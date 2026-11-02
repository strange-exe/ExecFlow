// Draws a laid-out flowchart as SVG, with DOM calls only: createElementNS, setAttribute and
// textContent. Code text reaches the drawing as text nodes and nothing else, so a label like
// `</text><script>` is just characters; nothing links outside the drawing. Shapes are ISO 5807's:
// terminator (rounded), process (rectangle), decision (diamond), input/output (parallelogram),
// predefined process (rectangle with side bars), connector (circle). Colours are the theme's custom
// properties (the export resolves them). Every box is a list item named by its kind and full text
// and carries its source lines; the lines are decoration (aria-hidden), since stepList() says where
// each step goes in words.
import type { Layout, LaidBox, LaidEdge, Point } from "./layout";
import { labelRect, METRICS } from "./layout";
import type { FlowChart, FlowEdge, FlowNode, Step } from "./model";
import { chipText, countsByKey, edgeKey, stepTraceWords, traceWidth, type ChartTrace } from "./trace";

const NS = "http://www.w3.org/2000/svg";

/** The DOM calls the renderer uses (a Document; tests pass a small stand-in). */
export type SvgDocument = Pick<Document, "createElementNS" | "createTextNode">;

/** The colour tokens a chart is drawn with. */
export const CHART_TOKENS = ["surface-raised", "border-strong", "text", "text-secondary", "success", "warning", "info", "action", "danger"] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/**
 * Shapes take the colour of what they mean, as an outline and a light tint (CHART_TINT percent over
 * surface-raised): terminators the success hue, decisions warning, input and output info, calls the
 * action hue. Plain steps and connectors stay neutral, so colour marks the shapes worth a look; the
 * shape itself always says the kind too. src/theme/contrast.ts checks text on every tint and every
 * outline against the chart's ground, in every theme.
 */
export const CHART_TINT = 14;
export type KindHue = "success" | "warning" | "info" | "action";
export function kindHue(kind: FlowNode["kind"]): KindHue | null {
  switch (kind) {
    case "start":
    case "end":
      return "success";
    case "decision":
      return "warning";
    case "io":
      return "info";
    case "call":
      return "action";
    default:
      return null;
  }
}

/**
 * How a chart is painted. The view's look names the theme's custom properties and is interactive
 * (rings, one Tab stop, list items); the export's gives resolved colours and font lists and none of that.
 */
export interface ChartLook {
  color(token: ChartToken): string;
  /** `token` at `pct` percent over surface-raised. */
  tint(token: KindHue, pct: number): string;
  codeFont: string;
  uiFont: string;
  interactive: boolean;
}

export const VIEW_LOOK: ChartLook = {
  color: (t) => `var(--${t})`,
  tint: (t, pct) => `color-mix(in srgb, var(--${t}) ${pct}%, var(--surface-raised))`,
  codeFont: "var(--font-code)",
  uiFont: "var(--font-ui)",
  interactive: true,
};

type Styles = Record<"shape" | "bar" | "text" | "note" | "edgeLabel" | "chip" | "chipText", string> & {
  kindShape(hue: KindHue | null): string;
  kindBar(hue: KindHue | null): string;
  edge(hue: EdgeHue, width?: number): string;
  arrow(hue: EdgeHue): string;
};

/** A connector's colour: Yes in the success hue, No in danger, the rest the secondary text colour. */
export type EdgeHue = "text-secondary" | "success" | "danger";
export function edgeHue(label: string | undefined): EdgeHue {
  return label === "Yes" ? "success" : label === "No" ? "danger" : "text-secondary";
}

