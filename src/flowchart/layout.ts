// Structured flowchart layout: a pure function from a flow model to positioned boxes and routed
// edges. It follows the model's Step tree, the way a teacher draws: a sequence stacks top-down on
// one spine; a decision's two branches sit left (Yes) and right (No) and rejoin below it (an if
// without else keeps Yes on the spine and takes No around the right; an if whose Yes leaves, like
// `if (x) return;`, goes Yes to the right and No straight on); a loop's back edge runs up a lane on
// its left, outside every box of the loop, and its exit down a lane on its right; a switch fans its
// cases out in columns under a bus. Every frame keeps its lanes inside its own width, so siblings
// never overlap them.
//
// break and continue go to points inside an enclosing loop, often across other boxes; they are
// routed last, with a shortest-path search on a grid of lines just clear of every box, so they never
// cross one (bends and running along another edge cost extra). A goto is not drawn as a line: its
// connector and its label's connector carry the same name (ISO 5807). Same input, same output.
import type { EdgeKind, FlowChart, FlowNode, NodeKind, Step } from "./model";

export interface Point {
  x: number;
  y: number;
}

export interface LaidBox {
  id: number;
  kind: NodeKind;
  /** Top-left corner and size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidEdge {
  from: number;
  to: number;
  label?: string;
  kind: EdgeKind;
  /** Orthogonal polyline from the source box's border to the target box's border. */
  points: Point[];
  /** Where an edge label's text starts (anchor start) or ends (anchor end), at its baseline. */
  labelAt?: { x: number; y: number; anchor: "start" | "end" };
}

export interface Layout {
  width: number;
  height: number;
  boxes: LaidBox[];
  edges: LaidEdge[];
}

/** Sizes in CSS pixels. Labels are drawn in the code font at FONT_SIZE (about 0.6em per character). */
export const METRICS = {
  fontSize: 13,
  charW: 8,
  lineH: 18,
  padX: 12,
  padY: 9,
  gapY: 28,
  gapX: 32,
  lane: 16,
  margin: 24,
  /** Room above a switch column for its case label. */
  caseDrop: 28,
  /** Parallelogram slant and the predefined process's side bars. */
  skew: 12,
  bar: 10,
} as const;

const M = METRICS;

/** Two different edges running side by side are this far apart at least, or share the line exactly. */
export const CHANNEL = 12;

/** Edge labels: the renderer's 12 px interface font, about 7 px a character. */
const LABEL = { charW: 7, ascent: 10, descent: 3, clear: 2 };

/** The area an edge label covers (its text plus a 2 px clearance), from its anchor point and text. */
export function labelRect(at: { x: number; y: number; anchor: "start" | "end" }, text: string): { x0: number; y0: number; x1: number; y1: number } {
  const w = [...text].length * LABEL.charW;
  const x0 = at.anchor === "start" ? at.x : at.x - w;
  return { x0: x0 - LABEL.clear, y0: at.y - LABEL.ascent - LABEL.clear, x1: x0 + w + LABEL.clear, y1: at.y + LABEL.descent + LABEL.clear };
}
const even = (n: number) => 2 * Math.ceil(n / 2);

/** A box's size from its label lines (and note). */
export function boxSize(node: FlowNode): { w: number; h: number } {
  const lines = node.label.length + (node.note ? 1 : 0);
  const chars = Math.max(1, ...node.label.map((l) => [...l].length), node.note ? [...node.note].length : 0);
  const tw = chars * M.charW;
  const th = Math.max(1, lines) * M.lineH;
  switch (node.kind) {
    case "decision": {
      // A diamond whose half-diagonals a, b hold the text block: (tw/2)/a + (th/2)/b <= 1.
      const b = th / 2 + 16;
      const a = tw / 2 / (1 - th / (2 * b));
      return { w: even(Math.max(112, 2 * a + 8)), h: even(Math.max(56, 2 * b)) };
    }
    case "connector": {
      const d = even(Math.max(32, tw + 14));
      return { w: d, h: d };
    }
    case "start":
    case "end": {
      const h = even(Math.max(36, th + 2 * M.padY));
      return { w: even(Math.max(96, tw + 2 * M.padX + h / 2)), h };
    }
    case "io":
      return { w: even(Math.max(120, tw + 2 * M.padX + 2 * M.skew)), h: even(Math.max(40, th + 2 * M.padY)) };
    case "call":
      return { w: even(Math.max(120, tw + 2 * M.padX + 2 * M.bar)), h: even(Math.max(40, th + 2 * M.padY)) };
    default:
      return { w: even(Math.max(120, tw + 2 * M.padX)), h: even(Math.max(40, th + 2 * M.padY)) };
  }
}

// ---------- frames: each step's size and the relative places of what is inside ----------
// Coordinates inside a frame are relative to its spine (x = 0) and top (y = 0). L and R are how far
// it reaches left and right of the spine, H its height. Control enters at (0, 0) and leaves at (0, H).

interface Box {
  id: number;
  w: number;
  h: number;
}

type Frame = { L: number; R: number; H: number } & (
  | { t: "node"; box: Box; ends: boolean; links: boolean }
  | { t: "seq"; items: { f: Frame; dy: number }[] }
  | { t: "jump"; jump: "break" | "continue" }
  | { t: "if"; variant: "spine" | "split" | "guard"; d: Box; yes: Frame; no: Frame; xYes: number; xNo: number; yYes: number; yNo: number; yJoin: number }
  | {
      t: "loop";
      variant: "pre" | "post" | "forever";
      d: Box | null;
      dTop: number;
      s: Frame;
      sTop: number;
      head: number;
      backY: number;
      xBack: number;
      xExit: number;
      exitY: number;
      orelse: Frame | null;
      oTop: number;
      update: number | null;
    }
  | { t: "switch"; d: Box; cols: { f: Frame; x: number; label: string; exit: "break" | "fall"; colR: number }[]; busY: number; colTop: number; ftY: number; collectY: number }
);

/** Does the frame hold a break or continue anywhere inside it? */
function hasJump(f: Frame): boolean {
  switch (f.t) {
    case "jump":
      return true;
    case "seq":
      return f.items.some((it) => hasJump(it.f));
    case "if":
      return hasJump(f.yes) || hasJump(f.no);
    case "loop":
      return hasJump(f.s) || (f.orelse !== null && hasJump(f.orelse));
    case "switch":
      return f.cols.some((c) => hasJump(c.f));
    default:
      return false;
  }
}

/** Draws nothing and jumps nowhere. */
const isBlank = (f: Frame): boolean => f.t === "seq" && f.items.every((it) => isBlank(it.f));

/** Does control fall out of the bottom of `step` (as opposed to always jumping or ending)? */
function falls(step: Step): boolean {
  switch (step.t) {
    case "end":
    case "break":
    case "continue":
      return false;
    case "goto":
      return step.target === null;
    case "seq": {
      let state = true;
      for (const s of step.items) state = s.t === "label" ? true : state && falls(s);
      return state;
    }
    case "if":
      return falls(step.yes) || falls(step.no);
    default:
      return true;
  }
}

/** True when a step draws nothing and jumps nowhere (an empty branch). */
function blank(step: Step): boolean {
  return step.t === "seq" && step.items.every(blank);
}

class Builder {
  constructor(private readonly sizes: Map<number, { w: number; h: number }>) {}

