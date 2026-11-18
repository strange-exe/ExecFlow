// Stepping through a run (the step-through view's data): a traced Python run of one chart's code
// (the program's top level, or the function picked) as numbered steps. Step 0 is the run at Start,
// before anything ran; each later step is one event of the chart's calls in the run's order (a line
// about to run, or a call returning or ending by an exception), with the box it is at, the
// connectors it went along (trace.ts's mapping, so the counts are the chart's), the counts so far
// and the call's variables at that moment.
//
// Any step can be read in any order without replaying the run from the start: counts are kept at
// a checkpoint every CHECK steps, and each call's variables at a checkpoint every few changes, so a
// read replays a short stretch only.
//
// Everything returned is plain data. Variable names and texts come from the user's program: the
// view must show them as text (textContent), never as HTML.
import type { RunTrace } from "../core/types";
import type { FlowChart } from "./model";
import { codesFor, ranUntraced, replay } from "./trace";

/** Why a chart has no steps: C or C++ (no trace yet), no traced run, a function the run didn't call, a generator. */
export type NoSteps = "language" | "no-run" | "not-called" | "untraced";

/** What the view says when there are no steps. */
export const NO_STEPS_WORDS: Record<NoSteps, string> = {
  language: "Step-through is for Python for now.",
  "no-run": "Run the program to step through it.",
  "not-called": "This function wasn't called in the last run.",
  untraced: "Generators and coroutines can't be stepped through yet.",
};

/** start: step 0; line: a line about to run; return: the call returned; raise: it ended by an exception. */
export type StepKind = "start" | "line" | "return" | "raise";

export interface RunStep {
  k: number;
  kind: StepKind;
  /** The line about to run (a raise: the line it raised on); null at Start and at a return. */
  line: number | null;
  /** The box the run is at (chart.nodes index). */
  node: number;
  /** The connectors this step went along (chart.edges indexes), in order; the last is `edge`. */
  edges: number[];
  edge: number | null;
  /** Decisions this step passed in a way the line events can't tell. */
  unsure: number[];
  /** The call (RunTrace.calls index) this step belongs to; -1 at Start. */
  call: number;
  /** The event's index in RunTrace.events, as pairs; -1 at Start. */
  event: number;
}

export interface StepModel {
  ok: true;
  /** Steps, Start included: steps are numbered 0 to total - 1. */
  total: number;
  /** The trace stopped at its step limit: the last step isn't the end of the run. */
  partial: boolean;
  /** Variables: recorded for every step, up to a size cut, or not at all (an older trace). */
  values: "all" | "cut" | "none";
  /** Step k (clamped into range). */
  step(k: number): RunStep;
  /** The step's call's variables as [name, text], in the order they were first set. */
  varsAt(k: number): [string, string][];
  /** The step's variables were recorded (false past a size cut, or with no values). */
  valuesKnownAt(k: number): boolean;
  /** Times the run had reached each box (chart.nodes index) by step k; Start counts each call. A fresh copy. */
  nodeCountsAt(k: number): Int32Array;
  /** Line events per line by step k (lines that ran at least once). */
  lineCountsAt(k: number): Map<number, number>;
  /** Times the run had gone along each connector (chart.edges index) by step k. A fresh copy. */
  edgeCountsAt(k: number): Int32Array;
}

export type StepsResult = StepModel | { ok: false; reason: NoSteps };

/** Steps between count checkpoints. */
const CHECK = 128;
/** Changes between a call's variable checkpoints (at least; more for calls with many variables). */
const VAR_CHECK = 64;

/** The steps of `trace` on `chart` (`program`: the chart is the file's top level), or why there are none. */
export function stepsFor(chart: FlowChart, trace: RunTrace | null | undefined, opts: { program: boolean; lang: string }): StepsResult {
  if (opts.lang !== "python") return { ok: false, reason: "language" };
  if (!trace) return { ok: false, reason: "no-run" };
  const codes = codesFor(chart, trace, opts.program);
  if (!codes.size) return { ok: false, reason: ranUntraced(chart, trace, opts.program) ? "untraced" : "not-called" };
  return build(chart, trace, codes);
}

const KIND: StepKind[] = ["start", "line", "return", "raise"];

