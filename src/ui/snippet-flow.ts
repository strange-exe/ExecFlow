// Capture snippet's flow without a DOM (final-v3 sections 4.3, 5.2, 7.3 and 7.5): which colours a
// choice gives, the preview scheduler (one render at a time, the last good preview kept, nothing
// rendered while an export is busy), the exporter (readback, clipboard write and encode inside the
// click), and the dialog's frame budget. The dialog (snippet-dialog.ts) supplies the canvas work and
// the DOM through the deps; the unit tests supply fakes. Lazy (the dialog's chunk).
import type { ColorChoice, PaintFamily, PaintInfo } from "../core/snippet";
import { checkColors, sameOptions, type ImageColors, type ImageOptions } from "../core/snippet-dialog";
import { layoutOf } from "../editor/snippet-canvas";
import { chooseScale, layoutImage, type Metrics } from "../editor/snippet-render";
import { DEFAULT_OWN, OWN } from "../theme/palettes";

export { sameOptions };

// ---------------------------------------------------------------- colours (4.3)

/** What the dialog read from the document root when it opened: the family, the scheme, the theme's name and the 17 computed values. */
export interface Paint extends PaintInfo {
  readonly computed: Readonly<Record<string, string>>;
}

/** The family of the root's data-palette (themes.ts applyTheme): none is Deep Field; anything not an own palette is a palette theme. */
export function paintFamily(palette: string | undefined): PaintFamily {
  if (palette === undefined) return "deep-field";
  return palette === "signal" || palette === "slate" ? palette : "palette";
}

/**
 * The colours of a choice: what this tab painted, or the own palette's light or dark. Palette
 * themes offer the default theme's (Signal's; the choices are named so: core/snippet-dialog.ts).
 * Null: not all #rrggbb.
 */
export function imageColors(choice: ColorChoice, paint: Paint): ImageColors | null {
  if (choice === "match") return checkColors(paint.computed);
  return checkColors(OWN[paint.family === "palette" ? DEFAULT_OWN : paint.family][choice]);
}

// ---------------------------------------------------------------- the preview scheduler (7.3)

/** The frame's data-preview. */
export type PreviewState = "rendering" | "ready" | "too-big" | "failed";
/** Why a render made no image: over the size caps at scale 1, a colour or an exception, no canvas context on this device. */
export type RenderFailure = "too-big" | "failed" | "device";
/** What a render hands back: its bitmap, the colours it was drawn with, and the edge's thickness in bitmap pixels. */
export interface Drawn {
  readonly canvas: unknown;
  readonly colors: ImageColors;
  readonly t: number;
}
/** Read by the renderer after each yield (snippet-canvas.ts inSlices): when set, it frees its canvas and stops. */
export interface RenderSignal {
  readonly stopped: boolean;
}
export type RenderOutcome<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly reason: RenderFailure | "stopped" };

export interface SchedulerDeps<R extends Drawn> {
  render(options: ImageOptions, signal: RenderSignal): Promise<RenderOutcome<R>>;
  /**
   * The scale these options are drawn at (the dialog: the step a too-big scale takes; 0 when none
   * fits). Two requests that differ only in a Scale drawn at the same scale make the same image, so
   * the second one renders nothing. Without it, every Scale is its own image.
   */
  drawnScale?(options: ImageOptions): number;
  /** Frees a bitmap that will never be shown again. */
  free(result: R): void;
  /**
   * Shows a finished render, in one step (the scheduler frees the previous one right after).
   * `adopted`: nothing was drawn, the shown render takes newer options that make the same image.
   */
  swap(result: R, options: ImageOptions, generation: number, adopted: boolean): void;
  /** Removes the shown render and says why there is none (the preview never shows what the export would not produce); `adopted` as for swap. */
  fail(reason: RenderFailure, options: ImageOptions, generation: number, adopted: boolean): void;
  /** data-preview and aria-busy, after every change. */
  state(state: PreviewState): void;
  /** From 400 ms into a render until no render runs: "Making the preview..." (`first`) or "Updating the preview...". */
  pending(on: boolean, first: boolean): void;
}

