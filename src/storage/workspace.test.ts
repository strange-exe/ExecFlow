import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFileBytes, gitBlobSha, type Eol } from "../core/bytes";
import { openWorkspaceDb, StorageError, type ChangeEvent, type WorkspaceDb } from "./db";
import { createSyncStore } from "./sync-store";
import { createWorkspaceStore, DEFAULT_LIMITS, MAX_FILES, MAX_WORKSPACE_BYTES, type WorkspaceStore } from "./workspace";

let db: WorkspaceDb;
let store: WorkspaceStore;
let ws: string;

beforeEach(async () => {
  db = await openWorkspaceDb({ name: `test-${crypto.randomUUID()}` });
  store = createWorkspaceStore(db);
  ws = (await store.ensureWorkspace("Default")).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const utf8 = (s: string) => new TextEncoder().encode(s);
const tree = async () => (await store.loadTree(ws)).map((e) => `${e.kind === "dir" ? "d" : "f"}:${e.path}`);
const rev = async () => (await store.getWorkspace(ws))!.rev;

/** The StorageError code a promise rejects with, or "ok". */
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

/** Every record of the workspace, for before/after comparisons. */
async function dump() {
  return {
    entries: await db.getAll("entries"),
    contents: await db.getAll("contents"),
    workspaces: await db.getAll("workspaces"),
    bases: await db.getAll("bases"),
  };
}

const REMOTE = {
  provider: "github" as const,
  owner: "me",
  repo: "code",
  branch: "main",
  baseCommit: null,
  baseTree: null,
  refEtag: null,
  lastSyncAt: null,
  lastError: null,
  deviceName: "laptop",
};

describe("workspaces", () => {
  it("ensureWorkspace finds an existing workspace by name and keeps its id", async () => {
    const again = await store.ensureWorkspace("  Default ");
    expect(again.id).toBe(ws);
    const other = await store.ensureWorkspace("Lab");
    expect(other.id).not.toBe(ws);
    expect((await store.listWorkspaces()).map((w) => w.name).sort()).toEqual(["Default", "Lab"]);
    expect(await outcome(store.ensureWorkspace("   "))).toBe("invalid");
  });

  it("starts with an empty tree, rev 0 and no remote", async () => {
    const rec = (await store.getWorkspace(ws))!;
    expect(rec).toMatchObject({ rev: 0, remote: null, ui: { openTabs: [], activePath: null, expanded: [] } });
    expect(await store.loadTree(ws)).toEqual([]);
  });
});

describe("creating and reading", () => {
  it("creates a file with its missing parent folders", async () => {
    const text = "int add(int a, int b) { return a + b; }\n";
    const meta = await store.createFile(ws, "src/util/helpers.c", text);
    expect(await tree()).toEqual(["d:src", "d:src/util", "f:src/util/helpers.c"]);
    expect(await store.readFile(ws, "src/util/helpers.c")).toBe(text);
    expect(meta).toMatchObject({ path: "src/util/helpers.c", kind: "file", eol: "\n", bom: false, size: utf8(text).length, baseSha: null });
    expect(meta.localSha).toBe(await gitBlobSha(utf8(text)));
    expect(meta).not.toHaveProperty("ws");
    expect(await rev()).toBe(1);
    const dir = await store.getEntry(ws, "src");
    expect(dir).toMatchObject({ kind: "dir", size: 0, localSha: null, baseSha: null });
  });

  it("creates empty folders", async () => {
    await store.createDir(ws, "a/b/c");
    expect(await tree()).toEqual(["d:a", "d:a/b", "d:a/b/c"]);
    expect(await outcome(store.createDir(ws, "a/b"))).toBe("exists");
  });

  it("refuses duplicates, names that differ only in case, and files under files", async () => {
    await store.createFile(ws, "main.py", "");
    await store.createDir(ws, "src");
    expect(await outcome(store.createFile(ws, "main.py", "x = 1\n"))).toBe("exists");
    expect(await outcome(store.createFile(ws, "Main.py", ""))).toBe("case-collision");
    expect(await outcome(store.createFile(ws, "MAIN.PY", ""))).toBe("case-collision");
    expect(await outcome(store.createFile(ws, "SRC/a.c", ""))).toBe("case-collision");
    expect(await outcome(store.createDir(ws, "Src"))).toBe("case-collision");
    expect(await outcome(store.createFile(ws, "main.py/inner.py", ""))).toBe("not-a-folder");
    expect(await outcome(store.createDir(ws, "main.py"))).toBe("exists");
    expect(await tree()).toEqual(["f:main.py", "d:src"]);
  });

  it("refuses paths that fail normalizePath", async () => {
    for (const bad of ["../evil.py", "/abs.py", "a//b.py", "con.txt", ".git/config", "dir/", "x\\y.c", "trailing. "]) {
      expect(await outcome(store.createFile(ws, bad, "")), bad).toBe("invalid-path");
    }
    expect(await store.loadTree(ws)).toEqual([]);
  });

  it("refuses text with carriage returns, control or direction characters, and oversize files", async () => {
    expect(await outcome(store.createFile(ws, "a.c", "x\r\n"))).toBe("invalid-text");
    expect(await outcome(store.createFile(ws, "b.c", "x" + String.fromCodePoint(0) + "\n"))).toBe("invalid-text");
    expect(await outcome(store.createFile(ws, "c.c", "/* " + String.fromCodePoint(0x202e) + " */\n"))).toBe("invalid-text");
    const small = createWorkspaceStore(db, { limits: { maxFileBytes: 8 } });
    expect(await outcome(small.createFile(ws, "big.c", "123456789"))).toBe("limit");
    expect(await store.loadTree(ws)).toEqual([]);
  });

  it("enforces the file-count and byte caps", async () => {
    expect(DEFAULT_LIMITS).toEqual({ maxFiles: 2000, maxBytes: 50 * 1024 * 1024, maxFileBytes: 1024 * 1024 });
    expect([MAX_FILES, MAX_WORKSPACE_BYTES]).toEqual([2000, 52428800]);
    const small = createWorkspaceStore(db, { limits: { maxFiles: 2, maxBytes: 10 } });
    await small.createFile(ws, "a.c", "12345");
    expect(await outcome(small.createFile(ws, "b.c", "123456"))).toBe("limit"); // 11 bytes in total
    await small.createFile(ws, "b.c", "12345");
    expect(await outcome(small.createFile(ws, "c.c", ""))).toBe("limit"); // a third file
    expect(await outcome(small.saveFile(ws, "a.c", "123456"))).toBe("limit"); // growing past 10 bytes
    await small.saveFile(ws, "a.c", "1234"); // shrinking is always fine
    expect(await small.readFile(ws, "a.c")).toBe("1234");
  });

  it("checks the writer lock again after hashing a new file", async () => {
    let writable = true;
    const guarded = createWorkspaceStore(db, { canWrite: () => writable });
    const before = await dump();
    const gate = holdFirstDigest();
    const creating = guarded.createFile(ws, "a.c", "x\n");
    await gate.reached;
    writable = false; // another tab became the writer while this one was hashing
    gate.open();
    expect(await outcome(creating)).toBe("read-only");
    expect(await dump()).toEqual(before);
  });

  it("readFile explains missing files and folders", async () => {
    await store.createDir(ws, "src");
    expect(await outcome(store.readFile(ws, "nope.c"))).toBe("not-found");
    expect(await outcome(store.readFile(ws, "src"))).toBe("not-a-file");
  });
});

describe("saving", () => {
  it.each([
    ["LF", "\n", false],
    ["CRLF with BOM", "\r\n", true],
    ["CR", "\r", false],
  ] as const)("keeps the line ending and BOM (%s); localSha is the blob id of the restored bytes", async (_, eol: Eol, bom: boolean) => {
    await store.createFile(ws, "f.c", "a\nb\n", { eol, bom });
    const created = (await store.getEntry(ws, "f.c"))!;
    expect(created.localSha).toBe(await gitBlobSha(encodeFileBytes("a\nb\n", eol, bom)));
    const meta = await store.saveFile(ws, "f.c", "x\ny\nz\n");
    const bytes = encodeFileBytes("x\ny\nz\n", eol, bom);
    expect(meta).toMatchObject({ eol, bom, size: bytes.length });
    expect(meta.localSha).toBe(await gitBlobSha(bytes));
    expect((await store.getEntry(ws, "f.c"))!.localSha).toBe(meta.localSha);
    expect(await store.readFile(ws, "f.c")).toBe("x\ny\nz\n");
    const exported = (await store.loadExport(ws)).files.find((f) => f.path === "f.c")!;
    expect(exported.bytes).toEqual(bytes);
  });

  it("a newer save wins the blob-id compare-and-set", async () => {
    await store.createFile(ws, "m.c", "v0\n");
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (++calls === 1) await gate; // hold back the first save's hash
      return realDigest(algorithm, data);
    });
    const first = store.saveFile(ws, "m.c", "v1\n");
    await vi.waitFor(async () => expect(await store.readFile(ws, "m.c")).toBe("v1\n"));
    expect((await store.getEntry(ws, "m.c"))!.localSha).toBeNull(); // saved, hash pending
    const second = await store.saveFile(ws, "m.c", "v2\n");
    open();
    const late = await first;
    expect(late.localSha).toBeNull(); // its hash arrived after a newer save, so it was dropped
    const v2 = await gitBlobSha(utf8("v2\n"));
    expect(second.localSha).toBe(v2);
    expect((await store.getEntry(ws, "m.c"))!.localSha).toBe(v2);
  });

  it("drops a late blob id when another file with the same mtime took the path meanwhile", async () => {
    await createWorkspaceStore(db, { now: () => 1000 }).createFile(ws, "m.c", "v0\n");
    const three = await gitBlobSha(utf8("three\n"));
    const gate = holdFirstDigest();
    const saving = createWorkspaceStore(db, { now: () => 1000 }).saveFile(ws, "m.c", "v1\n"); // mtime 1001
    await gate.reached;
    await store.renamePath(ws, "m.c", "kept.c");
    await createWorkspaceStore(db, { now: () => 1001 }).createFile(ws, "m.c", "three\n"); // also mtime 1001
    gate.open();
    expect((await saving).localSha).toBeNull();
    expect((await store.getEntry(ws, "m.c"))!.localSha).toBe(three);
    expect(await store.readFile(ws, "m.c")).toBe("three\n");
  });

  it("still reports a save as saved when hashing fails afterwards", async () => {
    await store.createFile(ws, "h.c", "");
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("no crypto here"));
    const meta = await store.saveFile(ws, "h.c", "kept\n");
    vi.restoreAllMocks();
    expect(meta.localSha).toBeNull();
    expect(await store.readFile(ws, "h.c")).toBe("kept\n");
    expect((await createSyncStore(db, ws).snapshot()).local.get("h.c")!.sha).toBe(await gitBlobSha(utf8("kept\n")));
  });

  it("expect: saves only over the text the editor was based on, else refuses with 'changed' and stores nothing", async () => {
    await store.createFile(ws, "main.py", "print('hi')\n");
    // A sync pulls GitHub's version while the editor still holds a buffer based on the old text.
    await store.saveFile(ws, "main.py", "print('github')\n");
    const before = await rev();
    expect(await outcome(store.saveFile(ws, "main.py", "print('hi')\n# typed\n", { expect: "print('hi')\n" }))).toBe("changed");
    expect(await store.readFile(ws, "main.py")).toBe("print('github')\n");
    expect(await rev()).toBe(before);
    // Based on what is stored now: saved.
    await store.saveFile(ws, "main.py", "print('github')\n# typed\n", { expect: "print('github')\n" });
    expect(await store.readFile(ws, "main.py")).toBe("print('github')\n# typed\n");
    // Without `expect` a save is unconditional, as before.
    await store.saveFile(ws, "main.py", "x = 1\n");
    expect(await store.readFile(ws, "main.py")).toBe("x = 1\n");
  });

  it("mtime always moves, even within one millisecond", async () => {
    const frozen = createWorkspaceStore(db, { now: () => 1000 });
    const a = await frozen.createFile(ws, "t.c", "");
    const b = await frozen.saveFile(ws, "t.c", "1\n");
    const c = await frozen.saveFile(ws, "t.c", "2\n");
    expect([a.mtime, b.mtime, c.mtime]).toEqual([1000, 1001, 1002]);
    expect(c.localSha).toBe(await gitBlobSha(utf8("2\n")));
  });

  it("refuses CR text, folders, missing files and files over the limit", async () => {
    await store.createFile(ws, "a.c", "");
    await store.createDir(ws, "dir");
    expect(await outcome(store.saveFile(ws, "a.c", "x\r\n"))).toBe("invalid-text");
    expect(await outcome(store.saveFile(ws, "dir", "x"))).toBe("not-a-file");
    expect(await outcome(store.saveFile(ws, "gone.c", "x"))).toBe("not-found");
    const small = createWorkspaceStore(db, { limits: { maxFileBytes: 4 } });
    expect(await outcome(small.saveFile(ws, "a.c", "12345"))).toBe("limit");
    expect(await store.readFile(ws, "a.c")).toBe("");
  });

  it("accepts strict durability (Ctrl+S)", async () => {
    await store.createFile(ws, "a.c", "");
    await store.saveFile(ws, "a.c", "saved\n", { durability: "strict" });
    expect(await store.readFile(ws, "a.c")).toBe("saved\n");
  });
});

