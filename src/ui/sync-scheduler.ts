// When to sync. Pure timing logic (the clock, visibility and the network are injected), so it is
// unit-tested without a browser:
// - A saved edit starts (or restarts) a 60 s timer; when it fires the page must be visible and
//   online, otherwise the sync waits until it is (wake()).
// - Ctrl+S, the Sync button and Connect sync at once. At most one sync runs at a time: a request
//   made during a sync runs once more right after it (several requests become one).
// - A failure worth retrying (rate limit, server, network) waits retryAfterMs, then twice as long,
//   and stops after 3 failures in a row. A failure that needs the user (a rejected token, a choice,
//   a missing permission) pauses automatic syncs until the user syncs by hand.

export const AUTO_SYNC_MS = 60_000;
/** A sync that left something for later (a file typed in meanwhile) runs again this soon. */
export const FOLLOW_UP_MS = 3_000;
/** First retry delay when GitHub doesn't say how long to wait. */
export const RETRY_BASE_MS = 30_000;
export const MAX_FAILURES = 3;

export type RunReason =
  | "button" // the Sync button in the top bar
  | "key" // Ctrl+S
  | "message" // "Sync now with a message" (the subject is the controller's, used by the next run)
  | "connect" // right after connecting
  | "edit" // 60 s after the last saved edit
  | "startup"
  | "online"
  | "retry"
  | "follow-up";

/** Started by the user: may open dialogs (the first-connect choice) and resets a failure streak. */
export const isManual = (reason: RunReason): boolean => reason === "button" || reason === "key" || reason === "message" || reason === "connect";

export type RunOutcome =
  | { kind: "ok"; again?: boolean }
  /** Nothing was tried (nothing to do, or not possible from this tab). */
  | { kind: "idle" }
  | { kind: "retry"; retryAfterMs?: number }
  /** Needs the user: a token, a choice, a permission. */
  | { kind: "stop" }
  | { kind: "offline" };

export interface SchedulerDeps {
  run(reason: RunReason): Promise<RunOutcome>;
  autoSync(): boolean;
  visible(): boolean;
  online(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  /** Something a status display shows changed (running, retryAt, paused). */
  onChange?(): void;
}

/** retryAfterMs (or 30 s) after the first failure, then twice as long each time. */
export function backoff(failures: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? RETRY_BASE_MS;
  return Math.max(retryAfterMs ?? 0, base * 2 ** Math.max(0, failures - 1));
}

export class SyncScheduler {
  /** Consecutive failures worth retrying. */
  failures = 0;
  /** When the next retry starts (null when none is planned). */
  retryAt: number | null = null;
  /** Automatic syncs are off until the user syncs by hand. */
  paused = false;
  private timer: unknown = null;
  private timerReason: RunReason | null = null;
  private running: Promise<void> | null = null;
  private queued: RunReason | null = null;
  /** A sync that was due while the page was hidden or offline. */
  private waiting: RunReason | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** A file was saved here. */
  localChange(): void {
    if (this.stopped || this.paused || !this.deps.autoSync()) return;
    // A planned retry or follow-up comes sooner and carries this change too.
    if (this.timerReason === "retry" || this.timerReason === "follow-up") return;
    this.schedule("edit", AUTO_SYNC_MS);
  }

  /** Syncs now (or right after the sync that is running). Resolves once that sync has finished. */
  request(reason: RunReason): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (isManual(reason)) {
      this.paused = false;
      this.failures = 0;
    }
    this.clearTimer();
    this.retryAt = null;
    this.waiting = null;
    return this.start(reason);
  }

  /** The page became visible, or the network came back: run a sync that was held back. */
  wake(): void {
    if (this.stopped || this.paused || this.waiting === null || !this.deps.visible() || !this.deps.online()) return;
    const reason = this.waiting;
    this.waiting = null;
    void this.start(reason);
  }

  /** Disconnected: forget timers, failures and pauses (a later connection starts fresh). */
  reset(): void {
    this.clearTimer();
    this.failures = 0;
    this.retryAt = null;
    this.paused = false;
    this.waiting = null;
    this.queued = null;
    this.deps.onChange?.();
  }

  /** Signed out: nothing runs any more. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.retryAt = null;
    this.waiting = null;
    this.queued = null;
    this.deps.onChange?.();
  }

  /** Waits for the running sync (if any). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  private schedule(reason: RunReason, ms: number): void {
    this.clearTimer();
    this.timerReason = reason;
    this.timer = this.deps.setTimeout(() => this.due(reason), ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.timerReason = null;
  }

  private due(reason: RunReason): void {
    this.timer = null;
    this.timerReason = null;
    if (this.stopped) return;
    if (reason !== "retry") this.retryAt = null;
    if (!this.deps.visible() || !this.deps.online()) {
      this.waiting = reason;
      this.deps.onChange?.();
      return;
    }
    void this.start(reason);
  }

  private start(reason: RunReason): Promise<void> {
    if (this.running) {
      // One more run after this one; a manual reason wins (it may ask the user).
      if (this.queued === null || isManual(reason)) this.queued = reason;
      return this.running;
    }
    const job = (async () => {
      let outcome: RunOutcome;
      try {
        outcome = await this.deps.run(reason);
      } catch {
        outcome = { kind: "retry" };
      }
      this.running = null;
      this.settle(outcome);
      const next = this.queued;
      this.queued = null;
      if (next !== null && !this.stopped) await this.start(next);
    })();
    this.running = job;
    this.deps.onChange?.();
    return job;
  }

  private settle(outcome: RunOutcome): void {
    if (this.stopped) return;
    switch (outcome.kind) {
      case "ok":
        this.failures = 0;
        this.retryAt = null;
        if (outcome.again) this.schedule("follow-up", FOLLOW_UP_MS);
        break;
      case "idle":
        break;
      case "offline":
        this.waiting = "online";
        break;
      case "stop":
        this.failures = 0;
        this.retryAt = null;
        this.paused = true;
        this.clearTimer();
        break;
      case "retry": {
        this.failures++;
        if (this.failures >= MAX_FAILURES) {
          this.paused = true;
          this.retryAt = null;
          this.clearTimer();
          break;
        }
        const delay = backoff(this.failures, outcome.retryAfterMs);
        this.retryAt = this.deps.now() + delay;
        this.schedule("retry", delay);
        break;
      }
    }
    this.deps.onChange?.();
  }
}
