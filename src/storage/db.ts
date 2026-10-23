// The workspace database: ONE IndexedDB database, "codeeditor", for every workspace's tree, file
// text, last-synced base table and app metadata. IndexedDB is the only browser store with atomic
// transactions across several records and stores, which folder renames, deletes and sync need.
// (The GitHub token lives in the sync module's own database, "codeeditor-secrets".)
//
// Rules for every module that touches this database:
//   - every mutation is exactly ONE transaction (inTransaction below), so a failure changes nothing;
//   - inside an open transaction, await nothing but IndexedDB requests: awaiting crypto, fetch or a
//     timer lets the transaction auto-commit half-way (hash before or after, never during);
//   - every stored path is normalizePath-clean.

import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import type { BaseEntry, EntryMeta, RemoteMeta, WsPath } from "../core/types";

export const DB_NAME = "codeeditor";
/** Bump only together with a new, appended block in upgrade(). */
export const DB_VERSION = 1;

/** Which files are open, which one is in front, and which folders are expanded in the tree. */
export interface UiState {
  openTabs: WsPath[];
  activePath: WsPath | null;
  expanded: WsPath[];
  /**
   * The Arguments field's text per file, as typed (runner/run-args.ts). Written only by
   * setRunArgs; follows renames and goes with deletes. Absent in records from before it existed.
   */
  args?: Record<WsPath, string>;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Bumped by every transaction that changes the workspace's files, tree, base table or remote,
   * so a tab that missed a BroadcastChannel message can tell it is out of date. UI-state writes
   * and filling in a file's blob id don't bump it (nothing a reader shows changes).
   */
  rev: number;
  remote: RemoteMeta | null;
  ui: UiState;
}

/** A file or folder. `parent` is "" for top-level entries; folders have size 0 and no shas. */
export interface EntryRecord extends EntryMeta {
  ws: string;
  parent: WsPath | "";
  name: string;
  ctime: number;
}

/** LF text of one (non-opaque) file. */
export interface ContentRecord {
  ws: string;
  path: WsPath;
  text: string;
}

/**
 * The remote tree as of the last sync, written only by sync. `text` is reserved for a later
 * version ("discard changes" offline); v1 never writes it.
 */
export interface BaseRecord extends BaseEntry {
  ws: string;
  text?: string;
}

export type MetaRecord =
  | { key: "schema"; version: number; migratedAt: number }
  | { key: "persist"; askedAt: number; granted: boolean };

export interface CodeEditorDB extends DBSchema {
  workspaces: { key: string; value: WorkspaceRecord };
  entries: { key: [string, string]; value: EntryRecord };
  contents: { key: [string, string]; value: ContentRecord };
  bases: { key: [string, string]; value: BaseRecord };
  meta: { key: string; value: MetaRecord };
}

export type WorkspaceDb = IDBPDatabase<CodeEditorDB>;
export type StoreName = StoreNames<CodeEditorDB>;
export type Durability = "default" | "strict" | "relaxed";

export interface OpenOptions {
  /** Database name; tests pass a fresh one each time. */
  name?: string;
  /** Another tab still has an older version open, so this one waits: ask the user to close it. */
  onBlocked?(info: { currentVersion: number; blockedVersion: number | null }): void;
  /**
   * This connection blocks a newer version, or (blockedVersion null) another tab is deleting the
   * database ("Sign out and clear this computer"). Flush pending saves, then call close(). Without
   * a handler the connection closes at once so the other tab isn't left waiting.
   */
  onBlocking?(info: { currentVersion: number; blockedVersion: number | null; close(): void }): void;
  /** The browser closed the connection abnormally (storage cleared, disk error): offer to reopen. */
  onTerminated?(): void;
}

/**
 * Opens (creating or upgrading) the workspace database. A VersionError rejection means an old
 * cached build met a newer database: tell the user to reload (see isVersionError).
 */
export function openWorkspaceDb(options: OpenOptions = {}): Promise<WorkspaceDb> {
  return openDB<CodeEditorDB>(options.name ?? DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      upgrade(db, oldVersion, newVersion ?? DB_VERSION, tx);
    },
    blocked(currentVersion, blockedVersion) {
      options.onBlocked?.({ currentVersion, blockedVersion });
    },
    blocking(currentVersion, blockedVersion, event) {
      const close = () => (event.target as IDBDatabase).close();
      if (options.onBlocking) options.onBlocking({ currentVersion, blockedVersion, close });
      else close();
    },
    terminated() {
      options.onTerminated?.();
    },
  });
}

/**
 * Schema migrations. Blocks are cumulative and append-only: a released block is never edited;
 * a change adds `if (oldVersion < N)`. They use only the versionchange transaction they are given
 * (an exception rolls the whole upgrade back) and never await anything else. Blob ids that a
 * migration can't keep are set to null; they are recomputed after the database opens.
 */
