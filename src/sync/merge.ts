// Three-way merge of a workspace with its GitHub repository, decided path by path on git blob ids.
// Pure: no I/O and no clock. engine.ts supplies the shas and applies the plan.
//
// The rule behind every decision: a version that differs from the last-synced base is never
// dropped. When both sides changed a file, the repository's version keeps the name and this
// computer's version is kept beside it as a conflict copy ("main.conflict-20261017-090503.py"),
// which is pushed too, so every machine sees both.
//
// Opaque entries (binary files, links, submodules, files too large to edit) belong to the
// repository: they are never edited, never deleted on GitHub, and this computer only keeps a
// read-only pointer to them that follows whatever the repository holds.

import { conflictName, foldKey, isConflictCopy, joinPath, nameOf, parentOf, splitExtension, tryNormalizePath } from "../core/paths";
import type { WsPath } from "../core/types";

/** A git blob id. In the functions below, null means "no file at this path". */
export type Sha = string;
/** Whose version ends up at a path: "l" this computer's, "r" the repository's. */
export type Side = "l" | "r";

export type DecisionKind =
  | "unchanged"
  | "converged" // both sides made the same change (or both deleted the file)
  | "changed-remotely"
  | "deleted-remotely"
  | "changed-locally"
  | "deleted-locally"
  | "conflict-both-changed" // the repository keeps the path, this computer's version becomes a copy
  | "conflict-edit-vs-remote-delete" // the edit survives and is pushed again
  | "conflict-local-delete-vs-remote-edit"; // the repository's edit is restored here

export interface Decision {
  at: Side | null;
  /** This computer's version also goes to a conflict copy. */
  copy: boolean;
  kind: DecisionKind;
}

/** One path: b = base sha (last sync), l = this computer, r = the repository; null = absent. */
export function decide(b: Sha | null, l: Sha | null, r: Sha | null): Decision {
  if (l === r) return { at: l === null ? null : "l", copy: false, kind: l === b ? "unchanged" : "converged" };
  if (l === b) return { at: r === null ? null : "r", copy: false, kind: r === null ? "deleted-remotely" : "changed-remotely" };
  if (r === b) return { at: l === null ? null : "l", copy: false, kind: l === null ? "deleted-locally" : "changed-locally" };
  if (l !== null && r !== null) return { at: "r", copy: true, kind: "conflict-both-changed" };
  if (l !== null) return { at: "l", copy: false, kind: "conflict-edit-vs-remote-delete" };
  return { at: "r", copy: false, kind: "conflict-local-delete-vs-remote-edit" };
}

export type MergeKind =
  | DecisionKind
  /** The repository's history was rewritten, so its deletions aren't trusted: the file stays. */
  | "kept-after-history-rewrite"
  /** An opaque file stays as the repository has it; a local delete or edit isn't sent. */
  | "kept-opaque"
  /** Both changed, but this computer's version already sits elsewhere in the repository: no copy. */
  | "already-on-remote"
  /** `path` holds this computer's version of `of`. */
  | "conflict-copy"
  /** `path` holds this computer's `of`, moved because the other side has a folder (or file) there. */
  | "conflict-file-vs-folder";

export interface MergeItem {
  path: WsPath;
  kind: MergeKind;
  of?: WsPath;
}

export interface MergedEntry {
  sha: Sha;
  from: Side;
  /** This computer's version of another path, saved under this new name. */
  copyOf?: WsPath;
  /** Opaque: never uploaded; this computer keeps only a read-only pointer. */
  opaque?: true;
}

export interface MergeOptions {
  /** The repository no longer contains the base commit (force-push elsewhere). */
  historyRewritten?: boolean;
  /** Local entries that are opaque pointers to a repository blob. */
  localOpaque?: ReadonlySet<WsPath>;
  /** Repository entries known to be opaque (links, submodules, binary or too large). */
  remoteOpaque?: ReadonlySet<WsPath>;
  /**
   * Repository paths left out of the merge (names the workspace can't store). They are never
   * moved or deleted, but their names and folders count as taken.
   */
  fixedRemote?: Iterable<string>;
}

export interface MergePlan {
  /** Every path that exists afterwards, on both sides (except opaque local-only pointers). */
  merged: Map<WsPath, MergedEntry>;
  /** Every path whose state changes, plus copies and moves, sorted by path then in creation order. */
  items: MergeItem[];
}

type RuledDecision = Omit<Decision, "kind"> & { kind: MergeKind };

function decideEntry(b: Sha | null, l: Sha | null, r: Sha | null, localOpaque: boolean, remoteOpaque: boolean, historyRewritten: boolean): RuledDecision {
  let d: RuledDecision;
  if (localOpaque && l !== null) {
    // The local entry only points at a repository blob, so the repository decides.
    if (r !== null) d = { at: "r", copy: false, kind: l === r ? (l === b ? "unchanged" : "converged") : "changed-remotely" };
    else if (b === null) d = { at: "l", copy: false, kind: "kept-opaque" };
    else d = { at: null, copy: false, kind: "deleted-remotely" };
  } else {
    d = decide(b, l, r);
    // Never edit or delete an opaque repository file: it stays the repository's, and a local
    // text version of the path (if different) is kept as a conflict copy.
    if (remoteOpaque && r !== null && d.at !== "r") {
      d = l === r ? { ...d, at: "r" } : { at: "r", copy: l !== null, kind: "kept-opaque" };
    }
  }
  if (historyRewritten && d.kind === "deleted-remotely") d = { at: "l", copy: false, kind: "kept-after-history-rewrite" };
  return d;
}

