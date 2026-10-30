// One sync of a workspace with its GitHub repository: local-first, one commit per push.
//
//  1. Read the branch head with a conditional request. A 304 means nothing moved remotely, so
//     nothing else needs reading. A 409 means the repository is empty.
//  2. Otherwise read the head commit's whole tree, and check (compare) that the history still
//     contains the commit this workspace last synced with.
//  3. Decide every path three ways against the last-synced base (merge.ts).
//  4. Download the repository versions this computer needs: raw blobs, at most 3 at a time,
//     each checked against its id and with core/safety checkBytes (non-text files stay opaque).
//  5. Empty repository: give it a first commit (Contents API), then start again.
//  6. Push the merged result as ONE commit: create tree (base_tree + changes), check that GitHub
//     stored exactly our bytes, create the commit, move the branch with force: false. If the
//     branch moved meanwhile (422), start again from 1 (at most 3 attempts).
//  7. Save the whole result in ONE store.commit. Nothing is written locally before that, so a
//     failed sync changes nothing here and can simply be retried.

import { encodeFileBytes, gitBlobSha, textBlobSha, type Eol } from "../core/bytes";
import { foldKey, tryNormalizePath } from "../core/paths";
import { MAX_FILE_BYTES, checkBytes } from "../core/safety";
import type { BaseEntry, LocalFileState, OpaquePut, RemoteMeta, SyncCommit, SyncSnapshot, SyncStore, WsPath } from "../core/types";
import { commitMessage } from "./commit-message";
import { GitHubError, type GitHubClient, type TreeEntryType, type TreeWrite } from "./github";
import { planMerge, type MergeItem, type Sha } from "./merge";

/** Attempts at moving the branch when someone else pushes at the same moment. */
export const MAX_ATTEMPTS = 3;
/** Blob downloads in flight at once (GitHub: avoid concurrent requests). */
export const PARALLEL_DOWNLOADS = 3;
/** Inline content per createTree request; more goes in further chained requests. */
export const INLINE_BUDGET_BYTES = 4 * 1024 * 1024;
/** Largest workspace (architecture: <= 2000 files). */
export const MAX_WORKSPACE_FILES = 2000;
/** Largest workspace in bytes (architecture: <= 50 MiB); downloads beyond it are refused up front. */
export const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;

const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

export type FirstConnectChoice = "use-remote" | "merge" | "push-local";
export type SyncPhase = "checking" | "downloading" | "uploading" | "verifying" | "saving";

export interface SyncOptions {
  /** Shown in commit messages ("From: <device> (ExecFlow)", commit-message.ts). */
  deviceName: string;
  /**
   * A subject the student typed for this sync ("Sync now with a message"): every commit this sync
   * makes uses it (cleaned again here); the file lists stay in the body. Empty or absent: automatic.
   */
  subject?: string;
  /** Stamps conflict copies and lastSyncAt. */
  now: () => Date;
  branch: string;
  onProgress?: (phase: SyncPhase, done?: number, total?: number) => void;
  /**
   * Asked once, on the first sync with a repository, when the repository and this computer both
   * have a file at the same path with different contents:
   * - "merge": the repository's version keeps the name, this computer's becomes a conflict copy;
   * - "use-remote": the repository's version wins and this computer's version is dropped;
   * - "push-local": this computer's version wins (the old one stays in the repository's history).
   * Files that exist on only one side are always kept. Rejecting cancels the sync. Default "merge".
   */
  firstConnect?: () => Promise<FirstConnectChoice>;
}

