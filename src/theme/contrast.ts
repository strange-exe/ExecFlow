// WCAG 2.2 contrast for the theme layer: the colour variables every theme provides, the
// foreground/background pairs the UI actually draws, and the guard that lifts a colour until it
// passes. This file has NO imports, so scripts/contrast-check.mjs can load it straight from Node
// (built-in type stripping) and report exactly what the app and its tests check.
//
// Relative luminance and contrast ratio: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
// and https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio (sRGB threshold 0.04045).

/** The colour half of the CSS variable contract (every theme sets all of these). Fonts and --code-size are set in tokens.css. */
export const COLOR_VARS = [
  "bg", "surface", "surface-raised", "border", "border-strong", "text", "text-muted", "gutter-text",
  "accent", "accent-hover", "on-accent", "accent-ink", "focus", "danger", "warning", "success",
  "selection", "active-line", "terminal-bg", "terminal-fg",
  "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable",
  "syn-operator", "syn-macro", "syn-punctuation",
] as const;
export type ColorVar = (typeof COLOR_VARS)[number];
export type Palette = Record<ColorVar, string>;

export const SYNTAX_VARS = COLOR_VARS.filter((v) => v.startsWith("syn-"));

export const HEX = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------- colour math

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(v: number[]): string {
  return `#${v.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
}

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

/** `top` at `t` (0..1) drawn over `base`: what CSS color-mix(in srgb, top t*100%, base) paints. */
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

// ---------------------------------------------------------------- UI-derived colours

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

/** A colour variable, or a UI mix drawn over one ("hover@surface"). */
export type Ref = ColorVar | `${UiMix}@${ColorVar}`;

export function resolve(p: Palette, ref: Ref): string {
  const at = ref.indexOf("@");
  if (at < 0) return p[ref as ColorVar];
  const mix = UI_MIXES[ref.slice(0, at) as UiMix];
  return over(p[ref.slice(at + 1) as ColorVar], p[mix.top], mix.pct / 100);
}

// ---------------------------------------------------------------- the pairs the UI draws

export interface Pair {
  fg: ColorVar;
  bg: Ref;
  /** 4.5 for text, 3 for UI boundaries, indicators and meaningful graphics. */
  min: number;
  use: string;
}

const TEXT = 4.5;
const UI = 3;

function pairs(): Pair[] {
  const list: Pair[] = [];
  const add = (fg: ColorVar, bg: Ref, min: number, use: string) => list.push({ fg, bg, min, use });
  const panels = ["bg", "surface", "surface-raised"] as const;

  // Chrome text: every panel, the hovered rows and buttons, the selected tree row.
  for (const bg of panels) {
    add("text", bg, TEXT, "body text, file names, labels");
    add("text-muted", bg, TEXT, "secondary text, hints, status bar, placeholders (::placeholder in app.css)");
    add("text", `hover@${bg}`, TEXT, "hovered row or ghost button");
    add("text-muted", `hover@${bg}`, TEXT, "hovered ghost button label");
    add("accent-ink", bg, TEXT, "links and accent-coloured text");
    add("focus", bg, UI, "focus ring");
    add("border-strong", bg, UI, "control and input boundaries, keycaps, search and bracket outlines");
    for (const s of ["danger", "warning", "success"] as const) add(s, bg, TEXT, `${s} text: status line, notice, problems`);
  }
  add("text", "selection", TEXT, "selected tree row, text selection, autocomplete option, focused lint item");
  add("text-muted", "selection", TEXT, "secondary text and lock icon on the selected tree row");
  add("accent", "selection", UI, "active-file bar on the selected tree row, autocomplete bar, current search match outline");
  add("focus", "selection", UI, "focus ring around the selected tree row");
  add("warning", "selection", UI, "conflict-copy icon on the selected tree row");
  add("danger", "selection", UI, "has-errors icon on the selected tree row");
  add("danger", "hover@surface", UI, "has-errors icon on a hovered tree row");
  add("danger", "hover@surface-raised", TEXT, "Delete in a menu, on the hovered or focused item");
  // Problems rows: the severity word on a hovered row.
  for (const s of ["danger", "warning"] as const) add(s, "hover@bg", TEXT, `${s} severity word on a hovered problem row`);

  // Run (the one filled accent control) and the active markers.
  add("on-accent", "accent", TEXT, "Run label and keycap on the accent fill");
  add("on-accent", "accent-hover", TEXT, "Run label on the hovered fill");
  add("accent", "surface", UI, "Run fill against the top bar; active-file bar in the tree");
  add("accent", "bg", UI, "active editor tab indicator; info lint underline");
  add("accent", "surface-raised", UI, "active panel tab indicator");

  // Editor: syntax, gutter, lint marks, outlines (editor/highlight.ts and extensions.ts LINT_SPEC).
  for (const t of SYNTAX_VARS) {
    add(t, "bg", TEXT, `${t} on the editor`);
    add(t, "active-line", TEXT, `${t} on the active line`);
    add(t, "selection", TEXT, `${t} inside a selection`);
  }
  add("text", "active-line", TEXT, "text and current line number on the active line");
  add("gutter-text", "bg", TEXT, "line numbers");
  for (const s of ["danger", "warning", "accent", "text-muted"] as const) {
    add(s, "bg", UI, `${s} lint underline and gutter marker`);
    add(s, "active-line", UI, `${s} lint underline and gutter marker on the active line`);
  }
  // A matching bracket is a selection-filled box with this outline: the outline meets the editor or
  // the active line around it, so those are its adjacent colours.
  add("border-strong", "active-line", UI, "search and bracket outline on the active line");
  add("danger", "bg", UI, "unmatched bracket outline");
  add("text", "surface-raised", TEXT, "tooltips, autocomplete list, menus");

  // Output console, receipt chips and live input.
  add("terminal-fg", "terminal-bg", TEXT, "program output");
  add("danger", "terminal-bg", TEXT, "stderr text and the 'error' receipt chip");
  add("success", "terminal-bg", TEXT, "'finished' receipt chip");
  add("warning", "terminal-bg", TEXT, "'stopped' and 'time limit' receipt chips");
  add("text-muted", "terminal-bg", TEXT, "receipt facts (exit code, time), echoed end of input");
  add("accent-ink", "terminal-bg", TEXT, "echoed input line");
  for (const s of ["danger", "success", "warning", "border-strong"] as const) add(s, "terminal-bg", UI, `${s} receipt chip outline, input field boundary`);
  add("focus", "terminal-bg", UI, "focus ring on the live input field");
  return list;
}

export const PAIRS: readonly Pair[] = pairs();

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

/** Colours the guard may move (backgrounds never move; on-accent is picked, not lifted). */
const LIFTABLE = new Set<ColorVar>(COLOR_VARS.filter((v) => !["bg", "surface", "surface-raised", "border", "selection", "active-line", "terminal-bg", "on-accent", "accent-hover"].includes(v)));

/**
 * Returns a palette where every pair passes, and the names of the colours it had to move. Each
 * foreground is lifted against all of its backgrounds at once; mixes that depend on a moved colour
 * (hover) are recomputed by repeating the pass until nothing changes.
 */
export function readablePalette(input: Palette): { palette: Palette; adjusted: ColorVar[] } {
  const p: Palette = { ...input };
  const adjusted = new Set<ColorVar>();
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const byFg = new Map<ColorVar, Pair[]>();
    for (const pair of PAIRS) if (LIFTABLE.has(pair.fg)) byFg.set(pair.fg, [...(byFg.get(pair.fg) ?? []), pair]);
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
    // move away from it (a darker blue under a white label).
    const onFills = (c: string) => Math.min(contrast(c, p.accent), contrast(c, p["accent-hover"]));
    if (onFills(p["on-accent"]) < TEXT) {
      const light = luminance(p.bg) > 0.18;
      const label = [p["on-accent"], p.bg, p.text, "#0b0e13", "#ffffff"]
        .filter((c) => luminance(c) > 0.18 === light)
        .sort((a, b) => onFills(b) - onFills(a))[0];
      if (label !== p["on-accent"]) {
        p["on-accent"] = label;
        adjusted.add("on-accent");
        moved = true;
      }
      for (const fill of ["accent", "accent-hover"] as const) {
        const next = lift(p[fill], [label], TEXT);
        if (next !== p[fill]) {
          p[fill] = next;
          adjusted.add(fill);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return { palette: p, adjusted: [...adjusted] };
}
