// The About page's Living Graph (redesign 9, the owner's pick 2026-11-17; reference page
// .claude/design/redesign9/c/final.html). The hero: sum_evens's code lifts and folds into its
// flowchart's nodes (FLIP, transform only), the edges draw in (stroke-dashoffset), then Run sends a
// pulse along the path the program took and leaves pass counts. A stepper walks the run by buttons
// and keys; nodes can be dragged or nudged a little and spring back. Below: the features graph's
// spine and the editor drawing. Under reduced motion nothing plays by itself: the final state, and
// the stepper still works. Everything is built with createElement(NS) and textContent, never markup.
// The stage says its state in data-phase (idle, fold, edges, ready, run, done), data-step and
// data-playing, which the end-to-end tests wait on.
import {
  EDGES,
  EDGE_LABEL,
  KIND,
  LANGS,
  LAST,
  NODES,
  OUTPUT,
  STATES,
  TRACE,
  allLabels,
  describeNode,
  labelsOf,
  nodeOfLine,
  readout,
  runLabel,
  springStep,
  stepFor,
  tabFor,
  type EdgeId,
  type Kind,
  type Spring,
  type Lang,
  type LangId,
  type NodeId,
} from "./living-graph";

const NS = "http://www.w3.org/2000/svg";
const TIMES = String.fromCodePoint(0xd7);
const DOT = String.fromCodePoint(0xb7);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const motionOK = () => !reducedMotion.matches;

// ---------------------------------------------------------------- geometry (chart units)
const CX = 245;
const FS = 12.5;
const CY: Readonly<Record<NodeId, number>> = { start: 26, init: 90, loop: 166, test: 274, add: 380, out: 454, end: 520 };
const HH: Readonly<Record<NodeId, number>> = { start: 34, init: 40, loop: 46, test: 96, add: 40, out: 40, end: 34 };
const VBH = 548;
/** How far a node may be dragged from home. */
const MAXOFF = 18;
const FOLD_IDS = ["init", "loop", "test", "add", "out"] as const;
const SPRING = "cubic-bezier(0.34, 1.45, 0.64, 1)";

type Pt = [number, number];

function mk<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v));
  if (parent) parent.append(e);
  return e;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const r2 = (v: number) => Math.round(v * 100) / 100;