export interface SyncReport {
  /** Written on this computer from the repository (new or changed), read-only pointers included. */
  pulled: WsPath[];
  /** Added or changed in the repository by this sync, conflict copies included. */
  pushed: WsPath[];
  /** "local": deleted here because the repository deleted it; "remote": deleted on GitHub. */
  deleted: { path: WsPath; where: "local" | "remote" }[];
  /** Both sides changed `path`: the repository's version kept the name, this computer's is `copy`. */
  conflicts: { path: WsPath; copy: WsPath }[];
  /** Changed on this computer while the sync ran: left alone; the next sync treats them as local changes. */
  skipped: WsPath[];
  /** Repository paths this workspace can't store (unsafe or reserved names): never pulled, never deleted. */
  ignoredRemotePaths: string[];
  /** Repository files kept as read-only pointers by this sync, and why. */
  opaque: { path: WsPath; reason: string }[];
  /** Changes held back: GitHub needs the Workflows permission for .github/workflows/. */
  notPushed: WsPath[];
  /** Everything the merge did, path by path (for a detailed report). */
  details: MergeItem[];
  /** The commit this workspace is now in step with; null while the repository is empty. */
  commit: string | null;
  /** Commits this sync made on GitHub (0: nothing needed uploading; 2: it started an empty repository). */
  commits: number;
  /** The repository's history was rewritten: its deletions were not applied here. */
  historyRewritten: boolean;
}

export type SyncErrorKind =
  | "tree-too-large"
  | "too-many-files"
  | "workspace-too-large"
  | "remote-moving"
  | "verify-failed"
  | "bad-download"
  | "not-default-branch";

