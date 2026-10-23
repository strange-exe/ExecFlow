// The storage side of GitHub sync (core/types.ts SyncStore). snapshot() hands the engine blob ids
// only; commit() applies a whole sync result in ONE transaction, path by path guarded by the local
// blob id the plan was made from, so nothing typed after the snapshot is ever overwritten.
//
// Extensions to the shared SyncCommit (see SyncStoreCommit below):
//   - `opaque` writes a pulled file that can't be stored as text (binary, non-UTF-8, mixed line
//     endings, symlink, submodule) as an opaque entry: only its blob id and mode are kept.
//   - A path that is skipped keeps its PREVIOUS base entry (or stays out of the base table), so the
//     next sync's 3-way merge sees both the local edit and the remote change, rather than mistaking
//     the remote version for the base and overwriting it.

import { encodeFileBytes, gitBlobSha, textBlobSha, type Eol } from "../core/bytes";
import type { BaseEntry, LocalFileState, OpaquePut, RemoteMeta, SyncCommit, SyncSnapshot, SyncStore, WsPath } from "../core/types";
import { emitChange, inTransaction, StorageError, wsRange, type BaseRecord, type EntryRecord, type WorkspaceDb } from "./db";
import {
  assertLf,
  bumped,
  cleanPath,
  currentSha,
  fileRecord,
  missingWorkspace,
  nextMtime,
  resolveOptions,
  TreeIndex,
  validateRemote,
  type StoreOptions,
} from "./internal";

/** A pulled file kept by blob id only (core OpaquePut). `size` (from the GitHub tree) is shown in the file tree. */
export type OpaqueWrite = OpaquePut;

/** Core SyncCommit, which now carries `opaque` itself. */
export type SyncStoreCommit = SyncCommit;

export interface WorkspaceSyncStore extends SyncStore {
  commit(change: SyncStoreCommit): Promise<{ skipped: WsPath[] }>;
}

/** A blob id computed outside a transaction, with what it was computed from. */
interface Hashed {
  sha: string;
  mtime: number;
  text: string;
  eol: Eol;
  bom: boolean;
}

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MODE = /^[0-7]{6}$/;

const NO_REMOTE: RemoteMeta = {
  provider: "github",
  owner: "",
  repo: "",
  branch: "",
  baseCommit: null,
  baseTree: null,
  refEtag: null,
  lastSyncAt: null,
  lastError: null,
  deviceName: "",
};