/** An orthogonal path through `p` with rounded corners. */
function ortho(p: Pt[], rad: number): string {
  let d = `M${r2(p[0][0])} ${r2(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < 0.01 || l2 < 0.01) continue;
    const rr = Math.min(rad, l1 / 2, l2 / 2);
    const p1 = [b[0] - ((b[0] - a[0]) / l1) * rr, b[1] - ((b[1] - a[1]) / l1) * rr];
    const p2 = [b[0] + ((c[0] - b[0]) / l2) * rr, b[1] + ((c[1] - b[1]) / l2) * rr];
    d += ` L${r2(p1[0])} ${r2(p1[1])} Q${r2(b[0])} ${r2(b[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  const z = p[p.length - 1];
  return `${d} L${r2(z[0])} ${r2(z[1])}`;
}

function shapePts(kind: Kind, cx: number, cy: number, w: number, h: number): Pt[] {
  const x = cx - w / 2;
  const y = cy - h / 2;
  if (kind === "loop") return [[x + 16, y], [x + w - 16, y], [x + w, cy], [x + w - 16, y + h], [x + 16, y + h], [x, cy]];
  if (kind === "dec") return [[cx, y], [x + w, cy], [cx, y + h], [x, cy]];
  return [[x + 12, y], [x + w, y], [x + w - 12, y + h], [x, y + h]];
}
function shapeEl(kind: Kind, cx: number, cy: number, w: number, h: number, cls: string, parent: Element): SVGElement {
  const x = cx - w / 2;
  const y = cy - h / 2;
  if (kind === "term") return mk("rect", { x, y, width: w, height: h, rx: h / 2, class: cls }, parent);
  if (kind === "proc") return mk("rect", { x, y, width: w, height: h, rx: 7, class: cls }, parent);
  return mk("polygon", { points: shapePts(kind, cx, cy, w, h).map((q) => `${r2(q[0])},${r2(q[1])}`).join(" "), class: cls }, parent);
}

// ---------------------------------------------------------------- the chart
interface GraphConfig {
  prefix: string;
  interactive: boolean;
  /** The id of the text that says how to move a node (interactive charts). */
  hintId?: string;
  dragEnabled?: () => boolean;
  lineOf?: (id: NodeId) => number;
  onActivate?: (id: NodeId) => void;
}
interface Offset extends Spring {
  raf: number;
}
interface NodeRec {
  g: SVGGElement;
  body: SVGGElement;
  lbl: SVGTextElement;
  badge: SVGGElement;
  bt: SVGTextElement;
}
interface EdgeRec {
  g: SVGGElement;
  draw: SVGPathElement;
  base: SVGPathElement;
  hot: SVGPathElement;
  label: SVGTextElement | null;
  count: SVGTSpanElement | null;
  d: string;
}
interface Base {
  kind: Kind;
  cx: number;
  cy: number;
  w: number;
  h: number;
}
interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  l: number;
  r: number;
  t: number;
  b: number;
  rmid: number;
}
interface Travel {
  eid: EdgeId;
  onDone: () => void;
  raf: number;
  t0: number;
}

/** Constant speed in the middle, eased in and out over the first and last fifth. */
function trap(t: number): number {
  const a = 0.2;
  const v = 1 / (1 - a);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < a) return (v * t * t) / (2 * a);
  if (t < 1 - a) return v * (a / 2 + (t - a));
  return 1 - (v * (1 - t) * (1 - t)) / (2 * a);
}

export type Graph = ReturnType<typeof makeGraph>;

export function makeGraph(svg: SVGSVGElement, cfg: GraphConfig) {
  const { prefix, interactive } = cfg;
  const defs = mk("defs", {}, svg);
  for (const [id, cls] of [["ai", "arr-idle"], ["ah", "arr-hot"]] as const) {
    const marker = mk("marker", { id: `${prefix}-${id}`, viewBox: "0 0 8 8", refX: 4, refY: 4, markerWidth: 8, markerHeight: 8, markerUnits: "userSpaceOnUse", orient: "auto" }, defs);
    mk("path", { d: "M0 0 L8 4 L0 8 Z", class: cls }, marker);
  }
  const glow = mk("filter", { id: `${prefix}-glow`, x: "-60%", y: "-60%", width: "220%", height: "220%" }, defs);
  mk("feGaussianBlur", { stdDeviation: 7 }, glow);
  const glowS = mk("filter", { id: `${prefix}-glowS`, x: "-100%", y: "-100%", width: "300%", height: "300%" }, defs);
  mk("feGaussianBlur", { stdDeviation: 4 }, glowS);

  const edgeLayer = mk("g", { class: "edges" }, svg);
  const tailA = mk("path", { class: "tail tail-a" }, svg);
  const tailB = mk("path", { class: "tail tail-b" }, svg);
  const nodeLayer = mk("g", { class: "nodes" }, svg);
  const pulse = mk("g", { class: "pulse" }, svg);
  mk("circle", { r: 12, class: "p-halo", filter: `url(#${prefix}-glowS)` }, pulse);
  mk("circle", { r: 5, class: "p-core" }, pulse);

  const base = {} as Record<NodeId, Base>;
  const off = {} as Record<NodeId, Offset>;
  const N = {} as Record<NodeId, NodeRec>;
  const E = {} as Record<EdgeId, EdgeRec>;
  const adj = {} as Record<NodeId, EdgeId[]>;
  const lanes = { no: 0, add: 0, top: 0, right: 0 };
  let labels = labelsOf(LANGS.py);
  for (const id of NODES) {
    off[id] = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0 };
    adj[id] = [];
  }
  for (const eid of EDGES) {
    const [a, b] = eid.split(">") as [NodeId, NodeId];
    adj[a].push(eid);
    if (!adj[b].includes(eid)) adj[b].push(eid);
  }

  function box(id: NodeId): Box {
    const b = base[id];
    const o = off[id];
    const cx = b.cx + o.x;
    const cy = b.cy + o.y;
    return { cx, cy, w: b.w, h: b.h, l: cx - b.w / 2, r: cx + b.w / 2, t: cy - b.h / 2, b: cy + b.h / 2, rmid: cx + b.w / 2 - (b.kind === "io" ? 6 : 0) };
  }
  function vert(a: NodeId, b: NodeId): Pt[] {
    const A = box(a);
    const B = box(b);
    if (Math.abs(A.cx - B.cx) < 0.5) return [[A.cx, A.b], [B.cx, B.t - 4]];
    const mid = (A.b + B.t) / 2;
    return [[A.cx, A.b], [A.cx, mid], [B.cx, mid], [B.cx, B.t - 4]];
  }
  const ROUTES: Record<EdgeId, () => Pt[]> = {
    "start>init": () => vert("start", "init"),
    "init>loop": () => vert("init", "loop"),
    "loop>test": () => vert("loop", "test"),
    "test>add": () => vert("test", "add"),
    "out>end": () => vert("out", "end"),
    // "no" leaves the diamond's left corner and re-enters the loop's left corner on an inner lane.
    "test>loop": () => {
      const t = box("test");
      const l = box("loop");
      return [[t.l, t.cy], [lanes.no, t.cy], [lanes.no, l.cy], [l.l - 4, l.cy]];
    },
    // The add step returns on an outer lane, over the top, into the loop's upper edge.
    "add>loop": () => {
      const a = box("add");
      const l = box("loop");
      const ex = l.l + 30;
      return [[a.l, a.cy], [lanes.add, a.cy], [lanes.add, lanes.top], [ex, lanes.top], [ex, l.t - 4]];
    },
    // "done" leaves the loop's right corner and comes down the right lane into the output.
    "loop>out": () => {
      const l = box("loop");
      const o = box("out");
      return [[l.r, l.cy], [lanes.right, l.cy], [lanes.right, o.cy], [o.rmid + 4, o.cy]];
    },
  };
  function labelPos(eid: EdgeId): { x: number; y: number; anchor: string } {
    if (eid === "loop>test") {
      const [l, t] = [box("loop"), box("test")];
      return { x: l.cx + 10, y: (l.b + t.t) / 2 + 4, anchor: "start" };
    }
    if (eid === "test>add") {
      const [t, a] = [box("test"), box("add")];
      return { x: t.cx + 10, y: (t.b + a.t) / 2 + 4, anchor: "start" };
    }
    if (eid === "test>loop") {
      const t = box("test");
      return { x: (t.l + lanes.no) / 2, y: t.cy - 7, anchor: "middle" };
    }
    const [l, o] = [box("loop"), box("out")];
    return { x: lanes.right + 8, y: (l.cy + o.cy) / 2 + 4, anchor: "start" };
  }
  function routeEdge(eid: EdgeId): void {
    const rec = E[eid];
    const d = ortho(ROUTES[eid](), 10);
    rec.d = d;
    for (const p of [rec.draw, rec.base, rec.hot]) p.setAttribute("d", d);
    if (rec.label) {
      const p = labelPos(eid);
      rec.label.setAttribute("x", String(r2(p.x)));
      rec.label.setAttribute("y", String(r2(p.y)));
      rec.label.setAttribute("text-anchor", p.anchor);
    }
  }

  function measure(text: string): number {
    const t = mk("text", { x: 0, y: -100, class: "lbl" }, nodeLayer);
    t.textContent = text;
    let w = 0;
    try {
      w = t.getComputedTextLength();
    } catch {
      w = 0;
    }
    t.remove();
    return w > 0 ? w : text.length * FS * 0.6;
  }

  /**
   * Draws the chart for `lbls`, sized for every label set in `sizing`, so the Python, C and C++
   * versions share one layout and switching never resizes it.
   */
  function build(lbls: Record<NodeId, string>, sizing: Record<NodeId, string>[] = [lbls]): void {
    labels = lbls;
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    for (const id of NODES) {
      const o = off[id];
      cancelAnimationFrame(o.raf);
      Object.assign(o, { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
      const tw = Math.max(...sizing.map((s) => measure(s[id])));
      const kind = KIND[id];
      const w = kind === "term" ? 96 : kind === "proc" ? Math.max(140, tw + 40) : kind === "loop" ? Math.max(200, tw + 52) : kind === "dec" ? Math.max(184, tw / 0.8 + 24) : Math.max(150, tw + 60);
      base[id] = { kind, cx: CX, cy: CY[id], w, h: HH[id] };
    }
    const bl = (id: NodeId) => base[id].cx - base[id].w / 2;
    const br = (id: NodeId) => base[id].cx + base[id].w / 2;
    lanes.no = Math.min(bl("loop"), bl("test")) - 34;
    lanes.add = lanes.no - 30;
    lanes.top = (CY.init + HH.init / 2 + CY.loop - HH.loop / 2) / 2;
    lanes.right = Math.max(br("loop"), br("test"), br("out")) + 34;
    // Crop the view to what is drawn: the outer lane on the left, the "done" label on the right.
    const minX = lanes.add - 18;
    const maxX = lanes.right + 66;
    svg.setAttribute("viewBox", `${r2(minX)} 0 ${r2(maxX - minX)} ${VBH}`);

    for (const eid of EDGES) {
      const g = mk("g", { class: "edge", "data-edge": eid }, edgeLayer);
      const draw = mk("path", { class: "e-draw", pathLength: 1 }, g);
      const bse = mk("path", { class: "e-base", "marker-end": `url(#${prefix}-ai)` }, g);
      const hot = mk("path", { class: "e-hot", pathLength: 1 }, g);
      let label: SVGTextElement | null = null;
      let count: SVGTSpanElement | null = null;
      const word = EDGE_LABEL[eid];
      if (word) {
        label = mk("text", { class: "elabel" }, g);
        label.textContent = word;
        count = mk("tspan", {}, label);
      }
      E[eid] = { g, draw, base: bse, hot, label, count, d: "" };
      routeEdge(eid);
    }

    for (const id of NODES) {
      const b = base[id];
      const g = mk("g", { class: "nd", "data-node": id }, nodeLayer);
      const body = mk("g", { class: "body" }, g);
      shapeEl(b.kind, b.cx, b.cy, b.w, b.h, "halo", body).setAttribute("filter", `url(#${prefix}-glow)`);
      shapeEl(b.kind, b.cx, b.cy, b.w + 10, b.h + (b.kind === "dec" ? 14 : 10), "fring", body);
      shapeEl(b.kind, b.cx, b.cy, b.w, b.h, "shape", body);
      const lbl = mk("text", { x: b.cx, y: b.cy, class: "lbl", "text-anchor": "middle", "dominant-baseline": "central" }, g);
      lbl.textContent = lbls[id];
      const [bx, by] = b.kind === "dec" ? [b.cx + b.w / 4 + 4, b.cy - b.h / 4 - 20] : [b.cx + b.w / 2 - 14, b.cy - b.h / 2 - 10];
      const badge = mk("g", { class: "badge" }, g);
      mk("rect", { x: r2(bx), y: r2(by), width: 32, height: 18, rx: 4 }, badge);
      const bt = mk("text", { x: r2(bx + 16), y: r2(by + 9.5), "text-anchor": "middle", "dominant-baseline": "central" }, badge);
      N[id] = { g, body, lbl, badge, bt };
      if (interactive) {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-roledescription", "draggable node");
        if (cfg.hintId) g.setAttribute("aria-describedby", cfg.hintId);
        wireDrag(id);
      } else {
        g.setAttribute("aria-hidden", "true");
      }
    }
  }

  // ---- direct manipulation: drag or arrow-nudge, then a spring brings the node home
  function applyOffset(id: NodeId): void {
    const o = off[id];
    N[id].g.style.transform = Math.abs(o.x) < 0.01 && Math.abs(o.y) < 0.01 ? "" : `translate(${r2(o.x)}px, ${r2(o.y)}px)`;
    adj[id].forEach(routeEdge);
  }
  function clampOff(x: number, y: number): { x: number; y: number } {
    const m = Math.hypot(x, y);
    return m <= MAXOFF ? { x, y } : { x: (x / m) * MAXOFF, y: (y / m) * MAXOFF };
  }
  function springTo(id: NodeId): void {
    const o = off[id];
    cancelAnimationFrame(o.raf);
    if (!motionOK()) {
      Object.assign(o, { x: o.tx, y: o.ty, vx: 0, vy: 0 });
      applyOffset(id);
      return;
    }
    let last = performance.now();
    const frame = (now: number) => {
      // A frame's stamp can come before `last` (taken outside a frame): that frame moves nothing.
      const dt = Math.max(0, now - last) / 1000;
      last = Math.max(last, now);
      const done = springStep(o, dt);
      applyOffset(id);
      if (!done) o.raf = requestAnimationFrame(frame);
    };
    o.raf = requestAnimationFrame(frame);
  }
  const goHome = (id: NodeId) => {
    off[id].tx = 0;
    off[id].ty = 0;
    springTo(id);
  };
  function wireDrag(id: NodeId): void {
    const g = N[id].g;
    let drag: { id: number; sx: number; sy: number; scale: number; ox: number; oy: number } | null = null;
    let keyHome = 0;
    g.addEventListener("pointerdown", (ev) => {
      if (!api.dragEnabled() || ev.button !== 0) return;
      const ctm = svg.getScreenCTM();
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, scale: ctm ? ctm.a : 1, ox: off[id].x, oy: off[id].y };
      cancelAnimationFrame(off[id].raf);
      try {
        g.setPointerCapture(ev.pointerId);
      } catch {
        // Capture is best effort.
      }
      g.classList.add("dragging");
    });
    g.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const c = clampOff(drag.ox + (ev.clientX - drag.sx) / drag.scale, drag.oy + (ev.clientY - drag.sy) / drag.scale);
      off[id].x = c.x;
      off[id].y = c.y;
      applyOffset(id);
    });
    const release = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      drag = null;
      g.classList.remove("dragging");
      goHome(id);
    };
    g.addEventListener("pointerup", release);
    g.addEventListener("pointercancel", release);
    g.addEventListener("lostpointercapture", release);
    g.addEventListener("keydown", (ev) => {
      const dir: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        cfg.onActivate?.(id);
        return;
      }
      if (ev.key === "Escape") {
        goHome(id);
        return;
      }
      const d = dir[ev.key];
      if (!d) return;
      ev.preventDefault();
      // The stepper's keys live on the run controls; a node's arrows move the node only.
      ev.stopPropagation();
      if (!api.dragEnabled()) return;
      const c = clampOff(off[id].tx + d[0] * 9, off[id].ty + d[1] * 9);
      off[id].tx = c.x;
      off[id].ty = c.y;
      springTo(id);
      clearTimeout(keyHome);
      keyHome = window.setTimeout(() => goHome(id), 650);
    });
    g.addEventListener("keyup", (ev) => {
      if (!ev.key.startsWith("Arrow")) return;
      clearTimeout(keyHome);
      keyHome = window.setTimeout(() => goHome(id), 220);
    });
    g.addEventListener("click", () => cfg.onActivate?.(id));
  }

  // ---- state
  let travelState: Travel | null = null;
  function render(k: number, o: { noHead?: boolean } = {}): void {
    const st = STATES[k];
    for (const id of NODES) {
      const c = st.counts[id] ?? 0;
      const rec = N[id];
      rec.g.classList.toggle("ran", c > 0);
      rec.g.classList.toggle("now", !o.noHead && id === st.cur);
      rec.badge.classList.toggle("on", c > 0);
      rec.bt.textContent = c > 0 ? TIMES + c : "";
      if (interactive) rec.g.setAttribute("aria-label", describeNode(id, labels, cfg.lineOf?.(id) ?? 0, c));
    }
    for (const eid of EDGES) {
      const c = st.edges[eid] ?? 0;
      const rec = E[eid];
      rec.g.classList.toggle("hot", c > 0);
      rec.g.classList.toggle("last", !o.noHead && eid === st.last);
      rec.base.setAttribute("marker-end", `url(#${prefix}${c > 0 ? "-ah" : "-ai"})`);
      if (rec.count) rec.count.textContent = c > 0 ? ` ${TIMES}${c}` : "";
      if (travelState?.eid !== eid) {
        rec.hot.style.strokeDashoffset = "";
        rec.hot.style.transition = "";
      }
    }
  }
  function pop(id: NodeId): void {
    if (!motionOK()) return;
    N[id].body.animate([{ transform: "scale(1)" }, { transform: "scale(1.07)" }, { transform: "scale(1)" }], { duration: 380, easing: SPRING });
  }

  // ---- the pulse: constant speed along the edge, eased in and out at its ends, with a short comet tail
  const placePulse = (x: number, y: number) => pulse.setAttribute("transform", `translate(${r2(x)} ${r2(y)})`);
  function travel(fromK: number, onDone: () => void): void {
    finishTravel();
    const eid = `${TRACE[fromK].id}>${TRACE[fromK + 1].id}` as EdgeId;
    const rec = E[eid];
    const first = !rec.g.classList.contains("hot");
    const dur = Math.max(260, Math.min(640, rec.base.getTotalLength() / 0.85));
    const TA = 30;
    const TB = 16;
    tailA.classList.add("on");
    tailB.classList.add("on");
    pulse.classList.add("on");
    if (first) {
      rec.hot.style.transition = "none";
      rec.hot.style.strokeDashoffset = "1";
    }
    const st: Travel = { eid, onDone, raf: 0, t0: performance.now() };
    travelState = st;
    const frame = (now: number) => {
      if (travelState !== st) return;
      const p = Math.min(1, (now - st.t0) / dur);
      const q = trap(p);
      const len = rec.base.getTotalLength();
      const pos = q * len;
      const pt = rec.base.getPointAtLength(pos);
      placePulse(pt.x, pt.y);
      tailA.setAttribute("d", rec.d);
      tailB.setAttribute("d", rec.d);
      tailA.style.strokeDasharray = `${TA} ${len + TA}`;
      tailA.style.strokeDashoffset = String(TA - pos);
      tailB.style.strokeDasharray = `${TB} ${len + TB}`;
      tailB.style.strokeDashoffset = String(TB - pos);
      if (first) rec.hot.style.strokeDashoffset = String(1 - q);
      if (p < 1) st.raf = requestAnimationFrame(frame);
      else finishTravel();
    };
    st.raf = requestAnimationFrame(frame);
  }
  function finishTravel(): void {
    const st = travelState;
    if (!st) return;
    travelState = null;
    cancelAnimationFrame(st.raf);
    tailA.classList.remove("on");
    tailB.classList.remove("on");
    E[st.eid].hot.style.strokeDashoffset = "";
    E[st.eid].hot.style.transition = "";
    st.onDone();
  }
  /** Rests the pulse where the edge it came in on meets the node (where a travel ends), never on
   *  the node's label; with no edge yet, at the node's top. */
  function parkPulse(id: NodeId, show: boolean, via: EdgeId | null = null): void {
    if (via && E[via]) {
      const len = E[via].base.getTotalLength();
      const pt = E[via].base.getPointAtLength(len);
      placePulse(pt.x, pt.y);
    } else {
      const b = box(id);
      placePulse(b.cx, b.t);
    }
    pulse.classList.toggle("on", show);
  }

  // ---- visibility for the fold
  function hideAll(): void {
    svg.classList.add("pre");
    for (const id of NODES) {
      N[id].g.classList.add("hid");
      N[id].lbl.classList.remove("wait");
    }
    for (const eid of EDGES) E[eid].g.classList.remove("drawing", "ready");
    pulse.classList.remove("on");
  }
  function showAll(): void {
    svg.classList.remove("pre");
    for (const id of NODES) {
      N[id].g.classList.remove("hid");
      N[id].lbl.classList.remove("wait");
    }
    for (const eid of EDGES) E[eid].g.classList.add("drawing", "ready");
  }

  const api = {
    svg,
    build,
    render,
    travel,
    finishTravel,
    parkPulse,
    pop,
    hideAll,
    showAll,
    box,
    N,
    E,
    dragEnabled: () => (cfg.dragEnabled ? cfg.dragEnabled() : true),
    isTravelling: () => travelState !== null,
  };
  return api;
}

