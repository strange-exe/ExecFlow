// One writer tab per workspace. The writer holds the Web Lock "codeeditor/ws/<id>"; every other
// tab is read-only (it can still run code from what it has loaded). Only the writer saves or syncs.
//
//   start():       take the lock if it is free (ifAvailable), otherwise read-only.
//   requestEdit(): "Edit here" in a read-only tab. Take the lock if free; otherwise ask the writer
//                  over BroadcastChannel to hand over (it flushes its saves, releases the lock and
//                  answers); with no answer within 2 s (the tab is frozen or discarded), steal the
//                  lock. The old holder sees its lock request settle and turns read-only.
//
// BroadcastChannel("codeeditor") only ever says "re-read IndexedDB" (or asks for a handover, or
// says this computer is being cleared, for every workspace): messages carry a workspace id, a
// revision number and paths, never file text or tokens. Tabs
// can miss messages (frozen, bfcached), so a tab compares the workspace's rev with the last one it
// saw whenever it becomes visible again.
//
// navigator.locks, BroadcastChannel, document and window are injectable for tests.

import { tryNormalizePath } from "../core/paths";
import type { WsPath } from "../core/types";
import type { ChangeEvent } from "./db";

export const CHANNEL_NAME = "codeeditor";
export const HANDOVER_TIMEOUT_MS = 2000;
/** A change touching more paths is announced as a whole-tree change. */
export const MAX_MESSAGE_PATHS = 200;

export function lockName(ws: string): string {
  return "codeeditor/ws/" + ws;
}

export type SyncState = "start" | "done" | "error";

export type TabMessage =
  | { v: 1; type: "changed"; ws: string; rev: number; paths: WsPath[] }
  | { v: 1; type: "tree"; ws: string; rev: number }
  | { v: 1; type: "sync"; ws: string; state: SyncState; rev: number }
  | { v: 1; type: "handover-request"; ws: string; from: string }
  | { v: 1; type: "handover-done"; ws: string; from: string; to: string }
  /** "Sign out and clear this computer" in tab `from`: every other tab drops what it holds. */
  | { v: 1; type: "cleared"; from: string };

export type TabRole = "starting" | "writer" | "reader";

/** Why a tab is read-only. */
export type ReadOnlyReason =
  | "other-tab" // another tab is the writer
  | "no-locks" // navigator.locks is missing (insecure context): never write
  | "handed-over" // this tab gave the lock to another one
  | "stolen" // another tab took the lock without a handover
  | "paused" // the page went into the back/forward cache
  | "closed";

/** Something another tab changed: re-read IndexedDB (the tree, and these paths if given). */
export type StaleHint =
  | { kind: "changed"; rev: number; paths: WsPath[] }
  | { kind: "tree"; rev: number }
  | { kind: "sync"; state: SyncState; rev: number }
  | { kind: "rev"; rev: number }
  | { kind: "unknown" };

