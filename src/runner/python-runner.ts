// Drives the Python worker (adapted from Pocket Run's Runner, same author, MIT). Start-up is lazy
// (warmUp() or the first run), retried START_ATTEMPTS times, and a Run pressed meanwhile can be
// cancelled. Stopping escalates: a KeyboardInterrupt through shared memory first (the warm
// interpreter survives), then terminate + a fresh start if the program doesn't yield within GRACE_MS.
// The time limit pauses while the program waits for typed input.
//
// Packages: user code never runs before the worker's lockdown, and the lockdown removes fetch. So a
// run first asks the worker whether the program imports a supported package it hasn't loaded
// (parsing only); if so, the runner starts a worker that loads it before its lockdown and runs there.
// The package set only grows during a session; a package that fails to load isn't tried again until
// restart().
//
// Worker messages are untrusted (a program can post its own): diagnostics and written files are
// re-checked here, and nothing privileged ever follows from a worker message.

import type { RunHooks, RunRequest, RunResult, RunStatus, ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import { parentOf } from "../core/paths";
import { createInputChannel, sendInput } from "./input-channel";
import type { BootSource, FromPython, ToPython } from "./protocol";
import { checkDiagnostics } from "./python-diagnostics";
import { checkWritten, prepareRunFiles } from "./python-files";
import { nextPackageSet } from "./python-packages";
import { GRACE_MS, RunClock, START_ATTEMPTS } from "./run-clock";

export type PythonState = "idle" | "booting" | "ready" | "running" | "failed";
type StopReason = "timeout" | "stopped" | "output-limit";

export interface BootInfo {
  source: BootSource;
  /** Start-up time, packages included. */
  ms: number;
  /** Packages loaded, dependencies included. */
  packages: string[];
  packageMs: number;
}

/** Python's memory cap, from the runtime folder's name ("314.0.7-heap512"). */
const HEAP_MB = Number(/-heap(\d+)$/.exec(__PYODIDE_DIR__)?.[1] ?? 0);
/** A syntax check that hasn't answered by then is dropped. */
const CHECK_TIMEOUT_MS = 5000;
/** At most this many outputs are read from one "out-batch" message (worker messages are untrusted). */
export const MAX_BATCH_PARTS = 100_000;

type Outcome = { kind: "result"; result: RunResult } | { kind: "need-packages"; packages: string[] };

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const list = (names: readonly string[]) => names.join(", ");

export class PythonRunner {
  state: PythonState = "idle";
  bootError = "";
  /** How the current runtime started (for diagnostics and tests). */
  lastBoot: BootInfo | null = null;

  private listeners = new Set<(state: PythonState) => void>();
  private worker: Worker | null = null;
  private interrupt: SharedArrayBuffer | null = null;
  private input: SharedArrayBuffer | null = null;
  private ready: Promise<void> = Promise.resolve();
  private generation = 0;
  /** Packages the current (or starting) worker loads. */
  private packages: string[] = [];
  /** What this build can load, as reported by a worker before any user code ran. */
  private available: string[] = [];
  /** Packages that failed to load, and why. */
  private unavailable = new Map<string, string>();
  private active: { stop: (why: StopReason) => void; provideInput?: (text: string | null) => void } | null = null;
  private checks = new Map<number, { path: WsPath; resolve: (d: ToolDiagnostic[] | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private latestCheck = new Map<WsPath, number>();
  private checkSeq = 0;
  private restartAfterRun = false;

  constructor(private readonly createWorker: () => Worker) {}

  /** Calls `fn` on every state change; returns a function that stops it. */
  onState(fn: (state: PythonState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(state: PythonState) {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  /** Starts Python now (e.g. when a .py file is opened), so the first run doesn't wait for it. */
  warmUp() {
    if (this.state === "idle" || this.state === "failed") this.boot();
  }

  /** A fresh interpreter ("Restart Python"); packages that failed to load are tried again. */
  restart() {
    this.unavailable.clear();
    if (this.active) {
      this.restartAfterRun = true; // run() replaces the interpreter once the program has stopped
      this.active.stop("stopped");
    } else {
      this.recycle();
    }
  }

  /** Ask the running program to stop (the user pressed Stop). Also cancels a run waiting for start-up. */
  stop() {
    this.active?.stop("stopped");
  }

  /** Answers the program's request for input: a line (with "\n") or null for end of input. */
  provideInput(text: string | null) {
    this.active?.provideInput?.(text);
  }

  // ---------------------------------------------------------------- start-up

  private boot() {
    const gen = ++this.generation;
    this.setState("booting");
    this.ready = (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.startWorker(gen);
          if (gen === this.generation) this.setState("ready");
          return;
        } catch (e) {
          if (gen !== this.generation) return; // superseded by a newer start
          if (attempt >= START_ATTEMPTS || (e as { retry?: boolean }).retry === false) {
            this.bootError = (e as Error).message;
            this.setState("failed");
            throw e;
          }
          await new Promise((r) => setTimeout(r, 250 * attempt));
          // A newer start (restart(), a new package set) began while this one waited: another
          // attempt would replace that start's worker with one that is then discarded.
          if (gen !== this.generation) return;
        }
      }
    })();
    this.ready.catch(() => {}); // surfaced through state; run() reports it
  }

  /** One attempt to start the runtime; rejects (and discards the worker) if it can't start. */
  private startWorker(gen: number): Promise<void> {
    const worker = this.createWorker();
    this.worker = worker;
    const interrupt = globalThis.crossOriginIsolated ? new SharedArrayBuffer(1) : null;
    const input = createInputChannel();
    this.interrupt = interrupt;
    this.input = input;
    const packages = this.packages;
    const started = new Promise<void>((resolve, reject) => {
      // Both listeners only cover start-up; they are removed as soon as it succeeds or fails.
      const detach = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      const fail = (message: string, retry = true) => {
        detach();
        worker.terminate();
        reject(Object.assign(new Error(message), { retry }));
      };
      const onError = (e: ErrorEvent) => {
        e.preventDefault(); // handled here (we retry); otherwise browsers also report it as uncaught
        fail(e.message || "the runtime failed to start");
      };
      const onMessage = ({ data }: MessageEvent<FromPython>) => {
        if (data.type !== "ready" && data.type !== "boot-failed") return;
        if (data.type === "boot-failed") return fail(String(data.error), data.retry !== false);
        detach();
        if (gen !== this.generation) {
          worker.terminate();
          return reject(new Error("superseded"));
        }
        // Sent before any user code ran, so it can be believed (still type-checked).
        this.available = isStringList(data.available) ? data.available : [];
        this.lastBoot = { source: data.source === "snapshot" ? "snapshot" : "fresh", ms: Number(data.ms) || 0, packages: isStringList(data.loaded) ? data.loaded : [], packageMs: Number(data.packageMs) || 0 };
        worker.addEventListener("message", this.onChecked);
        resolve();
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
    worker.postMessage({ type: "init", interrupt, input, packages } satisfies ToPython);
    return started;
  }

  /** Replaces the worker (after a hard kill, a MemoryError, or with a new package set). */
  private recycle() {
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.checks.keys()]) this.settleCheck(id, null);
    this.boot();
  }

  /** Waits for the runtime, unless the run is cancelled first. */
  private whenReady(cancelled: Promise<"cancelled">): Promise<"ready" | "failed" | "cancelled"> {
    return Promise.race([this.ready.then(() => "ready" as const, () => "failed" as const), cancelled]);
  }

  // ---------------------------------------------------------------- runs

  async run(req: RunRequest, hooks: RunHooks): Promise<RunResult> {
    if (this.active) throw new Error("a program is already running");
    const prepared = req.lang === "python" ? prepareRunFiles(req.files, req.entry) : { ok: false as const, reason: "The Python runner only runs Python files." };
    if (!prepared.ok) return { status: "error", exitCode: null, diagnostics: [], message: prepared.reason, ms: {} };
    const files = prepared.files;
    const known = new Set(files.map((f) => f.path));

    // A Run pressed while the runtime is still starting (or loading packages) waits for it, and
    // must be cancellable during that wait too. The time limit only starts once the program runs.
    let cancel!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => { cancel = () => resolve("cancelled"); });
    const outer = { stop: () => cancel() };
    this.active = outer;
    const stopped: RunResult = { status: "stopped", exitCode: null, diagnostics: [], ms: {} };
    try {
      let packageCheck = true;
      let note: string | undefined;
      for (;;) {
        if (this.state === "idle" || this.state === "failed") this.boot();
        if (this.state === "booting") hooks.onPhase("booting");
        const waited = await this.whenReady(cancelled);
        if (waited === "cancelled") return stopped;
        if (waited === "failed") return { status: "unavailable", exitCode: null, diagnostics: [], message: `Python couldn't start: ${this.bootError}`, ms: {} };

        const outcome = await this.execute(req, files, known, hooks, packageCheck, outer);
        if (outcome.kind === "result") {
          if (note && !outcome.result.message) outcome.result.message = note;
          return outcome.result;
        }
        // The program imports packages this interpreter doesn't have: start one that loads them.
        packageCheck = false; // never loop: the next attempt runs whatever is loaded
        const next = nextPackageSet(this.packages, outcome.packages, this.available);
        if (!next) continue;
        const previous = this.packages;
        const added = next.filter((p) => !previous.includes(p));
        this.packages = next;
        this.recycle();
        hooks.onPhase("downloading", list(added));
        const loaded = await this.whenReady(cancelled);
        if (loaded === "cancelled") return stopped;
        if (loaded === "failed") {
          for (const p of added) this.unavailable.set(p, this.bootError);
          note = `${list(added)} couldn't be loaded (${this.bootError}), so the program ran without ${added.length > 1 ? "them" : "it"}.`;
          this.packages = previous;
          this.recycle();
        }
      }
    } finally {
      this.active = null;
      if (this.restartAfterRun) {
        this.restartAfterRun = false;
        this.recycle();
      }
    }
  }

  /** Sends one run to the current worker and follows it to the end (or to a need-packages reply). */
  private execute(req: RunRequest, files: WorkspaceFile[], known: ReadonlySet<WsPath>, hooks: RunHooks, packageCheck: boolean, outer: NonNullable<PythonRunner["active"]>): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const started = performance.now();
      const worker = this.worker!;
      const interrupt = this.interrupt;
      const input = this.input;
      let written = 0;
      let reason: StopReason | null = null;
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      let waitingForInput = false;

      const finish = (outcome: Outcome, recycle: boolean) => {
        clock.stop();
        clearTimeout(hardKill);
        worker.removeEventListener("message", onMessage);
        this.active = outer;
        if (interrupt) Atomics.store(new Uint8Array(interrupt), 0, 0);
        if (recycle) this.recycle();
        else this.setState("ready");
        resolve(outcome);
      };

      const stop = (why: StopReason) => {
        if (reason) return;
        reason = why;
        if (interrupt) Atomics.store(new Uint8Array(interrupt), 0, 2); // SIGINT
        // A program asleep waiting for input can't see the interrupt: wake it with end of input.
        if (waitingForInput && input) {
          waitingForInput = false;
          sendInput(input, null);
        }
        hardKill = setTimeout(() => {
          const ms = performance.now() - started - clock.waitedMs;
          const message = "The program didn't respond to the interrupt, so Python was restarted.";
          finish({ kind: "result", result: { status: why, exitCode: null, diagnostics: [], message, ms: { run: ms } } }, true);
        }, interrupt ? GRACE_MS : 0);
      };

      const provideInput = (text: string | null) => {
        if (!waitingForInput || !input || reason) return;
        waitingForInput = false;
        sendInput(input, text);
        clock.resume();
      };

      const output = (stream: unknown, raw: unknown) => {
        if (reason === "output-limit" || typeof raw !== "string") return;
        const room = req.limits.outputCap - written;
        const text = raw.length > room ? raw.slice(0, room) : raw;
        written += text.length;
        if (text) hooks.onOutput(stream === "stderr" ? "stderr" : "stdout", text);
        if (text.length < raw.length) stop("output-limit");
      };

      const onMessage = ({ data }: MessageEvent<FromPython>) => {
        if (data.type === "out") {
          output(data.stream, data.text);
        } else if (data.type === "out-batch") {
          // Several outputs in order, one message (a program alternating stdout and stderr).
          if (!Array.isArray(data.parts)) return;
          for (const part of data.parts.slice(0, MAX_BATCH_PARTS)) {
            if (typeof part !== "object" || part === null) continue;
            output(part.stream, part.text);
          }
        } else if (data.type === "input-request") {
          if (!input || waitingForInput) return;
          // Stop (or the time limit) landed just before the program blocked on input, so it hasn't
          // seen the interrupt: wake it now (end of input; the worker then raises it) rather than
          // leave it asleep until the hard kill restarts Python.
          if (reason) return sendInput(input, null);
          waitingForInput = true;
          clock.pause();
          hooks.onInputRequest();
        } else if (data.type === "need-packages") {
          // Only ever an answer to packageCheck, sent before any user code runs. A program can post
          // its own; accepted every time, each one would restart the run with a fresh time limit.
          if (!packageCheck) return;
          if (reason) return finish({ kind: "result", result: { status: reason, exitCode: null, diagnostics: [], ms: {} } }, false);
          finish({ kind: "need-packages", packages: isStringList(data.packages) ? data.packages : [] }, false);
        } else if (data.type === "done") {
          const exitCode = Number.isSafeInteger(data.exitCode) ? data.exitCode : null;
          const oom = data.outOfMemory === true;
          const status: RunStatus = reason ?? (oom ? "crashed" : exitCode === 0 ? "ok" : "error");
          const result: RunResult = {
            status,
            exitCode,
            diagnostics: checkDiagnostics(data.diagnostics, known),
            written: checkWritten(data.written),
            ms: { run: typeof data.ms === "number" && data.ms >= 0 ? data.ms : performance.now() - started - clock.waitedMs },
          };
          const skipped = Number.isSafeInteger(data.writtenSkipped) ? data.writtenSkipped : 0;
          if (oom) result.message = `Python ran out of memory (its limit is ${HEAP_MB} MB).`;
          else if (skipped > 0) result.message = `The program also wrote ${skipped} file${skipped > 1 ? "s" : ""} that can't be added to the workspace (not text, larger than 1 MB, or more than 20 files).`;
          finish({ kind: "result", result }, data.recycle === true);
        }
      };

      const clock = new RunClock(req.limits.timeoutMs, () => stop("timeout"));
      this.active = { stop, provideInput };
      worker.addEventListener("message", onMessage);
      this.setState("running");
      hooks.onPhase("running");
      const msg: ToPython = {
        type: "run",
        files,
        entry: req.entry,
        cwd: parentOf(req.entry), // like `cd folder && python main.py`: open("data.txt") finds files next to it
        stdin: req.stdin,
        packageCheck,
        unavailable: [...this.unavailable.keys()],
      };
      worker.postMessage(msg);
    });
  }

  // ---------------------------------------------------------------- idle syntax checks

  /**
   * Compiles `text` as the Python file `path` without running it. Resolves null when Python isn't
   * ready, a program is running, or a newer check of the same file was sent (stale reply).
   */
  check(path: WsPath, text: string): Promise<ToolDiagnostic[] | null> {
    if (this.state !== "ready" || this.active || !this.worker || !path.endsWith(".py")) return Promise.resolve(null);
    const id = ++this.checkSeq;
    this.latestCheck.set(path, id);
    const worker = this.worker;
    return new Promise((resolve) => {
      this.checks.set(id, { path, resolve, timer: setTimeout(() => this.settleCheck(id, null), CHECK_TIMEOUT_MS) });
      worker.postMessage({ type: "check", id, path, text } satisfies ToPython);
    });
  }

  private onChecked = ({ data }: MessageEvent<FromPython>) => {
    if (data.type === "checked" && Number.isSafeInteger(data.id)) this.settleCheck(data.id, data.diagnostics);
  };

  private settleCheck(id: number, raw: unknown) {
    const pending = this.checks.get(id);
    if (!pending) return;
    this.checks.delete(id);
    clearTimeout(pending.timer);
    const current = this.latestCheck.get(pending.path) === id;
    if (current) this.latestCheck.delete(pending.path);
    pending.resolve(raw === null || !current ? null : checkDiagnostics(raw, new Set([pending.path])));
  }
}

// ---------------------------------------------------------------- the app's Python runtime

const python = new PythonRunner(() => new Worker(new URL("../workers/python.worker.ts", import.meta.url), { type: "module" }));

/** Runs a Python program; see RunRequest/RunResult in core/types.ts. Throws if one is already running. */
export const run = (req: RunRequest, hooks: RunHooks): Promise<RunResult> => python.run(req, hooks);
export const stop = (): void => python.stop();
export const provideInput = (text: string | null): void => python.provideInput(text);
export const check = (path: WsPath, text: string): Promise<ToolDiagnostic[] | null> => python.check(path, text);
export const warmUp = (): void => python.warmUp();
export const restart = (): void => python.restart();
export const state = (): PythonState => python.state;
export const onState = (fn: (state: PythonState) => void): (() => void) => python.onState(fn);
export const bootInfo = (): BootInfo | null => python.lastBoot;
