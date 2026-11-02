/// <reference types="node" />
// The run trace on a chart (trace.ts): line events, as CPython 3.14's sys.settrace reports them
// (each sequence below was recorded from a real run of the program, .claude/verify/ft/probe_*.py),
// mapped onto the real chart of that program: how many times each connector was followed.
import { describe, expect, it } from "vitest";
import type { RunTrace } from "../core/types";
import type { FlowChart } from "./model";
import { chartFile, ok, withPack } from "./fixtures/harness";
import { MARKS, MARKS_LINES, moduleTrace } from "./fixtures/trace-runs";
import { chipText, codesFor, ranUntraced, stepTraceWords, traceChart, traceSummary, traceWidth, type ChartTrace } from "./trace";

const test = withPack ? it : it.skip;

async function charts(source: string) {
  return (await chartFile("python", source)).charts.map(ok);
}

/** "from->to label: count" for every edge the run followed, in the chart's edge order. */
function followed(chart: FlowChart, t: ChartTrace): string[] {
  return chart.edges.flatMap((e, i) => (t.counts[i] ? [`${e.from}->${e.to}${e.label ? ` ${e.label}` : ""}${e.kind === "flow" ? "" : ` (${e.kind})`}: ${t.counts[i]}`] : []));
}

/** The count on the edge leaving the box whose text starts with `from`, with that label (or the only one). */
function count(chart: FlowChart, t: ChartTrace, from: string, label?: string, kind?: string): number {
  const id = chart.nodes.find((n) => n.text.startsWith(from))!.id;
  const i = chart.edges.findIndex((e) => e.from === id && (label === undefined || e.label === label) && (kind === undefined || e.kind === kind));
  expect(i, `edge from ${from} ${label ?? ""}`).toBeGreaterThanOrEqual(0);
  return t.counts[i];
}

