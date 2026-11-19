/// <reference types="node" />
// The step-through model (steps.ts): a traced run of one chart's code as numbered steps, with the
// box and connector of each step, the counts so far and the variables at that step, for any step
// in any order. The charts are the real ones for each program (the flowchart engine).
import { describe, expect, it } from "vitest";
import type { RunTrace } from "../core/types";
import type { FlowChart } from "./model";
import { chartFile, ok, withPack } from "./fixtures/harness";
import { encodeValues, moduleTrace, SUM_EVENS, SUM_EVENS_N, SUM_EVENS_TOTAL, sumEvensTrace } from "./fixtures/trace-runs";
import { NO_STEPS_WORDS, stepsFor, type StepModel } from "./steps";
import { traceChart } from "./trace";

const test = withPack ? it : it.skip;

async function charts(source: string) {
  return (await chartFile("python", source)).charts.map(ok);
}

const node = (chart: FlowChart, text: string) => chart.nodes.find((n) => n.text.startsWith(text))!.id;

function model(chart: FlowChart, trace: RunTrace | undefined, program = true): StepModel {
  const m = stepsFor(chart, trace, { program, lang: "python" });
  if (!m.ok) throw new Error(`no steps: ${m.reason}`);
  return m;
}

const vars = (m: StepModel, k: number) => Object.fromEntries(m.varsAt(k));

describe("step model's memory (audit run-4, lead 1)", () => {
  // A trace with a new line on every step (a forged one: a program can rewrite the recorder's
  // buffers) once made the model keep a copy of every line's count every 128 steps: steps x lines.
  // The line counts must cost memory in the steps alone.
  test("60,000 steps on 60,000 distinct lines keep a few MB, not steps x lines", async () => {
    const [chart] = await charts("x = 1\n");
    const lines = Array.from({ length: 60_000 }, (_, i) => i + 1);
    const before = process.memoryUsage().arrayBuffers;
    const m = model(chart, moduleTrace(lines));
    const kept = process.memoryUsage().arrayBuffers - before;
    expect(kept, `typed arrays kept: ${Math.round(kept / 2 ** 20)} MB`).toBeLessThan(64 * 2 ** 20);
    // Still right: at the last step every line has run once; halfway, the first half has.
    expect(m.lineCountsAt(m.total - 1).size).toBe(60_000);
    expect(m.lineCountsAt(30_000).get(30_000)).toBe(1);
    expect(m.lineCountsAt(30_000).has(30_001)).toBe(false);
  }, 60_000);
});

