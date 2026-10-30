// The local workspace: folders and LF text files in IndexedDB (db.ts), local-first. The editor
// saves here; runs, export and GitHub sync read from here. Every mutation below is exactly one
// transaction, so a folder rename or delete either happens completely or not at all.
//
// Blob ids: a save stores the text with localSha = null and only then hashes it, outside the
// transaction, filling the id in with a compare-and-set on mtime (a newer save wins). Sync's
// snapshot fills in any id that is still missing.

import { encodeFileBytes, gitBlobSha, textBlobSha, type Eol } from "../core/bytes";
import { foldKey, isConflictCopy, isInside, joinPath, nameOf, parentOf, tryNormalizePath } from "../core/paths";
import { checkBytes, checkText } from "../core/safety";
import type { EntryMeta, RemoteMeta, WorkspaceFile, WsPath } from "../core/types";
import {
  addChangeListener,
  belowRange,
  emitChange,
  inTransaction,
  readRequest,
  StorageError,
  wsRange,
  type ChangeListener,
  type Durability,
  type EntryRecord,
  type UiState,
  type WorkspaceDb,
  type WorkspaceRecord,
} from "./db";
import {
  assertLf,
  bumped,
  cleanPath,
  dirRecord,
  fileRecord,
  missingWorkspace,
  nextMtime,
  resolveOptions,
  toMeta,
  TreeIndex,
  validateRemote,
  type StorageLimits,
  type StoreOptions,
} from "./internal";

export { DEFAULT_LIMITS, MAX_FILES, MAX_WORKSPACE_BYTES, type StorageLimits, type StoreOptions } from "./internal";

export interface ImportedFile {
  /** A file name, or a path relative to the import folder ("src/util.c", e.g. from a zip). */
  name: string;
  bytes: Uint8Array;
}

export interface ImportResult {
  added: WsPath[];
  replaced: WsPath[];
  /** Folders created to hold the files (and any empty folders asked for). */
  dirs: WsPath[];
  /** Files left out, with one plain sentence each. `path` is set once the name was valid. */
  refused: { name: string; path?: WsPath; reason: string }[];
  /** Imported files that contain invisible characters (zero-width spaces and the like). */
  hidden: { path: WsPath; count: number }[];
}

export interface WorkspaceStats {
  files: number;
  dirs: number;
  /** Files kept from GitHub that can't be edited as text (binary, mixed line endings...). */
  opaque: number;
  /** Text bytes as saved; counts against limits.maxBytes. */
  bytes: number;
  /** Files whose blob id differs from the last sync (or isn't known yet). */
  changed: number;
  /** Files that have never been synced. */
  added: number;
  /** Synced paths deleted here and not pushed yet. */
  deleted: number;
  limits: StorageLimits;
}

export interface ExportData {
  /** Bytes exactly as saved (line endings and BOM restored). */
  files: { path: WsPath; bytes: Uint8Array; mtime: number }[];
  /** Folders with nothing inside (folders that hold files are implied by the file paths). */
  dirs: WsPath[];
  /** Opaque files: only their GitHub blob id is stored here, so they can't be exported. */
  skipped: WsPath[];
}