  private box(id: number): Box {
    const s = this.sizes.get(id)!;
    return { id, w: s.w, h: s.h };
  }

  build(step: Step): Frame {
    switch (step.t) {
      case "node":
      case "end":
      case "label":
      case "goto": {
        const box = this.box(step.id);
        return { t: "node", box, ends: step.t === "end", links: step.t === "goto" && step.target !== null, L: box.w / 2, R: box.w / 2, H: box.h };
      }
      case "break":
      case "continue":
        return { t: "jump", jump: step.t, L: 0, R: 0, H: 0 };
      case "seq":
        return this.seq(step.items.map((s) => this.build(s)));
      case "if":
        return this.ifFrame(step);
      case "loop":
        return this.loop(step);
      case "switch":
        return this.switchFrame(step);
    }
  }

  private seq(frames: Frame[]): Frame {
    const items: { f: Frame; dy: number }[] = [];
    let y = 0;
    // A gap above every drawn item that follows something (a box, or a break whose line starts there).
    let seen = false;
    let L = 0;
    let R = 0;
    for (const f of frames) {
      if (f.H > 0 && seen) y += M.gapY;
      if (!isBlank(f)) seen = true;
      items.push({ f, dy: y });
      y += f.H;
      L = Math.max(L, f.L);
      R = Math.max(R, f.R);
    }
    return { t: "seq", items, L, R, H: y };
  }

  private ifFrame(step: Extract<Step, { t: "if" }>): Frame {
    const d = this.box(step.cond);
    const yes = this.build(step.yes);
    const no = this.build(step.no);
    const hw = d.w / 2;
    if (blank(step.no) && !falls(step.yes)) {
      // Guard: Yes leaves (return, break...) on the right; No carries straight on.
      const pure = yes.H === 0;
      const xYes = pure ? hw : hw + M.gapX / 2 + yes.L;
      const yYes = pure ? d.h / 2 : d.h / 2 + M.gapY / 2;
      const H = Math.max(d.h, pure ? 0 : yYes + yes.H + M.gapY / 2);
      // A bare jump is routed later from the tip, past its "Yes" label: keep room for that run, so
      // an enclosing loop's exit lane passes outside it instead of crossing it.
      const jumpRoom = pure ? hw + labelRect({ x: 0, y: 0, anchor: "start" }, "Yes").x1 + 2 * CHANNEL : hw;
      return { t: "if", variant: "guard", d, yes, no, xYes, xNo: 0, yYes, yNo: d.h, yJoin: H, L: hw, R: Math.max(jumpRoom, xYes + yes.R), H };
    }
    if (blank(step.no)) {
      // No else: Yes straight down the spine, No around the right.
      const yYes = d.h + M.gapY;
      const xNo = Math.max(hw, yes.R) + M.lane;
      const yJoin = yYes + yes.H + M.gapY / 2;
      return { t: "if", variant: "spine", d, yes, no, xYes: 0, xNo, yYes, yNo: yJoin, yJoin, L: Math.max(hw, yes.L), R: xNo, H: yJoin };
    }
    const xYes = -Math.max(hw + M.lane, yes.R + M.gapX / 2);
    const xNo = Math.max(hw + M.lane, no.L + M.gapX / 2);
    const top = d.h + M.gapY / 2;
    const yJoin = top + Math.max(yes.H, no.H) + M.gapY / 2;
    return {
      t: "if",
      variant: "split",
      d,
      yes,
      no,
      xYes,
      xNo,
      yYes: top,
      yNo: top,
      yJoin,
      L: Math.max(hw, -xYes + yes.L),
      R: Math.max(hw, xNo + no.R),
      H: yJoin,
    };
  }

  private loop(step: Extract<Step, { t: "loop" }>): Frame {
    const J = M.gapY / 2;
    const body = this.build(step.body);
    const upd = step.update ? this.build(step.update) : null;
    const s = upd ? this.seq([body, upd]) : body;
    const update = step.update && step.update.t === "node" ? step.update.id : null;
    const orelse = step.orelse ? this.build(step.orelse) : null;
    if (step.post) {
      const d = this.box(step.cond!);
      const hw = d.w / 2;
      const sTop = J;
      const dTop = sTop + s.H + M.gapY;
      const xBack = -(Math.max(hw, s.L) + M.lane);
      const xExit = Math.max(hw, s.R) + M.lane;
      const H = dTop + d.h + M.gapY;
      return { t: "loop", variant: "post", d, dTop, s, sTop, head: 0, backY: 0, xBack, xExit, exitY: H, orelse: null, oTop: 0, update, L: -xBack, R: xExit, H };
    }
    if (step.cond === null) {
      const sTop = J;
      const backY = sTop + s.H + M.gapY / 2;
      const xBack = -(s.L + M.lane);
      const H = backY + M.gapY;
      return { t: "loop", variant: "forever", d: null, dTop: 0, s, sTop, head: 0, backY, xBack, xExit: s.R + M.lane, exitY: H, orelse: null, oTop: 0, update, L: -xBack, R: s.R + M.lane, H };
    }
    const d = this.box(step.cond);
    const hw = d.w / 2;
    const dTop = J;
    const sTop = dTop + d.h + M.gapY;
    const backY = sTop + s.H + M.gapY / 2;
    const xBack = -(Math.max(hw, s.L) + M.lane);
    // A break or continue inside is routed later down the right of the body's boxes (CLEAR past
    // them): the exit lane keeps a channel beyond that run instead of being crossed by it.
    const xExit = Math.max(hw, s.R) + (hasJump(s) ? Math.max(M.lane, CLEAR + CHANNEL) : M.lane);
    const exitY = backY + M.gapY / 2;
    let H = exitY;
    let oTop = 0;
    if (orelse) {
      oTop = exitY + M.gapY;
      H = oTop + orelse.H + M.gapY;
    }
    return { t: "loop", variant: "pre", d, dTop, s, sTop, head: 0, backY, xBack, xExit, exitY, orelse, oTop, update, L: Math.max(-xBack, orelse?.L ?? 0), R: Math.max(xExit, orelse?.R ?? 0), H };
  }

  private switchFrame(step: Extract<Step, { t: "switch" }>): Frame {
    const d = this.box(step.cond);
    const hw = d.w / 2;
    const busY = d.h + M.gapY / 2;
    const colTop = busY + M.caseDrop;
    const raw = step.cases.map((c) => {
      const f = this.build(c.body);
      // The case label sits right of the column's drop line, so the column reaches at least that far.
      const labelW = [...c.label].length * 7 + 10;
      return { f, label: c.label, exit: c.exit, colL: Math.max(f.L, 12), colR: Math.max(f.R, labelW) };
    });
    const total = raw.reduce((n, c) => n + c.colL + c.colR, 0) + M.gapX * (raw.length - 1);
    // Whole pixels, centred under the test; a column whose line would pass within a channel of the
    // switch's own line moves onto it (all columns move together, so their gaps stay).
    let x = Math.round(-total / 2);
    const cols = raw.map((c) => {
      const col = { f: c.f, x: x + c.colL, label: c.label, exit: c.exit, colR: c.colR };
      x += c.colL + c.colR + M.gapX;
      return col;
    });
    const nearest = cols.reduce((a, c) => (Math.abs(c.x) < Math.abs(a.x) ? c : a));
    if (nearest.x !== 0 && Math.abs(nearest.x) < CHANNEL) {
      const shift = nearest.x;
      for (const c of cols) c.x -= shift;
    }
    const maxH = Math.max(0, ...cols.map((c) => c.f.H));
    const ftY = colTop + maxH + M.gapY / 2;
    const collectY = ftY + M.gapY / 2;
    const H = collectY + M.gapY;
    const L = Math.max(hw, ...cols.map((c, i) => -(c.x - raw[i].colL)));
    const R = Math.max(hw, ...cols.map((c) => c.x + c.colR));
    return { t: "switch", d, cols, busY, colTop, ftY, collectY, L, R, H };
  }
}