describe("rename", () => {
  beforeEach(async () => {
    await store.createFile(ws, "src/a.c", "a\n");
    await store.createFile(ws, "src/lib/b.c", "b\n");
    await store.createFile(ws, "src/lib/c.h", "c\n");
    await store.createFile(ws, "src.c", "sibling\n");
    await store.createFile(ws, "other.c", "o\n");
  });

  it("moves a whole folder, contents included, in one transaction", async () => {
    await store.setUiState(ws, { openTabs: ["src/a.c", "other.c"], activePath: "src/lib/b.c", expanded: ["src", "src/lib"] });
    const before = await rev();
    const moved = await store.renamePath(ws, "src", "app/code");
    expect(moved).toEqual([
      { from: "src", to: "app/code" },
      { from: "src/a.c", to: "app/code/a.c" },
      { from: "src/lib", to: "app/code/lib" },
      { from: "src/lib/b.c", to: "app/code/lib/b.c" },
      { from: "src/lib/c.h", to: "app/code/lib/c.h" },
    ]);
    expect(await tree()).toEqual(["d:app", "d:app/code", "f:app/code/a.c", "d:app/code/lib", "f:app/code/lib/b.c", "f:app/code/lib/c.h", "f:other.c", "f:src.c"]);
    expect(await store.readFile(ws, "app/code/lib/b.c")).toBe("b\n");
    expect((await db.getAll("contents")).map((c) => c.path).sort()).toEqual(["app/code/a.c", "app/code/lib/b.c", "app/code/lib/c.h", "other.c", "src.c"]);
    expect(await rev()).toBe(before + 1);
    expect(await store.getUiState(ws)).toEqual({ openTabs: ["app/code/a.c", "other.c"], activePath: "app/code/lib/b.c", expanded: ["app/code", "app/code/lib"] });
    const b = (await store.getEntry(ws, "app/code/lib/b.c"))!;
    expect(b.localSha).toBe(await gitBlobSha(utf8("b\n")));
    expect(b.baseSha).toBeNull();
  });

  it("renames a single file", async () => {
    expect(await store.renamePath(ws, "other.c", "src/lib/other.c")).toEqual([{ from: "other.c", to: "src/lib/other.c" }]);
    expect(await store.readFile(ws, "src/lib/other.c")).toBe("o\n");
    expect(await outcome(store.readFile(ws, "other.c"))).toBe("not-found");
  });

  it("allows a case-only rename but refuses collisions with other entries", async () => {
    await store.renamePath(ws, "other.c", "Other.c");
    expect(await tree()).toContain("f:Other.c");
    await store.renamePath(ws, "src", "SRC");
    expect(await store.readFile(ws, "SRC/lib/b.c")).toBe("b\n");
    expect(await outcome(store.renamePath(ws, "Other.c", "SRC.C"))).toBe("case-collision");
    expect(await outcome(store.renamePath(ws, "Other.c", "src.c"))).toBe("exists");
    expect(await outcome(store.renamePath(ws, "SRC", "SRC/inner"))).toBe("invalid");
    expect(await outcome(store.renamePath(ws, "missing.c", "x.c"))).toBe("not-found");
    expect(await outcome(store.renamePath(ws, "Other.c", "src.c/x.c"))).toBe("not-a-folder");
    expect(await store.renamePath(ws, "Other.c", "Other.c")).toEqual([]);
  });

  it("refuses to create a parent folder that differs only in case from an existing one", async () => {
    expect(await outcome(store.renamePath(ws, "other.c", "Src/other.c"))).toBe("case-collision");
    expect(await outcome(store.renamePath(ws, "src/lib", "SRC.C/lib"))).toBe("case-collision");
    expect(await store.readFile(ws, "other.c")).toBe("o\n");
    expect((await tree()).filter((p) => p.toLowerCase().startsWith("d:src") && !p.startsWith("d:src"))).toEqual([]);
  });

  it("rolls back completely when a write fails part-way", async () => {
    const before = await dump();
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (++puts === 3) throw new DOMException("injected", "QuotaExceededError");
      return realPut.apply(this, args);
    });
    await expect(store.renamePath(ws, "src", "moved")).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(puts).toBe(3);
    vi.restoreAllMocks();
    expect(await dump()).toEqual(before);
  });

  it("rolls back completely when the last request fails asynchronously", async () => {
    const before = await dump();
    const realPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      // The workspace record already exists, so add() fails with a ConstraintError event.
      if (this.name === "workspaces") return this.add(...args);
      return realPut.apply(this, args);
    });
    await expect(store.renamePath(ws, "src", "moved")).rejects.toMatchObject({ name: "ConstraintError" });
    vi.restoreAllMocks();
    expect(await dump()).toEqual(before);
  });
});

