// The brand mark in exported images: the "<>" tile of public/icons/mark-v2.svg (a #2f5bea rounded
// square, two white chevrons), drawn as vector paths. Fixed brand colours, never theme colours: the
// mark is the product's logo, the same on every ground. One geometry, two outputs: drawBrandMark for
// a canvas (Capture snippet's credit line) and brandMarkSvg for an SVG export (the Flowchart export).
// brand-mark.test.ts checks the geometry against mark-v2.svg itself. Kept ASCII, no DOM at import.

/** mark-v2.svg in its own 32-unit view box. */
export const BRAND_MARK = Object.freeze({
  view: 32,
  tile: Object.freeze({ x: 1, y: 1, size: 30, radius: 7, fill: "#2f5bea" }),
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
  ctx.fillStyle = tile.fill;
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
 * The mark as an <svg> element, `size` px square, built with createElementNS only (no markup is
 * parsed, so nothing but these three elements and their fixed attributes can come out of it).
 * Decorative: the text beside it names the product.
 */
export function brandMarkSvg(doc: Pick<Document, "createElementNS">, size: number): SVGSVGElement {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError(`brand mark size must be a positive number: ${size}`);
  const el = <K extends "svg" | "rect" | "path">(tag: K, attrs: Record<string, string>) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const { view, tile, glyph } = BRAND_MARK;
  const svg = el("svg", { viewBox: `0 0 ${view} ${view}`, width: String(size), height: String(size), "aria-hidden": "true", focusable: "false" });
  svg.append(
    el("rect", { x: String(tile.x), y: String(tile.y), width: String(tile.size), height: String(tile.size), rx: String(tile.radius), fill: tile.fill }),
    el("path", {
      d: glyphPathData(), fill: "none", stroke: glyph.stroke, "stroke-width": String(glyph.width), "stroke-linecap": "round", "stroke-linejoin": "round",
    }),
  );
  return svg as SVGSVGElement;
}
