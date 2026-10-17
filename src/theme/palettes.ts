// Colour palettes. "CodeEditor Slate" is the app's own theme (Slate and Signal); tokens.css paints the
// same values before any script runs (a test keeps the two equal).
//
// The other palettes are Pocket Run's editor themes (its src/themes.ts, same author, MIT), kept as
// their 16 base colours and expanded onto CodeEditor's variable contract
// by expandBase() below. Palette sources, as Pocket Run recorded them (fetched 2026-10-10/12):
//   Tokyo Night       github.com/folke/tokyonight.nvim extras (Apache-2.0)
//   Catppuccin        github.com/catppuccin/palette (MIT)
//   Dracula           draculatheme.com/spec (MIT)
//   GitHub-style      github.com/primer/github-vscode-theme v6.3.5 (MIT)
//   One Dark Pro      github.com/Binaryify/OneDark-Pro (MIT)
//   Rose Pine         github.com/rose-pine/rose-pine-palette and rose-pine/vscode (MIT)
//   Nord              github.com/nordtheme/nord and nordtheme/visual-studio-code (MIT)
//   Gruvbox           github.com/morhetz/gruvbox, gruvbox-community/gruvbox (MIT)
//   Kanagawa          github.com/rebelot/kanagawa.nvim (MIT)
//   Everforest        github.com/sainnhe/everforest (MIT)
//   Ayu               github.com/ayu-theme/vscode-ayu (MIT)
//   Night Owl         github.com/sdras/night-owl-vscode-theme (MIT)
//   Solarized         ethanschoonover.com/solarized, altercation/vim-colors-solarized (MIT)
// Where an official colour misses a contrast pair, readablePalette() lifts it at run time.

import { lift, luminance, over, type Palette } from "./contrast";

export type Scheme = "light" | "dark";

/** CodeEditor Slate, light and dark. */
export const SLATE: Record<Scheme, Palette> = {
  light: {
    bg: "#fdfdff", surface: "#f6f8fa", "surface-raised": "#eff1f5", border: "#d6dbe3", "border-strong": "#79818d",
    text: "#1a2029", "text-muted": "#545b67", "gutter-text": "#6a727f",
    accent: "#0062d4", "accent-hover": "#0052b4", "on-accent": "#ffffff", "accent-ink": "#0062d4", focus: "#0062d4",
    danger: "#be2323", warning: "#915b00", success: "#0a7e3a",
    selection: "#d6e8ff", "active-line": "#f0f4fa", "terminal-bg": "#fdfdff", "terminal-fg": "#1a2029",
    "syn-keyword": "#7334a9", "syn-string": "#207029", "syn-number": "#974c00", "syn-comment": "#5c646f",
    "syn-function": "#005da1", "syn-type": "#7b5600", "syn-variable": "#232933", "syn-operator": "#246876",
    "syn-macro": "#9d2962", "syn-punctuation": "#5e646c",
  },
  dark: {
    bg: "#0e1217", surface: "#14171d", "surface-raised": "#1b1f27", border: "#313740", "border-strong": "#676f7c",
    text: "#e9ebef", "text-muted": "#abb1bc", "gutter-text": "#858d99",
    accent: "#60a7ff", "accent-hover": "#85baff", "on-accent": "#0e1217", "accent-ink": "#60a7ff", focus: "#60a7ff",
    danger: "#f97770", warning: "#f3b94c", success: "#64cf80",
    selection: "#193a62", "active-line": "#171c23", "terminal-bg": "#0b0e14", "terminal-fg": "#e9ebef",
    "syn-keyword": "#c49bf3", "syn-string": "#90d281", "syn-number": "#f6ab6b", "syn-comment": "#a1acbb",
    "syn-function": "#71bfff", "syn-type": "#e9c769", "syn-variable": "#dadee5", "syn-operator": "#91c8d6",
    "syn-macro": "#ea91bc", "syn-punctuation": "#a5abb5",
  },
};