/** The shown render (or the shown failure) and the options it was made with. */
export interface Current<R> {
  readonly result: R | null;
  readonly failure: RenderFailure | null;
  readonly options: ImageOptions;
  readonly generation: number;
}
/** A render an export waits for: `release()` frees it unless it was swapped in (the frame owns it then). */
export interface PinnedRender<R> {
  readonly result: R;
  readonly generation: number;
  release(): void;
}
export interface PreviewScheduler<R extends Drawn> {
  /** The options changed (or the first render): render them unless they are already shown or running. */
  request(options: ImageOptions): void;
  /** An export clicked while the preview isn't ready: the render for these options, pinned (never stopped by newer options). */
  renderFor(options: ImageOptions): Promise<PinnedRender<R>>;
  /** While an export is busy no render starts (at most three bitmaps alive); a pinned render still does. */
  hold(on: boolean): void;
  /** The dialog closed: nothing new starts, an unpinned render stops, the shown bitmap is freed; a pinned render runs on to its export. */
  cancel(): void;
  /** The shown render is a success with the newest options. */
  isReady(): boolean;
  current(): Current<R> | null;
}

export const PENDING_MS = 400;

interface Running<R> {
  readonly options: ImageOptions;
  readonly generation: number;
  pinned: boolean;
  outdated: boolean;
  cancelled: boolean;
  waiter: Waiter<R> | null;
}
interface Waiter<R> {
  resolve(p: PinnedRender<R>): void;
  reject(reason: RenderFailure): void;
}

/**
 * The scale the options are drawn at, from the rows and the code font's measures: the step a
 * too-big Scale takes (chooseScale), 0 when the image is too big at every scale. Before the
 * measures exist (no render has landed) it is the Scale chosen.
 */
export function drawnScaleOf(rows: readonly { readonly number: number | null }[], metrics: Metrics | null, o: ImageOptions): number {
  if (!metrics) return o.scale;
  const look = layoutImage(rows, metrics, layoutOf(o));
  return chooseScale(look.width, look.height, o.scale)?.scale ?? 0;
}

export interface DrawnScales {
  /** drawnScaleOf the newest rows and measures, kept per options object until the measures change. */
  scale(o: ImageOptions): number;
  /**
   * A render landed with these rows and measures. True when they differ from the last ones (a
   * render after a font fallback measures the real font differently): what was kept is dropped.
   */
  measure(rows: readonly { readonly number: number | null }[], metrics: Metrics): boolean;
}

/** The dialog's drawnScale for the scheduler: measures from every render, never only the first one. */
export function createDrawnScales(): DrawnScales {
  let rows: readonly { readonly number: number | null }[] | null = null;
  let metrics: Metrics | null = null;
  let kept = new WeakMap<ImageOptions, number>();
  return {
    scale(o) {
      if (!rows || !metrics) return o.scale;
      let s = kept.get(o);
      if (s === undefined) {
        s = drawnScaleOf(rows, metrics, o);
        kept.set(o, s);
      }
      return s;
    },
    measure(r, m) {
      if (r === rows && metrics && m.ch === metrics.ch && m.lineH === metrics.lineH && m.widest === metrics.widest) return false;
      rows = r;
      metrics = m;
      kept = new WeakMap();
      return true;
    },
  };
}

/** Both make the same image: the same options, or the same but for a Scale drawn at the same scale. */
export function sameImage(a: ImageOptions, b: ImageOptions, drawnScale?: (o: ImageOptions) => number): boolean {
  return sameOptions(a, b) || (!!drawnScale && sameOptions({ ...a, scale: b.scale }, b) && drawnScale(a) === drawnScale(b));
}