export function createSyncStore(db: WorkspaceDb, ws: string, options: StoreOptions = {}): WorkspaceSyncStore {
  const { limits, now, guard } = resolveOptions(options);

  function invalid(message: string): StorageError {
    return new StorageError("invalid", message);
  }

  /** Paths from the engine must already be canonical: anything else is a bug upstream. */
  function canonical(path: string, what: string): WsPath {
    const clean = cleanPath(path);
    if (clean !== path) throw invalid(`The ${what} path "${path}" isn't in canonical form.`);
    return clean;
  }

  async function snapshot(): Promise<SyncSnapshot> {
    const read = await inTransaction(db, ["entries", "contents", "bases", "workspaces"], "readonly", async (tx) => {
      const [wsRec, entries, bases] = await Promise.all([
        tx.objectStore("workspaces").get(ws),
        tx.objectStore("entries").getAll(wsRange(ws)),
        tx.objectStore("bases").getAll(wsRange(ws)),
      ]);
      if (!wsRec) throw missingWorkspace(ws);
      const stale = entries.filter((e) => e.kind === "file" && !e.opaque && e.localSha === null);
      const texts = await Promise.all(stale.map((e) => tx.objectStore("contents").get([ws, e.path])));
      return { wsRec, entries, bases, stale: stale.map((entry, i) => ({ entry, text: texts[i]?.text })) };
    });
    // Hash outside the transaction, then keep the ids for next time (compare-and-set on what was hashed).
    const computed = new Map<WsPath, Hashed>();
    for (const { entry, text } of read.stale) {
      // A text file without its text would look deleted to the merge and be deleted on GitHub.
      if (text === undefined) throw new StorageError("corrupt", `The text of "${entry.path}" is missing, so sync stopped.`);
      computed.set(entry.path, { sha: await textBlobSha(text, entry.eol, entry.bom), mtime: entry.mtime, text, eol: entry.eol, bom: entry.bom });
    }
    if (computed.size > 0) await storeShas(computed).catch(() => {});

    const local = new Map<WsPath, LocalFileState>();
    for (const e of read.entries) {
      if (e.kind !== "file") continue;
      const sha = e.opaque ? e.opaque.sha : (e.localSha ?? computed.get(e.path)!.sha);
      const state: LocalFileState = { path: e.path, sha, eol: e.eol, bom: e.bom };
      if (e.opaque) state.opaque = { sha: e.opaque.sha, mode: e.opaque.mode };
      local.set(e.path, state);
    }
    const base = new Map<WsPath, BaseEntry>(read.bases.map((b) => [b.path, { path: b.path, sha: b.sha, mode: b.mode }]));
    return { local, base, remote: read.wsRec.remote === null ? null : { ...read.wsRec.remote } };
  }

  /**
   * Keeps computed ids, but only on records that still hold exactly what was hashed: mtime alone
   * can't tell two files saved in the same millisecond apart once one is renamed onto the other's
   * path, and a wrong id there would let a sync overwrite or delete that file.
   */
  async function storeShas(computed: Map<WsPath, Hashed>): Promise<void> {
    if (!(options.canWrite?.() ?? true)) return;
    const paths = await inTransaction(db, ["entries", "contents"], "readwrite", async (tx) => {
      const store = tx.objectStore("entries");
      const keys = [...computed.keys()];
      const [current, texts] = await Promise.all([
        Promise.all(keys.map((p) => store.get([ws, p]))),
        Promise.all(keys.map((p) => tx.objectStore("contents").get([ws, p]))),
      ]);
      const writes: EntryRecord[] = [];
      current.forEach((e, i) => {
        const c = e && computed.get(e.path);
        if (!e || !c || e.kind !== "file" || e.opaque || e.mtime !== c.mtime || e.localSha === c.sha) return;
        if (e.eol === c.eol && e.bom === c.bom && texts[i]?.text === c.text) writes.push({ ...e, localSha: c.sha });
      });
      await Promise.all(writes.map((w) => store.put(w)));
      return writes.map((w) => w.path);
    });
    if (paths.length > 0) {
      const rec = await db.get("workspaces", ws);
      if (rec) emitChange(db, { ws, rev: rec.rev, paths, reason: "sha" });
    }
  }

  async function readText(path: WsPath): Promise<string> {
    const p = cleanPath(path);
    return inTransaction(db, ["entries", "contents"], "readonly", async (tx) => {
      const [entry, content] = await Promise.all([tx.objectStore("entries").get([ws, p]), tx.objectStore("contents").get([ws, p])]);
      if (!entry) throw new StorageError("not-found", `"${p}" doesn't exist.`);
      if (entry.kind !== "file") throw new StorageError("not-a-file", `"${p}" is a folder.`);
      if (entry.opaque) throw new StorageError("read-only-entry", `"${p}" isn't stored as text.`);
      if (!content) throw new StorageError("corrupt", `The text of "${p}" is missing.`);
      return content.text;
    });
  }

  async function commit(change: SyncStoreCommit): Promise<{ skipped: WsPath[] }> {
    guard();
    // 1. Validate everything (and check each blob id against its text) before the transaction.
    const touched = new Set<WsPath>();
    const once = (path: WsPath) => {
      if (touched.has(path)) throw invalid(`"${path}" appears more than once in one sync.`);
      touched.add(path);
    };
    const puts = change.put.map((put) => {
      const path = canonical(put.path, "pulled");
      once(path);
      assertLf(put.text);
      if (put.eol !== "\n" && put.eol !== "\r\n" && put.eol !== "\r") throw invalid(`"${path}" has an unknown line ending.`);
      const bytes = encodeFileBytes(put.text, put.eol, put.bom);
      if (bytes.length > limits.maxFileBytes) throw new StorageError("limit", `"${path}" is over ${limits.maxFileBytes / 1024} KB, so it can't be stored as text.`);
      return { ...put, path, bytes };
    });
    for (const put of puts) {
      if ((await gitBlobSha(put.bytes)) !== put.sha) throw invalid(`The blob id given for "${put.path}" doesn't match its text.`);
    }
    const removes = change.remove.map((rm) => {
      const path = canonical(rm.path, "deleted");
      once(path);
      return { path, expect: rm.expect };
    });
    const opaques = (change.opaque ?? []).map((o) => {
      const path = canonical(o.path, "pulled");
      once(path);
      if (!SHA.test(o.sha) || !MODE.test(o.mode)) throw invalid(`"${path}" has an invalid blob id or mode.`);
      return { ...o, path };
    });
    const nextBase = new Map<WsPath, BaseEntry>();
    for (const b of change.base) {
      const path = canonical(b.path, "base");
      if (nextBase.has(path)) throw invalid(`"${path}" appears twice in the base table.`);
      if (!SHA.test(b.sha) || !MODE.test(b.mode)) throw invalid(`The base entry for "${path}" has an invalid blob id or mode.`);
      nextBase.set(path, { path, sha: b.sha, mode: b.mode });
    }

    const t = now();
    // 2. One transaction: entries, contents, bases and the workspace record.
    const result = await inTransaction(
      db,
      ["entries", "contents", "bases", "workspaces"],
      "readwrite",
      async (tx) => {
        guard(); // again: the tab may have lost the writer lock while the blob ids were checked
        const entries = tx.objectStore("entries");
        const contents = tx.objectStore("contents");
        const basesStore = tx.objectStore("bases");
        const [wsRec, all, oldBases] = await Promise.all([tx.objectStore("workspaces").get(ws), entries.getAll(wsRange(ws)), basesStore.getAll(wsRange(ws))]);
        if (!wsRec) throw missingWorkspace(ws);
        const remote: RemoteMeta = { ...(wsRec.remote ?? NO_REMOTE), ...change.remote, provider: "github" };
        validateRemote(remote);

        const index = new TreeIndex(all);
        const skipped: WsPath[] = [];
        const applied: WsPath[] = [];
        const ops: Promise<unknown>[] = [];
        /** Final records to put, by path (written once, after the base ids are settled). */
        const changed = new Map<WsPath, EntryRecord>();
        const matches = (r: EntryRecord | undefined, expect: string) =>
          expect === "absent" ? r === undefined : r !== undefined && r.kind === "file" && currentSha(r) === expect;

        // Removes first, so a file can give way to a folder of the same name in the same sync.
        for (const rm of removes) {
          const r = index.get(rm.path);
          if (!matches(r, rm.expect)) {
            skipped.push(rm.path);
            continue;
          }
          index.remove(rm.path);
          ops.push(entries.delete([ws, rm.path]), contents.delete([ws, rm.path]));
          applied.push(rm.path);
        }

        /**
         * Git has no empty folders: an empty folder record (often left behind when the files in it were
         * deleted remotely) gives way to a pulled file of the same name. Only for a put that expects the
         * path to be absent here, so a put that ends up skipped changes nothing.
         */
        const yieldEmptyFolder = (path: WsPath, expect: string): EntryRecord | undefined => {
          const r = index.get(path);
          if (expect !== "absent" || r?.kind !== "dir") return r;
          const prefix = path + "/";
          for (const other of index.values()) if (other.path.startsWith(prefix)) return r;
          index.remove(path);
          changed.delete(path);
          ops.push(entries.delete([ws, path]));
          return undefined;
        };

        /** Parent folders for a new path; null when a file is in the way. */
        const parentsFor = (path: WsPath): EntryRecord[] | null => {
          try {
            return index.planParents(ws, path, t, false); // git allows names that differ only in case
          } catch (error) {
            if (error instanceof StorageError) return null;
            throw error;
          }
        };

        for (const put of puts) {
          const r = yieldEmptyFolder(put.path, put.expect);
          const parents = r ? [] : parentsFor(put.path);
          if (!matches(r, put.expect) || parents === null) {
            skipped.push(put.path);
            continue;
          }
          for (const d of parents) {
            index.add(d);
            changed.set(d.path, d);
          }
          const record = r
            ? { ...withoutOpaque(r), size: put.bytes.length, eol: put.eol, bom: put.bom, mtime: nextMtime(t, r.mtime), localSha: put.sha }
            : fileRecord(ws, put.path, { size: put.bytes.length, eol: put.eol, bom: put.bom, localSha: put.sha, baseSha: null, now: t });
          index.add(record);
          changed.set(put.path, record);
          ops.push(contents.put({ ws, path: put.path, text: put.text }));
          applied.push(put.path);
        }

        for (const o of opaques) {
          const r = yieldEmptyFolder(o.path, o.expect);
          const parents = r ? [] : parentsFor(o.path);
          if (!matches(r, o.expect) || parents === null) {
            skipped.push(o.path);
            continue;
          }
          for (const d of parents) {
            index.add(d);
            changed.set(d.path, d);
          }
          const size = o.size ?? 0;
          const blob = { sha: o.sha, mode: o.mode };
          const record: EntryRecord = r
            ? { ...r, size, eol: "\n", bom: false, mtime: nextMtime(t, r.mtime), localSha: o.sha, opaque: blob }
            : fileRecord(ws, o.path, { size, eol: "\n", bom: false, localSha: o.sha, baseSha: null, now: t, opaque: blob });
          index.add(record);
          changed.set(o.path, record);
          if (r && !r.opaque) ops.push(contents.delete([ws, o.path]));
          applied.push(o.path);
        }

        if (index.files > limits.maxFiles) throw new StorageError("limit", `After this sync the workspace would have ${index.files} files; the limit is ${limits.maxFiles}.`);
        if (index.bytes > limits.maxBytes) throw new StorageError("limit", `After this sync the workspace would be over ${limits.maxBytes / (1024 * 1024)} MB.`);

        // The base table: replaced, except that skipped paths keep what they had.
        const previous = new Map<WsPath, BaseRecord>(oldBases.map((b) => [b.path, b]));
        for (const path of skipped) {
          const old = previous.get(path);
          if (old) nextBase.set(path, { path, sha: old.sha, mode: old.mode });
          else nextBase.delete(path);
        }
        ops.push(basesStore.delete(wsRange(ws)));
        for (const b of nextBase.values()) ops.push(basesStore.put({ ws, path: b.path, sha: b.sha, mode: b.mode }));

        // Every file's baseSha follows the new base table.
        for (const r of index.values()) {
          if (r.kind !== "file") continue;
          const want = nextBase.get(r.path)?.sha ?? null;
          const pending = changed.get(r.path);
          if (pending) pending.baseSha = want;
          else if (r.baseSha !== want) changed.set(r.path, { ...r, baseSha: want });
        }
        for (const r of changed.values()) ops.push(entries.put(r));

        // Command-line arguments go with the files this sync removed (a later file of that name starts without them).
        const args = wsRec.ui.args && Object.fromEntries(Object.entries(wsRec.ui.args).filter(([p]) => index.get(p)?.kind === "file"));
        const wsNext = { ...bumped(wsRec, t), remote, ...(args ? { ui: { ...wsRec.ui, args } } : {}) };
        ops.push(tx.objectStore("workspaces").put(wsNext));
        await Promise.all(ops);
        return { skipped, applied, rev: wsNext.rev, dirs: [...changed.values()].filter((r) => r.kind === "dir").map((r) => r.path) };
      },
      "strict",
    );
    emitChange(db, { ws, rev: result.rev, paths: [...result.dirs, ...result.applied], reason: "sync" });
    return { skipped: result.skipped };
  }

  return { snapshot, readText, commit };
}

function withoutOpaque(r: EntryRecord): EntryRecord {
  const copy = { ...r };
  delete copy.opaque;
  return copy;
}
