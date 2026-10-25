// The theme engine (adapted from Pocket Run's src/themes.ts, same author, MIT). A theme is either
// one of CodeEditor's own palettes, Signal (the default), Deep Field or Slate, whose colours live in
// tokens.css so the first paint needs no script, or a palette whose colours are expanded onto the
// variable contract, passed through the readability guard and set as inline CSS variables on
// <html>. public/theme-boot.js repaints the saved choice before the app loads, from what
// applyTheme() stores under PAINT_KEY.

import { checkBytes } from "../core/safety";
import { shown } from "../ui/dom";
import { COLOR_VARS, HEX, isTokenValue, readablePalette, type ColorVar, type Palette } from "./contrast";
import {
  BASE_TOKENS, baseOf, DEFAULT_OWN, expandBase, OPTIONAL_TOKENS, OWN, POCKET_THEMES, type BaseColors, type OwnPalette, type Scheme, type ThemeGroup,
} from "./palettes";

export type { OwnPalette, Scheme };

export interface Theme {
  id: string;
  name: string;
  /** The scheme it is drawn in ("system" follows the device instead). */
  scheme: Scheme;
  group: ThemeGroup;
  /** CodeEditor's own palettes, whose colours are in tokens.css. */
  own?: OwnPalette;
  /** A palette theme's base colours (Pocket Run's format); undefined for the own palettes. */
  base?: BaseColors;
  /** Follows the device's light/dark setting. */
  system?: boolean;
  custom?: boolean;
}

export const DEFAULT_THEME_ID = "signal";
/**
 * "CodeEditor Deep Field (match device)", the default from 2026-10-18 until Signal (2026-10-25). A
 * device that kept it is moved to Signal once (storedThemeId); chosen again after that, it stays.
 */
export const DEEP_FIELD_SYSTEM_ID = "deep-field";
/**
 * "CodeEditor Slate (match device)". The id is historical: before Deep Field, "system" was the
 * default theme, so a device that saved it keeps Slate (an explicit choice is never re-pointed).
 */
export const SLATE_SYSTEM_ID = "system";

export const BUILT_IN: readonly Theme[] = [
  { id: DEFAULT_THEME_ID, name: "CodeEditor Signal (match device)", scheme: "light", group: "codeeditor", own: "signal", system: true },
  { id: "signal-light", name: "CodeEditor Signal Light", scheme: "light", group: "codeeditor", own: "signal" },
  { id: "signal-dark", name: "CodeEditor Signal Dark", scheme: "dark", group: "codeeditor", own: "signal" },
  { id: DEEP_FIELD_SYSTEM_ID, name: "CodeEditor Deep Field (match device)", scheme: "light", group: "codeeditor", own: "deep-field", system: true },
  { id: "deep-field-light", name: "CodeEditor Deep Field Light", scheme: "light", group: "codeeditor", own: "deep-field" },
  { id: "deep-field-dark", name: "CodeEditor Deep Field Dark", scheme: "dark", group: "codeeditor", own: "deep-field" },
  { id: SLATE_SYSTEM_ID, name: "CodeEditor Slate (match device)", scheme: "light", group: "codeeditor", own: "slate", system: true },
  { id: "slate-light", name: "CodeEditor Slate Light", scheme: "light", group: "codeeditor", own: "slate" },
  { id: "slate-dark", name: "CodeEditor Slate Dark", scheme: "dark", group: "codeeditor", own: "slate" },
  ...POCKET_THEMES,
];

// ---------------------------------------------------------------- colours of a theme

const cache = new Map<string, { palette: Palette; adjusted: ColorVar[] }>();

/** A palette theme's colours after the guard, plus what the guard moved. The own palettes are returned as designed. */
export function themePalette(theme: Theme, scheme: Scheme = theme.scheme): { palette: Palette; adjusted: ColorVar[] } {
  if (!theme.base) return { palette: { ...OWN[theme.own ?? DEFAULT_OWN][scheme] }, adjusted: [] };
  const key = theme.custom ? null : theme.id;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return { palette: { ...hit.palette }, adjusted: [...hit.adjusted] };
  // A moved Run fill or label changes what is derived from them (hover fill, selection band,
  // location and link): derive again from the moved values until they settle.
  let base = theme.base;
  let result = readablePalette(expandBase(base));
  const adjusted = new Set(result.adjusted);
  for (let round = 0; round < 4; round++) {
    const { action, "on-action": label } = result.palette;
    if (action === base.accent && label === base["on-accent"]) break;
    base = { ...base, accent: action, "on-accent": label };
    result = readablePalette(expandBase(base));
    for (const v of result.adjusted) adjusted.add(v);
  }
  result = { palette: result.palette, adjusted: [...adjusted] };
  if (key) cache.set(key, result);
  return { palette: { ...result.palette }, adjusted: [...result.adjusted] };
}

