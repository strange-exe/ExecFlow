// Capture snippet's renderer, the pure part (final-v3 sections 3, 4.1, 4.5, 7.5 and 7.6): the live
// parse, styled runs from the editor's own highlight style, the editor's special-character
// placeholders, wrapping, tab stops, the image's layout and scale, and the readback check. No DOM:
// snippet-canvas.ts measures and draws. Lazy (the dialog's chunk), so the CodeMirror imports here
// stay out of the shell. Kept ASCII: special characters are built from their code points.
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import { findClusterBreak, type EditorState } from "@codemirror/state";
import { highlightCode, tagHighlighter } from "@lezer/highlight";
import { IMAGE_TOKENS, type ImageToken } from "../core/snippet-dialog";
import { EXTRA_SPECIALS } from "./extensions";
import { highlightStyle } from "./highlight";

/** Lezer's tree, as @codemirror/language declares it (@lezer/common is not a direct dependency). */
export type Tree = ReturnType<typeof syntaxTree>;

/** A piece of a line in one style. `special`: a placeholder for an invisible or control character. */
export interface Run {
  readonly text: string;
  readonly token: ImageToken;
  readonly italic: boolean;
  readonly special?: boolean;
}
export interface StyledLine {
  readonly number: number;
  readonly runs: readonly Run[];
}
/** One drawn row: a line, or a continuation of one (number null, indented by `indent` columns). */
export interface Row {
  readonly number: number | null;
  readonly indent: number;
  readonly runs: readonly Run[];
}

// ---------------------------------------------------------------- the parse

/**
 * The syntax tree up to `to`: the live parse, in 50 ms slices with a yield between them, for at
 * most `budgetMs`. Plain text (no language) has no tree and never yields. When the budget is spent,
 * the tree so far, and `partial` if it ends before `to` (the dialog then says colours are missing).
 */
export async function treeFor(state: EditorState, to: number, budgetMs: number, yieldTask: () => Promise<void>): Promise<{ tree: Tree | null; partial: boolean }> {
  if (state.facet(language) === null) return { tree: null, partial: false };
  const start = performance.now();
  for (;;) {
    const tree = ensureSyntaxTree(state, to, 50);
    if (tree) return { tree, partial: false };
    if (performance.now() - start >= budgetMs) {
      const sofar = syntaxTree(state);
      return { tree: sofar, partial: sofar.length < to };
    }
    await yieldTask();
  }
}

// ---------------------------------------------------------------- styled runs

/** Each highlight-style rule's colour token and italic, by rule index (the classes "s0", "s1", ...). */
const RULES = highlightStyle.specs.map((spec) => {
  const token = /^var\(--([a-z-]+)\)$/.exec(String(spec.color ?? ""))?.[1];
  return {
    token: (IMAGE_TOKENS as readonly string[]).includes(token ?? "") ? (token as ImageToken) : null,
    italic: spec.fontStyle === undefined ? null : spec.fontStyle === "italic",
  };
});
const HIGHLIGHTER = tagHighlighter(highlightStyle.specs.map((spec, i) => ({ tag: spec.tag, class: `s${i}` })));

/** The style of a class list: like the CSS the editor gets, the highest rule index wins per property. */
function styleOf(classes: string): { token: ImageToken; italic: boolean } {
  let token: ImageToken = "text";
  let italic = false;
  let tokenAt = -1;
  let italicAt = -1;
  for (const c of classes.split(" ")) {
    const i = c.startsWith("s") ? Number(c.slice(1)) : NaN;
    const rule = RULES[i];
    if (!rule) continue;
    if (rule.token && i > tokenAt) [token, tokenAt] = [rule.token, i];
    if (rule.italic !== null && i > italicAt) [italic, italicAt] = [rule.italic, i];
  }
  return { token, italic };
}

function push(runs: Run[], run: Run): void {
  const last = runs.at(-1);
  if (last && !last.special && !run.special && last.token === run.token && last.italic === run.italic) {
    runs[runs.length - 1] = { text: last.text + run.text, token: last.token, italic: last.italic };
  } else {
    runs.push(run);
  }
}

/** Lines `first` to `last` as runs of one style each (adjacent equal runs merged). Without a tree, one text run per line. */
export function styledLines(state: EditorState, tree: Tree | null, first: number, last: number): StyledLine[] {
  const lines: { number: number; runs: Run[] }[] = [];
  for (let n = first; n <= last; n++) lines.push({ number: n, runs: [] });
  if (!tree) {
    for (const line of lines) {
      const text = state.doc.line(line.number).text;
      if (text) line.runs.push({ text, token: "text", italic: false });
    }
    return lines;
  }
  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  let at = 0;
  highlightCode(
    state.sliceDoc(0, to),
    tree,
    HIGHLIGHTER,
    (text, classes) => push(lines[at].runs, { text, ...styleOf(classes) }),
    () => void (at = Math.min(at + 1, lines.length - 1)),
    from,
    to,
  );
  return lines;
}

