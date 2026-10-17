// Shared by the Python and C/C++ runners (from Pocket Run, same author, MIT).

/**
 * The time limit counts only the program's own time: it pauses while the program waits for
 * the user to type, and resumes when the line arrives.
 */
export class RunClock {
  private budget: number;
  private segmentStart = performance.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waitStart = 0;
  waitedMs = 0;

  constructor(limitMs: number, private readonly onExpire: () => void) {
    this.budget = limitMs;
    this.timer = setTimeout(onExpire, limitMs);
  }
  pause() {
    clearTimeout(this.timer);
    this.budget -= performance.now() - this.segmentStart;
    this.waitStart = performance.now();
  }
  resume() {
    this.waitedMs += performance.now() - this.waitStart;
    this.segmentStart = performance.now();
    this.timer = setTimeout(this.onExpire, Math.max(0, this.budget));
  }
  stop() { clearTimeout(this.timer); }
}

/** After a soft interrupt, how long the program gets to unwind before a hard kill. */
export const GRACE_MS = 1000;

/**
 * Starting a worker can fail spuriously: WebKit blocks workers created right after a reload
 * that interrupted the previous page's start-up ("Worker load was blocked by
 * Cross-Origin-Embedder-Policy"), while a new attempt moments later succeeds. Retry before
 * telling the user the runtime couldn't start.
 */
export const START_ATTEMPTS = 3;
