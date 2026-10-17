// Converting tool positions (clang, wasm-ld, Python) to CodeMirror offsets and back.
//
// CodeMirror counts every line break and every UTF-16 code unit as one position. Tools count
// differently (core/types.ts ColumnUnit):
//   - "utf8-byte":  clang columns (1-based) and Python co_positions / traceback colno (0-based);
//   - "code-point": Python parser SyntaxError.offset / end_offset (1-based);
//   - "utf16":      the Python runner's wire format and LSP (0-based), CodeMirror itself.
// Everything here is pure, clamps instead of throwing (lintGutter's doc.lineAt throws a RangeError
// on a position past the end), and converts against the exact text that was compiled.

import type { Text } from "@codemirror/state";
import type { ColumnUnit } from "../core/types";

/** UTF-8 length of a code point. A lone surrogate counts 3, like TextEncoder (it writes U+FFFD). */
function utf8Width(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * UTF-16 offset within `lineText` of the 0-based column `col0` counted in `unit`. A column that
 * falls inside a character snaps to that character's start; past the end clamps to the line
 * length; NaN and negatives give 0.
 */
export function columnToUtf16(lineText: string, col0: number, unit: ColumnUnit): number {
  if (!(col0 > 0)) return 0;
  if (unit === "utf16") {
    let i = Math.min(Math.trunc(col0), lineText.length);
    if (i > 0 && i < lineText.length && isHigh(lineText.charCodeAt(i - 1)) && isLow(lineText.charCodeAt(i))) i--;
    return i;
  }
  let units = 0;
  let counted = 0;
  while (units < lineText.length) {
    const cp = lineText.codePointAt(units)!;
    const width = unit === "code-point" ? 1 : utf8Width(cp);
    if (counted + width > col0) break;
    counted += width;
    units += cp > 0xffff ? 2 : 1;
  }
  return units;
}

/** `line1` clamped to the document's lines (1-based); NaN gives 1. */
export function clampLine(doc: Text, line1: number): number {
  const n = Math.trunc(line1);
  return n >= 1 ? Math.min(n, doc.lines) : 1;
}

/** `pos` clamped to [0, doc.length]; NaN gives 0. */
export function clampPos(doc: Text, pos: number): number {
  const n = Math.trunc(pos);
  return n > 0 ? Math.min(n, doc.length) : 0;
}

/**
 * Document offset of a tool position: 1-based `line1`, `column` in `unit` counted from `base`
 * (a missing column is the start of the line). Never throws: lines and columns out of range clamp.
 */
export function toOffset(doc: Text, line1: number, column: number | undefined, unit: ColumnUnit, base: 0 | 1): number {
  const line = doc.line(clampLine(doc, line1));
  if (column == null) return line.from;
  return line.from + columnToUtf16(line.text, column - (base === 0 ? 0 : 1), unit);
}

/**
 * UTF-8 byte offset of the UTF-16 offset `units` within `lineText` (the inverse of
 * columnToUtf16 for "utf8-byte"). An offset inside a surrogate pair snaps to the pair's start.
 */
export function utf16ToUtf8Col(lineText: string, units: number): number {
  return countUpTo(lineText, units, utf8Width);
}

function countUpTo(lineText: string, units: number, width: (cp: number) => number): number {
  const end = units > 0 ? Math.min(Math.trunc(units), lineText.length) : 0;
  let total = 0;
  for (let i = 0; i < end; ) {
    const cp = lineText.codePointAt(i)!;
    const w16 = cp > 0xffff ? 2 : 1;
    if (i + w16 > end) break;
    total += width(cp);
    i += w16;
  }
  return total;
}

/**
 * 1-based line and column of `pos` (clamped), for the status bar and for sending positions to a
 * tool. The column counts `unit`s (UTF-16 code units by default).
 */
export function toLineCol(doc: Text, pos: number, unit: ColumnUnit = "utf16"): { line: number; col: number } {
  const p = clampPos(doc, pos);
  const line = doc.lineAt(p);
  const units = p - line.from;
  const col0 = unit === "utf16" ? units : countUpTo(line.text, units, unit === "utf8-byte" ? utf8Width : () => 1);
  return { line: line.number, col: col0 + 1 };
}
