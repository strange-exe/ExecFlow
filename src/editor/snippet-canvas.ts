// Capture snippet's canvas work (final-v3 sections 4.1 to 4.5, 7.4 and 7.6; round 2,
// .claude/design/batch3/s.md): the rows of a selection, prepared once per opening (the live parse,
// styles, placeholders, wrapping), and the image drawn from them for one set of options. The canvas
// is the export bitmap and also the preview (no <img>: the CSP's img-src never matches blob:). Every
// bitmap that won't be shown is freed (width and height 0). Lazy (the dialog's chunk).
import { findClusterBreak, type EditorState } from "@codemirror/state";
import { fitCut, ELLIPSIS, type LineSpan } from "../core/snippet";
import { CREDIT_TEXT, PADDING, type ImageColors, type ImageOptions } from "../core/snippet-dialog";
import { IMAGE_MIXES, over } from "../theme/contrast";
import type { Drawn, RenderOutcome, RenderSignal } from "../ui/snippet-flow";
import { drawBrandMark } from "./brand-mark";
import {
  cardRect, chooseScale, creditInk, creditMark, edgeThickness, layoutImage, markSpecials, pixelsOk, readbackRect, SIZES, styledLines, tabStop, treeFor, trimRuns, windowBarGround,
  wrapRows, type CreditPlace, type ImageLayout, type Metrics, type Row,
} from "./snippet-render";

/** Rows wrap at 100 columns, after a space at column 50 or later. */
const WRAP_AT = 100;
const BREAK_FROM = 50;
/**
 * More rows than this: the render's set-up and its fills each end their task before the text pass
 * (at 50 rows or fewer they don't). The text pass yields on time at any row count (inSlices, SLICE_MS).
 */
const BATCH = 50;
/** The text pass yields once this much time has gone since its last yield (a row count cost 5 hops per 200 rows, 30 ms each in Windows WebKit). */
export const SLICE_MS = 8;

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

/**
 * Runs `each` for 0 to count - 1, yielding a task whenever more than `budget` ms have gone since the
 * slice began; the signal is read after every yield. False: it was set (stopped, nothing more drawn).
 */
export async function inSlices(
  count: number, each: (i: number) => void, signal: RenderSignal,
  yieldTask: () => Promise<void> = nextTask, now: () => number = () => performance.now(), budget = SLICE_MS,
): Promise<boolean> {
  let slice = now();
  for (let i = 0; i < count; i++) {
    if (i > 0 && now() - slice > budget) {
      await yieldTask();
      if (signal.stopped) return false;
      slice = now();
    }
    each(i);
  }
  return true;
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
  /** The scale drawn at: the chosen one, or the step it had to take to fit. */
  readonly scale: number;
  readonly metrics: Metrics;
  /** The readback's row (bitmap px) and the ground drawn there. */
  readonly readback: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly ground: string };
}

/** The layout options of a set of image options. */
export const layoutOf = (o: Pick<ImageOptions, "numbers" | "name" | "frame" | "background" | "padding" | "mark">) =>
  ({ numbers: o.numbers, name: o.name, frame: o.frame, pad: o.background ? PADDING[o.padding] : 0, credit: o.mark }) as const;

/** A rectangle with its own radius per corner (top-left, top-right, bottom-right, bottom-left), as a path. */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: readonly [number, number, number, number]): void {
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** Runs of consecutive highlighted rows as [first row, row after the last]; a continuation row belongs to its line. */
function bands(rows: readonly Row[], highlight: readonly number[]): [number, number][] {
  const lit = new Set(highlight);
  const out: [number, number][] = [];
  let line = 0;
  rows.forEach((row, i) => {
    if (row.number !== null) line = row.number;
    if (!lit.has(line)) return;
    const last = out.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  });
  return out;
}

const fontOf = (font: CodeFont, size: number, italic: boolean) => `${italic ? "italic " : ""}400 ${size}px ${font.family}`;

/** A bitmap that will never be shown again: its memory goes now, not at garbage collection. */
export function freeCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 400 and 400 italic at the code size with the selected text, 400 a size smaller with the name.
 * Drawing goes ahead whatever loading says. True: both code faces loaded (their widths are final).
 */
async function loadFonts(font: CodeFont, sample: string, name: string): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return true;
  // load() rejects when a font fails (MDN); a throw, should an engine throw instead, counts the same: a failed load, never a failed render.
  const load = async (spec: string, text: string) => document.fonts.load(spec, text || " ");
  const [regular, italic] = await Promise.allSettled([
    load(fontOf(font, font.size, false), sample), load(fontOf(font, font.size, true), sample), load(fontOf(font, font.size - 1, false), name),
  ]);
  return regular.status === "fulfilled" && italic.status === "fulfilled";
}

