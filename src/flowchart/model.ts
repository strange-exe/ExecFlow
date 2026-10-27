// The flow model: one chart per function, language-free. Adapters (c.ts, cpp.ts, python.ts) turn a
// tree-sitter tree into a structured Step tree through a FlowBuilder; finish() then merges runs of
// simple statements (up to MERGE in one box), numbers the boxes in reading order and derives the
// edges. The Step tree is kept in the model: the layout places boxes by it (sequences stack,
// decisions split, loops get a back edge on the side), and the edges say where control goes.
import { condition, edgeText, label, nameText } from "./labels";

export type NodeKind = "start" | "end" | "process" | "io" | "decision" | "call" | "connector";

/** One statement inside a box, with its own source lines (1-based). */
export interface Part {
  text: string;
  from: number;
  to: number;
}

export interface FlowNode {
  id: number;
  kind: NodeKind;
  /** The lines drawn in the box (wrapped, capped, through shown()). */
  label: string[];
  /** The full text: the box's accessible name and tooltip (through shown()). */
  text: string;
  /** Source lines, 1-based and inclusive. */
  from: number;
  to: number;
  /** The statements merged into the box, each with its lines. */
  parts: Part[];
  /** A call box: the chart (function name, as in FlowChart.name) it opens. */
  callee?: string;
  /** Shown under the label: "shown as one step" for constructs the chart doesn't open up. */
  note?: string;
}

/**
 * flow: straight on, a branch or a rejoin; back: a loop's way back to its test; jump: break or
 * continue; link: a goto's connector to its label's connector (two circles with the same name,
 * the ISO 5807 way to join far-apart points; not drawn as a line).
 */
export type EdgeKind = "flow" | "back" | "jump" | "link";

export interface FlowEdge {
  from: number;
  to: number;
  label?: string;
  kind: EdgeKind;
}

/** The structure the layout follows. Node ids refer to FlowChart.nodes. */
export type Step =
  | { t: "node"; id: number }
  | { t: "seq"; items: Step[] }
  | { t: "if"; cond: number; yes: Step; no: Step }
  /** while/for (pre-test), do-while (post), or a loop with no test (cond null: for(;;)). */
  | { t: "loop"; post: boolean; cond: number | null; body: Step; update: Step | null; orelse: Step | null; line: number }
  | { t: "switch"; cond: number; cases: SwitchCase[] }
  | { t: "break" }
  | { t: "continue" }
  /** return, raise, throw: an end terminator with the code's text. */
  | { t: "end"; id: number }
  /** A goto's connector; target is the label's connector (null when the label doesn't exist). */
  | { t: "goto"; id: number; target: number | null }
  | { t: "label"; id: number };

export interface SwitchCase {
  /** "1", "1, 2" (stacked cases), "default". */
  label: string;
  body: Step;
  /** What happens after the body: "break" leaves the switch, "fall" runs into the next case. */
  exit: "break" | "fall";
}

export interface FlowChart {
  /** The function's name ("main", "Shape.area"; "Program" for a Python file's top level). */
  name: string;
  from: number;
  to: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  start: number;
  /** Boxes no path from Start reaches (code after a return, for example). */
  unreachable: number[];
  body: Step;
}

export type ChartResult = ({ ok: true } & FlowChart) | { ok: false; name: string; from: number; to: number; tooBig: string };
/** A function whose chart wasn't made: only the picked one is, so a file of many functions stays quick. */
export type ChartStub = { ok: null; name: string; from: number; to: number };

export interface FlowFile {
  /** One per function, the entry point first: charted, too big, or (not picked) a stub. */
  charts: (ChartResult | ChartStub)[];
  /** The first syntax mistake's line (1-based), when the code has one. */
  syntaxError?: number;
}

/** Limits from the spec: past them a chart is "too big", never slow. */
export const NODE_LIMIT = 400;
export const DEPTH_LIMIT = 40;
/** Consecutive simple statements merged into one box. */
export const MERGE = 3;
/** Boxes an adapter may create before merging; stops a 50 000-statement function early. */
const RAW_LIMIT = NODE_LIMIT * MERGE + 16;

export const ONE_STEP = "shown as one step";

export class TooBig extends Error {}

interface Draft {
  kind: NodeKind;
  parts: Part[];
  isCondition: boolean;
  simple: boolean;
  callee?: string;
  note?: string;
  dead?: boolean;
}

export interface NodeOptions {
  /** A decision's condition: drawn with " ?". */
  condition?: boolean;
  /** A plain statement that may share a box with its neighbours. */
  simple?: boolean;
  callee?: string;
  note?: string;
}