/** Pocket Run's theme-file colours (a Pocket Run theme file loads here unchanged). */
export const BASE_TOKENS = [
  "paper", "sheet", "bar", "ink", "muted", "rule", "accent", "on-accent", "ok", "err", "warn",
  "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-def",
] as const;
export type BaseToken = (typeof BASE_TOKENS)[number];
/** Syntax colours a CodeEditor theme file may set too; otherwise they are derived. */
export const OPTIONAL_TOKENS = ["syn-type", "syn-variable", "syn-operator", "syn-macro", "syn-punctuation"] as const;
export type OptionalToken = (typeof OPTIONAL_TOKENS)[number];
export type BaseColors = Record<BaseToken, string> & Partial<Record<OptionalToken, string>>;

const b = (
  paper: string, sheet: string, bar: string, ink: string, muted: string, rule: string,
  accent: string, onAccent: string, ok: string, err: string, warn: string,
  keyword: string, string: string, number: string, comment: string, def: string,
): BaseColors => ({
  paper, sheet, bar, ink, muted, rule, accent, "on-accent": onAccent, ok, err, warn,
  "syn-keyword": keyword, "syn-string": string, "syn-number": number, "syn-comment": comment, "syn-def": def,
});

export type ThemeGroup = "codeeditor" | "popular" | "more" | "yours";

export interface PaletteTheme {
  id: string;
  name: string;
  scheme: Scheme;
  group: ThemeGroup;
  base: BaseColors;
}

