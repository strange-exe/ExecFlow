// Capture snippet: the pure parts every entry point decides with (the file menu, the editor head's
// button, the editor's context menu; final-v3, .claude/design/snippet-image/): which whole lines a
// selection captures, the menu labels, the refusals and their texts, whether images can be copied,
// reading the remembered options, and the long-name cut (the dialog draws it too). This module is in
// the shell (the first visit), so what only the dialog needs lives in core/snippet-dialog.ts, which
// only the lazy dialog chunk imports. Type-only CodeMirror imports, so CodeMirror stays out of the
// first visit. Kept ASCII: special characters are built from their code points. No DOM types
// either: the worker build type-checks src/core with the WebWorker library.
import { nameOf } from "./paths";
import { BIDI_CONTROL, CONTROL, HIDDEN } from "./safety";

// Direction controls (Trojan Source), invisible and control characters, all of them at once.
const UNSHOWN = new RegExp(`${BIDI_CONTROL.source}|${HIDDEN.source}|${CONTROL.source}`, "g");

/**
 * ui/dom.ts shown(), for this DOM-free module (a unit test keeps the two equal): each direction,
 * invisible or control character in untrusted text (a file name, a custom theme's name) becomes a
 * visible tag such as "[U+202E]", so it can neither reorder nor hide the rest of the label.
 */
export function shown(text: string): string {
  return text.replace(UNSHOWN, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}

/** The most lines one image shows (the user's choice). */
export const MAX_LINES = 300;

/** U+2026, the ellipsis a cut name shows. */
export const ELLIPSIS = String.fromCodePoint(0x2026);

// ---------------------------------------------------------------- which lines

/** What pickLines reads: an EditorState, structurally. */
export interface LineLike {
  readonly number: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}
export interface RangeLike {
  readonly from: number;
  readonly to: number;
  readonly empty: boolean;
}
export interface SelectionState {
  readonly doc: { lineAt(pos: number): LineLike; line(n: number): LineLike };
  readonly selection: { readonly ranges: readonly RangeLike[] };
}

export type LineSpan = { readonly ok: true; readonly first: number; readonly last: number; readonly gaps: boolean };
export type LineRefusal =
  | { readonly ok: false; readonly reason: "empty" | "blank" }
  | { readonly ok: false; readonly reason: "cap"; readonly count: number; readonly first: number; readonly last: number };
export type LinePlan = LineSpan | LineRefusal;

/** Spaces and tabs only. A line holding an invisible character is not blank: it is drawn with its placeholder. */
const BLANK = /^[ \t]*$/;

/**
 * The whole lines a selection captures (final-v3 section 3): from the line of each non-empty range's
 * start to the line of its end, where an end at column 0 of a later line leaves that line out; one
 * span from the first range to the last (empty ranges, extra cursors, are ignored); blank lines at
 * both ends trimmed. `gaps`: a line inside the span that no range touches is drawn too, and the
 * dialog says so.
 */
export function pickLines(state: SelectionState): LinePlan {
  const { doc } = state;
  const spans: [number, number][] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) continue;
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    const first = doc.lineAt(from).number;
    const end = doc.lineAt(to);
    spans.push([first, to === end.from && end.number > first ? end.number - 1 : end.number]);
  }
  if (!spans.length) return { ok: false, reason: "empty" };
  let first = Math.min(...spans.map((s) => s[0]));
  let last = Math.max(...spans.map((s) => s[1]));
  while (first <= last && BLANK.test(doc.line(first).text)) first++;
  while (last >= first && BLANK.test(doc.line(last).text)) last--;
  if (first > last) return { ok: false, reason: "blank" };
  const count = last - first + 1;
  if (count > MAX_LINES) return { ok: false, reason: "cap", count, first, last };
  return { ok: true, first, last, gaps: hasGap(spans, first, last) };
}

/** True when some line from `first` to `last` lies in none of the spans. */
function hasGap(spans: [number, number][], first: number, last: number): boolean {
  let next = first;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b < next) continue;
    if (a > next) return true;
    next = b + 1;
    if (next > last) return false;
  }
  return next <= last;
}

// ---------------------------------------------------------------- labels

export const lineWords = (first: number, last: number): string => (first === last ? `line ${first}` : `lines ${first} to ${last}`);