function upgrade(
  db: WorkspaceDb,
  oldVersion: number,
  newVersion: number,
  tx: IDBPTransaction<CodeEditorDB, StoreName[], "versionchange">,
): void {
  if (oldVersion < 1) {
    db.createObjectStore("workspaces", { keyPath: "id" });
    db.createObjectStore("entries", { keyPath: ["ws", "path"] });
    db.createObjectStore("contents", { keyPath: ["ws", "path"] });
    db.createObjectStore("bases", { keyPath: ["ws", "path"] });
    db.createObjectStore("meta", { keyPath: "key" });
  }
  // A failed put aborts the upgrade transaction, which rejects openDB; nothing else to report.
  tx.objectStore("meta")
    .put({ key: "schema", version: newVersion, migratedAt: Date.now() })
    .catch(() => {});
}

export function isVersionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "VersionError";
}

/**
 * Deletes the whole workspace database ("Sign out and clear this computer"; the sync module
 * deletes its own secrets database). Pass this tab's open connections in `close`; other tabs get
 * onBlocking with blockedVersion null and must close theirs, or the delete waits (onBlocked).
 */
export async function deleteAllLocalData(
  options: { name?: string; close?: WorkspaceDb[]; onBlocked?: () => void } = {},
): Promise<void> {
  for (const db of options.close ?? []) db.close();
  await deleteDB(options.name ?? DB_NAME, { blocked: () => options.onBlocked?.() });
}

// ---------------------------------------------------------------- key ranges

/** Every [ws, path] key of one workspace: an array key sorts after every string. */
export function wsRange(ws: string): IDBKeyRange {
  return IDBKeyRange.bound([ws], [ws, []]);
}

/** Everything strictly below folder `dir` (not `dir` itself): "0" is the code unit after "/". */
export function belowRange(ws: string, dir: WsPath): IDBKeyRange {
  return dir === "" ? wsRange(ws) : IDBKeyRange.bound([ws, dir + "/"], [ws, dir + "0"], false, true);
}

// ---------------------------------------------------------------- transactions

export type Tx<Names extends StoreName[], Mode extends IDBTransactionMode> = IDBPTransaction<CodeEditorDB, Names, Mode>;

/**
 * Runs `body` in one transaction and resolves once it has committed. If `body` throws (a
 * validation error, a request that failed synchronously) the transaction is aborted, so nothing
 * it already wrote survives. `body` must await every request it issues and nothing else.
 */
export async function inTransaction<const Names extends StoreName[], Mode extends IDBTransactionMode, T>(
  db: WorkspaceDb,
  stores: Names,
  mode: Mode,
  body: (tx: Tx<Names, Mode>) => Promise<T>,
  durability: Durability = "default",
): Promise<T> {
  const tx = db.transaction(stores, mode, { durability });
  const done = tx.done;
  done.catch(() => {}); // observed below; this only stops an abort from being reported twice
  try {
    const value = await body(observeRequests(tx));
    await done;
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already committed or aborted
    }
    throw error;
  }
}

/**
 * Wraps a transaction (and the stores it hands out) so every request promise is observed the
 * moment it exists. When a body fails part-way, the abort rejects the requests it had already
 * issued but not yet awaited; without this they would surface as unhandled rejections. Awaiting a
 * request still sees its error as usual.
 */
function observeRequests<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (prop === "store" && typeof value === "object" && value !== null) return observeRequests(value);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(obj, args);
        if (result instanceof Promise) result.catch(() => {});
        else if ((prop === "objectStore" || prop === "index") && typeof result === "object" && result !== null) return observeRequests(result);
        return result;
      };
    },
  });
}

// ---------------------------------------------------------------- errors

export type StorageErrorCode =
  | "not-found"
  | "exists"
  | "case-collision"
  | "not-a-folder"
  | "not-a-file"
  | "read-only-entry"
  | "limit"
  | "invalid-path"
  | "invalid-text"
  | "invalid"
  | "corrupt"
  | "read-only"
  /** A compare-and-set save found different text stored (saveFile `expect`). */
  | "changed";

/** A refused storage operation. `message` is one plain sentence fit for the UI. */
export class StorageError extends Error {
  override name = "StorageError";
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- change events

export type ChangeReason = "save" | "create" | "rename" | "delete" | "import" | "sync" | "remote" | "sha" | "ui" | "workspace";

/** Fired after a write has committed. `paths` are the entries whose record or text changed. */
export interface ChangeEvent {
  ws: string;
  rev: number;
  paths: WsPath[];
  reason: ChangeReason;
}

export type ChangeListener = (event: ChangeEvent) => void;

// Listeners belong to a connection, so the workspace store and the sync store share them.
const listeners = new WeakMap<WorkspaceDb, Set<ChangeListener>>();

export function addChangeListener(db: WorkspaceDb, listener: ChangeListener): () => void {
  let set = listeners.get(db);
  if (!set) listeners.set(db, (set = new Set()));
  set.add(listener);
  return () => void set.delete(listener);
}

export function emitChange(db: WorkspaceDb, event: ChangeEvent): void {
  for (const listener of [...(listeners.get(db) ?? [])]) {
    try {
      listener(event);
    } catch (error) {
      // A broken listener must not stop the others or undo a committed write.
      (globalThis as { reportError?: (e: unknown) => void }).reportError?.(error);
    }
  }
}