/** A sync that stopped for a reason other than a GitHub error. `message` is one plain sentence. */
export class SyncError extends Error {
  override name = "SyncError";
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Repository entries this computer keeps as read-only pointers now live in core SyncCommit.opaque
 * (OpaquePut). These aliases keep the names this module and its tests already use.
 */
export type { OpaquePut };
export type SyncCommitWithOpaque = SyncCommit;

interface RemoteEntry {
  sha: Sha;
  mode: string;
  type: TreeEntryType;
  /** null when only the base table was read (sizes aren't stored there). */
  size: number | null;
}

interface RemoteView {
  head: string | null;
  tree: string | null;
  etag: string | null;
  entries: Map<WsPath, RemoteEntry>;
  ignored: string[];
  rewritten: boolean;
}

interface Content {
  text: string;
  eol: Eol;
  bom: boolean;
  sha: Sha;
}

// Syncs of one store run one after another, never interleaved.
const queues = new WeakMap<SyncStore, Promise<unknown>>();

export function sync(store: SyncStore, client: GitHubClient, opts: SyncOptions): Promise<SyncReport> {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(() => runSync(store, client, opts));
  queues.set(store, run.catch(() => undefined));
  return run;
}

async function runSync(store: SyncStore, client: GitHubClient, opts: SyncOptions): Promise<SyncReport> {
  const when = opts.now();
  const progress = opts.onProgress ?? (() => undefined);
  const fetchBlob = blobFetcher(client);
  let choice: FirstConnectChoice | undefined;
  /** The file this sync used to start an empty repository, as GitHub stored it. */
  let bootstrap: { path: WsPath; sha: Sha } | null = null;
  let commits = 0;

  for (let attempt = 1; ; ) {
    progress("checking");
    const snap = await store.snapshot();
    const prior = sameRemote(snap.remote, client, opts.branch) ? snap.remote : null;
    const baseCommit = prior?.baseCommit ?? null;
    const base = baseCommit ? snap.base : new Map<WsPath, BaseEntry>();
    const remote = await readRemote(client, opts.branch, prior, base, snap.local);

    const local = new Map<WsPath, Sha>();
    const localOpaque = new Set<WsPath>();
    const opaqueShas = new Set<Sha>();
    for (const [path, f] of snap.local) {
      local.set(path, f.sha);
      if (f.opaque) {
        localOpaque.add(path);
        opaqueShas.add(f.sha);
      }
    }
    // An empty repository has no history to delete from: it never turns into local deletions.
    const baseShas = new Map<WsPath, Sha>(remote.head === null ? [] : [...base].map(([p, e]) => [p, e.sha]));
    // Just after starting an empty repository its only file came from here: what was uploaded is
    // that file's base, so an edit typed meanwhile is a local change (pushed), not a difference.
    if (bootstrap && remote.head !== null && !baseShas.has(bootstrap.path)) baseShas.set(bootstrap.path, bootstrap.sha);
    const remoteShas = new Map<WsPath, Sha>([...remote.entries].map(([p, e]) => [p, e.sha]));

    // Repository files that are opaque, and why. Files deleted here are checked by content too:
    // a binary file missing locally is restored, never deleted on GitHub.
    const opaque = new Map<WsPath, string>();
    for (const [path, e] of remote.entries) {
      const why = opaqueReason(e, opaqueShas);
      if (why) opaque.set(path, why);
    }
    const deletedHere = [...remote.entries].filter(([p, e]) => !local.has(p) && baseShas.get(p) === e.sha && !opaque.has(p));
    if (deletedHere.length > 0) progress("downloading", 0, deletedHere.length);
    let checked = 0;
    await eachLimited(deletedHere, PARALLEL_DOWNLOADS, async ([path, e]) => {
      const result = checkBytes(await fetchBlob(e.sha));
      if (!result.ok) opaque.set(path, result.reason);
      progress("downloading", ++checked, deletedHere.length);
    });

    if (!baseCommit && !bootstrap && remote.head !== null && sharesDifferingFile(local, remoteShas, localOpaque)) {
      choice ??= opts.firstConnect ? await opts.firstConnect() : "merge";
      applyFirstConnect(choice, baseShas, local, remoteShas);
    }

    const plan = planMerge(baseShas, local, remoteShas, when, {
      historyRewritten: remote.rewritten,
      localOpaque,
      remoteOpaque: new Set(opaque.keys()),
      fixedRemote: remote.ignored,
    });
    if (plan.merged.size > MAX_WORKSPACE_FILES) {
      throw new SyncError("too-many-files", `The repository and this workspace together have ${plan.merged.size} files, more than the ${MAX_WORKSPACE_FILES} a workspace can hold.`);
    }

    // ---- what changes on this computer
    const reader = new LocalReader(store, snap.local);
    const put: SyncCommit["put"] = [];
    const opaquePuts: OpaquePut[] = [];
    const remove: SyncCommit["remove"] = [];
    const pulled: WsPath[] = [];
    const newlyOpaque: { path: WsPath; reason: string }[] = [];
    const wanted: WsPath[] = [];
    for (const [path, m] of plan.merged) {
      const current = snap.local.get(path);
      if (m.copyOf !== undefined) {
        const source = snap.local.get(m.copyOf)!;
        const expect = current?.sha ?? "absent";
        if (source.opaque) {
          opaquePuts.push({ path, sha: source.sha, mode: source.opaque.mode, size: 0, expect });
        } else {
          const c = await reader.read(m.copyOf);
          m.sha = c.sha; // the text actually read (the user may have typed since the snapshot)
          put.push({ path, text: c.text, eol: c.eol, bom: c.bom, sha: c.sha, expect });
        }
        continue;
      }
      if (m.from === "l") continue;
      const entry = remote.entries.get(path)!;
      if (current && current.sha === m.sha && (!current.opaque || current.opaque.mode === entry.mode)) continue;
      wanted.push(path);
    }
    // Everything downloaded is kept here, so more than a workspace holds would only be refused by
    // the store after the downloads (and held in memory until then).
    let downloadBytes = 0;
    for (const path of wanted) if (!opaque.has(path)) downloadBytes += remote.entries.get(path)!.size ?? 0;
    if (downloadBytes > MAX_WORKSPACE_BYTES) {
      throw new SyncError(
        "workspace-too-large",
        `The repository files this sync would download add up to ${Math.ceil(downloadBytes / (1024 * 1024))} MB, more than the ${MAX_WORKSPACE_BYTES / (1024 * 1024)} MB a workspace can hold.`,
      );
    }
    if (wanted.length > 0) progress("downloading", 0, wanted.length);
    let done = 0;
    await eachLimited(wanted, PARALLEL_DOWNLOADS, async (path) => {
      const entry = remote.entries.get(path)!;
      const expect = snap.local.get(path)?.sha ?? "absent";
      const keepOpaque = (reason: string) => {
        opaquePuts.push({ path, sha: entry.sha, mode: entry.mode, size: entry.size ?? 0, expect });
        newlyOpaque.push({ path, reason });
      };
      const why = opaque.get(path);
      if (why !== undefined) keepOpaque(why);
      else {
        const same = await reader.find(entry.sha);
        if (same) put.push({ path, text: same.text, eol: same.eol, bom: same.bom, sha: entry.sha, expect });
        else {
          const result = checkBytes(await fetchBlob(entry.sha));
          if (!result.ok) keepOpaque(result.reason);
          else if ((await textBlobSha(result.text, result.eol, result.bom)) !== entry.sha) keepOpaque("its bytes couldn't be stored exactly as text");
          else put.push({ path, text: result.text, eol: result.eol, bom: result.bom, sha: entry.sha, expect });
        }
      }
      pulled.push(path);
      progress("downloading", ++done, wanted.length);
    });
    for (const [path, f] of snap.local) if (!plan.merged.has(path)) remove.push({ path, expect: f.sha });

    // ---- empty repository: the Git Database API needs a first commit, made with the Contents API.
    if (remote.head === null) {
      const first = [...plan.merged].filter(([p, m]) => !m.opaque && !isWorkflowPath(p)).map(([p]) => p).sort()[0];
      if (first !== undefined) {
        if (bootstrap) {
          throw new SyncError("remote-moving", "GitHub still shows the repository as empty after ExecFlow added the first file, so sync again in a minute.");
        }
        const info = await client.getRepo();
        if (info.defaultBranch !== opts.branch) {
          throw new SyncError("not-default-branch", `This repository is empty, and GitHub can only start it on its default branch "${info.defaultBranch}", not "${opts.branch}".`);
        }
        const c = await reader.read(first);
        progress("uploading");
        // Named like any other commit that adds one file ("Add main.py"); the rest follow in the next.
        const message = commitMessage({ added: [first], changed: [], deleted: [] }, opts.deviceName, opts.subject);
        const uploaded = await client.putFile(first, encodeFileBytes(c.text, c.eol, c.bom), message);
        bootstrap = { path: first, sha: uploaded.blob };
        commits++;
        continue; // the next round sees that file on both sides and pushes the rest
      }
    }

    // ---- push: one tree, one commit, one fast-forward
    const entries: TreeWrite[] = [];
    // Deletes go first, so a file that gives way to a folder of the same name (or the reverse) is
    // gone before the new entries arrive, even when the push is split over several trees.
    const deletes: TreeWrite[] = [];
    const pushed: WsPath[] = [];
    const deletedRemote: WsPath[] = [];
    const notPushed: WsPath[] = [];
    const added: WsPath[] = [];
    const changed: WsPath[] = [];
    const knownBlobs = new Set<Sha>([...remote.entries.values()].filter((e) => e.type === "blob").map((e) => e.sha));
    // The tree GitHub must store: the current one with our changes applied.
    const expected = new Map<WsPath, { sha: Sha; mode: string }>([...remote.entries].map(([p, e]) => [p, { sha: e.sha, mode: e.mode }]));
    for (const [path, m] of plan.merged) {
      if (m.from === "r" || m.opaque) continue;
      const before = remote.entries.get(path);
      if (before && before.sha === m.sha) continue;
      if (isWorkflowPath(path)) {
        notPushed.push(path);
        continue;
      }
      const c = await reader.read(m.copyOf ?? path);
      m.sha = c.sha;
      if (before && before.sha === c.sha) continue;
      const mode = m.copyOf !== undefined ? "100644" : (regular(before?.mode) ?? regular(base.get(path)?.mode) ?? "100644");
      const bytes = encodeFileBytes(c.text, c.eol, c.bom);
      if (knownBlobs.has(c.sha)) entries.push({ path, mode, type: "blob", sha: c.sha });
      else if (bytes.length > MAX_FILE_BYTES) {
        if ((await client.createBlob(bytes)) !== c.sha) verifyFailed(path);
        entries.push({ path, mode, type: "blob", sha: c.sha });
      } else entries.push({ path, mode, type: "blob", content: exactText(bytes) });
      expected.set(path, { sha: c.sha, mode });
      if (before) changed.push(path);
      else added.push(path);
      pushed.push(path);
    }
    for (const [path, e] of remote.entries) {
      if (plan.merged.has(path)) continue;
      if (opaque.has(path) || e.type !== "blob") throw new Error(`Sync bug: it planned to delete the read-only file ${path}`);
      if (isWorkflowPath(path)) {
        notPushed.push(path);
        continue;
      }
      deletes.push({ path, mode: e.mode, type: "blob", sha: null });
      expected.delete(path);
      deletedRemote.push(path);
    }
    const writes = [...deletes, ...entries];

    let commit = remote.head;
    let tree = remote.tree;
    let etag = remote.etag;
    let newBase = remote.entries;
    if (writes.length > 0 && remote.head !== null && remote.tree !== null) {
      progress("uploading");
      let next = remote.tree;
      for (const chunk of chunked(writes)) next = await client.createTree(next, chunk);
      progress("verifying");
      const stored = await readTree(client, next);
      verifyTree(expected, stored.entries);
      const message = commitMessage({ added, changed, deleted: deletedRemote }, opts.deviceName, opts.subject);
      const created = await client.createCommit(message, next, [remote.head]);
      try {
        await client.updateRef(opts.branch, created);
      } catch (error) {
        if (!(error instanceof GitHubError && error.kind === "ref-rejected")) throw error;
        if (attempt >= MAX_ATTEMPTS) {
          throw new SyncError("remote-moving", `The repository kept changing while ExecFlow synced (${MAX_ATTEMPTS} tries); nothing was lost, so sync again in a moment.`);
        }
        attempt++;
        continue; // someone pushed meanwhile: merge again against the new head
      }
      commits++;
      commit = created;
      tree = next;
      etag = null; // our push moved the branch; the next sync reads it in full once
      newBase = stored.entries;
    }

    progress("saving");
    const remoteMeta: Partial<RemoteMeta> = {
      provider: "github",
      owner: client.owner,
      repo: client.repo,
      branch: opts.branch,
      baseCommit: commit,
      baseTree: tree,
      // Kept only when nothing changes here: then no path can be skipped, the base table equals
      // the tree, and a later 304 may stand in for reading it.
      refEtag: put.length + remove.length + opaquePuts.length === 0 ? etag : null,
      lastSyncAt: opts.now().getTime(),
      lastError: null,
      deviceName: opts.deviceName,
    };
    const change: SyncCommitWithOpaque = {
      put,
      remove,
      base: [...newBase].map(([path, e]) => ({ path, sha: e.sha, mode: e.mode })),
      remote: remoteMeta,
      opaque: opaquePuts,
    };
    const { skipped } = await store.commit(change);
    const skippedSet = new Set(skipped);
    // Files moved aside (file/folder clash) are reported as conflicts, not deletions.
    const movedFrom = new Set([...plan.merged.values()].map((m) => m.copyOf));
    return {
      pulled: pulled.filter((p) => !skippedSet.has(p)).sort(),
      pushed: pushed.sort(),
      deleted: [
        ...remove.filter((r) => !skippedSet.has(r.path) && !movedFrom.has(r.path)).map((r) => ({ path: r.path, where: "local" as const })),
        ...deletedRemote.map((path) => ({ path, where: "remote" as const })),
      ],
      conflicts: plan.items.filter((i) => i.kind === "conflict-copy" || i.kind === "conflict-file-vs-folder").map((i) => ({ path: i.of!, copy: i.path })),
      skipped,
      ignoredRemotePaths: remote.ignored,
      opaque: newlyOpaque.filter((o) => !skippedSet.has(o.path)).sort((a, b) => (a.path < b.path ? -1 : 1)),
      notPushed: notPushed.sort(),
      details: plan.items,
      commit,
      commits,
      historyRewritten: remote.rewritten,
    };
  }
}

// ---------------------------------------------------------------- reading the repository

function sameRemote(meta: RemoteMeta | null, client: GitHubClient, branch: string): meta is RemoteMeta {
  // Account and repository names are case-insensitive on GitHub; branch names are not.
  return (
    meta !== null &&
    meta.provider === "github" &&
    meta.owner.toLowerCase() === client.owner.toLowerCase() &&
    meta.repo.toLowerCase() === client.repo.toLowerCase() &&
    meta.branch === branch
  );
}

async function readRemote(
  client: GitHubClient,
  branch: string,
  prior: RemoteMeta | null,
  base: SyncSnapshot["base"],
  local: SyncSnapshot["local"],
): Promise<RemoteView> {
  const known = prior?.baseCommit && prior.baseTree ? { commit: prior.baseCommit, tree: prior.baseTree, etag: prior.refEtag } : null;
  const ref = await client.getRef(branch, known?.etag ?? null);
  if (ref.state === "empty") return { head: null, tree: null, etag: null, entries: new Map(), ignored: [], rewritten: false };
  if (known && ref.state === "unchanged") {
    // 304: the branch hasn't moved since a sync that wrote nothing here stored this ETag, so the
    // base table is exactly the repository's tree, minus the paths readTree ignores. The tree is
    // still read when this computer has a path the base lacks (it may clash with an ignored
    // repository folder, which only the listing shows) or lacks one (sizes are needed to check
    // files deleted here).
    if (local.size === base.size && [...base.keys()].every((p) => local.has(p))) {
      const entries = new Map<WsPath, RemoteEntry>();
      for (const [p, e] of base) entries.set(p, { sha: e.sha, mode: e.mode, type: e.mode === "160000" ? "commit" : "blob", size: null });
      return { head: known.commit, tree: known.tree, etag: known.etag, entries, ignored: [], rewritten: false };
    }
    return { head: known.commit, tree: known.tree, etag: known.etag, ...(await readTree(client, known.tree)), rewritten: false };
  }
  if (ref.state === "unchanged") throw new Error("Sync bug: GitHub answered 304 to a request without an ETag");
  if (known && ref.sha === known.commit) {
    // Same commit, but the base table may differ from its tree (a path skipped last time keeps
    // its older base entry), so read the tree. No commit read or compare is needed.
    return { head: known.commit, tree: known.tree, etag: ref.etag, ...(await readTree(client, known.tree)), rewritten: false };
  }
  const commit = await client.getCommit(ref.sha);
  const listing = await readTree(client, commit.tree);
  const rewritten = prior?.baseCommit ? await historyRewritten(client, prior.baseCommit, ref.sha) : false;
  return { head: ref.sha, tree: commit.tree, etag: ref.etag, ...listing, rewritten };
}

/** The tree's files. Paths that aren't normalizePath-clean (exactly) are set aside, not merged. */
async function readTree(client: GitHubClient, sha: string): Promise<{ entries: Map<WsPath, RemoteEntry>; ignored: string[] }> {
  const listing = await client.getTree(sha, true);
  if (listing.truncated) {
    throw new SyncError("tree-too-large", "The repository has too many files for GitHub to list in one answer, so ExecFlow can't sync it safely.");
  }
  const entries = new Map<WsPath, RemoteEntry>();
  const ignored: string[] = [];
  for (const e of listing.entries) {
    if (e.type === "tree") continue;
    // NFD names (from macOS) are ignored too: storing them as NFC would rename them on GitHub.
    if (!isCleanPath(e.path)) ignored.push(e.path);
    else entries.set(e.path, { sha: e.sha, mode: e.mode, type: e.type, size: e.size ?? null });
  }
  return { entries, ignored: ignored.sort() };
}

const isCleanPath = (path: string) => tryNormalizePath(path) === path;

async function historyRewritten(client: GitHubClient, baseCommit: string, head: string): Promise<boolean> {
  try {
    const status = await client.compare(baseCommit, head);
    return status !== "ahead" && status !== "identical";
  } catch (error) {
    // The base commit no longer exists in the repository: its history was replaced.
    if (error instanceof GitHubError && error.kind === "not-found") return true;
    throw error;
  }
}

function opaqueReason(e: RemoteEntry, opaqueShas: ReadonlySet<Sha>): string | null {
  if (e.type === "commit") return "it is a submodule (a link to another repository)";
  if (e.mode === "120000") return "it is a symbolic link";
  if (e.type !== "blob" || !REGULAR_MODES.has(e.mode)) return "it isn't a regular file";
  if (e.size !== null && e.size > MAX_FILE_BYTES) return `it is ${Math.round(e.size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB`;
  if (opaqueShas.has(e.sha)) return "it can't be edited as text here";
  return null;
}

/** Fetches each blob once per sync and checks its bytes against its id. */
function blobFetcher(client: GitHubClient): (sha: Sha) => Promise<Uint8Array> {
  const cache = new Map<Sha, Promise<Uint8Array>>();
  return (sha) => {
    let pending = cache.get(sha);
    if (!pending) {
      pending = client.getBlob(sha).then(async (bytes) => {
        if ((await gitBlobSha(bytes)) !== sha) {
          throw new SyncError("bad-download", "A file downloaded from GitHub didn't match its id, so the sync stopped before changing anything.");
        }
        return bytes;
      });
      cache.set(sha, pending);
      pending.catch(() => cache.delete(sha));
    }
    return pending;
  };
}

// ---------------------------------------------------------------- merging helpers

function sharesDifferingFile(local: ReadonlyMap<WsPath, Sha>, remote: ReadonlyMap<WsPath, Sha>, localOpaque: ReadonlySet<WsPath>): boolean {
  for (const [path, sha] of local) {
    const r = remote.get(path);
    if (r !== undefined && r !== sha && !localOpaque.has(path)) return true;
  }
  return false;
}

/** Turns a first-connect choice into a base, so the ordinary 3-way rules do the rest. */
function applyFirstConnect(choice: FirstConnectChoice, base: Map<WsPath, Sha>, local: ReadonlyMap<WsPath, Sha>, remote: ReadonlyMap<WsPath, Sha>): void {
  if (choice === "merge") return;
  for (const [path, l] of local) {
    const r = remote.get(path);
    if (r === undefined || r === l) continue;
    // base = local: "only the repository changed" -> take it. base = remote: push the local one.
    base.set(path, choice === "use-remote" ? l : r);
  }
}

/** Local text, read once per sync, with the sha of what was actually read. */
class LocalReader {
  private readonly cache = new Map<WsPath, Promise<Content>>();
  private readonly bySha = new Map<Sha, WsPath[]>();

