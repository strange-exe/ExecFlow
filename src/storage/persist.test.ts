import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAllLocalData, openWorkspaceDb, type WorkspaceDb } from "./db";
import { ASK_AGAIN_AFTER_MS, requestPersistence, shouldAskPersistence, storageStatus, type StorageLike } from "./persist";

function fakeStorage(state: { persisted: boolean; grant: boolean }): StorageLike & { persist: ReturnType<typeof vi.fn> } {
  return {
    persisted: async () => state.persisted,
    persist: vi.fn(async () => {
      state.persisted = state.grant;
      return state.grant;
    }),
    estimate: async () => ({ usage: 1234, quota: 1_000_000 }),
  };
}

let db: WorkspaceDb;
beforeEach(async () => {
  db = await openWorkspaceDb({ name: `test-${crypto.randomUUID()}` });
});
afterEach(() => db.close());

describe("storageStatus", () => {
  it("reports persistence and the estimate", async () => {
    expect(await storageStatus(fakeStorage({ persisted: true, grant: true }))).toEqual({ supported: true, persisted: true, usage: 1234, quota: 1_000_000 });
  });

  it("copes with a missing or failing Storage API", async () => {
    expect(await storageStatus(null)).toEqual({ supported: false, persisted: false, usage: null, quota: null });
    const failing: StorageLike = {
      persisted: () => Promise.reject(new Error("no")),
      persist: () => Promise.reject(new Error("no")),
      estimate: () => Promise.reject(new Error("no")),
    };
    expect(await storageStatus(failing)).toEqual({ supported: true, persisted: false, usage: null, quota: null });
  });
});

describe("requestPersistence", () => {
  it("asks once, records the answer and waits 30 days after a refusal", async () => {
    const t0 = Date.UTC(2026, 9, 17);
    const storage = fakeStorage({ persisted: false, grant: false });
    expect(await shouldAskPersistence(db, { storage, now: () => t0 })).toBe(true);
    expect(await requestPersistence({ storage, db, now: () => t0 })).toEqual({ granted: false, asked: true });
    expect(await db.get("meta", "persist")).toEqual({ key: "persist", askedAt: t0, granted: false });
    expect(await shouldAskPersistence(db, { storage, now: () => t0 + ASK_AGAIN_AFTER_MS - 1 })).toBe(false);
    expect(await shouldAskPersistence(db, { storage, now: () => t0 + ASK_AGAIN_AFTER_MS })).toBe(true);
  });

  it("doesn't ask when storage is already persistent or unsupported", async () => {
    const storage = fakeStorage({ persisted: true, grant: true });
    expect(await requestPersistence({ storage, db })).toEqual({ granted: true, asked: false });
    expect(storage.persist).not.toHaveBeenCalled();
    expect(await shouldAskPersistence(db, { storage })).toBe(false);
    expect(await requestPersistence({ storage: null })).toEqual({ granted: false, asked: false });
    expect(await shouldAskPersistence(db, { storage: null })).toBe(false);
  });

  it("rejects with StorageError closed once another tab has cleared this computer", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const own = await openWorkspaceDb({ name });
    await deleteAllLocalData({ name });
    const storage = fakeStorage({ persisted: false, grant: false });
    await expect(shouldAskPersistence(own, { storage })).rejects.toMatchObject({ name: "StorageError", code: "closed" });
  });

  it("reports a grant", async () => {
    const storage = fakeStorage({ persisted: false, grant: true });
    expect(await requestPersistence({ storage, db })).toEqual({ granted: true, asked: true });
    expect(await shouldAskPersistence(db, { storage })).toBe(false);
  });
});
