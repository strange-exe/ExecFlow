import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE_OPTIONS, IMAGE_TOKENS, type ImageColors, type ImageOptions } from "../core/snippet-dialog";
import { OWN } from "../theme/palettes";
import {
  createDrawnScales, createExporter, createPreviewScheduler, drawnScaleOf, frameBudget, frameContent, frameEstimate, imageColors, paintFamily, PENDING_MS, previewFit,
  type Drawn, type ExportResult, type Paint, type PreviewState, type RenderFailure, type RenderOutcome, type RenderSignal,
} from "./snippet-flow";

// final-v3 sections 5.2, 7.3 and 7.5, with fake timers, fake canvases and a fake clipboard.

const COLORS = Object.fromEntries(IMAGE_TOKENS.map((t) => [t, "#112233"])) as ImageColors;
const A: ImageOptions = { ...DEFAULT_IMAGE_OPTIONS, highlight: [] };
const B: ImageOptions = { ...A, colors: "light" };
const C: ImageOptions = { ...A, colors: "dark" };
const D: ImageOptions = { ...A, colors: "light", numbers: false, name: false };
/** The log's short name of a set of options (only colours and the toggles differ between A to D). */
const word = (o: ImageOptions) => `${o.colors} ${o.numbers ? "numbers" : "no-numbers"} ${o.name ? "name" : "no-name"}`;

interface FakeCanvas { id: number; freed: boolean }
interface FakeDrawn extends Drawn { canvas: FakeCanvas }
interface FakeRender {
  options: ImageOptions;
  signal: RenderSignal;
  canvas: FakeCanvas;
  /** The render reaches its end with no yield on the way. */
  done(): void;
  fail(reason: RenderFailure): void;
  /** A yield (snippet-canvas.ts inSlices): stops (freeing its canvas) when the signal says so; true when it carries on. */
  step(): boolean;
}

function harness(drawnScale?: (o: ImageOptions) => number) {
  const renders: FakeRender[] = [];
  const log: string[] = [];
  const states: PreviewState[] = [];
  const pending: string[] = [];
  let n = 0;
  const scheduler = createPreviewScheduler<FakeDrawn>({
    drawnScale,
    render: (options, signal) =>
      new Promise<RenderOutcome<FakeDrawn>>((resolve) => {
        const canvas = { id: ++n, freed: false };
        renders.push({
          options,
          signal,
          canvas,
          done: () => resolve({ ok: true, value: { canvas, colors: COLORS, t: 2 } }),
          fail: (reason) => {
            canvas.freed = true;
            resolve({ ok: false, reason });
          },
          step: () => {
            if (!signal.stopped) return true;
            canvas.freed = true;
            resolve({ ok: false, reason: "stopped" });
            return false;
          },
        });
      }),
    free: (r) => {
      log.push(`free ${r.canvas.id}`);
      r.canvas.freed = true;
    },
    swap: (r, options, _generation, adopted) => log.push(`${adopted ? "adopt" : "swap"} ${r.canvas.id} ${word(options)}`),
    fail: (reason, options, _generation, adopted) => log.push(`${adopted ? "adopt-fail" : "fail"} ${reason} ${word(options)}`),
    state: (s) => states.push(s),
    pending: (on, first) => pending.push(`${on} ${first ? "first" : "update"}`),
  });
  return { scheduler, renders, log, states, pending };
}