// ---------- routes ----------

type Dir = "up" | "down" | "left" | "right";

/** Where a break or continue lands: a point (arriving in one direction) or a vertical stretch of a lane. */
type Goal = { t: "point"; x: number; y: number; arrive: Dir } | { t: "vseg"; x: number; y0: number; y1: number };

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A drawn polyline and the box its edge goes to (edges to the same box may share a line). */
interface Owned {
  pts: Point[];
  to: number;
}

/** A fixed run of points, or a search to a goal (inside `region` first, when it has one). */
type Leg = { pts: Point[] } | { goal: Goal; region?: Rect };

interface Route {
  from: number;
  label?: string;
  legs: Leg[];
  labelAt?: LaidEdge["labelAt"];
  /** A switch case: its label goes beside the drop into its column, which ends at this point. */
  labelOnDrop?: Point;
  to?: number;
}

interface LoopCtx {
  /** null for a switch: continue passes through to the loop around it. */
  cont: { goal: Goal; tail: Point[]; target: number } | null;
  breakGoal: Goal;
  breakTail: Point[];
  breaks: Route[];
  /** The frame's area, set on entry. */
  region?: Rect;
}

const last = (r: Route): Point => {
  for (let i = r.legs.length - 1; i >= 0; i--) {
    const leg = r.legs[i];
    if ("pts" in leg && leg.pts.length) return leg.pts[leg.pts.length - 1];
  }
  throw new Error("route without a start");
};

function extend(r: Route, ...pts: Point[]): Route {
  const leg = r.legs[r.legs.length - 1];
  if (leg && "pts" in leg) leg.pts.push(...pts);
  else r.legs.push({ pts: [...pts] });
  return r;
}

/**
 * A label's preferred place as its edge leaves p going `dir`: the first candidate placeLabels tries,
 * and the area the break and continue search keeps clear.
 */
function labelNear(p: Point, dir: Dir): NonNullable<LaidEdge["labelAt"]> {
  switch (dir) {
    case "down":
      return { x: p.x + 6, y: p.y + 14, anchor: "start" };
    case "right":
      return { x: p.x + 4, y: p.y - 6, anchor: "start" };
    case "left":
      return { x: p.x - 4, y: p.y - 6, anchor: "end" };
    default:
      return { x: p.x + 6, y: p.y - 4, anchor: "start" };
  }
}

function start(from: number, p: Point, label?: string, dir?: Dir): Route {
  const r: Route = { from, legs: [{ pts: [p] }] };
  if (label !== undefined) {
    r.label = label;
    r.labelAt = labelNear(p, dir ?? "down");
  }
  return r;
}

class Router {
  readonly done: Route[] = [];
  readonly boxes = new Map<number, LaidBox>();
  private readonly stack: LoopCtx[] = [];

  /** Places every box of `f` (spine x, top y). */
  place(f: Frame, x: number, y: number): void {
    switch (f.t) {
      case "node":
        this.put(f.box, x, y);
        return;
      case "seq":
        for (const it of f.items) this.place(it.f, x, y + it.dy);
        return;
      case "jump":
        return;
      case "if":
        this.put(f.d, x, y);
        this.place(f.yes, x + f.xYes, y + f.yYes);
        if (f.variant === "split") this.place(f.no, x + f.xNo, y + f.yNo);
        return;
      case "loop":
        if (f.d) this.put(f.d, x, y + f.dTop);
        this.place(f.s, x, y + f.sTop);
        if (f.orelse) this.place(f.orelse, x, y + f.oTop);
        return;
      case "switch":
        this.put(f.d, x, y);
        for (const c of f.cols) this.place(c.f, x + c.x, y + f.colTop);
        return;
    }
  }

  private put(b: Box, x: number, y: number) {
    // Kind is filled in by layoutChart.
    this.boxes.set(b.id, { id: b.id, kind: "process", x: x - b.w / 2, y, w: b.w, h: b.h });
  }

  private finish(r: Route, to: number): void {
    r.to = to;
    this.done.push(r);
  }

  /** Ends routes at a box's top: they already end at (x, y), the frame's entry above it. */
  private enter(inc: Route[], id: number): void {
    const b = this.boxes.get(id)!;
    const top = { x: b.x + b.w / 2, y: b.y };
    for (const r of inc) {
      const p = last(r);
      if (p.x !== top.x || p.y !== top.y) extend(r, { x: top.x, y: top.y });
      this.finish(r, id);
    }
  }

  /** Routes the control inside `f`; `inc` ends at (x, y). Returns routes ending at (x, y + f.H). */
  route(f: Frame, x: number, y: number, inc: Route[]): Route[] {
    switch (f.t) {
      case "node": {
        this.enter(inc, f.box.id);
        if (f.ends || f.links) return [];
        return [start(f.box.id, { x, y: y + f.box.h })];
      }
      case "seq": {
        let flow = inc;
        for (const it of f.items) {
          flow = flow.map((r) => (last(r).y === y + it.dy ? r : extend(r, { x, y: y + it.dy })));
          flow = this.route(it.f, x, y + it.dy, flow);
        }
        return flow.map((r) => (last(r).y === y + f.H ? r : extend(r, { x, y: y + f.H })));
      }
      case "jump":
        this.jump(f.jump, inc);
        return [];
      case "if":
        return this.routeIf(f, x, y, inc);
      case "loop":
        return this.routeLoop(f, x, y, inc);
      case "switch":
        return this.routeSwitch(f, x, y, inc);
    }
  }

  /** Enters a loop or switch frame at (x, y): its jumps are searched inside its own area first. */
  private push(ctx: LoopCtx, f: Frame, x: number, y: number): void {
    ctx.region = { x0: x - f.L - 2 * M.lane, y0: y - M.lane, x1: x + f.R + 2 * M.lane, y1: y + f.H + M.lane };
    this.stack.push(ctx);
  }

  private jump(kind: "break" | "continue", inc: Route[]): void {
    if (kind === "break") {
      const ctx = this.stack.at(-1);
      if (!ctx) return;
      for (const r of inc) {
        r.legs.push({ goal: ctx.breakGoal, region: ctx.region }, { pts: [...ctx.breakTail] });
        ctx.breaks.push(r);
      }
      return;
    }
    const ctx = [...this.stack].reverse().find((c) => c.cont !== null);
    if (!ctx) return;
    const cont = ctx.cont!;
    for (const r of inc) {
      r.legs.push({ goal: cont.goal, region: ctx.region });
      if (cont.tail.length) r.legs.push({ pts: [...cont.tail] });
      this.enterAt(r, cont.target);
    }
  }

