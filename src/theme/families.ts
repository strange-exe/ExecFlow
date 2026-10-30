// The theme picker's model (Workbench Pro S4): the 45 built-in themes as 22 families, each with its
// variants (Light, Dark, Match device, or a variant's own name such as Mocha), the curated first
// row, search and the Light/Dark filter, and the code preview drawn in a theme's own colours. Pure
// data and functions: theme-picker.ts draws it; families.test.ts checks it, including the preview's
// contrast in every palette.
import type { ColorVar } from "./contrast";
import type { Theme } from "./themes";

export interface Variant {
  /** The theme's id: the radio's value and the stored choice (themes.ts CHOSEN_KEY), never changed here. */
  id: string;
  /** What the variant's button shows. */
  label: string;
}

export interface Family {
  id: string;
  name: string;
  variants: readonly Variant[];
  custom?: boolean;
}

const f = (id: string, name: string, ...variants: [string, string][]): Family => ({
  id,
  name,
  variants: variants.map(([vid, label]) => ({ id: vid, label })),
});

/**
 * Every built-in theme, in exactly one family (families.test.ts). A variant's label is the part of
 * its theme's name after the family's, or its scheme for a family of one. Where the theme's name has
 * no such part, the label is the variant's name in its own project: Tokyo Night's "night" style,
 * Rose Pine's "main" and Kanagawa's "wave" variants.
 */
export const FAMILIES: readonly Family[] = [
  f("signal", "CodeEditor Signal", ["signal", "Match device"], ["signal-light", "Light"], ["signal-dark", "Dark"]),
  f("deep-field", "CodeEditor Deep Field", ["deep-field", "Match device"], ["deep-field-light", "Light"], ["deep-field-dark", "Dark"]),
  f("slate", "CodeEditor Slate", ["system", "Match device"], ["slate-light", "Light"], ["slate-dark", "Dark"]),
  f("high-contrast", "High contrast", ["high-contrast", "Dark"]),
  f("github", "GitHub-style", ["github-light", "Light"], ["github-dark", "Dark"]),
  f("one-dark-pro", "One Dark Pro", ["one-dark-pro", "Dark"]),
  f("dracula", "Dracula", ["dracula", "Dark"]),
  f("tokyo-night", "Tokyo Night", ["tokyo-night", "Night"], ["tokyo-night-storm", "Storm"], ["tokyo-night-day", "Day"]),
  f("catppuccin", "Catppuccin", ["catppuccin-mocha", "Mocha"], ["catppuccin-macchiato", "Macchiato"], ["catppuccin-frappe", "Frappe"], ["catppuccin-latte", "Latte"]),
  f("rose-pine", "Rose Pine", ["rose-pine", "Main"], ["rose-pine-moon", "Moon"], ["rose-pine-dawn", "Dawn"]),
  f("nord", "Nord", ["nord", "Dark"]),
  f("gruvbox", "Gruvbox", ["gruvbox-dark", "Dark"], ["gruvbox-light", "Light"]),
  f("kanagawa", "Kanagawa", ["kanagawa", "Wave"], ["kanagawa-dragon", "Dragon"], ["kanagawa-lotus", "Lotus"]),
  f("everforest", "Everforest", ["everforest-dark", "Dark"], ["everforest-light", "Light"]),
  f("ayu", "Ayu", ["ayu-dark", "Dark"], ["ayu-mirage", "Mirage"], ["ayu-light", "Light"]),
  f("night-owl", "Night Owl", ["night-owl", "Dark"]),
  f("solarized", "Solarized", ["solarized-dark", "Dark"], ["solarized-light", "Light"]),
  f("vesper", "Vesper", ["vesper", "Dark"]),
  f("poimandres", "Poimandres", ["poimandres", "Dark"]),
  f("vitesse", "Vitesse", ["vitesse-dark", "Dark"], ["vitesse-light", "Light"]),
  f("flexoki", "Flexoki", ["flexoki-dark", "Dark"], ["flexoki-light", "Light"]),
  f("nightfox", "Nightfox", ["nightfox", "Dark"]),
];

/**
 * "Start here": the default, Slate (v1's own), High contrast, and three widely used editor families
 * with light and dark variants (the redesign4 picker study's first row). The rest follow A to Z.
 */
export const CURATED: readonly string[] = ["signal", "slate", "high-contrast", "github", "tokyo-night", "catppuccin"];