export const POCKET_THEMES: readonly PaletteTheme[] = [
  { id: "high-contrast", name: "High contrast", scheme: "dark", group: "codeeditor", base: b("#050608", "#0a0c10", "#14171d", "#f7f9fb", "#c9d1db", "#5c6672", "#ffd60a", "#0a0c10", "#4ade80", "#ff8080", "#ffd60a", "#ff9ff3", "#fde68a", "#7dd3fc", "#b8c2cc", "#67e8f9") },
  { id: "github-dark", name: "GitHub-style Dark", scheme: "dark", group: "popular", base: b("#010409", "#0d1117", "#161b22", "#e6edf3", "#7d8590", "#30363d", "#238636", "#ffffff", "#3fb950", "#f85149", "#d29922", "#ff7b72", "#a5d6ff", "#79c0ff", "#8b949e", "#d2a8ff") },
  { id: "github-light", name: "GitHub-style Light", scheme: "light", group: "popular", base: b("#f6f8fa", "#ffffff", "#f6f8fa", "#1f2328", "#656d76", "#d0d7de", "#1f883d", "#ffffff", "#1a7f37", "#cf222e", "#9a6700", "#cf222e", "#0a3069", "#0550ae", "#6e7781", "#8250df") },
  { id: "one-dark-pro", name: "One Dark Pro", scheme: "dark", group: "popular", base: b("#21252b", "#282c34", "#1d1f23", "#abb2bf", "#7f848e", "#3e4452", "#61afef", "#282c34", "#8cc265", "#c24038", "#d19a66", "#c678dd", "#98c379", "#d19a66", "#7f848e", "#61afef") },
  { id: "dracula", name: "Dracula", scheme: "dark", group: "popular", base: b("#21222c", "#282a36", "#343746", "#f8f8f2", "#6272a4", "#44475a", "#bd93f9", "#282a36", "#50fa7b", "#ff5555", "#ffb86c", "#ff79c6", "#f1fa8c", "#ffb86c", "#6272a4", "#50fa7b") },
  { id: "tokyo-night", name: "Tokyo Night", scheme: "dark", group: "popular", base: b("#16161e", "#1a1b26", "#292e42", "#c0caf5", "#a9b1d6", "#3b4261", "#7aa2f7", "#1a1b26", "#9ece6a", "#db4b4b", "#e0af68", "#9d7cd8", "#9ece6a", "#ff9e64", "#565f89", "#7aa2f7") },
  { id: "tokyo-night-day", name: "Tokyo Night Day", scheme: "light", group: "popular", base: b("#d0d5e3", "#e1e2e7", "#c4c8da", "#3760bf", "#6172b0", "#a8aecb", "#2e7de9", "#e1e2e7", "#587539", "#c64343", "#8c6c3e", "#7847bd", "#587539", "#b15c00", "#848cb5", "#2e7de9") },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", scheme: "dark", group: "popular", base: b("#11111b", "#1e1e2e", "#181825", "#cdd6f4", "#a6adc8", "#313244", "#cba6f7", "#11111b", "#a6e3a1", "#f38ba8", "#f9e2af", "#cba6f7", "#a6e3a1", "#fab387", "#9399b2", "#89b4fa") },
  { id: "catppuccin-latte", name: "Catppuccin Latte", scheme: "light", group: "popular", base: b("#dce0e8", "#eff1f5", "#e6e9ef", "#4c4f69", "#6c6f85", "#ccd0da", "#8839ef", "#eff1f5", "#40a02b", "#d20f39", "#df8e1d", "#8839ef", "#40a02b", "#fe640b", "#7c7f93", "#1e66f5") },
  { id: "rose-pine", name: "Rose Pine", scheme: "dark", group: "more", base: b("#191724", "#191724", "#1f1d2e", "#e0def4", "#908caa", "#403d52", "#ebbcba", "#191724", "#9ccfd8", "#eb6f92", "#f6c177", "#31748f", "#f6c177", "#ebbcba", "#6e6a86", "#ebbcba") },
  { id: "rose-pine-dawn", name: "Rose Pine Dawn", scheme: "light", group: "more", base: b("#faf4ed", "#faf4ed", "#fffaf3", "#464261", "#797593", "#dfdad9", "#d7827e", "#faf4ed", "#56949f", "#b4637a", "#ea9d34", "#286983", "#ea9d34", "#d7827e", "#9893a5", "#d7827e") },
  { id: "nord", name: "Nord", scheme: "dark", group: "more", base: b("#2e3440", "#2e3440", "#3b4252", "#d8dee9", "#616e88", "#4c566a", "#88c0d0", "#2e3440", "#a3be8c", "#bf616a", "#ebcb8b", "#81a1c1", "#a3be8c", "#b48ead", "#616e88", "#88c0d0") },
  { id: "gruvbox-dark", name: "Gruvbox Dark", scheme: "dark", group: "more", base: b("#1d2021", "#282828", "#3c3836", "#ebdbb2", "#a89984", "#504945", "#fe8019", "#282828", "#b8bb26", "#fb4934", "#fabd2f", "#fb4934", "#b8bb26", "#d3869b", "#928374", "#b8bb26") },
  { id: "gruvbox-light", name: "Gruvbox Light", scheme: "light", group: "more", base: b("#f9f5d7", "#fbf1c7", "#ebdbb2", "#3c3836", "#7c6f64", "#d5c4a1", "#af3a03", "#fbf1c7", "#79740e", "#9d0006", "#b57614", "#9d0006", "#79740e", "#8f3f71", "#928374", "#79740e") },
  { id: "kanagawa", name: "Kanagawa", scheme: "dark", group: "more", base: b("#16161d", "#1f1f28", "#2a2a37", "#dcd7ba", "#c8c093", "#363646", "#7e9cd8", "#16161d", "#98bb6c", "#e82424", "#ff9e3b", "#957fb8", "#98bb6c", "#d27e99", "#727169", "#7e9cd8") },
  { id: "everforest-dark", name: "Everforest Dark", scheme: "dark", group: "more", base: b("#232a2e", "#2d353b", "#343f44", "#d3c6aa", "#9da9a0", "#4f585e", "#a7c080", "#2d353b", "#a7c080", "#e67e80", "#dbbc7f", "#e67e80", "#a7c080", "#d699b6", "#859289", "#a7c080") },
  { id: "ayu-dark", name: "Ayu Dark", scheme: "dark", group: "more", base: b("#0d1017", "#10141c", "#141821", "#bfbdb6", "#5a6378", "#1b1f29", "#e6b450", "#765b24", "#70bf56", "#d95757", "#e6b450", "#ff8f40", "#aad94c", "#d2a6ff", "#5a6673", "#ffb454") },
  { id: "ayu-mirage", name: "Ayu Mirage", scheme: "dark", group: "more", base: b("#1f2430", "#242936", "#282e3b", "#cccac2", "#707a8c", "#171b24", "#ffcc66", "#735923", "#87d96c", "#ff6666", "#ffcc66", "#ffa659", "#d5ff80", "#dfbfff", "#6e7c8f", "#ffcd66") },
  { id: "night-owl", name: "Night Owl", scheme: "dark", group: "more", base: b("#011627", "#011627", "#0b2942", "#d6deeb", "#89a4bb", "#5f7e97", "#7e57c2", "#ffffff", "#22da6e", "#ef5350", "#ffeb95", "#c792ea", "#ecc48d", "#f78c6c", "#637777", "#82aaff") },
  { id: "solarized-dark", name: "Solarized Dark", scheme: "dark", group: "more", base: b("#002b36", "#002b36", "#073642", "#839496", "#586e75", "#073642", "#268bd2", "#002b36", "#859900", "#dc322f", "#b58900", "#859900", "#2aa198", "#2aa198", "#586e75", "#268bd2") },
  { id: "solarized-light", name: "Solarized Light", scheme: "light", group: "more", base: b("#fdf6e3", "#fdf6e3", "#eee8d5", "#657b83", "#93a1a1", "#eee8d5", "#268bd2", "#002b36", "#859900", "#dc322f", "#b58900", "#859900", "#2aa198", "#2aa198", "#93a1a1", "#268bd2") },
];