describe("run trace mapping", () => {
  test("the Flow Board example: the loop 5 times, Yes 2 No 3 at marks[i] > best", async () => {
    const [chart] = await charts(MARKS);
    const t = traceChart(chart, moduleTrace(MARKS_LINES), true)!;
    expect(t.calls).toBe(1);
    expect(t.unsure).toEqual([]);
    expect(count(chart, t, "i < n", "Yes")).toBe(5);
    expect(count(chart, t, "i < n", "No")).toBe(1);
    expect(count(chart, t, "marks[i] > best", "Yes")).toBe(2);
    expect(count(chart, t, "marks[i] > best", "No")).toBe(3);
    expect(count(chart, t, "i += 1", undefined, "back")).toBe(5);
    expect(count(chart, t, "best = marks[i]")).toBe(2);
    // Into and out of the program once.
    expect(t.counts[chart.edges.findIndex((e) => e.from === chart.start)]).toBe(1);
    expect(count(chart, t, "print('Best:'")).toBe(1);
    // The first connector drawn is Start's; the loop's Yes comes before its No.
    const yes = chart.edges.findIndex((e) => e.label === "Yes" && chart.nodes[e.from].text.startsWith("i < n"));
    const no = chart.edges.findIndex((e) => e.label === "No" && chart.nodes[e.from].text.startsWith("i < n"));
    expect(t.order[chart.edges.findIndex((e) => e.from === chart.start)]).toBe(0);
    expect(t.order[yes]).toBeLessThan(t.order[no]);
    expect(traceSummary(chart, t, true, 50_000)).toBe("Path of the last run: the loop i < n ran 5 times; marks[i] > best was Yes 2 times, No 3 times.");
  });

  test("a while loop: in, three times round, out", async () => {
    const [chart] = await charts("i = 0\nwhile i < 3:\n    i += 1\nprint(i)\n");
    const t = traceChart(chart, moduleTrace([1, 2, 3, 2, 3, 2, 3, 2, 4]), true)!;
    expect(followed(chart, t)).toEqual(["0->1: 1", "1->2: 1", "2->3 Yes: 3", "3->2 (back): 3", "2->4 No: 1", "4->5: 1"]);
  });

  test("a loop written on one line: each jump back to the line is once round", async () => {
    const [chart] = await charts("t = 0\nfor x in range(3): t += x\nprint(t)\n");
    const t = traceChart(chart, moduleTrace([1, 2, 2, 2, 2, 3]), true)!;
    expect(count(chart, t, "for x in range(3)", "Yes")).toBe(3);
    expect(count(chart, t, "t += x", undefined, "back")).toBe(3);
    expect(count(chart, t, "for x in range(3)", "No")).toBe(1);
    expect(t.unsure).toEqual([]);
  });

  test("an if written on one line can't tell Yes from No: unsure, and neither way is counted", async () => {
    const [chart] = await charts("a = 1\nif a: b = 1\nprint(a)\n");
    const t = traceChart(chart, moduleTrace([1, 2, 3]), true)!;
    const cond = chart.nodes.find((n) => n.kind === "decision")!.id;
    expect(t.unsure).toEqual([cond]);
    expect(count(chart, t, "a ?", "Yes")).toBe(0);
    expect(count(chart, t, "a ?", "No")).toBe(0);
    // What both ways share is still counted: into the decision, and print to End.
    expect(count(chart, t, "a = 1")).toBe(1);
    expect(count(chart, t, "print(a)")).toBe(1);
    expect(traceSummary(chart, t, true, 50_000)).toBe("Path of the last run: a: not known, its code shares a line.");
    expect(stepTraceWords(chart, t, cond)).toBe(" Last run: not known, its code shares a line.");
  });

  test("if / elif / else: only the way taken", async () => {
    const [chart] = await charts("a = 2\nif a == 1:\n    print(1)\nelif a == 2:\n    print(2)\nelse:\n    print(3)\nprint('end')\n");
    const t = traceChart(chart, moduleTrace([1, 2, 4, 5, 8]), true)!;
    expect(count(chart, t, "a == 1", "No")).toBe(1);
    expect(count(chart, t, "a == 1", "Yes")).toBe(0);
    expect(count(chart, t, "a == 2", "Yes")).toBe(1);
    expect(count(chart, t, "a == 2", "No")).toBe(0);
    expect(count(chart, t, "print(2)")).toBe(1);
    expect(count(chart, t, "print(1)")).toBe(0);
  });

  test("nested ifs in a loop", async () => {
    const src = "for i in range(4):\n    if i > 0:\n        if i % 2 == 0:\n            print('even', i)\n        else:\n            print('odd', i)\n    print('next')\n";
    const [chart] = await charts(src);
    const lines = [1, 2, 7, 1, 2, 3, 6, 7, 1, 2, 3, 4, 7, 1, 2, 3, 6, 7, 1];
    const t = traceChart(chart, moduleTrace(lines), true)!;
    expect(count(chart, t, "for i in range(4)", "Yes")).toBe(4);
    expect(count(chart, t, "for i in range(4)", "No")).toBe(1);
    expect(count(chart, t, "i > 0", "Yes")).toBe(3);
    expect(count(chart, t, "i > 0", "No")).toBe(1);
    expect(count(chart, t, "i % 2 == 0", "Yes")).toBe(1);
    expect(count(chart, t, "i % 2 == 0", "No")).toBe(2);
    expect(count(chart, t, "print('next')", undefined, "back")).toBe(4);
  });

  test("continue: the jump back to the loop is counted on its own connector", async () => {
    const src = "for i in range(4):\n    if i % 2:\n        continue\n    print(i)\nelse:\n    print('done')\n";
    const [chart] = await charts(src);
    const t = traceChart(chart, moduleTrace([1, 2, 4, 1, 2, 3, 1, 2, 4, 1, 2, 3, 1, 6]), true)!;
    expect(count(chart, t, "for i in range(4)", "Yes")).toBe(4);
    expect(count(chart, t, "i % 2", "Yes", "jump")).toBe(2);
    expect(count(chart, t, "i % 2", "No")).toBe(2);
    expect(count(chart, t, "print(i)", undefined, "back")).toBe(2);
    // The for's else runs when the loop ends without a break.
    expect(count(chart, t, "for i in range(4)", "No")).toBe(1);
    expect(count(chart, t, "print('done')")).toBe(1);
  });

  test("while / else with break: the else is skipped", async () => {
    const src = "n = 0\nwhile n < 5:\n    n += 1\n    if n == 3:\n        break\nelse:\n    print('no break')\nprint(n)\n";
    const [chart] = await charts(src);
    const t = traceChart(chart, moduleTrace([1, 2, 3, 4, 2, 3, 4, 2, 3, 4, 5, 8]), true)!;
    expect(count(chart, t, "n < 5", "Yes")).toBe(3);
    expect(count(chart, t, "n < 5", "No")).toBe(0);
    expect(count(chart, t, "n == 3", "No", "back")).toBe(2);
    expect(count(chart, t, "n == 3", "Yes", "jump")).toBe(1);
    expect(count(chart, t, "print('no break')")).toBe(0);
    expect(count(chart, t, "print(n)")).toBe(1);
  });

  test("while / else without break: the else runs", async () => {
    const [chart] = await charts("n = 0\nwhile n < 2:\n    n += 1\nelse:\n    print('done')\nprint(n)\n");
    const t = traceChart(chart, moduleTrace([1, 2, 3, 2, 3, 2, 5, 6]), true)!;
    expect(count(chart, t, "n < 2", "Yes")).toBe(2);
    expect(count(chart, t, "n < 2", "No")).toBe(1);
    expect(count(chart, t, "print('done')")).toBe(1);
  });

  test("a function's chart sums its calls; the top level's call boxes run once each", async () => {
    const src = "def f(n):\n    if n > 1:\n        return n\n    print(n)\nf(1)\nf(5)\n";
    const [program, f] = await charts(src);
    // Recorded (probe_events.py "func"): the top level is call 0; f is called twice (calls 1 and 2).
    const trace: RunTrace = {
      codes: [{ name: "<module>", line: 1 }, { name: "f", line: 1 }],
      calls: Int32Array.from([0, 1, 1]),
      events: Int32Array.from([0, 1, 0, 5, 1, 2, 1, 4, 1, -1, 0, 6, 2, 2, 2, 3, 2, -1, 0, -1]),
      partial: false,
    };
    const tf = traceChart(f, trace, false)!;
    expect(tf.calls).toBe(2);
    expect(count(f, tf, "n > 1", "Yes")).toBe(1);
    expect(count(f, tf, "n > 1", "No")).toBe(1);
    expect(count(f, tf, "print(n)")).toBe(1); // print(n) on to End, once
    expect(tf.counts[f.edges.findIndex((e) => e.from === f.start)]).toBe(2);
    expect(traceSummary(f, tf, false, 50_000)).toBe("Path of the last run: f ran 2 times; n > 1 was Yes 1 time, No 1 time.");
    const tp = traceChart(program, trace, true)!;
    expect(followed(program, tp)).toEqual(["0->1: 1", "1->2: 1", "2->3: 1"]);
  });

  test("an exception ends the call where it is: no connector to End", async () => {
    const [chart] = await charts("x = 1\nprint(x)\n");
    const t = traceChart(chart, moduleTrace([1, 2], -2), true)!;
    expect(followed(chart, t)).toEqual(["0->1: 1", "1->2: 1"]);
    expect(followed(chart, traceChart(chart, moduleTrace([1, 2]), true)!)).toEqual(["0->1: 1", "1->2: 1", "2->3: 1"]);
    // A trace cut short (no return at all) stops at the last line too, and says it is partial.
    const cut = traceChart(chart, moduleTrace([1, 2], null, true), true)!;
    expect(followed(chart, cut)).toEqual(["0->1: 1", "1->2: 1"]);
    expect(cut.partial).toBe(true);
    expect(traceSummary(chart, cut, true, 50_000)).toBe("Path of the last run: straight through, no decisions. Only the first 50,000 steps were counted.");
  });

  test("a function that didn't run, and another file's trace", async () => {
    const [, g] = await charts("def g():\n    return 1\nprint(2)\n");
    const trace = moduleTrace([3]);
    expect(traceChart(g, trace, false)).toBeNull();
    expect(codesFor(g, { ...trace, codes: [{ name: "g", line: 9 }] }, false)).toEqual(new Set([0])); // by name when the line moved
    expect(ranUntraced(g, trace, false)).toBe(false);
    // A generator: it ran, but has no lines to count, so no trace (and the view says why).
    const gen = { ...trace, codes: [{ name: "<module>", line: 1 }, { name: "g", line: 1, untraced: true }] };
    expect(codesFor(g, gen, false).size).toBe(0);
    expect(traceChart(g, gen, false)).toBeNull();
    expect(ranUntraced(g, gen, false)).toBe(true);
  });

  test("damaged traces count less, never throw", async () => {
    const [chart] = await charts("i = 0\nwhile i < 3:\n    i += 1\nprint(i)\n");
    const junk: RunTrace = {
      codes: [{ name: "<module>", line: 1 }],
      calls: Int32Array.from([0]),
      events: Int32Array.from([7, 1, -3, 2, 0, 99999, 0, -7, 0, 2, 0, 2147483647, 0, 3]),
      partial: false,
    };
    const t = traceChart(chart, junk, true)!;
    expect(t.counts.length).toBe(chart.edges.length);
    expect(t.counts.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
});

describe("run trace drawing words", () => {
  it("connector width by passes: 1.5, 2.5, 3, 4 px for 1, 2, 3, 5 or more", () => {
    expect([1, 2, 3, 4, 5, 50].map(traceWidth)).toEqual([1.5, 2.5, 3, 3.5, 4, 4]);
    expect(chipText(5)).toBe("5x");
  });
});