export const empty = (): Step => ({ t: "seq", items: [] });

/** Builds one chart. Adapters call node() for every box and nest() around every nested body. */
export class FlowBuilder {
  private drafts: Draft[] = [];
  private depth = 0;
  readonly start: number;
  /** The chart's name as shown (through shown(), capped). */
  readonly name: string;

  constructor(
    name: string,
    readonly from: number,
    readonly to: number,
  ) {
    this.name = nameText(name);
    this.start = this.node("start", "Start", from, from);
  }

  node(kind: NodeKind, code: string, from: number, to: number, options: NodeOptions = {}): number {
    if (this.drafts.length >= RAW_LIMIT) throw new TooBig(`it has more than ${NODE_LIMIT} steps`);
    this.drafts.push({
      kind,
      parts: [{ text: code, from, to }],
      isCondition: options.condition ?? false,
      simple: (options.simple ?? false) && kind === "process" && !options.note,
      callee: options.callee === undefined ? undefined : nameText(options.callee),
      note: options.note,
    });
    return this.drafts.length - 1;
  }

  /** Runs `fn` one nesting level deeper; past DEPTH_LIMIT the chart is too big. */
  nest<T>(fn: () => T): T {
    if (++this.depth > DEPTH_LIMIT) throw new TooBig(`its code is nested more than ${DEPTH_LIMIT} levels deep`);
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  /** The finished chart for a function whose body is `body`. */
  finish(body: Step): FlowChart {
    const merged = this.merge(body);
    const normal = this.normalize(merged);
    // Number the boxes in reading order: Start, then the body depth-first.
    const order: number[] = [this.start];
    visitNodes(normal, (id) => order.push(id));
    const newId = new Map<number, number>();
    for (const old of order) if (!newId.has(old)) newId.set(old, newId.size);
    const tree = renumber(normal, (id) => newId.get(id)!);
    const nodes: FlowNode[] = [...newId.keys()].map((old) => this.finalNode(old, newId.get(old)!));
    const edges: FlowEdge[] = [];
    const ctx: Ctx = { edges, stack: [] };
    const out = compile(tree, [{ from: 0, kind: "flow" }], ctx);
    const items: Step[] = [{ t: "node", id: 0 }, tree];
    if (out.length) {
      // The end of the function is reachable: it ends at an End terminator.
      const endId = nodes.length;
      nodes.push({ id: endId, kind: "end", label: ["End"], text: "End", from: this.to, to: this.to, parts: [{ text: "End", from: this.to, to: this.to }] });
      link(ctx, out, endId);
      items.push({ t: "end", id: endId });
    }
    if (nodes.length > NODE_LIMIT) throw new TooBig(`it has more than ${NODE_LIMIT} steps`);
    return {
      name: this.name,
      from: this.from,
      to: this.to,
      nodes,
      edges,
      start: 0,
      unreachable: unreachableFrom(0, nodes.length, edges),
      body: { t: "seq", items },
    };
  }

  /** Merges runs of simple process boxes in every sequence, MERGE at most per box. */
  private merge(step: Step): Step {
    switch (step.t) {
      case "seq": {
        const items: Step[] = [];
        let run: number | null = null;
        for (const raw of step.items) {
          const item = this.merge(raw);
          const draft = item.t === "node" ? this.drafts[item.id] : null;
          if (draft?.simple && run !== null && this.drafts[run].parts.length < MERGE) {
            this.drafts[run].parts.push(...draft.parts);
            draft.dead = true;
            continue;
          }
          run = draft?.simple ? (item as { id: number }).id : null;
          items.push(item);
        }
        return { t: "seq", items };
      }
      case "if":
        return { ...step, yes: this.merge(step.yes), no: this.merge(step.no) };
      case "loop":
        return {
          ...step,
          body: this.merge(step.body),
          update: step.update && this.merge(step.update),
          orelse: step.orelse && this.merge(step.orelse),
        };
      case "switch":
        return { ...step, cases: step.cases.map((c) => ({ ...c, body: this.merge(c.body) })) };
      default:
        return step;
    }
  }

  /** A loop with no test needs a box to come back to: a "loop" connector when its body has none first. */
  private normalize(step: Step): Step {
    switch (step.t) {
      case "seq":
        return { t: "seq", items: step.items.map((s) => this.normalize(s)) };
      case "if":
        return { ...step, yes: this.normalize(step.yes), no: this.normalize(step.no) };
      case "switch":
        return { ...step, cases: step.cases.map((c) => ({ ...c, body: this.normalize(c.body) })) };
      case "loop": {
        let body = this.normalize(step.body);
        if (step.cond === null && entryOf(body) === null) {
          const id = this.node("connector", "loop", step.line, step.line);
          body = { t: "seq", items: [{ t: "node", id }, body] };
        }
        return { ...step, body, update: step.update && this.normalize(step.update), orelse: step.orelse && this.normalize(step.orelse) };
      }
      default:
        return step;
    }
  }

  private finalNode(old: number, id: number): FlowNode {
    const d = this.drafts[old];
    const from = Math.min(...d.parts.map((p) => p.from));
    const to = Math.max(...d.parts.map((p) => p.to));
    let lines: string[];
    let text: string;
    if (d.parts.length > 1) {
      const labels = d.parts.map((p) => label(p.text, { maxLines: 2 }));
      lines = labels.flatMap((l) => l.lines);
      text = labels.map((l) => l.full).join("; ");
    } else {
      const l = d.isCondition ? condition(d.parts[0].text) : d.kind === "connector" ? label(d.parts[0].text, { maxLines: 1, wrap: 12 }) : label(d.parts[0].text);
      lines = l.lines;
      text = l.full;
    }
    const node: FlowNode = { id, kind: d.kind, label: lines, text, from, to, parts: d.parts.map((p) => ({ ...p, text: label(p.text).full })) };
    if (d.callee !== undefined) node.callee = d.callee;
    if (d.note !== undefined) node.note = d.note;
    return node;
  }
}

/** Every node id in the step, in reading order. */
export function visitNodes(step: Step, visit: (id: number) => void): void {
  switch (step.t) {
    case "node":
    case "end":
    case "goto":
    case "label":
      visit(step.id);
      return;
    case "seq":
      for (const s of step.items) visitNodes(s, visit);
      return;
    case "if":
      visit(step.cond);
      visitNodes(step.yes, visit);
      visitNodes(step.no, visit);
      return;
    case "loop":
      if (!step.post && step.cond !== null) visit(step.cond);
      visitNodes(step.body, visit);
      if (step.update) visitNodes(step.update, visit);
      if (step.post && step.cond !== null) visit(step.cond);
      if (step.orelse) visitNodes(step.orelse, visit);
      return;
    case "switch":
      visit(step.cond);
      for (const c of step.cases) visitNodes(c.body, visit);
      return;
    default:
      return;
  }
}

function renumber(step: Step, f: (id: number) => number): Step {
  switch (step.t) {
    case "node":
    case "end":
    case "label":
      return { ...step, id: f(step.id) };
    case "goto":
      return { ...step, id: f(step.id), target: step.target === null ? null : f(step.target) };
    case "seq":
      return { t: "seq", items: step.items.map((s) => renumber(s, f)) };
    case "if":
      return { ...step, cond: f(step.cond), yes: renumber(step.yes, f), no: renumber(step.no, f) };
    case "loop":
      return {
        ...step,
        cond: step.cond === null ? null : f(step.cond),
        body: renumber(step.body, f),
        update: step.update && renumber(step.update, f),
        orelse: step.orelse && renumber(step.orelse, f),
      };
    case "switch":
      return { ...step, cond: f(step.cond), cases: step.cases.map((c) => ({ ...c, body: renumber(c.body, f) })) };
    default:
      return step;
  }
}

/** The first box control reaches when it enters `step`, or null when it jumps away (or there is none). */
export function entryOf(step: Step): number | null {
  switch (step.t) {
    case "node":
    case "end":
    case "goto":
    case "label":
      return step.id;
    case "seq":
      for (const s of step.items) {
        if (s.t === "break" || s.t === "continue") return null;
        const e = entryOf(s);
        if (e !== null) return e;
      }
      return null;
    case "if":
    case "switch":
      return step.cond;
    case "loop":
      return step.post || step.cond === null ? (entryOf(step.body) ?? step.cond) : step.cond;
    default:
      return null;
  }
}

// ---------- edges ----------

/** Control waiting to go to the next box: from a box, with a branch label. */
export interface Pending {
  from: number;
  label?: string;
  kind: EdgeKind;
}

interface LoopCtx {
  /** Where `continue` goes; null for a switch (continue passes through to the loop around it). */
  next: number | null;
  breaks: Pending[];
}

interface Ctx {
  edges: FlowEdge[];
  stack: LoopCtx[];
}

function link(ctx: Ctx, from: Pending[], to: number, kind?: EdgeKind): void {
  for (const p of from) {
    // A break or continue stays a jump all the way to where it lands.
    const edge: FlowEdge = { from: p.from, to, kind: p.kind === "jump" ? "jump" : (kind ?? p.kind) };
    // Case values are the code's text: shown() and cut like every label.
    if (p.label !== undefined) edge.label = edgeText(p.label);
    ctx.edges.push(edge);
  }
}

/** Adds the edges inside `step`; `inc` is the control arriving. Returns the control leaving it. */
export function compile(step: Step, inc: Pending[], ctx: Ctx): Pending[] {
  switch (step.t) {
    case "node":
    case "label":
      link(ctx, inc, step.id);
      return [{ from: step.id, kind: "flow" }];
    case "end":
      link(ctx, inc, step.id);
      return [];
    case "goto":
      link(ctx, inc, step.id);
      if (step.target === null) return [{ from: step.id, kind: "flow" }];
      link(ctx, [{ from: step.id, kind: "link" }], step.target);
      return [];
    case "seq": {
      let flow = inc;
      for (const s of step.items) flow = compile(s, flow, ctx);
      return flow;
    }
    case "if": {
      link(ctx, inc, step.cond);
      const yes = compile(step.yes, [{ from: step.cond, label: "Yes", kind: "flow" }], ctx);
      const no = compile(step.no, [{ from: step.cond, label: "No", kind: "flow" }], ctx);
      return [...yes, ...no];
    }
    case "loop":
      return compileLoop(step, inc, ctx);
    case "switch": {
      link(ctx, inc, step.cond);
      const frame: LoopCtx = { next: null, breaks: [] };
      ctx.stack.push(frame);
      let prev: Pending[] = [];
      for (const c of step.cases) {
        const out = compile(c.body, [...prev, { from: step.cond, label: c.label, kind: "flow" }], ctx);
        if (c.exit === "break") {
          frame.breaks.push(...out);
          prev = [];
        } else {
          prev = out;
        }
      }
      ctx.stack.pop();
      return [...frame.breaks, ...prev];
    }
    case "break": {
      const frame = ctx.stack.at(-1);
      if (!frame) return inc; // break outside a loop: a compile error; the chart carries on
      frame.breaks.push(...inc.map((p) => ({ ...p, kind: "jump" as const })));
      return [];
    }
    case "continue": {
      const frame = [...ctx.stack].reverse().find((f) => f.next !== null);
      if (!frame) return inc;
      link(ctx, inc, frame.next!, "jump");
      return [];
    }
  }
}

function compileLoop(step: Extract<Step, { t: "loop" }>, inc: Pending[], ctx: Ctx): Pending[] {
  const updateEntry = step.update ? entryOf(step.update) : null;
  if (step.post) {
    // do { body } while (cond): the body first; "Yes" goes back to its first box.
    const cond = step.cond!;
    const frame: LoopCtx = { next: cond, breaks: [] };
    ctx.stack.push(frame);
    const body = compile(step.body, [...inc, { from: cond, label: "Yes", kind: "back" }], ctx);
    ctx.stack.pop();
    link(ctx, body, cond);
    return [{ from: cond, label: "No", kind: "flow" }, ...frame.breaks];
  }
  if (step.cond === null) {
    // for (;;): round and round; only break leaves.
    const head = entryOf(step.body)!;
    const frame: LoopCtx = { next: updateEntry ?? head, breaks: [] };
    ctx.stack.push(frame);
    let body = compile(step.body, inc, ctx);
    ctx.stack.pop();
    if (step.update) body = compile(step.update, body, ctx);
    link(ctx, body, head, "back");
    return frame.breaks;
  }
  const cond = step.cond;
  link(ctx, inc, cond);
  const frame: LoopCtx = { next: updateEntry ?? cond, breaks: [] };
  ctx.stack.push(frame);
  let body = compile(step.body, [{ from: cond, label: "Yes", kind: "flow" }], ctx);
  ctx.stack.pop();
  if (step.update) body = compile(step.update, body, ctx);
  link(ctx, body, cond, "back");
  let exits: Pending[] = [{ from: cond, label: "No", kind: "flow" }];
  if (step.orelse) exits = compile(step.orelse, exits, ctx);
  return [...exits, ...frame.breaks];
}

function unreachableFrom(start: number, count: number, edges: FlowEdge[]): number[] {
  const next = new Map<number, number[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const n of next.get(queue.shift()!) ?? []) if (!seen.has(n)) seen.add(n), queue.push(n);
  return Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
}