/** The measuring pass's result: the code font's 0 and space, its line box and baseline, the widest row. */
export interface Measured {
  readonly ch: number;
  readonly spaceW: number;
  readonly lineH: number;
  readonly codeV: { readonly ascent: number; readonly descent: number };
  readonly widest: number;
}
const MEASURED = new WeakMap<Prepared, { readonly font: CodeFont; readonly measured: Measured }>();

/**
 * The measuring pass once per opening: the rows and the font are fixed for it, and no option feeds
 * into it. Kept only when the code fonts loaded (`final`): a fallback face's widths are never kept.
 */
export function measuredOnce(prepared: Prepared, font: CodeFont, final: boolean, measure: () => Measured | null): Measured | null {
  const kept = MEASURED.get(prepared);
  if (kept && kept.font.family === font.family && kept.font.size === font.size) return kept.measured;
  const measured = measure();
  if (measured && final) MEASURED.set(prepared, { font, measured });
  return measured;
}

/** Ascent and descent of the font set on `ctx`, for the CSS half-leading baseline. */
function vertical(ctx: CanvasRenderingContext2D, size: number): { ascent: number; descent: number } {
  const m = ctx.measureText("0");
  const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : size * 0.8;
  const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : size * 0.2;
  return { ascent, descent };
}

/**
 * A measured width on the 1/64 px grid fonts are laid out on. The bitmap is ceil(CSS size x scale),
 * so a hair over a whole pixel (Linux WebKit measured a card that is 411 px elsewhere as just over
 * it: CI, 2026-10-23) made every image 1 px wider there. Rounding first gives every engine the same size.
 */
export const onGrid = (px: number) => Math.round(px * 64) / 64;

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
 * The "Made with CodeEditor" line, right-aligned at its place (card coordinates, under the drawing's
 * scale), with the brand mark before it (round 3; its fixed brand colours, brand-mark.ts).
 */
