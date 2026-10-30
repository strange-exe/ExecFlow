// The brand mark: the "<>" tile of public/icons/mark-v2.svg (a rounded square filled with the
// owner's "Blue to teal" gradient, top-left to bottom-right; two white chevrons), drawn as vector
// paths. Fixed brand colours, never theme colours: the mark is the product's logo, the same on
// every ground. One geometry, three outputs: drawBrandMark for a canvas (Capture snippet's credit
// line, the Flowchart PNG), brandMarkSvg for an SVG (the Flowchart export, the app's own mark).
// brand-mark.test.ts checks the geometry and the gradient against mark-v2.svg itself. Kept ASCII,
// no DOM at import.

type Stop = readonly [offset: number, color: string];

/** mark-v2.svg in its own 32-unit view box. */
export const BRAND_MARK = Object.freeze({
  view: 32,
  tile: Object.freeze({
    x: 1,
    y: 1,
    size: 30,
    radius: 7,
    /**
     * The tile's fill: a linear gradient in the tile's own box (SVG objectBoundingBox units), from
     * its top-left corner (x1, y1) to its bottom-right (x2, y2). White passes 4.5:1 at every point.
     */
    gradient: Object.freeze({
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stops: Object.freeze([Object.freeze([0, "#3561f0"]), Object.freeze([0.5, "#2a5ee0"]), Object.freeze([1, "#1a7a9a"])]) as readonly Stop[],
    }),
  }),
  glyph: Object.freeze({
    /** The two chevrons, "<" and ">", as absolute polylines. */
    lines: [
      [[12, 10], [6.5, 16], [12, 22]],
      [[20, 10], [25.5, 16], [20, 22]],
    ] as [number, number][][],
    stroke: "#ffffff",
    width: 3.5,
  }),
});

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * The tile gradient's colour at `t` (0 at the first stop, 1 at the last; clamped), as #rrggbb.
 * Interpolated in sRGB, as SVG and canvas gradients are by default.
 */
export function rampColor(t: number): string {
  const stops = BRAND_MARK.tile.gradient.stops;
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const i = Math.max(1, stops.findIndex(([offset]) => offset >= u));
  const [[o0, c0], [o1, c1]] = [stops[i - 1], stops[i]];
  const f = o1 === o0 ? 0 : (u - o0) / (o1 - o0);
  const [a, b] = [channels(c0), channels(c1)];
  return `#${a.map((v, j) => Math.round(v + (b[j] - v) * f).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The tile's colour at (vx, vy) in the mark's 32-unit view: where that point falls along the
 * tile's diagonal (the gradient runs in the tile's own box, so for this square tile the lines of
 * one colour run from bottom-left to top-right). Points outside the tile take the nearest end.
 */
export function tileColorAt(vx: number, vy: number): string {
  const { x, y, size } = BRAND_MARK.tile;
  return rampColor(((vx - x) / size + (vy - y) / size) / 2);
}

/** The glyph as SVG path data ("M12 10L6.5 16L12 22M20 10L25.5 16L20 22"). */
export function glyphPathData(): string {
  return BRAND_MARK.glyph.lines.map((line) => line.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("")).join("");
}

/**
 * Draws the mark with its top-left corner at (x, y), `size` px square, in the context's current
 * transform (Capture snippet draws its text under the export's scale, so the mark scales with it).
 * The fill and stroke styles are set here; the caller's line settings are put back after.
 */
export function drawBrandMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const k = size / BRAND_MARK.view;
  const { tile, glyph } = BRAND_MARK;
  const [x0, y0, w, r] = [x + tile.x * k, y + tile.y * k, tile.size * k, tile.radius * k];
  const saved = { lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, lineJoin: ctx.lineJoin };
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.lineTo(x0 + w - r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + r, r);
  ctx.lineTo(x0 + w, y0 + w - r);
  ctx.arcTo(x0 + w, y0 + w, x0 + w - r, y0 + w, r);
  ctx.lineTo(x0 + r, y0 + w);
  ctx.arcTo(x0, y0 + w, x0, y0 + w - r, r);
  ctx.lineTo(x0, y0 + r);
  ctx.arcTo(x0, y0, x0 + r, y0, r);
  ctx.closePath();
  // The gradient's x1..y2 are fractions of the tile's box, as in the SVG.
  const g = tile.gradient;
  const fill = ctx.createLinearGradient(x0 + g.x1 * w, y0 + g.y1 * w, x0 + g.x2 * w, y0 + g.y2 * w);
  for (const [offset, color] of g.stops) fill.addColorStop(offset, color);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  for (const line of glyph.lines) {
    line.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * k, y + py * k) : ctx.moveTo(x + px * k, y + py * k)));
  }
  ctx.strokeStyle = glyph.stroke;
  ctx.lineWidth = glyph.width * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineWidth = saved.lineWidth;
  ctx.lineCap = saved.lineCap;
  ctx.lineJoin = saved.lineJoin;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A prefix for this page's gradient ids, so marks from two exports pasted into one document don't
 * share an id either; the counter keeps the marks of one page apart. Letters and digits only.
 */
const ID_PREFIX = `ef-mark-${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
let made = 0;

/**
 * The mark as an <svg> element, `size` px square, built with createElementNS only (no markup is
 * parsed, so nothing but these elements and their fixed attributes can come out of it). Its tile
 * is filled with a gradient defined inside it, under an id of its own: several marks can sit in
 * one document, and an id shared by two would paint every tile with whichever came first.
 * Decorative: the text beside it names the product.
 */
export function brandMarkSvg(doc: Pick<Document, "createElementNS">, size: number): SVGSVGElement {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError(`brand mark size must be a positive number: ${size}`);
  const el = <K extends "svg" | "defs" | "linearGradient" | "stop" | "rect" | "path">(tag: K, attrs: Record<string, string>) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const { view, tile, glyph } = BRAND_MARK;
  const { x1, y1, x2, y2, stops } = tile.gradient;
  const id = `${ID_PREFIX}-${++made}`;
  const gradient = el("linearGradient", { id, x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) });
  gradient.append(...stops.map(([offset, color]) => el("stop", { offset: String(offset), "stop-color": color })));
  const defs = el("defs", {});
  defs.append(gradient);
  const svg = el("svg", { viewBox: `0 0 ${view} ${view}`, width: String(size), height: String(size), "aria-hidden": "true", focusable: "false" });
  svg.append(
    defs,
    el("rect", { x: String(tile.x), y: String(tile.y), width: String(tile.size), height: String(tile.size), rx: String(tile.radius), fill: `url(#${id})` }),
    el("path", {
      d: glyphPathData(), fill: "none", stroke: glyph.stroke, "stroke-width": String(glyph.width), "stroke-linecap": "round", "stroke-linejoin": "round",
    }),
  );
  return svg as SVGSVGElement;
}
