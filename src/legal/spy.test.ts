import { describe, expect, it } from "vitest";
import { pinReleased, reachesLine, readingIndex } from "./spy";

describe("reachesLine", () => {
  // A heading 4000 px down the page, a 160 px reading line, and 5000 px of scroll.
  it("is true when scrolling can bring the heading up to the reading line", () => {
    expect(reachesLine(4000, 160, 5000)).toBe(true);
    expect(reachesLine(5160, 160, 5000)).toBe(true);
    expect(reachesLine(5160.5, 160, 5000)).toBe(true); // sub-pixel rounding
  });
  it("is false for a heading too near the end of the page to reach it", () => {
    expect(reachesLine(5400, 160, 5000)).toBe(false);
    expect(reachesLine(600, 160, 0)).toBe(false);
  });
});

describe("readingIndex", () => {
  const line = 160;
  it("is -1 before the first heading reaches the reading line", () => {
    expect(readingIndex([400, 900, 1500], line)).toBe(-1);
    expect(readingIndex([], line)).toBe(-1);
  });
  it("is the last heading at or above the line", () => {
    expect(readingIndex([160, 900], line)).toBe(0);
    expect(readingIndex([-800, -200, 40, 700], line)).toBe(2);
    expect(readingIndex([-900, -500, -100], line)).toBe(2);
  });
  it("keeps a chosen section that can't reach the line while it is in the window", () => {
    // At the bottom of the page: "Changes" (3) sits at 500 px, under the line; "Removing" (2) is read.
    expect(readingIndex([-900, -300, 60, 500], line)).toBe(2);
    expect(readingIndex([-900, -300, 60, 500], line, 3, 900)).toBe(3);
  });
  it("lets the reading move past a pinned section, and ignores a pin out of the window or out of range", () => {
    expect(readingIndex([-900, -300, 60, 500], line, 1, 900)).toBe(2);
    expect(readingIndex([-900, -300, 60, 1200], line, 3, 900)).toBe(2);
    expect(readingIndex([-900, -300, 60, 500], line, 7, 900)).toBe(2);
  });
});

describe("pinReleased", () => {
  it("drops the pin once the heading leaves the window", () => {
    expect(pinReleased(40, 900)).toBe(false);
    expect(pinReleased(-1, 900)).toBe(true);
    expect(pinReleased(900, 900)).toBe(true);
  });
});
