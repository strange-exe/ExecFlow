// Capture snippet's flow without a DOM (final-v3 sections 4.3, 5.2, 7.3 and 7.5): which colours a
// choice gives, the preview scheduler (one render at a time, the last good preview kept, nothing
// rendered while an export is busy), the exporter (readback, clipboard write and encode inside the
// click), and the dialog's frame budget. The dialog (snippet-dialog.ts) supplies the canvas work and
// the DOM through the deps; the unit tests supply fakes. Lazy (the dialog's chunk).
import type { ColorChoice, PaintInfo } from "../core/snippet";
import { checkColors, sameOptions, type ImageColors, type ImageOptions } from "../core/snippet-dialog";
import { OWN } from "../theme/palettes";

export { sameOptions };

// ---------------------------------------------------------------- colours (4.3)

/** What the dialog read from the document root when it opened: the family, the scheme, the theme's name and the 17 computed values. */
export interface Paint extends PaintInfo {
  readonly computed: Readonly<Record<string, string>>;
}

/** The colours of a choice: what this tab painted, or the own palette's light or dark (Deep Field for palette themes). Null: not all #rrggbb. */
export function imageColors(choice: ColorChoice, paint: Paint): ImageColors | null {
  if (choice === "match") return checkColors(paint.computed);
  return checkColors(OWN[paint.family === "slate" ? "slate" : "deep-field"][choice]);
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
/** Read by the renderer at each 50-row yield: when set, it frees its canvas and stops. */
export interface RenderSignal {
  readonly stopped: boolean;
}
export type RenderOutcome<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly reason: RenderFailure | "stopped" };

export interface SchedulerDeps<R extends Drawn> {
  render(options: ImageOptions, signal: RenderSignal): Promise<RenderOutcome<R>>;
  /** Frees a bitmap that will never be shown again. */
  free(result: R): void;
  /** Shows a finished render, in one step (the scheduler frees the previous one right after). */
  swap(result: R, options: ImageOptions, generation: number): void;
  /** Removes the shown render and says why there is none (the preview never shows what the export would not produce). */
  fail(reason: RenderFailure, options: ImageOptions, generation: number): void;
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

  const isReady = () => !!current?.result && !!newest && sameOptions(current.options, newest);

  function report() {
    if (isReady()) deps.state("ready");
    else if (current?.failure && newest && sameOptions(current.options, newest) && !running) deps.state(current.failure === "too-big" ? "too-big" : "failed");
    else deps.state("rendering");
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
        deps.swap(o.value, run.options, run.generation);
        if (previous?.result) deps.free(previous.result);
      }
      if (!discard) run.waiter?.resolve(pinnedOf(run, o.value));
      else run.waiter?.reject("failed");
    } else {
      const reason = o.reason === "stopped" ? "failed" : o.reason;
      if (o.reason !== "stopped" && !discard && !closed) {
        const previous = current;
        current = { result: null, failure: reason, options: run.options, generation: run.generation };
        deps.fail(reason, run.options, run.generation);
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
    if (running) return;
    if (nextPinned) {
      const { options, waiter } = nextPinned;
      nextPinned = null;
      start(options, waiter);
      return;
    }
    if (closed || held || !newest) return;
    if (current && sameOptions(current.options, newest)) return;
    start(newest, null);
  }

  return {
    request(options) {
      if (closed) return;
      newest = options;
      if (running) {
        if (sameOptions(running.options, options)) running.outdated = false;
        else if (!running.pinned) running.outdated = true;
      }
      kick();
      report();
    },
    renderFor(options) {
      return new Promise<PinnedRender<R>>((resolve, reject) => {
        const waiter: Waiter<R> = { resolve, reject };
        if (running && sameOptions(running.options, options) && !running.cancelled) {
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
  /** The dialog head's height (the title may wrap). */
  readonly head: number;
  /** The footer's height, its empty status line included. */
  readonly footer: number;
  /** Each note's height under the frame. */
  readonly notes: readonly number[];
  /** From the Colours fieldset's top to the bottom of its first choice. */
  readonly firstRow: number;
}

/** The frame's room in the dialog, measured once per opening and on resize. Compact: the dialog itself becomes the one scroller. */
export function frameBudget(m: BudgetMeasures): { cap: number; compact: boolean; frameCap: number } {
  const dialogMax = Math.min(760, m.innerHeight - 32);
  const fixed = 2 + m.head + m.footer + 24 + 16 + m.notes.reduce((sum, h) => sum + h + 8, 0) + m.firstRow;
  // 18: the frame's padding (2 x 8) and border (2 x 1).
  const cap = dialogMax - fixed - 18;
  const compact = cap < 96;
  return { cap, compact, frameCap: compact ? Math.max(96, Math.round(dialogMax / 2) - 18) : Math.min(420, cap) };
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
 * How much the preview shrinks an image: to the frame's inner width, never enlarged, and, where the
 * stage shows the default look whole (`stage`, its content height; null when the stage is capped
 * and scrolls), to the stage's height as well, so a taller look (a larger background, the window
 * frame) shrinks a little instead of scrolling or reserving room for itself.
 */
export function previewFit(layout: { readonly width: number; readonly height: number }, innerWidth: number, stage: number | null): number {
  const byWidth = Math.min(1, Math.max(1, innerWidth) / layout.width);
  // Only a look taller than the stage shrinks by height (it then fills the stage's height exactly,
  // as the default look does); the looks that fit keep their width fit.
  return stage !== null && layout.height * byWidth > stage ? Math.min(byWidth, stage / layout.height) : byWidth;
}

/**
 * Before the first render: a layout's height from the line count (1, 12 and the line boxes; the
 * header adds a line box, 8, 1 and 12; the background's padding adds itself above and below).
 */
export function frameEstimate(rows: number, lineH: number, header: boolean, pad = 0): number {
  return 1 + 12 + (header ? lineH + 8 + 1 + 12 : 0) + rows * lineH + 12 + 1 + 2 * pad;
}
