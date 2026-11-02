// The run trace on a chart (feature F1, Flow Board's signature): how many times the last run went
// along each connector. The Python runner records line events (core/types.ts RunTrace); this maps
// them onto one chart, in the page, so any function picked later can show its part of the run.
//
// Each call of the chart's code is replayed on its own. A line event names the line the run moved
// to, so it is one of the chart's boxes (the first box on that line: the leftmost statement runs
// first); the connectors between the box before and that box are the path the run took. Boxes the
// run passes without a line event of their own are those sharing a line with the box before or the
// one after (`if x: y = 1`, `for i in r: total += i`), so a step may pass through them. A line event
// for the same line twice in a row is a jump back to it (a loop written on one line). When two
// different paths fit the same events (`if x: y = 1` on one line goes on to the next line Yes or
// No), only the connectors both paths share are counted, and the decision is "unsure": the chart
// never shows a way the run didn't take. Lines in no box (a `pass`, a docstring, a condition's
// second line) are skipped. Every number from the trace is checked, so a damaged trace counts less,
// never wrongly sized arrays.
import type { RunTrace } from "../core/types";
import type { FlowChart, FlowEdge, Step } from "./model";

export interface ChartTrace {
  /** Times the run went along each of chart.edges (by index). */
  counts: number[];
  /** When each edge was first followed (0 first), -1 when never: the order the trace draws in. */
  order: number[];
  /** Decisions whose way the line events can't tell (code sharing a line with its condition). */
  unsure: number[];
  /** Calls of the chart's code in the trace (the top level: 1); 0 when it didn't run. */
  calls: number;
  /** The trace stopped early (TRACE_STEPS lines), so the counts cover the start of the run only. */
  partial: boolean;
}

/** Ways a step may take at most before it counts as unsure, and their length (boxes passed). */
const MAX_PATHS = 8;
const MAX_DEPTH = 12;
/** Lines are numbered below this (about two million): larger numbers in a trace are no line of the chart. */
const LINES = 2 ** 21;

/** The code objects in the trace that are this chart's code (traced or not): the top level, or the function by name and first line. */
function matching(chart: Pick<FlowChart, "name" | "from">, trace: RunTrace, program: boolean): number[] {
  const found: number[] = [];
  trace.codes.forEach((c, i) => {
    if (program ? c.name === "<module>" : c.name === chart.name && c.line === chart.from) found.push(i);
  });
  // A decorator line or a moved function: the name alone, when no code matched by line.
  if (!program && !found.length) trace.codes.forEach((c, i) => c.name === chart.name && found.push(i));
  return found;
}

/** The traced code objects in the trace that are this chart's code. */
export function codesFor(chart: Pick<FlowChart, "name" | "from">, trace: RunTrace, program: boolean): Set<number> {
  return new Set(matching(chart, trace, program).filter((i) => !trace.codes[i].untraced));
}

/** The chart's code ran but its lines weren't recorded (a generator or coroutine). */
export function ranUntraced(chart: Pick<FlowChart, "name" | "from">, trace: RunTrace, program: boolean): boolean {
  return matching(chart, trace, program).some((i) => trace.codes[i].untraced === true);
}

/** The synthetic End box finish() adds (not a return statement's end box). */
function closingEnd(chart: FlowChart): number | null {
  for (let i = chart.nodes.length - 1; i >= 0; i--) {
    const n = chart.nodes[i];
    if (n.kind === "end" && n.text === "End" && n.parts.length === 1 && n.parts[0].text === "End") return n.id;
  }
  return null;
}

interface Step0 {
  /** Edge indexes counted. */
  edges: number[];
  /** Decisions passed in more than one way. */
  unsure: number[];
}

/**
 * The chart's run trace, or null when the chart's code isn't in the trace at all (another file's
 * trace, or a chart that has none). `program`: the chart is a Python file's top level.
 */
