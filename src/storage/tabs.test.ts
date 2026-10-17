import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "./db";
import {
  createTabCoordinator,
  HANDOVER_TIMEOUT_MS,
  lockName,
  MAX_MESSAGE_PATHS,
  parseTabMessage,
  relayChanges,
  type ChannelLike,
  type DocumentLike,
  type EventSourceLike,
  type LockManagerLike,
  type StaleHint,
  type TabCoordinator,
  type TabDeps,
} from "./tabs";

const WS = "ws-1";

/**
 * Web Locks for one exclusive lock, following the spec: ifAvailable answers null while the lock is
 * held, steal hands the lock over at once and fails the old holder's request with AbortError (or,
 * like some engines might, resolves it: `stealSettles: "resolve"`).
 */
class FakeLocks implements LockManagerLike {
  private holder: { stolen: boolean } | null = null;
  private readonly queue: (() => void)[] = [];
  readonly names: string[] = [];

  constructor(private readonly stealSettles: "reject" | "resolve" = "reject") {}

  get held(): boolean {
    return this.holder !== null;
  }

  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    this.names.push(name);
    if (options.steal && options.ifAvailable) return Promise.reject(new DOMException("steal with ifAvailable", "NotSupportedError"));
    return new Promise((resolve, reject) => {
      const grant = () => {
        const me = { stolen: false, resolve, reject };
        this.holder = me;
        Promise.resolve(callback({ name, mode: "exclusive" } as Lock)).then(
          (value) => {
            if (me.stolen) return;
            this.holder = null;
            resolve(value);
            this.queue.shift()?.();
          },
          (error) => {
            if (me.stolen) return;
            this.holder = null;
            reject(error);
            this.queue.shift()?.();
          },
        );
      };
      if (options.steal) {
        const old = this.holder as ({ stolen: boolean; resolve: (v: unknown) => void; reject: (e: unknown) => void } | null);
        if (old) {
          old.stolen = true;
          if (this.stealSettles === "reject") old.reject(new DOMException("The lock was stolen", "AbortError"));
          else old.resolve(undefined);
        }
        this.holder = null;
        grant();
        return;
      }
      if (this.holder || this.queue.length > 0) {
        if (options.ifAvailable) {
          Promise.resolve(callback(null)).then(resolve, reject);
          return;
        }
        this.queue.push(grant);
        return;
      }
      grant();
    });
  }
}

/** BroadcastChannel: structured-cloned, asynchronous, never delivered to the sender. */
class FakeChannel implements ChannelLike {
  frozen = false;
  closed = false;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  constructor(
    private readonly hub: FakeHub,
    readonly name: string,
  ) {}
  postMessage(message: unknown): void {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
    this.hub.deliver(this, message);
  }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  receive(data: unknown): void {
    if (this.closed || this.frozen) return;
    for (const l of [...this.listeners]) l({ data } as MessageEvent);
  }
}

class FakeHub {
  readonly log: Record<string, unknown>[] = [];
  private readonly channels: FakeChannel[] = [];
  open = (name: string): FakeChannel => {
    const c = new FakeChannel(this, name);
    this.channels.push(c);
    return c;
  };
  deliver(from: FakeChannel, message: unknown): void {
    this.log.push(message as Record<string, unknown>);
    const copy = structuredClone(message);
    for (const c of this.channels) if (c !== from && c.name === from.name) setTimeout(() => c.receive(copy), 0);
  }
}

class FakeTarget implements EventSourceLike {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, fields: Record<string, unknown> = {}): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l({ type, ...fields } as unknown as Event);
  }
}

class FakeDocument extends FakeTarget implements DocumentLike {
  visibilityState = "visible";
}

