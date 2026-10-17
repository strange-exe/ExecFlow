import { describe, expect, it } from "vitest";
import { AUTO_SYNC_MS, backoff, FOLLOW_UP_MS, MAX_FAILURES, RETRY_BASE_MS, SyncScheduler, type RunOutcome, type RunReason } from "./sync-scheduler";

/** A fake clock: timers run only when the test moves time forward. */
function harness(outcomes: (RunOutcome | (() => Promise<RunOutcome>))[] = []) {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const runs: RunReason[] = [];
  const state = { visible: true, online: true, auto: true };
  const scheduler = new SyncScheduler({
    async run(reason) {
      runs.push(reason);
      const next = outcomes.shift() ?? { kind: "ok" };
      return typeof next === "function" ? next() : next;
    },
    autoSync: () => state.auto,
    visible: () => state.visible,
    online: () => state.online,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    now: () => now,
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
    await flush();
  }
  return { scheduler, runs, state, advance, flush, pending: () => timers.size };
}

describe("sync scheduler", () => {
  it("syncs 60 s after the last saved edit, and a later edit restarts the wait", async () => {
    const t = harness();
    t.scheduler.localChange();
    await t.advance(30_000);
    t.scheduler.localChange();
    await t.advance(AUTO_SYNC_MS - 1);
    expect(t.runs).toEqual([]);
    await t.advance(1);
    expect(t.runs).toEqual(["edit"]);
  });

  it("does nothing on its own when automatic sync is off; Ctrl+S still syncs", async () => {
    const t = harness();
    t.state.auto = false;
    t.scheduler.localChange();
    await t.advance(10 * AUTO_SYNC_MS);
    expect(t.runs).toEqual([]);
    await t.scheduler.request("key");
    expect(t.runs).toEqual(["key"]);
  });

  it("holds a due sync while the page is hidden or offline, and runs it when that ends", async () => {
    const t = harness();
    t.state.visible = false;
    t.scheduler.localChange();
    await t.advance(AUTO_SYNC_MS);
    expect(t.runs).toEqual([]);
    t.state.visible = true;
    t.scheduler.wake();
    await t.flush();
    expect(t.runs).toEqual(["edit"]);

    t.state.online = false;
    t.scheduler.localChange();
    await t.advance(AUTO_SYNC_MS);
    t.scheduler.wake(); // still offline
    await t.flush();
    expect(t.runs).toEqual(["edit"]);
    t.state.online = true;
    t.scheduler.wake();
    await t.flush();
    expect(t.runs).toEqual(["edit", "edit"]);
  });

  it("an offline outcome waits for the network to come back", async () => {
    const t = harness([{ kind: "offline" }]);
    await t.scheduler.request("key");
    expect(t.pending()).toBe(0);
    t.scheduler.wake();
    await t.flush();
    expect(t.runs).toEqual(["key", "online"]);
  });

  it("backs off on a rate limit (retryAfterMs, then twice as long) and stops after 3 failures", async () => {
    const t = harness([
      { kind: "retry", retryAfterMs: 5000 },
      { kind: "retry", retryAfterMs: 5000 },
      { kind: "retry", retryAfterMs: 5000 },
    ]);
    await t.scheduler.request("key");
    expect(t.scheduler.retryAt).toBe(5000);
    await t.advance(4999);
    expect(t.runs).toEqual(["key"]);
    await t.advance(1);
    expect(t.runs).toEqual(["key", "retry"]);
    expect(t.scheduler.retryAt).toBe(5000 + 10_000);
    await t.advance(10_000);
    expect(t.runs).toEqual(["key", "retry", "retry"]);
    expect(t.scheduler.failures).toBe(MAX_FAILURES);
    expect(t.scheduler.paused).toBe(true);
    expect(t.scheduler.retryAt).toBeNull();
    // Stopped: edits don't start it again, a manual sync does (and starts a fresh streak).
    t.scheduler.localChange();
    await t.advance(10 * AUTO_SYNC_MS);
    expect(t.runs).toHaveLength(3);
    await t.scheduler.request("button");
    expect(t.runs).toEqual(["key", "retry", "retry", "button"]);
    expect(t.scheduler.failures).toBe(0);
    expect(t.scheduler.paused).toBe(false);
  });

  it("without a retry-after, waits 30 s and then 60 s", () => {
    expect(backoff(1)).toBe(RETRY_BASE_MS);
    expect(backoff(2)).toBe(2 * RETRY_BASE_MS);
    expect(backoff(1, 1000)).toBe(1000);
    expect(backoff(2, 1000)).toBe(2000);
    expect(backoff(2, 90_000)).toBe(180_000);
  });

  it("a failure that needs the user pauses automatic syncs until a manual one", async () => {
    const t = harness([{ kind: "stop" }]);
    await t.scheduler.request("startup");
    expect(t.scheduler.paused).toBe(true);
    t.scheduler.localChange();
    await t.advance(2 * AUTO_SYNC_MS);
    expect(t.runs).toEqual(["startup"]);
    await t.scheduler.request("key");
    expect(t.runs).toEqual(["startup", "key"]);
  });

  it("runs at most one sync at a time: requests during a sync become one more run after it", async () => {
    let release!: () => void;
    const held = new Promise<RunOutcome>((resolve) => (release = () => resolve({ kind: "ok" })));
    const t = harness([() => held]);
    const first = t.scheduler.request("key");
    await t.flush();
    expect(t.scheduler.busy).toBe(true);
    const second = t.scheduler.request("edit");
    const third = t.scheduler.request("button");
    await t.flush();
    expect(t.runs).toEqual(["key"]);
    release();
    await Promise.all([first, second, third]);
    // The manual reason wins (it may ask the user a question).
    expect(t.runs).toEqual(["key", "button"]);
    expect(t.scheduler.busy).toBe(false);
  });

  it("a sync that left something for later runs again soon", async () => {
    const t = harness([{ kind: "ok", again: true }]);
    await t.scheduler.request("key");
    await t.advance(FOLLOW_UP_MS);
    expect(t.runs).toEqual(["key", "follow-up"]);
  });

  it("an edit doesn't push back a planned retry", async () => {
    const t = harness([{ kind: "retry", retryAfterMs: 2000 }]);
    await t.scheduler.request("key");
    t.scheduler.localChange();
    await t.advance(2000);
    expect(t.runs).toEqual(["key", "retry"]);
  });

  it("a run that throws counts as a failure worth retrying", async () => {
    const t = harness([() => Promise.reject(new Error("bug"))]);
    await t.scheduler.request("key");
    expect(t.scheduler.failures).toBe(1);
    expect(t.scheduler.retryAt).toBe(RETRY_BASE_MS);
  });

  it("reset forgets the streak and timers; stop ends everything", async () => {
    const t = harness([{ kind: "retry" }]);
    await t.scheduler.request("key");
    t.scheduler.reset();
    expect(t.pending()).toBe(0);
    expect(t.scheduler.failures).toBe(0);
    t.scheduler.stop();
    await t.scheduler.request("key");
    t.scheduler.localChange();
    await t.advance(10 * AUTO_SYNC_MS);
    expect(t.runs).toEqual(["key"]);
  });
});
