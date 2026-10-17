// Helpers shared by workspace.ts and sync-store.ts (not part of the storage module's API).

import type { Eol } from "../core/bytes";
import { foldKey, nameOf, normalizePath, parentOf, PathError } from "../core/paths";
import { MAX_FILE_BYTES } from "../core/safety";
import type { EntryMeta, OpaqueBlob, RemoteMeta, WsPath } from "../core/types";
import { StorageError, type EntryRecord, type WorkspaceRecord } from "./db";

/** Workspace caps: GitHub inline pushes, memory for runs and IndexedDB quota all stay comfortable. */
export const MAX_FILES = 2000;
export const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;

export interface StorageLimits {
  /** Files (text and opaque) per workspace. */
  maxFiles: number;
  /** Bytes of text per workspace, counted as saved (line endings and BOM restored). */
  maxBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: Readonly<StorageLimits> = Object.freeze({
  maxFiles: MAX_FILES,
  maxBytes: MAX_WORKSPACE_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
});

export interface StoreOptions {
  /** Smaller caps for tests. */
  limits?: Partial<StorageLimits>;
  now?: () => number;
  /**
   * False in a tab that doesn't hold the workspace's writer lock (tabs.ts canWrite): every write
   * then throws StorageError "read-only" instead of racing the writer tab.
   */
  canWrite?: () => boolean;
}

export interface Resolved {
  limits: StorageLimits;
  now: () => number;
  guard(): void;
}

export function resolveOptions(options: StoreOptions = {}): Resolved {
  const canWrite = options.canWrite ?? (() => true);
  return {
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    now: options.now ?? Date.now,
    guard() {
      if (!canWrite()) throw new StorageError("read-only", "This tab is read-only because the workspace is open for editing in another tab.");
    },
  };
}

/** normalizePath, reporting a bad name as a StorageError. */
export function cleanPath(path: string): WsPath {
  try {
    return normalizePath(path);
  } catch (error) {
    if (error instanceof PathError) throw new StorageError("invalid-path", `"${path}" can't be used: ${error.message}.`);
    throw error;
  }
}

/** Stored text is LF only; eol and bom restore the file's bytes. */
export function assertLf(text: string): void {
  if (text.includes("\r")) throw new StorageError("invalid-text", "The text contains carriage returns; files are stored with LF line endings.");
}

/** mtime doubles as the compare-and-set token for filling in blob ids, so it must always move. */
export function nextMtime(now: number, previous: number): number {
  return Math.max(now, previous + 1);
}

export function bumped(ws: WorkspaceRecord, now: number): WorkspaceRecord {
  return { ...ws, rev: ws.rev + 1, updatedAt: now };
}

/** Checks the fields sync relies on; anything else is the sync module's business. */
export function validateRemote(remote: RemoteMeta): void {
  const ok =
    remote.provider === "github" &&
    typeof remote.owner === "string" &&
    remote.owner !== "" &&
    typeof remote.repo === "string" &&
    remote.repo !== "" &&
    typeof remote.branch === "string" &&
    remote.branch !== "" &&
    typeof remote.deviceName === "string";
  if (!ok) throw new StorageError("invalid", "The repository settings are incomplete (owner, repository and branch are needed).");
}

export function missingWorkspace(ws: string): StorageError {
  return new StorageError("not-found", `Workspace ${ws} doesn't exist.`);
}

/** The record without its storage keys, as handed to the UI and sync. */
export function toMeta(r: EntryRecord): EntryMeta {
  const meta: EntryMeta = {
    path: r.path,
    kind: r.kind,
    size: r.size,
    mtime: r.mtime,
    eol: r.eol,
    bom: r.bom,
    localSha: r.localSha,
    baseSha: r.baseSha,
  };
  if (r.opaque) meta.opaque = { sha: r.opaque.sha, mode: r.opaque.mode };
  return meta;
}

export function dirRecord(ws: string, path: WsPath, now: number): EntryRecord {
  return {
    ws,
    path,
    parent: parentOf(path),
    name: nameOf(path),
    kind: "dir",
    size: 0,
    ctime: now,
    mtime: now,
    eol: "\n",
    bom: false,
    localSha: null,
    baseSha: null,
  };
}

export function fileRecord(
  ws: string,
  path: WsPath,
  f: { size: number; eol: Eol; bom: boolean; localSha: string | null; baseSha: string | null; now: number; opaque?: OpaqueBlob },
): EntryRecord {
  const record: EntryRecord = {
    ws,
    path,
    parent: parentOf(path),
    name: nameOf(path),
    kind: "file",
    size: f.size,
    ctime: f.now,
    mtime: f.now,
    eol: f.eol,
    bom: f.bom,
    localSha: f.localSha,
    baseSha: f.baseSha,
  };
  if (f.opaque) record.opaque = { sha: f.opaque.sha, mode: f.opaque.mode };
  return record;
}

/** The blob id a file has now: its own for text, the remote's for opaque entries. */
export function currentSha(r: EntryRecord | undefined): string | null {
  if (!r || r.kind !== "file") return null;
  return r.opaque ? r.opaque.sha : r.localSha;
}

/**
 * In-memory view of one workspace's entries while a transaction decides what to write: exact and
 * case-folded lookups plus the file and byte counts the caps need.
 */
export class TreeIndex {
  private readonly byPath = new Map<WsPath, EntryRecord>();
  private readonly byFold = new Map<string, Set<WsPath>>();
  files = 0;
  bytes = 0;

