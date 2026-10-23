// The Arguments field's per-file text in the workspace's UI state (track R, batch 3): one writer
// (setRunArgs), kept by setUiState, moved by renames and dropped by deletes and a sync's removals.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFileBytes, gitBlobSha } from "../core/bytes";
import type { RemoteMeta } from "../core/types";
import { openWorkspaceDb, StorageError, type WorkspaceDb } from "./db";
import { createSyncStore } from "./sync-store";
import { createWorkspaceStore, type WorkspaceStore } from "./workspace";

let db: WorkspaceDb;
let store: WorkspaceStore;
let ws: string;

beforeEach(async () => {
  db = await openWorkspaceDb({ name: `test-${crypto.randomUUID()}` });
  store = createWorkspaceStore(db);
  ws = (await store.ensureWorkspace("Default")).id;
});

afterEach(() => db.close());

const args = async () => (await store.getUiState(ws)).args;

describe("setRunArgs", () => {
  it("keeps one text per file and removes a file's entry when emptied, without bumping rev", async () => {
    await store.createFile(ws, "a.py", "");
    await store.createFile(ws, "lab/b.c", "");
    const rev = (await store.getWorkspace(ws))!.rev;
    await store.setRunArgs(ws, "a.py", '1 "two words"');
    await store.setRunArgs(ws, "lab/b.c", "x");
    expect(await args()).toEqual({ "a.py": '1 "two words"', "lab/b.c": "x" });
    await store.setRunArgs(ws, "a.py", "");
    expect(await args()).toEqual({ "lab/b.c": "x" });
    expect((await store.getWorkspace(ws))!.rev).toBe(rev);
  });

  it("is kept by setUiState, which writes tabs and folders only", async () => {
    await store.createFile(ws, "a.py", "");
    await store.setRunArgs(ws, "a.py", "1");
    await store.setUiState(ws, { openTabs: ["a.py"], activePath: "a.py", expanded: [] });
    expect(await store.getUiState(ws)).toEqual({ openTabs: ["a.py"], activePath: "a.py", expanded: [], args: { "a.py": "1" } });
  });

  it("follows a renamed file or folder and goes with a deleted one", async () => {
    await store.createFile(ws, "lab/a.c", "");
    await store.createFile(ws, "lab/sub/b.c", "");
    await store.createFile(ws, "x.py", "");
    await store.setRunArgs(ws, "lab/a.c", "1");
    await store.setRunArgs(ws, "lab/sub/b.c", "2");
    await store.setRunArgs(ws, "x.py", "3");
    await store.renamePath(ws, "lab", "week1");
    await store.renamePath(ws, "x.py", "y.py");
    expect(await args()).toEqual({ "week1/a.c": "1", "week1/sub/b.c": "2", "y.py": "3" });
    await store.deletePath(ws, "week1/sub");
    await store.deletePath(ws, "y.py");
    expect(await args()).toEqual({ "week1/a.c": "1" });
    // A new file with a deleted file's name starts without arguments.
    await store.createFile(ws, "y.py", "");
    expect(await args()).toEqual({ "week1/a.c": "1" });
  });

  it("keeps nothing for a path that isn't a file (a save that arrives after its file went)", async () => {
    await store.createFile(ws, "a.py", "");
    await store.createFile(ws, "lab/b.c", "");
    await store.setRunArgs(ws, "a.py", "1");
    await store.setRunArgs(ws, "gone.py", "2");
    await store.setRunArgs(ws, "lab", "3");
    expect((await db.get("workspaces", ws))!.ui.args).toEqual({ "a.py": "1" });
    // A new file with that name starts without arguments.
    await store.createFile(ws, "gone.py", "");
    expect(await args()).toEqual({ "a.py": "1" });
  });

  it("reads only files that exist, whatever the record holds", async () => {
    await store.createFile(ws, "a.py", "");
    const rec = (await db.get("workspaces", ws))!;
    await db.put("workspaces", { ...rec, ui: { ...rec.ui, args: { "a.py": "1", "gone.py": "2" } } });
    expect(await args()).toEqual({ "a.py": "1" });
  });

  it("reads a record from before arguments existed as having none, and a bad stored value as nothing", async () => {
    expect(await store.getUiState(ws)).toEqual({ openTabs: [], activePath: null, expanded: [] });
    expect((await store.getUiState(ws)).args).toBeUndefined();
    await store.createFile(ws, "a.py", "");
    const rec = (await db.get("workspaces", ws))!;
    await db.put("workspaces", { ...rec, ui: { ...rec.ui, args: { "a.py": 7, "../x": "y", "": "z" } as never } });
    expect(await args()).toEqual({});
    await store.setRunArgs(ws, "a.py", "ok");
    expect(await args()).toEqual({ "a.py": "ok" });
  });

  it("goes with a file a sync removes (a later file with that name starts without them); a skipped removal keeps them", async () => {
    const sync = createSyncStore(db, ws);
    const remote: RemoteMeta = { provider: "github", owner: "me", repo: "code", branch: "main", baseCommit: "c1", baseTree: "t1", refEtag: null, lastSyncAt: null, lastError: null, deviceName: "laptop" };
    const text = "print(1)\n";
    const sha = await gitBlobSha(encodeFileBytes(text, "\n", false));
    const put = (path: string) => ({ path, text, eol: "\n" as const, bom: false, sha, expect: "absent" });
    const base = (...paths: string[]) => paths.map((path) => ({ path, sha, mode: "100644" }));
    await sync.commit({ put: [put("a.py"), put("b.py"), put("c.py"), put("d.c")], remove: [], base: base("a.py", "b.py", "c.py", "d.c"), remote });
    for (const path of ["a.py", "b.py", "c.py", "d.c"]) await store.setRunArgs(ws, path, `${path} args`);
    // a.py goes; c.py's removal is skipped (it expects other text); d.c gives way to a folder d.c/.
    const inner = { ...put("d.c/e.c") };
    const result = await sync.commit({
      put: [inner],
      remove: [
        { path: "a.py", expect: sha },
        { path: "c.py", expect: "9".repeat(40) },
        { path: "d.c", expect: sha },
      ],
      base: base("b.py", "c.py", "d.c/e.c"),
      remote: {},
    });
    expect(result.skipped).toEqual(["c.py"]);
    expect((await db.get("workspaces", ws))!.ui.args).toEqual({ "b.py": "b.py args", "c.py": "c.py args" });
    await store.createFile(ws, "a.py", "");
    expect(await args()).toEqual({ "b.py": "b.py args", "c.py": "c.py args" });
  });

  it("refuses an invalid path, an over-long text and a read-only tab", async () => {
    await expect(store.setRunArgs(ws, "../x.py", "1")).rejects.toBeInstanceOf(StorageError);
    await expect(store.setRunArgs(ws, "a.py", "x".repeat(16 * 1024 + 1))).rejects.toMatchObject({ code: "limit" });
    const readOnly = createWorkspaceStore(db, { canWrite: () => false });
    await expect(readOnly.setRunArgs(ws, "a.py", "1")).rejects.toMatchObject({ code: "read-only" });
  });
});
