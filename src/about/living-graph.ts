// The About page's hero program (redesign 9, "Living Graph"; brief .claude/design/redesign9/BRIEF.md):
// sum_evens in Python, C and C++, the nodes and edges of its flowchart, and the trace of one run,
// simulated from the program rather than typed in. Every count, the output and the step readout on
// the page come from here. Pure (no DOM), so it is unit tested; graph.ts draws it.

export const NODES = ["start", "init", "loop", "test", "add", "out", "end"] as const;
export type NodeId = (typeof NODES)[number];
/** The nodes a line of code stands for (Start and End have none). */
export type LineNode = "init" | "loop" | "test" | "add" | "out";
export type Kind = "term" | "proc" | "loop" | "dec" | "io";
export const KIND: Readonly<Record<NodeId, Kind>> = { start: "term", init: "proc", loop: "loop", test: "dec", add: "proc", out: "io", end: "term" };

export const EDGES = ["start>init", "init>loop", "loop>test", "test>add", "add>loop", "test>loop", "loop>out", "out>end"] as const;
export type EdgeId = (typeof EDGES)[number];
export const EDGE_LABEL: Readonly<Partial<Record<EdgeId, string>>> = { "loop>test": "next n", "test>add": "yes", "test>loop": "no", "loop>out": "done" };

/** A piece of a source line: its text, its highlight class, and 1 when it is part of its node's label. */
export type Piece = readonly [text: string, cls: "" | "kw" | "fn" | "num" | "str", label?: 1];

export const LANG_ORDER = ["py", "c", "cpp"] as const;
export type LangId = (typeof LANG_ORDER)[number];

export interface Lang {
  readonly id: LangId;
  /** The switcher's number: 01 / 03. */
  readonly idx: string;
  readonly file: string;
  readonly name: string;
  /** The 1-based line each node stands for. */
  readonly map: Readonly<Record<LineNode, number>>;
  readonly lines: readonly (readonly Piece[])[];
}

// A backslash, built from its code point: the C and C++ sources print a newline with "\n".
const BS = String.fromCharCode(92);
const C_BODY = (header: string, main: string, print: readonly Piece[]): (readonly Piece[])[] => [
  [["#include", "kw"], [" ", ""], [header, "str"]],
  [],
  [["int", "kw"], [" ", ""], ["main", "fn"], ...(main === "void" ? ([["(", ""], ["void", "kw"], [") {", ""]] as const) : ([["() {", ""]] as const))],
  [["    ", ""], ["int", "kw", 1], [" total = ", "", 1], ["0", "num", 1], [";", "", 1]],
  [["    ", ""], ["for", "kw", 1], [" (", "", 1], ["int", "kw", 1], [" n = ", "", 1], ["1", "num", 1], ["; n < ", "", 1], ["7", "num", 1], ["; n++)", "", 1]],
  [["        ", ""], ["if", "kw"], [" (", ""], ["n % ", "", 1], ["2", "num", 1], [" == ", "", 1], ["0", "num", 1], [")", ""]],
  [["            ", ""], ["total += n;", "", 1]],
  [["    ", ""], ...print],
  [["    ", ""], ["return", "kw"], [" ", ""], ["0", "num"], [";", ""]],
  [["}", ""]],
];

