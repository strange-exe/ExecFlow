import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN, KeyboardWatch } from "./keyboard";

describe("KeyboardWatch", () => {
  it("reads a window that got shorter while typing as the keyboard (interactive-widget=resizes-content)", () => {
    const watch = new KeyboardWatch();
    expect(watch.inset({ width: 390, height: 844 }, false)).toBe(0);
    expect(watch.inset({ width: 390, height: 500 }, true)).toBe(344);
    // Not typing: the same short window opens nothing over the dock.
    expect(watch.inset({ width: 390, height: 500 }, false)).toBe(0);
    expect(watch.inset({ width: 390, height: 844 }, true)).toBe(0);
  });

  it("reads a shorter visual viewport the same way (Safari keeps the layout viewport)", () => {
    const watch = new KeyboardWatch();
    watch.inset({ width: 390, height: 664, visualHeight: 664 }, false);
    expect(watch.inset({ width: 390, height: 664, visualHeight: 328 }, true)).toBe(336);
  });

  it("ignores the browser's own bars sliding away, and starts again at a new width", () => {
    const watch = new KeyboardWatch();
    watch.inset({ width: 390, height: 844 }, true);
    expect(watch.inset({ width: 390, height: 844 - (KEYBOARD_MIN - 1) }, true)).toBe(0);
    expect(watch.inset({ width: 390, height: 844 - KEYBOARD_MIN }, true)).toBe(KEYBOARD_MIN);
    // A turn of the phone: the new width's first height is its full height.
    expect(watch.inset({ width: 844, height: 390 }, true)).toBe(0);
    expect(watch.inset({ width: 844, height: 200 }, true)).toBe(190);
  });
});