export function createPreviewScheduler<R extends Drawn>(deps: SchedulerDeps<R>): PreviewScheduler<R> {
  let current: Current<R> | null = null;
  let running: Running<R> | null = null;
  let newest: ImageOptions | null = null;
  let held = false;
  let closed = false;
  let generation = 0;
  /** A pinned render asked for while another one still runs: it starts as soon as that one stops. */
  let nextPinned: { options: ImageOptions; waiter: Waiter<R> } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingOn = false;
  let pendingFirst = true;

  const same = (a: ImageOptions, b: ImageOptions) => sameImage(a, b, deps.drawnScale);
  const isReady = () => !!current?.result && !!newest && same(current.options, newest);

  function report() {
    if (isReady()) deps.state("ready");
    else if (current?.failure && newest && same(current.options, newest) && !running) deps.state(current.failure === "too-big" ? "too-big" : "failed");
    else deps.state("rendering");
  }

  /**
   * The newest options make the shown image without being its options: nothing renders, the shown
   * result takes them (swap or fail again, marked adopted, with the same bitmap and generation), so
   * the frame's options and every later check are the newest ones.
   */
  function adopt(options: ImageOptions) {
    if (!current) return;
    current = { ...current, options };
    if (current.result) deps.swap(current.result, options, current.generation, true);
    else if (current.failure) deps.fail(current.failure, options, current.generation, true);
  }

  function stopPending() {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
    if (pendingOn) {
      pendingOn = false;
      deps.pending(false, pendingFirst);
    }
  }

  function start(options: ImageOptions, waiter: Waiter<R> | null) {
    const run: Running<R> = { options, generation: ++generation, pinned: waiter !== null, outdated: false, cancelled: false, waiter };
    running = run;
    report();
    if (!pendingOn) {
      clearTimeout(pendingTimer);
      pendingFirst = !current;
      pendingTimer = setTimeout(() => {
        pendingOn = true;
        deps.pending(true, pendingFirst);
      }, PENDING_MS);
    }
    const signal: RenderSignal = { get stopped() { return run.cancelled || (run.outdated && !run.pinned); } };
    let outcome: Promise<RenderOutcome<R>>;
    try {
      outcome = deps.render(options, signal);
    } catch {
      outcome = Promise.resolve({ ok: false, reason: "failed" });
    }
    outcome.then(
      (o) => finish(run, o),
      () => finish(run, { ok: false, reason: "failed" }),
    );
  }

  function pinnedOf(run: Running<R>, result: R): PinnedRender<R> {
    let released = false;
    return {
      result,
      generation: run.generation,
      release() {
        if (released) return;
        released = true;
        if (current?.result !== result) deps.free(result);
      },
    };
  }

  function finish(run: Running<R>, o: RenderOutcome<R>) {
    if (running === run) running = null;
    const discard = run.cancelled || (run.outdated && !run.pinned);
    if (o.ok) {
      if (discard) {
        deps.free(o.value);
      } else if (!closed) {
        const previous = current;
        current = { result: o.value, failure: null, options: run.options, generation: run.generation };
        deps.swap(o.value, run.options, run.generation, false);
        if (previous?.result) deps.free(previous.result);
      }
      if (!discard) run.waiter?.resolve(pinnedOf(run, o.value));
      else run.waiter?.reject("failed");
    } else {
      const reason = o.reason === "stopped" ? "failed" : o.reason;
      if (o.reason !== "stopped" && !discard && !closed) {
        const previous = current;
        current = { result: null, failure: reason, options: run.options, generation: run.generation };
        deps.fail(reason, run.options, run.generation, false);
        if (previous?.result) deps.free(previous.result);
      }
      run.waiter?.reject(reason);
    }
    kick();
    if (!running) stopPending();
    report();
  }

  /** Starts what should run next, if nothing runs: a waiting pinned render first (held or closed or not), else the newest options. */
  function kick() {
    if (!closed && current && newest && !sameOptions(current.options, newest) && same(current.options, newest)) adopt(newest);
    if (running) return;
    if (nextPinned) {
      const { options, waiter } = nextPinned;
      nextPinned = null;
      start(options, waiter);
      return;
    }
    if (closed || held || !newest) return;
    if (current && same(current.options, newest)) return;
    start(newest, null);
  }

  return {
    request(options) {
      if (closed) return;
      newest = options;
      if (running) {
        if (same(running.options, options)) running.outdated = false;
        else if (!running.pinned) running.outdated = true;
      }
      kick();
      report();
    },
    renderFor(options) {
      return new Promise<PinnedRender<R>>((resolve, reject) => {
        const waiter: Waiter<R> = { resolve, reject };
        if (running && same(running.options, options) && !running.cancelled) {
          running.pinned = true;
          running.outdated = false;
          const before = running.waiter;
          running.waiter = before
            ? { resolve: (p) => (before.resolve(p), resolve(p)), reject: (r) => (before.reject(r), reject(r)) }
            : waiter;
          return;
        }
        nextPinned = { options, waiter };
        if (running && !running.pinned) running.outdated = true;
        kick();
      });
    },
    hold(on) {
      held = on;
      if (!on) {
        kick();
        report();
      }
    },
    cancel() {
      closed = true;
      if (running && !running.pinned) running.cancelled = true;
      if (current?.result) deps.free(current.result);
      current = current ? { ...current, result: null } : null;
      stopPending();
    },
    isReady,
    current: () => current,
  };
}