/** The width a name may take in a menu label, in units (a [U+XXXX] tag is one). */
export const MENU_NAME_UNITS = 24;

/**
 * The file menu's item (with the file's name) and the code menu's (`name` null): "Capture snippet
 * of main.py, lines 4 to 12...". Built from the plan, so the whole-line rule shows before the click.
 */
export function menuLabel(plan: LinePlan, name: string | null): string {
  if (!plan.ok && plan.reason !== "cap") return "Capture snippet of the selected lines...";
  const lines = lineWords(plan.first, plan.last);
  if (name === null) return `Capture snippet of ${lines}...`;
  return `Capture snippet of ${fitName(labelUnits(shown(nameOf(name))), () => 1, MENU_NAME_UNITS)}, ${lines}...`;
}

// ---------------------------------------------------------------- colours (the choices and tokens: core/snippet-dialog.ts)

/** Which colours the document root shows: Deep Field (no data-palette), Slate, or a palette theme (21 more, High contrast, custom). */
export type PaintFamily = "deep-field" | "slate" | "palette";
export interface PaintInfo {
  readonly family: PaintFamily;
  readonly scheme: "light" | "dark";
  readonly themeName: string | null;
}
export type ColorChoice = "match" | "light" | "dark";

// ---------------------------------------------------------------- copying images

/** What canCopyImages reads: globalThis, structurally. */
export interface ClipboardScope {
  readonly isSecureContext?: boolean;
  readonly ClipboardItem?: unknown;
  readonly navigator?: { readonly clipboard?: { readonly write?: unknown } };
}

