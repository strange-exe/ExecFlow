import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import {
  belowRange,
  DB_NAME,
  DB_VERSION,
  deleteAllLocalData,
  inTransaction,
  isClosedError,
  isVersionError,
  openWorkspaceDb,
  readRequest,
  StorageError,
  wsRange,
  type EntryRecord,
} from "./db";

const freshName = () => `test-${crypto.randomUUID()}`;

function entry(ws: string, path: string): EntryRecord {
  return { ws, path, parent: "", name: path, kind: "file", size: 0, ctime: 0, mtime: 0, eol: "\n", bom: false, localSha: null, baseSha: null };
}

describe("schema", () => {
  it("creates the five stores of version 1 with their key paths", async () => {
    const db = await openWorkspaceDb({ name: freshName() });
    expect(DB_NAME).toBe("codeeditor");
    expect(DB_VERSION).toBe(1);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(["bases", "contents", "entries", "meta", "workspaces"]);
    const tx = db.transaction(["workspaces", "entries", "contents", "bases", "meta"]);
    expect(tx.objectStore("workspaces").keyPath).toBe("id");
    expect(tx.objectStore("entries").keyPath).toEqual(["ws", "path"]);
    expect(tx.objectStore("contents").keyPath).toEqual(["ws", "path"]);
    expect(tx.objectStore("bases").keyPath).toEqual(["ws", "path"]);
    expect(tx.objectStore("meta").keyPath).toBe("key");
    expect(tx.objectStore("entries").indexNames.length).toBe(0);
    await tx.done;
    const schema = await db.get("meta", "schema");
    expect(schema).toMatchObject({ key: "schema", version: 1 });
    db.close();
  });

  it("reopens an existing database without running the upgrade again", async () => {
    const name = freshName();
    const first = await openWorkspaceDb({ name });
    const migratedAt = (await first.get("meta", "schema")) as { migratedAt: number };
    await first.put("workspaces", { id: "w", name: "W", createdAt: 0, updatedAt: 0, rev: 0, remote: null, ui: { openTabs: [], activePath: null, expanded: [] } });
    first.close();
    const second = await openWorkspaceDb({ name });
    expect(await second.get("workspaces", "w")).toBeDefined();
    expect(await second.get("meta", "schema")).toEqual(migratedAt);
    second.close();
  });

  it("reports a newer database as a VersionError", async () => {
    const name = freshName();
    const newer = await openDB(name, DB_VERSION + 1);
    newer.close();
    const error = await openWorkspaceDb({ name }).catch((e: unknown) => e);
    expect(isVersionError(error)).toBe(true);
    expect(isVersionError(new Error("other"))).toBe(false);
  });
});

describe("key ranges", () => {
  it("select one workspace, or exactly the entries below one folder", async () => {
    const db = await openWorkspaceDb({ name: freshName() });
    const paths = ["src", "src/a.c", "src/lib/b.c", "src.c", "src0", "src-old/x.c", "srcs/y.c", "main.c"];
    const tx = db.transaction("entries", "readwrite");
    await Promise.all([...paths.map((p) => tx.store.put(entry("w1", p))), tx.store.put(entry("w2", "src/a.c")), tx.store.put(entry("w0", "z"))]);
    await tx.done;
    const keysOf = async (range: IDBKeyRange) => (await db.getAllKeys("entries", range)).map((k) => `${k[0]}:${k[1]}`);
    expect((await keysOf(wsRange("w1"))).length).toBe(paths.length);
    expect(await keysOf(belowRange("w1", "src"))).toEqual(["w1:src/a.c", "w1:src/lib/b.c"]);
    expect(await keysOf(belowRange("w1", "src/lib"))).toEqual(["w1:src/lib/b.c"]);
    expect((await keysOf(belowRange("w1", ""))).length).toBe(paths.length);
    db.close();
  });
});

