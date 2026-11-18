/// <reference types="node" />
// The run trace end to end in the real interpreter: Pyodide (CPython 3.14, the version the app
// ships) runs the real helper (RUNNER_PY's __ce_run with tracing on), the worker's conversion
// (traceFromPython) reads __ce_trace, and the counts are mapped onto the program's real chart.
// Also: input() still works while tracing, imported modules aren't traced, and the cap keeps a
// long loop's cost small (the measured times are printed; the bound is generous for slow runners).
import { join } from "node:path";
import { loadPyodide, type PyodideAPI } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { chartFile, ok, withPack } from "../flowchart/fixtures/harness";
import type { FlowChart } from "../flowchart/model";
import { SUM_EVENS, SUM_EVENS_LINES, SUM_EVENS_N, SUM_EVENS_TOTAL } from "../flowchart/fixtures/trace-runs";
import { stepsFor } from "../flowchart/steps";
import { ranUntraced, traceChart } from "../flowchart/trace";
import { RUNNER_PY } from "./python-helper";
import { TRACE_STEPS, traceFromPython, VALUE_BUDGET, VALUE_STEPS, VALUE_TEXT } from "./run-trace";

const test = withPack ? it : it.skip;

let py: PyodideAPI;
let stdin = new Uint8Array();
/** What the runs printed (the values tests check that no user __repr__ ran). */
let printed = "";

beforeAll(async () => {
  py = await loadPyodide({ indexURL: join(process.cwd(), "node_modules", "pyodide") + "/" });
  py.setStdout({ batched: (s) => void (printed += s + "\n") });
  py.setStderr({ batched: () => {} });
  py.setStdin({
    read(buffer: Uint8Array) {
      const n = Math.min(buffer.length, stdin.length);
      buffer.set(stdin.subarray(0, n));
      stdin = stdin.subarray(n);
      return n;
    },
  });
  py.runPython(RUNNER_PY);
  py.globals.get("__ce_configure")(JSON.stringify({ imports: {} }));
  py.FS.mkdirTree("/workspace");
}, 120_000);

/** Runs `files` (the first is the entry) with tracing `on`; the run's JSON result, the trace and the run's time. */
function run(files: Record<string, string>, on = true, input = "") {
  for (const [name, text] of Object.entries(files)) py.FS.writeFile(`/workspace/${name}`, text);
  stdin = new TextEncoder().encode(input);
  const entry = Object.keys(files)[0];
  const t0 = performance.now();
  const result = JSON.parse(py.globals.get("__ce_run")(entry, "", "[]", "[]", on)) as { exit: number };
  const ms = performance.now() - t0;
  const proxy = py.globals.get("__ce_trace")();
  const trace = proxy ? traceFromPython(proxy.toJs()) : undefined;
  proxy?.destroy();
  // The trace's own time after the run: written out, converted and checked.
  const traceMs = performance.now() - t0 - ms;
  return { result, trace, ms, traceMs };
}

const program = async (source: string): Promise<FlowChart> => ok((await chartFile("python", source)).charts[0]);
const edge = (chart: FlowChart, from: string, label?: string) =>
  chart.edges.findIndex((e) => chart.nodes[e.from].text.startsWith(from) && (label === undefined || e.label === label));

const MARKS = `marks = [72, 85, 64, 90, 58]
n = len(marks)
total = 0
best = marks[0]
i = 0
while i < n:
    print("marks", i, marks[i])
    total += marks[i]
    if marks[i] > best:
        best = marks[i]
    i += 1
print("Best:", best)
`;