// ---------------------------------------------------------------- the exporter (7.5)

export type ExportKind = "copy" | "download";
export type ExportResult =
  | { readonly kind: "copied" }
  | { readonly kind: "downloaded"; readonly file: string }
  /** The write was refused or cancelled; the PNG made for it (and its name at click time) stays for Download. */
  | { readonly kind: "denied"; readonly blob: Blob; readonly file: string }
  | { readonly kind: "failed"; readonly reason: "device" | "privacy" | "updating" | "other" }
  | { readonly kind: "refused"; readonly reason: "too-big" }
  | { readonly kind: "preview-failed" };

export interface ExporterDeps<R extends Drawn> {
  readonly scheduler: PreviewScheduler<R>;
  /** getImageData of the readback row, checked (snippet-canvas readbackOk); false also when reading throws. */
  readbackOk(result: R): boolean;
  /** canvas.toBlob(done, "image/png"): it copies the bitmap at the call (WebKit even encodes inside it). */
  toBlob(result: R, done: (blob: Blob | null) => void): void;
  /** navigator.clipboard.write with one image/png item holding the promise; a throw is a rejected promise. */
  write(png: Promise<Blob>): Promise<void>;
  download(name: string, blob: Blob): void;
  /** The options at click time. */
  options(): ImageOptions;
  fileName(options: ImageOptions): string;
  /** The shown preview's failure, when it is of the newest options: the click repeats it instead of exporting. */
  previewProblem(): RenderFailure | null;
  /** An export starts: the status clears, #app data-capture="exporting". */
  started(kind: ExportKind): void;
  /** "Making the PNG..." from 400 ms into an export until it ends. */
  pending(on: boolean): void;
  /** The result: to the dialog's status when `open`, else to the page's notice. */
  finish(result: ExportResult, kind: ExportKind, open: boolean): void;
  isOpen(): boolean;
}
export interface Exporter {
  copy(e: { readonly detail: number }): void;
  download(e: { readonly detail: number }): void;
  busy(): boolean;
}

type Reason = "device" | "updating" | RenderFailure;
const refusalOf = (problem: RenderFailure): ExportResult =>
  problem === "too-big" ? { kind: "refused", reason: "too-big" } : problem === "device" ? { kind: "failed", reason: "device" } : { kind: "preview-failed" };
const failureOf = (reason: unknown): ExportResult =>
  reason === "device" ? { kind: "failed", reason: "device" }
  : reason === "updating" ? { kind: "failed", reason: "updating" }
  : reason === "too-big" ? { kind: "refused", reason: "too-big" }
  : { kind: "failed", reason: "other" };

