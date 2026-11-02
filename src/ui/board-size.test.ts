import { describe, expect, it } from "vitest";
import { BOARD_GAP, besideNow, chartDefault, chartMax, CHART_MIN, CODE_MIN, codeKeep, CONSOLE_GAP, consoleDefault, consoleMax, CONSOLE_MIN } from "./board-size";
import { sizeModel } from "./splitter";

// The boards' width at 1440 px and 1100 px: the window less the canvas's 16 px on each side.
const W1440 = 1440 - 32;
const W1100 = 1100 - 32;

describe("the board sizes (Flow Board layout fix, 2026-11-02)", () => {
  it("the code keeps 420 px, or 420 + 8 + 320 with the output beside it", () => {
    expect(codeKeep(false)).toBe(CODE_MIN);
    expect(codeKeep(true)).toBe(CODE_MIN + CONSOLE_GAP + CONSOLE_MIN);
    expect(codeKeep(true)).toBe(748);
  });

  it("the chart's default is half of the boards (two equal boards), and its largest leaves the code its room", () => {
    expect(chartDefault(W1440)).toBe((W1440 - BOARD_GAP) / 2);
    expect(chartMax(W1440, false)).toBe(W1440 - BOARD_GAP - CODE_MIN);
    expect(chartMax(W1440, true)).toBe(W1440 - BOARD_GAP - 748);
    // At 1100 px the default split leaves both boards above their least widths.
    expect(chartDefault(W1100)).toBeGreaterThanOrEqual(CHART_MIN);
    expect(W1100 - BOARD_GAP - chartDefault(W1100)).toBeGreaterThanOrEqual(CODE_MIN);
  });

  it("the output goes beside only when asked and when the code board keeps 420 + 320 (the chart at its least)", () => {
    expect(besideNow(false, W1440, true)).toBe(false);
    expect(besideNow(true, W1440, true)).toBe(true);
    expect(besideNow(true, W1440, false)).toBe(true);
    // 1100 px with the chart shown: 1068 - 16 - 320 = 732 < 748, so it falls back below.
    expect(besideNow(true, W1100, true)).toBe(false);
    // With the chart hidden the whole 1068 px is the code board's.
    expect(besideNow(true, W1100, false)).toBe(true);
    // The exact edge: one pixel short falls back.
    expect(besideNow(true, 748 + BOARD_GAP + CHART_MIN, true)).toBe(true);
    expect(besideNow(true, 747 + BOARD_GAP + CHART_MIN, true)).toBe(false);
  });

  it("the output's width keeps the code its 420 px, and starts at 40 percent of the code board", () => {
    expect(consoleMax(1000)).toBe(1000 - CONSOLE_GAP - CODE_MIN);
    expect(consoleDefault(1000)).toBe(Math.round((1000 - CONSOLE_GAP) * 0.4));
    expect(consoleDefault(748)).toBe(CONSOLE_MIN);
  });

  it("a stored chart width is clamped when the window narrows, and comes back when it widens", () => {
    let width = W1440;
    const chart = sizeModel({ min: CHART_MIN, max: () => chartMax(width, false), wanted: 900 });
    expect(chart.value).toBe(900);
    width = W1100;
    expect(chart.value).toBe(chartMax(W1100, false));
    width = W1440;
    expect(chart.value).toBe(900);
  });

  it("a default that follows the window follows it until a size is chosen, and again after a reset", () => {
    let width = W1440;
    const chart = sizeModel({ min: CHART_MIN, max: () => chartMax(width, false), wanted: () => chartDefault(width) });
    expect([chart.following, chart.value]).toEqual([true, chartDefault(W1440)]);
    width = W1100;
    expect(chart.value).toBe(chartDefault(W1100));
    chart.set(400);
    expect([chart.following, chart.value]).toEqual([false, 400]);
    width = W1440;
    expect(chart.value).toBe(400);
    chart.reset();
    expect([chart.following, chart.value]).toEqual([true, chartDefault(W1440)]);
  });
});