// ---------------------------------------------------------------- the code column
/** The program's lines; `withToks` wraps each line's label pieces in one span the fold can lift. */
function renderCode(ol: HTMLOListElement, L: Lang, withToks: boolean): void {
  ol.replaceChildren();
  L.lines.forEach((pieces, i) => {
    const ln = i + 1;
    const node = nodeOfLine(L, ln);
    const li = el("li");
    li.dataset.line = String(ln);
    const num = el("span", "ln", String(ln));
    num.setAttribute("aria-hidden", "true");
    const src = el("span", node ? "src" : "src dim");
    let tok: HTMLSpanElement | null = null;
    for (const [text, cls, label] of pieces) {
      const piece = el("span", cls || undefined, text);
      if (label && withToks && node) {
        if (!tok) {
          tok = el("span", "tok");
          tok.dataset.tok = node;
          src.append(tok);
        }
        tok.append(piece);
      } else src.append(piece);
    }
    if (!pieces.length) src.textContent = " ";
    const hits = el("span", "hits");
    hits.setAttribute("aria-hidden", "true");
    li.append(num, src, hits);
    ol.append(li);
  });
}

// ---------------------------------------------------------------- the hero
type Phase = "idle" | "fold" | "edges" | "ready" | "run" | "done";

function byId<T extends Element>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`about.html: #${id} is missing`);
  return e as unknown as T;
}