export interface LockManagerLike {
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown>;
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface DocumentLike extends EventSourceLike {
  readonly visibilityState: string;
}

export interface TabDeps {
  /** Current rev of the workspace in IndexedDB (null if it is gone). */
  readRev(): Promise<number | null>;
  /** Writer only: finish pending saves before handing the lock over. */
  flush?(): Promise<void>;
  /** The lock was taken without a handover: drop the save queue (it would race the new writer). */
  onStolen?(): void;
  /** Default navigator.locks; null = unavailable. */
  locks?: LockManagerLike | null;
  /** Default `new BroadcastChannel(name)`; null = unavailable. */
  openChannel?: ((name: string) => ChannelLike) | null;
  /** Default document (visibilitychange) and window (pageshow, pagehide); null = none. */
  doc?: DocumentLike | null;
  win?: EventSourceLike | null;
  handoverTimeoutMs?: number;
  tabId?: string;
}

export interface TabCoordinator {
  readonly tabId: string;
  readonly role: TabRole;
  /** Set while read-only. */
  readonly reason: ReadOnlyReason | null;
  /** True only while this tab holds the writer lock. Pass to createWorkspaceStore's canWrite. */
  canWrite(): boolean;
  start(): Promise<TabRole>;
  requestEdit(): Promise<TabRole>;
  /** Record the rev the UI has just loaded. */
  seen(rev: number): void;
  notifyChanged(rev: number, paths: WsPath[]): void;
  notifyTree(rev: number): void;
  notifySync(state: SyncState, rev: number): void;
  /** This tab is clearing this computer: tells every other tab, of any workspace. */
  notifyCleared(): void;
  /** Compares the stored rev with the last one seen; fires onStale and returns true if it moved. */
  checkRev(): Promise<boolean>;
  onRole(listener: (role: TabRole, reason: ReadOnlyReason | null) => void): () => void;
  onStale(listener: (hint: StaleHint) => void): () => void;
  /** Another tab is clearing this computer. */
  onCleared(listener: () => void): () => void;
  /** Releases the lock (if held) and stops listening. */
  close(): Promise<void>;
}

interface Holding {
  byUs: boolean;
  release(): void;
  /** Settles once the lock manager has let the lock go (or it was stolen). */
  released: Promise<void>;
}

function defaultLocks(): LockManagerLike | null {
  return (globalThis.navigator as Navigator | undefined)?.locks ?? null;
}

function defaultChannel(name: string): ChannelLike | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
}

const SYNC_STATES: readonly string[] = ["start", "done", "error"];
const isRev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100;

/**
 * A message for workspace `ws`, "unknown" for a message about `ws` this version can't read
 * (re-read to be safe), or null for anything else.
 */
export function parseTabMessage(data: unknown, ws: string): TabMessage | "unknown" | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  // Clearing removes every workspace, so it names none.
  if (m.v === 1 && m.type === "cleared") return isId(m.from) ? { v: 1, type: "cleared", from: m.from } : null;
  if (m.ws !== ws) return null;
  if (m.v !== 1) return "unknown";
  switch (m.type) {
    case "changed": {
      if (!isRev(m.rev) || !Array.isArray(m.paths)) return "unknown";
      const paths = m.paths
        .slice(0, MAX_MESSAGE_PATHS)
        .map((p) => (typeof p === "string" ? tryNormalizePath(p) : null))
        .filter((p): p is WsPath => p !== null);
      return { v: 1, type: "changed", ws, rev: m.rev, paths };
    }
    case "tree":
      return isRev(m.rev) ? { v: 1, type: "tree", ws, rev: m.rev } : "unknown";
    case "sync":
      return isRev(m.rev) && typeof m.state === "string" && SYNC_STATES.includes(m.state)
        ? { v: 1, type: "sync", ws, state: m.state as SyncState, rev: m.rev }
        : "unknown";
    case "handover-request":
      return isId(m.from) ? { v: 1, type: "handover-request", ws, from: m.from } : null;
    case "handover-done":
      return isId(m.from) && isId(m.to) ? { v: 1, type: "handover-done", ws, from: m.from, to: m.to } : null;
    default:
      return "unknown";
  }
}