export const LANGS: Readonly<Record<LangId, Lang>> = {
  py: {
    id: "py",
    idx: "01",
    file: "sum_evens.py",
    name: "Python",
    map: { init: 1, loop: 2, test: 3, add: 4, out: 5 },
    lines: [
      [["total = ", "", 1], ["0", "num", 1]],
      [["for", "kw", 1], [" n ", "", 1], ["in", "kw", 1], [" ", "", 1], ["range", "fn", 1], ["(", "", 1], ["1", "num", 1], [", ", "", 1], ["7", "num", 1], [")", "", 1], [":", ""]],
      [["    ", ""], ["if", "kw"], [" ", ""], ["n % ", "", 1], ["2", "num", 1], [" == ", "", 1], ["0", "num", 1], [":", ""]],
      [["        ", ""], ["total += n", "", 1]],
      [["print", "fn", 1], ["(total)", "", 1]],
    ],
  },
  c: {
    id: "c",
    idx: "02",
    file: "sum_evens.c",
    name: "C",
    map: { init: 4, loop: 5, test: 6, add: 7, out: 8 },
    lines: C_BODY("<stdio.h>", "void", [["printf", "fn", 1], ["(", "", 1], [`"%d${BS}n"`, "str", 1], [", total);", "", 1]]),
  },
  cpp: {
    id: "cpp",
    idx: "03",
    file: "sum_evens.cpp",
    name: "C++",
    map: { init: 4, loop: 5, test: 6, add: 7, out: 8 },
    lines: C_BODY("<iostream>", "", [["std::cout << total << ", "", 1], [`'${BS}n'`, "str", 1], [";", "", 1]]),
  },
};

/** The node a line stands for, or null. */
export function nodeOfLine(L: Lang, line: number): LineNode | null {
  for (const id of Object.keys(L.map) as LineNode[]) if (L.map[id] === line) return id;
  return null;
}

/** Each node's label: the label pieces of its line ("for n in range(1, 7)" without the colon). */
export function labelsOf(L: Lang): Record<NodeId, string> {
  const out = { start: "Start", end: "End" } as Record<NodeId, string>;
  for (const id of Object.keys(L.map) as LineNode[]) {
    out[id] = L.lines[L.map[id] - 1]
      .filter((p) => p[2])
      .map((p) => p[0])
      .join("");
  }
  return out;
}

/** Every language's labels: the chart is sized for all of them, so switching never resizes it. */
export function allLabels(): Record<NodeId, string>[] {
  return LANG_ORDER.map((id) => labelsOf(LANGS[id]));
}

export function sourceOf(L: Lang): string {
  return `${L.lines.map((line) => line.map((p) => p[0]).join("")).join("\n")}\n`;
}

/** One visit to a node, with the values after it, and the sentence a screen reader hears. */
export interface Visit {
  readonly id: NodeId;
  readonly n?: number;
  readonly total: number;
  readonly done?: true;
  readonly say: string;
}

function simulate(): Visit[] {
  const out: Visit[] = [{ id: "start", total: 0, say: "Start. The program begins." }];
  let total = 0;
  out.push({ id: "init", total, say: "total is set to 0" });
  for (let n = 1; n < 7; n++) {
    out.push({ id: "loop", n, total, say: `loop: n is ${n}, next n` });
    const even = n % 2 === 0;
    out.push({ id: "test", n, total, say: `${n} % 2 == 0 is ${even ? "true, so yes" : "false, so no"}` });
    if (even) {
      total += n;
      out.push({ id: "add", n, total, say: `total += ${n}, total is now ${total}` });
    }
  }
  out.push({ id: "loop", total, done: true, say: "loop: no more values of n, so done" });
  out.push({ id: "out", total, say: `the program prints ${total}` });
  out.push({ id: "end", total, say: "End. The program finished." });
  return out;
}

/** The run: 20 visits. */
export const TRACE: readonly Visit[] = simulate();
/** The last step: 19 moves along the chart's edges. */
export const LAST = TRACE.length - 1;
/** What the program prints. */
export const OUTPUT = String(TRACE[LAST].total);

/** Where the run stands after step k: pass counts, edges taken, the current node and the values. */
export interface State {
  readonly counts: Readonly<Partial<Record<NodeId, number>>>;
  readonly edges: Readonly<Partial<Record<EdgeId, number>>>;
  readonly cur: NodeId;
  /** The edge just taken, or null at step 0. */
  readonly last: EdgeId | null;
  readonly total: number;
  /** n's value, or null before the loop starts. */
  readonly n: number | null;
  /** Whether print(total) has run. */
  readonly printed: boolean;
}

const edgeOf = (a: NodeId, b: NodeId) => `${a}>${b}` as EdgeId;