function drawCredit(ctx: CanvasRenderingContext2D, at: CreditPlace, font: CodeFont, ink: string): void {
  ctx.font = fontOf(font, at.size, false);
  const width = onGrid(ctx.measureText(CREDIT_TEXT).width);
  ctx.fillStyle = ink;
  ctx.fillText(CREDIT_TEXT, at.right - width, baselineIn(at.top, at.size * 1.5, vertical(ctx, at.size)));
  const mark = creditMark(at, width);
  drawBrandMark(ctx, mark.x, mark.y, mark.size);
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
    const final = await loadFonts(font, prepared.sample, options.name ? name : "");
    // More than one batch: the preparing (on the first render) and the fonts' check end their task
    // before the measuring pass (one 36 to 57 ms task otherwise, Chromium, 300 rows, lab, 2026-10-21).
    if (prepared.rows.length > BATCH) await nextTask();
    if (signal.stopped) return { ok: false, reason: "stopped" };
    const measured = measuredOnce(prepared, font, final, () => {
      measure = document.createElement("canvas");
      measure.width = 1;
      measure.height = 1;
      const m = measure.getContext("2d");
      if (!m) return null;
      m.font = fontOf(font, font.size, false);
      const ch = onGrid(m.measureText("0").width);
      const spaceW = onGrid(m.measureText(" ").width);
      const codeV = vertical(m, font.size);
      let widest = 0;
      for (const row of prepared.rows) widest = Math.max(widest, walkRow(m, row, font, { ch, spaceW, tabSize: prepared.tabSize }));
      return { ch, spaceW, lineH: font.size * 1.5, codeV, widest: onGrid(widest) };
    });
    if (!measured) return { ok: false, reason: "device" };
    const { ch, spaceW, lineH, codeV, widest } = measured;
    const space = { ch, spaceW, tabSize: prepared.tabSize };
    const metrics: Metrics = { ch, lineH, widest };
    const layout = layoutImage(prepared.rows, metrics, layoutOf(options));
    const fit = chooseScale(layout.width, layout.height, options.scale);
    if (!fit) return { ok: false, reason: "too-big" };
    const { scale: s } = fit;
    const t = edgeThickness(s);

    canvas = document.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "device" };
    const { E, P } = SIZES;
    const card = cardRect(layout, fit, s);
    const windowed = options.frame === "window";
    // At the identity transform, in bitmap pixels, so straight edges stay crisp: the background
    // (none: transparent), the card's edge (t thick) and its ground with rounded corners, the
    // window's bar or the plain rule, the highlight bands.
    if (options.background) {
      ctx.fillStyle = over(colors.bg, colors.action, IMAGE_MIXES.mat.pct / 100);
      ctx.fillRect(0, 0, fit.width, fit.height);
    }
    ctx.fillStyle = colors.divider;
    roundedRect(ctx, card.x, card.y, card.w, card.h, [card.r, card.r, card.r, card.r]);
    ctx.fill();
    const inner = Math.max(0, card.r - t);
    ctx.fillStyle = colors.bg;
    roundedRect(ctx, card.x + t, card.y + t, card.w - 2 * t, card.h - 2 * t, [inner, inner, inner, inner]);
    ctx.fill();
    const bar = windowed ? windowBarGround(colors) : colors.bg;
    if (windowed) {
      const barEnd = card.y + Math.round(layout.barBottom * s);
      ctx.fillStyle = bar;
      roundedRect(ctx, card.x + t, card.y + t, card.w - 2 * t, barEnd - card.y - t, [inner, inner, 0, 0]);
      ctx.fill();
      ctx.fillStyle = colors.divider;
      ctx.fillRect(card.x + t, barEnd, card.w - 2 * t, t);
    } else if (options.name) {
      const x0 = card.x + Math.round((E + P) * s);
      ctx.fillStyle = colors.border;
      ctx.fillRect(x0, card.y + Math.round(layout.ruleY * s), card.x + Math.round((layout.cardWidth - E - P) * s) - x0, t);
    }
    if (options.highlight.length) {
      ctx.fillStyle = over(colors.bg, colors.focus, IMAGE_MIXES.mark.pct / 100);
      for (const [from, to] of bands(prepared.rows, options.highlight)) {
        const top = card.y + Math.round((layout.codeTop + from * lineH) * s);
        ctx.fillRect(card.x + t, top, card.w - 2 * t, card.y + Math.round((layout.codeTop + to * lineH) * s) - top);
      }
    }
    const readback = { ...readbackRect(card, t), ground: bar };
    ctx.setTransform(s, 0, 0, s, card.x, card.y);
    ctx.direction = "ltr";
    ctx.textBaseline = "alphabetic";

    if (options.name) {
      ctx.font = fontOf(font, font.size - 1, false);
      const units = nameUnits(name);
      const widths = new Map<string, number>();
      const widthOf = (text: string) => widths.get(text) ?? widths.set(text, ctx.measureText(text).width).get(text)!;
      const cut = fitCut(units.map((u) => u.text), widthOf, layout.cardWidth - 2 * (E + P));
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
    // before the text pass starts (not at 50 rows or fewer). The text pass then yields every SLICE_MS
    // ms whatever the row count, so a slow small render can yield too, and stop there.
    if (rows.length > BATCH) {
      await nextTask();
      if (signal.stopped) return { ok: false, reason: "stopped" };
    }
    const drawn = await inSlices(rows.length, (i) => {
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
    }, signal);
    if (!drawn) return { ok: false, reason: "stopped" };
    if (layout.credit) drawCredit(ctx, layout.credit, font, creditInk(colors, options.background));
    kept = true;
    return { ok: true, value: { canvas, colors, t, layout, scale: s, metrics, readback } };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    if (measure) freeCanvas(measure);
    if (canvas && !kept) freeCanvas(canvas);
  }
}

/** The export's readback (7.5): one row of the card's left edge and its ground, checked against the colours it was drawn with. False when reading throws. */
export function readbackOk(r: Pick<DrawnImage, "canvas" | "colors" | "t" | "readback">): boolean {
  try {
    const ctx = r.canvas.getContext("2d");
    if (!ctx) return false;
    const at = r.readback;
    return pixelsOk(ctx.getImageData(at.x, at.y, at.w, at.h).data, r.colors.divider, at.ground, r.t);
  } catch {
    return false;
  }
}
