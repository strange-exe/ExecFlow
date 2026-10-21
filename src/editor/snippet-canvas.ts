// Capture snippet's canvas work (final-v3 sections 4.1 to 4.5, 7.4 and 7.6): the rows of a
// selection, prepared once per opening (the live parse, styles, placeholders, wrapping), and the
// image drawn from them for one set of options. The canvas is the export bitmap and also the
// preview (no <img>: the CSP's img-src never matches blob:). Every bitmap that won't be shown is
// freed (width and height 0). Lazy (the dialog's chunk).
import { findClusterBreak, type EditorState } from "@codemirror/state";
import { fitCut, ELLIPSIS, type ImageOptions, type LineSpan } from "../core/snippet";
import type { ImageColors } from "../core/snippet-dialog";
import type { Drawn, RenderOutcome, RenderSignal } from "../ui/snippet-flow";
import {
  chooseScale, edgeThickness, layoutImage, markSpecials, pixelsOk, readbackRect, SIZES, styledLines, tabStop, treeFor, trimRuns, wrapRows,
  type ImageLayout, type Metrics, type Row,
} from "./snippet-render";

/** Rows wrap at 100 columns, after a space at column 50 or later. */
const WRAP_AT = 100;
const BREAK_FROM = 50;
/** Rows drawn between yields; 50 rows or fewer never yield. */
const BATCH = 50;

/** One task later (a posted message: timers and animation frames are throttled in hidden pages). */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export interface Prepared {
  readonly rows: readonly Row[];
  /** The parse didn't reach the last line within 1 s: some colours are missing. */
  readonly partial: boolean;
  /** The selected text (at most 2,000 characters), for loading the fonts it needs. */
  readonly sample: string;
  readonly tabSize: number;
}

/** The rows of the captured lines, once per opening: the live parse within 1 s, styles, placeholders, trailing space trimmed, wrapping. */
export async function prepare(state: EditorState, plan: LineSpan, yieldTask: () => Promise<void> = nextTask): Promise<Prepared> {
  // The dialog's own task (building it, showModal, the budget's layout) ends first: with a parsed
  // file every later step resolves at once, and the whole chain ran as one 50 to 60 ms task
  // (Chromium, 300 lines, lab, 2026-10-21).
  await yieldTask();
  const from = state.doc.line(plan.first).from;
  const to = state.doc.line(plan.last).to;
  const { tree, partial } = await treeFor(state, to, 1000, yieldTask);
  const rows: Row[] = [];
  for (const line of styledLines(state, tree, plan.first, plan.last)) {
    const marked = { number: line.number, runs: trimRuns(markSpecials(line.runs)) };
    for (const row of wrapRows(marked, WRAP_AT, BREAK_FROM, state.tabSize)) rows.push({ ...row, runs: trimRuns(row.runs) });
  }
  return { rows, partial, sample: state.sliceDoc(from, to).slice(0, 2000), tabSize: state.tabSize };
}

/** The editor's code font, read once per opening from its content element. */
export interface CodeFont {
  readonly family: string;
  readonly size: number;
}

/** What a render hands to the scheduler and the dialog. */
export interface DrawnImage extends Drawn {
  readonly canvas: HTMLCanvasElement;
  readonly layout: ImageLayout;
  readonly scale: number;
  readonly metrics: Metrics;
}

const fontOf = (font: CodeFont, size: number, italic: boolean) => `${italic ? "italic " : ""}400 ${size}px ${font.family}`;

/** A bitmap that will never be shown again: its memory goes now, not at garbage collection. */
export function freeCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** 400 and 400 italic at the code size with the selected text, 400 a size smaller with the name. Drawing goes ahead whatever loading says. */
async function loadFonts(font: CodeFont, sample: string, name: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  // load() rejects when a font fails (MDN); a throw, should an engine throw instead, counts the same: a failed load, never a failed render.
  const load = async (spec: string, text: string) => document.fonts.load(spec, text || " ");
  await Promise.allSettled([load(fontOf(font, font.size, false), sample), load(fontOf(font, font.size, true), sample), load(fontOf(font, font.size - 1, false), name)]);
}

/** Ascent and descent of the font set on `ctx`, for the CSS half-leading baseline. */
function vertical(ctx: CanvasRenderingContext2D, size: number): { ascent: number; descent: number } {
  const m = ctx.measureText("0");
  const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : size * 0.8;
  const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : size * 0.2;
  return { ascent, descent };
}

