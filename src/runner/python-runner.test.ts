import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunHooks, RunRequest } from "../core/types";
import { GRACE_MS } from "./run-clock";
import type { FromPython, ToPython } from "./protocol";
import { PythonRunner } from "./python-runner";

const AVAILABLE = ["numpy", "six", "python-dateutil", "pytz", "pandas"];

/** Stands in for the Python worker: `script` answers each message the runner posts. */
class FakeWorker {
  sent: ToPython[] = [];
  terminated = false;
  private listeners = { message: new Set<(e: { data: FromPython }) => void>(), error: new Set<(e: unknown) => void>() };
  constructor(private readonly script: (w: FakeWorker, msg: ToPython) => void) {}
  postMessage(msg: ToPython) {
    this.sent.push(msg);
    queueMicrotask(() => { if (!this.terminated) this.script(this, msg); });
  }
  addEventListener(type: "message" | "error", fn: (e: never) => void) { this.listeners[type].add(fn as never); }
  removeEventListener(type: "message" | "error", fn: (e: never) => void) { this.listeners[type].delete(fn as never); }
  emit(data: FromPython) { if (!this.terminated) for (const fn of [...this.listeners.message]) fn({ data }); }
  fail(message: string) { for (const fn of [...this.listeners.error]) fn({ message, preventDefault() {} }); }
  terminate() { this.terminated = true; }
  get init() { return this.sent.find((m) => m.type === "init") as Extract<ToPython, { type: "init" }>; }
  get runs() { return this.sent.filter((m) => m.type === "run") as Extract<ToPython, { type: "run" }>[]; }
}

type Script = (w: FakeWorker, msg: ToPython) => void;
const ready = (w: FakeWorker, msg: Extract<ToPython, { type: "init" }>) =>
  w.emit({ type: "ready", ms: 10, source: "fresh", loaded: msg.packages, available: AVAILABLE, packageMs: 0 });
const done = (extra: Partial<Extract<FromPython, { type: "done" }>> = {}): FromPython =>
  ({ type: "done", exitCode: 0, interrupted: false, recycle: false, outOfMemory: false, ms: 5, diagnostics: [], written: [], writtenSkipped: 0, ...extra });

function setUp(onRun: (w: FakeWorker, msg: Extract<ToPython, { type: "run" }>) => void, onInit: Script = (w, m) => ready(w, m as never)) {
  const workers: FakeWorker[] = [];
  const runner = new PythonRunner(() => {
    const w = new FakeWorker((w, msg) => {
      if (msg.type === "init") onInit(w, msg);
      else if (msg.type === "run") onRun(w, msg);
    });
    workers.push(w);
    return w as unknown as Worker;
  });
  return { runner, workers };
}

function hooks() {
  const out: string[] = [];
  const phases: string[] = [];
  const h: RunHooks & { out: string[]; phases: string[]; asked: number } = {
    out, phases, asked: 0,
    onOutput: (stream, text) => out.push(`${stream}:${text}`),
    onInputRequest: () => { h.asked++; },
    onPhase: (phase, detail) => phases.push(detail ? `${phase}:${detail}` : phase),
  };
  return h;
}

const request = (extra: Partial<RunRequest> = {}): RunRequest => ({
  lang: "python", entry: "main.py", files: [{ path: "main.py", text: "print(1)\n" }], stdin: "",
  limits: { timeoutMs: 1000, outputCap: 100 }, ...extra,
});