function initHero(): void {
  if (!document.getElementById("lg-stage")) return;
  const stage = byId<HTMLElement>("lg-stage");
  const fly = byId<HTMLElement>("lg-fly");
  const codeEl = byId<HTMLOListElement>("lg-code");
  const runBtn = byId<HTMLButtonElement>("lg-run");
  const runText = byId<HTMLElement>("lg-run-label");
  const back = byId<HTMLButtonElement>("lg-back");
  const fwd = byId<HTMLButtonElement>("lg-fwd");
  const replay = byId<HTMLButtonElement>("lg-replay");
  const readoutEl = byId<HTMLElement>("lg-readout");
  const out = byId<HTMLElement>("lg-out");
  const live = byId<HTMLElement>("lg-live");
  const panel = byId<HTMLElement>("lg-stage-panel");
  const tabs = [...stage.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const iPlay = runBtn.querySelector<SVGElement>(".i-play");
  const iPause = runBtn.querySelector<SVGElement>(".i-pause");

  let lang: LangId = "py";
  let phase: Phase = "idle";
  let seq = 0;
  let k = 0;
  let playing = false;
  let timer = 0;
  const lineTimers = new WeakMap<Element, number>();

  const setPhase = (p: Phase) => {
    phase = p;
    stage.dataset.phase = p;
  };
  const busy = () => phase === "fold" || phase === "edges";

  const graph = makeGraph(byId<SVGSVGElement>("lg-graph"), {
    prefix: "g1",
    interactive: true,
    hintId: "lg-drag-hint",
    dragEnabled: () => !busy(),
    lineOf: (id) => (id === "start" || id === "end" ? 0 : LANGS[lang].map[id]),
    onActivate: (id) => linkLine(id),
  });

  function linkLine(id: NodeId): void {
    if (id === "start" || id === "end") return;
    const ln = LANGS[lang].map[id];
    const li = codeEl.querySelector<HTMLElement>(`li[data-line="${ln}"]`);
    if (!li) return;
    li.classList.add("linked");
    clearTimeout(lineTimers.get(li));
    lineTimers.set(li, window.setTimeout(() => li.classList.remove("linked"), 1100));
    live.textContent = `Line ${ln}: ${li.querySelector(".src")?.textContent?.trim() ?? ""}`;
  }

  const say = () => {
    live.textContent = `Step ${k} of ${LAST}: ${TRACE[k].say}`;
  };
  /** Marks a control unavailable without disabling it, so a focused one keeps the focus. */
  const avail = (b: HTMLButtonElement, on: boolean) => b.setAttribute("aria-disabled", String(!on));
  const usable = (b: HTMLButtonElement) => b.getAttribute("aria-disabled") !== "true";

  function setK(next: number, how: "none" | "step" | "manual" | "manual-step"): void {
    k = next;
    const st = STATES[k];
    const L = LANGS[lang];
    stage.dataset.step = String(k);
    graph.render(k);
    if (how === "step" || how === "manual-step") graph.pop(st.cur);
    if (!graph.isTravelling()) graph.parkPulse(st.cur, motionOK() && phase !== "done" && k < LAST && k > 0, st.last);
    const r = readout(k);
    const b = (text: string) => el("b", undefined, text);
    readoutEl.replaceChildren("step ", b(r.step), `/${r.of}  ${DOT}  n = `, b(r.n), `  ${DOT}  total = `, b(r.total));
    const curLine = st.cur === "start" || st.cur === "end" ? 0 : L.map[st.cur];
    for (const li of codeEl.children) {
      const ln = Number((li as HTMLElement).dataset.line);
      const node = nodeOfLine(L, ln);
      li.classList.toggle("now", ln === curLine);
      const c = node ? (st.counts[node] ?? 0) : 0;
      const h = li.querySelector(".hits");
      if (!h) continue;
      h.classList.toggle("on", c > 0);
      h.textContent = c > 0 ? TIMES + c : "";
    }
    const hasVal = out.querySelector(".val") !== null;
    if (st.printed && !hasVal) out.replaceChildren(el("span", "val", OUTPUT));
    else if (!st.printed && (hasVal || !out.querySelector(".none"))) out.replaceChildren(el("span", "none", "nothing printed yet"));
    for (const t of tabs) {
      const fill = t.querySelector<HTMLElement>(".seg-fill");
      if (fill) fill.style.transform = `scaleX(${t.getAttribute("aria-selected") === "true" ? k / LAST : 0})`;
    }
    avail(back, k > 0 && !busy());
    avail(fwd, k < LAST && !busy());
    if (how === "manual") say();
    syncRun();
  }
  function syncRun(): void {
    runText.textContent = runLabel(playing, k);
    if (iPlay) iPlay.style.display = playing ? "none" : "";
    if (iPause) iPause.style.display = playing ? "" : "none";
    avail(runBtn, !busy());
    avail(replay, true);
    stage.dataset.playing = String(playing);
  }

  function stepForward(how: "auto" | "manual", cb?: () => void): void {
    if (k >= LAST) {
      cb?.();
      return;
    }
    if (motionOK()) {
      graph.travel(k, () => {
        setK(k + 1, how === "manual" ? "manual-step" : "step");
        if (how === "manual") say();
        cb?.();
      });
    } else {
      setK(k + 1, how === "manual" ? "manual" : "step");
      cb?.();
    }
  }
  function tick(my: number): void {
    if (my !== seq || !playing) return;
    if (k >= LAST) return finishRun();
    stepForward("auto", () => {
      if (my !== seq || !playing) return;
      if (k >= LAST) return finishRun();
      timer = window.setTimeout(() => tick(my), motionOK() ? 90 : 420);
    });
  }
  function finishRun(): void {
    playing = false;
    clearTimeout(timer);
    setPhase("done");
    setK(LAST, "none");
    graph.parkPulse("end", false);
  }
  function play(): void {
    if (busy()) return;
    graph.finishTravel();
    if (k >= LAST) setK(0, "none");
    setPhase("run");
    playing = true;
    syncRun();
    const my = seq;
    timer = window.setTimeout(() => tick(my), 160);
  }
  function halt(): void {
    playing = false;
    clearTimeout(timer);
    syncRun();
    graph.finishTravel();
  }
  /** A step taken by hand: the run is no longer finished unless it stands at the end. */
  function manualTo(target: number): void {
    halt();
    setPhase(target === LAST ? "done" : "run");
    if (target === k + 1) {
      stepForward("manual", () => {
        if (k === LAST) setPhase("done");
      });
    } else setK(target, "manual");
    syncRun();
  }

  runBtn.addEventListener("click", () => {
    if (!usable(runBtn)) return;
    if (playing) halt();
    else play();
  });
  fwd.addEventListener("click", () => {
    if (usable(fwd) && k < LAST) manualTo(k + 1);
  });
  back.addEventListener("click", () => {
    if (usable(back) && k > 0) manualTo(k - 1);
  });
  replay.addEventListener("click", () => startSequence("replay"));
  byId<HTMLElement>("lg-ctl").addEventListener("keydown", (ev) => {
    if (busy() || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const target = stepFor(ev.key, k);
    if (target === null) return;
    ev.preventDefault();
    manualTo(target);
  });

  // ---- the fold: code lines lift and land in their nodes (FLIP, transform only)
  const wait = (ms: number, my: number, fn: () => void) => window.setTimeout(() => my === seq && fn(), ms);
  function appear(id: NodeId): void {
    const n = graph.N[id];
    n.g.classList.remove("hid");
    n.body.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 520, easing: SPRING });
    n.lbl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
  }
  function runFold(my: number): void {
    setPhase("fold");
    fly.replaceChildren();
    const sr = stage.getBoundingClientRect();
    const FLY = 900;
    FOLD_IDS.forEach((id, i) => {
      const tok = codeEl.querySelector<HTMLElement>(`[data-tok="${id}"]`);
      const n = graph.N[id];
      if (!tok) return;
      const tr = tok.getBoundingClientRect();
      const lr = n.lbl.getBoundingClientRect();
      const ghost = tok.cloneNode(true) as HTMLElement;
      ghost.className = "ghost";
      ghost.removeAttribute("data-tok");
      ghost.style.fontSize = getComputedStyle(tok).fontSize;
      ghost.style.left = `${tr.left - sr.left}px`;
      ghost.style.top = `${tr.top - sr.top}px`;
      ghost.style.opacity = "0";
      fly.append(ghost);
      const gr = ghost.getBoundingClientRect();
      const s = gr.width > 0 ? lr.width / gr.width : 1;
      const tx = lr.left - gr.left;
      const ty = lr.top + lr.height / 2 - (gr.top + (gr.height * s) / 2);
      const final = `translate(${tx}px, ${ty}px) scale(${s})`;
      const lift = `translate(${tx * 0.04 + 6}px, ${ty * 0.04 - 12}px) scale(${1.08 + (s - 1) * 0.04})`;
      n.lbl.classList.add("wait");
      wait(260 + i * 120, my, () => {
        ghost.style.opacity = "1";
        tok.classList.add("lifted");
        const anim = ghost.animate(
          [
            { transform: "translate(0px, 0px) scale(1)", easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
            { transform: lift, offset: 0.2, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
            { transform: final },
          ],
          { duration: FLY, fill: "forwards" },
        );
        wait(FLY * 0.62, my, () => {
          n.g.classList.remove("hid");
          const from = id === "test" ? "scale(0.45, 0.2) rotate(-14deg)" : "scale(0.7, 0.3)";
          n.body.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "scale(1)" }], { duration: 560, easing: SPRING });
        });
        anim.onfinish = () => {
          if (my !== seq) return;
          n.lbl.classList.remove("wait");
          tok.classList.remove("lifted");
          ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "cubic-bezier(0.55, 0, 0.75, 0.2)", fill: "forwards" }).onfinish = () => ghost.remove();
        };
      });
    });
    wait(80, my, () => appear("start"));
    const foldEnd = 260 + (FOLD_IDS.length - 1) * 120 + FLY;
    wait(foldEnd - 200, my, () => appear("end"));
    wait(foldEnd + 120, my, () => drawEdges(my));
  }
  function drawEdges(my: number): void {
    setPhase("edges");
    for (const id of NODES) graph.N[id].g.classList.remove("hid");
    EDGES.forEach((eid, i) => {
      wait(i * 85, my, () => {
        const rec = graph.E[eid];
        void rec.draw.getBoundingClientRect();
        rec.g.classList.add("drawing");
        wait(560, my, () => rec.g.classList.add("ready"));
      });
    });
    wait((EDGES.length - 1) * 85 + 640, my, () => {
      setPhase("ready");
      graph.svg.classList.remove("pre");
      setK(0, "none");
      wait(420, my, () => play());
    });
  }

  /**
   * "fold" (load, a tab switch) or "replay". Under reduced motion nothing plays by itself: a load or a
   * tab switch shows the finished run, Replay rewinds to step 0 for the stepper.
   */
  function startSequence(how: "fold" | "replay"): void {
    const my = ++seq;
    halt();
    fly.replaceChildren();
    for (const t of codeEl.querySelectorAll(".tok.lifted")) t.classList.remove("lifted");
    if (motionOK()) {
      graph.hideAll();
      setPhase("fold");
      setK(0, "none");
      requestAnimationFrame(() => my === seq && runFold(my));
    } else {
      graph.showAll();
      setPhase(how === "replay" ? "ready" : "done");
      setK(how === "replay" ? 0 : LAST, "none");
    }
  }

  function selectLang(next: LangId, focus: boolean): void {
    const L = LANGS[next];
    lang = next;
    for (const t of tabs) {
      const on = t.dataset.lang === next;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    panel.setAttribute("aria-labelledby", `lg-tab-${next}`);
    byId<HTMLElement>("lg-sw-idx").textContent = L.idx;
    byId<HTMLElement>("lg-sw-file").textContent = L.file;
    byId<HTMLElement>("lg-ed-file").textContent = L.file;
    byId<HTMLElement>("lg-ed-lang").textContent = L.name;
    codeEl.setAttribute("aria-label", `Source code of ${L.file}`);
    renderCode(codeEl, L, true);
    graph.build(labelsOf(L), allLabels());
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => {
      const id = t.dataset.lang as LangId;
      if (id === lang) return;
      selectLang(id, false);
      startSequence("fold");
    });
    t.addEventListener("keydown", (ev) => {
      const j = tabFor(ev.key, i, tabs.length);
      if (j === null) return;
      ev.preventDefault();
      selectLang(tabs[j].dataset.lang as LangId, true);
      startSequence("fold");
    });
  });

  // A web font that arrives late changes text widths: measure again, and restart a fold in flight.
  document.fonts?.addEventListener?.("loadingdone", () => {
    if (phase === "idle") return;
    graph.build(labelsOf(LANGS[lang]), allLabels());
    if (busy()) return startSequence("fold");
    const was = playing;
    halt();
    graph.showAll();
    setK(k, "none");
    if (was) play();
  });

  // Reduced motion turned on during the visit: stop at once and show the finished run.
  reducedMotion.addEventListener("change", (e) => {
    if (!e.matches) return;
    document.documentElement.classList.remove("lg-motion");
    seq++;
    halt();
    fly.replaceChildren();
    for (const t of codeEl.querySelectorAll(".tok.lifted")) t.classList.remove("lifted");
    graph.showAll();
    setPhase("done");
    setK(LAST, "none");
  });

  // The first state: built and readable at once; the fold starts when the stage is in view.
  selectLang("py", false);
  if (motionOK()) {
    graph.hideAll();
    setPhase("idle");
    setK(0, "none");
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      void Promise.race([fontsReady, new Promise((r) => setTimeout(r, 3000))]).then(() => {
        if (phase !== "idle") return;
        graph.build(labelsOf(LANGS[lang]), allLabels());
        startSequence("fold");
      });
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          go();
        },
        { threshold: 0.35 },
      );
      io.observe(stage);
    } else go();
  } else {
    setPhase("done");
    graph.showAll();
    setK(LAST, "none");
    void document.fonts?.ready.then(() => {
      if (phase !== "done" || k !== LAST) return;
      graph.build(labelsOf(LANGS[lang]), allLabels());
      graph.showAll();
      setK(LAST, "none");
    });
  }
}

