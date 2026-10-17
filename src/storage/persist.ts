// Asking the browser to keep the workspace. Without persistence, IndexedDB is "best effort": it can
// be evicted under storage pressure, and Safari deletes script-written data after 7 days of use
// without a visit unless the site is installed. persist() is a request, not a promise: GitHub sync
// and Export are the real backup, and the UI says so.
//
// Call requestPersistence() from a user gesture (Firefox shows a prompt; Chromium and Safari
// decide silently from engagement). After a refusal, don't ask again for 30 days.

import type { WorkspaceDb } from "./db";

export type StorageLike = Pick<StorageManager, "persisted" | "persist" | "estimate">;

export interface StorageStatus {
  /** False where the Storage API is missing (insecure context, very old browser). */
  supported: boolean;
  persisted: boolean;
  /** Bytes used and available to this site, as rough estimates; null when unknown. */
  usage: number | null;
  quota: number | null;
}

export const ASK_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function defaultStorage(): StorageLike | null {
  return (globalThis.navigator as Navigator | undefined)?.storage ?? null;
}

export async function storageStatus(storage: StorageLike | null = defaultStorage()): Promise<StorageStatus> {
  if (!storage) return { supported: false, persisted: false, usage: null, quota: null };
  const [persisted, estimate] = await Promise.all([
    storage.persisted().catch(() => false),
    storage.estimate().catch(() => null),
  ]);
  return { supported: true, persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
}

/**
 * Asks for persistent storage (from a click). Records the answer in the database's meta store so
 * shouldAskPersistence() can hold back after a refusal. `asked` is false when nothing was asked
 * (unsupported, or already persisted).
 */
export async function requestPersistence(
  options: { storage?: StorageLike | null; db?: WorkspaceDb; now?: () => number } = {},
): Promise<{ granted: boolean; asked: boolean }> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return { granted: false, asked: false };
  if (await storage.persisted().catch(() => false)) return { granted: true, asked: false };
  const granted = await storage.persist().catch(() => false);
  if (options.db) {
    await options.db.put("meta", { key: "persist", askedAt: (options.now ?? Date.now)(), granted }).catch(() => {});
  }
  return { granted, asked: true };
}

/** Whether to offer "Protect local data" now: not when already persisted or refused recently. */
export async function shouldAskPersistence(
  db: WorkspaceDb,
  options: { storage?: StorageLike | null; now?: () => number } = {},
): Promise<boolean> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return false;
  if (await storage.persisted().catch(() => false)) return false;
  const last = await db.get("meta", "persist");
  if (last?.key === "persist" && !last.granted && (options.now ?? Date.now)() - last.askedAt < ASK_AGAIN_AFTER_MS) return false;
  return true;
}