beforeAll(() => {
  // input-channel.ts reads self.crossOriginIsolated; Node has neither.
  Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("PythonRunner", () => {
  it("starts lazily, runs, and reports output, diagnostics and written files", async () => {
    const { runner, workers } = setUp((w) => {
      w.emit({ type: "out", stream: "stdout", text: "1\n" });
      w.emit(done({ exitCode: 1, diagnostics: [{ path: "main.py", line: 1, col: 0, endLine: 1, endCol: 5, unit: "utf16", base: 0, severity: "error", message: "E", source: "python" }],
        written: [{ path: "out.txt", text: "x" }, { path: "../evil", text: "y" }] }));
    });
    expect(runner.state).toBe("idle");
    expect(workers).toHaveLength(0);
    const h = hooks();
    const r = await runner.run(request(), h);
    expect(r.status).toBe("error");
    expect(r.exitCode).toBe(1);
    expect(h.out).toEqual(["stdout:1\n"]);
    expect(h.phases).toEqual(["booting", "running"]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.written).toEqual([{ path: "out.txt", text: "x" }]);
    expect(runner.state).toBe("ready");
    // The run message carries the files, the entry's folder as cwd, and asks about packages.
    expect(workers[0].runs[0]).toMatchObject({ entry: "main.py", cwd: "", packageCheck: true, unavailable: [] });
  });

  it("sends the command-line arguments with the run (none when the request has none), on every attempt", async () => {
    const { runner, workers } = setUp((w, msg) => {
      if (msg.packageCheck && !w.init.packages.includes("numpy")) w.emit({ type: "need-packages", packages: ["numpy"] });
      else w.emit(done());
    });
    await runner.run(request({ args: ["a b", "", "$(rm -rf /)"] }), hooks());
    // The first attempt asked for numpy; the run in the new worker carries the same arguments.
    expect(workers.flatMap((w) => w.runs.map((r) => r.args))).toEqual([["a b", "", "$(rm -rf /)"], ["a b", "", "$(rm -rf /)"]]);
    await runner.run(request(), hooks());
    expect(workers.at(-1)!.runs.at(-1)!.args).toEqual([]);
  });

  it("runs from the entry's folder", async () => {
    const { runner, workers } = setUp((w) => w.emit(done()));
    await runner.run(request({ entry: "week1/main.py", files: [{ path: "week1/main.py", text: "" }] }), hooks());
    expect(workers[0].runs[0].cwd).toBe("week1");
  });

  it("refuses requests it can't run without starting Python", async () => {
    const { runner, workers } = setUp(() => {});
    const r = await runner.run(request({ entry: "../x.py" }), hooks());
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/isn't a Python file/);
    expect(workers).toHaveLength(0);
  });

  it("restarts with the packages a program imports, then runs it there", async () => {
    const { runner, workers } = setUp((w, msg) => {
      if (msg.packageCheck && !w.init.packages.includes("numpy")) w.emit({ type: "need-packages", packages: ["numpy"] });
      else w.emit(done());
    });
    const h = hooks();
    const r = await runner.run(request(), h);
    expect(r.status).toBe("ok");
    expect(workers.map((w) => w.init.packages)).toEqual([[], ["numpy"]]);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].runs[0].packageCheck).toBe(false);
    expect(h.phases).toEqual(["booting", "running", "downloading:numpy", "running"]);
    // Later runs start from the package set already loaded.
    await runner.run(request(), hooks());
    expect(workers).toHaveLength(2);
  });

  it("runs without a package that fails to load, says so, and doesn't try it again", async () => {
    const { runner, workers } = setUp(
      (w, msg) => (msg.packageCheck && !msg.unavailable.includes("pandas") ? w.emit({ type: "need-packages", packages: ["pandas"] }) : w.emit(done({ exitCode: 1 }))),
      (w, msg) => (msg.type === "init" && msg.packages.length ? w.emit({ type: "boot-failed", error: "Failed to fetch", retry: false }) : ready(w, msg as never)),
    );
    const r = await runner.run(request(), hooks());
    expect(r.status).toBe("error");
    expect(r.message).toBe("pandas couldn't be loaded (Failed to fetch), so the program ran without it.");
    // A download failure isn't retried (it would fail the same way); the standard worker comes back.
    expect(workers.map((w) => w.init.packages)).toEqual([[], ["pandas"], []]);
    const again = await runner.run(request(), hooks());
    expect(again.message).toBeUndefined();
    expect(workers.at(-1)!.runs.at(-1)!.unavailable).toEqual(["pandas"]);
    expect(workers).toHaveLength(3);
    runner.restart(); // tries failed packages again
    await vi.advanceTimersByTimeAsync(1);
    await runner.run(request(), hooks());
    expect(workers.map((w) => w.init.packages)).toEqual([[], ["pandas"], [], [], ["pandas"], []]);
  });

  it("retries a start that failed for another reason", async () => {
    let starts = 0;
    const { runner, workers } = setUp((w) => w.emit(done()), (w, msg) => (++starts < 3 ? w.emit({ type: "boot-failed", error: "blocked" }) : ready(w, msg as never)));
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(2000); // the START_ATTEMPTS back-off
    expect((await p).status).toBe("ok");
    expect(workers).toHaveLength(3);
  });

  it("a start superseded during its retry back-off doesn't take over the runtime", async () => {
    let starts = 0;
    const { runner, workers } = setUp((w) => w.emit(done()), (w, msg) => (++starts === 1 ? w.emit({ type: "boot-failed", error: "blocked" }) : ready(w, msg as never)));
    runner.warmUp();
    await vi.advanceTimersByTimeAsync(1); // the first attempt failed; its retry waits 250 ms
    runner.restart(); // a newer start succeeds meanwhile
    await vi.advanceTimersByTimeAsync(1000); // the old retry's delay ends
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).status).toBe("ok"); // sent to the live worker, not to a discarded one
    expect(workers).toHaveLength(2);
  });

  it("a program can't restart its run (and its time limit) by posting need-packages itself", async () => {
    const { runner, workers } = setUp((w) => {
      // Nothing to load, so the program runs, posts need-packages, then finishes.
      if (w.runs.length <= 10) w.emit({ type: "need-packages", packages: [] });
      w.emit(done({ exitCode: 7 }));
    });
    const r = await runner.run(request(), hooks());
    expect(r.exitCode).toBe(7);
    expect(workers[0].runs.map((m) => m.packageCheck)).toEqual([true, false]);
  });

  it("ignores need-packages for packages the build can't load (forged)", async () => {
    const { runner, workers } = setUp((w, msg) => (msg.packageCheck ? w.emit({ type: "need-packages", packages: ["evil"] }) : w.emit(done())));
    expect((await runner.run(request(), hooks())).status).toBe("ok");
    expect(workers).toHaveLength(1);
    expect(workers[0].runs.map((m) => m.packageCheck)).toEqual([true, false]);
  });

  it("interrupts at the time limit; a program that unwinds keeps the warm interpreter", async () => {
    const { runner, workers } = setUp(() => {}); // runs forever until interrupted
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(999);
    expect(runner.state).toBe("running");
    expect(new Uint8Array(workers[0].init.interrupt!)[0]).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(new Uint8Array(workers[0].init.interrupt!)[0]).toBe(2); // SIGINT, which the program sees
    workers[0].emit(done({ exitCode: 130, interrupted: true }));
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(r.exitCode).toBe(130);
    expect(workers).toHaveLength(1);
  });

  it("kills and restarts a program that ignores the interrupt", async () => {
    const { runner, workers } = setUp(() => {});
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(1000 + GRACE_MS + 1);
    const r = await p;
    expect(r).toMatchObject({ status: "timeout", exitCode: null });
    expect(r.message).toMatch(/restarted/);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it("time spent waiting for input doesn't count", async () => {
    const { runner, workers } = setUp((w) => w.emit({ type: "input-request" }));
    const h = hooks();
    const p = runner.run(request(), h);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.asked).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000); // far past the 1 s limit
    expect(runner.state).toBe("running");
    runner.provideInput("hello\n");
    workers[0].emit(done());
    expect((await p).status).toBe("ok");
  });

  it("Stop while waiting for input wakes the program with end of input and reports stopped", async () => {
    const { runner, workers } = setUp((w) => w.emit({ type: "input-request" }));
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(10);
    runner.stop();
    // input-channel.ts layout: Int32 state at 0, 3 = end of input. Asleep, the program can't see SIGINT.
    expect(Atomics.load(new Int32Array(workers[0].init.input!, 0, 1), 0)).toBe(3);
    workers[0].emit(done({ exitCode: 130, interrupted: true }));
    expect((await p).status).toBe("stopped");
    expect(workers).toHaveLength(1); // no hard kill
  });

  it("Stop just before the program blocks on input wakes it at once instead of restarting Python", async () => {
    const { runner, workers } = setUp(() => {});
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(10);
    runner.stop();
    workers[0].emit({ type: "input-request" }); // was on its way: the program hasn't seen the interrupt
    // input-channel.ts layout: Int32 state at 0, 3 = end of input (the worker then raises the interrupt).
    expect(Atomics.load(new Int32Array(workers[0].init.input!, 0, 1), 0)).toBe(3);
    workers[0].emit(done({ exitCode: 130, interrupted: true }));
    expect((await p).status).toBe("stopped");
    expect(workers).toHaveLength(1); // the warm interpreter is kept
  });

  it("cuts output at the cap and stops the program", async () => {
    const { runner, workers } = setUp((w) => {
      w.emit({ type: "out", stream: "stdout", text: "x".repeat(60) });
      w.emit({ type: "out", stream: "stderr", text: "y".repeat(60) });
      w.emit({ type: "out", stream: "stdout", text: "z" });
    });
    const h = hooks();
    const p = runner.run(request(), h);
    await vi.advanceTimersByTimeAsync(10);
    workers[0].emit(done({ exitCode: 130, interrupted: true }));
    const r = await p;
    expect(r.status).toBe("output-limit");
    expect(h.out.join("").replace(/std(out|err):/g, "")).toHaveLength(100);
  });

  it("reads a batch of outputs in order, with the same cap, and ignores malformed parts", async () => {
    const { runner, workers } = setUp((w) => {
      w.emit({ type: "out-batch", parts: [{ stream: "stdout", text: "out 0\n" }, { stream: "stderr", text: "err 0\n" }, { stream: "stdout", text: "out 1\n" }] });
      // Untrusted: a part that isn't an object, or text that isn't a string, is skipped.
      w.emit({ type: "out-batch", parts: [null, { stream: "stderr", text: 5 }, { stream: "stderr", text: "x".repeat(200) }] } as never);
      w.emit({ type: "out-batch", parts: "not a list" } as never);
    });
    const h = hooks();
    const p = runner.run(request(), h);
    await vi.advanceTimersByTimeAsync(10);
    workers[0].emit(done({ exitCode: 130, interrupted: true }));
    const r = await p;
    expect(h.out.slice(0, 3)).toEqual(["stdout:out 0\n", "stderr:err 0\n", "stdout:out 1\n"]);
    expect(r.status).toBe("output-limit");
    expect(h.out.join("").replace(/std(out|err):/g, "")).toHaveLength(100);
  });

  describe("the first start's download (B9)", () => {
    /** Records phases with their progress: "downloading:Python:3000/4000". */
    function progressHooks() {
      const phases: string[] = [];
      const h: RunHooks = {
        onOutput: () => {},
        onInputRequest: () => {},
        onPhase: (phase, detail, progress) => phases.push([phase, detail, progress && `${progress.loaded}/${progress.total}`].filter(Boolean).join(":")),
      };
      return { h, phases };
    }
    const progress = (loaded: number, total: number, finished = false): FromPython => ({ type: "progress", loaded, total, done: finished });

    it("shows the download after about 1 s of start-up, with its bytes, then Starting again once they are in", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {}); // ready only when the test says
      const { h, phases } = progressHooks();
      const p = runner.run(request(), h);
      await vi.advanceTimersByTimeAsync(0);
      workers[0].emit(progress(1000, 4000));
      await vi.advanceTimersByTimeAsync(500);
      expect(phases, "nothing about a download in the first second").toEqual(["booting"]);
      await vi.advanceTimersByTimeAsync(600);
      expect(phases).toEqual(["booting", "downloading:Python:1000/4000"]);
      expect(runner.downloadShown()).toEqual({ loaded: 1000, total: 4000 });
      workers[0].emit(progress(3000, 4000));
      expect(phases.at(-1)).toBe("downloading:Python:3000/4000");
      workers[0].emit(progress(4000, 4000));
      expect(phases.at(-1), "every byte is in: Python is starting").toBe("booting");
      expect(runner.downloadShown()).toBeNull();
      workers[0].emit({ type: "ready", ms: 10, source: "fresh", loaded: [], available: AVAILABLE, packageMs: 0 });
      expect((await p).status).toBe("ok");
      expect(phases).toEqual(["booting", "downloading:Python:1000/4000", "downloading:Python:3000/4000", "booting", "running"]);
    });

    it("a quick start (the runtime already on this device) never mentions a download", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {});
      const { h, phases } = progressHooks();
      const p = runner.run(request(), h);
      await vi.advanceTimersByTimeAsync(0);
      workers[0].emit(progress(4000, 4000));
      await vi.advanceTimersByTimeAsync(300);
      workers[0].emit(progress(4000, 4000, true));
      await vi.advanceTimersByTimeAsync(900);
      workers[0].emit({ type: "ready", ms: 10, source: "snapshot", loaded: [], available: AVAILABLE, packageMs: 0 });
      await p;
      expect(phases).toEqual(["booting", "running"]);
    });

    it("a size the build doesn't know shows the bytes until the download says it is done", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {});
      const { h, phases } = progressHooks();
      const p = runner.run(request(), h);
      await vi.advanceTimersByTimeAsync(0);
      workers[0].emit(progress(5000, 0));
      await vi.advanceTimersByTimeAsync(1100);
      expect(phases.at(-1)).toBe("downloading:Python:5000/0");
      workers[0].emit(progress(6000, 0, true));
      expect(phases.at(-1)).toBe("booting");
      workers[0].emit({ type: "ready", ms: 10, source: "fresh", loaded: [], available: AVAILABLE, packageMs: 0 });
      await p;
    });

    it("a Run pressed after warmUp's download has gone on for a second shows it at once", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {});
      runner.warmUp();
      await vi.advanceTimersByTimeAsync(0);
      workers[0].emit(progress(2000, 4000));
      await vi.advanceTimersByTimeAsync(1500);
      const { h, phases } = progressHooks();
      const p = runner.run(request(), h);
      await vi.advanceTimersByTimeAsync(0);
      expect(phases).toEqual(["booting", "downloading:Python:2000/4000"]);
      workers[0].emit({ type: "ready", ms: 10, source: "fresh", loaded: [], available: AVAILABLE, packageMs: 0 });
      await p;
      expect(runner.downloadShown()).toBeNull();
    });

    it("tells state listeners when the download becomes worth showing, even with no new bytes then (a stalled connection)", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {});
      const seen: (string | null)[] = [];
      runner.onState(() => seen.push(runner.downloadShown() ? "shown" : null));
      runner.warmUp();
      await vi.advanceTimersByTimeAsync(0);
      workers[0].emit(progress(2000, 4000)); // then nothing arrives
      await vi.advanceTimersByTimeAsync(1100);
      expect(seen.at(-1)).toBe("shown");
    });

    it("tells state listeners about progress, ignores malformed counts, and forgets the download once ready", async () => {
      const { runner, workers } = setUp((w) => w.emit(done()), () => {});
      let calls = 0;
      runner.onState(() => calls++);
      runner.warmUp();
      await vi.advanceTimersByTimeAsync(1100);
      const before = calls;
      workers[0].emit(progress(100, 4000));
      expect(calls).toBe(before + 1);
      workers[0].emit({ type: "progress", loaded: Number.NaN, total: -5, done: false } as FromPython);
      workers[0].emit({ type: "progress", loaded: "9" as unknown as number, total: 4000, done: false });
      expect(runner.downloadShown()).toEqual({ loaded: 100, total: 4000 });
      workers[0].emit({ type: "ready", ms: 10, source: "fresh", loaded: [], available: AVAILABLE, packageMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.downloadShown()).toBeNull();
      // A program posting progress later changes nothing (only start-up listens for it).
      workers[0].emit(progress(1, 4000));
      expect(runner.downloadShown()).toBeNull();
    });
  });

  it("Stop during start-up cancels the run before it is sent", async () => {
    const { runner, workers } = setUp(() => {}, () => {}); // never becomes ready
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(10);
    runner.stop();
    expect((await p).status).toBe("stopped");
    expect(workers[0].runs).toHaveLength(0);
  });

  it("reports unavailable after START_ATTEMPTS failed starts", async () => {
    const { runner, workers } = setUp(() => {}, (w) => w.fail("Worker load was blocked"));
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/blocked/);
    expect(workers).toHaveLength(3);
    expect(runner.state).toBe("failed");
  });

  it("an out-of-memory run is a crash with a plain message, and the runtime is replaced", async () => {
    const { runner, workers } = setUp((w) => w.emit(done({ exitCode: 1, outOfMemory: true, recycle: true })));
    const r = await runner.run(request(), hooks());
    expect(r.status).toBe("crashed");
    expect(r.message).toMatch(/ran out of memory \(its limit is 512 MB\)/);
    await vi.advanceTimersByTimeAsync(10);
    expect(workers).toHaveLength(2);
    expect(runner.state).toBe("ready");
  });

  it("restart() during a run stops it and replaces the interpreter even if the program unwinds", async () => {
    const { runner, workers } = setUp(() => {});
    const p = runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(10);
    runner.restart();
    workers[0].emit(done({ exitCode: 130, interrupted: true, recycle: false }));
    expect((await p).status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(1);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(runner.state).toBe("ready");
  });

  it("a program from another folder gets a fresh interpreter: nothing one folder's program left in memory reaches another's", async () => {
    const { runner, workers } = setUp((w) => w.emit(done()));
    const at = (entry: string) => request({ entry, files: [{ path: entry, text: "" }] });
    await runner.run(at("lab1-2/main.py"), hooks());
    await runner.run(at("lab1-2/other.py"), hooks()); // the same folder keeps the warm interpreter
    expect(workers).toHaveLength(1);
    await runner.run(at("lab1/main.py"), hooks());
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].runs.map((r) => r.entry)).toEqual(["lab1/main.py"]);
    await runner.run(at("main.py"), hooks()); // the top level is a folder of its own too
    expect(workers).toHaveLength(3);
  });

  it("only one run at a time", async () => {
    const { runner } = setUp(() => {});
    void runner.run(request(), hooks());
    await expect(runner.run(request(), hooks())).rejects.toThrow(/already running/);
  });
});