export const STATES: readonly State[] = TRACE.map((visit, k) => {
  const counts: Partial<Record<NodeId, number>> = {};
  const edges: Partial<Record<EdgeId, number>> = {};
  let n: number | null = null;
  for (let i = 0; i <= k; i++) {
    const v = TRACE[i];
    if (v.n !== undefined) n = v.n;
    counts[v.id] = (counts[v.id] ?? 0) + 1;
    if (i > 0) {
      const e = edgeOf(TRACE[i - 1].id, v.id);
      edges[e] = (edges[e] ?? 0) + 1;
    }
  }
  return { counts, edges, cur: visit.id, last: k > 0 ? edgeOf(TRACE[k - 1].id, visit.id) : null, total: visit.total, n, printed: k >= LAST - 1 };
});

const pad = (n: number) => String(n).padStart(2, "0");

/** The readout under the chart: step 07/19, n and total. */
export function readout(k: number): { step: string; of: string; n: string; total: string } {
  const st = STATES[k];
  return { step: pad(k), of: String(LAST), n: st.n === null ? "not set" : String(st.n), total: String(st.total) };
}

/** The step a key moves to from step k, or null when the key does nothing there. */
export function stepFor(key: string, k: number): number | null {
  if (key === "ArrowRight") return k < LAST ? k + 1 : null;
  if (key === "ArrowLeft") return k > 0 ? k - 1 : null;
  if (key === "Home") return k > 0 ? 0 : null;
  if (key === "End") return k < LAST ? LAST : null;
  return null;
}

/** The tab a key moves to from tab i of count (arrows wrap round), or null. */
export function tabFor(key: string, i: number, count: number): number | null {
  if (key === "ArrowRight") return (i + 1) % count;
  if (key === "ArrowLeft") return (i + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The Run button's word: what a press does now. */
export function runLabel(playing: boolean, k: number): string {
  if (playing) return "Pause";
  if (k === LAST) return "Run again";
  return k === 0 ? "Run" : "Resume";
}

/** A node's offset from home, its velocity and where its spring is pulling it. */
export interface Spring {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
}

/**
 * Advances a node's spring by `seconds` of real time and says whether it is at rest (then exactly at
 * its target). Fixed 1/120 s substeps keep it stable, so a slow or janky page still brings the node
 * home on time; a frame longer than 0.25 s counts as 0.25 s (a tab coming back from the background).
 */
export function springStep(o: Spring, seconds: number): boolean {
  // Damping ratio about 0.6: one small overshoot, then rest.
  const K = 320;
  const C = 21;
  const H = 1 / 120;
  let left = Math.min(0.25, seconds);
  while (left > 1e-9) {
    const dt = Math.min(H, left);
    left -= dt;
    o.vx += (-K * (o.x - o.tx) - C * o.vx) * dt;
    o.vy += (-K * (o.y - o.ty) - C * o.vy) * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
  }
  const done = Math.abs(o.x - o.tx) < 0.05 && Math.abs(o.y - o.ty) < 0.05 && Math.abs(o.vx) < 0.5 && Math.abs(o.vy) < 0.5;
  if (done) Object.assign(o, { x: o.tx, y: o.ty, vx: 0, vy: 0 });
  return done;
}

const KIND_WORD: Readonly<Record<Kind, string>> = { term: "", proc: "Step", loop: "Loop", dec: "Decision", io: "Output" };

/** A node's accessible name: what it is, its line, where it leads, and how often it ran. */
export function describeNode(id: NodeId, labels: Record<NodeId, string>, line: number, count: number): string {
  let s = id === "start" || id === "end" ? `${labels[id]}.` : `${KIND_WORD[KIND[id]]} ${labels[id]}, line ${line}.`;
  if (id === "loop") s += ` Next n leads to the decision, done leads to ${labels.out}.`;
  if (id === "test") s += ` Yes leads to ${labels.add}, no leads back to the loop.`;
  if (id === "add") s += " Leads back to the loop.";
  s += count > 0 ? ` Ran ${count} ${count === 1 ? "time" : "times"}.` : " Not run yet.";
  return s;
}