/** Lets settled promises run their callbacks (the scheduler finishes a render in a microtask). */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the preview scheduler (7.3)", () => {
  it("renders the first request at once and marks the frame", async () => {
    const h = harness();
    h.scheduler.request(A);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0].options).toEqual(A);
    expect(h.states.at(-1)).toBe("rendering");
    expect(h.scheduler.isReady()).toBe(false);
    h.renders[0].done();
    await flush();
    expect(h.log).toEqual(["swap 1 match numbers name"]);
    expect(h.states.at(-1)).toBe("ready");
    expect(h.scheduler.isReady()).toBe(true);
    expect(h.scheduler.current()?.result?.canvas.id).toBe(1);
  });

  it("three requests during a render give exactly one more render, with the last options", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.scheduler.request(B);
    h.scheduler.request(C);
    h.scheduler.request(D);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0].step()).toBe(false);
    await flush();
    expect(h.renders).toHaveLength(2);
    expect(h.renders[1].options).toEqual(D);
    h.renders[1].done();
    await flush();
    expect(h.renders).toHaveLength(2);
    expect(h.log).toEqual(["swap 2 light no-numbers no-name"]);
  });

  it("an outdated render stops at its next yield and its canvas is freed", async () => {
    const h = harness();
    h.scheduler.request(A);
    expect(h.renders[0].step()).toBe(true);
    h.scheduler.request(B);
    expect(h.renders[0].signal.stopped).toBe(true);
    expect(h.renders[0].step()).toBe(false);
    expect(h.renders[0].canvas.freed).toBe(true);
    await flush();
    expect(h.renders.map((r) => word(r.options))).toEqual(["match numbers name", "light numbers name"]);
  });

  it("an outdated render of 50 rows or fewer that completes is freed and never swapped", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.scheduler.request(B);
    h.renders[0].done();
    await flush();
    expect(h.renders[0].canvas.freed).toBe(true);
    expect(h.log).toEqual(["free 1"]);
    h.renders[1].done();
    await flush();
    expect(h.log).toEqual(["free 1", "swap 2 light numbers name"]);
    expect(h.log.join()).not.toContain("swap 1");
  });

  it("asking for the shown options again is ready at once; asking for the running ones keeps that render", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.renders[0].done();
    await flush();
    h.scheduler.request(B);
    expect(h.states.at(-1)).toBe("rendering");
    h.scheduler.request(A);
    expect(h.states.at(-1)).toBe("ready");
    expect(h.scheduler.isReady()).toBe(true);
    expect(h.renders[1].signal.stopped).toBe(true);
    // Back to the running render's options before its next yield: it carries on.
    h.scheduler.request(C);
    expect(h.renders).toHaveLength(2);
    h.scheduler.request(B);
    expect(h.renders[1].signal.stopped).toBe(false);
    h.renders[1].done();
    await flush();
    expect(h.renders).toHaveLength(2);
    expect(h.log).toEqual(["swap 1 match numbers name", "swap 2 light numbers name", "free 1"]);
  });

  it("a pinned render is never stopped by newer options, and it reaches its waiter", async () => {
    const h = harness();
    h.scheduler.request(A);
    const waiter = h.scheduler.renderFor(A);
    h.scheduler.request(B);
    expect(h.renders[0].signal.stopped).toBe(false);
    expect(h.renders[0].step()).toBe(true);
    h.renders[0].done();
    const pinned = await waiter;
    expect(pinned.result.canvas.id).toBe(1);
    await flush();
    expect(h.log[0]).toBe("swap 1 match numbers name");
    // Then the newest options render.
    expect(h.renders.map((r) => word(r.options))).toEqual(["match numbers name", "light numbers name"]);
  });

  it("while held, a request starts nothing and hold(false) starts the newest", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.renders[0].done();
    await flush();
    h.scheduler.hold(true);
    h.scheduler.request(B);
    h.scheduler.request(C);
    expect(h.renders).toHaveLength(1);
    expect(h.states.at(-1)).toBe("rendering");
    h.scheduler.hold(false);
    expect(h.renders).toHaveLength(2);
    expect(h.renders[1].options).toEqual(C);
  });

  it("renderFor while held still starts, pinned", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.renders[0].done();
    await flush();
    h.scheduler.hold(true);
    h.scheduler.request(B);
    expect(h.renders).toHaveLength(1);
    const waiter = h.scheduler.renderFor(B);
    expect(h.renders).toHaveLength(2);
    h.scheduler.request(C);
    expect(h.renders[1].signal.stopped).toBe(false);
    h.renders[1].done();
    expect((await waiter).result.canvas.id).toBe(2);
  });

  it("renderFor while another render runs waits for it to stop, then starts pinned", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.scheduler.request(B);
    const waiter = h.scheduler.renderFor(B);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0].step()).toBe(false);
    await flush();
    expect(h.renders).toHaveLength(2);
    expect(h.renders[1].options).toEqual(B);
    h.renders[1].done();
    expect((await waiter).result.canvas.id).toBe(2);
  });

  it("a pinned render that fails rejects its waiter with the render's reason", async () => {
    const h = harness();
    h.scheduler.request(A);
    const waiter = h.scheduler.renderFor(A);
    h.renders[0].fail("too-big");
    await expect(waiter).rejects.toBe("too-big");
    expect(h.log).toEqual(["fail too-big match numbers name"]);
    expect(h.states.at(-1)).toBe("too-big");
  });

  it("cancel() stops and frees an unpinned render", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.scheduler.cancel();
    expect(h.renders[0].signal.stopped).toBe(true);
    expect(h.renders[0].step()).toBe(false);
    expect(h.renders[0].canvas.freed).toBe(true);
    await flush();
    expect(h.renders).toHaveLength(1);
  });

  it("a render finishing after cancel never swaps, and the shown canvas is freed at cancel", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.renders[0].done();
    await flush();
    h.scheduler.request(B);
    h.scheduler.cancel();
    expect(h.renders[0].canvas.freed).toBe(true);
    h.renders[1].done();
    await flush();
    expect(h.renders[1].canvas.freed).toBe(true);
    expect(h.log).toEqual(["swap 1 match numbers name", "free 1", "free 2"]);
    h.scheduler.request(C);
    expect(h.renders).toHaveLength(2);
  });

  it("cancel() lets a pinned render reach its waiter; release() frees it because it was never swapped in", async () => {
    const h = harness();
    h.scheduler.request(A);
    const waiter = h.scheduler.renderFor(A);
    h.scheduler.cancel();
    expect(h.renders[0].signal.stopped).toBe(false);
    expect(h.renders[0].step()).toBe(true);
    h.renders[0].done();
    const pinned = await waiter;
    expect(h.log).toEqual([]);
    pinned.release();
    expect(h.log).toEqual(["free 1"]);
    pinned.release();
    expect(h.log).toEqual(["free 1"]);
  });

  it("the pending text: false at 399 ms, true at 400 ms, cleared when the render becomes current", async () => {
    const h = harness();
    expect(PENDING_MS).toBe(400);
    h.scheduler.request(A);
    await vi.advanceTimersByTimeAsync(399);
    expect(h.pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pending).toEqual(["true first"]);
    h.renders[0].done();
    await flush();
    expect(h.pending).toEqual(["true first", "false first"]);
    // A re-render says "Updating" (not the first), and a quick one never shows the text.
    h.scheduler.request(B);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.pending.at(-1)).toBe("true update");
    h.renders[1].done();
    await flush();
    expect(h.pending.at(-1)).toBe("false update");
    h.scheduler.request(C);
    await vi.advanceTimersByTimeAsync(100);
    h.renders[2].done();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.pending).toHaveLength(4);
  });

  it("a failed render replaces the shown one (the preview never shows what the export would not produce)", async () => {
    const h = harness();
    h.scheduler.request(A);
    h.renders[0].done();
    await flush();
    h.scheduler.request(D);
    h.renders[1].fail("failed");
    await flush();
    expect(h.log).toEqual(["swap 1 match numbers name", "fail failed light no-numbers no-name", "free 1"]);
    expect(h.states.at(-1)).toBe("failed");
    expect(h.scheduler.isReady()).toBe(false);
    expect(h.scheduler.current()).toMatchObject({ result: null, failure: "failed" });
  });

  it("a render that throws counts as failed", async () => {
    const states: PreviewState[] = [];
    const s = createPreviewScheduler<FakeDrawn>({
      render: () => Promise.reject(new Error("boom")),
      free: () => {},
      swap: () => {},
      fail: () => {},
      state: (x) => states.push(x),
      pending: () => {},
    });
    s.request(A);
    await flush();
    expect(states.at(-1)).toBe("failed");
  });
});

