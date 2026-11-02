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
import { ranUntraced, traceChart } from "../flowchart/trace";
import { RUNNER_PY } from "./python-helper";
import { TRACE_STEPS, traceFromPython } from "./run-trace";

const test = withPack ? it : it.skip;

let py: PyodideAPI;
let stdin = new Uint8Array();

beforeAll(async () => {
  py = await loadPyodide({ indexURL: join(process.cwd(), "node_modules", "pyodide") + "/" });
  py.setStdout({ batched: () => {} });
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
  return { result, trace, ms };
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