  /**
   * Ends a route at a box: at its top when the route comes down the spine above it (searching a way
   * there when other boxes are in between, as for a do-while's test that starts a for (;;) because its
   * body begins with a break), else where it already is.
   */
  private enterAt(r: Route, id: number): void {
    const leg = r.legs[r.legs.length - 1];
    if ("pts" in leg && leg.pts.length) {
      const b = this.boxes.get(id)!;
      const p = leg.pts[leg.pts.length - 1];
      const cx = b.x + b.w / 2;
      if (p.x === cx && p.y < b.y) {
        const blocked = [...this.boxes.values()].some((o) => o.id !== id && cx > o.x && cx < o.x + o.w && p.y < o.y + o.h && b.y > o.y);
        if (blocked) r.legs.push({ goal: { t: "point", x: cx, y: b.y, arrive: "down" } });
        else leg.pts.push({ x: cx, y: b.y });
      }
    }
    this.finish(r, id);
  }

  private routeIf(f: Extract<Frame, { t: "if" }>, x: number, y: number, inc: Route[]): Route[] {
    const d = f.d;
    this.enter(inc, d.id);
    const hw = d.w / 2;
    const mid = y + d.h / 2;
    const bottom = { x, y: y + d.h };
    if (f.variant === "guard") {
      const yesIn = start(d.id, { x: x + hw, y: mid }, "Yes", "right");
      if (f.xYes !== hw) extend(yesIn, { x: x + f.xYes, y: mid }, { x: x + f.xYes, y: y + f.yYes });
      const yesOut = this.route(f.yes, x + f.xYes, y + f.yYes, [yesIn]);
      const out = [start(d.id, bottom, "No", "down")];
      if (f.yJoin > d.h) extend(out[0], { x, y: y + f.yJoin });
      // Only if the prediction was wrong (Yes falls through after all): join it below.
      for (const r of yesOut) extend(r, { x: x + f.xYes, y: y + f.yJoin }, { x, y: y + f.yJoin });
      return [...out, ...yesOut];
    }
    if (f.variant === "spine") {
      const yesIn = extend(start(d.id, bottom, "Yes", "down"), { x, y: y + f.yYes });
      const yesOut = this.route(f.yes, x, y + f.yYes, [yesIn]).map((r) => extend(r, { x, y: y + f.yJoin }));
      const noOut = extend(start(d.id, { x: x + hw, y: mid }, "No", "right"), { x: x + f.xNo, y: mid }, { x: x + f.xNo, y: y + f.yJoin }, { x, y: y + f.yJoin });
      return [...yesOut, noOut];
    }
    const yesIn = extend(start(d.id, { x: x - hw, y: mid }, "Yes", "left"), { x: x + f.xYes, y: mid }, { x: x + f.xYes, y: y + f.yYes });
    const noIn = extend(start(d.id, { x: x + hw, y: mid }, "No", "right"), { x: x + f.xNo, y: mid }, { x: x + f.xNo, y: y + f.yNo });
    const join = (r: Route, bx: number) => extend(r, { x: bx, y: y + f.yJoin }, { x, y: y + f.yJoin });
    const yesOut = this.route(f.yes, x + f.xYes, y + f.yYes, [yesIn]).map((r) => join(r, x + f.xYes));
    const noOut = this.route(f.no, x + f.xNo, y + f.yNo, [noIn]).map((r) => join(r, x + f.xNo));
    return [...yesOut, ...noOut];
  }

  private routeLoop(f: Extract<Frame, { t: "loop" }>, x: number, y: number, inc: Route[]): Route[] {
    const J = M.gapY / 2;
    const junction = y + J / 2;
    const back = (r: Route, fromY: number) => extend(r, { x, y: fromY }, { x: x + f.xBack, y: fromY }, { x: x + f.xBack, y: junction }, { x, y: junction }, { x, y: y + J });
    const updateBox = f.update !== null ? this.boxes.get(f.update)! : null;
    const updateGoal = (): { goal: Goal; tail: Point[]; target: number } | null =>
      updateBox ? { goal: { t: "point", x: updateBox.x + updateBox.w, y: updateBox.y + updateBox.h / 2, arrive: "left" }, tail: [], target: f.update! } : null;

    if (f.variant === "post") {
      const d = f.d!;
      const hw = d.w / 2;
      const dTop = y + f.dTop;
      const dMid = dTop + d.h / 2;
      // Yes goes back up the left lane into the top of the body.
      const yes = start(d.id, { x: x - hw, y: dMid }, "Yes", "left");
      extend(yes, { x: x + f.xBack, y: dMid }, { x: x + f.xBack, y: junction }, { x, y: junction }, { x, y: y + f.sTop });
      const entering = inc.map((r) => extend(r, { x, y: y + f.sTop }));
      const ctx: LoopCtx = {
        cont: { goal: { t: "point", x: x + hw, y: dMid, arrive: "left" }, tail: [], target: d.id },
        breakGoal: { t: "vseg", x, y0: dTop + d.h + 6, y1: y + f.H - 2 },
        breakTail: [{ x, y: y + f.H }],
        breaks: [],
      };
      this.push(ctx, f, x, y);
      const bodyOut = this.route(f.s, x, y + f.sTop, [...entering, yes]);
      this.stack.pop();
      for (const r of bodyOut) extend(r, { x, y: dTop });
      this.enter(bodyOut, d.id);
      const no = extend(start(d.id, { x, y: dTop + d.h }, "No", "down"), { x, y: y + f.H });
      return [no, ...ctx.breaks];
    }

    if (f.variant === "forever") {
      const head = this.headOf(f);
      const entering = inc.map((r) => extend(r, { x, y: y + f.sTop }));
      const ctx: LoopCtx = {
        cont: updateGoal() ?? { goal: { t: "vseg", x: x + f.xBack, y0: junction + 4, y1: y + f.backY }, tail: [{ x: x + f.xBack, y: junction }, { x, y: junction }, { x, y: y + J }], target: head },
        breakGoal: { t: "vseg", x, y0: y + f.backY + 8, y1: y + f.H - 2 },
        breakTail: [{ x, y: y + f.H }],
        breaks: [],
      };
      this.push(ctx, f, x, y);
      const bodyOut = this.route(f.s, x, y + f.sTop, entering);
      this.stack.pop();
      for (const r of bodyOut) {
        back(r, y + f.backY);
        this.enterAt(r, head);
      }
      return ctx.breaks;
    }

    const d = f.d!;
    const hw = d.w / 2;
    const dTop = y + f.dTop;
    const dMid = dTop + d.h / 2;
    for (const r of inc) extend(r, { x, y: dTop });
    this.enter(inc, d.id);
    const exitY = y + f.exitY;
    const ctx: LoopCtx = {
      cont: updateGoal() ?? { goal: { t: "vseg", x: x + f.xBack, y0: junction + 4, y1: y + f.backY }, tail: [{ x: x + f.xBack, y: junction }, { x, y: junction }, { x, y: dTop }], target: d.id },
      breakGoal: f.orelse ? { t: "vseg", x, y0: y + f.oTop + f.orelse.H + 8, y1: y + f.H - 2 } : { t: "vseg", x: x + f.xExit, y0: dMid + 8, y1: exitY - 4 },
      breakTail: f.orelse ? [{ x, y: y + f.H }] : [{ x: x + f.xExit, y: exitY }, { x, y: exitY }],
      breaks: [],
    };
    const yes = extend(start(d.id, { x, y: dTop + d.h }, "Yes", "down"), { x, y: y + f.sTop });
    this.push(ctx, f, x, y);
    const bodyOut = this.route(f.s, x, y + f.sTop, [yes]);
    this.stack.pop();
    for (const r of bodyOut) {
      back(r, y + f.backY);
      this.finish(r, d.id);
    }
    let exits = [extend(start(d.id, { x: x + hw, y: dMid }, "No", "right"), { x: x + f.xExit, y: dMid }, { x: x + f.xExit, y: exitY }, { x, y: exitY })];
    if (f.orelse) {
      exits = exits.map((r) => extend(r, { x, y: y + f.oTop }));
      exits = this.route(f.orelse, x, y + f.oTop, exits).map((r) => extend(r, { x, y: y + f.H }));
    }
    return [...exits, ...ctx.breaks];
  }

