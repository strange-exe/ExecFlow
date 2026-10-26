// The Flowchart export (milestone 4): an SVG built from the same safe DOM as the view (renderChart
// with the export's look: every colour resolved to #rrggbb, font lists with generic fallbacks,
// no rings, Tab stops, classes or data attributes) and a PNG drawn on a canvas from the same layout
// with the page's loaded fonts (drawing the SVG as an image would lose those fonts, and WebKit can
// refuse to read back a canvas an SVG image was drawn on). Every export carries the footer the owner
// asked for: the brand mark, "Made with CodeEditor", the file and the function.
import { drawBrandMark, brandMarkSvg } from "../editor/brand-mark";
import { nameOf } from "../core/paths";
import { cleanFilename, tagUnshown as shown } from "../core/safety";
import { DEFAULT_OWN, OWN } from "../theme/palettes";
import { PAPER } from "../theme/print-ink";
import { nameText } from "./labels";
import { METRICS, type Layout, type Point } from "./layout";
import type { FlowChart, FlowNode } from "./model";
import { arrowCorners, CHART_TOKENS, renderChart, type ChartToken, type SvgDocument } from "./render";

export { CHART_TOKENS };

/** The colours an export is drawn in: the chart's tokens, the ground and the footer's rule. */
export type ExportColors = Record<ChartToken | "bg" | "border", string>;
export interface ExportLook {
  colors: ExportColors;
  codeFont: string;
  uiFont: string;
}

/** "Print-safe light": the default theme's light ink on white (Save as PDF's print palette). */
export function printColors(): ExportColors {
  const light = OWN[DEFAULT_OWN].light;
  return { "surface-raised": PAPER, "border-strong": light["border-strong"], text: light.text, "text-secondary": light["text-secondary"], border: light.border, bg: PAPER };
}

export const FOOTER_TEXT = "Made with CodeEditor";
/** The footer under the chart: one line, the mark at the left margin. */
export const FOOTER = { height: 44, mark: 20, margin: 24, gap: 8, between: 16, textW: 7, fontSize: 12 } as const;

/** What the footer says after the credit: the file, then the function (a Python file's top level by name). */
export function footerWhat(file: string, chart: Pick<FlowChart, "name">): string {
  const name = nameText(nameOf(file) || file);
  return chart.name === "Program" ? `${name}, top level` : `${name}, function ${chart.name}`;
}

/** The export's size in CSS px: the chart, widened if the footer needs it, plus the footer. */
export function exportSize(layout: Layout, what: string): { width: number; height: number; footerWidth: number } {
  const footerWidth = 2 * FOOTER.margin + FOOTER.mark + FOOTER.gap + (FOOTER_TEXT.length + [...what].length) * FOOTER.textW + FOOTER.between;
  return { width: Math.ceil(Math.max(layout.width, footerWidth)), height: Math.ceil(layout.height + FOOTER.height), footerWidth };
}

const NS = "http://www.w3.org/2000/svg";