export function createExporter<R extends Drawn>(deps: ExporterDeps<R>): Exporter {
  const { scheduler } = deps;
  let busy = false;
  /** Resolved PNGs by render generation: a later export of the same bitmap reuses them (rejections are never kept). */
  const cache = new Map<number, Blob>();

  function action(kind: ExportKind, e: { readonly detail: number }) {
    if (busy || e.detail > 1) return;
    const problem = deps.previewProblem();
    if (problem) {
      deps.finish(refusalOf(problem), kind, deps.isOpen());
      return;
    }
    busy = true;
    scheduler.hold(true);
    deps.started(kind);
    let pendingOn = false;
    const timer = setTimeout(() => {
      pendingOn = true;
      deps.pending(true);
    }, 400);
    const done = (result: ExportResult) => {
      busy = false;
      clearTimeout(timer);
      if (pendingOn) deps.pending(false);
      scheduler.hold(false);
      deps.finish(result, kind, deps.isOpen());
    };
    const options = deps.options();
    const name = deps.fileName(options);
    let resolvePng!: (b: Blob) => void;
    let rejectPng!: (reason: Reason) => void;
    let png = new Promise<Blob>((resolve, reject) => {
      resolvePng = resolve;
      rejectPng = reject;
    });
    let written: Promise<void> | null = null;
    let gen: number | null = null;
    const encode = (r: R) => deps.toBlob(r, (b) => (b ? resolvePng(b) : rejectPng("device")));
    const shown = scheduler.isReady() ? scheduler.current() : null;
    if (shown?.result) {
      // The ready path: the bitmap the student sees, read, written and encoded in this click.
      const r = shown.result;
      gen = shown.generation;
      const kept = cache.get(gen);
      if (kept) {
        png = Promise.resolve(kept);
        if (kind === "copy") written = deps.write(png);
      } else {
        if (!deps.readbackOk(r)) {
          done({ kind: "failed", reason: "privacy" });
          return;
        }
        // Before toBlob: WebKit encodes inside it, and the write must use this click's activation.
        if (kind === "copy") written = deps.write(png);
        encode(r);
      }
    } else {
      // Not ready: the write still happens in the click (activation); the PNG follows from the render of the options clicked with.
      if (kind === "copy") written = deps.write(png);
      scheduler.renderFor(options).then(
        (p) => {
          gen = p.generation;
          if (!deps.readbackOk(p.result)) rejectPng("updating");
          else encode(p.result);
          p.release(); // after toBlob, which copied the bitmap
        },
        (reason: RenderFailure) => rejectPng(reason),
      );
    }
    png.then(
      (b) => {
        if (gen !== null) cache.set(gen, b);
      },
      () => {},
    );
    let outcome: Promise<ExportResult> =
      kind === "copy"
        ? (written ?? Promise.reject(new Error("no write"))).then(
            (): ExportResult => ({ kind: "copied" }),
            () => png.then((blob): ExportResult => ({ kind: "denied", blob, file: name }), failureOf),
          )
        : png.then((blob): ExportResult => {
            deps.download(name, blob);
            return { kind: "downloaded", file: name };
          }, failureOf);
    outcome = outcome.catch((): ExportResult => ({ kind: "failed", reason: "other" }));
    // Busy until both the outcome and the PNG have settled (a denied write waits for its PNG).
    Promise.allSettled([outcome, png]).then(() => outcome.then(done));
  }

  return {
    copy: (e) => action("copy", e),
    download: (e) => action("download", e),
    busy: () => busy,
  };
}

// ---------------------------------------------------------------- the frame's height (5.2)