export interface WorkspaceStore {
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  getWorkspace(ws: string): Promise<WorkspaceRecord | null>;
  /** The workspace called `name`, created if it doesn't exist (allowed in read-only tabs too). */
  ensureWorkspace(name: string): Promise<WorkspaceRecord>;
  /** Every file and folder, in key order (sort for display with Intl.Collator). */
  loadTree(ws: string): Promise<EntryMeta[]>;
  getEntry(ws: string, path: WsPath): Promise<EntryMeta | null>;
  readFile(ws: string, path: WsPath): Promise<string>;
  /**
   * Saves LF text, keeping the file's line ending and BOM. Use durability "strict" for Ctrl+S.
   * `expect` makes it a compare-and-set: the save happens only if the stored text is still exactly
   * `expect` (the text the editor loaded or last saved); otherwise it throws StorageError "changed"
   * and stores nothing, so a pull or another writer's text is never overwritten unseen.
   */
  saveFile(ws: string, path: WsPath, text: string, options?: { durability?: Durability; expect?: string }): Promise<EntryMeta>;
  /** Creates a file (and any missing parent folders). New files are LF without a BOM by default. */
  createFile(ws: string, path: WsPath, text: string, options?: { eol?: Eol; bom?: boolean }): Promise<EntryMeta>;
  createDir(ws: string, path: WsPath): Promise<EntryMeta>;
  /** Renames or moves a file or a whole folder; returns every moved path. */
  renamePath(ws: string, from: WsPath, to: WsPath): Promise<{ from: WsPath; to: WsPath }[]>;
  /** Deletes a file or a whole folder; returns every deleted path. */
  deletePath(ws: string, path: WsPath): Promise<WsPath[]>;
  importFiles(ws: string, dir: WsPath | "", files: ImportedFile[], options?: { replace?: boolean; dirs?: string[] }): Promise<ImportResult>;
  /** Text files under `rootDir` for a run: no opaque entries, no conflict copies. */
  loadRunFiles(ws: string, rootDir?: WsPath | ""): Promise<WorkspaceFile[]>;
  loadExport(ws: string): Promise<ExportData>;
  workspaceStats(ws: string): Promise<WorkspaceStats>;
  getUiState(ws: string): Promise<UiState>;
  /** Open tabs, the active file and expanded folders; the stored arguments (`ui.args`) are kept as they are. */
  setUiState(ws: string, ui: UiState): Promise<void>;
  /** One file's Arguments text ("" removes it). Doesn't bump rev, like setUiState. */
  setRunArgs(ws: string, path: WsPath, text: string): Promise<void>;
  /**
   * Connects the workspace to a repository, or disconnects it (null). Choosing a different
   * repository or branch, or disconnecting, forgets the base table and the sync position
   * (baseCommit, baseTree, refEtag, lastSyncAt, lastError): nothing has been synced there.
   * Owner and repository names are compared ignoring case, as GitHub does.
   */
  setRemote(ws: string, remote: RemoteMeta | null): Promise<void>;
  /** Called after every committed write; returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void;
}

const MAX_UI_PATHS = 500;
/** A stored Arguments text is at most this long (the field itself stops runs at 4,096). */
const MAX_UI_ARGS_CHARS = 16 * 1024;
const MAX_NAME_LENGTH = 100;

export function createWorkspaceStore(db: WorkspaceDb, options: StoreOptions = {}): WorkspaceStore {
  const { limits, now, guard } = resolveOptions(options);

  function cleanName(name: string): string {
    const clean = name.trim();
    const checked = checkText(clean);
    if (!clean || clean.length > MAX_NAME_LENGTH || !checked.ok || checked.hidden > 0 || /[\t\n]/.test(clean)) {
      throw new StorageError("invalid", `A workspace name needs 1 to ${MAX_NAME_LENGTH} visible characters.`);
    }
    return clean;
  }

  function limitError(message: string): StorageError {
    return new StorageError("limit", message);
  }

  function fileTooBig(path: WsPath, size: number): StorageError {
    return limitError(`"${path}" would be ${Math.ceil(size / 1024)} KB; files can be at most ${limits.maxFileBytes / 1024} KB.`);
  }

  const workspaceFull = () => limitError(`The workspace can hold at most ${limits.maxBytes / (1024 * 1024)} MB of files.`);
  const tooManyFiles = () => limitError(`The workspace can hold at most ${limits.maxFiles} files.`);

  /**
   * Stores a blob id computed after a save, unless the file has been saved again since. mtime alone
   * can't prove that: another record (renamed here, or created in the same millisecond) can carry
   * the same mtime, so the text, line ending and BOM that were hashed must still be the stored ones.
   */
  async function fillSha(ws: string, path: WsPath, saved: EntryRecord, text: string, sha: string): Promise<boolean> {
    const result = await inTransaction(db, ["entries", "contents", "workspaces"], "readwrite", async (tx) => {
      const [entry, content, wsRec] = await Promise.all([
        tx.objectStore("entries").get([ws, path]),
        tx.objectStore("contents").get([ws, path]),
        tx.objectStore("workspaces").get(ws),
      ]);
      if (!entry || !wsRec || entry.kind !== "file" || entry.opaque || entry.mtime !== saved.mtime) return null;
      if (entry.eol !== saved.eol || entry.bom !== saved.bom || content?.text !== text) return null;
      if (entry.localSha === sha) return { rev: wsRec.rev, wrote: false };
      await tx.objectStore("entries").put({ ...entry, localSha: sha });
      return { rev: wsRec.rev, wrote: true };
    });
    if (result === null) return false;
    if (result.wrote) emitChange(db, { ws, rev: result.rev, paths: [path], reason: "sha" });
    return true;
  }

  function mapUi(ui: UiState, map: (path: WsPath) => WsPath | null): UiState {
    const list = (paths: WsPath[]) => [...new Set(paths.map(map).filter((p): p is WsPath => p !== null))];
    const next: UiState = { openTabs: list(ui.openTabs), activePath: ui.activePath === null ? null : map(ui.activePath), expanded: list(ui.expanded) };
    // A file's arguments follow it when it (or its folder) is renamed, and go when it is deleted.
    if (ui.args) {
      const args: Record<WsPath, string> = {};
      for (const [path, text] of Object.entries(ui.args)) {
        const to = map(path);
        if (to !== null) args[to] = text;
      }
      next.args = args;
    }
    return next;
  }

  /** The stored arguments, keeping only clean paths with text (records are read as untrusted). */
  function cleanArgs(args: unknown): Record<WsPath, string> {
    const out: Record<WsPath, string> = {};
    if (typeof args !== "object" || args === null) return out;
    for (const [key, text] of Object.entries(args)) {
      const path = tryNormalizePath(key);
      if (path !== null && typeof text === "string" && text && text.length <= MAX_UI_ARGS_CHARS) out[path] = text;
    }
    return out;
  }

  const store: WorkspaceStore = {
    async listWorkspaces() {
      return readRequest(db, (d) => d.getAll("workspaces"));
    },

    async getWorkspace(ws) {
      return (await readRequest(db, (d) => d.get("workspaces", ws))) ?? null;
    },

    async ensureWorkspace(name) {
      const clean = cleanName(name);
      let created = false;
      const record = await inTransaction(db, ["workspaces"], "readwrite", async (tx) => {
        const all = await tx.objectStore("workspaces").getAll();
        const found = all.find((w) => w.name === clean);
        if (found) return found;
        const t = now();
        const rec: WorkspaceRecord = {
          id: crypto.randomUUID(),
          name: clean,
          createdAt: t,
          updatedAt: t,
          rev: 0,
          remote: null,
          ui: { openTabs: [], activePath: null, expanded: [] },
        };
        await tx.objectStore("workspaces").put(rec);
        created = true;
        return rec;
      });
      if (created) emitChange(db, { ws: record.id, rev: record.rev, paths: [], reason: "workspace" });
      return record;
    },

    async loadTree(ws) {
      return (await readRequest(db, (d) => d.getAll("entries", wsRange(ws)))).map(toMeta);
    },

    async getEntry(ws, path) {
      const p = cleanPath(path);
      const entry = await readRequest(db, (d) => d.get("entries", [ws, p]));
      return entry ? toMeta(entry) : null;
    },

    async readFile(ws, path) {
      const p = cleanPath(path);
      return inTransaction(db, ["entries", "contents"], "readonly", async (tx) => {
        const [entry, content] = await Promise.all([tx.objectStore("entries").get([ws, p]), tx.objectStore("contents").get([ws, p])]);
        if (!entry) throw new StorageError("not-found", `"${p}" doesn't exist.`);
        if (entry.kind !== "file") throw new StorageError("not-a-file", `"${p}" is a folder.`);
        if (entry.opaque) throw new StorageError("read-only-entry", `"${p}" isn't a text file ExecFlow can open.`);
        if (!content) throw new StorageError("corrupt", `The text of "${p}" is missing.`);
        return content.text;
      });
    },

    async saveFile(ws, path, text, saveOptions = {}) {
      guard();
      const p = cleanPath(path);
      assertLf(text);
      const t = now();
      const saved = await inTransaction(
        db,
        ["entries", "contents", "workspaces"],
        "readwrite",
        async (tx) => {
          const entries = tx.objectStore("entries");
          const [entry, wsRec] = await Promise.all([entries.get([ws, p]), tx.objectStore("workspaces").get(ws)]);
          if (!wsRec) throw missingWorkspace(ws);
          if (!entry) throw new StorageError("not-found", `"${p}" doesn't exist any more.`);
          if (entry.kind !== "file") throw new StorageError("not-a-file", `"${p}" is a folder.`);
          if (entry.opaque) throw new StorageError("read-only-entry", `"${p}" can't be edited here.`);
          if (saveOptions.expect !== undefined) {
            const stored = await tx.objectStore("contents").get([ws, p]);
            if (stored?.text !== saveOptions.expect) throw new StorageError("changed", `"${p}" was changed elsewhere since it was opened.`);
          }
          const size = encodeFileBytes(text, entry.eol, entry.bom).length;
          if (size > limits.maxFileBytes) throw fileTooBig(p, size);
          if (size > entry.size) {
            // Growing: check the workspace total (metadata only, one key-range read).
            const index = new TreeIndex(await entries.getAll(wsRange(ws)));
            if (index.bytes - entry.size + size > limits.maxBytes) throw workspaceFull();
          }
          const next: EntryRecord = { ...entry, size, mtime: nextMtime(t, entry.mtime), localSha: null };
          const wsNext = bumped(wsRec, t);
          await Promise.all([tx.objectStore("contents").put({ ws, path: p, text }), entries.put(next), tx.objectStore("workspaces").put(wsNext)]);
          return { entry: next, rev: wsNext.rev };
        },
        saveOptions.durability,
      );
      emitChange(db, { ws, rev: saved.rev, paths: [p], reason: "save" });
      // Outside the transaction, and best effort: the text is saved already, so a failure here
      // only leaves the id null for sync's snapshot to recompute.
      const sha = await textBlobSha(text, saved.entry.eol, saved.entry.bom).catch(() => null);
      const filled = sha !== null && (await fillSha(ws, p, saved.entry, text, sha).catch(() => false));
      return toMeta(filled ? { ...saved.entry, localSha: sha } : saved.entry);
    },

    async createFile(ws, path, text, createOptions = {}) {
      guard();
      const p = cleanPath(path);
      assertLf(text);
      const checked = checkText(text);
      if (!checked.ok) throw new StorageError("invalid-text", `"${p}" wasn't created: ${checked.reason}.`);
      const eol = createOptions.eol ?? "\n";
      const bom = createOptions.bom ?? false;
      const bytes = encodeFileBytes(text, eol, bom);
      if (bytes.length > limits.maxFileBytes) throw fileTooBig(p, bytes.length);
      const sha = await gitBlobSha(bytes); // before the transaction opens
      const t = now();
      const result = await inTransaction(db, ["entries", "contents", "bases", "workspaces"], "readwrite", async (tx) => {
        guard(); // again: the tab may have lost the writer lock while the blob id was computed
        const [wsRec, all, base] = await Promise.all([
          tx.objectStore("workspaces").get(ws),
          tx.objectStore("entries").getAll(wsRange(ws)),
          tx.objectStore("bases").get([ws, p]),
        ]);
        if (!wsRec) throw missingWorkspace(ws);
        const index = new TreeIndex(all);
        index.assertFree(p);
        if (index.files + 1 > limits.maxFiles) throw tooManyFiles();
        if (index.bytes + bytes.length > limits.maxBytes) throw workspaceFull();
        const dirs = index.planParents(ws, p, t);
        const entry = fileRecord(ws, p, { size: bytes.length, eol, bom, localSha: sha, baseSha: base?.sha ?? null, now: t });
        const wsNext = bumped(wsRec, t);
        await Promise.all([
          ...dirs.map((d) => tx.objectStore("entries").put(d)),
          tx.objectStore("entries").put(entry),
          tx.objectStore("contents").put({ ws, path: p, text }),
          tx.objectStore("workspaces").put(wsNext),
        ]);
        return { entry, dirs, rev: wsNext.rev };
      });
      emitChange(db, { ws, rev: result.rev, paths: [...result.dirs.map((d) => d.path), p], reason: "create" });
      return toMeta(result.entry);
    },

    async createDir(ws, path) {
      guard();
      const p = cleanPath(path);
      const t = now();
      const result = await inTransaction(db, ["entries", "workspaces"], "readwrite", async (tx) => {
        const [wsRec, all] = await Promise.all([tx.objectStore("workspaces").get(ws), tx.objectStore("entries").getAll(wsRange(ws))]);
        if (!wsRec) throw missingWorkspace(ws);
        const index = new TreeIndex(all);
        index.assertFree(p);
        const dirs = [...index.planParents(ws, p, t), dirRecord(ws, p, t)];
        const wsNext = bumped(wsRec, t);
        await Promise.all([...dirs.map((d) => tx.objectStore("entries").put(d)), tx.objectStore("workspaces").put(wsNext)]);
        return { dirs, rev: wsNext.rev };
      });
      emitChange(db, { ws, rev: result.rev, paths: result.dirs.map((d) => d.path), reason: "create" });
      return toMeta(result.dirs[result.dirs.length - 1]!);
    },

    async renamePath(ws, from, to) {
      guard();
      const f = cleanPath(from);
      const target = cleanPath(to);
      if (f === target) return [];
      if (isInside(target, f)) throw new StorageError("invalid", `"${f}" can't be moved inside itself.`);
      const t = now();
      const result = await inTransaction(db, ["entries", "contents", "bases", "workspaces"], "readwrite", async (tx) => {
        const entries = tx.objectStore("entries");
        const contents = tx.objectStore("contents");
        const [wsRec, all, bases, below, own] = await Promise.all([
          tx.objectStore("workspaces").get(ws),
          entries.getAll(wsRange(ws)),
          tx.objectStore("bases").getAll(wsRange(ws)),
          contents.getAll(belowRange(ws, f)),
          contents.get([ws, f]),
        ]);
        if (!wsRec) throw missingWorkspace(ws);
        const index = new TreeIndex(all);
        const source = index.get(f);
        if (!source) throw new StorageError("not-found", `"${f}" doesn't exist.`);
        const moving = all.filter((r) => isInside(r.path, f));
        const opaque = moving.find((r) => r.opaque);
        if (opaque) {
          // Its bytes aren't stored here, so a rename couldn't be pushed as content.
          throw new StorageError("read-only-entry", `"${opaque.path}" came from GitHub as a file ExecFlow can't edit, so it can't be moved here; rename it on GitHub instead.`);
        }
        const movingPaths = new Set(moving.map((r) => r.path));
        const isMoving = (p: WsPath) => movingPaths.has(p);
        const moves = moving.map((r) => ({ record: r, to: cleanPath(target + r.path.slice(f.length)) }));
        for (const m of moves) index.assertFree(m.to, isMoving);
        for (const r of moving) index.remove(r.path);
        const dirs = index.planParents(ws, target, t);
        const baseSha = new Map(bases.map((b) => [b.path, b.sha]));
        const textOf = new Map([...below, ...(own ? [own] : [])].map((c) => [c.path, c.text]));
        const remap = (p: WsPath): WsPath => (isInside(p, f) ? target + p.slice(f.length) : p);
        const wsNext = { ...bumped(wsRec, t), ui: mapUi(wsRec.ui, remap) };
        const ops: Promise<unknown>[] = [entries.delete([ws, f]), entries.delete(belowRange(ws, f)), contents.delete([ws, f]), contents.delete(belowRange(ws, f))];
        for (const d of dirs) ops.push(entries.put(d));
        for (const { record, to: dest } of moves) {
          const moved: EntryRecord = { ...record, path: dest, parent: parentOf(dest), name: nameOf(dest) };
          if (record.kind === "file") {
            moved.baseSha = baseSha.get(dest) ?? null;
            const text = textOf.get(record.path);
            if (text === undefined) throw new StorageError("corrupt", `The text of "${record.path}" is missing.`);
            ops.push(contents.put({ ws, path: dest, text }));
          }
          ops.push(entries.put(moved));
        }
        ops.push(tx.objectStore("workspaces").put(wsNext));
        await Promise.all(ops);
        return { rev: wsNext.rev, dirs: dirs.map((d) => d.path), moved: moves.map((m) => ({ from: m.record.path, to: m.to })) };
      });
      emitChange(db, {
        ws,
        rev: result.rev,
        paths: [...result.dirs, ...result.moved.flatMap((m) => [m.from, m.to])],
        reason: "rename",
      });
      return result.moved;
    },

    async deletePath(ws, path) {
      guard();
      const p = cleanPath(path);
      const t = now();
      const result = await inTransaction(db, ["entries", "contents", "workspaces"], "readwrite", async (tx) => {
        const entries = tx.objectStore("entries");
        const contents = tx.objectStore("contents");
        const [wsRec, entry, below] = await Promise.all([tx.objectStore("workspaces").get(ws), entries.get([ws, p]), entries.getAllKeys(belowRange(ws, p))]);
        if (!wsRec) throw missingWorkspace(ws);
        if (!entry) throw new StorageError("not-found", `"${p}" doesn't exist.`);
        const deleted = [p, ...below.map((k) => k[1])];
        const wsNext = { ...bumped(wsRec, t), ui: mapUi(wsRec.ui, (q) => (isInside(q, p) ? null : q)) };
        await Promise.all([
          entries.delete([ws, p]),
          entries.delete(belowRange(ws, p)),
          contents.delete([ws, p]),
          contents.delete(belowRange(ws, p)),
          tx.objectStore("workspaces").put(wsNext),
        ]);
        return { rev: wsNext.rev, deleted };
      });
      emitChange(db, { ws, rev: result.rev, paths: result.deleted, reason: "delete" });
      return result.deleted;
    },

    async importFiles(ws, dir, files, importOptions = {}) {
      guard();
      const root = dir === "" ? "" : cleanPath(dir);
      const refused: ImportResult["refused"] = [];
      const hidden: ImportResult["hidden"] = [];
      // 1. Names, content checks and blob ids, before any transaction opens.
      const candidates: { name: string; path: WsPath; text: string; eol: Eol; bom: boolean; size: number; sha: string; hidden: number }[] = [];
      const seen = new Map<string, string>();
      for (const file of files) {
        const path = tryNormalizePath(joinPath(root, file.name));
        if (path === null) {
          refused.push({ name: file.name, reason: invalidNameReason(joinPath(root, file.name)) });
          continue;
        }
        const fold = foldKey(path);
        if (seen.has(fold)) {
          refused.push({ name: file.name, path, reason: `it has the same name as "${seen.get(fold)}" in this import` });
          continue;
        }
        const checked = checkBytes(file.bytes);
        if (!checked.ok) {
          refused.push({ name: file.name, path, reason: checked.reason });
          continue;
        }
        const bytes = encodeFileBytes(checked.text, checked.eol, checked.bom);
        if (bytes.length > limits.maxFileBytes) {
          refused.push({ name: file.name, path, reason: `it is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${limits.maxFileBytes / 1024} KB` });
          continue;
        }
        seen.set(fold, path); // only files that passed claim their name
        candidates.push({ name: file.name, path, text: checked.text, eol: checked.eol, bom: checked.bom, size: bytes.length, sha: await gitBlobSha(bytes), hidden: checked.hidden });
      }
      const emptyDirs: { name: string; path: WsPath }[] = [];
      for (const d of importOptions.dirs ?? []) {
        const path = tryNormalizePath(joinPath(root, d.replace(/\/+$/, "")));
        if (path === null) refused.push({ name: d, reason: invalidNameReason(joinPath(root, d)) });
        else emptyDirs.push({ name: d, path });
      }
      const t = now();
      // 2. One transaction decides what fits and writes it.
      const result = await inTransaction(db, ["entries", "contents", "bases", "workspaces"], "readwrite", async (tx) => {
        guard(); // again: the tab may have lost the writer lock while the files were checked and hashed
        const entries = tx.objectStore("entries");
        const contents = tx.objectStore("contents");
        const [wsRec, all, bases] = await Promise.all([tx.objectStore("workspaces").get(ws), entries.getAll(wsRange(ws)), tx.objectStore("bases").getAll(wsRange(ws))]);
        if (!wsRec) throw missingWorkspace(ws);
        const index = new TreeIndex(all);
        const rootEntry = root === "" ? undefined : index.get(root);
        if (rootEntry && rootEntry.kind !== "dir") throw new StorageError("not-a-folder", `"${root}" is a file, so files can't be imported into it.`);
        const baseSha = new Map(bases.map((b) => [b.path, b.sha]));
        const added: WsPath[] = [];
        const replaced: WsPath[] = [];
        const dirs: WsPath[] = [];
        const ops: Promise<unknown>[] = [];
        const addParents = (path: WsPath) => {
          for (const d of index.planParents(ws, path, t)) {
            index.add(d);
            dirs.push(d.path);
            ops.push(entries.put(d));
          }
        };
        for (const c of candidates) {
          const existing = index.get(c.path);
          if (existing) {
            if (!importOptions.replace) {
              refused.push({ name: c.name, path: c.path, reason: "a file with this name already exists" });
            } else if (existing.kind !== "file") {
              refused.push({ name: c.name, path: c.path, reason: "a folder already has this name" });
            } else if (existing.opaque) {
              refused.push({ name: c.name, path: c.path, reason: "the existing file came from GitHub and can't be replaced here" });
            } else if (index.bytes - existing.size + c.size > limits.maxBytes) {
              refused.push({ name: c.name, path: c.path, reason: `the workspace would be over ${limits.maxBytes / (1024 * 1024)} MB` });
            } else {
              const next: EntryRecord = { ...existing, size: c.size, eol: c.eol, bom: c.bom, mtime: nextMtime(t, existing.mtime), localSha: c.sha };
              index.add(next);
              ops.push(entries.put(next), contents.put({ ws, path: c.path, text: c.text }));
              replaced.push(c.path);
              if (c.hidden > 0) hidden.push({ path: c.path, count: c.hidden });
            }
            continue;
          }
          const twin = index.caseTwin(c.path);
          if (twin) {
            refused.push({ name: c.name, path: c.path, reason: `it differs only in letter case from "${twin}"` });
            continue;
          }
          if (index.files + 1 > limits.maxFiles) {
            refused.push({ name: c.name, path: c.path, reason: `the workspace would have more than ${limits.maxFiles} files` });
            continue;
          }
          if (index.bytes + c.size > limits.maxBytes) {
            refused.push({ name: c.name, path: c.path, reason: `the workspace would be over ${limits.maxBytes / (1024 * 1024)} MB` });
            continue;
          }
          try {
            addParents(c.path);
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            refused.push({ name: c.name, path: c.path, reason: lowerFirst(error.message) });
            continue;
          }
          const entry = fileRecord(ws, c.path, { size: c.size, eol: c.eol, bom: c.bom, localSha: c.sha, baseSha: baseSha.get(c.path) ?? null, now: t });
          index.add(entry);
          ops.push(entries.put(entry), contents.put({ ws, path: c.path, text: c.text }));
          added.push(c.path);
          if (c.hidden > 0) hidden.push({ path: c.path, count: c.hidden });
        }
        for (const d of emptyDirs) {
          const existing = index.get(d.path);
          if (existing?.kind === "dir") continue;
          try {
            if (existing) throw new StorageError("exists", `a file is already called "${d.path}"`);
            index.assertFree(d.path);
            addParents(d.path);
            const rec = dirRecord(ws, d.path, t);
            index.add(rec);
            dirs.push(d.path);
            ops.push(entries.put(rec));
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            refused.push({ name: d.name, path: d.path, reason: lowerFirst(error.message) });
          }
        }
        if (ops.length === 0) return { rev: wsRec.rev, added, replaced, dirs, wrote: false };
        const wsNext = bumped(wsRec, t);
        ops.push(tx.objectStore("workspaces").put(wsNext));
        await Promise.all(ops);
        return { rev: wsNext.rev, added, replaced, dirs, wrote: true };
      });
      if (result.wrote) emitChange(db, { ws, rev: result.rev, paths: [...result.dirs, ...result.added, ...result.replaced], reason: "import" });
      return { added: result.added, replaced: result.replaced, dirs: result.dirs, refused, hidden };
    },

    async loadRunFiles(ws, rootDir = "") {
      const root = rootDir === "" ? "" : cleanPath(rootDir);
      return inTransaction(db, ["entries", "contents"], "readonly", async (tx) => {
        const [rootEntry, entries, contents] = await Promise.all([
          root === "" ? Promise.resolve(undefined) : tx.objectStore("entries").get([ws, root]),
          tx.objectStore("entries").getAll(belowRange(ws, root)),
          tx.objectStore("contents").getAll(belowRange(ws, root)),
        ]);
        if (root !== "" && !rootEntry) throw new StorageError("not-found", `"${root}" doesn't exist.`);
        if (rootEntry && rootEntry.kind !== "dir") throw new StorageError("not-a-folder", `"${root}" is a file, not a folder.`);
        const textOf = new Map(contents.map((c) => [c.path, c.text]));
        const out: WorkspaceFile[] = [];
        for (const e of entries) {
          if (e.kind !== "file" || e.opaque || isConflictCopy(e.path)) continue;
          const text = textOf.get(e.path);
          if (text === undefined) throw new StorageError("corrupt", `The text of "${e.path}" is missing.`);
          out.push({ path: e.path, text });
        }
        return out;
      });
    },

    async loadExport(ws) {
      return inTransaction(db, ["entries", "contents"], "readonly", async (tx) => {
        const [entries, contents] = await Promise.all([tx.objectStore("entries").getAll(wsRange(ws)), tx.objectStore("contents").getAll(wsRange(ws))]);
        const textOf = new Map(contents.map((c) => [c.path, c.text]));
        const parents = new Set(entries.map((e) => e.parent));
        const data: ExportData = { files: [], dirs: [], skipped: [] };
        for (const e of entries) {
          if (e.kind === "dir") {
            if (!parents.has(e.path)) data.dirs.push(e.path);
          } else if (e.opaque) {
            data.skipped.push(e.path);
          } else {
            const text = textOf.get(e.path);
            if (text === undefined) throw new StorageError("corrupt", `The text of "${e.path}" is missing.`);
            data.files.push({ path: e.path, bytes: encodeFileBytes(text, e.eol, e.bom), mtime: e.mtime });
          }
        }
        return data;
      });
    },

    async workspaceStats(ws) {
      return inTransaction(db, ["entries", "bases"], "readonly", async (tx) => {
        const [entries, baseKeys] = await Promise.all([tx.objectStore("entries").getAll(wsRange(ws)), tx.objectStore("bases").getAllKeys(wsRange(ws))]);
        const stats: WorkspaceStats = { files: 0, dirs: 0, opaque: 0, bytes: 0, changed: 0, added: 0, deleted: 0, limits: { ...limits } };
        const filePaths = new Set<WsPath>();
        for (const e of entries) {
          if (e.kind === "dir") {
            stats.dirs++;
            continue;
          }
          filePaths.add(e.path);
          stats.files++;
          const sha = e.opaque ? e.opaque.sha : e.localSha;
          if (e.opaque) stats.opaque++;
          else stats.bytes += e.size;
          if (e.baseSha === null) stats.added++;
          else if (sha !== e.baseSha) stats.changed++;
        }
        stats.deleted = baseKeys.filter((k) => !filePaths.has(k[1])).length;
        return stats;
      });
    },

    async getUiState(ws) {
      const rec = await readRequest(db, (d) => d.get("workspaces", ws));
      if (!rec) throw missingWorkspace(ws);
      if (!rec.ui.args) return rec.ui;
      // Only files that exist: a sync that removed a file doesn't go through mapUi.
      const files = new Set((await readRequest(db, (d) => d.getAllKeys("entries", wsRange(ws)))).map((k) => k[1]));
      const args = Object.fromEntries(Object.entries(cleanArgs(rec.ui.args)).filter(([path]) => files.has(path)));
      return { ...rec.ui, args };
    },

    async setUiState(ws, ui) {
      guard();
      const clean = (paths: unknown): WsPath[] => {
        if (!Array.isArray(paths)) return [];
        const valid = paths.map((p) => (typeof p === "string" ? tryNormalizePath(p) : null)).filter((p): p is WsPath => p !== null);
        return [...new Set(valid)].slice(0, MAX_UI_PATHS);
      };
      const next: UiState = {
        openTabs: clean(ui.openTabs),
        activePath: typeof ui.activePath === "string" ? tryNormalizePath(ui.activePath) : null,
        expanded: clean(ui.expanded),
      };
      const rev = await inTransaction(db, ["workspaces"], "readwrite", async (tx) => {
        const rec = await tx.objectStore("workspaces").get(ws);
        if (!rec) throw missingWorkspace(ws);
        // The arguments have their own writer (setRunArgs): what is stored stays.
        await tx.objectStore("workspaces").put({ ...rec, ui: rec.ui.args ? { ...next, args: rec.ui.args } : next });
        return rec.rev;
      });
      emitChange(db, { ws, rev, paths: [], reason: "ui" });
    },

    async setRunArgs(ws, path, text) {
      guard();
      const clean = tryNormalizePath(path);
      if (clean === null) throw new StorageError("invalid-path", `"${path}" isn't a valid file path.`);
      if (text.length > MAX_UI_ARGS_CHARS) throw new StorageError("limit",`The arguments for ${nameOf(clean)} are too long to keep.`);
      const rev = await inTransaction(db, ["workspaces", "entries"], "readwrite", async (tx) => {
        const [rec, entry] = await Promise.all([tx.objectStore("workspaces").get(ws), tx.objectStore("entries").get([ws, clean])]);
        if (!rec) throw missingWorkspace(ws);
        const args = cleanArgs(rec.ui.args);
        // Only a file keeps arguments: a save that arrives after its file was deleted or renamed
        // writes nothing (a later file with that name starts without them).
        if (text && entry?.kind === "file") {
          if (!(clean in args) && Object.keys(args).length >= MAX_UI_PATHS) throw new StorageError("limit", "Arguments are kept for at most 500 files.");
          args[clean] = text;
        } else delete args[clean];
        await tx.objectStore("workspaces").put({ ...rec, ui: { ...rec.ui, args } });
        return rec.rev;
      });
      emitChange(db, { ws, rev, paths: [], reason: "ui" });
    },

    async setRemote(ws, remote) {
      guard();
      if (remote !== null) validateRemote(remote);
      const t = now();
      const rev = await inTransaction(db, ["workspaces", "bases", "entries"], "readwrite", async (tx) => {
        const rec = await tx.objectStore("workspaces").get(ws);
        if (!rec) throw missingWorkspace(ws);
        // GitHub account and repository names ignore case (the sync engine compares them the same
        // way); branch names don't.
        const same = (a: RemoteMeta | null, b: RemoteMeta | null) =>
          a !== null &&
          b !== null &&
          a.provider === b.provider &&
          a.owner.toLowerCase() === b.owner.toLowerCase() &&
          a.repo.toLowerCase() === b.repo.toLowerCase() &&
          a.branch === b.branch;
        const ops: Promise<unknown>[] = [];
        let stored = remote === null ? null : { ...remote };
        if (!same(rec.remote, remote)) {
          // A different repository (or none): the old base table says nothing about it.
          const entries = await tx.objectStore("entries").getAll(wsRange(ws));
          ops.push(tx.objectStore("bases").delete(wsRange(ws)));
          for (const e of entries) if (e.baseSha !== null) ops.push(tx.objectStore("entries").put({ ...e, baseSha: null }));
          // Nor does the old sync position: a base commit without its base table would make sync
          // skip the first-connect choice and merge against a commit of another branch or repository.
          if (stored) stored = { ...stored, baseCommit: null, baseTree: null, refEtag: null, lastSyncAt: null, lastError: null };
        }
        const next = bumped({ ...rec, remote: stored }, t);
        ops.push(tx.objectStore("workspaces").put(next));
        await Promise.all(ops);
        return next.rev;
      });
      emitChange(db, { ws, rev, paths: [], reason: "remote" });
    },

    onChange(listener) {
      return addChangeListener(db, listener);
    },
  };
  return store;
}

function lowerFirst(message: string): string {
  const s = message.replace(/\.$/, "");
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function invalidNameReason(path: string): string {
  try {
    cleanPath(path);
  } catch (error) {
    if (error instanceof StorageError) return lowerFirst(error.message);
  }
  return "the name can't be used";
}