function el(doc: SvgDocument, tag: string, attrs: Record<string, string | number>): Element {
  const e = doc.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export interface ExportInput {
  chart: FlowChart;
  layout: Layout;
  /** The file's path or name (only its name is shown). */
  file: string;
  look: ExportLook;
}

/** The export as an <svg> element: title, ground, the chart, then the footer. Serialize it with XMLSerializer. */
export function exportSvg(input: ExportInput, doc: SvgDocument = document): SVGSVGElement {
  const { chart, layout, file, look } = input;
  const what = footerWhat(file, chart);
  const { width, height } = exportSize(layout, what);
  const fileName = nameText(nameOf(file) || file);
  const title = `Flowchart of ${chart.name} in ${fileName}`;
  const root = el(doc, "svg", { xmlns: NS, viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": title }) as SVGSVGElement;
  const titleEl = el(doc, "title", {});
  titleEl.textContent = title;
  root.appendChild(titleEl);
  root.appendChild(el(doc, "rect", { x: 0, y: 0, width, height, fill: look.colors.bg }));
  const drawing = renderChart(chart, layout, doc, { color: (t) => look.colors[t], codeFont: look.codeFont, uiFont: look.uiFont, interactive: false });
  drawing.setAttribute("x", String(Math.round((width - layout.width) / 2)));
  drawing.setAttribute("y", "0");
  root.appendChild(drawing);

  const y = layout.height;
  const footer = el(doc, "g", {});
  footer.appendChild(el(doc, "line", { x1: FOOTER.margin, y1: y + 0.5, x2: width - FOOTER.margin, y2: y + 0.5, stroke: look.colors.border, "stroke-width": 1 }));
  const markY = y + (FOOTER.height - FOOTER.mark) / 2;
  const mark = brandMarkSvg(doc, FOOTER.mark);
  mark.setAttribute("x", String(FOOTER.margin));
  mark.setAttribute("y", String(markY));
  footer.appendChild(mark);
  const baseline = y + FOOTER.height / 2 + 4;
  const textX = FOOTER.margin + FOOTER.mark + FOOTER.gap;
  const credit = el(doc, "text", { x: textX, y: baseline, style: `fill:${look.colors.text};font-family:${look.uiFont};font-size:${FOOTER.fontSize}px;font-weight:600` });
  credit.textContent = FOOTER_TEXT;
  const where = el(doc, "text", { x: width - FOOTER.margin, y: baseline, "text-anchor": "end", style: `fill:${look.colors["text-secondary"]};font-family:${look.uiFont};font-size:${FOOTER.fontSize}px` });
  where.textContent = what;
  footer.appendChild(credit);
  footer.appendChild(where);
  root.appendChild(footer);
  return root;
}

/** Letters, digits, _ and - only; every other run becomes one -; no - at either end. */
const slug = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

/** `<file>-<function>-flowchart.<ext>`: "grades-c-main-flowchart.png". */
export function exportFileName(file: string, fn: string, ext: "png" | "svg"): string {
  const part = (text: string) => slug(shown(text)).slice(0, 60).replace(/-+$/, "");
  const name = [part(nameOf(file) || file), part(fn)].filter(Boolean).join("-") || "chart";
  return cleanFilename(`${name}-flowchart.${ext}`);
}

/** The browsers' safe canvas size (the same caps as Capture snippet's, editor/snippet-render.ts). */
export const MAX_AREA = 16_777_216;
export const MAX_SIDE = 16_384;
const SCALES = [2, 1.5, 1, 0.75, 0.5, 0.25] as const;

/** 2x when the bitmap fits the caps, else the largest smaller step that does (`reduced`); null past 0.25x. */
export function chooseExportScale(width: number, height: number): { scale: number; width: number; height: number; reduced: boolean } | null {
  for (const scale of SCALES) {
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (w * h <= MAX_AREA && w <= MAX_SIDE && h <= MAX_SIDE) return { scale, width: w, height: h, reduced: scale < SCALES[0] };
  }
  return null;
}

/** Where the footer's mark is drawn, in CSS px (the PNG's readback checks the tile's colour there). */
export function markSpot(layout: Layout): { x: number; y: number; size: number } {
  return { x: FOOTER.margin, y: layout.height + (FOOTER.height - FOOTER.mark) / 2, size: FOOTER.mark };
}

// ---------------------------------------------------------------- the PNG

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, pts: Point[], close: boolean) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
}

function drawShape(ctx: CanvasRenderingContext2D, node: FlowNode, b: { x: number; y: number; w: number; h: number }) {
  const { x, y, w, h } = b;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (node.kind) {
    case "start":
    case "end":
      roundRect(ctx, x, y, w, h, h / 2);
      break;
    case "decision":
      poly(ctx, [{ x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy }], true);
      break;
    case "io":
      poly(ctx, [{ x: x + METRICS.skew, y }, { x: x + w, y }, { x: x + w - METRICS.skew, y: y + h }, { x, y: y + h }], true);
      break;
    case "connector":
      ctx.beginPath();
      ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
      break;
    default:
      roundRect(ctx, x, y, w, h, 2);
  }
  ctx.fill();
  ctx.stroke();
  if (node.kind === "call") {
    ctx.beginPath();
    ctx.moveTo(x + METRICS.bar, y);
    ctx.lineTo(x + METRICS.bar, y + h);
    ctx.moveTo(x + w - METRICS.bar, y);
    ctx.lineTo(x + w - METRICS.bar, y + h);
    ctx.stroke();
  }
}

/**
 * Draws the export on a canvas context already sized `width x height` CSS px times `scale`:
 * the same geometry as exportSvg, in the fonts the page has loaded.
 */
export function drawExport(ctx: CanvasRenderingContext2D, input: ExportInput, scale: number): void {
  const { chart, layout, file, look } = input;
  const c = look.colors;
  const what = footerWhat(file, chart);
  const { width, height } = exportSize(layout, what);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(Math.round((width - layout.width) / 2), 0);
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  // Edges, arrowheads and their labels.
  ctx.strokeStyle = c["border-strong"];
  for (const e of layout.edges) {
    poly(ctx, e.points, false);
    ctx.stroke();
    poly(ctx, arrowCorners(e), true);
    ctx.fillStyle = c["border-strong"];
    ctx.fill();
    if (e.label !== undefined && e.labelAt) {
      ctx.font = `12px ${look.uiFont}`;
      ctx.fillStyle = c["text-secondary"];
      ctx.textAlign = e.labelAt.anchor === "end" ? "right" : "left";
      ctx.fillText(e.label, e.labelAt.x, e.labelAt.y);
    }
  }
  // Boxes and their labels.
  const boxes = new Map(layout.boxes.map((b) => [b.id, b]));
  ctx.textAlign = "center";
  for (const node of chart.nodes) {
    const b = boxes.get(node.id);
    if (!b) continue;
    ctx.fillStyle = c["surface-raised"];
    ctx.strokeStyle = c["border-strong"];
    drawShape(ctx, node, b);
    const lines = node.note ? [...node.label, node.note] : node.label;
    const first = b.y + b.h / 2 - ((lines.length - 1) * METRICS.lineH) / 2 + METRICS.fontSize * 0.35;
    lines.forEach((line, i) => {
      const note = node.note !== undefined && i === lines.length - 1;
      ctx.font = note ? `italic 11px ${look.uiFont}` : `${METRICS.fontSize}px ${look.codeFont}`;
      ctx.fillStyle = note ? c["text-secondary"] : c.text;
      ctx.fillText(line, b.x + b.w / 2, first + i * METRICS.lineH);
    });
  }
  ctx.restore();
  // The footer.
  const y = layout.height;
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(FOOTER.margin, y + 0.5);
  ctx.lineTo(width - FOOTER.margin, y + 0.5);
  ctx.stroke();
  const spot = markSpot(layout);
  drawBrandMark(ctx, spot.x, spot.y, spot.size);
  const baseline = y + FOOTER.height / 2 + 4;
  const textX = FOOTER.margin + FOOTER.mark + FOOTER.gap;
  ctx.textAlign = "left";
  ctx.font = `600 ${FOOTER.fontSize}px ${look.uiFont}`;
  ctx.fillStyle = c.text;
  ctx.fillText(FOOTER_TEXT, textX, baseline);
  ctx.font = `${FOOTER.fontSize}px ${look.uiFont}`;
  ctx.fillStyle = c["text-secondary"];
  ctx.textAlign = "right";
  ctx.fillText(what, width - FOOTER.margin, baseline);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