// A large image's 3x does not fit and steps down to 2x: 3x and 2x then make the same bitmap, which
// was rendered again (110 to 160 ms in WebKit, audit 2026-10-28). The dialog gives the scale each
// request is drawn at; here 3 steps down to 2.
describe("the preview scheduler: requests that make the same bitmap", () => {
  const S3: ImageOptions = { ...A, scale: 3 };
  const S2: ImageOptions = { ...A, scale: 2 };
  const S1: ImageOptions = { ...A, scale: 1 };
  const key = (o: ImageOptions) => Math.min(o.scale, 2);

  it("other colours at a Scale that steps down the same way are still another image (only the scale may differ)", async () => {
    const h = harness(key);
    h.scheduler.request(S3);
    h.renders[0].done();
    await flush();
    h.scheduler.request({ ...B, scale: 2 });
    expect(h.renders).toHaveLength(2);
  });

  it("a Scale that steps down to the shown bitmap renders nothing; the frame takes the new options", async () => {
    const h = harness(key);
    h.scheduler.request(S3);
    h.renders[0].done();
    await flush();
    h.scheduler.request(S2);
    expect(h.renders).toHaveLength(1);
    expect(h.scheduler.isReady()).toBe(true);
    expect(h.states.at(-1)).toBe("ready");
    expect(h.scheduler.current()).toMatchObject({ options: S2, generation: 1 });
    // Adopted, not drawn: the dialog's data-renders counts renders shown, so it leaves this one out.
    expect(h.log).toEqual(["swap 1 match numbers name", "adopt 1 match numbers name"]);
    // A scale that makes another bitmap still renders.
    h.scheduler.request(S1);
    expect(h.renders).toHaveLength(2);
    expect(h.scheduler.isReady()).toBe(false);
  });

  it("asked while that render runs, it keeps the render going and takes its result", async () => {
    const h = harness(key);
    h.scheduler.request(S3);
    h.scheduler.request(S2);
    expect(h.renders[0].signal.stopped).toBe(false);
    h.renders[0].done();
    await flush();
    expect(h.renders).toHaveLength(1);
    expect(h.scheduler.isReady()).toBe(true);
    expect(h.scheduler.current()?.options).toEqual(S2);
    expect(h.log).toEqual(["swap 1 match numbers name", "adopt 1 match numbers name"]);
  });

  it("an export of the stepped-down scale pins the running render instead of starting one", async () => {
    const h = harness(key);
    h.scheduler.request(S3);
    const waiter = h.scheduler.renderFor(S2);
    expect(h.renders).toHaveLength(1);
    h.renders[0].done();
    expect((await waiter).result.canvas.id).toBe(1);
    await flush();
    expect(h.renders).toHaveLength(1);
  });

  it("a too-big result counts for every scale that steps down the same way: no render, the failure said again", async () => {
    const h = harness(key);
    h.scheduler.request(S3);
    h.renders[0].fail("too-big");
    await flush();
    h.scheduler.request(S2);
    expect(h.renders).toHaveLength(1);
    expect(h.states.at(-1)).toBe("too-big");
    expect(h.log).toEqual(["fail too-big match numbers name", "adopt-fail too-big match numbers name"]);
  });
});