export function traceChart(chart: FlowChart, trace: RunTrace, program: boolean): ChartTrace | null {
  const codes = codesFor(chart, trace, program);
  if (!codes.size) return null;
  const counts = new Array<number>(chart.edges.length).fill(0);
  const order = new Array<number>(chart.edges.length).fill(-1);
  const unsure = new Set<number>();
  let next = 0;

  // Boxes by line (Start and the closing End have no lines of their own), first box first.
  const end = closingEnd(chart);
  const byLine = new Map<number, number[]>();
  for (const n of chart.nodes) {
    if (n.id === chart.start || n.id === end) continue;
    for (const p of n.parts) {
      for (let line = p.from; line <= p.to && line < LINES && line - p.from < 10_000; line++) {
        const list = byLine.get(line) ?? [];
        if (!list.includes(n.id)) list.push(n.id);
        byLine.set(line, list);
      }
    }
  }
  for (const list of byLine.values()) list.sort((a, b) => a - b);
  const out = new Map<number, number[]>();
  chart.edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]));

  /** Every path from `from` to `to` (one edge at least) through boxes in `via` only. */
  function paths(from: number, to: number, via: Set<number>): number[][] {
    const found: number[][] = [];
    const seen = new Set([from]);
    const walk = (at: number, path: number[]) => {
      if (found.length > MAX_PATHS || path.length > MAX_DEPTH) return;
      for (const i of out.get(at) ?? []) {
        const n = chart.edges[i].to;
        if (n === to) found.push([...path, i]);
        else if (via.has(n) && !seen.has(n)) {
          seen.add(n);
          walk(n, [...path, i]);
          seen.delete(n);
        }
      }
    };
    walk(from, []);
    return found;
  }

  /** The edges a step surely took (those every fitting path shares) and the decisions it can't tell. */
  function settle(found: number[][]): Step0 {
    if (found.length === 1) return { edges: found[0], unsure: [] };
    if (!found.length) return { edges: [], unsure: [] };
    const shared = found[0].filter((i) => found.every((p) => p.includes(i)));
    const differ = new Set(found.flat().filter((i) => !shared.includes(i)).map((i) => chart.edges[i].from));
    return { edges: shared, unsure: [...differ].filter((id) => chart.nodes[id]?.kind === "decision") };
  }

  // Each kind of step is worked out once and then looked up (a long loop repeats a few steps
  // thousands of times). Keys are numbers, (box, line before, line now) packed: lines are under
  // LINES (a file has far fewer), boxes under NODE_LIMIT.
  const memo = [new Map<number, Step0>(), new Map<number, Step0>(), new Map<number, Step0>()];
  const nodesOn = (line: number | null) => (line === null ? [] : (byLine.get(line) ?? []));
  function step(kind: 0 | 1 | 2, from: number, to: number, before: number | null, now: number | null): Step0 {
    const key = (from * LINES + (before ?? 0)) * LINES + (now ?? 0);
    let s = memo[kind].get(key);
    if (!s) {
      s = settle(paths(from, to, new Set([before, now].flatMap(nodesOn))));
      memo[kind].set(key, s);
    }
    return s;
  }
  function take(s: Step0) {
    for (const i of s.edges) {
      counts[i]++;
      if (order[i] < 0) order[i] = next++;
    }
    for (const d of s.unsure) unsure.add(d);
  }

  // Each call replayed on its own: where it is (box, last line seen) and the last raw line.
  interface Call {
    at: number;
    line: number | null;
    raw: number | null;
    over: boolean;
  }
  const { events, calls: callCode } = trace;
  const live: (Call | undefined)[] = new Array(callCode.length);
  let calls = 0;
  for (let k = 0; k + 1 < events.length; k += 2) {
    const serial = events[k];
    const line = events[k + 1];
    if (!(serial >= 0 && serial < callCode.length && codes.has(callCode[serial]))) continue;
    let c = live[serial];
    if (!c) {
      c = live[serial] = { at: chart.start, line: null, raw: null, over: false };
      calls++;
    }
    if (c.over) continue;
    if (line < 0) {
      // The call returned (-1) to its caller: on to the closing End. An exception (-2) goes nowhere on the chart.
      c.over = true;
      if (line === -1 && end !== null && chart.nodes[c.at]?.kind !== "end") take(step(2, c.at, end, c.line, null));
      continue;
    }
    const again = line === c.raw;
    c.raw = line;
    const on = line < LINES ? byLine.get(line) : undefined;
    if (!on) continue;
    if (again) {
      // Back to the same line: once round a loop written on that line, if the chart has one.
      take(step(1, c.at, c.at, null, line));
      continue;
    }
    if (on.includes(c.at)) {
      // Another line of the same box (a statement over several lines).
      c.line = line;
      continue;
    }
    const to = on[0];
    take(step(0, c.at, to, c.line, line));
    c.at = to;
    c.line = line;
  }
  return { counts, order, unsure: [...unsure].sort((a, b) => a - b), calls, partial: trace.partial };
}

// ---------------------------------------------------------------- drawing and words

/** An edge's key, as the layout matches its edges to the model's. */
export const edgeKey = (e: Pick<FlowEdge, "from" | "to" | "label">) => `${e.from}>${e.to}>${e.label ?? ""}`;

/** Per edge key: the times the run went that way and when it first did (for layout edges). */
export function countsByKey(chart: FlowChart, ct: ChartTrace): Map<string, { count: number; order: number }> {
  const map = new Map<string, { count: number; order: number }>();
  chart.edges.forEach((e, i) => {
    const k = edgeKey(e);
    const was = map.get(k);
    const order = ct.order[i] ?? -1;
    if (!was) map.set(k, { count: ct.counts[i] ?? 0, order });
    else map.set(k, { count: was.count + (ct.counts[i] ?? 0), order: was.order < 0 ? order : order < 0 ? was.order : Math.min(was.order, order) });
  });
  return map;
}