function styles(look: ChartLook): Styles {
  const c = look.color;
  const shape = `fill:${c("surface-raised")};stroke:${c("border-strong")};stroke-width:1.5`;
  return {
    shape,
    bar: `fill:none;stroke:${c("border-strong")};stroke-width:1.5`,
    text: `fill:${c("text")};font-family:${look.codeFont};font-size:13px`,
    note: `fill:${c("text-secondary")};font-family:${look.uiFont};font-size:11px;font-style:italic`,
    edgeLabel: `fill:${c("text")};font-family:${look.uiFont};font-size:12px;font-weight:600`,
    kindShape: (hue) => (hue ? `fill:${look.tint(hue, CHART_TINT)};stroke:${c(hue)};stroke-width:1.75` : shape),
    kindBar: (hue) => `fill:none;stroke:${c(hue ?? "border-strong")};stroke-width:1.5`,
    edge: (hue, width = 1.5) => `fill:none;stroke:${c(hue)};stroke-width:${width};stroke-linejoin:round;stroke-linecap:round`,
    arrow: (hue) => `fill:${c(hue)};stroke:none`,
    // The pass-count chip (Flow Board's signature): secondary ink on the raised surface, a hairline round it.
    chip: `fill:${c("surface-raised")};stroke:${c("border-strong")};stroke-width:1`,
    chipText: `fill:${c("text-secondary")};font-family:${look.codeFont};font-size:${CHIP.fontSize}px`,
  };
}

// ---------------------------------------------------------------- the run trace

/** The pass-count chip's size: mono 11 px, about 6.6 px a character. */
export const CHIP = { h: 16, charW: 6.6, padX: 4, fontSize: 11, gap: 3, rx: 4 } as const;
/** Draw-in steps: the 17th connector and later start with the 16th (a long trace doesn't crawl). */
export const TRACE_STAGGER_STEPS = 16;

export interface TraceMark {
  /** Times the run went this way. */
  count: number;
  /** Its place in the draw-in (0 first, in run order, at most TRACE_STAGGER_STEPS). */
  step: number;
  /** The connector's width (traceWidth). */
  width: number;
  /** The chip with the count, on a branch (a labelled edge), a loop's way back, or a break or continue. */
  chip: { x: number; y: number; w: number; h: number; text: string } | null;
}

/**
 * What the run trace adds to each of the layout's edges (null: the run didn't go that way). The
 * view's SVG and the export's SVG and PNG all draw from this, so they can't disagree. A branch's
 * chip sits beside its label, away from the box; any other chip sits on the middle of the edge's longest
 * segment, its fill covering the line under it.
 */
export function traceMarks(chart: FlowChart, layout: Layout, ct: ChartTrace): (TraceMark | null)[] {
  const by = countsByKey(chart, ct);
  const firsts = [...new Set(layout.edges.map((e) => by.get(edgeKey(e))).filter((c) => c && c.count > 0 && c.order >= 0).map((c) => c!.order))].sort((a, b) => a - b);
  return layout.edges.map((e) => {
    const c = by.get(edgeKey(e));
    if (!c || c.count <= 0) return null;
    const step = Math.min(TRACE_STAGGER_STEPS, Math.max(0, firsts.indexOf(c.order)));
    const mark: TraceMark = { count: c.count, step, width: traceWidth(c.count), chip: null };
    if (e.label === undefined && e.kind !== "back" && e.kind !== "jump") return mark;
    const text = chipText(c.count);
    const w = Math.round(text.length * CHIP.charW + 2 * CHIP.padX);
    const h = CHIP.h;
    if (e.label !== undefined && e.labelAt) {
      const r = labelRect(e.labelAt, e.label);
      // Centred on the label's x-height, on the label's far side from its box: just after a label
      // that starts at the corner ("Yes 5x"), just before one that ends at it ("5x Yes", left of a
      // decision's left corner), so the chip never runs into the diamond.
      const x = e.labelAt.anchor === "end" ? r.x0 - CHIP.gap - w : r.x1 + CHIP.gap;
      mark.chip = { x, y: Math.round(e.labelAt.y - 4 - h / 2), w, h, text };
      return mark;
    }
    let best = { len: -1, mid: e.points[0] };
    for (let i = 1; i < e.points.length; i++) {
      const [p, q] = [e.points[i - 1], e.points[i]];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len > best.len) best = { len, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } };
    }
    mark.chip = { x: Math.round(best.mid.x - w / 2), y: Math.round(best.mid.y - h / 2), w, h, text };
    return mark;
  });
}