describe("the drawn scale: the dialog's key for requests that make the same bitmap", () => {
  const rows = [{ number: 1 }, { number: 2 }];
  const narrow = { ch: 9, lineH: 22.5, widest: 144 };
  /** 6,000 px of code: wider than MAX_SIDE at 3, so Scale 3 steps down to 2. */
  const wide = { ch: 9, lineH: 22.5, widest: 6000 };
  /** Wider than MAX_SIDE even at scale 1. */
  const huge = { ch: 9, lineH: 22.5, widest: 20_000 };
  const S3: ImageOptions = { ...A, scale: 3 };

  it("is the Scale chosen while no render gave the measures", () => {
    expect(drawnScaleOf(rows, null, S3)).toBe(3);
    const scales = createDrawnScales();
    expect(scales.scale(S3)).toBe(3);
    expect(scales.scale({ ...A, scale: 1 })).toBe(1);
  });

  it("is the step a too-big Scale takes, and 0 when the image is too big at every scale", () => {
    expect(drawnScaleOf(rows, narrow, S3)).toBe(3);
    expect(drawnScaleOf(rows, wide, S3)).toBe(2);
    expect(drawnScaleOf(rows, wide, { ...A, scale: 2 })).toBe(2);
    expect(drawnScaleOf(rows, huge, S3)).toBe(0);
    expect(drawnScaleOf(rows, huge, { ...A, scale: 1 })).toBe(0);
  });

  it("new measures (a font that loaded after a fallback render) clear what was worked out from the old ones", () => {
    const scales = createDrawnScales();
    expect(scales.measure(rows, narrow)).toBe(true);
    expect(scales.scale(S3)).toBe(3);
    // The same measures again (a later render of the same font): nothing changes.
    expect(scales.measure(rows, { ...narrow })).toBe(false);
    expect(scales.scale(S3)).toBe(3);
    // The real font measures wider: the same options object is worked out again, not read from the cache.
    expect(scales.measure(rows, wide)).toBe(true);
    expect(scales.scale(S3)).toBe(2);
    expect(scales.measure(rows, huge)).toBe(true);
    expect(scales.scale(S3)).toBe(0);
  });

  it("other rows count as new measures too", () => {
    const scales = createDrawnScales();
    scales.measure(rows, narrow);
    expect(scales.measure([...rows], narrow)).toBe(true);
  });
});