/** A traced connector's width (tokens.md): 1.5, 2.5, 3 and 4 px for 1, 2, 3 and 5 or more passes (4: 3.5). */
export function traceWidth(count: number): number {
  if (count <= 1) return 1.5;
  if (count === 2) return 2.5;
  if (count === 3) return 3;
  if (count === 4) return 3.5;
  return 4;
}

/** A pass-count chip's words: "5x" (the ASCII letter x). */
export const chipText = (count: number) => `${count}x`;

export const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);

/** A decision's condition without the chart's " ?". */
const plain = (text: string) => text.replace(/ \?$/, "");

/** The loops' tests in the chart's structure. */
function loopTests(step: Step, out = new Set<number>()): Set<number> {
  switch (step.t) {
    case "seq":
      step.items.forEach((s) => loopTests(s, out));
      break;
    case "if":
      loopTests(step.yes, out);
      loopTests(step.no, out);
      break;
    case "loop":
      if (step.cond !== null) out.add(step.cond);
      loopTests(step.body, out);
      if (step.update) loopTests(step.update, out);
      if (step.orelse) loopTests(step.orelse, out);
      break;
    case "switch":
      step.cases.forEach((c) => loopTests(c.body, out));
      break;
  }
  return out;
}

/** What the run did at one decision, in words ("the loop i < n ran 5 times", "x > 0 was Yes 2 times, No 3 times"). */
function decisionWords(chart: FlowChart, ct: ChartTrace, id: number, loops: Set<number>): string {
  const node = chart.nodes[id];
  const what = plain(node.text);
  if (ct.unsure.includes(id)) return `${what}: not known, its code shares a line`;
  const outs = chart.edges.flatMap((e, i) => (e.from === id ? [{ e, n: ct.counts[i] ?? 0 }] : []));
  const total = outs.reduce((s, o) => s + o.n, 0);
  if (!total) return `${what} was never reached`;
  if (loops.has(id)) {
    const yes = outs.filter((o) => o.e.label === "Yes").reduce((s, o) => s + o.n, 0);
    return `the loop ${what} ran ${times(yes)}`;
  }
  // Yes and No (or a switch's cases), each once, in the chart's order.
  const by = new Map<string, number>();
  for (const o of outs) by.set(o.e.label ?? "on", (by.get(o.e.label ?? "on") ?? 0) + o.n);
  return `${what} was ${[...by].map(([label, n]) => `${label} ${times(n)}`).join(", ")}`;
}

/** Decisions named in the spoken summary; the rest are counted ("and 3 more decisions"). */
export const SUMMARY_DECISIONS = 8;

/** The live region's words after a traced run: "Path of the last run: the loop i < n ran 5 times; ..." */
export function traceSummary(chart: FlowChart, ct: ChartTrace, program: boolean, steps: number): string {
  const head = "Path of the last run";
  const tail = ct.partial ? ` Only the first ${steps.toLocaleString("en-US")} steps were counted.` : "";
  if (!ct.calls) return `${head}: ${chart.name} didn't run.${tail}`;
  const loops = loopTests(chart.body);
  const decisions = chart.nodes.filter((n) => n.kind === "decision").map((n) => n.id);
  const said = decisions.slice(0, SUMMARY_DECISIONS).map((id) => decisionWords(chart, ct, id, loops));
  if (decisions.length > SUMMARY_DECISIONS) said.push(`and ${decisions.length - SUMMARY_DECISIONS} more decisions (Steps lists them)`);
  const calls = program ? "" : `${chart.name} ran ${times(ct.calls)}`;
  const parts = [calls, ...said].filter(Boolean);
  if (!parts.length) return `${head}: straight through, no decisions.${tail}`;
  return `${head}: ${parts.join("; ")}.${tail}`;
}

/** The Steps outline's words for one box after a traced run (empty when the run didn't leave it). */
export function stepTraceWords(chart: FlowChart, ct: ChartTrace, id: number): string {
  if (ct.unsure.includes(id)) return " Last run: not known, its code shares a line.";
  const outs = chart.edges.flatMap((e, i) => (e.from === id ? [{ e, n: ct.counts[i] ?? 0 }] : []));
  if (!outs.some((o) => o.n > 0)) return "";
  const labelled = outs.filter((o) => o.e.label !== undefined);
  const words = labelled.length
    ? labelled.map((o) => `${o.e.label} ${times(o.n)}`)
    : outs.filter((o) => o.n > 0).map((o) => (outs.length > 1 ? `${times(o.n)} to step ${o.e.to + 1}` : times(o.n)));
  return ` Last run: ${words.join(", ")}.`;
}