describe("delete", () => {
  beforeEach(async () => {
    await store.createFile(ws, "src/a.c", "a\n");
    await store.createFile(ws, "src/lib/b.c", "b\n");
    await store.createFile(ws, "src.c", "1\n");
    await store.createFile(ws, "src0/x.c", "2\n");
    await store.createFile(ws, "srcs/y.c", "3\n");
  });

  it("removes a folder and everything below it, and nothing else", async () => {
    await store.setUiState(ws, { openTabs: ["src/a.c", "src.c"], activePath: "src/a.c", expanded: ["src", "srcs"] });
    const deleted = await store.deletePath(ws, "src");
    expect(deleted.sort()).toEqual(["src", "src/a.c", "src/lib", "src/lib/b.c"]);
    expect(await tree()).toEqual(["f:src.c", "d:src0", "f:src0/x.c", "d:srcs", "f:srcs/y.c"]);
    expect((await db.getAll("contents")).map((c) => c.path).sort()).toEqual(["src.c", "src0/x.c", "srcs/y.c"]);
    expect(await store.getUiState(ws)).toEqual({ openTabs: ["src.c"], activePath: null, expanded: ["srcs"] });
    expect(await outcome(store.deletePath(ws, "src"))).toBe("not-found");
  });

  it("rolls back completely when a delete fails part-way", async () => {
    const before = await dump();
    const realDelete = IDBObjectStore.prototype.delete;
    let deletes = 0;
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      if (++deletes === 3) throw new DOMException("injected", "UnknownError");
      return realDelete.call(this, query);
    });
    await expect(store.deletePath(ws, "src")).rejects.toMatchObject({ name: "UnknownError" });
    vi.restoreAllMocks();
    expect(await dump()).toEqual(before);
  });
});