/** The chip as SVG: a rounded rect and its count. */
function chip(doc: SvgDocument, m: TraceMark, STYLE: Styles, live: boolean): SVGGElement {
  const c = m.chip!;
  const g = el(doc, "g", live ? { "data-part": "count", "data-count": m.count, style: `--fc-i:${m.step}` } : {});
  g.appendChild(el(doc, "rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: CHIP.rx, style: STYLE.chip }));
  const t = el(doc, "text", { x: c.x + c.w / 2, y: c.y + c.h / 2 + CHIP.fontSize * 0.35, "text-anchor": "middle", style: STYLE.chipText });
  t.textContent = c.text;
  g.appendChild(t);
  return g;
}

/**
 * An orthogonal polyline as a path whose corners are arcs of up to `r` (half the shorter leg at most);
 * the last corner up to `lastR`, so its curve ends before the arrowhead's base.
 */
export function roundedPath(points: Point[], r = 8, lastR = r): string {
  if (points.length < 3) return `M${pts(points).replaceAll(" ", " L")}`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, i === points.length - 2 ? lastR : r, inLen / 2, outLen / 2);
    if (k < 0.5) {
      d += ` L${b.x},${b.y}`;
      continue;
    }
    const p1 = { x: b.x - ((b.x - a.x) / inLen) * k, y: b.y - ((b.y - a.y) / inLen) * k };
    const p2 = { x: b.x + ((c.x - b.x) / outLen) * k, y: b.y + ((c.y - b.y) / outLen) * k };
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/** Words a screen reader says before a box's text. */
function kindWords(node: FlowNode): string {
  switch (node.kind) {
    case "start":
      return "Start";
    case "end":
      return node.text === "End" ? "End" : `End: ${node.text}`;
    case "decision":
      return `Decision: ${node.text}`;
    case "io":
      return `Input or output: ${node.text}`;
    case "call":
      return `Call to ${node.callee}: ${node.text}`;
    case "connector":
      return node.text;
    default:
      return node.text;
  }
}

function el<K extends keyof SVGElementTagNameMap>(doc: SvgDocument, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = doc.createElementNS(NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const pts = (list: Point[]) => list.map((p) => `${p.x},${p.y}`).join(" ");

function shape(doc: SvgDocument, node: FlowNode, b: LaidBox, STYLE: Styles): SVGElement[] {
  const { x, y, w, h } = b;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hue = kindHue(node.kind);
  const style = STYLE.kindShape(hue);
  switch (node.kind) {
    case "start":
    case "end":
      return [el(doc, "rect", { x, y, width: w, height: h, rx: h / 2, style })];
    case "decision":
      return [el(doc, "polygon", { points: pts([{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }]), style })];
    case "io": {
      const s = METRICS.skew;
      return [el(doc, "polygon", { points: pts([{ x: x + s, y }, { x: x + w, y }, { x: x + w - s, y: y + h }, { x, y: y + h }]), style })];
    }
    case "call": {
      const bar = METRICS.bar;
      return [
        el(doc, "rect", { x, y, width: w, height: h, rx: 2, style }),
        el(doc, "line", { x1: x + bar, y1: y, x2: x + bar, y2: y + h, style: STYLE.kindBar(hue) }),
        el(doc, "line", { x1: x + w - bar, y1: y, x2: x + w - bar, y2: y + h, style: STYLE.kindBar(hue) }),
      ];
    }
    case "connector":
      return [el(doc, "circle", { cx, cy, r: w / 2, style })];
    default:
      return [el(doc, "rect", { x, y, width: w, height: h, rx: 2, style })];
  }
}

/** The label lines (and the note) centred in the box, one tspan per line. */
function label(doc: SvgDocument, node: FlowNode, b: LaidBox, STYLE: Styles): SVGTextElement {
  const lines = node.note ? [...node.label, node.note] : node.label;
  const lh = METRICS.lineH;
  const cx = b.x + b.w / 2;
  const first = b.y + b.h / 2 - ((lines.length - 1) * lh) / 2 + METRICS.fontSize * 0.35;
  const text = el(doc, "text", { x: cx, y: first, "text-anchor": "middle", style: STYLE.text });
  lines.forEach((line, i) => {
    const isNote = node.note !== undefined && i === lines.length - 1;
    const span = el(doc, "tspan", isNote ? { x: cx, y: first + i * lh, style: STYLE.note } : { x: cx, y: first + i * lh });
    span.textContent = line;
    text.appendChild(span);
  });
  return text;
}

/** The last leg's length in px. */
function lastLeg(edge: LaidEdge): number {
  const [end, before] = [edge.points[edge.points.length - 1], edge.points[edge.points.length - 2]];
  return Math.hypot(end.x - before.x, end.y - before.y);
}

/**
 * The arrowhead's length: 9 px, or on an edge whose last leg is too short for it and a corner (a
 * searched line into a box's side can arrive 4 px after its bend) as long as the leg allows, 4 px
 * at least, so the line still meets the head's base instead of its side.
 */
export function arrowLength(edge: LaidEdge): number {
  if (edge.points.length < 3) return 9;
  const leg = lastLeg(edge);
  return Math.min(9, Math.max(Math.min(4, leg), leg - 2));
}

/** A filled triangle at the end of the edge, pointing the way its last segment goes. */
export function arrowCorners(edge: LaidEdge): Point[] {
  const end = edge.points[edge.points.length - 1];
  const before = edge.points[edge.points.length - 2];
  const dx = Math.sign(end.x - before.x);
  const dy = Math.sign(end.y - before.y);
  const len = arrowLength(edge);
  const half = len / 2;
  const back = { x: end.x - dx * len, y: end.y - dy * len };
  return [end, { x: back.x + dy * half, y: back.y + dx * half }, { x: back.x - dy * half, y: back.y - dx * half }];
}

/**
 * A connector's line as a path (the SVG's and the PNG's): it stops inside the arrowhead, 3 px short
 * of its base (under the fill), so the head's point stays sharp at the box; the last corner's curve
 * ends before the head's base.
 */
export function edgePath(e: LaidEdge): string {
  const line = [...e.points];
  const [end, before] = [line[line.length - 1], line[line.length - 2]];
  const run = lastLeg(e);
  const head = arrowLength(e);
  const cut = head - 3;
  if (run > head) line[line.length - 1] = { x: end.x - ((end.x - before.x) / run) * cut, y: end.y - ((end.y - before.y) / run) * cut };
  return roundedPath(line, 8, Math.max(0, run - head));
}

function arrow(doc: SvgDocument, edge: LaidEdge, STYLE: Styles, interactive: boolean): SVGPolygonElement {
  const style = STYLE.arrow(edgeHue(edge.label));
  return el(doc, "polygon", interactive ? { points: pts(arrowCorners(edge)), style, "data-part": "arrow" } : { points: pts(arrowCorners(edge)), style });
}

/**
 * The chart as an <svg> element (not yet in the page). With the export's look (interactive false)
 * it carries no rings, Tab stops, list roles, classes or data attributes: only the drawing.
 *
 * With a run trace, each connector the run took is drawn at its count's width and branches, ways
 * back and jumps get a pass-count chip; the rest stay plain. In the view a traced connector is a
 * second path over the plain one (data-part "trace", pathLength 1), so the view's CSS can draw it
 * in along its length while the plain line is always there; the export draws the traced path only.
 */
export function renderChart(chart: FlowChart, layout: Layout, doc: SvgDocument = document, look: ChartLook = VIEW_LOOK, trace: ChartTrace | null = null): SVGSVGElement {
  const STYLE = styles(look);
  const live = look.interactive;
  const svg = el(
    doc,
    "svg",
    live
      ? { xmlns: NS, viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height, role: "group", "aria-label": `Flowchart of ${chart.name}`, "data-chart": chart.name }
      : { xmlns: NS, viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height },
  );
  const unreachable = new Set(chart.unreachable);

  const marks = trace ? traceMarks(chart, layout, trace) : [];
  const edges = el(doc, "g", live ? { "data-part": "edges", "aria-hidden": "true" } : {});
  const chips = el(doc, "g", live ? { "data-part": "counts", "aria-hidden": "true" } : {});
  for (const [i, e] of layout.edges.entries()) {
    const m = marks[i] ?? null;
    const hue = edgeHue(e.label);
    const g = el(doc, "g", live ? { "data-from": e.from, "data-to": e.to, "data-kind": e.kind, ...(m ? { "data-count": m.count } : {}) } : {});
    const d = edgePath(e);
    if (live || !m) g.appendChild(el(doc, "path", { d, style: STYLE.edge(hue) }));
    if (m) g.appendChild(el(doc, "path", live ? { d, pathLength: 1, "data-part": "trace", style: `${STYLE.edge(hue, m.width)};--fc-i:${m.step}` } : { d, style: STYLE.edge(hue, m.width) }));
    g.appendChild(arrow(doc, e, STYLE, live));
    if (e.label !== undefined && e.labelAt) {
      const t = el(doc, "text", { x: e.labelAt.x, y: e.labelAt.y, "text-anchor": e.labelAt.anchor, style: STYLE.edgeLabel });
      t.textContent = e.label;
      g.appendChild(t);
    }
    if (m?.chip) chips.appendChild(chip(doc, m, STYLE, live));
    edges.appendChild(g);
  }
  svg.appendChild(edges);
  // Over every connector (a chip covers the line it sits on), under the boxes.
  if (marks.some((m) => m?.chip)) svg.appendChild(chips);

  const list = el(doc, "g", live ? { role: "list", "aria-label": "Steps", "data-part": "steps" } : {});
  const boxes = new Map(layout.boxes.map((b) => [b.id, b]));
  for (const node of chart.nodes) {
    const b = boxes.get(node.id);
    if (!b) continue;
    const lines = node.from === node.to ? `line ${node.from}` : `lines ${node.from} to ${node.to}`;
    const name = [kindWords(node), node.note, unreachable.has(node.id) ? "never reached" : undefined, lines].filter(Boolean).join(", ");
    // Out of the Tab order: the view keeps one box at tabindex 0 (one Tab stop, arrows move).
    const g = el(
      doc,
      "g",
      live
        ? { class: "fc-node", role: "listitem", tabindex: -1, "aria-label": name, "data-node": node.id, "data-kind": node.kind, "data-line-from": node.from, "data-line-to": node.to }
        : {},
    );
    const title = el(doc, "title", {});
    title.textContent = name;
    g.appendChild(title);
    // The ring the view shows round a focused box and round the caret's box (styled by its CSS:
    // interaction only, so an exported image never carries it).
    if (live) g.appendChild(el(doc, "rect", { class: "fc-ring", x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, rx: 6 }));
    for (const s of shape(doc, node, b, STYLE)) g.appendChild(s);
    g.appendChild(label(doc, node, b, STYLE));
    list.appendChild(g);
  }
  svg.appendChild(list);
  return svg;
}

/**
 * The legend's entries in reading order: a name for each shape, and the kinds drawn with it (start
 * and end share the terminator). The view lists only the entries its chart uses.
 */
export const LEGEND: readonly { kind: FlowNode["kind"]; also?: FlowNode["kind"]; words: string }[] = [
  { kind: "start", also: "end", words: "Start and end" },
  { kind: "process", words: "Step" },
  { kind: "io", words: "Input or output" },
  { kind: "decision", words: "Decision" },
  { kind: "call", words: "Function call" },
  { kind: "connector", words: "Label or go to" },
];

/**
 * A 24 x 14 picture of a kind's shape for the legend, in the very style its boxes are drawn with
 * (the same outline, tint and width), so the legend can't drift from the chart. Decorative: the
 * words beside it say the kind.
 */
export function kindSwatch(kind: FlowNode["kind"], doc: SvgDocument = document, look: ChartLook = VIEW_LOOK): SVGSVGElement {
  const STYLE = styles(look);
  const hue = kindHue(kind);
  const style = STYLE.kindShape(hue);
  const svg = el(doc, "svg", { xmlns: NS, viewBox: "0 0 24 14", width: 24, height: 14, "aria-hidden": "true", focusable: "false" });
  const parts: SVGElement[] = (() => {
    switch (kind) {
      case "start":
      case "end":
        return [el(doc, "rect", { x: 1, y: 1, width: 22, height: 12, rx: 6, style })];
      case "decision":
        return [el(doc, "polygon", { points: "12,1 23,7 12,13 1,7", style })];
      case "io":
        return [el(doc, "polygon", { points: "6,1 23,1 18,13 1,13", style })];
      case "call":
        return [
          el(doc, "rect", { x: 1, y: 1, width: 22, height: 12, rx: 1, style }),
          el(doc, "line", { x1: 5, y1: 1, x2: 5, y2: 13, style: STYLE.kindBar(hue) }),
          el(doc, "line", { x1: 19, y1: 1, x2: 19, y2: 13, style: STYLE.kindBar(hue) }),
        ];
      case "connector":
        return [el(doc, "circle", { cx: 12, cy: 7, r: 6, style })];
      default:
        return [el(doc, "rect", { x: 1, y: 1, width: 22, height: 12, rx: 1, style })];
    }
  })();
  for (const p of parts) svg.appendChild(p);
  return svg;
}

/** Where control goes after a box, in words: "Next: step 4." or "Yes: step 5. No: step 6." */
function next(node: FlowNode, out: FlowEdge[]): string {
  if (node.kind === "connector" && out.length === 1 && out[0].kind === "link") return `: step ${out[0].to + 1}.`;
  if (out.length === 0) return ".";
  if (out.every((e) => e.label === undefined)) return `. Next: ${out.map((e) => `step ${e.to + 1}`).join(", ")}.`;
  return ` ${out.map((e) => `${e.label ?? "Then"}: step ${e.to + 1}.`).join(" ")}`;
}

/** The goto connectors in the chart's structure (a goto whose label isn't in the chart has no link edge). */
function gotoIds(step: Step, out: Set<number>): Set<number> {
  switch (step.t) {
    case "goto":
      out.add(step.id);
      break;
    case "seq":
      step.items.forEach((s) => gotoIds(s, out));
      break;
    case "if":
      gotoIds(step.yes, out);
      gotoIds(step.no, out);
      break;
    case "loop":
      gotoIds(step.body, out);
      if (step.update) gotoIds(step.update, out);
      if (step.orelse) gotoIds(step.orelse, out);
      break;
    case "switch":
      step.cases.forEach((c) => gotoIds(c.body, out));
      break;
  }
  return out;
}

/**
 * The chart as a text outline in reading order, one entry per box: never the only way to read it.
 * With a run trace, each box the run left says how many times it went each way ("Last run: Yes 5 times, No 1 time.").
 */
export function stepList(chart: FlowChart, trace: ChartTrace | null = null): { id: number; text: string }[] {
  const unreachable = new Set(chart.unreachable);
  const gotos = gotoIds(chart.body, new Set());
  return chart.nodes.map((node) => {
    const out = chart.edges.filter((e) => e.from === node.id);
    let words = kindWords(node);
    if (node.kind === "connector") words = gotos.has(node.id) ? `Go to ${node.text}` : `Label ${node.text}`;
    if (node.note) words += ` (${node.note})`;
    if (unreachable.has(node.id)) words += " (never reached)";
    return { id: node.id, text: `${node.id + 1}. ${words}${next(node, out)}${trace ? stepTraceWords(chart, trace, node.id) : ""}` };
  });
}

/**
 * The trace legend's pictures, in the trace's own style: "width" a plain connector over a 4 px one
 * ("Thicker ran more often"), "count" a chip ("Times that way ran"). Decorative: the words say it.
 */
export function traceSwatch(which: "width" | "count", doc: SvgDocument = document, look: ChartLook = VIEW_LOOK): SVGSVGElement {
  const STYLE = styles(look);
  const svg = el(doc, "svg", { xmlns: NS, viewBox: "0 0 24 16", width: 24, height: 16, "aria-hidden": "true", focusable: "false" });
  if (which === "width") {
    svg.appendChild(el(doc, "path", { d: "M2,4 L22,4", style: STYLE.edge("text-secondary") }));
    svg.appendChild(el(doc, "path", { d: "M2,11 L22,11", style: STYLE.edge("text-secondary", traceWidth(5)) }));
  } else {
    svg.appendChild(el(doc, "rect", { x: 0.5, y: 0.5, width: 23, height: 15, rx: CHIP.rx, style: STYLE.chip }));
    const t = el(doc, "text", { x: 12, y: 8 + CHIP.fontSize * 0.35, "text-anchor": "middle", style: STYLE.chipText });
    t.textContent = chipText(5);
    svg.appendChild(t);
  }
  return svg;
}

/** The trace's two legend rows, shown only while a trace is. */
export const TRACE_LEGEND: readonly { which: "width" | "count"; words: string }[] = [
  { which: "width", words: "Thicker ran more often" },
  { which: "count", words: "Times that way ran" },
];