  constructor(
    private readonly store: SyncStore,
    private readonly files: ReadonlyMap<WsPath, LocalFileState>,
  ) {
    for (const [path, f] of files) {
      if (f.opaque) continue;
      const list = this.bySha.get(f.sha);
      if (list) list.push(path);
      else this.bySha.set(f.sha, [path]);
    }
  }

  read(path: WsPath): Promise<Content> {
    let pending = this.cache.get(path);
    if (!pending) {
      const f = this.files.get(path);
      if (!f || f.opaque) throw new Error(`Sync bug: ${path} has no local text`);
      pending = this.store.readText(path).then(async (text) => ({ text, eol: f.eol, bom: f.bom, sha: await textBlobSha(text, f.eol, f.bom) }));
      this.cache.set(path, pending);
    }
    return pending;
  }

  /** A local text file with exactly these bytes (renamed or copied on the other side): no download. */
  async find(sha: Sha): Promise<Content | null> {
    for (const path of this.bySha.get(sha) ?? []) {
      try {
        const c = await this.read(path);
        if (c.sha === sha) return c;
      } catch {
        // Deleted since the snapshot: download instead.
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- pushing helpers

/** GitHub refuses changes under .github/workflows/ without the Workflows permission. */
function isWorkflowPath(path: WsPath): boolean {
  return foldKey(path).startsWith(".github/workflows/");
}

const regular = (mode: string | undefined) => (mode !== undefined && REGULAR_MODES.has(mode) ? mode : undefined);

/** The exact bytes as a string: createTree stores `content` as its UTF-8 bytes. */
function exactText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function chunked(entries: TreeWrite[]): TreeWrite[][] {
  const chunks: TreeWrite[][] = [];
  let current: TreeWrite[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = "content" in e ? e.content.length * 3 : 0;
    if (current.length > 0 && bytes + size > INLINE_BUDGET_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function verifyFailed(path: WsPath): never {
  throw new SyncError("verify-failed", `GitHub stored a different version of ${path} than ExecFlow sent, so the sync stopped before changing the branch.`);
}

/**
 * The tree GitHub stored must be exactly the expected one: same paths, shas (so the same bytes)
 * and modes. Checked before the branch moves, so a mismatch changes nothing anyone can see.
 */
function verifyTree(expected: ReadonlyMap<WsPath, { sha: Sha; mode: string }>, stored: ReadonlyMap<WsPath, RemoteEntry>): void {
  for (const [path, want] of expected) {
    const got = stored.get(path);
    if (!got || got.sha !== want.sha || got.mode !== want.mode) verifyFailed(path);
  }
  for (const path of stored.keys()) if (!expected.has(path)) verifyFailed(path);
}

async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