/** The families after the curated row, by name. */
export function otherFamilies(): Family[] {
  return FAMILIES.filter((fam) => !CURATED.includes(fam.id)).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function curatedFamilies(): Family[] {
  return CURATED.map((id) => FAMILIES.find((fam) => fam.id === id)!);
}

/** A theme loaded from a file is a family of one, under "Yours". */
export function customFamily(theme: Theme): Family {
  return { id: theme.id, name: theme.name, variants: [{ id: theme.id, label: theme.scheme === "dark" ? "Dark" : "Light" }], custom: true };
}

/**
 * The radio's accessible name: the theme's own name (what Settings always said), with the button's
 * visible label added when the name doesn't hold it (WCAG 2.5.3 Label in Name): "Dracula, Dark",
 * "Kanagawa, Wave"; "CodeEditor Slate Dark" and "Catppuccin Mocha" stay as they are.
 */
export function variantName(theme: Pick<Theme, "name">, label: string): string {
  return theme.name.toLowerCase().includes(label.toLowerCase()) ? theme.name : `${theme.name}, ${label}`;
}

export type SchemeFilter = "all" | "light" | "dark";

/** Whether a variant is offered under the Light/Dark filter: "match device" is both. */
export function variantShown(theme: Pick<Theme, "scheme" | "system">, filter: SchemeFilter): boolean {
  return filter === "all" || Boolean(theme.system) || theme.scheme === filter;
}

/** Lower case, accents and punctuation folded to spaces, so "rose-pine" and "Rose Pine" meet. */
const fold = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().trim();

/** Whether a search matches a family: its name, a variant's label or a variant's theme name. Empty matches all. */
export function familyMatches(family: Family, themes: ReadonlyMap<string, Pick<Theme, "name">>, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const words = [family.name, ...family.variants.flatMap((v) => [v.label, themes.get(v.id)?.name ?? ""])].map(fold);
  return q.split(" ").every((part) => words.some((w) => w.includes(part)));
}

/** The family's schemes in words, under its name: "Dark", "Light and dark", "Light, dark, match device". */
export function schemesText(themes: readonly Pick<Theme, "scheme" | "system">[]): string {
  const light = themes.some((t) => !t.system && t.scheme === "light");
  const dark = themes.some((t) => !t.system && t.scheme === "dark");
  const device = themes.some((t) => t.system);
  const words = [light && "light", dark && "dark", device && "match device"].filter(Boolean) as string[];
  const text = words.length === 3 ? words.join(", ") : words.join(" and ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- the preview

/** The roles the preview draws, each a colour of the theme's own. */
export type PreviewRole =
  | "text" | "gutter" | "keyword" | "string" | "number" | "comment" | "function"
  | "type" | "variable" | "operator" | "macro" | "punctuation";

export const PREVIEW_COLORS: Readonly<Record<PreviewRole, ColorVar>> = {
  text: "text",
  gutter: "gutter-text",
  keyword: "syn-keyword",
  string: "syn-string",
  number: "syn-number",
  comment: "syn-comment",
  function: "syn-function",
  type: "syn-type",
  variable: "syn-variable",
  operator: "syn-operator",
  macro: "syn-macro",
  punctuation: "syn-punctuation",
};

export interface PreviewLine {
  /** The failed line: drawn on the theme's error band with its danger mark. */
  failed?: boolean;
  parts: readonly (readonly [PreviewRole, string])[];
}

const sp = (n = 1) => ["text", " ".repeat(n)] as const;

/**
 * Six lines of C that hold every syntax colour the editor paints, the fifth the line a run failed on
 * (a division by zero when n is 0). Spaces are plain text.
 */
export const PREVIEW_LINES: readonly PreviewLine[] = [
  { parts: [["macro", "#define"], sp(), ["variable", "MAX"], sp(), ["number", "3"], sp(2), ["comment", "// cap"]] },
  { parts: [["type", "int"], sp(), ["function", "avg"], ["punctuation", "("], ["type", "int"], sp(), ["operator", "*"], ["variable", "m"], ["punctuation", ","], sp(), ["type", "int"], sp(), ["variable", "n"], ["punctuation", ")"], sp(), ["punctuation", "{"]] },
  { parts: [sp(2), ["keyword", "if"], sp(), ["punctuation", "("], ["variable", "n"], sp(), ["operator", ">"], sp(), ["variable", "MAX"], ["punctuation", ")"], sp(), ["keyword", "return"], sp(), ["number", "0"], ["punctuation", ";"]] },
  { parts: [sp(2), ["function", "printf"], ["punctuation", "("], ["string", '"%d"'], ["punctuation", ","], sp(), ["variable", "n"], ["punctuation", ")"], ["punctuation", ";"]] },
  { failed: true, parts: [sp(2), ["keyword", "return"], sp(), ["variable", "m"], ["punctuation", "["], ["number", "0"], ["punctuation", "]"], sp(), ["operator", "/"], sp(), ["variable", "n"], ["punctuation", ";"]] },
  { parts: [["punctuation", "}"]] },
];