describe("run trace in Pyodide", () => {
  test("the helper's cap is the page's TRACE_STEPS", () => {
    expect(RUNNER_PY).toContain(`TRACE_STEPS = ${TRACE_STEPS}\n`);
    expect(RUNNER_PY).toContain(`VALUE_TEXT = ${VALUE_TEXT}\n`);
    expect(RUNNER_PY).toContain(`VALUE_STEPS = ${VALUE_STEPS}\n`);
    expect(RUNNER_PY).toContain(`VALUE_BUDGET = ${VALUE_BUDGET}  #`);
  });

  test("counts the Flow Board example's branches", async () => {
    const { result, trace } = run({ "marks.py": MARKS });
    expect(result.exit).toBe(0);
    expect(trace).toBeDefined();
    expect(trace!.partial).toBe(false);
    expect(trace!.codes).toEqual([{ name: "<module>", line: 1 }]);
    const chart = await program(MARKS);
    const t = traceChart(chart, trace!, true)!;
    expect(t.counts[edge(chart, "i < n", "Yes")]).toBe(5);
    expect(t.counts[edge(chart, "i < n", "No")]).toBe(1);
    expect(t.counts[edge(chart, "marks[i] > best", "Yes")]).toBe(2);
    expect(t.counts[edge(chart, "marks[i] > best", "No")]).toBe(3);
    expect(t.counts[edge(chart, "i += 1")]).toBe(5);
  }, 60_000);

  test("input() works while tracing, and only the run file is traced", async () => {
    const helper = "def double(x):\n    if x > 0:\n        return 2 * x\n    return 0\n";
    const main = "import helper\n\ndef ask():\n    return int(input())\n\nn = ask()\nfor k in range(n):\n    print(helper.double(k))\n";
    const { result, trace } = run({ "main.py": main, "helper.py": helper }, true, "3\n");
    expect(result.exit).toBe(0);
    expect(trace!.codes.map((c) => c.name).sort()).toEqual(["<module>", "ask"]);
    const chart = await program(main);
    const t = traceChart(chart, trace!, true)!;
    expect(t.counts[edge(chart, "for k in range(n)", "Yes")]).toBe(3);
    const ask = ok((await chartFile("python", main)).charts[1]);
    expect(traceChart(ask, trace!, false)!.calls).toBe(1);
  }, 60_000);

  test("functions, methods and recursion: each chart sums its own calls", async () => {
    const src = "class Shape:\n    def area(self, n):\n        if n <= 1:\n            return 1\n        return n * self.area(n - 1)\n\nprint(Shape().area(4))\n";
    const { trace } = run({ "shape.py": src });
    const all = await chartFile("python", src);
    const area = ok(all.charts.find((c) => c.name === "Shape.area")!);
    const t = traceChart(area, trace!, false)!;
    expect(t.calls).toBe(4);
    expect(t.counts[edge(area, "n <= 1", "Yes")]).toBe(1);
    expect(t.counts[edge(area, "n <= 1", "No")]).toBe(3);
  }, 60_000);

  test("a generator ran but isn't traced; the loop that used it is", async () => {
    const src = "def evens(n):\n    for k in range(n):\n        if k % 2 == 0:\n            yield k\n\nfor e in evens(6):\n    print(e)\n";
    const { result, trace } = run({ "gen.py": src });
    expect(result.exit).toBe(0);
    expect(trace!.codes).toEqual([{ name: "<module>", line: 1 }, { name: "evens", line: 1, untraced: true }]);
    const all = await chartFile("python", src);
    const evens = ok(all.charts.find((c) => c.name === "evens")!);
    expect(traceChart(evens, trace!, false)).toBeNull();
    expect(ranUntraced(evens, trace!, false)).toBe(true);
    const chart = ok(all.charts[0]);
    expect(traceChart(chart, trace!, true)!.counts[edge(chart, "for e in evens(6)", "Yes")]).toBe(3);
  }, 60_000);

  test("a long loop: the trace stops at TRACE_STEPS, and the rest runs at full speed", async () => {
    const src = "t = 0\nfor i in range(1000000):\n    t += i\nprint(t)\n";
    run({ "warm.py": src }, false); // warm the interpreter
    const off = run({ "long.py": src }, false);
    const on = run({ "long.py": src }, true);
    const offAgain = run({ "long.py": src }, false);
    const base = Math.min(off.ms, offAgain.ms);
    console.log(`1e6-iteration loop: untraced ${off.ms.toFixed(0)} / ${offAgain.ms.toFixed(0)} ms, traced ${on.ms.toFixed(0)} ms (+${(on.ms - base).toFixed(0)} ms)`);
    expect(on.trace!.partial).toBe(true);
    // Each event is a (call, line) pair: exactly TRACE_STEPS lines were kept.
    expect(on.trace!.events.length).toBe(2 * TRACE_STEPS);
    // The chart still shows the start of the run.
    const chart = await program(src);
    const m0 = performance.now();
    const t = traceChart(chart, on.trace!, true)!;
    const mapMs = performance.now() - m0;
    console.log(`mapping ${TRACE_STEPS} line events onto the chart: ${mapMs.toFixed(1)} ms`);
    expect(mapMs).toBeLessThan(500);
    expect(t.partial).toBe(true);
    expect(t.counts[edge(chart, "for i in range(1000000)", "Yes")]).toBeGreaterThan(20_000);
    // The cost is the capped part only: well under the time of the untraced run itself on any machine.
    expect(on.ms - base).toBeLessThan(Math.max(1500, base));
  }, 120_000);
});

/** The variables at the last step of the program's chart, as a plain object. */
async function lastVars(src: string, name: string) {
  const { result, trace } = run({ [name]: src });
  const chart = await program(src);
  const m = stepsFor(chart, trace, { program: true, lang: "python" });
  if (!m.ok) throw new Error(m.reason);
  return { result, trace: trace!, m, vars: Object.fromEntries(m.varsAt(m.total - 1)) };
}

