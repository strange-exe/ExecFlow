// WCAG 2.2 contrast for the theme layer (token contract v2): the colour variables every theme
// provides, the foreground/background pairs the UI actually draws, CodeEditor's own palette rules
// (role distinctness and region steps), and the guard that lifts a colour until it passes. This
// file has NO imports, so scripts/contrast-check.mjs can load it straight from Node (built-in type
// stripping) and report exactly what the app and its tests check.
//
// Relative luminance and contrast ratio: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
// and https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio (sRGB threshold 0.04045). Non-text
// contrast: https://www.w3.org/TR/WCAG22/#non-text-contrast. OKLab: https://bottosson.github.io/posts/oklab/
// (the matrices below are from that page).

/**
 * The colour half of the CSS variable contract, v2 (every theme sets all 42; v1 had 30). Fonts,
 * sizes and --code-size are set in tokens.css. v1's accent family was split by role: --accent is
 * now --action (the primary fill), --accent-ink is --link, and their other jobs moved to
 * --location, --info, --focus, --control-on, --brand and --input-echo.
 */
export const COLOR_VARS = [
  // grounds and regions
  "bg", "surface", "surface-raised", "terminal-bg", "terminal-fg", "runlog-bg", "divider", "border", "border-strong",
  // text
  "text", "text-secondary", "text-muted", "gutter-text",
  // action
  "action", "action-hover", "on-action", "control-on",
  // focus, selection, location
  "focus", "selection", "list-selected", "active-line", "location",
  // severity
  "danger", "warning", "success", "info",
  // run outcome
  "error-band", "call-site", "input-echo",
  // links and brand
  "link", "brand", "on-brand",
  // syntax
  "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable",
  "syn-operator", "syn-macro", "syn-punctuation",
] as const;
export type ColorVar = (typeof COLOR_VARS)[number];
export type Palette = Record<ColorVar, string>;

export const SYNTAX_VARS = COLOR_VARS.filter((v) => v.startsWith("syn-"));

/**
 * The four band tokens may be translucent (#rrggbbaa): CodeMirror paints the text selection under
 * line backgrounds, so an opaque active-line or error band would hide a selection on that line.
 * Used alone, each is painted over the ground named here.
 */
export const ALPHA_BASE = {
  "active-line": "bg",
  "error-band": "bg",
  selection: "bg",
  "list-selected": "surface",
} as const satisfies Partial<Record<ColorVar, ColorVar>>;
export type BandVar = keyof typeof ALPHA_BASE;
export const ALPHA_OK: readonly BandVar[] = Object.keys(ALPHA_BASE) as BandVar[];

/** A plain colour (theme files and every non-band token). */
export const HEX = /^#[0-9a-f]{6}$/i;
/** A band token's value: a plain colour, or one with an alpha byte. */
export const BAND_HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

const isBand = (name: string): name is BandVar => (ALPHA_OK as readonly string[]).includes(name);

/** True when `value` is a valid value for colour token `name` (alpha only on the four bands). */
export function isTokenValue(name: string, value: unknown): value is string {
  if (typeof value !== "string" || !(COLOR_VARS as readonly string[]).includes(name)) return false;
  return isBand(name) ? BAND_HEX.test(value) : HEX.test(value);
}