export interface BudgetMeasures {
  readonly innerHeight: number;
  /** The window is 900 px wide or more (the app's own breakpoint): side by side unless compact. */
  readonly wide: boolean;
  /** The dialog head's height (the title may wrap). */
  readonly head: number;
  /** The footer's height, its empty status line included. */
  readonly footer: number;
  /** Each note's height under the frame. */
  readonly notes: readonly number[];
  /** From the Colours fieldset's top to the bottom of its first choice. */
  readonly firstRow: number;
}

/** How the dialog lays out: the stage left of the options ("side"), or above them ("stack"). */
export type SnippetLayout = "side" | "stack";

/**
 * The frame's room in the dialog, measured once per opening and on resize. Compact: the dialog
 * itself becomes the one scroller (very short or zoomed windows, at any width). Otherwise (redesign
 * 6, snippet-image.css): side by side from 900 px wide (the stage fills the dialog's height, its
 * size set by CSS), or stacked with the preview at most 45% of the window's height and the first
 * Colours chip in view. From 900 px the dialog is at most 820 px tall and leaves 24 px of the
 * window on each side, inside its 1 px border; below that it is a full-screen sheet with no border.
 */
export function frameBudget(m: BudgetMeasures): { cap: number; compact: boolean; frameCap: number; layout: SnippetLayout } {
  const border = m.wide ? 2 : 0;
  const dialogMax = m.wide ? Math.min(820, m.innerHeight - 48) : m.innerHeight;
  // The stage bar and the notes: each its height and the 8 px gap before it.
  const notes = m.notes.reduce((sum, h) => sum + h + 8, 0);
  // Stacked: the stage column's 12 px top, the stage panel's border and padding (2 + 2 x 12), the
  // bar and notes, then the options down to the first chip's bottom.
  const fixed = border + m.head + m.footer + 12 + 26 + notes + m.firstRow;
  // 18: the frame's padding (2 x 8) and border (2 x 1).
  const cap = dialogMax - fixed - 18;
  // Side by side the options don't sit under the stage: the stage has the body's height less the
  // stage column's padding (2 x 16), the panel's 26 and the bar and notes, and needs 96 px of it.
  const side = dialogMax - border - m.head - m.footer - 32 - 26 - notes - 18;
  const compact = m.wide ? side < 96 : cap < 96;
  const frameCap = compact ? Math.max(96, Math.round(dialogMax / 2) - 18) : Math.min(Math.round(0.45 * m.innerHeight) - 18, cap);
  return { cap, compact, frameCap, layout: m.wide && !compact ? "side" : "stack" };
}

/**
 * The frame's content height once a render has landed: the tallest of the given layouts as fitted
 * to the width, from 96 to the cap. The dialog passes the default look's layouts (medium
 * background, plain frame, either toggle), so the stage is never sized for a rarer, taller look.
 */
export function frameContent(layouts: readonly { readonly width: number; readonly height: number }[], innerWidth: number, frameCap: number): number {
  const tallest = Math.max(0, ...layouts.map((l) => l.height * Math.min(1, innerWidth / l.width)));
  return Math.min(frameCap, Math.max(96, tallest));
}

/**
 * How much the preview shrinks an image (round 3): the whole image inside the stage's inner box,
 * both ways, never enlarged, so a long snippet reads as a tall thumbnail and the stage never
 * scrolls. `actual`: the "Actual size" toggle, 1:1 (the stage then scrolls).
 */
export function previewFit(layout: { readonly width: number; readonly height: number }, innerWidth: number, innerHeight: number, actual = false): number {
  if (actual) return 1;
  return Math.min(1, Math.max(1, innerWidth) / layout.width, Math.max(1, innerHeight) / layout.height);
}

/**
 * Before the first render: a layout's height from the line count (1, 12 and the line boxes; the
 * header adds a line box, 8, 1 and 12; the background's padding adds itself above and below).
 */
export function frameEstimate(rows: number, lineH: number, header: boolean, pad = 0): number {
  return 1 + 12 + (header ? lineH + 8 + 1 + 12 : 0) + rows * lineH + 12 + 1 + 2 * pad;
}
