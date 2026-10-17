import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFileBytes, gitBlobSha, textBlobSha } from "../core/bytes";
import type { BaseEntry, RemoteMeta } from "../core/types";
import { openWorkspaceDb, StorageError, type ChangeEvent, type WorkspaceDb } from "./db";
import { createSyncStore, type SyncStoreCommit, type WorkspaceSyncStore } from "./sync-store";
import { createWorkspaceStore, type WorkspaceStore } from "./workspace";

let db: WorkspaceDb;
let store: WorkspaceStore;
let sync: WorkspaceSyncStore;
let ws: string;

const REMOTE: RemoteMeta = {
  provider: "github",
  owner: "me",
  repo: "code",
  branch: "main",
  baseCommit: "c1",
  baseTree: "t1",
  refEtag: null,
  lastSyncAt: null,
  lastError: null,
  deviceName: "laptop",
};

beforeEach(async () => {
  db = await openWorkspaceDb({ name: `test-${crypto.randomUUID()}` });
  store = createWorkspaceStore(db);
  ws = (await store.ensureWorkspace("Default")).id;
  sync = createSyncStore(db, ws);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const sha = (text: string) => textBlobSha(text);
const base = (path: string, s: string, mode = "100644"): BaseEntry => ({ path, sha: s, mode });
const commit = (c: Partial<SyncStoreCommit>) => sync.commit({ put: [], remove: [], base: [], remote: {}, ...c });
const put = async (path: string, text: string, expect: string, eol: "\n" | "\r\n" | "\r" = "\n", bom = false) => ({
  path,
  text,
  eol,
  bom,
  sha: await gitBlobSha(encodeFileBytes(text, eol, bom)),
  expect,
});

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
}

/** Holds back the first crypto.subtle.digest call until open(); `reached` settles when it starts. */
function holdFirstDigest() {
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const started = new Promise<void>((resolve) => (reached = resolve));
  let calls = 0;
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    if (++calls === 1) {
      reached();
      await gate;
    }
    return realDigest(algorithm, data);
  });
  return { open, reached: started };
}

async function dump() {
  return {
    entries: await db.getAll("entries"),
    contents: await db.getAll("contents"),
    workspaces: await db.getAll("workspaces"),
    bases: await db.getAll("bases"),
  };
}

/** A workspace in step with a remote that has a.c and b.c. */
async function synced() {
  await store.createFile(ws, "a.c", "a1\n");
  await store.createFile(ws, "b.c", "b1\n");
  await commit({ base: [base("a.c", await sha("a1\n")), base("b.c", await sha("b1\n"))], remote: REMOTE });
}