const open: TabCoordinator[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

function tab(id: string, deps: Partial<TabDeps> & { hub?: FakeHub; locks?: LockManagerLike | null }): TabCoordinator {
  const { hub, ...rest } = deps;
  const t = createTabCoordinator(WS, {
    readRev: async () => 0,
    openChannel: hub ? hub.open : null,
    doc: null,
    win: null,
    tabId: id,
    handoverTimeoutMs: 40,
    ...rest,
  });
  open.push(t);
  return t;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("one writer per workspace", () => {
  it("the first tab writes, the next one is read-only", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab("A", { locks, hub });
    expect(a.role).toBe("starting");
    expect(a.canWrite()).toBe(false);
    expect(await a.start()).toBe("writer");
    expect(a.canWrite()).toBe(true);
    const b = tab("B", { locks, hub });
    expect(await b.start()).toBe("reader");
    expect(b.reason).toBe("other-tab");
    expect(b.canWrite()).toBe(false);
    expect(new Set(locks.names)).toEqual(new Set([lockName(WS)]));
    expect(lockName(WS)).toBe("codeeditor/ws/ws-1");
  });

  it("hands over politely: the writer flushes, releases, answers; the reader takes the lock", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const order: string[] = [];
    const a = tab("A", {
      locks,
      hub,
      flush: async () => {
        order.push("A flush start");
        await new Promise((r) => setTimeout(r, 15));
        order.push("A flush end");
      },
      onStolen: () => order.push("A stolen"),
    });
    await a.start();
    const b = tab("B", { locks, hub });
    await b.start();
    a.onRole((role, reason) => order.push(`A ${role} ${reason}`));
    b.onRole((role) => order.push(`B ${role}`));
    expect(await b.requestEdit()).toBe("writer");
    expect(order).toEqual(["A reader handed-over", "A flush start", "A flush end", "B writer"]);
    expect([a.canWrite(), b.canWrite()]).toEqual([false, true]);
    expect(hub.log.map((m) => m.type)).toEqual(["handover-request", "handover-done"]);
    expect(hub.log[1]).toEqual({ v: 1, type: "handover-done", ws: WS, from: "A", to: "B" });
  });

  it("steals the lock when the writer doesn't answer within the timeout", async () => {
    expect(HANDOVER_TIMEOUT_MS).toBe(2000);
    const locks = new FakeLocks();
    const hub = new FakeHub();
    let channelA: FakeChannel | undefined;
    const flush = vi.fn(async () => {});
    const onStolen = vi.fn();
    const a = createTabCoordinator(WS, { locks, openChannel: (n) => (channelA = hub.open(n)), readRev: async () => 0, doc: null, win: null, tabId: "A", flush, onStolen });
    open.push(a);
    await a.start();
    channelA!.frozen = true; // a frozen or discarded tab
    const b = tab("B", { locks, hub });
    await b.start();
    const started = performance.now();
    expect(await b.requestEdit()).toBe("writer");
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    await tick();
    expect(a.role).toBe("reader");
    expect(a.reason).toBe("stolen");
    expect(a.canWrite()).toBe(false);
    expect(onStolen).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
    expect(locks.held).toBe(true);
  });

  it("treats a stolen lock the same when the engine resolves instead of rejecting", async () => {
    const locks = new FakeLocks("resolve");
    const hub = new FakeHub();
    let channelA: FakeChannel | undefined;
    const onStolen = vi.fn();
    const a = createTabCoordinator(WS, { locks, openChannel: (n) => (channelA = hub.open(n)), readRev: async () => 0, doc: null, win: null, tabId: "A", onStolen });
    open.push(a);
    await a.start();
    channelA!.frozen = true;
    const b = tab("B", { locks, hub });
    await b.start();
    await b.requestEdit();
    await tick();
    expect([a.role, a.reason, b.role]).toEqual(["reader", "stolen", "writer"]);
    expect(onStolen).toHaveBeenCalledOnce();
  });

  it("steals at once when there is no BroadcastChannel to ask on", async () => {
    const locks = new FakeLocks();
    const a = tab("A", { locks });
    await a.start();
    const b = tab("B", { locks, handoverTimeoutMs: 60_000 });
    await b.start();
    expect(await b.requestEdit()).toBe("writer");
    await tick();
    expect(a.reason).toBe("stolen");
  });

  it("takes a free lock straight away, without asking anyone", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab("A", { locks, hub });
    await a.start();
    const b = tab("B", { locks, hub });
    await b.start();
    await a.close();
    expect(a.reason).toBe("closed");
    expect(await b.requestEdit()).toBe("writer");
    expect(hub.log.filter((m) => m.type === "handover-request")).toEqual([]);
  });

  it("stays read-only without navigator.locks", async () => {
    const t = tab("A", { locks: null });
    expect(await t.start()).toBe("reader");
    expect(t.reason).toBe("no-locks");
    expect(await t.requestEdit()).toBe("reader");
    expect(t.canWrite()).toBe(false);
  });

  it("joins concurrent Edit-here clicks into one request", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab("A", { locks, hub });
    await a.start();
    const b = tab("B", { locks, hub });
    await b.start();
    const [r1, r2] = await Promise.all([b.requestEdit(), b.requestEdit()]);
    expect([r1, r2]).toEqual(["writer", "writer"]);
    expect(hub.log.filter((m) => m.type === "handover-request").length).toBe(1);
  });

  it("releases on pagehide into the back/forward cache and tries again on pageshow", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const win = new FakeTarget();
    const a = tab("A", { locks, hub, win });
    await a.start();
    win.fire("pagehide", { persisted: false });
    await tick();
    expect(a.role).toBe("writer"); // a real unload releases the lock by itself
    win.fire("pagehide", { persisted: true });
    await tick();
    expect([a.role, a.reason, locks.held]).toEqual(["reader", "paused", false]);
    win.fire("pageshow", { persisted: true });
    await tick();
    expect(a.role).toBe("writer");
  });

  it("is the writer again when the page comes back before its pause had flushed and let go", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const win = new FakeTarget();
    const a = tab("A", { locks, hub, win, flush: () => new Promise((r) => setTimeout(r, 20)) });
    await a.start();
    win.fire("pagehide", { persisted: true });
    win.fire("pageshow", { persisted: true }); // restored while the save queue was still flushing
    await new Promise((r) => setTimeout(r, 60));
    expect([a.role, a.reason, a.canWrite(), locks.held]).toEqual(["writer", null, true, true]);
  });
});