// ---------------------------------------------------------------- special characters

/** CodeMirror 6.43.14's own list (highlightSpecialChars' Specials, not exported), kept here; e2e 18 checks the two agree. */
const DEFAULT_SPECIALS: readonly (number | readonly [number, number])[] = [
  [0x0, 0x8], [0xa, 0x1f], [0x7f, 0x9f], 0xad, 0x61c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff,
  [0xfff9, 0xfffc],
];

/** The editor marks this character (CodeMirror's default list plus the app's EXTRA_SPECIALS). */
export function isSpecial(code: number): boolean {
  for (const s of DEFAULT_SPECIALS) if (typeof s === "number" ? code === s : code >= s[0] && code <= s[1]) return true;
  return EXTRA_SPECIALS.test(String.fromCodePoint(code));
}

/** What the editor draws instead: a control picture below 32, otherwise a bullet. */
export const placeholderFor = (code: number): string => String.fromCodePoint(code < 32 ? 0x2400 + code : 0x2022);

/** Every special character becomes its own danger-coloured placeholder run. Tabs are left alone. */
export function markSpecials(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    let plain = "";
    for (const ch of run.text) {
      const code = ch.codePointAt(0)!;
      if (code === 9 || !isSpecial(code)) {
        plain += ch;
        continue;
      }
      if (plain) out.push({ text: plain, token: run.token, italic: run.italic });
      plain = "";
      out.push({ text: placeholderFor(code), token: "danger", italic: run.italic, special: true });
    }
    if (plain) out.push({ text: plain, token: run.token, italic: run.italic });
  }
  return out;
}

// ---------------------------------------------------------------- whitespace, tabs and wrapping

/** Trailing spaces and tabs go (what the editor would show as nothing). */
export const trimEnd = (text: string): string => text.replace(/[ \t]+$/, "");

/** Runs without trailing spaces and tabs (placeholders are never trimmed). */
export function trimRuns(runs: readonly Run[]): Run[] {
  const out = [...runs];
  while (out.length) {
    const last = out[out.length - 1];
    if (last.special) break;
    const text = trimEnd(last.text);
    if (text) {
      out[out.length - 1] = { ...last, text };
      break;
    }
    out.pop();
  }
  return out;
}

/** The x of the next tab stop (CSS Text 3): a multiple of tabSize spaces from the code's left edge, skipping one closer than half a character. */
export function tabStop(x: number, spaceW: number, ch: number, tabSize: number): number {
  const width = tabSize * spaceW;
  let next = (Math.floor(x / width) + 1) * width;
  if (next - x < 0.5 * ch) next += width;
  return next;
}

/**
 * Wraps a line at `max` columns: after a space at column `threshold` or later, else at `max`,
 * never inside a grapheme cluster. Continuation rows have no number and start at the line's
 * indentation plus the tab size (at most 50 columns). A wide character counts as one column, as in
 * CodeMirror; a tab counts to its stop.
 */
export function wrapRows(line: StyledLine, max: number, threshold: number, tabSize: number): Row[] {
  const units: { text: string; run: Run }[] = [];
  for (const run of line.runs) {
    if (run.special) {
      units.push({ text: run.text, run });
      continue;
    }
    for (let pos = 0; pos < run.text.length; ) {
      const next = findClusterBreak(run.text, pos);
      units.push({ text: run.text.slice(pos, next), run });
      pos = next;
    }
  }
  if (!units.length) return [{ number: line.number, indent: 0, runs: [] }];
  let lead = 0;
  for (const u of units) {
    if (u.text === " ") lead += 1;
    else if (u.text === "\t") lead += tabSize - (lead % tabSize);
    else break;
  }
  const contIndent = Math.min(lead + tabSize, 50);
  const rows: Row[] = [];
  for (let i = 0; i < units.length; ) {
    const indent = rows.length ? contIndent : 0;
    let col = indent;
    let j = i;
    let breakAfter = -1;
    while (j < units.length) {
      const u = units[j];
      const w = u.text === "\t" ? tabSize - (col % tabSize) : 1;
      if (col + w > max && j > i) break;
      if (u.text === " " && col >= threshold) breakAfter = j + 1;
      col += w;
      j++;
    }
    if (j < units.length && breakAfter > i) j = breakAfter;
    const runs: Run[] = [];
    for (const u of units.slice(i, j)) push(runs, u.run.special ? u.run : { text: u.text, token: u.run.token, italic: u.run.italic });
    rows.push({ number: rows.length ? null : line.number, indent, runs });
    i = j;
  }
  return rows;
}