describe("the exporter (7.5)", () => {
  function setup(opts: { ready?: boolean } = {}) {
    const h = harness();
    const calls: string[] = [];
    const results: { result: ExportResult; kind: string; open: boolean }[] = [];
    let options: ImageOptions = A;
    let readOk = true;
    let open = true;
    let writeResult: "resolve" | "reject" = "resolve";
    const blobs: ((b: Blob | null) => void)[] = [];
    const exporter = createExporter<FakeDrawn>({
      scheduler: h.scheduler,
      // A freed canvas would show here: the bitmap must still be there when it is read and encoded.
      readbackOk: (r) => {
        calls.push(`getImageData ${r.canvas.id}${r.canvas.freed ? " (freed)" : ""}`);
        return readOk;
      },
      toBlob: (r, done) => {
        calls.push(`toBlob ${r.canvas.id}${r.canvas.freed ? " (freed)" : ""}`);
        blobs.push(done);
      },
      write: (png) => {
        calls.push("write");
        return writeResult === "reject" ? Promise.reject(new Error("NotAllowedError")) : png.then(() => undefined);
      },
      download: (name) => calls.push(`download ${name}`),
      options: () => options,
      fileName: (o) => (o.name ? "main-py-lines-2-3.png" : "code-lines-2-3.png"),
      previewProblem: () => null,
      started: () => calls.push("started"),
      pending: (on) => calls.push(`pending ${on}`),
      finish: (result, kind, isOpen) => results.push({ result, kind, open: isOpen }),
      isOpen: () => open,
    });
    const ready = async () => {
      h.scheduler.request(options);
      h.renders.at(-1)!.done();
      await flush();
    };
    return {
      ...h, exporter, calls, results, blobs, ready, opts,
      setOptions: (o: ImageOptions) => (options = o),
      setReadback: (ok: boolean) => (readOk = ok),
      setOpen: (o: boolean) => (open = o),
      setWrite: (w: "resolve" | "reject") => (writeResult = w),
    };
  }
  const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

  it("ready path, Copy: readback, write and toBlob in that order, inside the one synchronous call", async () => {
    const s = setup();
    await s.ready();
    s.exporter.copy({ detail: 1 });
    expect(s.calls).toEqual(["started", "getImageData 1", "write", "toBlob 1"]);
    expect(s.exporter.busy()).toBe(true);
    s.blobs[0](PNG);
    await flush();
    expect(s.results).toEqual([{ result: { kind: "copied" }, kind: "copy", open: true }]);
    expect(s.exporter.busy()).toBe(false);
  });

  it("ready path, Download: readback then toBlob, synchronously; the name from the options at click time", async () => {
    const s = setup();
    await s.ready();
    s.exporter.download({ detail: 1 });
    expect(s.calls).toEqual(["started", "getImageData 1", "toBlob 1"]);
    s.blobs[0](PNG);
    await flush();
    expect(s.calls.at(-1)).toBe("download main-py-lines-2-3.png");
    expect(s.results[0].result).toEqual({ kind: "downloaded", file: "main-py-lines-2-3.png" });
  });

  it("a failed readback writes nothing and encodes nothing: failed (privacy)", async () => {
    const s = setup();
    await s.ready();
    s.setReadback(false);
    s.exporter.copy({ detail: 1 });
    expect(s.calls).toEqual(["started", "getImageData 1"]);
    expect(s.results).toEqual([{ result: { kind: "failed", reason: "privacy" }, kind: "copy", open: true }]);
    expect(s.exporter.busy()).toBe(false);
  });

  it("write rejects first and the PNG resolves later: denied with that blob, and Download reuses it", async () => {
    const s = setup();
    await s.ready();
    s.setWrite("reject");
    s.exporter.copy({ detail: 1 });
    await flush();
    expect(s.results).toEqual([]);
    expect(s.exporter.busy()).toBe(true);
    s.blobs[0](PNG);
    await flush();
    expect(s.results[0].result).toEqual({ kind: "denied", blob: PNG, file: "main-py-lines-2-3.png" });
    s.exporter.download({ detail: 1 });
    await flush();
    expect(s.calls.filter((c) => c.startsWith("toBlob"))).toEqual(["toBlob 1"]);
    expect(s.calls.at(-1)).toBe("download main-py-lines-2-3.png");
    expect(s.results[1].result).toEqual({ kind: "downloaded", file: "main-py-lines-2-3.png" });
  });

  it("write rejects first and the PNG fails later: failed with the app's reason; a failed PNG is not reused", async () => {
    const s = setup();
    await s.ready();
    s.setWrite("reject");
    s.exporter.copy({ detail: 1 });
    s.blobs[0](null);
    await flush();
    expect(s.results[0].result).toEqual({ kind: "failed", reason: "device" });
    s.setWrite("resolve");
    s.exporter.copy({ detail: 1 });
    expect(s.calls.filter((c) => c.startsWith("toBlob"))).toEqual(["toBlob 1", "toBlob 1"]);
  });

  it("busy until both settle: clicks while busy and second clicks of a double click do nothing; the scheduler is held", async () => {
    const s = setup();
    await s.ready();
    s.exporter.download({ detail: 2 });
    expect(s.calls).toEqual([]);
    s.exporter.copy({ detail: 1 });
    const before = s.calls.length;
    s.exporter.copy({ detail: 1 });
    s.exporter.download({ detail: 1 });
    expect(s.calls).toHaveLength(before);
    s.scheduler.request(B);
    expect(s.renders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(s.calls.at(-1)).toBe("pending true");
    s.blobs[0](PNG);
    await flush();
    expect(s.exporter.busy()).toBe(false);
    expect(s.calls).toContain("pending false");
    // Released: the newest options render now.
    expect(s.renders).toHaveLength(2);
    expect(s.renders[1].options).toEqual(B);
  });

  it("not ready: write is still called in the click; the PNG is of the options at click time", async () => {
    const s = setup();
    s.scheduler.request(A);
    s.exporter.copy({ detail: 1 });
    expect(s.calls).toEqual(["started", "write"]);
    // An option changes after the click: the export keeps the options it was clicked with.
    s.setOptions(B);
    s.scheduler.request(B);
    expect(s.renders).toHaveLength(1);
    expect(s.renders[0].signal.stopped).toBe(false);
    s.renders[0].done();
    await flush();
    expect(s.calls).toEqual(["started", "write", "getImageData 1", "toBlob 1"]);
    s.blobs[0](PNG);
    await flush();
    expect(s.results[0].result).toEqual({ kind: "copied" });
    expect(s.renders[0].options).toEqual(A);
  });

  it("not ready: a failed readback gives failed (updating)", async () => {
    const s = setup();
    s.scheduler.request(A);
    s.setReadback(false);
    s.exporter.download({ detail: 1 });
    s.renders[0].done();
    await flush();
    expect(s.calls).toEqual(["started", "getImageData 1"]);
    expect(s.results[0].result).toEqual({ kind: "failed", reason: "updating" });
  });

  it("not ready, closed during the render: the waiter still resolves, release() follows toBlob, the outcome goes to the notice", async () => {
    const s = setup();
    s.scheduler.request(A);
    s.exporter.copy({ detail: 1 });
    s.scheduler.cancel();
    s.setOpen(false);
    s.renders[0].done();
    await flush();
    expect(s.calls).toEqual(["started", "write", "getImageData 1", "toBlob 1"]);
    expect(s.log).toEqual(["free 1"]);
    s.blobs[0](PNG);
    await flush();
    expect(s.results).toEqual([{ result: { kind: "copied" }, kind: "copy", open: false }]);
  });

  it("a preview that is too big or failed is refused at the click, with nothing exported", async () => {
    const h = harness();
    const results: ExportResult[] = [];
    let problem: RenderFailure | null = "too-big";
    const write = vi.fn();
    const exporter = createExporter<FakeDrawn>({
      scheduler: h.scheduler, readbackOk: () => true, toBlob: () => {}, write, download: () => {}, options: () => A, fileName: () => "x.png",
      previewProblem: () => problem, started: () => {}, pending: () => {}, finish: (r) => results.push(r), isOpen: () => true,
    });
    exporter.copy({ detail: 1 });
    problem = "failed";
    exporter.download({ detail: 1 });
    problem = "device";
    exporter.copy({ detail: 1 });
    expect(results).toEqual([{ kind: "refused", reason: "too-big" }, { kind: "preview-failed" }, { kind: "failed", reason: "device" }]);
    expect(write).not.toHaveBeenCalled();
    expect(exporter.busy()).toBe(false);
  });
});

describe("imageColors (4.3)", () => {
  const computed = Object.fromEntries(IMAGE_TOKENS.map((t) => [t, "#010203"]));
  const paint = (family: Paint["family"]): Paint => ({ family, scheme: "dark", themeName: null, computed });
  const pick = (p: Record<string, string>) => Object.fromEntries(IMAGE_TOKENS.map((t) => [t, p[t]]));
  it("Signal, the default: light and dark give Signal's own palettes", () => {
    expect(imageColors("match", paint("signal"))).toEqual(computed);
    expect(imageColors("light", paint("signal"))).toEqual(pick(OWN.signal.light));
    expect(imageColors("dark", paint("signal"))).toEqual(pick(OWN.signal.dark));
  });
  it("the family is read from data-palette: none is Deep Field, signal and slate their own, anything else a palette theme", () => {
    expect(paintFamily(undefined)).toBe("deep-field");
    expect(paintFamily("signal")).toBe("signal");
    expect(paintFamily("slate")).toBe("slate");
    expect(paintFamily("palette")).toBe("palette");
    expect(paintFamily("evil")).toBe("palette");
  });
  it("match gives the computed values; light and dark the own palette, the default's (Signal) for palette themes", () => {
    expect(imageColors("match", paint("deep-field"))).toEqual(computed);
    expect(imageColors("light", paint("deep-field"))).toEqual(pick(OWN["deep-field"].light));
    expect(imageColors("dark", paint("deep-field"))).toEqual(pick(OWN["deep-field"].dark));
    expect(imageColors("light", paint("slate"))).toEqual(pick(OWN.slate.light));
    expect(imageColors("dark", paint("slate"))).toEqual(pick(OWN.slate.dark));
    expect(imageColors("light", paint("palette"))).toEqual(pick(OWN.signal.light));
    expect(imageColors("dark", paint("palette"))).toEqual(pick(OWN.signal.dark));
  });
  it("a computed value that isn't #rrggbb fails the choice, never a guess", () => {
    expect(imageColors("match", { ...paint("palette"), computed: { ...computed, "syn-keyword": "var(--x)" } })).toBeNull();
    expect(imageColors("light", { ...paint("palette"), computed: { ...computed, bg: "" } })).not.toBeNull();
  });
});

describe("the frame budget (5.2)", () => {
  // The table's measures (head, footer, first row: from the Colours section's top to its first
  // swatch chip's bottom) and its viewports; cap and frame cap from the formula. Redesign 6
  // (.claude/design/redesign6/snippet/design.md): side by side from 900 px wide unless compact, in a
  // dialog of at most 820 px that leaves 48 px of the window; below 900 px a full-screen sheet (no
  // border). Stacked, the preview takes at most 45% of the window's height (its frame's 18 px of
  // padding and border included), under the stage column's 12 px top and inside the stage panel's
  // 1 px border and 12 px padding.
  it.each([
    ["1440 x 900", 900, true, 57, 64, 138, 503, false, 387, "side"],
    ["1280 x 800 coarse", 800, true, 64, 69, 146, 415, false, 342, "side"],
    ["1093 x 504", 504, true, 57, 64, 138, 139, false, 139, "side"],
    // Wide and short: stacked it would be compact (the options would sit under the stage), side by side the stage has 153 px.
    ["1093 x 400", 400, true, 57, 64, 138, 35, false, 35, "side"],
    ["1093 x 300", 300, true, 57, 64, 138, -65, true, 108, "stack"],
    ["600 x 900", 900, false, 64, 132, 138, 510, false, 387, "stack"],
    ["390 x 844", 844, false, 64, 132, 138, 454, false, 362, "stack"],
    ["320 x 640", 640, false, 90, 132, 154, 208, false, 208, "stack"],
    ["683 x 330", 330, false, 64, 132, 138, -60, true, 147, "stack"],
    ["844 x 390 coarse", 390, false, 64, 132, 146, -8, true, 177, "stack"],
    ["455 x 213", 213, false, 64, 132, 138, -177, true, 96, "stack"],
    ["320 x 256", 256, false, 90, 132, 154, -176, true, 110, "stack"],
  ] as [string, number, boolean, number, number, number, number, boolean, number, string][])("%s", (_, innerHeight, wide, head, footer, firstRow, cap, compact, frameCap, layout) => {
    const b = frameBudget({ innerHeight, wide, head, footer, notes: [], firstRow });
    expect(b.cap).toBeCloseTo(cap, 9);
    expect(b.compact).toBe(compact);
    expect(b.frameCap).toBeCloseTo(frameCap, 9);
    expect(b.layout).toBe(layout);
  });

  it("each note (the stage bar too) takes its height plus 8, stacked and side by side", () => {
    const plain = frameBudget({ innerHeight: 900, wide: false, head: 64, footer: 132, notes: [], firstRow: 138 });
    const noted = frameBudget({ innerHeight: 900, wide: false, head: 64, footer: 132, notes: [18, 36], firstRow: 138 });
    expect(plain.cap - noted.cap).toBeCloseTo(18 + 8 + 36 + 8, 9);
    // Side by side the stage's room shrinks by the same: 1093 x 400 has 153 px for the frame's content
    // without notes, so a 28 px bar and a 16 px note (60 with their gaps) leave 93: compact.
    expect(frameBudget({ innerHeight: 400, wide: true, head: 57, footer: 64, notes: [], firstRow: 138 }).layout).toBe("side");
    const tight = frameBudget({ innerHeight: 400, wide: true, head: 57, footer: 64, notes: [28, 16], firstRow: 138 });
    expect(tight.compact).toBe(true);
    expect(tight.layout).toBe("stack");
  });

  it("the sheet below 900 px is the whole window with no border; a wide dialog keeps 48 px of it and a 2 px border", () => {
    const m = { innerHeight: 700, head: 64, footer: 132, notes: [], firstRow: 138 };
    const sheet = frameBudget({ ...m, wide: false });
    // Wide, too short for side by side: stacked in a dialog of 700 - 48 px with its 2 px border.
    const boxed = frameBudget({ ...m, wide: true, footer: 450 });
    expect(sheet.cap).toBeCloseTo(700 - (64 + 132 + 12 + 26 + 138) - 18, 9);
    expect(boxed.compact).toBe(true);
    expect(boxed.cap).toBeCloseTo(652 - (2 + 64 + 450 + 12 + 26 + 138) - 18, 9);
    // The wide dialog never grows past 820 px.
    expect(frameBudget({ ...m, innerHeight: 2000, wide: true }).cap).toBeCloseTo(820 - (2 + 64 + 132 + 12 + 26 + 138) - 18, 9);
  });
});

describe("the frame's content height (5.2)", () => {
  const fixture = [
    { width: 347, height: 114.5 }, { width: 347, height: 71 }, { width: 322, height: 114.5 }, { width: 322, height: 71 },
  ];
  const caseB = [
    { width: 977, height: 4569.5 }, { width: 977, height: 4526 }, { width: 934, height: 4569.5 }, { width: 934, height: 4526 },
  ];
  const caseF = [
    { width: 977, height: 6819.5 }, { width: 977, height: 6776 }, { width: 934, height: 6819.5 }, { width: 934, height: 6776 },
  ];
  it("the fixture's four layouts at inner widths 600 and 216", () => {
    expect(frameContent(fixture, 600, 420)).toBe(114.5);
    // At 216 the tallest fitted layout is numbers off with the header (114.5 x 216 / 322 = 76.8): the floor holds.
    expect(frameContent(fixture, 216, 418)).toBe(96);
    expect(frameContent(fixture, 300, 418)).toBeCloseTo((114.5 * 300) / 322, 9);
  });
  it("cases B and F: the tallest fitted layout, capped", () => {
    expect(frameContent(caseB, 600, 420)).toBe(420);
    expect(frameContent(caseB, 600, 5000)).toBeCloseTo((4569.5 * 600) / 934, 9);
    expect(frameContent(caseF, 216, 5000)).toBeCloseTo((6819.5 * 216) / 934, 9);
    expect(frameContent(caseF, 216, 214)).toBe(214);
  });
  it("never below 96, never above the frame cap, and never enlarged", () => {
    expect(frameContent([{ width: 100, height: 20 }], 600, 420)).toBe(96);
    expect(frameContent([{ width: 100, height: 300 }], 600, 420)).toBe(300);
    expect(frameContent([{ width: 100, height: 3000 }], 600, 131)).toBe(131);
  });
  it("the preview's fit: the whole image in the stage both ways, never enlarged; Actual size is 1:1", () => {
    // The fixture's default look at 1x is 411 x 178.5 (medium background); large and window is 475 x 238.5.
    expect(previewFit({ width: 411, height: 178.5 }, 600, 178.5)).toBe(1);
    expect(previewFit({ width: 475, height: 238.5 }, 600, 178.5)).toBeCloseTo(178.5 / 238.5, 12);
    expect(238.5 * previewFit({ width: 475, height: 238.5 }, 600, 178.5)).toBeCloseTo(178.5, 9);
    // Narrow: the width fit already brings it under the stage, so nothing more.
    expect(previewFit({ width: 475, height: 238.5 }, 300, 178.5)).toBeCloseTo(300 / 475, 12);
    // Round 3: a long selection is never scrolled in Fit; it shrinks to the stage's height too (a tall thumbnail).
    expect(previewFit({ width: 934, height: 4569.5 }, 600, 420)).toBeCloseTo(420 / 4569.5, 12);
    expect(4569.5 * previewFit({ width: 934, height: 4569.5 }, 600, 420)).toBeCloseTo(420, 9);
    // A shorter look keeps its width fit (centred on the stage, never enlarged).
    expect(previewFit({ width: 347, height: 114.5 }, 600, 178.5)).toBe(1);
    // A stage with no room yet (before layout) never gives a zero or negative scale.
    expect(previewFit({ width: 347, height: 114.5 }, 0, 0)).toBeGreaterThan(0);
    // Actual size: 1:1 whatever the stage.
    expect(previewFit({ width: 934, height: 4569.5 }, 600, 420, true)).toBe(1);
    expect(previewFit({ width: 100, height: 50 }, 600, 420, true)).toBe(1);
  });
  it("the estimate before the first render: the default layout's height from the line count", () => {
    expect(frameEstimate(2, 22.5, true)).toBe(114.5);
    expect(frameEstimate(2, 22.5, false)).toBe(71);
    expect(frameEstimate(300, 22.5, true)).toBe(6819.5);
  });
});
