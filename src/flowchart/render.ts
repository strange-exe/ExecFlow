// Draws a laid-out flowchart as SVG, with DOM calls only: createElementNS, setAttribute and
// textContent. Code text reaches the drawing as text nodes and nothing else, so a label like
// `</text><script>` is just characters; nothing links outside the drawing. Shapes are ISO 5807's:
// terminator (rounded), process (rectangle), decision (diamond), input/output (parallelogram),
// predefined process (rectangle with side bars), connector (circle). Colours are the theme's custom
// properties (the export resolves them). Every box is a list item named by its kind and full text
// and carries its source lines; the lines are decoration (aria-hidden), since stepList() says where
// each step goes in words.
import type { Layout, LaidBox, LaidEdge, Point } from "./layout";
import { METRICS } from "./layout";
import type { FlowChart, FlowEdge, FlowNode } from "./model";

const NS = "http://www.w3.org/2000/svg";

/** The DOM calls the renderer uses (a Document; tests pass a small stand-in). */
export type SvgDocument = Pick<Document, "createElementNS" | "createTextNode">;

/** The colour tokens a chart is drawn with. */
export const CHART_TOKENS = ["surface-raised", "border-strong", "text", "text-secondary"] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/**
 * How a chart is painted. The view's look names the theme's custom properties and is interactive
 * (rings, one Tab stop, list items); the export's gives resolved colours and font lists and none of that.
 */
export interface ChartLook {
  color(token: ChartToken): string;
  codeFont: string;
  uiFont: string;
  interactive: boolean;
}

export const VIEW_LOOK: ChartLook = { color: (t) => `var(--${t})`, codeFont: "var(--font-code)", uiFont: "var(--font-ui)", interactive: true };

type Styles = Record<"shape" | "bar" | "text" | "note" | "edge" | "arrow" | "edgeLabel", string>;

function styles(look: ChartLook): Styles {
  const c = look.color;
  return {
    shape: `fill:${c("surface-raised")};stroke:${c("border-strong")};stroke-width:1.5`,
    bar: `fill:none;stroke:${c("border-strong")};stroke-width:1.5`,
    text: `fill:${c("text")};font-family:${look.codeFont};font-size:13px`,
    note: `fill:${c("text-secondary")};font-family:${look.uiFont};font-size:11px;font-style:italic`,
    edge: `fill:none;stroke:${c("border-strong")};stroke-width:1.5;stroke-linejoin:round`,
    arrow: `fill:${c("border-strong")};stroke:none`,
    edgeLabel: `fill:${c("text-secondary")};font-family:${look.uiFont};font-size:12px`,
  };
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
  switch (node.kind) {
    case "start":
    case "end":
      return [el(doc, "rect", { x, y, width: w, height: h, rx: h / 2, style: STYLE.shape })];
    case "decision":
      return [el(doc, "polygon", { points: pts([{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }]), style: STYLE.shape })];
    case "io": {
      const s = METRICS.skew;
      return [el(doc, "polygon", { points: pts([{ x: x + s, y }, { x: x + w, y }, { x: x + w - s, y: y + h }, { x, y: y + h }]), style: STYLE.shape })];
    }
    case "call": {
      const bar = METRICS.bar;
      return [
        el(doc, "rect", { x, y, width: w, height: h, rx: 2, style: STYLE.shape }),
        el(doc, "line", { x1: x + bar, y1: y, x2: x + bar, y2: y + h, style: STYLE.bar }),
        el(doc, "line", { x1: x + w - bar, y1: y, x2: x + w - bar, y2: y + h, style: STYLE.bar }),
      ];
    }
    case "connector":
      return [el(doc, "circle", { cx, cy, r: w / 2, style: STYLE.shape })];
    default:
      return [el(doc, "rect", { x, y, width: w, height: h, rx: 2, style: STYLE.shape })];
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

/** A filled triangle at the end of the edge, pointing the way its last segment goes. */
export function arrowCorners(edge: LaidEdge): Point[] {
  const end = edge.points[edge.points.length - 1];
  const before = edge.points[edge.points.length - 2];
  const dx = Math.sign(end.x - before.x);
  const dy = Math.sign(end.y - before.y);
  const len = 8;
  const half = 4;
  const back = { x: end.x - dx * len, y: end.y - dy * len };
  return [end, { x: back.x + dy * half, y: back.y + dx * half }, { x: back.x - dy * half, y: back.y - dx * half }];
}

function arrow(doc: SvgDocument, edge: LaidEdge, STYLE: Styles, interactive: boolean): SVGPolygonElement {
  return el(doc, "polygon", interactive ? { points: pts(arrowCorners(edge)), style: STYLE.arrow, "data-part": "arrow" } : { points: pts(arrowCorners(edge)), style: STYLE.arrow });
}

/**
 * The chart as an <svg> element (not yet in the page). With the export's look (interactive false)
 * it carries no rings, Tab stops, list roles, classes or data attributes: only the drawing.
 */
export function renderChart(chart: FlowChart, layout: Layout, doc: SvgDocument = document, look: ChartLook = VIEW_LOOK): SVGSVGElement {
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

  const edges = el(doc, "g", live ? { "data-part": "edges", "aria-hidden": "true" } : {});
  for (const e of layout.edges) {
    const g = el(doc, "g", live ? { "data-from": e.from, "data-to": e.to, "data-kind": e.kind } : {});
    g.appendChild(el(doc, "polyline", { points: pts(e.points), style: STYLE.edge }));
    g.appendChild(arrow(doc, e, STYLE, live));
    if (e.label !== undefined && e.labelAt) {
      const t = el(doc, "text", { x: e.labelAt.x, y: e.labelAt.y, "text-anchor": e.labelAt.anchor, style: STYLE.edgeLabel });
      t.textContent = e.label;
      g.appendChild(t);
    }
    edges.appendChild(g);
  }
  svg.appendChild(edges);

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

/** Where control goes after a box, in words: "Next: step 4." or "Yes: step 5. No: step 6." */
function next(node: FlowNode, out: FlowEdge[]): string {
  if (node.kind === "connector" && out.length === 1 && out[0].kind === "link") return `: step ${out[0].to + 1}.`;
  if (out.length === 0) return ".";
  if (out.every((e) => e.label === undefined)) return `. Next: ${out.map((e) => `step ${e.to + 1}`).join(", ")}.`;
  return ` ${out.map((e) => `${e.label ?? "Then"}: step ${e.to + 1}.`).join(" ")}`;
}

/** The chart as a text outline in reading order, one entry per box: never the only way to read it. */
export function stepList(chart: FlowChart): { id: number; text: string }[] {
  const unreachable = new Set(chart.unreachable);
  return chart.nodes.map((node) => {
    const out = chart.edges.filter((e) => e.from === node.id);
    let words = kindWords(node);
    if (node.kind === "connector") words = out.some((e) => e.kind === "link") ? `Go to ${node.text}` : `Label ${node.text}`;
    if (node.note) words += ` (${node.note})`;
    if (unreachable.has(node.id)) words += " (never reached)";
    return { id: node.id, text: `${node.id + 1}. ${words}${next(node, out)}` };
  });
}
