import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { clampLine, clampPos, columnToUtf16, toLineCol, toOffset, utf16ToUtf8Col } from "./positions";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const E_ACUTE = cp(0xe9); // 2 UTF-8 bytes, 1 UTF-16 unit
const HAN = cp(0x4e2d); // 3 bytes, 1 unit
const EMOJI = cp(0x1f600); // 4 bytes, 2 units
const LONE = String.fromCharCode(0xd800); // lone surrogate: TextEncoder writes U+FFFD, 3 bytes
const doc = (text: string) => Text.of(text.split("\n"));
const utf8 = (s: string) => new TextEncoder().encode(s).length;

// x e han emoji lone y: UTF-16 starts 0 1 2 3 5 6; UTF-8 starts 0 1 3 6 10 13; code points 0..5
const LINE = `x${E_ACUTE}${HAN}${EMOJI}${LONE}y`;
const UNIT_STARTS = [0, 1, 2, 3, 5, 6];
const BYTE_STARTS = [0, 1, 3, 6, 10, 13];

describe("columnToUtf16", () => {
  it("is the identity for ASCII in every unit", () => {
    for (const unit of ["utf8-byte", "code-point", "utf16"] as const) {
      expect(columnToUtf16("int x = 1;", 4, unit)).toBe(4);
    }
  });

  it("agrees with TextEncoder on the byte widths it assumes", () => {
    expect([E_ACUTE, HAN, EMOJI, LONE].map(utf8)).toEqual([2, 3, 4, 3]);
  });

  it("converts UTF-8 byte columns for 1-, 2-, 3- and 4-byte characters and a lone surrogate", () => {
    BYTE_STARTS.forEach((byte, i) => expect(columnToUtf16(LINE, byte, "utf8-byte"), `byte ${byte}`).toBe(UNIT_STARTS[i]));
  });

  it("snaps a byte column inside a character to that character's start", () => {
    expect(columnToUtf16(LINE, 2, "utf8-byte")).toBe(1); // inside the 2-byte e
    expect(columnToUtf16(LINE, 4, "utf8-byte")).toBe(2); // inside the 3-byte character
    expect(columnToUtf16(LINE, 8, "utf8-byte")).toBe(3); // inside the emoji
    expect(columnToUtf16(LINE, 11, "utf8-byte")).toBe(5); // inside the lone surrogate's 3 bytes
  });

  it("counts an emoji as one code point but two UTF-16 units", () => {
    [0, 1, 2, 3, 4, 5].forEach((point, i) => expect(columnToUtf16(LINE, point, "code-point")).toBe(UNIT_STARTS[i]));
  });

  it("keeps UTF-16 columns, snapping one between the halves of a surrogate pair to its start", () => {
    expect(columnToUtf16(LINE, 3, "utf16")).toBe(3);
    expect(columnToUtf16(LINE, 4, "utf16")).toBe(3);
    expect(columnToUtf16(LINE, 5, "utf16")).toBe(5);
  });

  it("clamps columns past the end, negatives and NaN", () => {
    for (const unit of ["utf8-byte", "code-point", "utf16"] as const) {
      expect(columnToUtf16(LINE, 999, unit)).toBe(LINE.length);
      expect(columnToUtf16(LINE, Infinity, unit)).toBe(LINE.length);
      expect(columnToUtf16(LINE, -3, unit)).toBe(0);
      expect(columnToUtf16(LINE, Number.NaN, unit)).toBe(0);
    }
    expect(columnToUtf16("", 5, "utf8-byte")).toBe(0);
  });
});