const FORMATS = String.raw`import math

class Loud:
    def __repr__(self):
        print("repr called")
        raise RuntimeError("no")
    __str__ = __repr__

class Meta(type):
    @property
    def __name__(cls):
        print("name called")
        raise RuntimeError("meta")

class Odd(metaclass=Meta):
    pass

class N(int):
    def __repr__(self):
        print("repr called")
        return "N"

def f():
    return 1

big = 10 ** 500
small = -42
pi = 0.5
flag = True
nothing = None
text = "line\nbreak\t" + chr(0x202e) + "x" * 100
nums = list(range(100))
nested = [[1, [2, [3]]], (4,), {5}]
d = {"a": 1, 2: [3]}
t1 = (1,)
s0 = set()
fs = frozenset()
loud = Loud()
odd = Odd()
n = N(3)
inside = [Loud(), N(1)]
fn = f
mod = math
cls = Loud
_private = 1
globals()["not an identifier"] = 1
short = "hi"
del short
end = 1
`;

describe("variable values in Pyodide", () => {
  test("sum_evens: the real run's lines and values are the step model's fixture", async () => {
    const { result, trace, m } = await lastVars(SUM_EVENS, "sum_evens.py");
    expect(result.exit).toBe(0);
    const lines = [...trace.events].filter((_, i) => i % 2 === 1);
    expect(lines).toEqual([...SUM_EVENS_LINES, -1]);
    expect(m.total).toBe(20);
    expect(m.values).toBe("all");
    for (let k = 1; k < 20; k++) {
      const want: Record<string, string> = {};
      if (SUM_EVENS_TOTAL[k - 1] !== null) want.total = String(SUM_EVENS_TOTAL[k - 1]);
      if (SUM_EVENS_N[k - 1] !== null) want.n = String(SUM_EVENS_N[k - 1]);
      expect(Object.fromEntries(m.varsAt(k)), `step ${k}`).toEqual(want);
    }
    // Changes only: total and n change 9 times in all (n 6 times, total 4 times).
    expect(trace.values!.deltas.length / 3).toBe(10);
  }, 60_000);

  test("formats only built-in simple types itself; never runs the program's own code", async () => {
    printed = "";
    const { result, vars } = await lastVars(FORMATS, "formats.py");
    expect(result.exit).toBe(0);
    expect(printed).not.toContain("called");
    const ell = String.fromCodePoint(0x2026);
    expect(vars.big).toMatch(/^<int, about \d+ digits>$/);
    expect(vars).toMatchObject({ small: "-42", pi: "0.5", flag: "True", nothing: "None", t1: "(1,)", s0: "set()", fs: "frozenset()" });
    // The bidi override as Python's repr escapes it (backslash, "u202e"), built from code points.
    const rlo = String.fromCodePoint(92) + "u202e";
    expect(vars.text).toBe(String.raw`'line\nbreak\t` + rlo + "x".repeat(VALUE_TEXT - 21) + ell);
    expect(vars.text).toHaveLength(VALUE_TEXT);
    expect(vars.nums).toBe("[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, " + ell);
    expect(vars.nested).toBe(`[[1, [${ell}]], (4,), {5}]`);
    expect(vars.d).toBe("{'a': 1, 2: [3]}");
    expect(vars).toMatchObject({ loud: "<Loud>", odd: "<Odd>", n: "<N>", inside: "[<Loud>, <N>]", _private: "1", end: "1" });
    for (const gone of ["fn", "mod", "cls", "math", "f", "Loud", "not an identifier", "short", "__name__", "__file__"]) expect(vars, gone).not.toHaveProperty(gone);
    for (const text of Object.values(vars)) expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }, 60_000);

  test("a deleted variable goes away at the next step", async () => {
    const src = "a = 1\nb = 2\ndel a\nc = 3\n";
    const { m } = await lastVars(src, "del.py");
    expect(m.varsAt(3)).toEqual([["a", "1"], ["b", "2"]]);
    expect(m.varsAt(4)).toEqual([["b", "2"]]);
    expect(m.varsAt(m.total - 1)).toEqual([["b", "2"], ["c", "3"]]);
  }, 60_000);

  test("a function's call shows its own locals, each call apart", async () => {
    const src = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n\nx = fact(3)\n";
    const { trace } = run({ "fact.py": src });
    const fact = ok((await chartFile("python", src)).charts[1]);
    const m = stepsFor(fact, trace, { program: false, lang: "python" });
    if (!m.ok) throw new Error(m.reason);
    const ns = Array.from({ length: m.total - 1 }, (_, i) => Object.fromEntries(m.varsAt(i + 1)).n);
    expect(ns).toEqual(["3", "3", "2", "2", "1", "1", "1", "2", "3"]);
  }, 60_000);

  test("the size budget stops the values, not the run or its line trace", async () => {
    py.runPython("VALUE_BUDGET = 3000");
    try {
      const src = "s = ''\nfor i in range(500):\n    s = str(i) * 3\nprint(len(s))\n";
      const { result, trace } = run({ "budget.py": src });
      expect(result.exit).toBe(0);
      expect(trace!.partial).toBe(false);
      const v = trace!.values!;
      expect(v.cut).not.toBeNull();
      expect(v.cut!).toBeGreaterThan(10);
      for (let i = 0; i < v.deltas.length; i += 3) expect(v.deltas[i]).toBeLessThan(v.cut!);
      const size = v.texts.reduce((n, t) => n + t.length + 8, 0) + v.names.reduce((n, t) => n + t.length + 8, 0) + 4 * v.deltas.length;
      expect(size).toBeLessThanOrEqual(3000);
    } finally {
      py.runPython("VALUE_BUDGET = 2000000");
    }
  }, 60_000);

  test("an error inside the value recording stops the values, never the program", async () => {
    // During the run (containers are written out as the event fires) and after it (numbers).
    for (const [type, value] of [["list", "[2]"], ["float", "2.5"]]) {
      py.runPython(`_saved = _VFMT[id(${type})]\n_VFMT[id(${type})] = lambda v, depth: 1 / 0`);
      try {
        printed = "";
        const { result, trace } = run({ "boom.py": `a = 'x'\nb = ${value}\nprint('done', b)\n` });
        expect(result.exit, type).toBe(0);
        expect(printed).toContain(`done ${value}`);
        expect(trace!.partial).toBe(false);
        expect(trace!.values!.cut, type).toBe(2); // the event where b's value would have been read
        expect(trace!.values!.texts).toEqual(["'x'"]);
      } finally {
        py.runPython(`_VFMT[id(${type})] = _saved`);
      }
    }
  }, 60_000);

  test.each([
    // 1 + 2 * 24998 + 2 lines and the return: 50,000 events, just under TRACE_STEPS; values for the first VALUE_STEPS.
    [24998, 50_000],
    // 10,000 events: values for every one.
    [4998, 10_000],
  ])("cost: a loop of range(%i) with and without values (times printed)", async (range, events) => {
    const src = `t = 0\nfor i in range(${range}):\n    t += i\nprint(t)\n`;
    const times = { off: [] as number[], lines: [] as number[], values: [] as number[], linesAfter: [] as number[], valuesAfter: [] as number[] };
    run({ "warm.py": src }, true);
    for (let r = 0; r < 7; r++) {
      times.off.push(run({ "cost.py": src }, false).ms);
      py.runPython("TRACE_VALUES = False");
      const l = run({ "cost.py": src }, true);
      times.lines.push(l.ms);
      times.linesAfter.push(l.traceMs);
      py.runPython("TRACE_VALUES = True");
      const v = run({ "cost.py": src }, true);
      times.values.push(v.ms);
      times.valuesAfter.push(v.traceMs);
    }
    const { trace } = run({ "cost.py": src }, true);
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const [off, lines, values] = [median(times.off), median(times.lines), median(times.values)];
    const [linesAfter, valuesAfter] = [median(times.linesAfter), median(times.valuesAfter)];
    const v = trace!.values!;
    const bytes = v.texts.reduce((n, t) => n + t.length, 0) + v.names.reduce((n, t) => n + t.length, 0) + 4 * v.deltas.length;
    console.log(
      `${events}-event loop (median of 7): untraced ${off.toFixed(0)} ms, lines only ${lines.toFixed(0)} + ${linesAfter.toFixed(0)} ms, ` +
        `lines + values ${values.toFixed(0)} + ${valuesAfter.toFixed(0)} ms (run + trace read); run +${(((values - lines) / lines) * 100).toFixed(0)}%, ` +
        `run and read +${(((values + valuesAfter - lines - linesAfter) / (lines + linesAfter)) * 100).toFixed(0)}% over lines only; ` +
        `events ${trace!.events.length / 2}, deltas ${v.deltas.length / 3}, texts ${v.texts.length}, values ~${(bytes / 1024).toFixed(0)} KB`,
    );
    expect(trace!.events.length / 2).toBe(events);
    expect(trace!.partial).toBe(false);
    expect(v.cut).toBe(events > VALUE_STEPS ? VALUE_STEPS : null);
    // About 3 us an event with values, on top of the line trace: at most VALUE_STEPS of them.
    expect(values - lines).toBeLessThan(Math.max(250, lines));
  }, 120_000);
});
