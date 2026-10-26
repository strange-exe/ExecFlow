// Flowchart box labels: the code's own text, whitespace collapsed, wrapped at about WRAP
// characters and cut with an ellipsis after a few lines. The full text (capped at MAX_TEXT) is
// kept for the box's accessible name and tooltip. Every character that could hide or reorder
// text (bidi controls, invisible characters) is tagged by shown(), as everywhere else in the app.
import { tagUnshown as shown } from "../core/safety";

/** Characters per line, counted in code points. */
export const WRAP = 28;
/** The longest full text kept, in code points of the code (before tags). */
export const MAX_TEXT = 400;
export const ELLIPSIS = String.fromCodePoint(0x2026);

export interface Label {
  /** The lines drawn in the box. */
  lines: string[];
  /** The whole text, for the accessible name and tooltip. */
  full: string;
  /** True when the lines leave part of the text out. */
  cut: boolean;
}

/** Splits text into "atoms" that a line break never splits: one code point, or a whole [U+XXXX] tag. */
function atoms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[U\+[0-9A-F]{4,6}\]|[\s\S]/gu)) out.push(m[0]);
  return out;
}

const width = (parts: string[]) => parts.reduce((n, a) => n + [...a].length, 0);

/** Word-wraps `text` into lines of at most `max` code points. */
function wrapLines(text: string, max: number): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let word: string[] = [];
  const flushWord = () => {
    // A word that doesn't fit in what is left of the line starts a new one; one longer than a whole
    // line is split wherever the line is full.
    const needed = width(word) + (line.length ? 1 : 0);
    if (line.length && width(line) + needed > max) {
      lines.push(line.join(""));
      line = [];
    }
    for (const a of word) {
      if (line.length && width(line) + [...a].length > max) {
        lines.push(line.join(""));
        line = [];
      }
      if (line.length === 0 && a === " ") continue;
      line.push(a);
    }
    word = [];
  };
  for (const a of atoms(text)) {
    if (a === " ") {
      flushWord();
      if (line.length) line.push(" ");
    } else {
      word.push(a);
    }
  }
  flushWord();
  if (line.length) lines.push(line.join("").trimEnd());
  return lines.map((l) => l.trimEnd());
}

/** Cuts `line` so that it plus an ellipsis fits in `max` code points. */
function withEllipsis(line: string, max: number): string {
  const parts = atoms(line.trimEnd());
  while (parts.length && width(parts) + 1 > max) parts.pop();
  return parts.join("").trimEnd() + ELLIPSIS;
}

/** The label for a piece of code. `maxLines` lines at most; the last is cut with an ellipsis. */
export function label(code: string, { maxLines = 3, wrap = WRAP }: { maxLines?: number; wrap?: number } = {}): Label {
  const collapsed = code.replace(/\s+/g, " ").trim();
  const points = [...collapsed];
  const capped = points.length > MAX_TEXT ? points.slice(0, MAX_TEXT).join("") + ELLIPSIS : collapsed;
  const full = shown(capped);
  const all = wrapLines(full, wrap);
  if (all.length <= maxLines) return { lines: all, full, cut: capped !== collapsed };
  const lines = all.slice(0, maxLines);
  lines[maxLines - 1] = withEllipsis(lines[maxLines - 1], wrap);
  return { lines, full, cut: true };
}

/** A function's name as shown (chart picker, call boxes): one line of at most 60 code points. */
export const nameText = (name: string) => label(name, { maxLines: 1, wrap: 60 }).lines[0] ?? "";

/** An edge's label (a case value): one line of at most 20 code points. */
export const edgeText = (text: string) => label(text, { maxLines: 1, wrap: 20 }).lines[0] ?? "";

/** A decision's label: the condition's own text followed by " ?". */
export function condition(code: string, options?: { maxLines?: number }): Label {
  return label(`${code.replace(/\s+/g, " ").trim()} ?`, options);
}