describe("step model", () => {
  test("sum_evens: 20 steps from Start to End, with counts and variables at each", async () => {
    const [chart] = await charts(SUM_EVENS);
    const m = model(chart, sumEvensTrace());
    expect(m.total).toBe(20);
    expect(m.partial).toBe(false);
    expect(m.values).toBe("all");
    const start = m.step(0);
    expect(start).toMatchObject({ k: 0, kind: "start", line: null, node: chart.start, edge: null });
    expect([...m.nodeCountsAt(0)].every((n) => n === 0)).toBe(true);
    expect(m.lineCountsAt(0).size).toBe(0);
    expect(m.varsAt(0)).toEqual([]);
    // Step 1 runs line 1: Start -> total = 0.
    expect(m.step(1)).toMatchObject({ kind: "line", line: 1, node: node(chart, "total = 0") });
    expect(chart.edges[m.step(1).edge!].from).toBe(chart.start);
    const last = m.step(19);
    expect(last.kind).toBe("return");
    expect(chart.nodes[last.node].text).toBe("End");
    const end = m.nodeCountsAt(19);
    const want = { start: 1, init: 1, loop: 7, test: 6, add: 3, out: 1, end: 1 };
    const got = {
      start: end[chart.start],
      init: end[node(chart, "total = 0")],
      loop: end[node(chart, "for n in range(1, 7)")],
      test: end[node(chart, "n % 2 == 0")],
      add: end[node(chart, "total += n")],
      out: end[node(chart, "print(total)")],
      end: end[last.node],
    };
    expect(got).toEqual(want);
    expect([...m.lineCountsAt(19)].sort((a, b) => a[0] - b[0])).toEqual([[1, 1], [2, 7], [3, 6], [4, 3], [5, 1]]);
    // The variables at every step: before the step's line runs (the return's: the final ones).
    for (let k = 1; k < 20; k++) {
      const want: Record<string, string> = {};
      if (SUM_EVENS_TOTAL[k - 1] !== null) want.total = String(SUM_EVENS_TOTAL[k - 1]);
      if (SUM_EVENS_N[k - 1] !== null) want.n = String(SUM_EVENS_N[k - 1]);
      expect(vars(m, k), `step ${k}`).toEqual(want);
    }
    // In the order they were first set.
    expect(m.varsAt(19)).toEqual([["total", "12"], ["n", "6"]]);
    // The step counts agree with the chart's own counts (the same mapping).
    const ct = traceChart(chart, sumEvensTrace(), true)!;
    const edgeTotals = new Array(chart.edges.length).fill(0);
    for (let k = 1; k < m.total; k++) for (const e of m.step(k).edges) edgeTotals[e]++;
    expect(edgeTotals).toEqual(ct.counts);
  });

  test("random access matches a replay from the start on a long loop", async () => {
    const n = 3000;
    const [chart] = await charts(`t = 0\nfor i in range(${n}):\n    t += i\n    del_me = i % 7\nprint(t)\n`);
    const lines = [1];
    const states: [string, string][][] = [[]];
    let t = 0;
    for (let i = 0; i < n; i++) {
      states.push([["t", String(t)], ...(i ? ([["i", String(i - 1)], ["del_me", String((i - 1) % 7)]] as [string, string][]) : [])]);
      lines.push(2);
      states.push([["t", String(t)], ["i", String(i)], ...(i ? ([["del_me", String((i - 1) % 7)]] as [string, string][]) : [])]);
      lines.push(3);
      t += i;
      // del_me goes away now and then (a del, or a name that became a function).
      states.push([["t", String(t)], ["i", String(i)], ...(i % 5 ? ([["del_me", String(i % 7)]] as [string, string][]) : [])]);
      lines.push(4);
    }
    lines.push(2, 5);
    states.push([["t", String(t)], ["i", String(n - 1)]], [["t", String(t)], ["i", String(n - 1)]], [["t", String(t)], ["i", String(n - 1)]]);
    const base = moduleTrace(lines);
    const trace = { ...base, values: encodeValues(base.events, states) };
    const m = model(chart, trace);
    expect(m.total).toBe(lines.length + 2);
    // A replay from step 0, in order: the expected answers for every step.
    const counts = new Array(chart.nodes.length).fill(0);
    const lineCounts = new Map<number, number>();
    const expected: { counts: number[]; lines: [number, number][]; vars: [string, string][] }[] = [];
    for (let k = 0; k < m.total; k++) {
      const s = m.step(k);
      if (k === 1) counts[chart.start]++;
      for (const e of s.edges) counts[chart.edges[e].to]++;
      if (s.kind === "line") lineCounts.set(s.line!, (lineCounts.get(s.line!) ?? 0) + 1);
      expected.push({ counts: [...counts], lines: [...lineCounts].sort((a, b) => a[0] - b[0]), vars: k === 0 ? [] : [...states[k - 1]].sort() });
    }
    // Then any step, in a shuffled order.
    const order = Array.from({ length: m.total }, (_, k) => k).sort((a, b) => ((a * 7919) % 104_729) - ((b * 7919) % 104_729));
    const t0 = performance.now();
    for (const k of order) {
      expect([...m.nodeCountsAt(k)], `counts at ${k}`).toEqual(expected[k].counts);
      expect([...m.lineCountsAt(k)].sort((a, b) => a[0] - b[0]), `lines at ${k}`).toEqual(expected[k].lines);
      expect([...m.varsAt(k)].sort(), `vars at ${k}`).toEqual(expected[k].vars);
    }
    console.log(`${m.total} steps, each read in a shuffled order: ${(performance.now() - t0).toFixed(0)} ms`);
  });

  test("a function picked in the chart's picker: its calls only, recursion included", async () => {
    const src = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n\nprint(fact(3))\n";
    const [, fact] = await charts(src);
    const base: RunTrace = {
      codes: [{ name: "<module>", line: 1 }, { name: "fact", line: 1 }],
      calls: Int32Array.from([0, 1, 1, 1]),
      events: Int32Array.from([0, 1, 0, 6, 1, 2, 1, 4, 2, 2, 2, 4, 3, 2, 3, 3, 3, -1, 2, -1, 1, -1, 0, -1]),
      partial: false,
    };
    const n = (v: number): [string, string][] => [["n", String(v)]];
    const trace = { ...base, values: encodeValues(base.events, [[], [], n(3), n(3), n(2), n(2), n(1), n(1), n(1), n(2), n(3), []]) };
    const m = model(fact, trace, false);
    // Start, then the 9 events of the three calls (the top level's are not this chart's).
    expect(m.total).toBe(10);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => m.step(k).call)).toEqual([1, 1, 2, 2, 3, 3, 3, 2, 1]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => m.varsAt(k)[0][1])).toEqual(["3", "3", "2", "2", "1", "1", "1", "2", "3"]);
    expect(m.step(6)).toMatchObject({ kind: "line", line: 3, node: node(fact, "return 1") });
    // The innermost call returns first, at its return box (a return statement is an end of its own).
    expect(m.step(7)).toMatchObject({ kind: "return", line: null, call: 3, node: node(fact, "return 1") });
    expect(m.step(9)).toMatchObject({ kind: "return", call: 1, node: node(fact, "return n * fact") });
    const end = m.nodeCountsAt(9);
    expect(end[fact.start]).toBe(3);
    expect(end[node(fact, "n <= 1")]).toBe(3);
    expect(end[node(fact, "return 1")]).toBe(1);
    expect(end[node(fact, "return n * fact")]).toBe(2);
    // Each call starts at Start: the second call's first step comes from Start again.
    expect(fact.edges[m.step(3).edges[0]].from).toBe(fact.start);
  });

  test("an exception mid-run: the last step stays where it raised", async () => {
    const [chart] = await charts("x = 1\nprint(x)\n");
    const base = moduleTrace([1, 2], -2);
    const m = model(chart, { ...base, values: encodeValues(base.events, [[], [["x", "1"]], [["x", "1"]]]) });
    expect(m.total).toBe(4);
    expect(m.step(3)).toMatchObject({ kind: "raise", line: 2, node: node(chart, "print(x)"), edge: null, edges: [] });
    expect(m.nodeCountsAt(3)[chart.nodes.find((n) => n.text === "End")!.id]).toBe(0);
    expect(m.varsAt(3)).toEqual([["x", "1"]]);
  });

  test("a trace cut at its step limit: the last step is the last line recorded", async () => {
    const [chart] = await charts("x = 1\nprint(x)\n");
    const m = model(chart, moduleTrace([1, 2], null, true));
    expect(m.total).toBe(3);
    expect(m.partial).toBe(true);
    expect(m.step(2)).toMatchObject({ kind: "line", line: 2 });
    // No values in this trace: the steps are still there, with no variables.
    expect(m.values).toBe("none");
    expect(m.varsAt(2)).toEqual([]);
    expect(m.valuesKnownAt(2)).toBe(false);
  });

  test("values cut by the size budget: known before the cut, not after", async () => {
    const [chart] = await charts(SUM_EVENS);
    const trace = sumEvensTrace();
    const values = trace.values!;
    // Keep the deltas of the first 5 events only, as the helper does when the budget runs out.
    const keep: number[] = [];
    for (let i = 0; i < values.deltas.length; i += 3) if (values.deltas[i] < 5) keep.push(...values.deltas.subarray(i, i + 3));
    const m = model(chart, { ...trace, values: { ...values, deltas: Int32Array.from(keep), cut: 5 } });
    expect(m.values).toBe("cut");
    expect(m.valuesKnownAt(5)).toBe(true); // event 4
    expect(m.valuesKnownAt(6)).toBe(false); // event 5: the cut
    expect(vars(m, 5)).toEqual({ total: "0", n: "2" });
  });

  test("no step-through: another language, no run, a function not called, a generator", async () => {
    const [program, g] = await charts("def g():\n    yield 1\nprint(2)\n");
    expect(stepsFor(program, moduleTrace([3]), { program: true, lang: "c" })).toEqual({ ok: false, reason: "language" });
    expect(stepsFor(program, moduleTrace([3]), { program: true, lang: "cpp" })).toEqual({ ok: false, reason: "language" });
    expect(stepsFor(program, undefined, { program: true, lang: "python" })).toEqual({ ok: false, reason: "no-run" });
    expect(stepsFor(g, moduleTrace([3]), { program: false, lang: "python" })).toEqual({ ok: false, reason: "not-called" });
    const gen = { ...moduleTrace([3]), codes: [{ name: "<module>", line: 1 }, { name: "g", line: 1, untraced: true }] };
    expect(stepsFor(g, gen, { program: false, lang: "python" })).toEqual({ ok: false, reason: "untraced" });
    expect(NO_STEPS_WORDS.language).toBe("Step-through is for Python for now.");
    for (const words of Object.values(NO_STEPS_WORDS)) expect(words).toMatch(/^[A-Z][\x20-\x7e]+\.$/);
  });

  test("connector counts at any step: the steps' own connectors so far, the chart's counts at the end", async () => {
    const [chart] = await charts(SUM_EVENS);
    const m = model(chart, sumEvensTrace());
    const ct = traceChart(chart, sumEvensTrace(), true)!;
    const so = new Array(chart.edges.length).fill(0);
    expect([...m.edgeCountsAt(0)]).toEqual(so);
    for (let k = 1; k < m.total; k++) {
      for (const e of m.step(k).edges) so[e]++;
      expect([...m.edgeCountsAt(k)], `step ${k}`).toEqual(so);
    }
    expect([...m.edgeCountsAt(m.total - 1)]).toEqual(ct.counts);
    // A fresh copy each time, clamped like the others.
    const a = m.edgeCountsAt(99);
    a[0] = 1234;
    expect(m.edgeCountsAt(99)[0]).not.toBe(1234);
    expect([...m.edgeCountsAt(-3)]).toEqual(new Array(chart.edges.length).fill(0));
  });

  test("connector counts at any step on a long run match a replay (checkpoints)", async () => {
    const [chart] = await charts("t = 0\nfor i in range(400):\n    t += i\nprint(t)\n");
    const lines = [1];
    for (let i = 0; i < 400; i++) lines.push(2, 3);
    lines.push(2, 4);
    const m = model(chart, moduleTrace(lines));
    const so = new Array(chart.edges.length).fill(0);
    for (let k = 1; k < m.total; k++) {
      for (const e of m.step(k).edges) so[e]++;
      if (k % 37 === 0 || k === m.total - 1) expect([...m.edgeCountsAt(k)], `step ${k}`).toEqual(so);
    }
  });

  test("out-of-range step numbers are clamped, never thrown", async () => {
    const [chart] = await charts(SUM_EVENS);
    const m = model(chart, sumEvensTrace());
    expect(m.step(-5).k).toBe(0);
    expect(m.step(999).k).toBe(19);
    expect(m.step(2.7).k).toBe(2);
    expect(m.varsAt(Number.NaN)).toEqual([]);
  });
});