  /** The first box of a for(;;) body (the model guarantees there is one). */
  private headOf(f: Extract<Frame, { t: "loop" }>): number {
    const first = (fr: Frame): number | null => {
      switch (fr.t) {
        case "node":
          return fr.box.id;
        case "seq":
          for (const it of fr.items) {
            if (it.f.t === "jump") return null;
            const id = first(it.f);
            if (id !== null) return id;
          }
          return null;
        case "if":
        case "switch":
          return fr.d.id;
        case "loop":
          // As the model's entryOf: a do-while whose body starts with a jump starts at its test.
          return fr.variant === "pre" ? fr.d!.id : (first(fr.s) ?? fr.d?.id ?? null);
        default:
          return null;
      }
    };
    return first(f.s)!;
  }

  private routeSwitch(f: Extract<Frame, { t: "switch" }>, x: number, y: number, inc: Route[]): Route[] {
    const d = f.d;
    this.enter(inc, d.id);
    const ctx: LoopCtx = { cont: null, breakGoal: { t: "vseg", x, y0: y + f.collectY + 8, y1: y + f.H - 2 }, breakTail: [{ x, y: y + f.H }], breaks: [] };
    const out: Route[] = [];
    let falling: Route[] = [];
    const colTop = y + f.colTop;
    this.push(ctx, f, x, y);
    f.cols.forEach((c, i) => {
      const cx = x + c.x;
      const drop = { x: cx, y: colTop };
      const r: Route = { from: d.id, label: c.label, labelOnDrop: drop, labelAt: { x: cx + 6, y: colTop - 6, anchor: "start" }, legs: [{ pts: [{ x, y: y + d.h }, { x, y: y + f.busY }, { x: cx, y: y + f.busY }, { x: cx, y: colTop }] }] };
      const colOut = this.route(c.f, cx, colTop, [...falling, r]);
      const bottom = colTop + c.f.H;
      if (c.exit === "fall" && i < f.cols.length - 1) {
        // Into the next case: down below the columns, right through the gap, up and in from the top.
        const gx = cx + c.colR + M.gapX / 2;
        const next = x + f.cols[i + 1].x;
        falling = colOut.map((o) => extend(o, { x: cx, y: y + f.ftY }, { x: gx, y: y + f.ftY }, { x: gx, y: colTop - 6 }, { x: next, y: colTop - 6 }, { x: next, y: colTop }));
      } else {
        falling = [];
        out.push(...colOut.map((o) => (cx === x ? extend(o, { x, y: y + f.H }) : extend(o, { x: cx, y: Math.max(bottom, y + f.collectY) }, { x, y: y + f.collectY }, { x, y: y + f.H }))));
      }
    });
    this.stack.pop();
    return [...out, ...falling, ...ctx.breaks];
  }
}

// ---------- the grid search for break and continue ----------

const CLEAR = 8;
const BEND = 24;
const OVERLAP = 6;
const CROSS = 12;
const MAX_EXPANSIONS = 400_000;

class Grid {
  readonly xs: number[];
  readonly ys: number[];
  private readonly xi = new Map<number, number>();
  private readonly yi = new Map<number, number>();
  /** Blocked steps: vertical from (i, j) to (i, j+1), horizontal from (i, j) to (i+1, j). */
  private readonly vBlock: Uint8Array;
  private readonly hBlock: Uint8Array;
  /** Steps that already carry an edge: 0 none, the edge's target box + 1, or -1 for edges to several targets. */
  private readonly vUsed: Int32Array;
  private readonly hUsed: Int32Array;
  /** Steps running beside an edge, closer than CHANNEL. */
  private readonly vNear: Uint8Array;
  private readonly hNear: Uint8Array;
  /** Search buffers, 8 bytes per (cell, direction), made once per layout. */
  private best: Float32Array | null = null;
  private prev: Int32Array | null = null;
  private touched: number[] = [];

