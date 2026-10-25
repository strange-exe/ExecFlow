import { describe, expect, it } from "vitest";
import { contrast, HEX, TEXT } from "./contrast";
import { SIGNAL } from "./palettes";
import { PAPER, PRINT_INK, PRINT_RULE_TOKENS, PRINT_TEXT_TOKENS } from "./print-ink";

describe("the print-safe ink (Save as PDF)", () => {
  it.each(PRINT_TEXT_TOKENS.map((t) => [t]))("%s keeps 4.5:1 on white paper", (token) => {
    const ratio = contrast(PRINT_INK[token], PAPER);
    expect(ratio, `${token} ${PRINT_INK[token]} on ${PAPER}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT);
  });

  it("is Signal Light's ink (the default theme's), plain hexes only (no translucent values reach paper)", () => {
    for (const token of [...PRINT_TEXT_TOKENS, ...PRINT_RULE_TOKENS]) {
      expect(PRINT_INK[token]).toBe(SIGNAL.light[token]);
      expect(PRINT_INK[token]).toMatch(HEX);
    }
  });

  it("the check can fail: a pale colour is caught", () => {
    expect(contrast("#999999", PAPER)).toBeLessThan(TEXT);
  });
});