describe("runs", () => {
  it("loadRunFiles returns text files under the folder, without opaque entries or conflict copies", async () => {
    await store.createFile(ws, "prog/main.c", "int main(void) { return 0; }\n");
    await store.createFile(ws, "prog/util.h", "#pragma once\n");
    await store.createFile(ws, "prog/data/input.txt", "3 4\n");
    await store.createFile(ws, "prog/main.conflict-20261017-090503.c", "int main(void) { return 1; }\n");
    await store.createFile(ws, "other/x.py", "print(1)\n");
    await createSyncStore(db, ws).commit({
      put: [],
      remove: [],
      base: [],
      remote: REMOTE,
      opaque: [{ path: "prog/logo.png", sha: "a".repeat(40), mode: "100644", size: 1234, expect: "absent" }],
    });
    expect((await store.loadTree(ws)).find((e) => e.path === "prog/logo.png")).toMatchObject({ opaque: { sha: "a".repeat(40), mode: "100644" }, size: 1234 });
    const files = await store.loadRunFiles(ws, "prog");
    expect(files).toEqual([
      { path: "prog/data/input.txt", text: "3 4\n" },
      { path: "prog/main.c", text: "int main(void) { return 0; }\n" },
      { path: "prog/util.h", text: "#pragma once\n" },
    ]);
    expect((await store.loadRunFiles(ws)).map((f) => f.path)).toEqual(["other/x.py", "prog/data/input.txt", "prog/main.c", "prog/util.h"]);
    expect(await outcome(store.loadRunFiles(ws, "nope"))).toBe("not-found");
    expect(await outcome(store.loadRunFiles(ws, "prog/main.c"))).toBe("not-a-folder");
    expect(await outcome(store.readFile(ws, "prog/logo.png"))).toBe("read-only-entry");
    expect(await outcome(store.saveFile(ws, "prog/logo.png", "x"))).toBe("read-only-entry");
    expect(await outcome(store.renamePath(ws, "prog", "p2"))).toBe("read-only-entry");
  });
});