describe("transactions", () => {
  it("abort everything when the body throws after writing", async () => {
    const db = await openWorkspaceDb({ name: freshName() });
    const failure = inTransaction(db, ["entries", "meta"], "readwrite", async (tx) => {
      await tx.objectStore("entries").put(entry("w", "a.c"));
      await tx.objectStore("meta").put({ key: "persist", askedAt: 1, granted: true });
      throw new Error("validation failed half-way");
    });
    await expect(failure).rejects.toThrow("validation failed half-way");
    expect(await db.count("entries")).toBe(0);
    expect(await db.get("meta", "persist")).toBeUndefined();
    db.close();
  });

  it("abort everything when a request fails asynchronously", async () => {
    const db = await openWorkspaceDb({ name: freshName() });
    await db.put("entries", entry("w", "exists.c"));
    const failure = inTransaction(db, ["entries"], "readwrite", async (tx) => {
      await tx.store.put(entry("w", "new.c"));
      await tx.store.add(entry("w", "exists.c")); // ConstraintError
    });
    await expect(failure).rejects.toMatchObject({ name: "ConstraintError" });
    expect((await db.getAllKeys("entries")).map((k) => k[1])).toEqual(["exists.c"]);
    db.close();
  });
});

describe("deleteAllLocalData", () => {
  it("deletes the database, closing this tab's connection", async () => {
    const name = freshName();
    const db = await openWorkspaceDb({ name });
    await db.put("meta", { key: "persist", askedAt: 1, granted: false });
    await deleteAllLocalData({ name, close: [db] });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(name);
    const reopened = await openWorkspaceDb({ name });
    expect(await reopened.get("meta", "persist")).toBeUndefined();
    reopened.close();
  });

  it("asks other connections to close (blockedVersion null) and closes them by default", async () => {
    const name = freshName();
    const handled = await openWorkspaceDb({
      name,
      onBlocking: (info) => {
        expect(info.blockedVersion).toBeNull();
        info.close();
      },
    });
    const unhandled = await openWorkspaceDb({ name });
    await deleteAllLocalData({ name });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(name);
    // Both connections are closed now: starting a transaction fails.
    expect(() => handled.transaction("meta")).toThrow();
    expect(() => unhandled.transaction("meta")).toThrow();
  });
});

describe("a connection another tab closes", () => {
  /** Starts `run` and reports whether it threw at once, then what its promise settled with. */
  async function settle(run: () => Promise<unknown>): Promise<{ threw: boolean; error: unknown }> {
    let promise: Promise<unknown>;
    try {
      promise = run();
    } catch (error) {
      return { threw: true, error };
    }
    return { threw: false, error: await promise.then(() => null, (e: unknown) => e) };
  }

  it("closes on versionchange (another tab clears this computer), and a later transaction rejects with StorageError closed", async () => {
    const name = freshName();
    const db = await openWorkspaceDb({ name });
    // The other tab's delete only finishes because this connection closed on versionchange.
    await deleteAllLocalData({ name });
    expect(() => db.transaction("meta")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    const later = await settle(() => inTransaction(db, ["meta"], "readonly", (tx) => tx.store.get("schema")));
    expect(later.threw).toBe(false);
    expect(later.error).toBeInstanceOf(StorageError);
    expect(later.error).toMatchObject({ code: "closed" });
    expect(isClosedError(later.error)).toBe(true);
  });

  it("does the same after an onBlocking handler closes it, and for a newer version opened elsewhere", async () => {
    const name = freshName();
    const seen: (number | null)[] = [];
    const db = await openWorkspaceDb({ name, onBlocking: ({ blockedVersion, close }) => (seen.push(blockedVersion), close()) });
    const newer = await openDB(name, DB_VERSION + 1);
    newer.close();
    expect(seen).toEqual([DB_VERSION + 1]);
    const later = await settle(() => inTransaction(db, ["meta"], "readwrite", (tx) => tx.store.put({ key: "persist", askedAt: 1, granted: true })));
    expect(later).toMatchObject({ threw: false, error: { name: "StorageError", code: "closed" } });
  });

  it("readRequest reports a closed connection the same way and passes every other error through", async () => {
    const name = freshName();
    const db = await openWorkspaceDb({ name });
    expect(await readRequest(db, () => db.get("meta", "schema"))).toMatchObject({ key: "schema" });
    const other = await settle(() => readRequest(db, () => db.get("nope" as "meta", "x")));
    expect(other.error).toMatchObject({ name: "NotFoundError" });
    await deleteAllLocalData({ name });
    const later = await settle(() => readRequest(db, () => db.get("meta", "schema")));
    expect(later).toMatchObject({ threw: false, error: { name: "StorageError", code: "closed" } });
    expect(isClosedError(new StorageError("not-found", "x"))).toBe(false);
    expect(isClosedError(new DOMException("closing", "InvalidStateError"))).toBe(false);
  });
});