// ---------------------------------------------------------------- colour math

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(v: number[]): string {
  return `#${v.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
}

const opaque = (hex: string) => hex.slice(0, 7);
const alphaOf = (hex: string) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `t` (0..1) drawn over `base`: what CSS color-mix(in srgb, top t*100%, base) and alpha compositing paint. */
export function over(base: string, top: string, t: number): string {
  const [b, f] = [rgb(base), rgb(top)];
  return toHex(b.map((v, i) => v * (1 - t) + f[i] * t));
}

/**
 * Moves `fg` towards black or white (whichever the first background needs) in 5% steps until it
 * reaches `target` against every background. The hue is kept; only lightness moves.
 */
export function lift(fg: string, backgrounds: readonly string[], target: number): string {
  if (backgrounds.every((bg) => contrast(fg, bg) >= target)) return fg;
  const towards = luminance(backgrounds[0]) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  const from = rgb(fg);
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const hex = toHex(from.map((v, i) => v + (towards[i] - v) * t));
    if (backgrounds.every((bg) => contrast(hex, bg) >= target)) return hex;
  }
  return toHex(towards);
}

/** OKLab [L, a, b] of an sRGB colour (alpha ignored). */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(opaque(hex)).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklch(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = oklab(hex);
  const C = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

/** OKLab distance: the perceptual difference of two large areas. */
export function deltaE(x: string, y: string): number {
  const [p, q] = [oklab(x), oklab(y)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// ---------------------------------------------------------------- UI-derived colours and stacks

/**
 * Colours the component CSS derives from the contract with color-mix(), so every theme gets them.
 * tokens.css writes each one as `--<name>: color-mix(in srgb, var(--<top>) <pct>%, transparent)`;
 * src/theme/contrast.test.ts checks the CSS matches this table, and the pairs below resolve them
 * over the surface they are drawn on.
 */
export const UI_MIXES = {
  hover: { top: "text", pct: 7 },
} as const satisfies Record<string, { top: ColorVar; pct: number }>;
export type UiMix = keyof typeof UI_MIXES;

type Part = ColorVar | UiMix;
/**
 * A ground: a colour variable, or a stack painted right to left: "hover@surface" is the hover mix
 * over the surface, "error-band@selection@bg" the error band over the selection over the code.
 */
export type Ref = ColorVar | `${Part}@${ColorVar}` | `${Part}@${BandVar}@${ColorVar}`;

/** A token used alone: a band is painted over its ALPHA_BASE. */
function solid(p: Palette, name: ColorVar): string {
  const v = p[name];
  if (v.length !== 9) return v;
  return isBand(name) ? over(solid(p, ALPHA_BASE[name]), opaque(v), alphaOf(v)) : opaque(v);
}

/** One stack part painted over `base`. */
function paint(p: Palette, name: Part, base: string): string {
  if (name in UI_MIXES) {
    const mix = UI_MIXES[name as UiMix];
    return over(base, opaque(p[mix.top]), mix.pct / 100);
  }
  const v = p[name as ColorVar];
  return v.length === 9 ? over(base, opaque(v), alphaOf(v)) : v;
}

/** The colour a ground really is on screen. */
export function resolve(p: Palette, ref: Ref): string {
  const parts = ref.split("@") as Part[];
  let color = solid(p, parts[parts.length - 1] as ColorVar);
  for (let i = parts.length - 2; i >= 0; i--) color = paint(p, parts[i], color);
  return color;
}

// ---------------------------------------------------------------- the pairs the UI draws

export interface Pair {
  fg: ColorVar;
  bg: Ref;
  /** 4.5 for text, 3 for UI boundaries, indicators and meaningful graphics. */
  min: number;
  use: string;
}

export const TEXT = 4.5;
export const UI = 3;

const PANELS = ["bg", "surface", "surface-raised"] as const;

/**
 * The v1 rows, in v1's order, renamed to v2 tokens (the accent's roles split by use). Ported from
 * the design record's contract (.claude/design/redesign/pairs.mjs, 2026-10-18), verbatim.
 */
function ported(): Pair[] {
  const list: Pair[] = [];
  const add = (fg: ColorVar, bg: Ref, min: number, use: string) => list.push({ fg, bg, min, use });

  // Chrome text: every panel, the hovered rows and buttons.
  for (const bg of PANELS) {
    add("text", bg, TEXT, "body text, file names, labels");
    add("text-muted", bg, TEXT, "hints, placeholders, keycaps, field notes");
    add("text", `hover@${bg}`, TEXT, "hovered row or ghost button");
    add("text-muted", `hover@${bg}`, TEXT, "hovered ghost button label");
    add("link", bg, TEXT, "links (always underlined)");
    add("focus", bg, UI, "focus ring; on bg also the editor's focus bar on the gutter edge");
    add("border-strong", bg, UI, "control and input boundaries, keycaps, search and bracket outlines");
    for (const s of ["danger", "warning", "success"] as const) add(s, bg, TEXT, `${s} text and icons: notices, problems, field notes, status words`);
  }
  // The selected tree row (list-selected over the sidebar) and the icons drawn on it.
  add("text", "list-selected@surface", TEXT, "selected tree row");
  add("text-muted", "list-selected@surface", TEXT, "secondary text and lock icon on the selected tree row");
  add("location", "list-selected@surface", UI, "current-file bar on the selected tree row");
  add("focus", "list-selected@surface", UI, "focus ring around the selected tree row");
  add("warning", "list-selected@surface", UI, "conflict-copy icon on the selected tree row");
  add("danger", "list-selected@surface", UI, "has-errors icon on the selected tree row");
  add("danger", "hover@surface", UI, "has-errors icon on a hovered tree row");
  add("danger", "hover@surface-raised", TEXT, "Delete in a menu, on the hovered or focused item");
  for (const s of ["danger", "warning"] as const) add(s, "hover@bg", TEXT, `${s} severity word on a hovered problem row`);

  // Run (the one filled action control) and the current-item markers.
  add("on-action", "action", TEXT, "Run label and icon on the action fill; Connect, Create");
  add("on-action", "action-hover", TEXT, "Run label on the hovered fill");
  add("action", "surface", UI, "Run fill against the editor head");
  add("location", "bg", UI, "active editor tab indicator (the active tab is on bg)");
  add("location", "surface", UI, "current-file bar in the tree; selected panel tab and phone view-switch indicator");

  // Editor: syntax, gutter, lint marks, outlines (editor/highlight.ts and extensions.ts LINT_SPEC).
  for (const t of SYNTAX_VARS) {
    add(t, "bg", TEXT, `${t} on the editor`);
    add(t, "active-line@bg", TEXT, `${t} on the active line`);
    add(t, "selection@bg", TEXT, `${t} inside a selection`);
  }
  add("text", "active-line@bg", TEXT, "text and current line number on the active line");
  add("gutter-text", "bg", TEXT, "line numbers");
  for (const s of ["danger", "warning", "info", "text-muted"] as const) {
    add(s, "bg", UI, `${s} lint underline and gutter marker`);
    add(s, "active-line@bg", UI, `${s} lint underline and gutter marker on the active line`);
  }
  add("border-strong", "active-line@bg", UI, "search and bracket outline on the active line");
  add("danger", "bg", UI, "unmatched bracket outline");
  add("text", "surface-raised", TEXT, "tooltips, autocomplete list, menus");
  // The suggestion (autocomplete) list, editor/highlight.ts: kind icons, details and the "more
  // options" marks are text-muted, TEXT for the icons too (they share the details' colour). This
  // row is the selected option while the list updates; the list itself and the picked option are
  // checked by the panel rows above and the list-selected rows below. (extensions.test.ts ties this
  // to the CSS.)
  add("text-muted", "active-line@surface-raised", TEXT, "suggestion list: kind icon and detail on the selected option while the list updates");

  // Output: the log, the run-log header's status words (v1: receipt chips) and live input.
  add("terminal-fg", "terminal-bg", TEXT, "program output");
  add("danger", "terminal-bg", TEXT, "stderr text");
  add("success", "runlog-bg", TEXT, "Finished status word and icon in the run-log header (v1: receipt chip)");
  add("warning", "runlog-bg", TEXT, "Stopped and Time limit reached status words in the run-log header (v1: receipt chips)");
  add("text-muted", "terminal-bg", TEXT, "(end of input) echo and console notes");
  add("input-echo", "terminal-bg", TEXT, "the user's typed input echoed in the log (with a non-colour cue)");
  add("danger", "terminal-bg", UI, "stderr bar beside each stderr line");
  add("success", "terminal-bg", UI, "success note icon in the log");
  add("warning", "terminal-bg", UI, "warning note icon in the log");
  add("border-strong", "terminal-bg", UI, "live input field boundary");
  add("focus", "terminal-bg", UI, "focus ring on the live input field and the log");
  return list;
}

/** Rows the v2 contract and layout add. */
function added(): Pair[] {
  const list: Pair[] = [];
  const add = (fg: ColorVar, bg: Ref, min: number, use: string) => list.push({ fg, bg, min, use });

  // A third readable text level for chrome.
  for (const bg of PANELS) {
    add("text-secondary", bg, TEXT, "secondary but readable chrome: state words, breadcrumb, inactive tabs, labels");
    add("text-secondary", `hover@${bg}`, TEXT, "secondary text on a hovered row or button");
  }
  add("text-secondary", "list-selected@surface", TEXT, "secondary text on the selected tree row");

  // The suggestion list on its own ground and on v2's selected-option fill.
  add("text-muted", "surface-raised", TEXT, "suggestion list: kind icons, option details, more-options marks");
  add("text-muted", "list-selected@surface-raised", TEXT, "suggestion list: kind icon and detail on the selected option");

  // list-selected in its other places (autocomplete, dialog choices, theme tiles).
  add("text", "list-selected@surface-raised", TEXT, "selected autocomplete option");
  add("text", "active-line@surface-raised", TEXT, "selected autocomplete option while the list updates");
  add("text", "list-selected@bg", TEXT, "chosen option in First connect; selected theme tile name");
  add("text-muted", "list-selected@bg", TEXT, "note under a chosen option");

  // location in its other places.
  add("location", "hover@surface", UI, "current-file bar on a hovered tree row");
  add("location", "list-selected@surface-raised", UI, "bar on the selected autocomplete option and lint-panel row");
  add("location", "active-line@surface-raised", UI, "bar on the selected autocomplete option while the list updates");
  add("location", "list-selected@bg", UI, "outline of the selected theme tile");

  // The action fill on the dialog ground, and checked controls.
  add("action", "bg", UI, "Connect and Create fills on a dialog or the empty workspace");
  add("control-on", "bg", UI, "checked checkbox and radio, progress bar (dialogs)");
  add("control-on", "surface", UI, "checked checkbox in the editor's search panel");

  // focus wherever v2 can draw it (the caret is drawn in focus too).
  add("focus", "runlog-bg", UI, "focus ring on run-log header controls");
  add("focus", "active-line@bg", UI, "caret on the active line");
  add("focus", "selection@bg", UI, "caret inside a selection");
  add("focus", "error-band@bg", UI, "caret and focus bar on the error line");
  add("focus", "error-band@runlog-bg", UI, "focus ring on the exception button in a failed run's header");
  add("focus", "list-selected@bg", UI, "focus ring on a chosen option or the selected theme tile");

  // info as icons and marks (words stay in text).
  add("info", "surface", UI, "unsynced sync icon, runtime not-downloaded icon, status-bar notice icon");
  add("info", "surface-raised", UI, "info icon in tooltips");
  add("info", "terminal-bg", UI, "info note icon in the log");
  add("info", "hover@bg", UI, "info icon on a hovered problem row");

  // Plain text inside a selection.
  add("text", "selection@bg", TEXT, "untokenised text inside a selection");

  // The error-line band (code and its gutter cell) after a failed run.
  for (const t of SYNTAX_VARS) add(t, "error-band@bg", TEXT, `${t} on the error line`);
  add("text", "error-band@bg", TEXT, "untokenised text and the current line number on the error line");
  add("gutter-text", "error-band@bg", TEXT, "line number on the error line");
  add("danger", "error-band@bg", UI, "error squiggle and gutter marker on the error line");

  // Selected text on the cursor line and on the error line: CodeMirror draws the selection under
  // the line backgrounds, so what shows is the band painted over the selection.
  for (const t of SYNTAX_VARS) add(t, "active-line@selection@bg", TEXT, `${t} selected on the cursor line`);
  add("text", "active-line@selection@bg", TEXT, "untokenised text selected on the cursor line");
  for (const t of SYNTAX_VARS) add(t, "error-band@selection@bg", TEXT, `${t} selected on the error line`);
  add("text", "error-band@selection@bg", TEXT, "untokenised text selected on the error line");

  // The call-site marker (the call that led to the error, in the file that ran).
  add("call-site", "bg", UI, "call-site outline and gutter glyph");
  add("call-site", "active-line@bg", UI, "call-site outline and gutter glyph on the active line (the cursor moves there)");

  // The run-log header (one per run, sticky at the top of the log).
  add("text", "runlog-bg", TEXT, "file name and status word in the run-log header");
  add("text-secondary", "runlog-bg", TEXT, "exit code and time in the run-log header");
  add("text-muted", "runlog-bg", TEXT, "timer paused note in the run-log header");
  add("danger", "runlog-bg", TEXT, "Couldn't start and Crashed status words in a neutral header");
  add("text", "hover@runlog-bg", TEXT, "hovered End input button in the header");
  add("border-strong", "runlog-bg", UI, "outlined controls in the run-log header");
  // A failed run's header carries the error band and the lifted exception.
  add("text", "error-band@runlog-bg", TEXT, "file name and status word in a failed run's header");
  add("text-secondary", "error-band@runlog-bg", TEXT, "exit code and time in a failed run's header");
  add("danger", "error-band@runlog-bg", TEXT, "the lifted exception and its status icon");
  add("text", "hover@error-band@runlog-bg", TEXT, "hovered exception button (its exception text, in --text since round 2)");
  // The exception text is drawn in --text with a --danger x-circle, so this row is the icon (3:1).
  add("danger", "hover@error-band@runlog-bg", UI, "x-circle on a hovered exception button");

  // The brand mark (logos are exempt from 1.4.11; kept legible on purpose).
  add("on-brand", "brand", UI, "glyph on the brand tile");

  // Tree badges on a hovered row.
  add("warning", "hover@surface", UI, "conflict-copy icon on a hovered tree row");

  // The error jump drawn on error-band over the editor head. The exception button's 1 px danger
  // boundary is covered by "danger on error-band@runlog-bg" (4.5:1, stricter than a boundary needs).
  add("text", "error-band@surface", TEXT, "error jump label on its error-band fill in the editor head");
  add("danger", "error-band@surface", UI, "error jump x-circle, and its danger edge or bar");
  add("focus", "error-band@surface", UI, "focus ring on the error jump");
  add("text-secondary", "hover@error-band@runlog-bg", TEXT, "hovered exception button (its location part)");
  return list;
}

/**
 * Every foreground/background pair the UI draws: 185 rows (100 ported from v1, 85 new). Three rows
 * repeat an earlier (fg, bg, min) with another `use` (danger on bg at 3:1 and text on
 * surface-raised, both from v1; text-muted on surface-raised from the suggestion list), so 182
 * checks are unique; the `use` text records another place the pair is drawn.
 */
export const PAIRS: readonly Pair[] = [...ported(), ...added()];

export interface PairResult extends Pair {
  fgHex: string;
  bgHex: string;
  ratio: number;
  pass: boolean;
}

export function checkPalette(p: Palette): PairResult[] {
  return PAIRS.map((pair) => {
    const fgHex = p[pair.fg];
    const bgHex = resolve(p, pair.bg);
    const ratio = contrast(fgHex, bgHex);
    return { ...pair, fgHex, bgHex, ratio, pass: ratio >= pair.min };
  });
}

// ---------------------------------------------------------------- CodeEditor's own palettes: distinctness and steps

/**
 * Role distinctness. Two colours are distinct when both are chromatic (OKLCH C >= CHROMA_MIN) and
 * their hues differ by HUE_MIN degrees or more; or exactly one is chromatic and they differ by
 * DELTA_E_MIN in OKLab; or both are neutral and their lightness differs by NEUTRAL_L_MIN. A rule
 * with when: "chromatic" applies only if one of the two is chromatic. These rules (and STEPS) bind
 * CodeEditor's own palettes; the palette themes keep the WCAG pairs and the guard only.
 */
export const DISTINCT_LIMITS = { CHROMA_MIN: 0.04, HUE_MIN: 30, DELTA_E_MIN: 0.12, NEUTRAL_L_MIN: 0.3 };

export interface DistinctRule {
  a: ColorVar;
  b: ColorVar;
  when?: "chromatic";
  why: string;
}

export const DISTINCT: readonly DistinctRule[] = [
  { a: "focus", b: "action", why: "a focus ring is not the Run colour" },
  { a: "focus", b: "location", why: "a focus ring never looks like the current-file and tab bars beside it" },
  { a: "info", b: "action", why: "info severity is distinct from the action hue" },
  { a: "syn-function", b: "action", why: "function names sit away from the Run colour" },
  { a: "brand", b: "action", why: "the brand mark is not a second action-coloured object" },
  { a: "call-site", b: "action", why: "the call-site marker is neutral or danger, never the action colour" },
  { a: "call-site", b: "focus", why: "the call-site outline does not read as a focus or caret mark" },
  { a: "input-echo", b: "link", when: "chromatic", why: "typed input is not coloured like a link" },
  { a: "action", b: "danger", why: "Run never reads as an error or a destructive action" },
  { a: "location", b: "danger", why: "the current-file bar sits beside error flags in the tree and tabs" },
  { a: "danger", b: "warning", why: "severities differ in hue as well as icon shape" },
  { a: "syn-function", b: "warning", why: "a warning squiggle under a function name is never gold on gold" },
  { a: "brand", b: "focus", why: "the brand tile never looks like the focus colour" },
];

export type Scheme = "light" | "dark";
export type Separation = "surface" | "line";

export interface Step {
  a: Ref;
  b: Ref;
  /** "dE": OKLab distance; "ratio": WCAG ratio; "chroma": a's OKLCH chroma, with a's hue within hueMax of b's. */
  metric: "dE" | "ratio" | "chroma";
  min: number;
  /** A pair whose delta E is the cap. */
  max?: readonly [Ref, Ref];
  hueMax?: number;
  schemes?: readonly Scheme[];
  why: string;
}

/** Region steps and bands: "common" binds every own palette, plus the set of its separation mode. */
export const STEPS: Record<"common" | Separation, readonly Step[]> = {
  common: [
    { a: "terminal-bg", b: "bg", metric: "dE", min: 0.03, why: "the program's terminal has its own ground" },
    { a: "runlog-bg", b: "terminal-bg", metric: "dE", min: 0.02, why: "the run-log header reads as a header band over the log" },
    { a: "error-band@bg", b: "bg", metric: "dE", min: 0.05, why: "the error-line band is a visible band" },
    { a: "error-band@bg", b: "active-line@bg", metric: "dE", min: 0.04, why: "the error band never reads as the current-line band" },
    { a: "selection@bg", b: "bg", metric: "dE", min: 0.03, why: "selected text is visible" },
    { a: "active-line@selection@bg", b: "active-line@bg", metric: "dE", min: 0.03, why: "a selection stays visible on the cursor line (CodeMirror draws it under line bands)" },
    { a: "error-band@selection@bg", b: "error-band@bg", metric: "dE", min: 0.03, why: "a selection stays visible on the error line" },
    { a: "list-selected@surface", b: "surface", metric: "dE", min: 0.025, max: ["error-band@bg", "bg"], why: "the selected file row is visible but never louder than the error band" },
    { a: "error-band@bg", b: "selection@bg", metric: "dE", min: 0.05, why: "the error band never reads as a text selection" },
    { a: "error-band@bg", b: "danger", metric: "chroma", min: 0.02, hueMax: 20, schemes: ["light"], why: "the error line's band reads as red, not as a neutral tint" },
    { a: "error-band@bg", b: "danger", metric: "chroma", min: 0.04, hueMax: 20, schemes: ["dark"], why: "the error line's band reads as red, not as a neutral tint" },
    { a: "error-band@surface", b: "danger", metric: "chroma", min: 0.02, hueMax: 20, schemes: ["light"], why: "the error jump's fill reads as red" },
    { a: "error-band@surface", b: "danger", metric: "chroma", min: 0.04, hueMax: 20, schemes: ["dark"], why: "the error jump's fill reads as red" },
    { a: "error-band@runlog-bg", b: "danger", metric: "chroma", min: 0.02, hueMax: 20, schemes: ["light"], why: "a failed run's header reads as red" },
    { a: "error-band@runlog-bg", b: "danger", metric: "chroma", min: 0.04, hueMax: 20, schemes: ["dark"], why: "a failed run's header reads as red" },
  ],
  surface: [
    { a: "surface", b: "bg", metric: "dE", min: 0.03, why: "chrome (sidebar, editor head, panel bar, status bar) vs the code" },
    { a: "surface-raised", b: "surface", metric: "dE", min: 0.02, schemes: ["dark"], why: "menus and tooltips over chrome, dark mode (no shadows there)" },
    { a: "surface-raised", b: "bg", metric: "dE", min: 0.02, schemes: ["dark"], why: "menus and tooltips over the code, dark mode (no shadows there)" },
  ],
  line: [
    { a: "divider", b: "bg", metric: "ratio", min: 1.8, why: "region lines drawn on purpose, against the code ground" },
    { a: "divider", b: "surface", metric: "ratio", min: 1.8, why: "region lines against the chrome ground" },
    { a: "divider", b: "terminal-bg", metric: "ratio", min: 1.8, why: "region line above the log" },
  ],
};

export interface DistinctResult extends DistinctRule {
  aHex: string;
  bHex: string;
  detail: string;
  pass: boolean;
}

export interface StepResult extends Step {
  set: "common" | Separation;
  aHex: string;
  bHex: string;
  value: number;
  cap?: number;
  hue?: number;
  pass: boolean;
}

function distinctness(x: string, y: string): { ok: boolean; both: "chromatic" | "mixed" | "neutral"; detail: string } {
  const { CHROMA_MIN, HUE_MIN, DELTA_E_MIN, NEUTRAL_L_MIN } = DISTINCT_LIMITS;
  const [m, n] = [oklch(x), oklch(y)];
  const [cx, cy] = [m.C >= CHROMA_MIN, n.C >= CHROMA_MIN];
  if (cx && cy) {
    const d = Math.abs(m.h - n.h);
    const dh = Math.min(d, 360 - d);
    return { ok: dh >= HUE_MIN, both: "chromatic", detail: `hues ${dh.toFixed(0)} deg apart (needs ${HUE_MIN})` };
  }
  if (cx !== cy) {
    const dE = deltaE(x, y);
    return { ok: dE >= DELTA_E_MIN, both: "mixed", detail: `one neutral, dE ${dE.toFixed(3)} (needs ${DELTA_E_MIN})` };
  }
  const dL = Math.abs(m.L - n.L);
  return { ok: dL >= NEUTRAL_L_MIN, both: "neutral", detail: `both neutral, dL ${dL.toFixed(3)} (needs ${NEUTRAL_L_MIN})` };
}

function measure(metric: Step["metric"], x: string, y: string): number {
  if (metric === "chroma") return oklch(x).C;
  return metric === "ratio" ? contrast(x, y) : deltaE(x, y);
}

function hueGap(x: string, y: string): number {
  const d = Math.abs(oklch(x).h - oklch(y).h);
  return Math.min(d, 360 - d);
}

/** Role distinctness and region steps for one of CodeEditor's own palettes. */
export function checkRules(p: Palette, opts: { scheme: Scheme; separation: Separation }): { distinct: DistinctResult[]; steps: StepResult[] } {
  const distinct = DISTINCT.map((rule) => {
    const [aHex, bHex] = [resolve(p, rule.a), resolve(p, rule.b)];
    const d = distinctness(aHex, bHex);
    const skip = rule.when === "chromatic" && d.both === "neutral";
    return { ...rule, aHex, bHex, detail: skip ? "both neutral: the rule does not apply" : d.detail, pass: skip || d.ok };
  });
  const sets = [["common", STEPS.common], [opts.separation, STEPS[opts.separation]]] as const;
  const steps = sets.flatMap(([set, rows]) =>
    rows.filter((s) => !s.schemes || s.schemes.includes(opts.scheme)).map((s): StepResult => {
      const [aHex, bHex] = [resolve(p, s.a), resolve(p, s.b)];
      const value = measure(s.metric, aHex, bHex);
      const cap = s.max ? measure(s.metric, resolve(p, s.max[0]), resolve(p, s.max[1])) : undefined;
      const hue = s.hueMax !== undefined ? hueGap(aHex, bHex) : undefined;
      const pass = value >= s.min && (cap === undefined || value <= cap) && (hue === undefined || hue <= s.hueMax!);
      return { ...s, set, aHex, bHex, value, cap, hue, pass };
    }),
  );
  return { distinct, steps };
}

// ---------------------------------------------------------------- the readability guard (palette themes)

/**
 * Colours the guard may move. Grounds, rules and bands never move; the Run label (on-action) and
 * the brand glyph (on-brand) are picked, not lifted; the hovered fill follows the Run fill.
 */
const FIXED: readonly ColorVar[] = [
  "bg", "surface", "surface-raised", "terminal-bg", "runlog-bg", "divider", "border", "selection", "list-selected",
  "active-line", "error-band", "brand", "on-action", "action-hover", "on-brand",
];
export const LIFTABLE: ReadonlySet<ColorVar> = new Set(COLOR_VARS.filter((v) => !FIXED.includes(v)));

/**
 * Returns a palette where every pair passes, and the names of the colours it had to move. Each
 * foreground is lifted against all of its backgrounds at once; mixes and stacks that depend on a
 * moved colour (hover) are recomputed by repeating the pass until nothing changes.
 */
export function readablePalette(input: Palette): { palette: Palette; adjusted: ColorVar[] } {
  const p: Palette = { ...input };
  const adjusted = new Set<ColorVar>();
  const byFg = new Map<ColorVar, Pair[]>();
  for (const pair of PAIRS) if (LIFTABLE.has(pair.fg)) byFg.set(pair.fg, [...(byFg.get(pair.fg) ?? []), pair]);
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const [fg, list] of byFg) {
      const target = Math.max(...list.map((x) => x.min));
      const failing = list.filter((x) => contrast(p[fg], resolve(p, x.bg)) < x.min);
      if (!failing.length) continue;
      // Lift against every background it is drawn on, at the strictest minimum among them.
      const next = lift(p[fg], list.map((x) => resolve(p, x.bg)), target);
      if (next !== p[fg]) {
        p[fg] = next;
        adjusted.add(fg);
        moved = true;
      }
    }
    // The Run label: the best-reading light colour on a light page, dark on a dark one (so the
    // fill can move away from the page and the label at once). If it still falls short, the fills
    // move away from it (a darker fill under a light label).
    const onFills = (c: string) => Math.min(contrast(c, p.action), contrast(c, p["action-hover"]));
    if (onFills(p["on-action"]) < TEXT) {
      const light = luminance(p.bg) > 0.18;
      const label = [p["on-action"], p.bg, p.text, "#0b0e13", "#ffffff"]
        .filter((c) => luminance(c) > 0.18 === light)
        .sort((a, b) => onFills(b) - onFills(a))[0];
      if (label !== p["on-action"]) {
        p["on-action"] = label;
        adjusted.add("on-action");
        moved = true;
      }
      for (const fill of ["action", "action-hover"] as const) {
        const next = lift(p[fill], [label], TEXT);
        if (next !== p[fill]) {
          p[fill] = next;
          adjusted.add(fill);
          moved = true;
        }
      }
    }
    // The brand glyph: kept legible on its tile (3:1). The tile never moves, so the glyph is picked
    // from the palette's own colours (or near-black and white), whichever reads best.
    if (contrast(p["on-brand"], p.brand) < UI) {
      const glyph = [p["on-brand"], p.bg, p.text, p.surface, "#0b0e13", "#ffffff"].sort((a, b) => contrast(b, p.brand) - contrast(a, p.brand))[0];
      if (glyph !== p["on-brand"]) {
        p["on-brand"] = glyph;
        adjusted.add("on-brand");
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { palette: p, adjusted: [...adjusted] };
}