/** True where a PNG can be put on the clipboard (Copy image is offered only then). Never a bare ClipboardItem reference. */
export function canCopyImages(scope: ClipboardScope): boolean {
  if (!scope.isSecureContext) return false;
  const item: unknown = scope.ClipboardItem;
  if (typeof item !== "function") return false;
  if (typeof scope.navigator?.clipboard?.write !== "function") return false;
  const supports = (item as { supports?: unknown }).supports;
  // ClipboardItem.supports is missing before Safari 18.4: then PNG is assumed (every engine writes it).
  if (typeof supports !== "function") return true;
  try {
    return supports.call(item, "image/png") === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the dialog's options

export interface ImageOptions {
  readonly colors: ColorChoice;
  readonly numbers: boolean;
  readonly name: boolean;
}
export const DEFAULT_IMAGE_OPTIONS: ImageOptions = Object.freeze({ colors: "match", numbers: true, name: true });
/** One device key of its own (5.4): a per-viewer convenience, cleared by "Sign out and clear this computer". */
export const IMAGE_OPTIONS_KEY = "codeeditor:snippet-image";

/** Stored options cleaned field by field: unknown keys dropped, anything odd falls back to its default. */
export function cleanImageOptions(value: unknown): ImageOptions {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    colors: v.colors === "light" || v.colors === "dark" || v.colors === "match" ? v.colors : DEFAULT_IMAGE_OPTIONS.colors,
    numbers: typeof v.numbers === "boolean" ? v.numbers : DEFAULT_IMAGE_OPTIONS.numbers,
    name: typeof v.name === "boolean" ? v.name : DEFAULT_IMAGE_OPTIONS.name,
  };
}

/** localStorage, structurally. */
export interface OptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (SecurityError): the defaults then, and changes last for the opening. */
export function readImageOptions(storage: Pick<OptionsStorage, "getItem"> | null): ImageOptions {
  try {
    return cleanImageOptions(JSON.parse(storage?.getItem(IMAGE_OPTIONS_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_IMAGE_OPTIONS };
  }
}

// ---------------------------------------------------------------- messages (final-v3 section 6.2)

/** Where Capture was asked for: the file menu, the head button by pointer or by key, or the code menu. */
export type Entry = "menu" | "head-pointer" | "head-key" | "context";
export type Tone = "info" | "error" | "success";

export type CaptureMessage =
  | { readonly kind: "refused"; readonly reason: "no-file" | "empty" | "blank" | "too-big" }
  | { readonly kind: "refused"; readonly reason: "cap"; readonly count: number }
  | { readonly kind: "chunk-failed"; readonly detail: string }
  | { readonly kind: "making-preview" | "updating-preview" | "preview-failed" | "partial" | "gaps" | "making-png" | "denied" }
  | { readonly kind: "copied"; readonly what: string }
  | { readonly kind: "downloaded"; readonly file: string }
  | { readonly kind: "failed"; readonly reason: "device" | "privacy" | "other" }
  | { readonly kind: "failed"; readonly reason: "updating"; readonly action: "copy" | "download" };

/** The texts the shell says itself: a refusal, and the dialog's chunk failing to load. */
export type ShellMessage = Extract<CaptureMessage, { readonly kind: "refused" | "chunk-failed" }>;

/**
 * A refusal's text, or the chunk failure's, string for string (6.2). `open`: the dialog is open (only
 * too-big is said there, from the dialog's own captureMessage in core/snippet-dialog.ts, which has
 * every other text); otherwise the page's notice line says it.
 */
export function refusalMessage(m: ShellMessage, at: { coarse: boolean; entry: Entry; open: boolean }): { text: string; tone: Tone } {
  const info = (text: string) => ({ text, tone: "info" as const });
  if (m.kind === "chunk-failed") return { text: `The image tool couldn't open: ${m.detail.replace(/\.+$/, "")}.`, tone: "error" };
  switch (m.reason) {
    case "no-file":
      return info("Open a file and select some code first.");
    case "empty":
      if (at.coarse) return info("Select the lines to capture first.");
      if (at.entry === "head-pointer") return info("Select the lines first.");
      if (at.entry === "head-key") return info("Select the lines in the code, then press Shift+F10 there.");
      return info("Select the lines first, then right-click them or press Shift+F10.");
    case "blank":
      return info("The selected lines are blank. Select some code first.");
    case "cap":
      return info(`That's ${m.count} lines. An image can show up to ${MAX_LINES}, so select fewer lines.`);
    case "too-big":
      return info(at.open ? "That selection is too big for one image. Close this and select fewer or shorter lines." : "That selection is too big for one image. Select fewer or shorter lines.");
  }
}

// ---------------------------------------------------------------- long names (4.2)

/**
 * Units of a label: a [U+XXXX] tag (from shown()) is one unit, so a cut never splits it; anything
 * else is one code point.
 */
export function labelUnits(text: string): string[] {
  return text.match(/\[U\+[0-9A-F]{4,6}\]|[^]/gu) ?? [];
}

/**
 * Cuts a name in the middle with an ellipsis when its units are wider than `max` (4.2). Kept: the
 * extension (from the last dot, when that dot isn't the first unit and the extension, dot included,
 * is at most 10 units) and the last 4 units of the stem before it. The start shrinks first, down
 * to 1 unit; only then does the stem's tail. Units are never split.
 */
export function fitName(units: readonly string[], widthOf: (unit: string) => number, max: number): string {
  const cut = fitCut(units, widthOf, max);
  return cut ? `${units.slice(0, cut.start).join("")}${ELLIPSIS}${units.slice(units.length - cut.end).join("")}` : units.join("");
}

/**
 * Where fitName cuts: keep `start` units, the ellipsis, then the last `end` units (the stem's tail and
 * the extension). Null when the whole name fits. The image draws the same cut with its own styles.
 */
export function fitCut(units: readonly string[], widthOf: (unit: string) => number, max: number): { start: number; end: number } | null {
  const width = (from: number, to: number) => {
    let w = 0;
    for (let i = from; i < to; i++) w += widthOf(units[i]);
    return w;
  };
  if (width(0, units.length) <= max) return null;
  const dot = units.lastIndexOf(".");
  const extLength = dot > 0 && units.length - dot <= 10 ? units.length - dot : 0;
  const stemLength = units.length - extLength;
  const ell = widthOf(ELLIPSIS);
  let tail = Math.min(4, stemLength);
  // Everything before the tail; it can't fit with the ellipsis added, so the loop shrinks it.
  let start = stemLength - tail;
  const fits = () => width(0, start) + ell + width(units.length - extLength - tail, units.length) <= max;
  while (start > 1 && !fits()) start--;
  while (tail > 0 && !fits()) tail--;
  return { start, end: tail + extLength };
}
