// C and C++ on the page (adapted from Pocket Run, same author, MIT): a warm compiler worker (clang
// + lld, kept across runs, with its object cache) plus a fresh, disposable worker per program run,
// so a stuck program never costs a compiler reload.

import { joinPath, nameOf, splitExtension, isConflictCopy, isInside, tryNormalizePath } from "../core/paths";
import { checkBytes, MAX_FILE_BYTES } from "../core/safety";
import type { RunHooks, RunRequest, RunResult, RunStatus, ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import type { FromCompiler, FromProgram, ToCompiler, ToProgram } from "./clang-protocol";
import { checkBuildOptions, includeClosure } from "./cpp-build";
import { cppHints } from "./hints";
import { createOutputTail, readOutputTail } from "./cpp-output-tail";
import { createInputChannel, sendInput } from "./input-channel";
import { planProgram, type ProgramPlan } from "./program";
import { RunClock, START_ATTEMPTS } from "./run-clock";

/** "idle": the pack is installed but clang is not loaded yet (no C/C++ file has been opened). */
export type CppState = "checking" | "absent" | "downloading" | "idle" | "booting" | "ready" | "running" | "failed";

/** Compiling can't be interrupted: each step (a unit, the precompiled header, the link) gets this long. */
export const STEP_TIMEOUT_MS = 30_000;
/** Starting clang from the cached pack takes ~0.2 s warm and a few seconds cold; past this it is given up. */
export const BOOT_TIMEOUT_MS = 60_000;
/** RunResult.written holds at most this many files. */
export const MAX_WRITTEN_FILES = 20;
/** A program worker that hasn't said "started" by then is replaced (see START_ATTEMPTS). */
export const PROGRAM_START_MS = 5_000;

type StopReason = "stopped" | "timeout" | "output-limit";
type Built = Extract<FromCompiler, { type: "built" }>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 errors in main.c and util.h", for the output panel. */
export function summarize(diagnostics: readonly ToolDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error" && d.source !== "hint");
  const files = [...new Set(errors.map((d) => (d.path ? nameOf(d.path) : null)).filter((p): p is string => !!p))];
  const where = files.length ? ` in ${files.length <= 3 ? files.join(files.length === 2 ? " and " : ", ") : `${files.length} files`}` : "";
  return `${plural(errors.length, "error")}${where}`;
}

/**
 * A crash as one plain sentence for the log (B13, 2026-10-24), from cpp-wasi.ts describeCrash's
 * words. The header already says "Crashed", so the sentence says what happened, never "crashed"
 * again ("Crashed: The program crashed: aborted (...)" was the audit's finding). The runtime
 * diagnostic keeps describeCrash's words: the error help and Problems match those.
 */
export function crashMessage(crash: string): string {
  const after = (prefix: string) => crash.slice(prefix.length).trim();
  if (crash.startsWith("stack overflow")) return "The program ran out of stack memory: a function keeps calling itself (infinite or very deep recursion).";
  if (crash.startsWith("invalid memory access")) return "The program used memory it doesn't own, like a segmentation fault: often a bad pointer or an array index out of range.";
  if (crash.startsWith("aborted")) return "The program stopped itself: abort() was called, an assert failed, or a function is defined with other parameter types than it was declared with.";
  if (crash.startsWith("integer division by zero")) return "The program divided a whole number by zero.";
  if (crash.startsWith("integer overflow in division")) return "The program divided INT_MIN by -1, which gives a number too big for an int.";
  if (crash.startsWith("a call through a bad function pointer")) return "The program called a function through a bad function pointer.";
  if (crash.startsWith("out of memory")) return `The program ran out of memory${after("out of memory") ? ` ${after("out of memory")}` : ""}.`;
  return `The program stopped with an error: ${crash.replace(/\.$/, "")}.`;
}

export class CppRunner {
  state: CppState = "checking";
  progress = { loaded: 0, total: __CLANG_PACK__.totalBytes };
  /** Why the last download or start failed; never blank when there was a failure. */
  error = "";
  onState?: (state: CppState) => void;
  private readonly listeners = new Set<(state: CppState) => void>();

  private compiler!: Worker;
  private spare: { worker: Worker; failed: boolean } | null = null;
  /** Whether the UI wants the compiler warm (a C/C++ file is open). */
  private wantBoot = false;
  private ready: Promise<void> | null = null;
  private booted = false;
  /** Whether the current compiler worker has answered "check" (pack installed or not). */
  private checked = false;
  private nextId = 0;
  private active: { stop: (reason: StopReason) => void; provideInput?: (text: string | null) => void } | null = null;

  constructor(
    private readonly createCompiler: () => Worker,
    private readonly createProgram: () => Worker,
  ) {
    this.startCompiler();
  }

  /** Calls `fn` on every state or progress change; returns the unsubscribe function. */
  subscribe(fn: (state: CppState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.onState?.(this.state);
    for (const fn of this.listeners) fn(this.state);
  }

  private setState(state: CppState) {
    this.state = state;
    this.emit();
  }

  private send(msg: ToCompiler) {
    this.compiler.postMessage(msg);
  }

  private startCompiler(attempt = 1) {
    const compiler = this.createCompiler();
    this.compiler = compiler;
    this.ready = null;
    this.booted = false;
    this.checked = false;
    // A worker that can't even start (see START_ATTEMPTS) errors before its first reply: retry it.
    let replied = false;
    const onStartError = (e: ErrorEvent) => {
      if (replied) return;
      e.preventDefault(); // handled here (we retry); otherwise browsers also report it as uncaught
      compiler.terminate();
      if (attempt < START_ATTEMPTS) {
        setTimeout(() => { if (this.compiler === compiler) this.startCompiler(attempt + 1); }, 250 * attempt);
      } else {
        this.error = e.message || "the C/C++ compiler failed to start";
        this.setState("failed");
      }
    };
    compiler.addEventListener("error", onStartError, { once: true });
    compiler.addEventListener("message", ({ data }: MessageEvent<FromCompiler>) => {
      if (!replied) { replied = true; compiler.removeEventListener("error", onStartError); }
      if (this.compiler !== compiler) return;
      if (data.type === "pack") {
        this.checked = true;
        if (!data.installed) this.setState("absent");
        else if (this.wantBoot) void this.boot();
        else this.setState("idle");
      }
      if (data.type === "progress") { this.progress = { loaded: data.loaded, total: data.total }; this.emit(); }
      // A failed download must always say so (the page offers "Try again" only when there is a reason).
      if (data.type === "download-failed") { this.error = data.error || "the download was interrupted"; this.setState("absent"); }
    });
    this.send({ type: "check" });
  }

  /** Start clang as soon as a C/C++ file is open, so pressing Run doesn't wait for it. */
  prepare() {
    this.wantBoot = true;
    this.spare ??= this.makeSpare();
    if (this.state === "idle") void this.boot();
  }

  /** Starts the one-time pack download (only when the pack is absent). */
  download() {
    if (this.state !== "absent") return;
    this.error = "";
    this.progress = { loaded: 0, total: __CLANG_PACK__.totalBytes };
    this.wantBoot = true;
    this.setState("downloading");
    this.send({ type: "download" });
  }

  private boot(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.state !== "running") this.setState("booting");
    const compiler = this.compiler;
    this.ready = new Promise((resolve, reject) => {
      // Settles exactly once: a ready or boot-failed reply, the worker dying, or the start-up limit.
      const settle = (error: string | null) => {
        compiler.removeEventListener("message", onMessage);
        compiler.removeEventListener("error", onError);
        clearTimeout(timer);
        if (error === null) {
          this.booted = true;
          if (this.state === "booting") this.setState("ready");
          resolve();
          return;
        }
        this.error = error;
        this.ready = null;
        this.setState("failed");
        reject(new Error(error));
      };
      const onMessage = ({ data }: MessageEvent<FromCompiler>) => {
        if (data.type === "ready") settle(null);
        else if (data.type === "boot-failed") settle(data.error || "the compiler could not be loaded");
      };
      // A worker that dies after its first reply (a crash or out of memory while clang loads) sends
      // no boot-failed, so without this the run would wait forever.
      const onError = (e: ErrorEvent) => {
        e.preventDefault();
        compiler.terminate();
        settle(e.message || "the compiler stopped while starting");
      };
      const timer = setTimeout(() => {
        compiler.terminate();
        settle("the compiler took too long to start");
      }, BOOT_TIMEOUT_MS);
      compiler.addEventListener("message", onMessage);
      compiler.addEventListener("error", onError);
    });
    this.ready.catch(() => {});
    this.send({ type: "boot" });
    return this.ready;
  }

  private restartCompiler() {
    this.compiler.terminate();
    this.setState("booting");
    this.startCompiler();
  }

  stop() {
    this.active?.stop("stopped");
  }

  /** Answers the program's request for input: a line (with "\n") or null for end of input. */
  provideInput(text: string | null) {
    this.active?.provideInput?.(text);
  }

  /**
   * Resolves once the current worker has said whether the pack is installed and no download runs
   * (or the worker couldn't start). A replaced worker shows "booting" before it has answered.
   */
  private settled(): Promise<void> {
    const known = (s: CppState) => s === "failed" || (this.checked && s !== "checking" && s !== "downloading");
    if (known(this.state)) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe((s) => {
        if (known(s)) { off(); resolve(); }
      });
    });
  }

  async run(req: RunRequest, hooks: RunHooks): Promise<RunResult> {
    if (this.active) throw new Error("a program is already running");
    if (req.lang !== "c" && req.lang !== "cpp") throw new Error(`the C/C++ runner can't run ${req.lang}`);
    const started = performance.now();
    const planned = planProgram(req.entry, req.files);
    if (!planned.ok) {
      return {
        status: "build-failed", exitCode: null, message: planned.reason, ms: {},
        diagnostics: [{ path: req.entry, line: 1, unit: "utf16", base: 0, severity: "error", message: planned.reason, source: "clang" }],
      };
    }
    const plan = planned.plan;

    // ---- phase 0: the pack, then clang. Stop works throughout and never starts a compile. ----
    let cancel!: (reason: StopReason) => void;
    const cancelled = new Promise<StopReason>((resolve) => { cancel = resolve; });
    let stopped = false;
    this.active = { stop: (why) => { stopped = true; cancel(why); } };
    let early: RunResult | null;
    try {
      early = await this.whenCompilerReady(hooks, cancelled, () => stopped);
    } catch (e) {
      this.active = null;
      throw e;
    }
    if (early) {
      this.active = null;
      return { ...early, skipped: plan.skipped, ms: { build: performance.now() - started } };
    }
    this.setState("running");

    // ---- phase 1: build, one watchdog per step ----
    const built = await this.build(req, plan, hooks, cancelled);
    const buildMs = performance.now() - started;
    if (typeof built === "string") {
      this.active = null;
      const timeout = built === "timeout";
      return {
        status: timeout ? "timeout" : "stopped", exitCode: null, diagnostics: [], skipped: plan.skipped, ms: { build: buildMs },
        ...(timeout ? { message: `Compiling took longer than ${STEP_TIMEOUT_MS / 1000} s for one step and was stopped.` } : {}),
      };
    }
    // Hints read the program's own files only: plan.mounted is every C/C++ file of the workspace.
    const sources = programSources(plan);
    const hints = (status: RunStatus) => cppHints({ sources, units: plan.units.map((u) => u.path), diagnostics: built.diagnostics, status });
    // A compiler past its memory budget (or one that crashed) is replaced once it is idle again.
    const recycle = () => {
      if (!built.recycle) return this.setState("ready");
      this.restartCompiler();
      this.prepare();
    };
    if (!built.ok) {
      this.active = null;
      recycle();
      return {
        status: "build-failed", exitCode: null, skipped: plan.skipped, ms: { build: buildMs },
        diagnostics: [...built.diagnostics, ...hints("build-failed")],
        message: built.internalError
          ? `The ${built.stage === "link" ? "linker" : "compiler"} crashed (${built.internalError}).`
          : `The program didn't ${built.stage === "link" ? "link" : "compile"}: ${summarize(built.diagnostics)}.`,
      };
    }

    // ---- phase 2: run the program in a fresh worker; only this part has the time limit ----
    hooks.onPhase("running");
    const run = await this.execute(req, plan, built.wasm!, hooks);
    this.active = null;
    recycle();
    const diagnostics = [...built.diagnostics, ...run.runtime, ...hints(run.status)];
    return { ...run.result, diagnostics, skipped: plan.skipped, ms: { build: buildMs, run: run.result.ms.run } };
  }

  /** Waits for the pack and a booted clang; returns a finished result when the run can't go on. */
  private async whenCompilerReady(hooks: RunHooks, cancelled: Promise<StopReason>, stopped: () => boolean): Promise<RunResult | null> {
    const result = (status: RunStatus, message?: string): RunResult => ({ status, exitCode: null, diagnostics: [], ms: {}, ...(message ? { message } : {}) });
    if (this.state === "downloading") hooks.onPhase("downloading");
    await Promise.race([this.settled(), cancelled]);
    if (stopped()) return result("stopped");
    if (this.state === "absent") {
      return result("unavailable", this.error
        ? `The C/C++ compiler download stopped (${this.error}). Try the download again.`
        : "Download the C/C++ compiler first (a one-time download).");
    }
    if (this.state === "failed") {
      // Start afresh once: the failure may have been a worker that couldn't start.
      this.error = "";
      this.restartCompiler();
      await Promise.race([this.settled(), cancelled]);
      if (stopped()) return result("stopped");
      // restartCompiler() changed the state (TypeScript can't see that through the method call).
      if ((this.state as CppState) === "absent") return result("unavailable", "Download the C/C++ compiler first (a one-time download).");
      // The replacement couldn't even load (START_ATTEMPTS times): booting it would wait forever.
      if ((this.state as CppState) === "failed") return result("unavailable", `The C/C++ compiler couldn't start (${this.error}).`);
    }
    this.wantBoot = true;
    if (!this.booted) hooks.onPhase("booting");
    const boot = await Promise.race([this.boot().then(() => "ok" as const, () => "failed" as const), cancelled]);
    if (stopped()) {
      if (this.state !== "failed") this.setState(this.booted ? "ready" : "booting");
      return result("stopped");
    }
    if (boot === "failed") return result("unavailable", `The C/C++ compiler couldn't start (${this.error}).`);
    return null;
  }

  private build(req: RunRequest, plan: ProgramPlan, hooks: RunHooks, cancelled: Promise<StopReason>): Promise<Built | "timeout" | "stopped"> {
    const id = this.nextId++;
    const compiler = this.compiler;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const done = (outcome: Built | "timeout" | "stopped") => {
        if (finished) return; // a later Stop (during the program run) must not touch the compiler
        finished = true;
        clearTimeout(timer);
        compiler.removeEventListener("message", onMessage);
        compiler.removeEventListener("error", onError);
        if (typeof outcome === "string") {
          // clang can't be interrupted mid-compile, so replace it (it reloads from the cache).
          this.restartCompiler();
          this.prepare();
        }
        resolve(outcome);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done("timeout"), STEP_TIMEOUT_MS);
      };
      const onMessage = ({ data }: MessageEvent<FromCompiler>) => {
        if (!("id" in data) || data.id !== id) return;
        if (data.type === "step") {
          arm();
          if (data.step === "compile") hooks.onPhase("compiling", data.path);
          else if (data.step === "link") hooks.onPhase("linking");
          else hooks.onPhase("compiling", "<bits/stdc++.h> (once)");
        } else if (data.type === "unit") {
          arm();
        } else if (data.type === "built") {
          done(data);
        }
      };
      const onError = (e: ErrorEvent) => {
        e.preventDefault();
        done({
          type: "built", id, ok: false, stage: "compile", compileMs: 0, linkMs: 0, compiled: 0, reused: 0, recycle: true,
          internalError: e.message || "the compiler worker failed",
          diagnostics: [{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "clang", message: `The compiler failed (${e.message || "its worker stopped"}). Press Run again.` }],
        }); // recycle: true, so run() replaces the dead worker
      };
      compiler.addEventListener("message", onMessage);
      compiler.addEventListener("error", onError);
      void cancelled.then(() => done("stopped"));
      arm();
      const { options } = checkBuildOptions(req.build);
      this.send({ type: "build", id, root: plan.root, files: plan.mounted, units: plan.units, options });
    });
  }

  /** A pre-started program worker; one that failed to load before it was used is noted, not used. */
  private makeSpare(): { worker: Worker; failed: boolean } {
    const entry = { worker: this.createProgram(), failed: false };
    entry.worker.addEventListener("error", (e) => {
      if (this.spare !== entry) return; // in use: the run's own handler deals with it
      e.preventDefault();
      entry.failed = true;
    });
    return entry;
  }

  private takeProgramWorker(): Worker {
    const spare = this.spare;
    this.spare = this.makeSpare(); // warm a replacement for the next run
    if (spare && !spare.failed) return spare.worker;
    spare?.worker.terminate();
    return this.createProgram();
  }

  private execute(req: RunRequest, plan: ProgramPlan, wasm: Uint8Array, hooks: RunHooks): Promise<{ result: RunResult; status: RunStatus; runtime: ToolDiagnostic[] }> {
    const firstWorker = this.takeProgramWorker();
    const folderFiles = req.files
      .filter((f) => isInside(f.path, plan.root) && f.path !== plan.root && !isConflictCopy(f.path))
      .map((f) => ({ path: plan.root === "" ? f.path : f.path.slice(plan.root.length + 1), text: f.text }));
    return new Promise((resolve) => {
      let reason: StopReason | null = null;
      let shown = 0;
      let program = firstWorker;
      let started = false; // the worker loaded and said "started"
      let waitingForInput = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      // The time limit starts when the program does, not while its worker loads.
      let clock: RunClock | null = null;
      let runStarted = performance.now();
      const input = createInputChannel();
      const tail = createOutputTail();
      /** Shows program output up to the cap; true when it had to cut some. */
      const show = (stream: "stdout" | "stderr", full: string): boolean => {
        const room = req.limits.outputCap - shown;
        const text = full.length > room ? full.slice(0, room) : full;
        shown += text.length;
        if (text) hooks.onOutput(stream, text);
        return text.length < full.length;
      };
      const finish = (status: RunStatus, exitCode: number | null, ms: number, message?: string, written?: WorkspaceFile[], crash?: string) => {
        clearTimeout(startTimer);
        clock?.stop();
        program.terminate(); // also ends a program asleep waiting for input
        const runtime: ToolDiagnostic[] = crash ? [{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", message: `The program crashed: ${crash}`, source: "runtime" }] : [];
        resolve({
          status,
          runtime,
          result: { status, exitCode, diagnostics: [], ms: { run: ms }, ...(message ? { message } : {}), ...(written?.length ? { written } : {}) },
        });
      };
      const stop = (why: StopReason) => {
        if (reason) return;
        reason = why;
        const ms = started ? performance.now() - runStarted - (clock?.waitedMs ?? 0) : 0;
        const message = why === "timeout" ? `The program ran for longer than ${Math.round(req.limits.timeoutMs / 1000)} s and was stopped (time spent waiting for input doesn't count).`
          : why === "output-limit" ? `The program printed more than ${req.limits.outputCap.toLocaleString("en")} characters and was stopped.` : undefined;
        // What the program printed just before it was stopped may not be posted yet (see cpp-output-tail.ts).
        if (tail && started) for (const c of readOutputTail(tail)) if (show(c.stream, c.text)) break;
        finish(why, null, ms, message);
      };
      const provideInput = (text: string | null) => {
        if (!waitingForInput || !input || reason) return;
        waitingForInput = false;
        sendInput(input, text);
        clock?.resume();
      };
      const onMessage = ({ data }: MessageEvent<FromProgram>) => {
        if (reason) return;
        if (!started) {
          started = true;
          clearTimeout(startTimer);
          runStarted = performance.now();
          clock = new RunClock(req.limits.timeoutMs, () => stop("timeout"));
        }
        if (data.type === "started") return;
        if (data.type === "out") {
          if (show(data.stream, data.text)) stop("output-limit");
          return;
        }
        if (data.type === "input-request") {
          waitingForInput = true;
          clock?.pause();
          hooks.onInputRequest();
          return;
        }
        if (data.type !== "done") return;
        if (data.truncated) return stop("output-limit");
        const written = acceptWritten(plan.root, data.written);
        if (data.crash) return finish("crashed", null, data.ms, crashMessage(data.crash), written, data.crash);
        if (data.exitCode === 0) return finish("ok", 0, data.ms, undefined, written);
        finish("error", data.exitCode, data.ms, `The program exited with code ${data.exitCode}.`, written);
      };
      const msg: ToProgram = {
        type: "run", wasm, stdin: req.stdin, outputCap: req.limits.outputCap * 4, input, tail,
        // argv[0] is the program's name (main.c runs as "main"), then the Arguments field's words.
        args: [splitExtension(nameOf(plan.entry)).stem, ...(req.args ?? [])], files: folderFiles,
      };
      // The program is copied, not transferred, so it can be handed to a replacement worker
      // if the first one fails to start (see START_ATTEMPTS).
      const launch = (worker: Worker, attempt: number) => {
        program = worker;
        // A worker that fails to load, or loads but never answers (WebKit can block a worker
        // load without an error the page sees in time), is replaced before the run begins.
        const failedStart = (why: string) => {
          if (reason || started || program !== worker) return;
          worker.terminate();
          if (attempt < START_ATTEMPTS) return launch(this.createProgram(), attempt + 1);
          reason = "stopped";
          finish("error", null, 0, `The program couldn't start: ${why}.`);
        };
        worker.onmessage = onMessage;
        worker.onerror = (e) => {
          e.preventDefault(); // handled here: retried, or reported in the program's output
          if (reason) return;
          if (!started) return failedStart(e.message || "its worker failed to load");
          reason = "stopped";
          finish("error", null, performance.now() - runStarted, `The program couldn't run: ${e.message || "its worker stopped"}.`);
        };
        clearTimeout(startTimer);
        startTimer = setTimeout(() => failedStart("its worker didn't load"), PROGRAM_START_MS);
        worker.postMessage(msg);
      };
      this.active = { stop, provideInput };
      launch(firstWorker, 1);
    });
  }
}

/** The program's units and the user headers they include (not other programs or skipped files). */
function programSources(plan: ProgramPlan): WorkspaceFile[] {
  const byPath = new Map(plan.mounted.map((f) => [f.path, f]));
  const paths = new Set<WsPath>();
  for (const unit of plan.units) {
    paths.add(unit.path);
    for (const header of includeClosure(unit.path, byPath, plan.root)) paths.add(header);
  }
  return plan.mounted.filter((f) => paths.has(f.path));
}

/**
 * Files the program wrote, checked here on the page (worker messages are untrusted): a clean
 * workspace path inside the program folder, text that passes the same checks as an opened file,
 * at most MAX_WRITTEN_FILES of at most 1 MiB.
 */
export function acceptWritten(root: WsPath, files: unknown): WorkspaceFile[] {
  if (!Array.isArray(files)) return [];
  const out: WorkspaceFile[] = [];
  for (const f of files as { path?: unknown; bytes?: unknown }[]) {
    if (out.length >= MAX_WRITTEN_FILES) break;
    if (typeof f?.path !== "string" || !(f.bytes instanceof Uint8Array) || f.bytes.length > MAX_FILE_BYTES) continue;
    const rel = tryNormalizePath(f.path);
    const path = rel && tryNormalizePath(joinPath(root, rel));
    if (!path || !isInside(path, root)) continue;
    const checked = checkBytes(f.bytes);
    if (!checked.ok) continue;
    out.push({ path, text: checked.text });
  }
  return out;
}