/** A line box's baseline: CSS half-leading. */
const baselineIn = (top: number, lineH: number, v: { ascent: number; descent: number }) => top + (lineH - (v.ascent + v.descent)) / 2 + v.ascent;

/**
 * Walks a row's pieces left to right from the code's left edge: tabs go to the next stop, every
 * other piece advances by its measured width. `draw` gets each piece and its x (relative to codeX).
 */
function walkRow(
  ctx: CanvasRenderingContext2D, row: Row, font: CodeFont, space: { ch: number; spaceW: number; tabSize: number },
  draw?: (text: string, x: number, run: Row["runs"][number]) => void,
): number {
  let x = row.indent * space.spaceW;
  let current = "";
  for (const run of row.runs) {
    const f = fontOf(font, font.size, run.italic);
    if (f !== current) ctx.font = current = f;
    const parts = run.special ? [run.text] : run.text.split("\t");
    parts.forEach((part, k) => {
      if (k > 0) x = tabStop(x, space.spaceW, space.ch, space.tabSize);
      if (!part) return;
      draw?.(part, x, run);
      x += ctx.measureText(part).width;
    });
  }
  return x;
}

/** A small hooked arrow (a quarter curve down and to the right, two-stroke head): the continuation mark. Not a glyph, and not the call-site elbow. */
function hookMark(ctx: CanvasRenderingContext2D, right: number, top: number, ch: number, lineH: number): void {
  const w = ch;
  const h = 0.4 * lineH;
  const x0 = right - w;
  const y0 = top + (lineH - h) / 2;
  const sx = x0 + w * 0.25;
  const ey = y0 + h * 0.7;
  const ex = x0 + w * 0.95;
  const r = Math.min(w * 0.35, h * 0.5);
  const head = Math.min(w * 0.3, h * 0.3);
  ctx.beginPath();
  ctx.moveTo(sx, y0);
  ctx.lineTo(sx, ey - r);
  ctx.quadraticCurveTo(sx, ey, sx + r, ey);
  ctx.lineTo(ex, ey);
  ctx.moveTo(ex - head, ey - head);
  ctx.lineTo(ex, ey);
  ctx.lineTo(ex - head, ey + head);
  ctx.stroke();
}

/** The name as drawing units: grapheme clusters, each placeholder one unit (placeholders are never cut). */
function nameUnits(name: string): { text: string; special: boolean }[] {
  const units: { text: string; special: boolean }[] = [];
  for (const run of markSpecials([{ text: name, token: "text-secondary", italic: false }])) {
    if (run.special) {
      units.push({ text: run.text, special: true });
      continue;
    }
    for (let pos = 0; pos < run.text.length; ) {
      const next = findClusterBreak(run.text, pos);
      units.push({ text: run.text.slice(pos, next), special: false });
      pos = next;
    }
  }
  return units;
}

/**
 * Draws the image for one set of options. At scale 1 too big: too-big; no 2D context: device; any
 * throw: failed; the signal set at a yield: stopped (the canvas freed). Identity fills first (the
 * whole bitmap, the edge, the rule, so the bitmap is opaque and the lines crisp), then the text
 * under ctx.scale.
 */