/** Folded names (and every folder above them) already used, so new names never collide. */
class TakenNames {
  private readonly keys = new Set<string>();
  add(path: string): void {
    for (let p = path; p !== ""; p = parentOf(p)) this.keys.add(foldKey(p));
  }
  has(path: string): boolean {
    return this.keys.has(foldKey(path));
  }
}

// The stamp core/paths conflictName adds, followed by the extension or the end of the name.
const STAMP = /\.conflict-\d{8}-\d{6}(?:-\d+)?(?=\.[^.]*$|$)/;

/**
 * A free conflict-copy name for `path`. A copy of a conflict copy is named after the original
 * file again ("main.conflict-B.py", not "main.conflict-A.conflict-B.py"). Names too long to
 * store get a shorter stem.
 */
export function copyName(path: WsPath, when: Date, taken: { has(path: string): boolean; add(path: string): void }): WsPath {
  const name = nameOf(path);
  const plain = (isConflictCopy(path) && name.replace(STAMP, "")) || name;
  const { stem, ext } = splitExtension(plain);
  const chars = [...stem];
  for (let keep = chars.length; keep > 0; keep -= keep > 8 ? 8 : 1) {
    const shortened = joinPath(parentOf(path), chars.slice(0, keep).join("") + ext);
    const candidate = conflictName(shortened, when, (c) => taken.has(c));
    if (tryNormalizePath(candidate) === candidate) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(`No valid conflict-copy name is left for ${path}`);
}

/**
 * Plans the merge. `base`, `local` and `remote` map paths to blob shas. `when` stamps conflict
 * copies (the same `when` gives the same names, so retries are stable).
 */
export function planMerge(
  base: ReadonlyMap<WsPath, Sha>,
  local: ReadonlyMap<WsPath, Sha>,
  remote: ReadonlyMap<WsPath, Sha>,
  when: Date,
  options: MergeOptions = {},
): MergePlan {
  const localOpaque = options.localOpaque ?? new Set<WsPath>();
  const remoteOpaque = options.remoteOpaque ?? new Set<WsPath>();
  const fixed = [...(options.fixedRemote ?? [])];
  const merged = new Map<WsPath, MergedEntry>();
  const items: MergeItem[] = [];
  const copies: { item: MergeItem; of: WsPath; sha: Sha }[] = [];

  const paths = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort();
  for (const path of paths) {
    const b = base.get(path) ?? null;
    const l = local.get(path) ?? null;
    const r = remote.get(path) ?? null;
    const lo = l !== null && localOpaque.has(path);
    const ro = r !== null && remoteOpaque.has(path);
    const d = decideEntry(b, l, r, lo, ro, options.historyRewritten === true);
    if (d.at === "l") merged.set(path, lo ? { sha: l!, from: "l", opaque: true } : { sha: l!, from: "l" });
    else if (d.at === "r") merged.set(path, ro ? { sha: r!, from: "r", opaque: true } : { sha: r!, from: "r" });
    if (d.kind === "unchanged") continue;
    const item: MergeItem = { path, kind: d.kind };
    items.push(item);
    if (d.copy) copies.push({ item, of: path, sha: l! });
  }

  const taken = new TakenNames();
  for (const p of paths) taken.add(p);
  for (const p of fixed) taken.add(p);

  // Shas the repository keeps at their own path after this merge. A local version already among
  // them needs no copy: it is still there (e.g. a copy pushed by a sync whose answer was lost).
  const keptRemotely = new Set<Sha>();
  for (const [p, m] of merged) if (remote.get(p) === m.sha) keptRemotely.add(m.sha);
  for (const c of copies) {
    if (keptRemotely.has(c.sha)) {
      c.item.kind = "already-on-remote";
      continue;
    }
    const name = copyName(c.of, when, taken);
    merged.set(name, { sha: c.sha, from: "l", copyOf: c.of });
    items.push({ path: name, kind: "conflict-copy", of: c.of });
  }

  // A path can't be a file on one side and a folder on the other. This computer's side moves:
  // a local file to a conflict name, or local files out of a folder the repository has as a file.
  const folders = new Set<string>();
  const addFolders = (p: string) => {
    for (let d = parentOf(p); d !== ""; d = parentOf(d)) folders.add(d);
  };
  for (const p of merged.keys()) addFolders(p);
  for (const p of fixed) addFolders(p);
  const move = (from: WsPath, to: WsPath) => {
    const m = merged.get(from)!;
    const of = m.copyOf ?? from;
    merged.delete(from);
    merged.set(to, { ...m, copyOf: of });
    taken.add(to);
    items.push({ path: to, kind: "conflict-file-vs-folder", of });
  };
  for (const path of [...merged.keys()].sort()) {
    const m = merged.get(path);
    if (!m || !folders.has(path)) continue;
    if (m.from === "l") {
      move(path, copyName(path, when, taken));
    } else {
      const dir = copyName(path, when, taken);
      for (const q of [...merged.keys()]) {
        if (q.startsWith(path + "/") && merged.get(q)!.from === "l") move(q, dir + q.slice(path.length));
      }
    }
  }
  return { merged, items };
}
