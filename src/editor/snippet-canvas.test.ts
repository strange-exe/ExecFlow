// The measured widths the image's size is built from go on the font grid first (CI, 2026-10-23:
// Linux WebKit's image was 1 px wider, its card a hair over the 411 px every other engine measured).
import { describe, expect, it } from "vitest";
import { inSlices, measuredOnce, onGrid, SLICE_MS, type Measured, type Prepared } from "./snippet-canvas";
import { chooseScale, layoutImage } from "./snippet-render";

// The text pass yields on time, not on a row count: each hop cost about 30 ms in Windows WebKit, and
// a 200-row render made five of them (audit 2026-10-28). A fake clock: each row costs `cost` ms.
describe("inSlices", () => {
  function run(count: number, cost: number, stopAt = Infinity) {
    let t = 0;
    let yields = 0;
    const done: number[] = [];
    /** The time spent drawing between consecutive yields. */
    const slices: number[] = [0];
    const signal = { stopped: false };
    const finished = inSlices(
      count,
      (i) => {
        done.push(i);
        t += cost;
        slices[slices.length - 1] += cost;
      },
      signal,
      async () => {
        yields++;
        slices.push(0);
        if (yields >= stopAt) signal.stopped = true;
      },
      () => t,
    );
    return finished.then((ok) => ({ ok, yields, done, slices }));
  }

  it("a 200-row render of about 10 ms yields once, not every 50 rows", async () => {
    const r = await run(200, 0.05);
    expect(r).toMatchObject({ ok: true, yields: 1 });
    expect(r.done).toHaveLength(200);
  });

  it("cheap rows never yield, however many there are", async () => {
    const r = await run(1000, 0.001);
    expect(r).toMatchObject({ ok: true, yields: 0 });
  });

  it("slow rows still yield: no slice runs longer than the budget and one row", async () => {
    const r = await run(40, 3);
    expect(r.ok).toBe(true);
    expect(r.yields).toBeGreaterThan(5);
    for (const s of r.slices) expect(s).toBeLessThanOrEqual(SLICE_MS + 3);
  });

  it("stops at the yield where the signal is set: nothing more is drawn", async () => {
    const r = await run(40, 3, 2);
    expect(r.ok).toBe(false);
    expect(r.yields).toBe(2);
    expect(r.done).toEqual(Array.from({ length: r.done.length }, (_, i) => i));
    expect(r.done.length).toBeLessThan(40);
  });
});

// Every preview render walked every row to measure it, though rows and font are fixed per opening.
describe("measuredOnce", () => {
  const FONT = { family: "JetBrains Mono", size: 15 };
  const M: Measured = { ch: 9, spaceW: 9, lineH: 22.5, codeV: { ascent: 12, descent: 3 }, widest: 900 };
  const prepared = (): Prepared => ({ rows: [], partial: false, sample: "", tabSize: 4 });

  it("measures once per opening when the code fonts loaded", () => {
    const p = prepared();
    let n = 0;
    const measure = () => (n++, M);
    expect(measuredOnce(p, FONT, true, measure)).toBe(M);
    expect(measuredOnce(p, FONT, true, measure)).toBe(M);
    expect(n).toBe(1);
    // Another opening (its own rows) measures again.
    measuredOnce(prepared(), FONT, true, measure);
    expect(n).toBe(2);
  });

  it("keeps nothing measured with a fallback face (a font that failed to load), nor a failed measure", () => {
    const p = prepared();
    let n = 0;
    measuredOnce(p, FONT, false, () => (n++, M));
    measuredOnce(p, FONT, true, () => (n++, null));
    measuredOnce(p, FONT, true, () => (n++, M));
    measuredOnce(p, FONT, true, () => (n++, M));
    expect(n).toBe(3);
  });

  it("measures again for another code font", () => {
    const p = prepared();
    let n = 0;
    measuredOnce(p, FONT, true, () => (n++, M));
    measuredOnce(p, { ...FONT, size: 16 }, true, () => (n++, M));
    expect(n).toBe(2);
  });
});

describe("onGrid", () => {
  it("keeps a width that is on the 1/64 px grid", () => {
    for (const w of [9, 9.015625, 7.796875, 0, 124.5]) expect(onGrid(w)).toBe(w);
  });

  it("takes a hair off or on to the nearest grid step", () => {
    expect(onGrid(9.0015)).toBe(9);
    expect(onGrid(8.9999999)).toBe(9);
    expect(onGrid(7.8)).toBe(7.796875);
  });

  it("gives the 15 px code font's card the same bitmap whether its advance is 9 or a hair over", () => {
    const rows = [{ number: 2 }, { number: 3 }];
    const sizeFor = (advance: number) => {
      const ch = onGrid(advance);
      const l = layoutImage(rows, { ch, lineH: 22.5, widest: onGrid(16 * advance) }, { numbers: true, name: true, frame: "plain", pad: 32 });
      return [1, 2, 3].map((s) => chooseScale(l.width, l.height, s));
    };
    expect(sizeFor(9.0015)).toEqual(sizeFor(9));
    expect(sizeFor(9)[1]).toMatchObject({ scale: 2, width: 822 });
  });
});