describe("staying in step", () => {
  it("tells other tabs to re-read, with ids, revs and paths only", async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab("A", { locks, hub });
    const b = tab("B", { locks, hub });
    await a.start();
    await b.start();
    const hints: StaleHint[] = [];
    b.onStale((h) => hints.push(h));
    a.notifyChanged(3, ["src/a.c", "src/b.c"]);
    a.notifyTree(4);
    a.notifySync("done", 5);
    a.notifyChanged(6, Array.from({ length: MAX_MESSAGE_PATHS + 1 }, (_, i) => `f${i}.c`));
    await tick();
    expect(hints).toEqual([
      { kind: "changed", rev: 3, paths: ["src/a.c", "src/b.c"] },
      { kind: "tree", rev: 4 },
      { kind: "sync", state: "done", rev: 5 },
      { kind: "tree", rev: 6 },
    ]);
    const allowed = new Set(["v", "type", "ws", "rev", "paths", "state", "from", "to"]);
    for (const m of hub.log) for (const key of Object.keys(m)) expect(allowed.has(key), key).toBe(true);
  });

  it("ignores other workspaces and malformed messages, and re-reads on unknown versions", async () => {
    expect(parseTabMessage({ v: 1, type: "changed", ws: "other", rev: 1, paths: [] }, WS)).toBeNull();
    expect(parseTabMessage("text", WS)).toBeNull();
    expect(parseTabMessage(null, WS)).toBeNull();
    expect(parseTabMessage({ v: 2, type: "changed", ws: WS }, WS)).toBe("unknown");
    expect(parseTabMessage({ v: 1, type: "future", ws: WS }, WS)).toBe("unknown");
    expect(parseTabMessage({ v: 1, type: "changed", ws: WS, rev: -1, paths: [] }, WS)).toBe("unknown");
    expect(parseTabMessage({ v: 1, type: "handover-request", ws: WS }, WS)).toBeNull();
    expect(parseTabMessage({ v: 1, type: "changed", ws: WS, rev: 2, paths: ["ok.c", "../bad", 7, "/abs"] }, WS)).toEqual({ v: 1, type: "changed", ws: WS, rev: 2, paths: ["ok.c"] });
    const hub = new FakeHub();
    const b = tab("B", { locks: new FakeLocks(), hub });
    const hints: StaleHint[] = [];
    b.onStale((h) => hints.push(h));
    const outsider = hub.open("codeeditor");
    outsider.postMessage({ v: 9, type: "changed", ws: WS });
    outsider.postMessage({ v: 1, type: "changed", ws: "other", rev: 1, paths: [] });
    await tick();
    expect(hints).toEqual([{ kind: "unknown" }]);
  });

  it("checks the stored rev when the tab becomes visible again", async () => {
    let stored = 1;
    const doc = new FakeDocument();
    const b = tab("B", { locks: new FakeLocks(), readRev: async () => stored, doc });
    const hints: StaleHint[] = [];
    b.onStale((h) => hints.push(h));
    b.seen(1);
    doc.visibilityState = "hidden";
    stored = 2; // a message was missed while hidden
    doc.fire("visibilitychange");
    await tick();
    expect(hints).toEqual([]);
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await vi.waitFor(() => expect(hints).toEqual([{ kind: "rev", rev: 2 }]));
    expect(await b.checkRev()).toBe(false); // now up to date
  });

  it("relayChanges forwards committed writes but not blob-id fills or UI state", () => {
    const notifyChanged = vi.fn();
    const relay = relayChanges({ notifyChanged }, WS);
    const event = (reason: ChangeEvent["reason"], ws = WS): ChangeEvent => ({ ws, rev: 7, paths: ["a.c"], reason });
    relay(event("save"));
    relay(event("sha"));
    relay(event("ui"));
    relay(event("rename"));
    relay(event("save", "other"));
    expect(notifyChanged.mock.calls).toEqual([
      [7, ["a.c"]],
      [7, ["a.c"]],
    ]);
  });
});