  constructor(records: Iterable<EntryRecord>) {
    for (const r of records) this.add(r);
  }

  get(path: WsPath): EntryRecord | undefined {
    return this.byPath.get(path);
  }

  values(): IterableIterator<EntryRecord> {
    return this.byPath.values();
  }

  add(r: EntryRecord): void {
    this.remove(r.path);
    this.byPath.set(r.path, r);
    const key = foldKey(r.path);
    let set = this.byFold.get(key);
    if (!set) this.byFold.set(key, (set = new Set()));
    set.add(r.path);
    if (r.kind === "file") {
      this.files++;
      if (!r.opaque) this.bytes += r.size;
    }
  }

  remove(path: WsPath): EntryRecord | undefined {
    const r = this.byPath.get(path);
    if (!r) return undefined;
    this.byPath.delete(path);
    const set = this.byFold.get(foldKey(path));
    set?.delete(path);
    if (set?.size === 0) this.byFold.delete(foldKey(path));
    if (r.kind === "file") {
      this.files--;
      if (!r.opaque) this.bytes -= r.size;
    }
    return r;
  }

  /** An existing entry whose path equals `path` ignoring letter case (other than those in `except`). */
  caseTwin(path: WsPath, except: (p: WsPath) => boolean = () => false): WsPath | null {
    for (const p of this.byFold.get(foldKey(path)) ?? []) if (p !== path && !except(p)) return p;
    return null;
  }

  /** Throws unless nothing is stored at `path`, not even under a name that differs only in case. */
  assertFree(path: WsPath, except: (p: WsPath) => boolean = () => false): void {
    const existing = this.byPath.get(path);
    if (existing && !except(path)) {
      throw new StorageError("exists", `"${path}" already exists.`);
    }
    const twin = this.caseTwin(path, except);
    if (twin) throw caseCollision(path, twin);
  }

  /**
   * The folder records to create so every parent of `path` exists, top-down. Throws if a parent
   * is a file or clashes in case with another entry. Doesn't change the index (call add()).
   */
  planParents(ws: string, path: WsPath, now: number, checkCase = true): EntryRecord[] {
    const out: EntryRecord[] = [];
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      const existing = this.byPath.get(dir);
      if (existing) {
        if (existing.kind !== "dir") throw new StorageError("not-a-folder", `"${dir}" is a file, so it can't contain other files.`);
        continue;
      }
      if (checkCase) {
        const twin = this.caseTwin(dir);
        if (twin) throw caseCollision(dir, twin);
      }
      out.push(dirRecord(ws, dir, now));
    }
    return out;
  }
}

function caseCollision(path: WsPath, twin: WsPath): StorageError {
  return new StorageError(
    "case-collision",
    `"${path}" differs only in letter case from "${twin}"; Windows and macOS can't keep both, so choose another name.`,
  );
}