export function createTabCoordinator(ws: string, deps: TabDeps): TabCoordinator {
  const tabId = deps.tabId ?? crypto.randomUUID();
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks;
  let channel: ChannelLike | null = null;
  try {
    channel = deps.openChannel === undefined ? defaultChannel(CHANNEL_NAME) : deps.openChannel === null ? null : deps.openChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  const doc = deps.doc === undefined ? (typeof document === "undefined" ? null : document) : deps.doc;
  const win = deps.win === undefined ? (typeof window === "undefined" ? null : window) : deps.win;
  const timeoutMs = deps.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS;

  let role: TabRole = "starting";
  let reason: ReadOnlyReason | null = null;
  let holding: Holding | null = null;
  let handingOver = false;
  let closed = false;
  let lastRev: number | null = null;
  let editing: Promise<TabRole> | null = null;
  let answerHandover: ((ok: boolean) => void) | null = null;
  /** Settles once a back/forward-cache pause has flushed and let the lock go. */
  let paused: Promise<void> = Promise.resolve();
  const roleListeners = new Set<(role: TabRole, reason: ReadOnlyReason | null) => void>();
  const staleListeners = new Set<(hint: StaleHint) => void>();
  const clearedListeners = new Set<() => void>();

  function report(error: unknown) {
    (globalThis as { reportError?: (e: unknown) => void }).reportError?.(error);
  }

  function setRole(next: TabRole, why: ReadOnlyReason | null) {
    if (role === next && reason === why) return;
    role = next;
    reason = why;
    for (const listener of [...roleListeners]) {
      try {
        listener(next, why);
      } catch (error) {
        report(error);
      }
    }
  }

  function emitStale(hint: StaleHint) {
    for (const listener of [...staleListeners]) {
      try {
        listener(hint);
      } catch (error) {
        report(error);
      }
    }
  }

  function post(message: TabMessage) {
    try {
      channel?.postMessage(message);
    } catch {
      // closed channel: other tabs catch up through the rev check
    }
  }

  /** Requests the lock; resolves true once this tab holds it, false if it wasn't granted. */
  function acquire(options: LockOptions): Promise<boolean> {
    if (!locks || closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let mine: Holding | null = null;
      let settle!: () => void;
      const released = new Promise<void>((r) => (settle = r));
      const granted = (lock: Lock | null) => {
        if (!lock || closed) {
          resolve(false);
          return undefined;
        }
        return new Promise<void>((releaseLock) => {
          const h: Holding = {
            byUs: false,
            released,
            release() {
              h.byUs = true;
              releaseLock();
            },
          };
          mine = h;
          holding = h;
          setRole("writer", null);
          resolve(true);
        });
      };
      let request: Promise<unknown>;
      try {
        request = locks.request(lockName(ws), options, granted);
      } catch {
        resolve(false);
        return;
      }
      // Settles when the lock is let go. If this tab didn't let it go, it was stolen (the spec
      // rejects with AbortError; some engines may resolve instead, so both count).
      const finished = () => {
        settle();
        const h = mine as Holding | null;
        if (!h) {
          resolve(false);
          return;
        }
        if (holding === h) holding = null;
        if (!h.byUs && !closed) {
          setRole("reader", "stolen");
          try {
            deps.onStolen?.();
          } catch (error) {
            report(error);
          }
        }
      };
      request.then(finished, finished);
    });
  }

  function askForHandover(): Promise<boolean> {
    if (!channel) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (answerHandover === finish) answerHandover = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      answerHandover = finish;
      post({ v: 1, type: "handover-request", ws, from: tabId });
    });
  }

  async function handOver(to: string): Promise<void> {
    const h = holding;
    if (handingOver || !h) return;
    handingOver = true;
    setRole("reader", "handed-over"); // the editor stops taking edits now; saves already queued may finish
    try {
      await deps.flush?.();
    } catch {
      // A save that failed is still in this tab's memory; the new writer starts from what is stored.
    }
    h.release();
    await h.released;
    handingOver = false;
    post({ v: 1, type: "handover-done", ws, from: tabId, to });
  }

  function pause(): void {
    const h = holding;
    if (!h || handingOver) return;
    setRole("reader", "paused");
    paused = (async () => {
      try {
        await deps.flush?.();
      } catch {
        // see handOver
      }
      h.release();
      await h.released;
    })();
  }

  async function checkRev(): Promise<boolean> {
    let rev: number | null;
    try {
      rev = await deps.readRev();
    } catch {
      return false;
    }
    if (rev === null) return false;
    const moved = lastRev !== null && rev !== lastRev;
    lastRev = rev;
    if (moved) emitStale({ kind: "rev", rev });
    return moved;
  }

  async function start(): Promise<TabRole> {
    if (closed || holding) return role;
    if (!locks) {
      setRole("reader", "no-locks");
      return role;
    }
    const got = await acquire({ ifAvailable: true });
    if (!got && !holding && !closed) setRole("reader", "other-tab");
    return role;
  }

  async function edit(): Promise<TabRole> {
    if (closed || holding) return role;
    if (!locks) {
      setRole("reader", "no-locks");
      return role;
    }
    if (await acquire({ ifAvailable: true })) return role;
    const answered = await askForHandover();
    if (closed) return role;
    if (answered && (await acquire({ ifAvailable: true }))) return role;
    await acquire({ steal: true });
    return role;
  }

  const onMessage = (event: MessageEvent) => {
    const m = parseTabMessage(event.data, ws);
    if (m === null) return;
    if (m === "unknown") {
      emitStale({ kind: "unknown" });
      return;
    }
    switch (m.type) {
      case "handover-request":
        if (holding && m.from !== tabId) void handOver(m.from);
        return;
      case "handover-done":
        if (m.to === tabId) answerHandover?.(true);
        return;
      case "changed":
        lastRev = m.rev;
        emitStale({ kind: "changed", rev: m.rev, paths: m.paths });
        return;
      case "tree":
        lastRev = m.rev;
        emitStale({ kind: "tree", rev: m.rev });
        return;
      case "sync":
        lastRev = m.rev;
        emitStale({ kind: "sync", state: m.state, rev: m.rev });
        return;
      case "cleared":
        for (const listener of [...clearedListeners]) {
          try {
            listener();
          } catch (error) {
            report(error);
          }
        }
        return;
    }
  };
  const onVisibility = () => {
    if (doc?.visibilityState === "visible") void checkRev();
  };
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    void checkRev();
    // The page can come back before the pause finished flushing and letting go; start() would
    // then see the lock still held and do nothing, leaving the only tab read-only.
    if (reason === "paused") void paused.then(() => (reason === "paused" ? start() : role));
  };
  const onPageHide = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) pause();
  };

  channel?.addEventListener("message", onMessage);
  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pageshow", onPageShow);
  win?.addEventListener("pagehide", onPageHide);

  return {
    tabId,
    get role() {
      return role;
    },
    get reason() {
      return reason;
    },
    canWrite: () => holding !== null && !closed,
    start,
    requestEdit() {
      editing ??= edit().finally(() => (editing = null));
      return editing;
    },
    seen(rev) {
      if (isRev(rev)) lastRev = rev;
    },
    notifyChanged(rev, paths) {
      if (!isRev(rev)) return;
      lastRev = rev;
      const clean = paths.filter((p) => typeof p === "string");
      if (clean.length > MAX_MESSAGE_PATHS) post({ v: 1, type: "tree", ws, rev });
      else post({ v: 1, type: "changed", ws, rev, paths: clean });
    },
    notifyTree(rev) {
      if (!isRev(rev)) return;
      lastRev = rev;
      post({ v: 1, type: "tree", ws, rev });
    },
    notifySync(state, rev) {
      if (!isRev(rev) || !SYNC_STATES.includes(state)) return;
      lastRev = rev;
      post({ v: 1, type: "sync", ws, state, rev });
    },
    notifyCleared() {
      post({ v: 1, type: "cleared", from: tabId });
    },
    checkRev,
    onRole(listener) {
      roleListeners.add(listener);
      return () => void roleListeners.delete(listener);
    },
    onStale(listener) {
      staleListeners.add(listener);
      return () => void staleListeners.delete(listener);
    },
    onCleared(listener) {
      clearedListeners.add(listener);
      return () => void clearedListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      answerHandover?.(false);
      channel?.removeEventListener("message", onMessage);
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pageshow", onPageShow);
      win?.removeEventListener("pagehide", onPageHide);
      const h = holding;
      if (h) {
        h.release();
        await h.released;
      }
      setRole("reader", "closed");
      try {
        channel?.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Tells other tabs about a workspace store's committed writes: `store.onChange(relayChanges(tab, ws))`.
 * Blob-id fills and UI-state writes stay local (nothing a reader shows changes).
 */
export function relayChanges(tab: Pick<TabCoordinator, "notifyChanged">, ws: string): (event: ChangeEvent) => void {
  return (event) => {
    if (event.ws !== ws || event.reason === "sha" || event.reason === "ui") return;
    tab.notifyChanged(event.rev, event.paths);
  };
}