// ---------------------------------------------------------------- custom themes from a file

export const MAX_THEME_BYTES = 16 * 1024;
export const MAX_CUSTOM_THEMES = 8;

export type Parsed = { ok: true; theme: Theme; adjusted: ColorVar[] } | { ok: false; error: string };

/**
 * Reads a theme file: Pocket Run's format (name, scheme, 16 colours), plus optional CodeEditor
 * syntax colours. Only #rrggbb values for known names are accepted: no CSS, no URLs, no script.
 */
export function parseThemeFile(bytes: Uint8Array): Parsed {
  if (bytes.length > MAX_THEME_BYTES) return { ok: false, error: `A theme file is at most ${MAX_THEME_BYTES / 1024} KB; this one is bigger.` };
  const text = checkBytes(bytes);
  if (!text.ok) return { ok: false, error: `This isn't a theme file: ${text.reason}.` };
  if (text.hidden) return { ok: false, error: "This theme file contains invisible characters." };
  let data: unknown;
  try {
    data = JSON.parse(text.text);
  } catch {
    return { ok: false, error: "This isn't a theme file: it isn't valid JSON." };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, error: "This isn't a theme file." };
  const d = data as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => !["name", "scheme", "colors"].includes(k));
  // Keys are repeated in the message: JSON escapes can carry direction characters past checkBytes.
  if (extra.length) return { ok: false, error: `Unknown setting in the theme file: ${extra.slice(0, 3).map(shown).join(", ")}.` };
  if (typeof d.name !== "string" || !d.name.trim()) return { ok: false, error: 'The theme needs a "name".' };
  const name = d.name.replace(/[^\p{L}\p{N} ._'()&+-]/gu, "").trim().slice(0, 40);
  if (!name) return { ok: false, error: "The theme's name has no letters or digits." };
  if (d.scheme !== "light" && d.scheme !== "dark") return { ok: false, error: '"scheme" must be "light" or "dark".' };
  if (typeof d.colors !== "object" || d.colors === null || Array.isArray(d.colors)) return { ok: false, error: 'The theme needs "colors".' };
  const given = d.colors as Record<string, unknown>;
  const known: readonly string[] = [...BASE_TOKENS, ...OPTIONAL_TOKENS];
  const unknown = Object.keys(given).filter((k) => !known.includes(k));
  if (unknown.length) return { ok: false, error: `Unknown colour name: ${unknown.slice(0, 3).map(shown).join(", ")}.` };
  const missing = BASE_TOKENS.filter((t) => !(t in given));
  if (missing.length) return { ok: false, error: `Missing colours: ${missing.join(", ")}.` };
  const bad = Object.keys(given).filter((t) => typeof given[t] !== "string" || !HEX.test(given[t] as string));
  if (bad.length) return { ok: false, error: `These must be colours like "#1e1e2e": ${bad.join(", ")}.` };
  const base = Object.fromEntries(Object.keys(given).map((t) => [t, (given[t] as string).toLowerCase()])) as BaseColors;
  const theme: Theme = { id: `custom:${name.toLowerCase()}`, name, scheme: d.scheme, group: "yours", base, custom: true };
  return { ok: true, theme, adjusted: themePalette(theme).adjusted };
}

/** A theme file for the given colours: a starting point for making your own. */
export function themeTemplate(name: string, scheme: Scheme, palette: Palette): string {
  return JSON.stringify({ name, scheme, colors: baseOf(palette) }, null, 2) + "\n";
}

// ---------------------------------------------------------------- the chosen theme, kept on this device

export const CHOSEN_KEY = "codeeditor:theme";
export const CUSTOM_KEY = "codeeditor:custom-themes";
/** Read by public/theme-boot.js, so the theme is painted before any module loads. */
export const PAINT_KEY = "codeeditor:theme-paint";
/**
 * Set to DEFAULT_THEME_ID by the one-time move (storedThemeId) and by every choice (chooseTheme): a
 * saved Deep Field "match device" is then the student's own choice. Read by public/theme-boot.js
 * too: until it is set, the old default's paint is painted as Signal already.
 */
export const DEFAULT_SEEN_KEY = "codeeditor:theme-default";

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage blocked: the choice lasts for this visit only
    }
  },
};