describe("toOffset", () => {
  const source = doc(`int main() {\n  printf("${EMOJI}");\n  retur 0;\n}`);

  it("places a clang position (1-based bytes) on the right character", () => {
    expect(toOffset(source, 3, 3, "utf8-byte", 1)).toBe(source.line(3).from + 2); // the r of "retur"
    // Line 2: two spaces, printf(", the 4-byte emoji, then the closing quote at byte 14 (column 15).
    const quote = toOffset(source, 2, 15, "utf8-byte", 1);
    expect(source.sliceString(quote, quote + 1)).toBe('"');
  });

  it("places a Python SyntaxError offset (1-based code points) after an emoji", () => {
    const py = doc(`s = "${EMOJI}" +\nprint(s`);
    const plus = toOffset(py, 1, 9, "code-point", 1); // the 9th character, UTF-16 unit 9
    expect(plus).toBe(9);
    expect(py.sliceString(plus, plus + 1)).toBe("+");
  });

  it("places a 0-based UTF-8 column (Python co_positions) the same as the 1-based one", () => {
    expect(toOffset(source, 2, 14, "utf8-byte", 0)).toBe(toOffset(source, 2, 15, "utf8-byte", 1));
  });

  it("clamps lines past the end and before the start instead of throwing", () => {
    expect(toOffset(source, 99, 1, "utf8-byte", 1)).toBe(source.line(source.lines).from);
    expect(toOffset(source, 0, 1, "utf8-byte", 1)).toBe(0);
    expect(toOffset(source, -5, 1, "utf8-byte", 1)).toBe(0);
    expect(toOffset(source, Number.NaN, 1, "utf8-byte", 1)).toBe(0);
  });

  it("clamps a column past the end of its line to the line end", () => {
    expect(toOffset(source, 1, 500, "utf8-byte", 1)).toBe(source.line(1).to);
    expect(toOffset(source, 99, 500, "utf8-byte", 1)).toBe(source.length);
  });

  it("uses the line start when there is no column", () => {
    expect(toOffset(source, 3, undefined, "utf8-byte", 1)).toBe(source.line(3).from);
  });

  it("works on an empty document", () => {
    const empty = doc("");
    expect(toOffset(empty, 5, 5, "utf8-byte", 1)).toBe(0);
    expect(clampLine(empty, 5)).toBe(1);
    expect(clampPos(empty, 5)).toBe(0);
  });
});

describe("utf16ToUtf8Col", () => {
  it("matches TextEncoder for every character start", () => {
    UNIT_STARTS.forEach((unit, i) => {
      expect(utf16ToUtf8Col(LINE, unit)).toBe(BYTE_STARTS[i]);
      expect(utf16ToUtf8Col(LINE, unit)).toBe(utf8(LINE.slice(0, unit)));
    });
  });

  it("round-trips with columnToUtf16", () => {
    for (const unit of UNIT_STARTS) expect(columnToUtf16(LINE, utf16ToUtf8Col(LINE, unit), "utf8-byte")).toBe(unit);
  });

  it("snaps inside a surrogate pair and clamps", () => {
    expect(utf16ToUtf8Col(LINE, 4)).toBe(6);
    expect(utf16ToUtf8Col(LINE, 999)).toBe(utf8(LINE));
    expect(utf16ToUtf8Col(LINE, -1)).toBe(0);
  });
});

describe("toLineCol", () => {
  const text = doc(`ab\n${EMOJI}z`);

  it("gives 1-based lines and UTF-16 columns by default", () => {
    expect(toLineCol(text, 0)).toEqual({ line: 1, col: 1 });
    expect(toLineCol(text, 2)).toEqual({ line: 1, col: 3 });
    expect(toLineCol(text, 5)).toEqual({ line: 2, col: 3 }); // after the emoji: 2 UTF-16 units
  });

  it("can count UTF-8 bytes or code points instead", () => {
    expect(toLineCol(text, 5, "utf8-byte")).toEqual({ line: 2, col: 5 });
    expect(toLineCol(text, 5, "code-point")).toEqual({ line: 2, col: 2 });
  });

  it("clamps positions outside the document", () => {
    expect(toLineCol(text, -4)).toEqual({ line: 1, col: 1 });
    expect(toLineCol(text, 999)).toEqual({ line: 2, col: 4 });
  });
});