/**
 * Maps Pocket Run's 16 colours onto CodeEditor's contract. Pocket Run's "sheet" is the editor
 * (CodeEditor's --bg), "paper" the page behind it (the sidebar here), "bar" its header strips.
 * The colours Pocket Run doesn't have are derived the way CSS color-mix() would (over()):
 *   accent-hover   accent moved 15% away from its label (darker under a white label, lighter under a dark one)
 *   selection      18% accent over the editor; active-line 4% text over the editor
 *   border-strong  80% muted over the editor, lifted to 3:1
 *   syn-function   = syn-def (Pocket Run colours calls and definitions with it)
 *   syn-type/macro = syn-keyword (most of these themes colour int/char and #include like keywords)
 *   syn-variable/operator = text, syn-punctuation = muted
 * readablePalette() then lifts anything still under its contrast pair.
 */
export function expandBase(base: BaseColors): Palette {
  const bg = base.sheet;
  return {
    bg,
    surface: base.paper,
    "surface-raised": base.bar,
    border: base.rule,
    "border-strong": lift(over(bg, base.muted, 0.8), [bg, base.paper, base.bar], 3),
    text: base.ink,
    "text-muted": base.muted,
    "gutter-text": base.muted,
    accent: base.accent,
    // Away from the label, so the hovered Run button reads at least as well as the resting one.
    "accent-hover": over(base.accent, luminance(base["on-accent"]) > 0.18 ? "#000000" : "#ffffff", 0.15),
    "on-accent": base["on-accent"],
    "accent-ink": base.accent,
    focus: base.accent,
    danger: base.err,
    warning: base.warn,
    success: base.ok,
    selection: over(bg, base.accent, 0.18),
    "active-line": over(bg, base.ink, 0.04),
    "terminal-bg": bg,
    "terminal-fg": base.ink,
    "syn-keyword": base["syn-keyword"],
    "syn-string": base["syn-string"],
    "syn-number": base["syn-number"],
    "syn-comment": base["syn-comment"],
    "syn-function": base["syn-def"],
    "syn-type": base["syn-type"] ?? base["syn-keyword"],
    "syn-variable": base["syn-variable"] ?? base.ink,
    "syn-operator": base["syn-operator"] ?? base.ink,
    "syn-macro": base["syn-macro"] ?? base["syn-keyword"],
    "syn-punctuation": base["syn-punctuation"] ?? base.muted,
  };
}

/** The other way round, for "Get template": a theme file that reproduces `p`. */
export function baseOf(p: Palette): BaseColors {
  return {
    paper: p.surface, sheet: p.bg, bar: p["surface-raised"], ink: p.text, muted: p["text-muted"], rule: p.border,
    accent: p.accent, "on-accent": p["on-accent"], ok: p.success, err: p.danger, warn: p.warning,
    "syn-keyword": p["syn-keyword"], "syn-string": p["syn-string"], "syn-number": p["syn-number"],
    "syn-comment": p["syn-comment"], "syn-def": p["syn-function"],
    "syn-type": p["syn-type"], "syn-variable": p["syn-variable"], "syn-operator": p["syn-operator"],
    "syn-macro": p["syn-macro"], "syn-punctuation": p["syn-punctuation"],
  };
}