// ---------------------------------------------------------------- layout (4.1)

/** CSS px at scale 1: edge, side padding, vertical padding, gutter gap, name to rule; the narrowest code column. */
export const SIZES = { E: 1, P: 16, V: 12, G: 16, HG: 8, MIN_COLS: 32 } as const;
const { E, P, V, G, HG, MIN_COLS } = SIZES;

export interface Metrics {
  /** The advance of "0" in the code font. */
  readonly ch: number;
  /** The code size times 1.5 (the editor's line box). */
  readonly lineH: number;
  /** The widest row from the code's left edge, indentation and tab stops included. */
  readonly widest: number;
}

export interface ImageLayout {
  readonly width: number;
  readonly height: number;
  /** Where every row's code starts. */
  readonly codeX: number;
  /** The right edge of the line numbers (0 with numbers off). */
  readonly gutterRight: number;
  /** The right edge of the continuation hook marks. */
  readonly markRight: number;
  readonly digits: number;
  readonly nameTop: number;
  readonly ruleY: number;
  readonly codeTop: number;
  readonly rows: number;
}

/** The image's geometry in CSS px (4.1). The header never widens the image. */
export function layoutImage(rows: readonly { readonly number: number | null }[], m: Metrics, o: { readonly numbers: boolean; readonly name: boolean }): ImageLayout {
  const largest = Math.max(0, ...rows.map((r) => r.number ?? 0));
  const digits = o.numbers ? String(largest).length : 0;
  const continued = rows.some((r) => r.number === null);
  let gutterRight = 0;
  let markRight = 0;
  let codeX = E + P;
  if (o.numbers) {
    gutterRight = E + P + digits * m.ch;
    markRight = gutterRight;
    codeX = gutterRight + G;
  } else if (continued) {
    // Numbers off: the hook marks keep a column of their own at the left, so continuation rows stay marked.
    markRight = E + P + m.ch;
    codeX = markRight + G;
  }
  const nameTop = E + V;
  const ruleY = E + V + m.lineH + HG;
  const codeTop = o.name ? ruleY + 1 + V : E + V;
  return {
    width: codeX + Math.max(m.widest, MIN_COLS * m.ch) + P + E,
    height: codeTop + rows.length * m.lineH + V + E,
    codeX, gutterRight, markRight, digits, nameTop, ruleY, codeTop, rows: rows.length,
  };
}

/** The lowest canvas area limit among the browsers (iOS: 4096 x 4096), and the longest side. */
export const MAX_AREA = 16_777_216;
export const MAX_SIDE = 16_384;

/** Scale 2, stepping to 1.5 then 1 until the bitmap fits; null when even scale 1 is too big. */
export function chooseScale(width: number, height: number): { scale: number; width: number; height: number } | null {
  for (const scale of [2, 1.5, 1]) {
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (w * h <= MAX_AREA && w <= MAX_SIDE && h <= MAX_SIDE) return { scale, width: w, height: h };
  }
  return null;
}

/** The edge's (and the rule's) thickness in bitmap pixels. */
export const edgeThickness = (scale: number): number => Math.max(1, Math.round(scale));

// ---------------------------------------------------------------- the readback (7.5)

/** One bitmap row inside the top padding: the left edge's t pixels, then ground; pixel t + 2 is read as ground. */
export const readbackRect = (t: number) => ({ x: 0, y: t + 2, w: t + 3, h: 1 });

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * The readback proves the bitmap is the one drawn: the edge pixels within 8 of --divider, the
 * ground pixel within 8 of --bg, all opaque. A privacy placeholder (random bytes with random alpha,
 * or all white) fails: no built-in theme's divider is within 8 of white.
 */
export function pixelsOk(data: ArrayLike<number>, divider: string, bg: string, t: number): boolean {
  const near = (at: number, hex: string) => {
    const rgb = rgbOf(hex);
    return data[at * 4 + 3] === 255 && rgb.every((c, k) => Math.abs(data[at * 4 + k] - c) <= 8);
  };
  if (data.length < (t + 3) * 4) return false;
  for (let x = 0; x < t; x++) if (!near(x, divider)) return false;
  return near(t + 2, bg);
}