/** Custom themes saved on this device, re-validated on every read in case storage was edited. */
export function customThemes(): Theme[] {
  try {
    const list = JSON.parse(storage.get(CUSTOM_KEY) ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .flatMap((item) => {
        const parsed = parseThemeFile(new TextEncoder().encode(JSON.stringify(item)));
        return parsed.ok ? [parsed.theme] : [];
      })
      .slice(0, MAX_CUSTOM_THEMES);
  } catch {
    return [];
  }
}

const stored = (t: Theme) => ({ name: t.name, scheme: t.scheme, colors: t.base });

export function saveCustomTheme(theme: Theme): { ok: true } | { ok: false; error: string } {
  const others = customThemes().filter((t) => t.id !== theme.id);
  if (others.length >= MAX_CUSTOM_THEMES) return { ok: false, error: `You can keep up to ${MAX_CUSTOM_THEMES} themes. Delete one first.` };
  storage.set(CUSTOM_KEY, JSON.stringify([...others, theme].map(stored)));
  return { ok: true };
}

export function deleteCustomTheme(id: string): void {
  storage.set(CUSTOM_KEY, JSON.stringify(customThemes().filter((t) => t.id !== id).map(stored)));
}

export function allThemes(): Theme[] {
  return [...BUILT_IN, ...customThemes()];
}

export const defaultTheme = (): Theme => BUILT_IN.find((t) => t.id === DEFAULT_THEME_ID)!;

/**
 * The saved theme's id. A Deep Field "match device" saved by a build from before Signal (the
 * default then) becomes Signal, once (the owner's call, 2026-10-25): the move marks the device, and
 * so does every choice made in this build (chooseTheme), so a Deep Field "match device" chosen since
 * stays. Deep Field's fixed light and dark, and every other saved theme, were explicit choices and
 * stay. Nothing is written for a device with nothing to move.
 */
function storedThemeId(): string | null {
  const id = storage.get(CHOSEN_KEY);
  if (id !== DEEP_FIELD_SYSTEM_ID || storage.get(DEFAULT_SEEN_KEY) === DEFAULT_THEME_ID) return id;
  storage.set(CHOSEN_KEY, DEFAULT_THEME_ID);
  storage.set(DEFAULT_SEEN_KEY, DEFAULT_THEME_ID);
  return DEFAULT_THEME_ID;
}

export function chosenTheme(): Theme {
  const id = storedThemeId() ?? DEFAULT_THEME_ID;
  return allThemes().find((t) => t.id === id) ?? defaultTheme();
}

const prefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** The scheme a theme is drawn in right now. */
export function activeScheme(theme: Theme): Scheme {
  return theme.system ? (prefersDark() ? "dark" : "light") : theme.scheme;
}

/** What theme-boot.js needs to paint a theme before the app loads. */
export interface Paint {
  system: boolean;
  scheme: Scheme;
  /** Which colours: one of the own palettes in tokens.css, or a palette theme's inline colours. */
  palette: OwnPalette | "palette";
  /** Inline colours for palette themes; null for the own palettes (tokens.css has them). */
  colors: Palette | null;
}

export function paintFor(theme: Theme): Paint {
  const scheme = activeScheme(theme);
  const system = Boolean(theme.system);
  if (theme.base) return { system, scheme, palette: "palette", colors: themePalette(theme).palette };
  return { system, scheme, palette: theme.own ?? DEFAULT_OWN, colors: null };
}

/**
 * Paints a theme. data-theme picks light or dark; data-palette picks Signal's or Slate's block in
 * tokens.css ("signal", "slate") or marks a palette theme ("palette"), and is absent for Deep Field
 * (tokens.css :root); palette themes set every colour inline, each value checked first.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const paint = paintFor(theme);
  for (const v of COLOR_VARS) root.style.removeProperty(`--${v}`);
  root.dataset.theme = paint.scheme;
  root.dataset.themeId = theme.id;
  if (paint.palette === "deep-field") delete root.dataset.palette;
  else root.dataset.palette = paint.palette;
  if (paint.colors) for (const v of COLOR_VARS) if (isTokenValue(v, paint.colors[v])) root.style.setProperty(`--${v}`, paint.colors[v]);
  // The browser's toolbar colour: per scheme for "match device", the theme's own chrome otherwise.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes("dark") ? "dark" : "light";
    const own = OWN[paint.palette === "palette" ? DEFAULT_OWN : paint.palette];
    meta.content = paint.colors ? paint.colors.surface : own[paint.system ? scheme : paint.scheme].surface;
  }
  storage.set(PAINT_KEY, JSON.stringify(paint));
}

export function chooseTheme(theme: Theme): void {
  storage.set(CHOSEN_KEY, theme.id);
  // Chosen in a build whose default is Signal: never moved (storedThemeId, theme-boot.js).
  storage.set(DEFAULT_SEEN_KEY, DEFAULT_THEME_ID);
  applyTheme(theme);
}

/** Keeps "match device" in step with the system's light/dark setting. */
export function followDevice(): void {
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const theme = chosenTheme();
    if (theme.system) applyTheme(theme);
  });
}
