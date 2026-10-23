// The measured widths the image's size is built from go on the font grid first (CI, 2026-10-23:
// Linux WebKit's image was 1 px wider, its card a hair over the 411 px every other engine measured).
import { describe, expect, it } from "vitest";
import { onGrid } from "./snippet-canvas";
import { chooseScale, layoutImage } from "./snippet-render";

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