export async function drawImage(
  prepared: Prepared, options: ImageOptions, colors: ImageColors, signal: RenderSignal, font: CodeFont, name: string,
): Promise<RenderOutcome<DrawnImage>> {
  let canvas: HTMLCanvasElement | null = null;
  let measure: HTMLCanvasElement | null = null;
  let kept = false;
  try {
    await loadFonts(font, prepared.sample, options.name ? name : "");
    // More than one batch: the preparing (on the first render) and the fonts' check end their task
    // before the measuring pass (one 36 to 57 ms task otherwise, Chromium, 300 rows, lab, 2026-10-21).
    if (prepared.rows.length > BATCH) await nextTask();
    if (signal.stopped) return { ok: false, reason: "stopped" };
    measure = document.createElement("canvas");
    measure.width = 1;
    measure.height = 1;
    const m = measure.getContext("2d");
    if (!m) return { ok: false, reason: "device" };
    m.font = fontOf(font, font.size, false);
    const ch = m.measureText("0").width;
    const spaceW = m.measureText(" ").width;
    const lineH = font.size * 1.5;
    const space = { ch, spaceW, tabSize: prepared.tabSize };
    const codeV = vertical(m, font.size);
    let widest = 0;
    for (const row of prepared.rows) widest = Math.max(widest, walkRow(m, row, font, space));
    const metrics: Metrics = { ch, lineH, widest };
    const layout = layoutImage(prepared.rows, metrics, options);
    const fit = chooseScale(layout.width, layout.height);
    if (!fit) return { ok: false, reason: "too-big" };
    const { scale: s } = fit;
    const t = edgeThickness(s);

    canvas = document.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "device" };
    const { E, P } = SIZES;
    // At the identity transform, in bitmap pixels: the ground, the edge (t thick), the rule.
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, fit.width, fit.height);
    ctx.fillStyle = colors.divider;
    ctx.fillRect(0, 0, fit.width, t);
    ctx.fillRect(0, fit.height - t, fit.width, t);
    ctx.fillRect(0, 0, t, fit.height);
    ctx.fillRect(fit.width - t, 0, t, fit.height);
    if (options.name) {
      const x0 = Math.round((E + P) * s);
      ctx.fillStyle = colors.border;
      ctx.fillRect(x0, Math.round(layout.ruleY * s), Math.round((layout.width - E - P) * s) - x0, t);
    }
    ctx.scale(s, s);
    ctx.direction = "ltr";
    ctx.textBaseline = "alphabetic";

    if (options.name) {
      ctx.font = fontOf(font, font.size - 1, false);
      const units = nameUnits(name);
      const widths = new Map<string, number>();
      const widthOf = (text: string) => widths.get(text) ?? widths.set(text, ctx.measureText(text).width).get(text)!;
      const cut = fitCut(units.map((u) => u.text), widthOf, layout.width - 2 * (E + P));
      const shownUnits = cut ? [...units.slice(0, cut.start), { text: ELLIPSIS, special: false }, ...units.slice(units.length - cut.end)] : units;
      const y = baselineIn(layout.nameTop, lineH, vertical(ctx, font.size - 1));
      let x = E + P;
      for (let i = 0; i < shownUnits.length; ) {
        let j = i;
        let text = "";
        while (j < shownUnits.length && shownUnits[j].special === shownUnits[i].special) text += shownUnits[j++].text;
        ctx.fillStyle = shownUnits[i].special ? colors.danger : colors["text-secondary"];
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
        i = j;
      }
    }

    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors["gutter-text"];
    const rows = prepared.rows;
    // More than one batch: the measuring pass, the bitmap's allocation and its fills end their task
    // before the text pass starts (50 rows or fewer still never yield).
    if (rows.length > BATCH) {
      await nextTask();
      if (signal.stopped) return { ok: false, reason: "stopped" };
    }
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % BATCH === 0) {
        await nextTask();
        if (signal.stopped) return { ok: false, reason: "stopped" };
      }
      const row = rows[i];
      const top = layout.codeTop + i * lineH;
      const y = baselineIn(top, lineH, codeV);
      if (row.number !== null && options.numbers) {
        ctx.font = fontOf(font, font.size, false);
        const label = String(row.number);
        ctx.fillStyle = colors["gutter-text"];
        ctx.fillText(label, layout.gutterRight - ctx.measureText(label).width, y);
      } else if (row.number === null) {
        hookMark(ctx, layout.markRight, top, ch, lineH);
      }
      walkRow(ctx, row, font, space, (text, x, run) => {
        ctx.fillStyle = colors[run.token];
        ctx.fillText(text, layout.codeX + x, y);
      });
    }
    kept = true;
    return { ok: true, value: { canvas, colors, t, layout, scale: s, metrics } };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    if (measure) freeCanvas(measure);
    if (canvas && !kept) freeCanvas(canvas);
  }
}

/** The export's readback (7.5): one row of the top padding, checked against the colours it was drawn with. False when reading throws. */
export function readbackOk(canvas: HTMLCanvasElement, colors: ImageColors, t: number): boolean {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const r = readbackRect(t);
    return pixelsOk(ctx.getImageData(r.x, r.y, r.w, r.h).data, colors.divider, colors.bg, t);
  } catch {
    return false;
  }
}