  constructor(
    boxes: LaidBox[],
    fixed: Owned[],
    goals: { from: Point; goal: Goal }[],
    /** The area searched, when not the whole chart: its border is the outer ring. */
    private readonly region?: Rect,
  ) {
    const xs = new Set<number>();
    const ys = new Set<number>();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
      xs.add(b.x - CLEAR).add(b.x + b.w + CLEAR);
      ys.add(b.y - CLEAR).add(b.y + b.h + CLEAR);
      // A box's centre lines carry its ports; a kept-clear label area (id -1) has none.
      if (b.id >= 0) {
        xs.add(b.x + b.w / 2);
        ys.add(b.y + b.h / 2);
      }
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + b.w);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y + b.h);
    }
    for (const line of fixed)
      for (const p of line.pts) {
        xs.add(p.x);
        ys.add(p.y);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    for (const { from, goal } of goals) {
      xs.add(from.x);
      ys.add(from.y);
      xs.add(goal.x);
      if (goal.t === "point") ys.add(goal.y);
      else ys.add(goal.y0).add(goal.y1);
    }
    // An outer ring, so there is (nearly always) a way around.
    if (region) {
      xs.add(region.x0).add(region.x1);
      ys.add(region.y0).add(region.y1);
    } else {
      xs.add(minX - 2 * M.lane).add(maxX + 2 * M.lane);
      ys.add(minY - M.lane).add(maxY + M.lane);
    }
    this.xs = [...xs].sort((a, b) => a - b);
    this.ys = [...ys].sort((a, b) => a - b);
    this.xs.forEach((v, i) => this.xi.set(v, i));
    this.ys.forEach((v, i) => this.yi.set(v, i));
    const n = this.xs.length * this.ys.length;
    this.vBlock = new Uint8Array(n);
    this.hBlock = new Uint8Array(n);
    this.vUsed = new Int32Array(n);
    this.hUsed = new Int32Array(n);
    this.vNear = new Uint8Array(n);
    this.hNear = new Uint8Array(n);
    for (const b of boxes) this.block(b);
    for (const line of fixed) for (let i = 1; i < line.pts.length; i++) this.use(line.pts[i - 1], line.pts[i], line.to);
  }

  private idx(i: number, j: number) {
    return j * this.xs.length + i;
  }

  /** Lowest index whose value is >= v. */
  private static lower(arr: number[], v: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** A box blocks every step that would run through it or along its border. */
  private block(b: LaidBox) {
    const { xs, ys } = this;
    const i0 = Grid.lower(xs, b.x);
    const i1 = Grid.lower(xs, b.x + b.w + 0.001);
    const j0 = Grid.lower(ys, b.y);
    const j1 = Grid.lower(ys, b.y + b.h + 0.001);
    // Vertical steps on lines with b.x <= x <= b.x + w whose span overlaps (top, bottom).
    for (let i = i0; i < i1; i++) {
      for (let j = Math.max(0, j0 - 1); j < Math.min(ys.length - 1, j1); j++) {
        if (ys[j] < b.y + b.h && ys[j + 1] > b.y) this.vBlock[this.idx(i, j)] = 1;
      }
    }
    for (let j = j0; j < j1; j++) {
      for (let i = Math.max(0, i0 - 1); i < Math.min(xs.length - 1, i1); i++) {
        if (xs[i] < b.x + b.w && xs[i + 1] > b.x) this.hBlock[this.idx(i, j)] = 1;
      }
    }
  }

  /**
   * Marks the grid steps an edge segment runs along, and as "near" the parallel steps less than
   * CHANNEL px beside it (a careful search never takes those: two edges either share a line or keep
   * a readable channel between them).
   */
  private use(p: Point, q: Point, to: number) {
    const { xs, ys } = this;
    const vertical = p.x === q.x;
    if (!vertical && p.y !== q.y) return;
    const at = vertical ? p.x : p.y;
    const lines = vertical ? xs : ys;
    const along = vertical ? ys : xs;
    const lo = Math.min(vertical ? p.y : p.x, vertical ? q.y : q.x);
    const hi = Math.max(vertical ? p.y : p.x, vertical ? q.y : q.x);
    // Steps (k to k+1) along the segment whose span overlaps (lo, hi).
    const first = Math.max(0, Grid.lower(along, lo + 0.001) - 1);
    const last = Grid.lower(along, hi - 0.001);
    for (let l = Grid.lower(lines, at - CHANNEL + 0.001); l < lines.length && lines[l] < at + CHANNEL; l++) {
      const same = lines[l] === at;
      for (let k = first; k < last && k < along.length - 1; k++) {
        if (along[k + 1] <= lo || along[k] >= hi) continue;
        const step = vertical ? this.idx(l, k) : this.idx(k, l);
        if (same) {
          const used = vertical ? this.vUsed : this.hUsed;
          used[step] = used[step] === 0 || used[step] === to + 1 ? to + 1 : -1;
        } else {
          (vertical ? this.vNear : this.hNear)[step] = 1;
        }
      }
    }
  }

  /** Records a found path so later searches avoid running along it. */
  record(path: Point[], to: number) {
    for (const line of this.region ? clipLine(path, this.region) : [path]) for (let i = 1; i < line.length; i++) this.use(line[i - 1], line[i], to);
  }

  /** Whether a point is a grid crossing (inside the area) the search can start or end at. */
  has(p: Point): boolean {
    return this.xi.has(p.x) && this.yi.has(p.y);
  }

  /**
   * Cheapest orthogonal path from `from` to the goal that crosses no box, or null. `heading` is the
   * direction the line was already going: going on costs no bend and turning straight back is not allowed.
   */
  search(
    from: Point,
    goal: Goal,
    heading: Dir | null,
    to: number,
    { weight = 1.5, plain = false, keepChannel = true }: { weight?: number; plain?: boolean; keepChannel?: boolean } = {},
  ): Point[] | null {
    const { xs, ys } = this;
    const W = xs.length;
    if (!this.has(from) || !this.xi.has(goal.x)) return null;
    const si = this.xi.get(from.x)!;
    const sj = this.yi.get(from.y)!;
    const gi = this.xi.get(goal.x)!;
    const DIRS: { di: number; dj: number; d: Dir }[] = [
      { di: 0, dj: -1, d: "up" },
      { di: 0, dj: 1, d: "down" },
      { di: -1, dj: 0, d: "left" },
      { di: 1, dj: 0, d: "right" },
    ];
    const dirIndex = { up: 0, down: 1, left: 2, right: 3 } as const;
    const reached = (i: number, j: number, d: number): boolean => {
      if (i !== gi) return false;
      if (goal.t === "point") return ys[j] === goal.y && d === dirIndex[goal.arrive];
      return ys[j] >= goal.y0 && ys[j] <= goal.y1 && (d === 2 || d === 3);
    };
    const h = (i: number, j: number) => {
      const dx = Math.abs(xs[i] - goal.x);
      const y = ys[j];
      const dy = goal.t === "point" ? Math.abs(y - goal.y) : y < goal.y0 ? goal.y0 - y : y > goal.y1 ? y - goal.y1 : 0;
      return dx + dy;
    };
    // States: (cell, direction of the last move); 4 = none yet. The buffers are shared by every
    // search on this grid; only the states a search touched are reset afterwards.
    const S = W * ys.length * 5;
    if (!this.best) {
      // Float32 is exact for these costs (whole pixels, far below 2^24) and halves the memory.
      this.best = new Float32Array(S).fill(Infinity);
      this.prev = new Int32Array(S).fill(-1);
    }
    for (const t of this.touched) {
      this.best[t] = Infinity;
      this.prev![t] = -1;
    }
    this.touched = [];
    const best = this.best;
    const prev = this.prev!;
    const touched = this.touched;
    const heap = new MinHeap();
    const s0 = (sj * W + si) * 5 + (heading ? dirIndex[heading] : 4);
    best[s0] = 0;
    touched.push(s0);
    heap.push(weight * h(si, sj), 0, s0);
    let expansions = 0;
    while (heap.size) {
      const [, g, s] = heap.pop();
      if (g > best[s]) continue;
      const cell = Math.floor(s / 5);
      const d = s % 5;
      const i = cell % W;
      const j = Math.floor(cell / W);
      if (d !== 4 && reached(i, j, d)) return this.path(prev, s, W);
      if (++expansions > MAX_EXPANSIONS) return null;
      for (let k = 0; k < 4; k++) {
        const { di, dj } = DIRS[k];
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= ys.length) continue;
        // No going straight back.
        if (d !== 4 && ((d === 0 && k === 1) || (d === 1 && k === 0) || (d === 2 && k === 3) || (d === 3 && k === 2))) continue;
        const vertical = di === 0;
        const step = vertical ? this.idx(i, Math.min(j, nj)) : this.idx(Math.min(i, ni), j);
        if (vertical ? this.vBlock[step] : this.hBlock[step]) continue;
        if (keepChannel && (vertical ? this.vNear[step] : this.hNear[step])) continue;
        const len = vertical ? Math.abs(ys[nj] - ys[j]) : Math.abs(xs[ni] - xs[i]);
        let cost = len;
        if (d !== 4 && d !== k) cost += BEND;
        if (!plain) {
          // Running along another edge costs extra, unless it goes to the same box: then the two join.
          const used = vertical ? this.vUsed[step] : this.hUsed[step];
          if (used !== 0 && used !== to + 1) cost += len * OVERLAP;
          // Crossing an edge that runs the other way at the cell we arrive at.
          const crossing = vertical
            ? (ni > 0 && this.hUsed[this.idx(ni - 1, nj)]) || (ni < W - 1 && this.hUsed[this.idx(ni, nj)])
            : (nj > 0 && this.vUsed[this.idx(ni, nj - 1)]) || (nj < ys.length - 1 && this.vUsed[this.idx(ni, nj)]);
          if (crossing) cost += CROSS;
        }
        const ns = (nj * W + ni) * 5 + k;
        const ng = g + cost;
        if (ng < best[ns]) {
          if (best[ns] === Infinity) touched.push(ns);
          best[ns] = ng;
          prev[ns] = s;
          heap.push(ng + weight * h(ni, nj), ng, ns);
        }
      }
    }
    return null;
  }

  private path(prev: Int32Array, end: number, W: number): Point[] {
    const pts: Point[] = [];
    for (let s = end; s !== -1; s = prev[s]) {
      const cell = Math.floor(s / 5);
      pts.push({ x: this.xs[cell % W], y: this.ys[Math.floor(cell / W)] });
    }
    return pts.reverse();
  }
}

