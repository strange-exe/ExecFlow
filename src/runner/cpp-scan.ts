// Light C/C++ source scanning shared by program selection, hints and linker-error locating.
// Not a parser: comments, string and character literals are blanked out (same length, newlines
// kept) so that simple regular expressions only see code, and offsets still match the original.

/** `text` with comments blanked out; string and character literals stay. */
export function stripComments(text: string): string {
  return blankOut(text, true);
}

/** `text` with comments, string literals and character literals replaced by spaces. */
export function stripCommentsAndStrings(text: string): string {
  return blankOut(text, false);
}

function blankOut(text: string, keepStrings: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(text[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      // A line comment ends at a newline that isn't escaped with a backslash.
      let j = i + 2;
      while (j < n && !(text[j] === "\n" && text[j - 1] !== "\\")) j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
    } else if (c === "R" && next === '"' && !isIdentChar(text[i - 1])) {
      // C++ raw string R"delim( ... )delim"
      const open = text.indexOf("(", i + 2);
      const delim = open < 0 ? "" : text.slice(i + 2, open);
      const close = open < 0 || /[\s\\()]/.test(delim) ? -1 : text.indexOf(`)${delim}"`, open + 1);
      const j = close < 0 ? lineEnd(text, i) : close + delim.length + 2;
      if (keepStrings) out.push(text.slice(i, j));
      else {
        out.push("R");
        blank(i + 1, j);
      }
      i = j;
    } else if (c === '"' || (c === "'" && !isDigitSeparator(text, i))) {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + (text[j] === c ? 1 : 0));
      if (keepStrings) out.push(text.slice(i, j));
      else blank(i, j);
      i = j;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

export function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** C++14 digit separators: 1'000'000 (a quote between two digits of a number). */
function isDigitSeparator(text: string, i: number): boolean {
  return /[0-9a-fA-F]/.test(text[i - 1] ?? "") && /[0-9a-fA-F]/.test(text[i + 1] ?? "") && /\b\d[\w']*$/.test(text.slice(Math.max(0, i - 32), i));
}

/** 1-based line and 0-based UTF-16 column of `offset` in `text`. */
export function lineColAt(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: offset - start };
}

const MAIN = /\b(?:int|void|auto|signed|unsigned)\s+main\s*\(/;

/** Whether the source defines (or at least declares at file level) a main function. */
export function definesMain(text: string): boolean {
  return MAIN.test(stripCommentsAndStrings(text));
}

/** Quoted includes (`#include "x.h"`) in order, outside comments. */
export function quotedIncludes(text: string): string[] {
  const found: string[] = [];
  for (const m of stripComments(text).matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"\n]+)"/gm)) found.push(m[1]);
  return found;
}

/** True when the text has `#include <bits/stdc++.h>` outside comments. */
export function includesBits(text: string): boolean {
  return /^[ \t]*#[ \t]*include[ \t]*<bits\/stdc\+\+\.h>/m.test(stripComments(text));
}