// ---------------------------------------------------------------- the features graph's spine
function initSpine(): void {
  const tree = document.getElementById("lg-tree");
  if (!tree) return;
  if (!motionOK() || !("IntersectionObserver" in window)) {
    tree.classList.remove("pending");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      tree.classList.remove("pending");
      io.disconnect();
    },
    { threshold: 0.15 },
  );
  io.observe(tree);
}

// ---------------------------------------------------------------- the editor drawing: the same chart, finished
function initMock(): void {
  const code = document.getElementById("lg-code2") as HTMLOListElement | null;
  const svg = document.getElementById("lg-graph2") as SVGSVGElement | null;
  if (!code || !svg) return;
  renderCode(code, LANGS.py, false);
  const st = STATES[LAST];
  for (const li of code.querySelectorAll<HTMLElement>("li")) {
    const node = nodeOfLine(LANGS.py, Number(li.dataset.line));
    const c = node ? (st.counts[node] ?? 0) : 0;
    const h = li.querySelector(".hits");
    if (c && h) {
      h.textContent = TIMES + c;
      h.classList.add("on");
    }
  }
  const g2 = makeGraph(svg, { prefix: "g2", interactive: false });
  const draw = () => {
    g2.build(labelsOf(LANGS.py));
    g2.showAll();
    g2.render(LAST, { noHead: true });
  };
  draw();
  void document.fonts?.ready.then(draw);
}

/** The Living Graph parts of the About page. */
export function initLivingGraph(): void {
  if (motionOK()) document.documentElement.classList.add("lg-motion");
  initHero();
  initSpine();
  initMock();
}