/** A binary min-heap of (priority, cost, state); ties go to the earlier push, so the search is deterministic. */
class MinHeap {
  private f: number[] = [];
  private g: number[] = [];
  private s: number[] = [];
  private seq: number[] = [];
  private n = 0;
  get size() {
    return this.f.length;
  }
  private less(a: number, b: number) {
    return this.f[a] < this.f[b] || (this.f[a] === this.f[b] && this.seq[a] < this.seq[b]);
  }
  private swap(a: number, b: number) {
    for (const arr of [this.f, this.g, this.s, this.seq]) [arr[a], arr[b]] = [arr[b], arr[a]];
  }
  push(f: number, g: number, s: number) {
    this.f.push(f);
    this.g.push(g);
    this.s.push(s);
    this.seq.push(this.n++);
    let i = this.f.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, number] {
    const top: [number, number, number] = [this.f[0], this.g[0], this.s[0]];
    const lastIndex = this.f.length - 1;
    this.swap(0, lastIndex);
    this.f.pop();
    this.g.pop();
    this.s.pop();
    this.seq.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.f.length && this.less(l, m)) m = l;
      if (r < this.f.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** The parts of an orthogonal polyline inside a rectangle, one segment each. */
function clipLine(line: Point[], r: Rect): Point[][] {
  const out: Point[][] = [];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  for (let i = 1; i < line.length; i++) {
    const [p, q] = [line[i - 1], line[i]];
    if (p.x === q.x) {
      if (p.x < r.x0 || p.x > r.x1) continue;
      const a = clamp(Math.min(p.y, q.y), r.y0, r.y1);
      const b = clamp(Math.max(p.y, q.y), r.y0, r.y1);
      if (b > a) out.push([{ x: p.x, y: a }, { x: p.x, y: b }]);
    } else {
      if (p.y < r.y0 || p.y > r.y1) continue;
      const a = clamp(Math.min(p.x, q.x), r.x0, r.x1);
      const b = clamp(Math.max(p.x, q.x), r.x0, r.x1);
      if (b > a) out.push([{ x: a, y: p.y }, { x: b, y: p.y }]);
    }
  }
  return out;
}

/** Drops repeated points and the middle of straight runs. */
function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q.x === p.x && q.y === p.y) continue;
    out.push({ x: p.x, y: p.y });
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      if ((a.x === b.x && b.x === c.x && (b.y - a.y) * (c.y - b.y) >= 0) || (a.y === b.y && b.y === c.y && (b.x - a.x) * (c.x - b.x) >= 0)) out.splice(-2, 1);
      else break;
    }
  }
  return out;
}

