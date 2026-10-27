import { describe, expect, it } from "vitest";
import { ELLIPSIS, MAX_TEXT, WRAP, condition, label } from "./labels";

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("flowchart labels", () => {
  it("collapses whitespace and keeps the code's own text", () => {
    const l = label("sum  =\n\t  sum + i");
    expect(l.full).toBe("sum = sum + i");
    expect(l.lines).toEqual(["sum = sum + i"]);
  });

  it("ends a condition with ' ?'", () => {
    expect(condition("i < n").full).toBe("i < n ?");
    expect(condition("  i <\n n ").lines).toEqual(["i < n ?"]);
  });

  it("wraps at about 28 characters, between words", () => {
    const l = label("total_marks = total_marks + marks[i] * weight[i]");
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) expect([...line].length).toBeLessThanOrEqual(WRAP);
    expect(l.lines.join(" ")).toBe(l.full);
  });

  it("splits a word longer than a line", () => {
    const word = "x".repeat(60);
    const l = label(word, { maxLines: 5 });
    expect(l.lines).toEqual(["x".repeat(28), "x".repeat(28), "x".repeat(4)]);
  });

  it("cuts long text with an ellipsis and keeps the full text for the accessible name", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const l = label(text, { maxLines: 3 });
    expect(l.lines.length).toBe(3);
    expect(l.lines[2].endsWith(ELLIPSIS)).toBe(true);
    for (const line of l.lines) expect([...line].length).toBeLessThanOrEqual(WRAP);
    expect(l.full).toBe(text);
    expect(l.cut).toBe(true);
    expect(label("short").cut).toBe(false);
  });

  it("caps the full text too, so a huge statement can't make a huge name", () => {
    const l = label("a".repeat(100_000));
    expect([...l.full].length).toBe(MAX_TEXT + 1);
    expect(l.full.endsWith(ELLIPSIS)).toBe(true);
  });

  it("tags direction and invisible characters with shown(), in the lines and the full text", () => {
    const l = label(`if (role ${cp(0x202e)}== admin${cp(0x2066)}) x${cp(0x200b)}y`);
    for (const text of [...l.lines, l.full]) {
      const raw = [...text].map((c) => c.codePointAt(0)!).filter((p) => (p >= 0x202a && p <= 0x202e) || (p >= 0x2066 && p <= 0x2069) || p === 0x200b);
      expect(raw).toEqual([]);
    }
    expect(l.full).toContain("[U+202E]");
    expect(l.full).toContain("[U+2066]");
    expect(l.full).toContain("[U+200B]");
  });

  it("tags a lone surrogate (it can't be drawn or exported as UTF-8), and keeps a real pair", () => {
    const pair = cp(0x1f600);
    const l = label(`x = "${String.fromCharCode(0xd800)}${pair}"`);
    expect(l.full).toContain("[U+D800]");
    expect(l.full).toContain(pair);
    expect([...l.full].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false);
  });

  it("never splits a [U+XXXX] tag across two lines", () => {
    const text = `${"y".repeat(24)}${cp(0x202e)}${"z".repeat(10)}`;
    const l = label(text, { maxLines: 4 });
    for (const line of l.lines) {
      expect(line.split("[").length).toBe(line.split("]").length);
    }
    expect(l.lines.join("")).toBe(l.full);
  });

  it("never splits a character made of two UTF-16 units", () => {
    const smile = cp(0x1f600);
    const l = label(smile.repeat(40), { maxLines: 4 });
    // A lone surrogate is a code point between 0xd800 and 0xdfff once the string is split by code points.
    for (const line of l.lines) expect([...line].filter((c) => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff)).toEqual([]);
    expect(l.lines[0]).toBe(smile.repeat(28));
  });
});
