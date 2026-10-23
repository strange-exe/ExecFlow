import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunHooks, RunRequest } from "../core/types";
import type { FromCompiler, FromProgram } from "./clang-protocol";
import { TailWriter } from "./cpp-output-tail";
import { acceptWritten, BOOT_TIMEOUT_MS, CppRunner, STEP_TIMEOUT_MS, summarize } from "./cpp-runner";

/** A stand-in for a worker: records what it's sent and replies when the test says so. */
class FakeWorker {
  sent: { type: string; [k: string]: unknown }[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private listeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
  addEventListener(type: string, fn: (e: { data: unknown }) => void) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: (e: { data: unknown }) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  postMessage(msg: { type: string }) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  reply(data: FromCompiler | FromProgram) {
    for (const fn of [...(this.listeners.message ?? [])]) fn({ data });
    this.onmessage?.({ data });
  }
  last(type: string): unknown { return [...this.sent].reverse().find((m) => m.type === type); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The program worker the runner handed the program to; it says "started" as the real one does. */
function running(programs: FakeWorker[]): FakeWorker {
  const worker = [...programs].reverse().find((p) => p.last("run") && !p.terminated);
  if (!worker) throw new Error("no program worker got the program");
  worker.reply({ type: "started" });
  return worker;
}

function setup(installed: boolean) {
  const compilers: FakeWorker[] = [];
  const programs: FakeWorker[] = [];
  const runner = new CppRunner(
    () => { const w = new FakeWorker(); compilers.push(w); return w as unknown as Worker; },
    () => { const w = new FakeWorker(); programs.push(w); return w as unknown as Worker; },
  );
  compilers[0].reply({ type: "pack", installed });
  return { runner, compilers, programs, compiler: () => compilers[compilers.length - 1] };
}

function hooks() {
  const out: string[] = [];
  const phases: string[] = [];
  const h: RunHooks = { onOutput: (s, t) => out.push(`${s}:${t}`), onInputRequest: () => phases.push("input"), onPhase: (p, d) => phases.push(d ? `${p}:${d}` : p) };
  return { h, out, phases };
}

const REQ: RunRequest = {
  lang: "c",
  entry: "lab/ex1.c",
  files: [
    { path: "lab/ex1.c", text: '#include <stdio.h>\nint main(void) { char s[9]; gets(s); return 0; }\n' },
    { path: "lab/ex2.c", text: "int main(void) { return 0; }\n" },
    { path: "lab/util.c", text: "int helper(void) { return 1; }\n" },
    { path: "lab/input.txt", text: "3 4\n" },
    { path: "other/x.c", text: "int x;\n" },
  ],
  stdin: "",
  limits: { timeoutMs: 15_000, outputCap: 1000 },
};

beforeEach(() => {
  vi.stubGlobal("self", globalThis); // input-channel.ts reads self.crossOriginIsolated
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the C/C++ download", () => {
  it("starts when asked, once the pack is known to be missing", () => {
    const { runner, compiler } = setup(false);
    expect(runner.state).toBe("absent");
    runner.download();
    expect(runner.state).toBe("downloading");
    expect(compiler().sent.map((m) => m.type)).toEqual(["check", "download"]);
  });

  it("never fails silently: a blank reason still gives the user one (and so a Try again button)", () => {
    const { runner, compiler } = setup(false);
    runner.download();
    compiler().reply({ type: "download-failed", error: "" });
    expect(runner.state).toBe("absent");
    expect(runner.error).not.toBe("");
  });

  it("keeps the worker's own reason when there is one, and reports progress", () => {
    const { runner, compiler } = setup(false);
    const seen: string[] = [];
    runner.subscribe((s) => seen.push(`${s}:${runner.progress.loaded}`));
    runner.download();
    compiler().reply({ type: "progress", loaded: 500, total: 1000 });
    compiler().reply({ type: "download-failed", error: "clang.wasm: HTTP 503" });
    expect(runner.error).toBe("clang.wasm: HTTP 503");
    expect(seen).toEqual(["downloading:0", "downloading:500", "absent:500"]);
  });

  it("says the pack must be downloaded first instead of failing", async () => {
    const { runner } = setup(false);
    const r = await runner.run(REQ, hooks().h);
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/Download the C\/C\+\+ compiler first/);
  });
});

describe("a C/C++ run", () => {
  it("boots clang, builds the program's units, runs it with its folder's files and checks what it wrote", async () => {
    const { runner, compiler, programs } = setup(true);
    const { h, out, phases } = hooks();
    const done = runner.run(REQ, h);
    await tick();
    expect(compiler().last("boot")).toBeTruthy();
    compiler().reply({ type: "ready", ms: 5 });
    await tick();
    const build = compiler().last("build") as { id: number; root: string; units: { path: string }[]; files: { path: string }[] };
    expect(build.root).toBe("lab");
    expect(build.units.map((u) => u.path)).toEqual(["lab/ex1.c", "lab/util.c"]);
    expect(build.files.map((f) => f.path)).not.toContain("lab/input.txt");
    compiler().reply({ type: "step", id: build.id, step: "compile", path: "lab/ex1.c" });
    compiler().reply({ type: "unit", id: build.id, path: "lab/ex1.c", state: "ok", ms: 1, diagnostics: [] });
    compiler().reply({ type: "step", id: build.id, step: "link" });
    compiler().reply({ type: "built", id: build.id, ok: true, stage: "link", wasm: new Uint8Array([0, 97, 115, 109]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 2, reused: 0, recycle: false });
    await tick();
    const program = running(programs);
    const run = program.last("run") as { files: { path: string }[]; args: string[]; outputCap: number };
    expect(run.files.map((f) => f.path).sort()).toEqual(["ex1.c", "ex2.c", "input.txt", "util.c"]);
    expect(run.args).toEqual(["ex1"]);
    program.reply({ type: "out", stream: "stdout", text: "7\n" });
    const enc = new TextEncoder();
    program.reply({
      type: "done", exitCode: 0, truncated: false, ms: 3,
      written: [
        { path: "out.txt", bytes: enc.encode("sum=7\n") },
        { path: "../escape.txt", bytes: enc.encode("x") },
        { path: "bin.dat", bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]) },
      ],
    });
    const r = await done;
    expect(r.status).toBe("ok");
    expect(r.exitCode).toBe(0);
    expect(r.skipped).toEqual(["lab/ex2.c"]);
    expect(r.written).toEqual([{ path: "lab/out.txt", text: "sum=7\n" }]);
    expect(out).toEqual(["stdout:7\n"]);
    expect(phases).toEqual(["booting", "compiling:lab/ex1.c", "linking", "running"]);
    expect(r.diagnostics.map((d) => d.code)).toContain("gets"); // the hint, from all the program's sources
    expect(program.terminated).toBe(true);
    expect(runner.state).toBe("ready");
  });

  it("gives the program its arguments after its name: argv[0] is the file's stem, then each argument as given", async () => {
    const { runner, compiler, programs } = setup(true);
    runner.prepare();
    compiler().reply({ type: "ready", ms: 1 });
    const args = ["two words", "", "$(rm -rf /)", ";", "|"];
    const done = runner.run({ ...REQ, args }, hooks().h);
    await tick();
    const b = compiler().last("build") as { id: number; options: Record<string, unknown> };
    expect(b.options).not.toHaveProperty("defines");
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0, 97, 115, 109]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 2, reused: 0, recycle: false });
    await tick();
    const program = running(programs);
    expect((program.last("run") as { args: string[] }).args).toEqual(["ex1", ...args]);
    program.reply({ type: "done", exitCode: 0, truncated: false, ms: 1, written: [] });
    expect((await done).status).toBe("ok");
  });

  it("gives hints only about the program's own files, not other programs in the workspace", async () => {
    const { runner, compiler, programs } = setup(true);
    runner.prepare();
    compiler().reply({ type: "ready", ms: 1 });
    const req: RunRequest = {
      ...REQ,
      entry: "lab/main.c",
      files: [
        { path: "lab/main.c", text: '#include "util.h"\nint main(void) { return helper(); }\n' },
        { path: "lab/util.h", text: "int helper(void);\nstatic inline void line(char *s) { gets(s); }\n" },
        { path: "lab/util.c", text: '#include <stdio.h>\nint helper(void) { char c; return scanf("%c", &c); }\n' },
        { path: "lab/ex2.c", text: "void main() { }\n" }, // skipped: its own main()
        { path: "old/turbo.c", text: "#include <conio.h>\nvoid main() { clrscr(); }\n" }, // another program
      ],
    };
    const done = runner.run(req, hooks().h);
    await tick();
    const b = compiler().last("build") as { id: number; files: { path: string }[] };
    expect(b.files.map((f) => f.path)).toContain("old/turbo.c"); // still mounted, for #include "../x.h"
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 2, reused: 0, recycle: false });
    await tick();
    running(programs).reply({ type: "done", exitCode: 0, truncated: false, ms: 1, written: [] });
    const r = await done;
    expect(r.diagnostics.filter((d) => d.source === "hint").map((d) => [d.code, d.path])).toEqual([["gets", "lab/util.h"], ["scanf-char", "lab/util.c"]]);
  });

  it("reports a failed build with a summary and stays ready", async () => {
    const { runner, compiler } = setup(true);
    runner.prepare(); // a C/C++ file is open: clang boots before Run
    compiler().reply({ type: "ready", ms: 1 });
    const done = runner.run(REQ, hooks().h);
    await tick();
    const build = compiler().last("build") as { id: number };
    compiler().reply({
      type: "built", id: build.id, ok: false, stage: "compile", compileMs: 1, linkMs: 0, compiled: 2, reused: 0, recycle: false,
      diagnostics: [
        { path: "lab/util.h", line: 2, unit: "utf8-byte", base: 1, severity: "error", message: "expected expression", source: "clang" },
        { path: "lab/ex1.c", line: 3, unit: "utf8-byte", base: 1, severity: "error", message: "x", source: "clang" },
      ],
    });
    const r = await done;
    expect(r.status).toBe("build-failed");
    expect(r.message).toBe("The program didn't compile: 2 errors in util.h and ex1.c.");
    expect(runner.state).toBe("ready");
  });

  it("gives every build step its own time limit, then replaces the stuck compiler", async () => {
    vi.useFakeTimers();
    const { runner, compiler, compilers } = setup(true);
    runner.prepare(); // a C/C++ file is open: clang boots before Run
    compiler().reply({ type: "ready", ms: 1 });
    const done = runner.run(REQ, hooks().h);
    await vi.advanceTimersByTimeAsync(0);
    const first = compiler();
    const build = first.last("build") as { id: number };
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS - 1000);
    first.reply({ type: "unit", id: build.id, path: "lab/ex1.c", state: "ok", ms: 29_000, diagnostics: [] });
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS - 1000);
    expect(first.terminated).toBe(false); // 58 s in total, but no single step took 30 s
    await vi.advanceTimersByTimeAsync(2000);
    const r = await done;
    expect(r.status).toBe("timeout");
    expect(r.message).toMatch(/30 s/);
    expect(first.terminated).toBe(true);
    expect(compilers.length).toBe(2);
  });

  it("after a failed start, a run waits for the fresh worker's pack check (and offers the download if the pack is gone)", async () => {
    const { runner, compiler, compilers } = setup(true);
    runner.prepare();
    compiler().reply({ type: "boot-failed", error: "out of memory" });
    expect(runner.state).toBe("failed");
    const done = runner.run(REQ, hooks().h);
    await tick();
    expect(compilers.length).toBe(2);
    expect(compiler().sent.map((m) => m.type)).toEqual(["check"]); // no boot before the answer
    compiler().reply({ type: "pack", installed: false }); // e.g. site data was cleared meanwhile
    const r = await done;
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/Download the C\/C\+\+ compiler first/);
    expect(runner.state).toBe("absent"); // so the page offers the download again
    expect(compiler().sent.map((m) => m.type)).toEqual(["check"]);
  });

  it("a replacement compiler worker that can't load at all is reported, not waited on", async () => {
    vi.useFakeTimers();
    const { runner, compiler, compilers } = setup(true);
    runner.prepare();
    compiler().reply({ type: "boot-failed", error: "x" });
    let result: Awaited<ReturnType<CppRunner["run"]>> | undefined;
    void runner.run(REQ, hooks().h).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      // WebKit: "Worker load was blocked by Cross-Origin-Embedder-Policy", before any reply.
      const w = compiler() as unknown as { listeners: Record<string, ((e: unknown) => void)[]> };
      w.listeners.error.forEach((fn) => fn({ preventDefault() {}, message: "Worker load was blocked" }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(compilers.length).toBe(4);
    expect(result).toMatchObject({ status: "unavailable", message: "The C/C++ compiler couldn't start (Worker load was blocked)." });
    expect(runner.state).toBe("failed");
  });

  it("a compiler worker that dies while clang loads is reported, not waited on", async () => {
    const { runner, compiler } = setup(true);
    const done = runner.run(REQ, hooks().h);
    await tick();
    expect(compiler().last("boot")).toBeTruthy();
    const w = compiler() as unknown as { listeners: Record<string, ((e: unknown) => void)[]> };
    w.listeners.error.forEach((fn) => fn({ preventDefault() {}, message: "out of memory" }));
    const r = await done;
    expect(r).toMatchObject({ status: "unavailable", message: "The C/C++ compiler couldn't start (out of memory)." });
    expect(runner.state).toBe("failed");
    expect(compiler().terminated).toBe(true);
  });

  it("a compiler worker that never answers its boot is given up after BOOT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const { runner, compiler } = setup(true);
    let result: Awaited<ReturnType<CppRunner["run"]>> | undefined;
    void runner.run(REQ, hooks().h).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ status: "unavailable", message: "The C/C++ compiler couldn't start (the compiler took too long to start)." });
    expect(compiler().terminated).toBe(true);
  });

  it("after a failed start with the pack still there, a run boots the fresh worker once and builds", async () => {
    const { runner, compiler } = setup(true);
    const first = runner.run(REQ, hooks().h); // no prepare(): the run itself boots clang
    await tick();
    compiler().reply({ type: "boot-failed", error: "" });
    expect((await first).status).toBe("unavailable");
    expect(runner.state).toBe("failed");
    const done = runner.run(REQ, hooks().h);
    await tick();
    expect(compiler().sent.map((m) => m.type)).toEqual(["check"]);
    compiler().reply({ type: "pack", installed: true });
    await tick();
    expect(compiler().sent.map((m) => m.type)).toEqual(["check", "boot"]);
    compiler().reply({ type: "ready", ms: 1 });
    await tick();
    const b = compiler().last("build") as { id: number };
    expect(b).toBeTruthy();
    compiler().reply({ type: "built", id: b.id, ok: false, stage: "compile", compileMs: 1, linkMs: 0, compiled: 1, reused: 0, recycle: false, diagnostics: [] });
    expect((await done).status).toBe("build-failed");
  });

  it("Stop while clang loads never compiles", async () => {
    const { runner, compiler } = setup(true);
    const done = runner.run(REQ, hooks().h);
    await tick();
    runner.stop();
    const r = await done;
    expect(r.status).toBe("stopped");
    expect(compiler().last("build")).toBeUndefined();
  });

  it("times a program out, then ends it; a crash is reported in words", async () => {
    vi.useFakeTimers();
    const { runner, compiler, programs } = setup(true);
    runner.prepare(); // a C/C++ file is open: clang boots before Run
    compiler().reply({ type: "ready", ms: 1 });
    const built = async () => {
      await vi.advanceTimersByTimeAsync(0);
      const b = compiler().last("build") as { id: number };
      compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
      await vi.advanceTimersByTimeAsync(0);
      return running(programs);
    };
    const loop = runner.run({ ...REQ, limits: { timeoutMs: 1000, outputCap: 100 } }, hooks().h);
    const p1 = await built();
    await vi.advanceTimersByTimeAsync(1100);
    const r1 = await loop;
    expect(r1.status).toBe("timeout");
    expect(p1.terminated).toBe(true);
    const crash = runner.run(REQ, hooks().h);
    const p2 = await built();
    p2.reply({ type: "done", exitCode: -1, crash: "stack overflow (infinite or very deep recursion?)", truncated: false, ms: 2, written: [] });
    const r2 = await crash;
    expect(r2).toMatchObject({ status: "crashed", exitCode: null, message: "The program crashed: stack overflow (infinite or very deep recursion?)." });
    expect(r2.diagnostics.some((d) => d.source === "runtime")).toBe(true);
  });

  it("doesn't use a spare worker that failed to load, and replaces one that never starts", async () => {
    vi.useFakeTimers();
    const { runner, compiler, programs } = setup(true);
    runner.prepare();
    compiler().reply({ type: "ready", ms: 1 });
    const spare = programs[0];
    let prevented = false;
    // WebKit: "Worker load was blocked by Cross-Origin-Embedder-Policy", before any run.
    (spare as unknown as { listeners: Record<string, ((e: unknown) => void)[]> }).listeners.error.forEach((fn) => fn({ preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(true);
    const done = runner.run(REQ, hooks().h);
    await vi.advanceTimersByTimeAsync(0);
    const b = compiler().last("build") as { id: number };
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(spare.last("run")).toBeUndefined();
    expect(spare.terminated).toBe(true);
    const silent = [...programs].reverse().find((p) => p.last("run"))!;
    await vi.advanceTimersByTimeAsync(5_000); // never says "started": replaced
    expect(silent.terminated).toBe(true);
    const next = running(programs);
    expect(next).not.toBe(silent);
    next.reply({ type: "done", exitCode: 0, truncated: false, ms: 1, written: [] });
    expect((await done).status).toBe("ok");
  });

  it("stops a program that floods its output at the cap", async () => {
    const { runner, compiler, programs } = setup(true);
    runner.prepare(); // a C/C++ file is open: clang boots before Run
    compiler().reply({ type: "ready", ms: 1 });
    const { h, out } = hooks();
    const done = runner.run({ ...REQ, limits: { timeoutMs: 5000, outputCap: 10 } }, h);
    await tick();
    const b = compiler().last("build") as { id: number };
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
    await tick();
    running(programs).reply({ type: "out", stream: "stdout", text: "x".repeat(25) });
    const r = await done;
    expect(r.status).toBe("output-limit");
    expect(out).toEqual([`stdout:${"x".repeat(10)}`]);
  });

  it("shows what a program printed just before it hung once the timeout (or Stop) ends it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crossOriginIsolated", true);
    const { runner, compiler, programs } = setup(true);
    runner.prepare();
    compiler().reply({ type: "ready", ms: 1 });
    const { h, out } = hooks();
    const done = runner.run({ ...REQ, limits: { timeoutMs: 1000, outputCap: 100 } }, h);
    await vi.advanceTimersByTimeAsync(0);
    const b = compiler().last("build") as { id: number };
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
    await vi.advanceTimersByTimeAsync(0);
    const program = running(programs);
    const sent = program.last("run") as { tail: SharedArrayBuffer | null };
    expect(sent.tail).toBeInstanceOf(SharedArrayBuffer);
    program.reply({ type: "out", stream: "stdout", text: "line 1\n" });
    // The worker's unposted batch; the program then loops forever, so it never posts it.
    const worker = new TailWriter(sent.tail!);
    worker.append("stdout", "line 2\n");
    worker.append("stdout", "x".repeat(200));
    await vi.advanceTimersByTimeAsync(1100);
    expect((await done).status).toBe("timeout");
    expect(out).toEqual(["stdout:line 1\n", `stdout:line 2\n${"x".repeat(100 - 14)}`]); // still within the cap
    // Stop reads it too; a batch the worker posted (and so cleared) isn't shown twice.
    const again = hooks();
    const stopped = runner.run(REQ, again.h);
    await vi.advanceTimersByTimeAsync(0);
    const b2 = compiler().last("build") as { id: number };
    compiler().reply({ type: "built", id: b2.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
    await vi.advanceTimersByTimeAsync(0);
    const p2 = running(programs);
    const w2 = new TailWriter((p2.last("run") as { tail: SharedArrayBuffer }).tail);
    w2.append("stderr", "posted\n");
    w2.clear();
    p2.reply({ type: "out", stream: "stderr", text: "posted\n" });
    w2.append("stdout", "pending\n");
    runner.stop();
    expect((await stopped).status).toBe("stopped");
    expect(again.out).toEqual(["stderr:posted\n", "stdout:pending\n"]);
  });

  it("reports the worker's own byte cap as the output limit, not as exit code -1", async () => {
    const { runner, compiler, programs } = setup(true);
    runner.prepare();
    compiler().reply({ type: "ready", ms: 1 });
    const done = runner.run(REQ, hooks().h);
    await tick();
    const b = compiler().last("build") as { id: number };
    compiler().reply({ type: "built", id: b.id, ok: true, stage: "link", wasm: new Uint8Array([0]), diagnostics: [], compileMs: 1, linkMs: 1, compiled: 1, reused: 0, recycle: false });
    await tick();
    running(programs).reply({ type: "done", exitCode: -1, truncated: true, ms: 5, written: [] });
    const r = await done;
    expect(r).toMatchObject({ status: "output-limit", exitCode: null });
    expect(r.message).toMatch(/more than 1,000 characters/);
  });
});

describe("files a program wrote", () => {
  const enc = new TextEncoder();
  it("keeps clean text files inside the program folder, at most 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `out${i}.txt`, bytes: enc.encode(`${i}\n`) }));
    expect(acceptWritten("p", many)).toHaveLength(20);
    expect(acceptWritten("", [{ path: "results/r.txt", bytes: enc.encode("r\r\n") }])).toEqual([{ path: "results/r.txt", text: "r\n" }]);
  });

  it("drops anything unsafe: bad names, binary or invalid UTF-8, direction tricks, non-bytes", () => {
    expect(acceptWritten("p", [
      { path: "../x.txt", bytes: enc.encode("x") },
      { path: "a/../../x.txt", bytes: enc.encode("x") },
      { path: "con.txt", bytes: enc.encode("x") },
      { path: "bad.txt", bytes: new Uint8Array([0xff, 0xfe, 0x41]) },
      { path: "trick.txt", bytes: enc.encode(`a${String.fromCodePoint(0x202e)}b`) },
      { path: "s.txt", bytes: "not bytes" },
      null,
    ])).toEqual([]);
    expect(acceptWritten("p", "nope")).toEqual([]);
  });

  it("summarises errors by file", () => {
    const e = (path: string | null) => ({ path, line: 1, unit: "utf16" as const, base: 0 as const, severity: "error" as const, message: "m", source: "clang" as const });
    expect(summarize([e("a/x.c")])).toBe("1 error in x.c");
    expect(summarize([e("a.c"), e("b.c"), e("c.c"), e("d.c")])).toBe("4 errors in 4 files");
    expect(summarize([e(null)])).toBe("1 error");
  });
});