describe("snapshot", () => {
  it("reports every file's blob id, the base table and the remote", async () => {
    await synced();
    await store.createFile(ws, "dir/new.py", "x = 1\n", { eol: "\r\n", bom: true });
    const snap = await sync.snapshot();
    expect([...snap.local.keys()].sort()).toEqual(["a.c", "b.c", "dir/new.py"]);
    expect(snap.local.get("dir/new.py")).toEqual({ path: "dir/new.py", sha: await gitBlobSha(encodeFileBytes("x = 1\n", "\r\n", true)), eol: "\r\n", bom: true });
    expect([...snap.base.values()]).toEqual([base("a.c", await sha("a1\n")), base("b.c", await sha("b1\n"))]);
    expect(snap.remote).toEqual(REMOTE);
  });

  it("computes missing blob ids before returning, and keeps them", async () => {
    await store.createFile(ws, "a.c", "hello\n");
    const entry = (await db.get("entries", [ws, "a.c"]))!;
    await db.put("entries", { ...entry, localSha: null }); // e.g. the tab closed before hashing
    const snap = await sync.snapshot();
    expect(snap.local.get("a.c")!.sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect((await store.getEntry(ws, "a.c"))!.localSha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("in a read-only tab computes missing blob ids but doesn't write them", async () => {
    await store.createFile(ws, "a.c", "hello\n");
    const entry = (await db.get("entries", [ws, "a.c"]))!;
    await db.put("entries", { ...entry, localSha: null });
    const snap = await createSyncStore(db, ws, { canWrite: () => false }).snapshot();
    expect(snap.local.get("a.c")!.sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect((await store.getEntry(ws, "a.c"))!.localSha).toBeNull();
  });

  it("stops if a text file has lost its text, rather than letting it look deleted", async () => {
    await store.createFile(ws, "a.c", "x\n");
    const entry = (await db.get("entries", [ws, "a.c"]))!;
    await db.put("entries", { ...entry, localSha: null });
    await db.delete("contents", [ws, "a.c"]);
    expect(await outcome(sync.snapshot())).toBe("corrupt");
  });

  it("doesn't give a computed blob id to a different file that took the path while it was hashed", async () => {
    // Two files saved in the same millisecond have equal mtimes, so mtime alone can't tell them apart.
    const frozen = createWorkspaceStore(db, { now: () => 1000 });
    await frozen.createFile(ws, "a.c", "mine\n");
    await frozen.createFile(ws, "b.c", "other\n");
    for (const p of ["a.c", "b.c"]) {
      const e = (await db.get("entries", [ws, p]))!;
      await db.put("entries", { ...e, localSha: null }); // ids still to compute
    }
    const [mine, other, remoteSha] = [await sha("mine\n"), await sha("other\n"), await sha("remote\n")];
    const gate = holdFirstDigest();
    const snapping = sync.snapshot();
    await gate.reached;
    // While the snapshot hashes, the user moves b.c away and a.c into its place.
    await store.renamePath(ws, "b.c", "z.c");
    await store.renamePath(ws, "a.c", "b.c");
    gate.open();
    const snap = await snapping;
    expect(snap.local.get("b.c")!.sha).toBe(other); // the snapshot itself describes what it read
    expect((await store.getEntry(ws, "b.c"))!.localSha).not.toBe(other);
    // So a sync planned from that snapshot can't overwrite (or delete) the moved file.
    const remote = { path: "b.c", text: "remote\n", eol: "\n" as const, bom: false, sha: remoteSha, expect: other };
    expect((await commit({ put: [remote], base: [base("b.c", remoteSha)], remote: REMOTE })).skipped).toEqual(["b.c"]);
    expect(await store.readFile(ws, "b.c")).toBe("mine\n");
    expect((await commit({ remove: [{ path: "b.c", expect: other }], base: [] })).skipped).toEqual(["b.c"]);
    expect(await store.readFile(ws, "b.c")).toBe("mine\n");
    expect((await sync.snapshot()).local.get("b.c")!.sha).toBe(mine);
  });

  it("readText returns LF text and refuses folders and opaque files", async () => {
    await store.createFile(ws, "d/a.c", "x\n", { eol: "\r\n" });
    await commit({ remote: REMOTE, opaque: [{ path: "d/b.bin", sha: "f".repeat(40), mode: "100644", expect: "absent" }] });
    expect(await sync.readText("d/a.c")).toBe("x\n");
    expect(await outcome(sync.readText("d"))).toBe("not-a-file");
    expect(await outcome(sync.readText("d/b.bin"))).toBe("read-only-entry");
    expect(await outcome(sync.readText("nope"))).toBe("not-found");
  });
});

describe("commit", () => {
  it("applies pulls, deletes, the base table and the remote meta in one transaction", async () => {
    await synced();
    const events: ChangeEvent[] = [];
    store.onChange((e) => events.push(e));
    const revBefore = (await store.getWorkspace(ws))!.rev;
    const a2 = await put("a.c", "a2\n", await sha("a1\n"));
    const lib = await put("lib/deep/new.c", "n\n", "absent", "\r\n");
    const result = await commit({
      put: [a2, lib],
      remove: [{ path: "b.c", expect: await sha("b1\n") }],
      base: [base("a.c", a2.sha), base("lib/deep/new.c", lib.sha, "100755")],
      remote: { baseCommit: "c2", baseTree: "t2", lastSyncAt: 99 },
    });
    expect(result).toEqual({ skipped: [] });
    expect((await store.loadTree(ws)).map((e) => e.path)).toEqual(["a.c", "lib", "lib/deep", "lib/deep/new.c"]);
    expect(await store.readFile(ws, "a.c")).toBe("a2\n");
    expect(await store.readFile(ws, "lib/deep/new.c")).toBe("n\n");
    const newEntry = (await store.getEntry(ws, "lib/deep/new.c"))!;
    expect(newEntry).toMatchObject({ eol: "\r\n", localSha: lib.sha, baseSha: lib.sha, size: 3 });
    expect((await store.getEntry(ws, "a.c"))!.baseSha).toBe(a2.sha);
    expect((await db.getAll("bases")).map((b) => [b.path, b.mode])).toEqual([["a.c", "100644"], ["lib/deep/new.c", "100755"]]);
    const wsRec = (await store.getWorkspace(ws))!;
    expect(wsRec.rev).toBe(revBefore + 1);
    expect(wsRec.remote).toEqual({ ...REMOTE, baseCommit: "c2", baseTree: "t2", lastSyncAt: 99 });
    expect(events).toEqual([{ ws, rev: revBefore + 1, reason: "sync", paths: ["lib", "lib/deep", "b.c", "a.c", "lib/deep/new.c"] }]);
    expect((await store.workspaceStats(ws)).changed + (await store.workspaceStats(ws)).added).toBe(0);
  });

  it("skips a file edited since the snapshot, keeping the edit and its old base entry", async () => {
    await synced();
    const snap = await sync.snapshot();
    await store.saveFile(ws, "a.c", "typed meanwhile\n");
    const remote = await put("a.c", "remote edit\n", snap.local.get("a.c")!.sha);
    const result = await commit({ put: [remote], base: [base("a.c", remote.sha), base("b.c", await sha("b1\n"))], remote: { baseCommit: "c2" } });
    expect(result.skipped).toEqual(["a.c"]);
    expect(await store.readFile(ws, "a.c")).toBe("typed meanwhile\n");
    // The next 3-way merge must see base a1, local "typed", remote "remote edit": both changed.
    const after = await sync.snapshot();
    expect(after.base.get("a.c")!.sha).toBe(await sha("a1\n"));
    expect(after.local.get("a.c")!.sha).toBe(await sha("typed meanwhile\n"));
    expect((await store.getEntry(ws, "a.c"))!.baseSha).toBe(await sha("a1\n"));
    expect((await store.getWorkspace(ws))!.remote!.baseCommit).toBe("c2");
  });

  it("skips a put while the edit's blob id is still being computed", async () => {
    await synced();
    const snap = await sync.snapshot();
    const entry = (await db.get("entries", [ws, "a.c"]))!;
    await db.put("entries", { ...entry, localSha: null, mtime: entry.mtime + 5 }); // saved, hash pending
    const remote = await put("a.c", "remote\n", snap.local.get("a.c")!.sha);
    expect((await commit({ put: [remote], base: [base("a.c", remote.sha)] })).skipped).toEqual(["a.c"]);
    expect(await store.readFile(ws, "a.c")).toBe("a1\n");
  });

  it('"absent" means no file may be at the path; an empty folder gives way', async () => {
    await synced();
    await store.createFile(ws, "made-here.c", "mine\n");
    await store.createDir(ws, "folder.c");
    const theirs = await put("made-here.c", "theirs\n", "absent");
    const onDir = await put("folder.c", "file\n", "absent");
    const fresh = await put("fresh.c", "new\n", "absent");
    const result = await commit({
      put: [theirs, onDir, fresh],
      base: [base("a.c", await sha("a1\n")), base("b.c", await sha("b1\n")), base("made-here.c", theirs.sha), base("folder.c", onDir.sha), base("fresh.c", fresh.sha)],
    });
    expect(result.skipped).toEqual(["made-here.c"]);
    expect(await store.readFile(ws, "made-here.c")).toBe("mine\n");
    expect(await store.readFile(ws, "fresh.c")).toBe("new\n");
    // Git can't hold an empty folder, so nothing is lost: the pulled file takes its place.
    expect(await store.readFile(ws, "folder.c")).toBe("file\n");
    // Skipped paths had no base before, so they still have none: the next merge sees "both added".
    const bases = (await db.getAll("bases")).map((b) => b.path);
    expect(bases).toEqual(["a.c", "b.c", "folder.c", "fresh.c"]);
  });

  it("a folder emptied by remote deletes gives way to a pulled file of the same name", async () => {
    await store.createFile(ws, "keep.py", "k\n");
    await store.createFile(ws, "notes/a.py", "a\n");
    // The other computer replaced the folder notes/ with a file called notes.
    const file = await put("notes", "now a file\n", "absent");
    const result = await commit({
      remove: [{ path: "notes/a.py", expect: await sha("a\n") }],
      put: [file],
      base: [base("keep.py", await sha("k\n")), base("notes", file.sha)],
      remote: REMOTE,
    });
    expect(result.skipped).toEqual([]);
    expect((await store.getEntry(ws, "notes"))!.kind).toBe("file");
    expect(await store.readFile(ws, "notes")).toBe("now a file\n");
    expect((await store.loadTree(ws)).map((e) => e.path)).toEqual(["keep.py", "notes"]);
  });

  it("a folder that still holds files is never replaced by a pulled file", async () => {
    await store.createFile(ws, "notes/a.py", "a\n");
    const file = await put("notes", "file\n", "absent");
    const result = await commit({ put: [file], base: [base("notes", file.sha)], remote: REMOTE });
    expect(result.skipped).toEqual(["notes"]);
    expect((await store.getEntry(ws, "notes"))!.kind).toBe("dir");
    expect(await store.readFile(ws, "notes/a.py")).toBe("a\n");
  });

  it("a put planned against a file's blob id leaves an empty folder at that path alone", async () => {
    await store.createDir(ws, "notes");
    const file = await put("notes", "file\n", await sha("old\n"));
    const result = await commit({ put: [file], base: [base("notes", file.sha)], remote: REMOTE });
    expect(result.skipped).toEqual(["notes"]);
    expect((await store.getEntry(ws, "notes"))!.kind).toBe("dir");
  });

  it("skips a delete whose file changed or is already gone", async () => {
    await synced();
    await store.saveFile(ws, "a.c", "kept\n");
    await store.deletePath(ws, "b.c");
    const result = await commit({
      remove: [
        { path: "a.c", expect: await sha("a1\n") },
        { path: "b.c", expect: await sha("b1\n") },
      ],
      base: [],
    });
    expect(result.skipped).toEqual(["a.c", "b.c"]);
    expect(await store.readFile(ws, "a.c")).toBe("kept\n");
    expect((await db.getAll("bases")).map((b) => b.path)).toEqual(["a.c", "b.c"]);
  });

  it("removes a file before creating a folder of the same name", async () => {
    await synced();
    const inner = await put("a.c/inner.c", "i\n", "absent");
    const result = await commit({ remove: [{ path: "a.c", expect: await sha("a1\n") }], put: [inner], base: [base("a.c/inner.c", inner.sha)] });
    expect(result.skipped).toEqual([]);
    expect((await store.getEntry(ws, "a.c"))!.kind).toBe("dir");
    expect(await store.readFile(ws, "a.c/inner.c")).toBe("i\n");
  });

  it("skips a put whose parent is a file that stays", async () => {
    await synced();
    const inner = await put("a.c/inner.c", "i\n", "absent");
    expect((await commit({ put: [inner], base: [base("a.c/inner.c", inner.sha)] })).skipped).toEqual(["a.c/inner.c"]);
    expect((await store.getEntry(ws, "a.c"))!.kind).toBe("file");
  });

  it("mirrors remote names that differ only in case", async () => {
    await synced();
    const upper = await put("A.c", "upper\n", "absent");
    expect((await commit({ put: [upper], base: [base("A.c", upper.sha)] })).skipped).toEqual([]);
    expect(await store.readFile(ws, "A.c")).toBe("upper\n");
    expect(await store.readFile(ws, "a.c")).toBe("a1\n");
  });

  it("is all-or-nothing when a write fails part-way", async () => {
    await synced();
    const before = await dump();
    const a2 = await put("a.c", "a2\n", await sha("a1\n"));
    const n = await put("n/new.c", "n\n", "absent");
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (++puts === 4) throw new DOMException("injected", "QuotaExceededError");
      return realPut.apply(this, args);
    });
    await expect(commit({ put: [a2, n], remove: [{ path: "b.c", expect: await sha("b1\n") }], base: [base("a.c", a2.sha), base("n/new.c", n.sha)], remote: { baseCommit: "c9" } })).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    vi.restoreAllMocks();
    expect(await dump()).toEqual(before);
  });

  it("refuses a blob id that doesn't match its text, and non-canonical or repeated paths, before writing", async () => {
    await synced();
    const before = await dump();
    const wrong = { ...(await put("a.c", "a2\n", await sha("a1\n"))), sha: "0".repeat(40) };
    expect(await outcome(commit({ put: [wrong] }))).toBe("invalid");
    expect(await outcome(commit({ put: [await put("x/../a.c", "a\n", "absent")] }))).toBe("invalid-path");
    expect(await outcome(commit({ put: [await put("a.c", "z\n", await sha("a1\n"))], remove: [{ path: "a.c", expect: await sha("a1\n") }] }))).toBe("invalid");
    expect(await outcome(commit({ put: [{ ...(await put("a.c", "x\n", await sha("a1\n"))), text: "x\r\n" }] }))).toBe("invalid-text");
    expect(await outcome(commit({ base: [base("ok.c", "zz")] }))).toBe("invalid");
    expect(await outcome(commit({ base: [base(".git/config", "a".repeat(40))] }))).toBe("invalid-path");
    expect(await dump()).toEqual(before);
  });

  it("checks the writer lock again once the blob ids are checked, so a tab that lost it meanwhile writes nothing", async () => {
    await synced();
    let writable = true;
    const guarded = createSyncStore(db, ws, { canWrite: () => writable });
    const a2 = await put("a.c", "a2\n", await sha("a1\n"));
    const before = await dump();
    const gate = holdFirstDigest();
    const committing = guarded.commit({ put: [a2], remove: [], base: [base("a.c", a2.sha)], remote: { baseCommit: "c2" } });
    await gate.reached;
    writable = false; // another tab became the writer while this one was hashing
    gate.open();
    expect(await outcome(committing)).toBe("read-only");
    expect(await dump()).toEqual(before);
  });

  it("needs owner, repository and branch once there is no remote yet", async () => {
    await store.createFile(ws, "a.c", "x\n");
    expect(await outcome(commit({ remote: { baseCommit: "c1" } }))).toBe("invalid");
    expect((await store.getWorkspace(ws))!.remote).toBeNull();
    await commit({ remote: { owner: "me", repo: "r", branch: "main", deviceName: "pc" } });
    expect((await store.getWorkspace(ws))!.remote).toMatchObject({ provider: "github", owner: "me", repo: "r", branch: "main", baseCommit: null });
  });

  it("enforces the workspace caps for what a sync would leave", async () => {
    await synced();
    const small = createSyncStore(db, ws, { limits: { maxFiles: 2 } });
    const extra = await put("c.c", "c\n", "absent");
    expect(await outcome(small.commit({ put: [extra], remove: [], base: [], remote: {} }))).toBe("limit");
    expect((await store.loadTree(ws)).length).toBe(2);
    const tight = createSyncStore(db, ws, { limits: { maxBytes: 8 } }); // a.c and b.c use 6 bytes
    const grown = await put("a.c", "a1 and more\n", await sha("a1\n"));
    expect(await outcome(tight.commit({ put: [grown], remove: [], base: [], remote: {} }))).toBe("limit");
    expect(await store.readFile(ws, "a.c")).toBe("a1\n");
  });

  it("refuses a path that isn't in canonical form (NFD from macOS) instead of storing it renamed", async () => {
    await synced();
    const before = await dump();
    const nfd = "cafe" + String.fromCodePoint(0x301) + ".c";
    expect(await outcome(commit({ put: [await put(nfd, "x\n", "absent")] }))).toBe("invalid");
    expect(await outcome(commit({ remove: [{ path: nfd, expect: "absent" }] }))).toBe("invalid");
    expect(await outcome(commit({ base: [base(nfd, "a".repeat(40))] }))).toBe("invalid");
    expect(await dump()).toEqual(before);
  });
});

describe("opaque entries", () => {
  const BLOB = "1".repeat(40);
  const BLOB2 = "2".repeat(40);

  it("are written by blob id, appear in snapshots, and keep no text", async () => {
    await commit({ remote: REMOTE, opaque: [{ path: "img/logo.png", sha: BLOB, mode: "100644", size: 2048, expect: "absent" }], base: [base("img/logo.png", BLOB)] });
    const snap = await sync.snapshot();
    expect(snap.local.get("img/logo.png")).toEqual({ path: "img/logo.png", sha: BLOB, eol: "\n", bom: false, opaque: { sha: BLOB, mode: "100644" } });
    expect(await db.count("contents")).toBe(0);
    expect((await store.getEntry(ws, "img/logo.png"))!).toMatchObject({ size: 2048, localSha: BLOB, baseSha: BLOB, opaque: { sha: BLOB, mode: "100644" } });
    expect((await store.workspaceStats(ws)).opaque).toBe(1);
  });

  it("are never replaced or removed without their own blob id", async () => {
    await commit({ remote: REMOTE, opaque: [{ path: "x.bin", sha: BLOB, mode: "100644", expect: "absent" }], base: [base("x.bin", BLOB)] });
    const text = await put("x.bin", "now text\n", "0".repeat(40));
    const result = await commit({
      put: [text],
      base: [base("x.bin", text.sha)],
    });
    expect(result.skipped).toEqual(["x.bin"]);
    expect(await commit({ remove: [{ path: "x.bin", expect: "absent" }], base: [base("x.bin", BLOB)] })).toEqual({ skipped: ["x.bin"] });
    expect(await commit({ remove: [{ path: "x.bin", expect: "9".repeat(40) }], base: [base("x.bin", BLOB)] })).toEqual({ skipped: ["x.bin"] });
    expect((await store.getEntry(ws, "x.bin"))!.opaque).toEqual({ sha: BLOB, mode: "100644" });
    expect(await commit({ remove: [{ path: "x.bin", expect: BLOB }], base: [] })).toEqual({ skipped: [] });
    expect(await store.getEntry(ws, "x.bin")).toBeNull();
  });

  it("change kind only when the plan saw the current blob (remote turned binary into text and back)", async () => {
    await commit({ remote: REMOTE, opaque: [{ path: "data.txt", sha: BLOB, mode: "100644", expect: "absent" }], base: [base("data.txt", BLOB)] });
    const text = await put("data.txt", "plain now\n", BLOB);
    expect(await commit({ put: [text], base: [base("data.txt", text.sha)] })).toEqual({ skipped: [] });
    expect(await store.readFile(ws, "data.txt")).toBe("plain now\n");
    expect((await store.getEntry(ws, "data.txt"))!.opaque).toBeUndefined();
    expect(await commit({ opaque: [{ path: "data.txt", sha: BLOB2, mode: "100644", expect: text.sha }], base: [base("data.txt", BLOB2)] })).toEqual({ skipped: [] });
    expect((await store.getEntry(ws, "data.txt"))!.opaque).toEqual({ sha: BLOB2, mode: "100644" });
    expect(await db.get("contents", [ws, "data.txt"])).toBeUndefined();
  });

  it("refuse an invalid blob id or mode", async () => {
    expect(await outcome(commit({ remote: REMOTE, opaque: [{ path: "x.bin", sha: "nothex", mode: "100644", expect: "absent" }] }))).toBe("invalid");
    expect(await outcome(commit({ remote: REMOTE, opaque: [{ path: "x.bin", sha: BLOB, mode: "12", expect: "absent" }] }))).toBe("invalid");
  });
});