describe("import", () => {
  it("checks every file and refuses each problem with a reason", async () => {
    await store.createFile(ws, "lab/main.py", "old\n");
    const zwsp = String.fromCodePoint(0x200b);
    const result = await store.importFiles(ws, "lab", [
      { name: "ok.py", bytes: utf8("print(1)\n") },
      { name: "sub/helper.c", bytes: utf8("int x;\r\n") },
      { name: "hidden.py", bytes: utf8(`na${zwsp}me = 1\n`) },
      { name: "image.py", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) },
      { name: "latin1.c", bytes: new Uint8Array([0x63, 0xe9, 0x0a]) },
      { name: "mixed.c", bytes: utf8("a\r\nb\n") },
      { name: "trojan.c", bytes: utf8("/* " + String.fromCodePoint(0x2066) + " */\n") },
      { name: "../escape.py", bytes: utf8("x\n") },
      { name: "con.py", bytes: utf8("x\n") },
      { name: "OK.py", bytes: utf8("again\n") },
      { name: "main.py", bytes: utf8("new\n") },
    ]);
    expect(result.added).toEqual(["lab/ok.py", "lab/sub/helper.c", "lab/hidden.py"]);
    expect(result.dirs).toEqual(["lab/sub"]);
    expect(result.replaced).toEqual([]);
    expect(result.hidden).toEqual([{ path: "lab/hidden.py", count: 1 }]);
    expect(result.refused.map((r) => r.name)).toEqual(["image.py", "latin1.c", "mixed.c", "trojan.c", "../escape.py", "con.py", "OK.py", "main.py"]);
    for (const r of result.refused) expect(r.reason.length).toBeGreaterThan(5);
    expect(result.refused.find((r) => r.name === "OK.py")!.reason).toContain("lab/ok.py");
    const helper = (await store.getEntry(ws, "lab/sub/helper.c"))!;
    expect(helper).toMatchObject({ eol: "\r\n", bom: false, size: 8 });
    expect(helper.localSha).toBe(await gitBlobSha(utf8("int x;\r\n")));
    expect(await store.readFile(ws, "lab/sub/helper.c")).toBe("int x;\n");
    expect(await store.readFile(ws, "lab/main.py")).toBe("old\n");
  });

  it("refuses a file whose name differs only in case from one already in the workspace", async () => {
    await store.createFile(ws, "lab/main.py", "old\n");
    const result = await store.importFiles(ws, "lab", [{ name: "Main.py", bytes: utf8("new\n") }], { replace: true });
    expect(result.added).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.refused).toEqual([{ name: "Main.py", path: "lab/Main.py", reason: expect.stringContaining("lab/main.py") }]);
    expect(await tree()).toEqual(["d:lab", "f:lab/main.py"]);
  });

  it("a refused file doesn't block a later valid file with the same name", async () => {
    const result = await store.importFiles(ws, "", [
      { name: "data.txt", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) },
      { name: "DATA.txt", bytes: utf8("1 2 3\n") },
    ]);
    expect(result.added).toEqual(["DATA.txt"]);
    expect(result.refused.map((r) => r.name)).toEqual(["data.txt"]);
  });

  it("replaces existing files only when asked, keeping the imported line endings", async () => {
    await store.createFile(ws, "main.py", "old\n");
    const result = await store.importFiles(ws, "", [{ name: "main.py", bytes: utf8("new\r\n") }], { replace: true });
    expect(result.replaced).toEqual(["main.py"]);
    expect(await store.readFile(ws, "main.py")).toBe("new\n");
    const meta = (await store.getEntry(ws, "main.py"))!;
    expect(meta.eol).toBe("\r\n");
    expect(meta.localSha).toBe(await gitBlobSha(utf8("new\r\n")));
  });

  it("stops at the workspace caps and creates empty folders in the same transaction", async () => {
    const small = createWorkspaceStore(db, { limits: { maxFiles: 2, maxBytes: 12, maxFileBytes: 6 } });
    const before = await rev();
    const result = await small.importFiles(ws, "", [
      { name: "a.c", bytes: utf8("12345") },
      { name: "toolong.c", bytes: utf8("1234567") },
      { name: "b.c", bytes: utf8("123456") },
      { name: "c.c", bytes: utf8("1") },
    ], { dirs: ["empty/inner/", "../bad"] });
    expect(result.added).toEqual(["a.c", "b.c"]);
    expect(result.refused.map((r) => r.name)).toEqual(["toolong.c", "../bad", "c.c"]);
    expect(result.dirs).toEqual(["empty", "empty/inner"]);
    expect(await rev()).toBe(before + 1);
  });

  it("checks the writer lock again after hashing, so a tab that lost it meanwhile writes nothing", async () => {
    let writable = true;
    const guarded = createWorkspaceStore(db, { canWrite: () => writable });
    const before = await dump();
    const gate = holdFirstDigest();
    const importing = guarded.importFiles(ws, "", [{ name: "a.c", bytes: utf8("x\n") }]);
    await gate.reached;
    writable = false; // another tab became the writer while this one was hashing
    gate.open();
    expect(await outcome(importing)).toBe("read-only");
    expect(await dump()).toEqual(before);
  });

  it("refuses to import into a file and writes nothing when everything is refused", async () => {
    await store.createFile(ws, "notes.txt", "");
    expect(await outcome(store.importFiles(ws, "notes.txt", [{ name: "a.c", bytes: utf8("x") }]))).toBe("not-a-folder");
    const before = await rev();
    const result = await store.importFiles(ws, "", [{ name: "bin.c", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]) }]);
    expect(result.added).toEqual([]);
    expect(await rev()).toBe(before);
  });
});