/** The layout of one chart: positioned boxes and routed edges, in pixels from the top-left. */
export function layoutChart(chart: FlowChart): Layout {
  const sizes = new Map(chart.nodes.map((n) => [n.id, boxSize(n)]));
  const frame = new Builder(sizes).build(chart.body);
  const router = new Router();
  const x0 = frame.L + M.margin;
  router.place(frame, x0, M.margin);
  router.route(frame, x0, M.margin, []);

  // Fixed legs first; then each break and continue, in order, avoiding what is already drawn.
  const kindOf = new Map(chart.nodes.map((n) => [n.id, n.kind]));
  const boxes = [...router.boxes.values()].map((b) => Object.assign(b, { kind: kindOf.get(b.id)! }));
  const fixed: Owned[] = [];
  const searches: { from: Point; goal: Goal }[] = [];
  for (const r of router.done) {
    let at: Point | null = null;
    const to = r.to!;
    for (const leg of r.legs) {
      if ("pts" in leg) {
        // A fixed run after a search starts where the search arrives, unknown yet: it joins at its own start.
        fixed.push({ pts: at ? [at, ...leg.pts] : leg.pts, to });
        if (leg.pts.length) at = leg.pts[leg.pts.length - 1];
      } else {
        if (at) searches.push({ from: at, goal: leg.goal });
        at = null;
        // A lane the search may join is taken as drawn along its whole length: other edges keep their
        // channel from all of it.
        if (leg.goal.t === "vseg") fixed.push({ pts: [{ x: leg.goal.x, y: leg.goal.y0 }, { x: leg.goal.x, y: leg.goal.y1 }], to });
      }
    }
  }
  const lines = fixed.map((l) => ({ pts: simplify(l.pts), to: l.to })).filter((l) => l.pts.length > 1);
  // Each label's preferred place is kept clear of the searched edges, so the label fits there.
  const reserved: LaidBox[] = router.done.flatMap((r) => {
    if (r.label === undefined || !r.labelAt) return [];
    const q = labelRect(r.labelAt, r.label);
    return [{ id: -1, kind: "process" as const, x: q.x0, y: q.y0, w: q.x1 - q.x0, h: q.y1 - q.y0 }];
  });
  const found: Owned[] = [];
  // One grid per loop area (small, so the search's memory stays small), and one for the whole chart.
  const grids = new Map<string, Grid>();
  const gridFor = (region: Rect | undefined): Grid => {
    const key = region ? `${region.x0},${region.y0},${region.x1},${region.y1}` : "all";
    let g = grids.get(key);
    if (!g) {
      const inside = (p: Point) => !region || (p.x >= region.x0 && p.x <= region.x1 && p.y >= region.y0 && p.y <= region.y1);
      const meets = (b: LaidBox) => !region || (b.x < region.x1 && b.x + b.w > region.x0 && b.y < region.y1 && b.y + b.h > region.y0);
      const clip = (l: Owned): Owned[] => (region ? clipLine(l.pts, region).map((pts) => ({ pts, to: l.to })) : [l]);
      g = new Grid(
        [...boxes, ...reserved].filter(meets),
        [...lines, ...found].flatMap(clip),
        searches.filter((s) => inside(s.from)),
        region,
      );
      grids.set(key, g);
    }
    return g;
  };
  const kinds = new Map<string, EdgeKind[]>();
  for (const e of chart.edges) {
    const k = `${e.from}>${e.to}>${e.label ?? ""}`;
    kinds.set(k, [...(kinds.get(k) ?? []), e.kind]);
  }
  const edges: LaidEdge[] = router.done.map((r) => {
    const pts: Point[] = [];
    for (const leg of r.legs) {
      if ("pts" in leg) {
        // After a search, the next fixed leg starts where the search arrived (on the same line).
        pts.push(...leg.pts);
        continue;
      }
      const from = pts[pts.length - 1];
      const dir = heading(pts);
      // Inside the loop's own area first; then the whole chart; then a greedier search that only
      // keeps the channel between edges; then one that may squeeze beside them (very large charts).
      const local = leg.region ? gridFor(leg.region) : null;
      const all = () => gridFor(undefined);
      const to = r.to!;
      const path =
        local?.search(from, leg.goal, dir, to) ??
        all().search(from, leg.goal, dir, to) ??
        all().search(from, leg.goal, dir, to, { weight: 4, plain: true }) ??
        all().search(from, leg.goal, dir, to, { weight: 4, plain: true, keepChannel: false }) ??
        fallback(from, leg.goal);
      found.push({ pts: path, to });
      for (const g of grids.values()) g.record(path, to);
      pts.push(...path.slice(1));
    }
    const k = `${r.from}>${r.to}>${r.label ?? ""}`;
    const kind = kinds.get(k)?.shift() ?? "flow";
    const edge: LaidEdge = { from: r.from, to: r.to!, kind, points: simplify(pts) };
    if (r.label !== undefined) edge.label = r.label;
    if (r.labelAt) edge.labelAt = r.labelAt;
    return edge;
  });
  placeLabels(edges, boxes, new Map(router.done.flatMap((r, i) => (r.labelOnDrop ? [[i, r.labelOnDrop] as const] : []))));

  // Move everything so the top-left corner is (margin, margin).
  const allPts = edges.flatMap((e) => e.points);
  const rects = edges.flatMap((e) => (e.label !== undefined && e.labelAt ? [labelRect(e.labelAt, e.label)] : []));
  const minX = Math.min(...boxes.map((b) => b.x), ...allPts.map((p) => p.x), ...rects.map((r) => r.x0));
  const minY = Math.min(...boxes.map((b) => b.y), ...allPts.map((p) => p.y), ...rects.map((r) => r.y0));
  const dx = M.margin - minX;
  const dy = M.margin - minY;
  const outBoxes = boxes
    .map((b) => ({ ...b, x: b.x + dx, y: b.y + dy }))
    .sort((a, b) => a.id - b.id);
  const outEdges = edges.map((e) => {
    const moved: LaidEdge = { ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    if (e.labelAt) moved.labelAt = { ...e.labelAt, x: e.labelAt.x + dx, y: e.labelAt.y + dy };
    return moved;
  });
  const outRects = outEdges.flatMap((e) => (e.label !== undefined && e.labelAt ? [labelRect(e.labelAt, e.label)] : []));
  const maxX = Math.max(...outBoxes.map((b) => b.x + b.w), ...outEdges.flatMap((e) => e.points.map((p) => p.x)), ...outRects.map((r) => r.x1));
  const maxY = Math.max(...outBoxes.map((b) => b.y + b.h), ...outEdges.flatMap((e) => e.points.map((p) => p.y)), ...outRects.map((r) => r.y1));
  return { width: Math.ceil(maxX + M.margin), height: Math.ceil(maxY + M.margin), boxes: outBoxes, edges: outEdges };
}

type Rect4 = { x0: number; y0: number; x1: number; y1: number };

/** Does a rectangle meet the drawn shape of a box? A decision is its diamond, every other box its rectangle. */
export function rectMeetsBox(r: Rect4, b: { kind: NodeKind; x: number; y: number; w: number; h: number }): boolean {
  if (!(r.x0 < b.x + b.w && b.x < r.x1 && r.y0 < b.y + b.h && b.y < r.y1)) return false;
  if (b.kind !== "decision") return true;
  // |dx|/a + |dy|/b < 1 inside the diamond; its smallest value over the rectangle is at the point
  // of the rectangle nearest the centre.
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const nx = Math.min(Math.max(cx, r.x0), r.x1);
  const ny = Math.min(Math.max(cy, r.y0), r.y1);
  return Math.abs(nx - cx) / (b.w / 2) + Math.abs(ny - cy) / (b.h / 2) < 1;
}

/** Places each edge label where it touches no box, no edge (its own included) and no other label. */
function placeLabels(edges: LaidEdge[], boxes: LaidBox[], onDrop: Map<number, Point>): void {
  const segs = edges.flatMap((e) => e.points.slice(1).map((q, i) => ({ p: e.points[i], q })));
  const placed: Rect4[] = [];
  const meets = (r: Rect4, x0: number, y0: number, x1: number, y1: number) => r.x0 < x1 && x0 < r.x1 && r.y0 < y1 && y0 < r.y1;
  const hits = (r: Rect4) => {
    let n = 0;
    for (const b of boxes) if (rectMeetsBox(r, b)) n++;
    for (const { p, q } of segs) if (meets(r, Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x) + 0.01, Math.max(p.y, q.y) + 0.01)) n++;
    for (const o of placed) if (meets(r, o.x0, o.y0, o.x1, o.y1)) n++;
    return n;
  };
  edges.forEach((e, i) => {
    if (e.label === undefined) return;
    const text = e.label;
    // Along the edge's first segment (a decision's Yes or No as it leaves the box), or its last one
    // (a switch case on the drop into its column, since the cases share their first segments).
    // When the first segment is too short to hold the label, the second one is tried too. A case
    // label sits just above its column, between the bus and the column's top.
    const drop = onDrop.get(i);
    const candidates: NonNullable<LaidEdge["labelAt"]>[] = drop
      ? [
          { x: drop.x + 6, y: drop.y - 6, anchor: "start" },
          { x: drop.x - 6, y: drop.y - 6, anchor: "end" },
        ]
      : [];
    const runs: [Point, Point][] = drop ? [] : e.points.slice(1, 3).map((q, k) => [e.points[k], q]);
    for (const [p, q] of runs) {
      const len = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      for (const t of [4, 16, 28, 40, 52]) {
        if (t > len + 12) break;
        if (p.x === q.x) {
          const down = q.y > p.y;
          const y = down ? p.y + t + 10 : p.y - t;
          candidates.push({ x: p.x + 6, y, anchor: "start" }, { x: p.x - 6, y, anchor: "end" });
        } else {
          const right = q.x > p.x;
          const x = right ? p.x + t : p.x - t;
          const anchor = right ? "start" : "end";
          candidates.push({ x, y: p.y - 6, anchor }, { x, y: p.y + 16, anchor });
        }
      }
    }
    let best = candidates[0] ?? e.labelAt!;
    let bestHits = Infinity;
    for (const c of candidates) {
      const h = hits(labelRect(c, text));
      if (h < bestHits) [best, bestHits] = [c, h];
      if (h === 0) break;
    }
    e.labelAt = best;
    placed.push(labelRect(best, text));
  });
}

/** The direction of a polyline's last non-empty segment. */
function heading(pts: Point[]): Dir | null {
  const end = pts[pts.length - 1];
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i];
    if (p.x === end.x && p.y === end.y) continue;
    if (p.x === end.x) return end.y > p.y ? "down" : "up";
    return end.x > p.x ? "right" : "left";
  }
  return null;
}

/** Used only if the search gives up: an L-shaped line (the layout tests would flag it crossing a box). */
function fallback(from: Point, goal: Goal): Point[] {
  const gy = goal.t === "point" ? goal.y : Math.min(Math.max(from.y, goal.y0), goal.y1);
  return [from, { x: from.x, y: gy }, { x: goal.x, y: gy }];
}