describe("PythonRunner.check", () => {
  it("answers only while ready, and drops stale replies", async () => {
    const replies: Extract<ToPython, { type: "check" }>[] = [];
    const { runner, workers } = setUp((w) => w.emit(done()));
    expect(await runner.check("main.py", "x")).toBeNull(); // not started
    runner.warmUp();
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.state).toBe("ready");
    const w = workers[0];
    const first = runner.check("main.py", "if True");
    const second = runner.check("main.py", "if True:");
    replies.push(...(w.sent.filter((m) => m.type === "check") as never[]));
    expect(replies.map((m) => m.text)).toEqual(["if True", "if True:"]);
    const diag = { path: "main.py", line: 1, col: 7, endLine: 1, endCol: 8, unit: "utf16", base: 0, severity: "error", message: "SyntaxError: expected ':'", source: "python" } as const;
    w.emit({ type: "checked", id: replies[0].id, diagnostics: [diag] });
    w.emit({ type: "checked", id: replies[1].id, diagnostics: [] });
    expect(await first).toBeNull();
    expect(await second).toEqual([]);
    expect(await runner.check("notes.txt", "x")).toBeNull();
  });

  it("is never sent while a program runs", async () => {
    const { runner, workers } = setUp(() => {});
    void runner.run(request(), hooks());
    await vi.advanceTimersByTimeAsync(1);
    expect(await runner.check("main.py", "x")).toBeNull();
    expect(workers[0].sent.some((m) => m.type === "check")).toBe(false);
  });
});