describe("export", () => {
  it("returns saved bytes, empty folders, and lists opaque files it can't include", async () => {
    await store.createFile(ws, "a/b.c", "x\n", { eol: "\r\n", bom: true });
    await store.createDir(ws, "empty");
    await store.createDir(ws, "a/also-empty");
    await createSyncStore(db, ws).commit({ put: [], remove: [], base: [], remote: REMOTE, opaque: [{ path: "a/pic.png", sha: "b".repeat(40), mode: "100644", expect: "absent" }] });
    const data = await store.loadExport(ws);
    expect(data.files).toEqual([{ path: "a/b.c", bytes: encodeFileBytes("x\n", "\r\n", true), mtime: expect.any(Number) }]);
    expect(data.dirs.sort()).toEqual(["a/also-empty", "empty"]);
    expect(data.skipped).toEqual(["a/pic.png"]);
  });
});

describe("events, guards and state", () => {
  it("onChange fires after each committed write, never for a failed one", async () => {
    const events: ChangeEvent[] = [];
    const off = store.onChange((e) => events.push(e));
    await store.createFile(ws, "src/a.c", "1\n");
    await store.saveFile(ws, "src/a.c", "2\n");
    await outcome(store.createFile(ws, "src/a.c", ""));
    await store.renamePath(ws, "src", "lib");
    await store.deletePath(ws, "lib");
    off();
    await store.createFile(ws, "after.c", "");
    expect(events.map((e) => [e.reason, e.rev, e.paths])).toEqual([
      ["create", 1, ["src", "src/a.c"]],
      ["save", 2, ["src/a.c"]],
      ["sha", 2, ["src/a.c"]],
      ["rename", 3, ["src", "lib", "src/a.c", "lib/a.c"]],
      ["delete", 4, ["lib", "lib/a.c"]],
    ]);
    expect(events.every((e) => e.ws === ws)).toBe(true);
  });

  it("a listener that throws doesn't stop the others", async () => {
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error("broken listener");
    });
    store.onChange((e) => seen.push(e.reason));
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    await store.createFile(ws, "a.c", "");
    vi.unstubAllGlobals();
    expect(seen).toEqual(["create"]);
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("a read-only tab can't write, but can read and find its workspace", async () => {
    await store.createFile(ws, "a.c", "x\n");
    const readOnly = createWorkspaceStore(db, { canWrite: () => false });
    expect(await outcome(readOnly.saveFile(ws, "a.c", "y\n"))).toBe("read-only");
    expect(await outcome(readOnly.createFile(ws, "b.c", ""))).toBe("read-only");
    expect(await outcome(readOnly.deletePath(ws, "a.c"))).toBe("read-only");
    expect(await outcome(readOnly.setUiState(ws, { openTabs: [], activePath: null, expanded: [] }))).toBe("read-only");
    expect(await readOnly.readFile(ws, "a.c")).toBe("x\n");
    expect((await readOnly.ensureWorkspace("Default")).id).toBe(ws);
    expect(await outcome(createSyncStore(db, ws, { canWrite: () => false }).commit({ put: [], remove: [], base: [], remote: REMOTE }))).toBe("read-only");
  });

  it("setUiState keeps only valid paths and doesn't bump rev", async () => {
    const before = await rev();
    await store.setUiState(ws, { openTabs: ["a.c", "../x", "a.c", "b/c.py"], activePath: "/bad", expanded: ["b"] });
    expect(await store.getUiState(ws)).toEqual({ openTabs: ["a.c", "b/c.py"], activePath: null, expanded: ["b"] });
    expect(await rev()).toBe(before);
  });

  it("workspaceStats counts files, changes and pending deletes", async () => {
    await store.createFile(ws, "a.c", "a\n");
    await store.createFile(ws, "b.c", "b\n");
    await store.createDir(ws, "d");
    const sync = createSyncStore(db, ws);
    const snap = await sync.snapshot();
    await sync.commit({
      put: [],
      remove: [],
      base: [
        { path: "a.c", sha: snap.local.get("a.c")!.sha, mode: "100644" },
        { path: "b.c", sha: snap.local.get("b.c")!.sha, mode: "100644" },
        { path: "gone.c", sha: "c".repeat(40), mode: "100644" },
      ],
      remote: REMOTE,
    });
    await store.saveFile(ws, "b.c", "changed\n");
    await store.createFile(ws, "new.c", "");
    expect(await store.workspaceStats(ws)).toEqual({
      files: 3,
      dirs: 1,
      opaque: 0,
      bytes: 2 + 8 + 0,
      changed: 1,
      added: 1,
      deleted: 1,
      limits: DEFAULT_LIMITS,
    });
  });

  it("setRemote keeps the base table for the same repository and forgets it for another", async () => {
    await store.createFile(ws, "a.c", "a\n");
    const sync = createSyncStore(db, ws);
    const sha = (await sync.snapshot()).local.get("a.c")!.sha;
    await sync.commit({ put: [], remove: [], base: [{ path: "a.c", sha, mode: "100644" }], remote: REMOTE });
    await store.setRemote(ws, { ...REMOTE, lastError: "network" });
    expect((await store.getEntry(ws, "a.c"))!.baseSha).toBe(sha);
    expect(await db.count("bases")).toBe(1);
    await store.setRemote(ws, { ...REMOTE, repo: "other" });
    expect((await store.getEntry(ws, "a.c"))!.baseSha).toBeNull();
    expect(await db.count("bases")).toBe(0);
    await store.setRemote(ws, null);
    expect((await store.getWorkspace(ws))!.remote).toBeNull();
    expect(await outcome(store.setRemote(ws, { ...REMOTE, owner: "" }))).toBe("invalid");
  });

  it("setRemote forgets the sync position along with the base table, and matches GitHub names case-insensitively", async () => {
    await store.createFile(ws, "a.c", "a\n");
    const sync = createSyncStore(db, ws);
    const sha = (await sync.snapshot()).local.get("a.c")!.sha;
    const synced = { ...REMOTE, baseCommit: "c1", baseTree: "t1", refEtag: 'W/"e1"', lastSyncAt: 5, lastError: "offline" };
    await sync.commit({ put: [], remove: [], base: [{ path: "a.c", sha, mode: "100644" }], remote: synced });
    // GitHub account and repository names ignore case (as the sync engine does): still the same repository.
    await store.setRemote(ws, { ...synced, owner: "Me", repo: "Code" });
    expect(await db.count("bases")).toBe(1);
    expect((await store.getEntry(ws, "a.c"))!.baseSha).toBe(sha);
    expect((await store.getWorkspace(ws))!.remote).toMatchObject({ owner: "Me", repo: "Code", baseCommit: "c1", baseTree: "t1", refEtag: 'W/"e1"' });
    // Another branch: nothing has been synced there, so no base commit, tree or ETag either.
    await store.setRemote(ws, { ...synced, branch: "dev" });
    expect(await db.count("bases")).toBe(0);
    expect((await store.getWorkspace(ws))!.remote).toEqual({ ...synced, branch: "dev", baseCommit: null, baseTree: null, refEtag: null, lastSyncAt: null, lastError: null });
  });
});