function build(chart: FlowChart, trace: RunTrace, codes: Set<number>): StepModel {
  // Per step (step 0 is Start): event, call, kind, line (-1: none), box, first event of its call,
  // and its connectors and unsure decisions as stretches of two flat lists.
  const event = [-1];
  const call = [-1];
  const kind = [0];
  const line = [-1];
  const node = [chart.start];
  const first = [0];
  const edgeAt = [0];
  const edgeList: number[] = [];
  const unsureAt = [0];
  const unsureList: number[] = [];
  const lastLine = new Map<number, number>();
  replay(chart, trace, codes, (m) => {
    event.push(m.event);
    call.push(m.serial);
    first.push(m.first ? 1 : 0);
    node.push(m.at);
    if (m.line >= 0) {
      kind.push(1);
      line.push(m.line);
      lastLine.set(m.serial, m.line);
    } else {
      kind.push(m.line === -1 ? 2 : 3);
      line.push(m.line === -1 ? -1 : (lastLine.get(m.serial) ?? -1));
    }
    edgeList.push(...m.edges);
    edgeAt.push(edgeList.length);
    unsureList.push(...m.unsure);
    unsureAt.push(unsureList.length);
  });
  const total = event.length;
  const clamp = (k: number) => (Number.isFinite(k) ? Math.min(total - 1, Math.max(0, Math.trunc(k))) : 0);

  // Lines by a compact index, for the line counts.
  const lineIndex = new Map<number, number>();
  const lines: number[] = [];
  for (let k = 1; k < total; k++) {
    if (kind[k] === 1 && !lineIndex.has(line[k])) {
      lineIndex.set(line[k], lines.length);
      lines.push(line[k]);
    }
  }
  const edgeTo = chart.edges.map((e) => e.to);
  /** Adds step k's counts. */
  function count(k: number, nodes: Int32Array, byLine: Int32Array, byEdge: Int32Array) {
    if (first[k]) nodes[chart.start]++;
    for (let i = edgeAt[k - 1]; i < edgeAt[k]; i++) {
      nodes[edgeTo[edgeList[i]]]++;
      byEdge[edgeList[i]]++;
    }
    if (kind[k] === 1) byLine[lineIndex.get(line[k])!]++;
  }
  const nodeCheck: Int32Array[] = [];
  const lineCheck: Int32Array[] = [];
  const edgeCheck: Int32Array[] = [];
  {
    const nodes = new Int32Array(chart.nodes.length);
    const byLine = new Int32Array(lines.length);
    const byEdge = new Int32Array(chart.edges.length);
    for (let k = 0; k < total; k++) {
      if (k) count(k, nodes, byLine, byEdge);
      if (k % CHECK === 0) {
        nodeCheck.push(nodes.slice());
        lineCheck.push(byLine.slice());
        edgeCheck.push(byEdge.slice());
      }
    }
  }
  /** Counts at step k (boxes, lines, connectors): from the checkpoint before it. */
  function countsAt(k: number): [Int32Array, Int32Array, Int32Array] {
    const c = Math.floor(k / CHECK);
    const nodes = nodeCheck[c].slice();
    const byLine = lineCheck[c].slice();
    const byEdge = edgeCheck[c].slice();
    for (let j = c * CHECK + 1; j <= k; j++) count(j, nodes, byLine, byEdge);
    return [nodes, byLine, byEdge];
  }

  const vars = valuesFor(trace, new Set(call));
  const cut = trace.values?.cut ?? null;
  const lastEvent = event[total - 1];
  const known = (k: number) => trace.values !== undefined && (cut === null || event[k] < cut);

  return {
    ok: true,
    total,
    partial: trace.partial,
    values: !trace.values ? "none" : cut !== null && cut <= lastEvent ? "cut" : "all",
    step(k) {
      k = clamp(k);
      const edges = edgeList.slice(edgeAt[k - 1] ?? 0, edgeAt[k]);
      return {
        k,
        kind: KIND[kind[k]],
        line: line[k] < 0 ? null : line[k],
        node: node[k],
        edges,
        edge: edges.length ? edges[edges.length - 1] : null,
        unsure: unsureList.slice(unsureAt[k - 1] ?? 0, unsureAt[k]),
        call: call[k],
        event: event[k],
      };
    },
    varsAt(k) {
      k = clamp(k);
      return k > 0 && vars ? vars(call[k], event[k]) : [];
    },
    valuesKnownAt: (k) => known(clamp(k)),
    nodeCountsAt: (k) => countsAt(clamp(k))[0],
    lineCountsAt(k) {
      const byLine = countsAt(clamp(k))[1];
      const out = new Map<number, number>();
      byLine.forEach((n, i) => n && out.set(lines[i], n));
      return out;
    },
    edgeCountsAt: (k) => countsAt(clamp(k))[2],
  };
}

/** Last index in the sorted list `a` whose value is at most `x`, plus one (0 when none is). */
function upTo(a: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The variables of each of `calls` at any of its events: (call, event) -> [name, text][], or null
 * when the trace has no values. Each call's changes are kept apart, with a checkpoint (the whole
 * set, in order) every VAR_CHECK changes or more.
 */
function valuesFor(trace: RunTrace, calls: Set<number>): ((call: number, event: number) => [string, string][]) | null {
  const v = trace.values;
  if (!v) return null;
  interface Changes {
    at: number[];
    name: number[];
    text: number[];
    /** Checkpoints: changes applied, and the set then as flat (name, text) pairs. */
    pos: number[];
    sets: Int32Array[];
  }
  const byCall = new Map<number, Changes>();
  const d = v.deltas;
  for (let i = 0; i + 2 < d.length; i += 3) {
    const serial = trace.events[2 * d[i]];
    if (!calls.has(serial)) continue;
    let c = byCall.get(serial);
    if (!c) byCall.set(serial, (c = { at: [], name: [], text: [], pos: [], sets: [] }));
    c.at.push(d[i]);
    c.name.push(d[i + 1]);
    c.text.push(d[i + 2]);
  }
  const apply = (c: Changes, set: Map<number, number>, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (c.text[i] < 0) set.delete(c.name[i]);
      else set.set(c.name[i], c.text[i]);
    }
  };
  for (const c of byCall.values()) {
    const set = new Map<number, number>();
    let next = 0;
    for (let i = 0; i <= c.at.length; i++) {
      if (i === next) {
        c.pos.push(i);
        c.sets.push(Int32Array.from([...set].flat()));
        next = i + Math.max(VAR_CHECK, set.size);
      }
      if (i < c.at.length) apply(c, set, i, i + 1);
    }
  }
  return (serial, event) => {
    const c = byCall.get(serial);
    if (!c) return [];
    const n = upTo(c.at, event);
    const at = upTo(c.pos, n) - 1;
    const set = new Map<number, number>();
    const flat = c.sets[at];
    for (let i = 0; i < flat.length; i += 2) set.set(flat[i], flat[i + 1]);
    apply(c, set, c.pos[at], n);
    return [...set].map(([name, text]) => [v.names[name] ?? "", v.texts[text] ?? ""]);
  };
}
