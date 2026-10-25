// Colour palettes on token contract v2 (src/theme/contrast.ts COLOR_VARS). CodeEditor's own three
// palettes, Signal (the default since 2026-10-25), Deep Field (the default before it) and Slate, are
// painted by tokens.css before any script runs (a unit test keeps the two files equal); all three
// pass every pair as designed, so the guard never moves them.
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
// Added in CodeEditor, in the same 16-colour format and the same role mapping as their family's
// existing entry (fetched 2026-10-23 from each repository's own palette file; licence read in its
// LICENSE file):
//   Tokyo Night Storm         folke/tokyonight.nvim lua/tokyonight/colors/storm.lua (Apache-2.0)
//   Catppuccin Macchiato, Frappe  catppuccin/palette palette.json (MIT)
//   Rose Pine Moon            rose-pine/rose-pine-palette source/index.ts (MIT)
//   Kanagawa Dragon, Lotus    rebelot/kanagawa.nvim lua/kanagawa/colors.lua and themes.lua (MIT)
//   Everforest Light          sainnhe/everforest autoload/everforest.vim, "medium" (MIT)
//   Ayu Light                 ayu-theme/vscode-ayu ayu-light.json (MIT)
//   Vesper                    raunofreiberg/vesper themes/Vesper-dark-color-theme.json (MIT)
//   Poimandres                drcmda/poimandres-theme themes/poimandres-color-theme.json (MIT)
//   Vitesse Dark, Light       antfu/vscode-theme-vitesse scripts/colors.ts (MIT)
//   Flexoki Dark, Light       kepano/flexoki vscode/Flexoki-*-color-theme.json (MIT)
//   Nightfox                  EdenEast/nightfox.nvim lua/nightfox/palette/nightfox.lua (MIT)
// The format holds opaque colours only, so a source colour with an alpha byte is stored as it paints
// over the ground its theme draws it on (over()): Ayu Light's border #6b7d8f1f on #fcfcfc is
// #eaedef; Vesper's comment #8b8b8b94 on #101010 is #575757; Poimandres' raised layer #30334080 and
// comment #767c9db0 on #1b1e28 are #262934 and #5a5f79; Vitesse Dark's text #dbd7caee, secondary
// text #dedcd590 and comment #758575dd on #121212 are #cecabe, #858480 and #687668; Vitesse Light's
// secondary text #393a3490 on #ffffff is #8f908c. Two picks where the source has no single colour:
// Poimandres' Run is its link and info blue #add7ff (its own button is a grey #303340) and its
// keywords are its storage blue #91b4d5 (plain keywords are body-text grey there); Nightfox's
// functions use blue #719cd6, the base its plugin brightens at run time.
// Where an official colour misses a contrast pair, readablePalette() lifts it at run time.

import { lift, luminance, over, type Palette, type Scheme } from "./contrast";

export type { Scheme };

/**
 * CodeEditor Signal, light and dark (redesign 2, option a "Slate Signal", chosen 2026-10-25): cool
 * slate neutrals with a surface ladder (the chrome on --surface, the code on a near-white or
 * near-black sheet), one electric blue for the action, the location bars and checked controls, and a
 * teal focus apart from it (the caret, the focus ring and typed input). Red marks errors only. The
 * values are the guard-checked ones (the design round's tuned.json): every pair passes as designed
 * and every distinctness rule and region step holds (separation "surface"). The four band tokens are
 * translucent (#rrggbbaa) so a selection shows through the cursor line and the error line.
 */
export const SIGNAL: Record<Scheme, Palette> = {
  light: {
    bg: "#fcfcfd", surface: "#edf0f3", "surface-raised": "#ffffff", "terminal-bg": "#eff1f4", "terminal-fg": "#14171c", "runlog-bg": "#e6e9ee", divider: "#d0d6de", border: "#d6dbe2", "border-strong": "#6e7682",
    text: "#14171c", "text-secondary": "#3a4049", "text-muted": "#4f5662", "gutter-text": "#5d646f",
    action: "#2f5bea", "action-hover": "#2449c4", "on-action": "#ffffff", "control-on": "#2f5bea",
    focus: "#0b6e80", selection: "#2f5bea2e", "list-selected": "#2f5bea1f", "active-line": "#14171c08", location: "#2f5bea",
    danger: "#9d2025", warning: "#935100", success: "#2d7737", info: "#0e7490",
    "error-band": "#e5484d30", "call-site": "#c4282e", "input-echo": "#0b6e80",
    link: "#2448c8", brand: "#14171c", "on-brand": "#ffffff",
    "syn-keyword": "#8b2a81", "syn-string": "#1c5e2e", "syn-number": "#8f3d0a", "syn-comment": "#4f565f", "syn-function": "#0d5c68",
    "syn-type": "#5a40a7", "syn-variable": "#1f242b", "syn-operator": "#4a5563", "syn-macro": "#96294e", "syn-punctuation": "#4c525c",
  },
  dark: {
    bg: "#0e1116", surface: "#151a21", "surface-raised": "#1d232c", "terminal-bg": "#050709", "terminal-fg": "#e6e9ee", "runlog-bg": "#121820", divider: "#2a313b", border: "#252c35", "border-strong": "#737d8b",
    text: "#e8ebf0", "text-secondary": "#b9c0ca", "text-muted": "#a3aab5", "gutter-text": "#9198a5",
    action: "#7ea2ff", "action-hover": "#9ab6ff", "on-action": "#0b1020", "control-on": "#7ea2ff",
    focus: "#4fd1df", selection: "#7ea2ff33", "list-selected": "#7ea2ff24", "active-line": "#e8ebf00a", location: "#7ea2ff",
    danger: "#ff7b7b", warning: "#f5a35c", success: "#6fd08c", info: "#5bc6d6",
    "error-band": "#ff5d6640", "call-site": "#ff7b7b", "input-echo": "#4fd1df",
    link: "#9ab6ff", brand: "#2a313b", "on-brand": "#e8ebf0",
    "syn-keyword": "#e896dc", "syn-string": "#8bd79a", "syn-number": "#f4a87a", "syn-comment": "#abb1ba", "syn-function": "#6fd3e0",
    "syn-type": "#bba8ff", "syn-variable": "#dce1e8", "syn-operator": "#aeb8c6", "syn-macro": "#ff9dbb", "syn-punctuation": "#acb3bd",
  },
};

/**
 * CodeEditor Deep Field, light and dark: three 12-step OKLCH scales per mode (sage-stone neutral,
 * spruce anchor, brass accent), gamut-mapped to sRGB. "Spruce is the product, brass is your hand,
 * red is an error": the action, location bars and links are spruce; focus, the caret, the text
 * selection and typed input are brass; red marks errors only. The four band tokens are translucent
 * (#rrggbbaa) so a selection shows through the cursor line and the error line.
 */
export const DEEP_FIELD: Record<Scheme, Palette> = {
  light: {
    bg: "#f8fbf9", surface: "#dbeee2", "surface-raised": "#fcfefd", "terminal-bg": "#e8f1ed", "terminal-fg": "#1f2421", "runlog-bg": "#f3f8f6", divider: "#adc0b4", border: "#c4d7cb", "border-strong": "#6d7a71",
    text: "#1f2421", "text-secondary": "#4b524d", "text-muted": "#565d58", "gutter-text": "#575e59",
    action: "#004f3a", "action-hover": "#00402f", "on-action": "#f8fbf9", "control-on": "#004f3a",
    focus: "#776100", selection: "#cdae5429", "list-selected": "#004f3a1c", "active-line": "#1f242108", location: "#004f3a",
    danger: "#ac262c", warning: "#a05300", success: "#377531", info: "#2a6d9c",
    "error-band": "#ff6e823b", "call-site": "#ac262c", "input-echo": "#776100",
    link: "#044a37", brand: "#adc0b4", "on-brand": "#1f2421",
    "syn-keyword": "#713882", "syn-string": "#2b652f", "syn-number": "#8d400c", "syn-comment": "#535b54", "syn-function": "#265496",
    "syn-type": "#066166", "syn-variable": "#272d29", "syn-operator": "#485966", "syn-macro": "#8f305a", "syn-punctuation": "#545b56",
  },
  dark: {
    bg: "#13201b", surface: "#152a22", "surface-raised": "#1e322a", "terminal-bg": "#0d1814", "terminal-fg": "#e9eae4", "runlog-bg": "#0d211a", divider: "#3b5047", border: "#2e423a", "border-strong": "#6d8178",
    text: "#e9eae4", "text-secondary": "#bdbfb8", "text-muted": "#abaea5", "gutter-text": "#999d95",
    action: "#b4dccb", "action-hover": "#caecde", "on-action": "#0d1814", "control-on": "#b4dccb",
    focus: "#e0c262", selection: "#b89c402b", "list-selected": "#b4dccb1c", "active-line": "#e9eae40a", location: "#b4dccb",
    danger: "#fc867f", warning: "#faa969", success: "#85cc7e", info: "#7eb8e6",
    "error-band": "#ba293b5c", "call-site": "#fc867f", "input-echo": "#e0c262",
    link: "#a8d7c4", brand: "#3b5047", "on-brand": "#e9eae4",
    "syn-keyword": "#d9a9e8", "syn-string": "#99d69a", "syn-number": "#f6ae86", "syn-comment": "#afb3a8", "syn-function": "#9cc4f8",
    "syn-type": "#8bd7da", "syn-variable": "#dfe0d9", "syn-operator": "#adc1cf", "syn-macro": "#f2a3c0", "syn-punctuation": "#b0b2aa",
  },
};

/**
 * CodeEditor Slate (v1's own theme, "Slate and Signal"), kept as a picker theme on contract v2.
 * Every v1 hex is kept where its role still exists (the azure Run, focus, links, location bars and
 * calls; the slate panels; its syntax colours). Forced changes only: a translucent active line (ink
 * at 3%, so a selection on the cursor line shows), the light Run label #fdfdff instead of pure
 * white, and its own error band (#be2323 at 14% light, a deeper red #ba293b at 36% dark). The new
 * roles follow expandBase()'s rules. Then the guard lifted what missed a pair on the new stacked
 * grounds, and the result is frozen here: light danger #be2323 to #a21e1e, gutter-text #6a727f to
 * #5a616c, and seven syntax colours by small steps (string, number, comment, function, type,
 * operator, punctuation); dark gutter-text #858d99 to #8b939e.
 */
export const SLATE: Record<Scheme, Palette> = {
  light: {
    bg: "#fdfdff", surface: "#f6f8fa", "surface-raised": "#eff1f5", "terminal-bg": "#fdfdff", "terminal-fg": "#1a2029", "runlog-bg": "#eff1f5", divider: "#d6dbe3", border: "#d6dbe3", "border-strong": "#79818d",
    text: "#1a2029", "text-secondary": "#373e48", "text-muted": "#545b67", "gutter-text": "#5a616c",
    action: "#0062d4", "action-hover": "#0052b4", "on-action": "#fdfdff", "control-on": "#0062d4",
    focus: "#0062d4", selection: "#d6e8ff", "list-selected": "#1a20291a", "active-line": "#1a202908", location: "#0062d4",
    danger: "#a21e1e", warning: "#915b00", success: "#0a7e3a", info: "#545b67",
    "error-band": "#be232324", "call-site": "#be2323", "input-echo": "#1a2029",
    link: "#0062d4", brand: "#1a2029", "on-brand": "#fdfdff",
    "syn-keyword": "#7334a9", "syn-string": "#1d6525", "syn-number": "#884400", "syn-comment": "#4e555e", "syn-function": "#005899",
    "syn-type": "#755200", "syn-variable": "#232933", "syn-operator": "#205e6a", "syn-macro": "#9d2962", "syn-punctuation": "#50555c",
  },
  dark: {
    bg: "#0e1217", surface: "#14171d", "surface-raised": "#1b1f27", "terminal-bg": "#0b0e14", "terminal-fg": "#e9ebef", "runlog-bg": "#1b1f27", divider: "#313740", border: "#313740", "border-strong": "#676f7c",
    text: "#e9ebef", "text-secondary": "#caced6", "text-muted": "#abb1bc", "gutter-text": "#8b939e",
    action: "#60a7ff", "action-hover": "#85baff", "on-action": "#0e1217", "control-on": "#60a7ff",
    focus: "#60a7ff", selection: "#193a62", "list-selected": "#e9ebef1a", "active-line": "#e9ebef08", location: "#60a7ff",
    danger: "#f97770", warning: "#f3b94c", success: "#64cf80", info: "#abb1bc",
    "error-band": "#ba293b5c", "call-site": "#f97770", "input-echo": "#e9ebef",
    link: "#60a7ff", brand: "#e9ebef", "on-brand": "#0e1217",
    "syn-keyword": "#c49bf3", "syn-string": "#90d281", "syn-number": "#f6ab6b", "syn-comment": "#a1acbb", "syn-function": "#71bfff",
    "syn-type": "#e9c769", "syn-variable": "#dadee5", "syn-operator": "#91c8d6", "syn-macro": "#ea91bc", "syn-punctuation": "#a5abb5",
  },
};

/** CodeEditor's own palettes (painted by tokens.css), by name. */
export type OwnPalette = "signal" | "deep-field" | "slate";
export const OWN: Record<OwnPalette, Record<Scheme, Palette>> = { signal: SIGNAL, "deep-field": DEEP_FIELD, slate: SLATE };
/**
 * The default theme's own palette (themes.ts DEFAULT_THEME_ID): what a palette theme with nothing
 * valid to paint falls back to, the Light and Dark that Capture snippet offers under a palette
 * theme, and Save as PDF's ink.
 */
export const DEFAULT_OWN: OwnPalette = "signal";

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
  { id: "tokyo-night-storm", name: "Tokyo Night Storm", scheme: "dark", group: "popular", base: b("#1f2335", "#24283b", "#292e42", "#c0caf5", "#a9b1d6", "#3b4261", "#7aa2f7", "#24283b", "#9ece6a", "#db4b4b", "#e0af68", "#9d7cd8", "#9ece6a", "#ff9e64", "#565f89", "#7aa2f7") },
  { id: "tokyo-night-day", name: "Tokyo Night Day", scheme: "light", group: "popular", base: b("#d0d5e3", "#e1e2e7", "#c4c8da", "#3760bf", "#6172b0", "#a8aecb", "#2e7de9", "#e1e2e7", "#587539", "#c64343", "#8c6c3e", "#7847bd", "#587539", "#b15c00", "#848cb5", "#2e7de9") },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", scheme: "dark", group: "popular", base: b("#11111b", "#1e1e2e", "#181825", "#cdd6f4", "#a6adc8", "#313244", "#cba6f7", "#11111b", "#a6e3a1", "#f38ba8", "#f9e2af", "#cba6f7", "#a6e3a1", "#fab387", "#9399b2", "#89b4fa") },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", scheme: "dark", group: "popular", base: b("#181926", "#24273a", "#1e2030", "#cad3f5", "#a5adcb", "#363a4f", "#c6a0f6", "#181926", "#a6da95", "#ed8796", "#eed49f", "#c6a0f6", "#a6da95", "#f5a97f", "#939ab7", "#8aadf4") },
  { id: "catppuccin-frappe", name: "Catppuccin Frappe", scheme: "dark", group: "popular", base: b("#232634", "#303446", "#292c3c", "#c6d0f5", "#a5adce", "#414559", "#ca9ee6", "#232634", "#a6d189", "#e78284", "#e5c890", "#ca9ee6", "#a6d189", "#ef9f76", "#949cbb", "#8caaee") },
  { id: "catppuccin-latte", name: "Catppuccin Latte", scheme: "light", group: "popular", base: b("#dce0e8", "#eff1f5", "#e6e9ef", "#4c4f69", "#6c6f85", "#ccd0da", "#8839ef", "#eff1f5", "#40a02b", "#d20f39", "#df8e1d", "#8839ef", "#40a02b", "#fe640b", "#7c7f93", "#1e66f5") },
  { id: "rose-pine", name: "Rose Pine", scheme: "dark", group: "more", base: b("#191724", "#191724", "#1f1d2e", "#e0def4", "#908caa", "#403d52", "#ebbcba", "#191724", "#9ccfd8", "#eb6f92", "#f6c177", "#31748f", "#f6c177", "#ebbcba", "#6e6a86", "#ebbcba") },
  { id: "rose-pine-moon", name: "Rose Pine Moon", scheme: "dark", group: "more", base: b("#232136", "#232136", "#2a273f", "#e0def4", "#908caa", "#44415a", "#ea9a97", "#232136", "#9ccfd8", "#eb6f92", "#f6c177", "#3e8fb0", "#f6c177", "#ea9a97", "#6e6a86", "#ea9a97") },
  { id: "rose-pine-dawn", name: "Rose Pine Dawn", scheme: "light", group: "more", base: b("#faf4ed", "#faf4ed", "#fffaf3", "#464261", "#797593", "#dfdad9", "#d7827e", "#faf4ed", "#56949f", "#b4637a", "#ea9d34", "#286983", "#ea9d34", "#d7827e", "#9893a5", "#d7827e") },
  { id: "nord", name: "Nord", scheme: "dark", group: "more", base: b("#2e3440", "#2e3440", "#3b4252", "#d8dee9", "#616e88", "#4c566a", "#88c0d0", "#2e3440", "#a3be8c", "#bf616a", "#ebcb8b", "#81a1c1", "#a3be8c", "#b48ead", "#616e88", "#88c0d0") },
  { id: "gruvbox-dark", name: "Gruvbox Dark", scheme: "dark", group: "more", base: b("#1d2021", "#282828", "#3c3836", "#ebdbb2", "#a89984", "#504945", "#fe8019", "#282828", "#b8bb26", "#fb4934", "#fabd2f", "#fb4934", "#b8bb26", "#d3869b", "#928374", "#b8bb26") },
  { id: "gruvbox-light", name: "Gruvbox Light", scheme: "light", group: "more", base: b("#f9f5d7", "#fbf1c7", "#ebdbb2", "#3c3836", "#7c6f64", "#d5c4a1", "#af3a03", "#fbf1c7", "#79740e", "#9d0006", "#b57614", "#9d0006", "#79740e", "#8f3f71", "#928374", "#79740e") },
  { id: "kanagawa", name: "Kanagawa", scheme: "dark", group: "more", base: b("#16161d", "#1f1f28", "#2a2a37", "#dcd7ba", "#c8c093", "#363646", "#7e9cd8", "#16161d", "#98bb6c", "#e82424", "#ff9e3b", "#957fb8", "#98bb6c", "#d27e99", "#727169", "#7e9cd8") },
  { id: "kanagawa-dragon", name: "Kanagawa Dragon", scheme: "dark", group: "more", base: b("#0d0c0c", "#181616", "#282727", "#c5c9c5", "#c8c093", "#393836", "#8ba4b0", "#0d0c0c", "#98bb6c", "#e82424", "#ff9e3b", "#8992a7", "#8a9a7b", "#a292a3", "#737c73", "#8ba4b0") },
  { id: "kanagawa-lotus", name: "Kanagawa Lotus", scheme: "light", group: "more", base: b("#d5cea3", "#f2ecbc", "#e7dba0", "#545464", "#43436c", "#e4d794", "#4d699b", "#d5cea3", "#6f894e", "#e82424", "#e98a00", "#624c83", "#6f894e", "#b35b79", "#8a8980", "#4d699b") },
  { id: "everforest-dark", name: "Everforest Dark", scheme: "dark", group: "more", base: b("#232a2e", "#2d353b", "#343f44", "#d3c6aa", "#9da9a0", "#4f585e", "#a7c080", "#2d353b", "#a7c080", "#e67e80", "#dbbc7f", "#e67e80", "#a7c080", "#d699b6", "#859289", "#a7c080") },
  { id: "everforest-light", name: "Everforest Light", scheme: "light", group: "more", base: b("#efebd4", "#fdf6e3", "#f4f0d9", "#5c6a72", "#829181", "#e0dcc7", "#8da101", "#fdf6e3", "#8da101", "#f85552", "#dfa000", "#f85552", "#8da101", "#df69ba", "#939f91", "#8da101") },
  { id: "ayu-dark", name: "Ayu Dark", scheme: "dark", group: "more", base: b("#0d1017", "#10141c", "#141821", "#bfbdb6", "#5a6378", "#1b1f29", "#e6b450", "#765b24", "#70bf56", "#d95757", "#e6b450", "#ff8f40", "#aad94c", "#d2a6ff", "#5a6673", "#ffb454") },
  { id: "ayu-mirage", name: "Ayu Mirage", scheme: "dark", group: "more", base: b("#1f2430", "#242936", "#282e3b", "#cccac2", "#707a8c", "#171b24", "#ffcc66", "#735923", "#87d96c", "#ff6666", "#ffcc66", "#ffa659", "#d5ff80", "#dfbfff", "#6e7c8f", "#ffcd66") },
  { id: "ayu-light", name: "Ayu Light", scheme: "light", group: "more", base: b("#f8f9fa", "#fcfcfc", "#fafafa", "#5c6166", "#828e9f", "#eaedef", "#f29718", "#7e4b01", "#6cbf43", "#e65050", "#f29718", "#fa8532", "#86b300", "#a37acc", "#adaeb1", "#eba400") },
  { id: "night-owl", name: "Night Owl", scheme: "dark", group: "more", base: b("#011627", "#011627", "#0b2942", "#d6deeb", "#89a4bb", "#5f7e97", "#7e57c2", "#ffffff", "#22da6e", "#ef5350", "#ffeb95", "#c792ea", "#ecc48d", "#f78c6c", "#637777", "#82aaff") },
  { id: "solarized-dark", name: "Solarized Dark", scheme: "dark", group: "more", base: b("#002b36", "#002b36", "#073642", "#839496", "#586e75", "#073642", "#268bd2", "#002b36", "#859900", "#dc322f", "#b58900", "#859900", "#2aa198", "#2aa198", "#586e75", "#268bd2") },
  { id: "solarized-light", name: "Solarized Light", scheme: "light", group: "more", base: b("#fdf6e3", "#fdf6e3", "#eee8d5", "#657b83", "#93a1a1", "#eee8d5", "#268bd2", "#002b36", "#859900", "#dc322f", "#b58900", "#859900", "#2aa198", "#2aa198", "#93a1a1", "#268bd2") },
  { id: "vesper", name: "Vesper", scheme: "dark", group: "more", base: b("#101010", "#101010", "#161616", "#ffffff", "#a0a0a0", "#282828", "#ffc799", "#000000", "#99ffe4", "#ff8080", "#ffc799", "#a0a0a0", "#99ffe4", "#ffc799", "#575757", "#ffc799") },
  { id: "poimandres", name: "Poimandres", scheme: "dark", group: "more", base: b("#1b1e28", "#1b1e28", "#262934", "#a6accd", "#767c9d", "#303340", "#add7ff", "#1b1e28", "#5de4c7", "#d0679d", "#fffac2", "#91b4d5", "#5de4c7", "#5de4c7", "#5a5f79", "#add7ff") },
  { id: "vitesse-dark", name: "Vitesse Dark", scheme: "dark", group: "more", base: b("#121212", "#121212", "#181818", "#cecabe", "#858480", "#191919", "#4d9375", "#121212", "#4d9375", "#cb7676", "#d4976c", "#4d9375", "#c98a7d", "#4c9a91", "#687668", "#80a665") },
  { id: "vitesse-light", name: "Vitesse Light", scheme: "light", group: "more", base: b("#ffffff", "#ffffff", "#f7f7f7", "#393a34", "#8f908c", "#f0f0f0", "#1c6b48", "#ffffff", "#1e754f", "#ab5959", "#a65e2b", "#1e754f", "#b56959", "#2f798a", "#a0ada0", "#59873a") },
  { id: "flexoki-dark", name: "Flexoki Dark", scheme: "dark", group: "more", base: b("#100f0f", "#100f0f", "#1c1b1a", "#cecdc3", "#878580", "#343331", "#3aa99f", "#100f0f", "#879a39", "#d14d41", "#da702c", "#879a39", "#3aa99f", "#8b7ec8", "#878580", "#da702c") },
  { id: "flexoki-light", name: "Flexoki Light", scheme: "light", group: "more", base: b("#fffcf0", "#fffcf0", "#f2f0e5", "#100f0f", "#6f6e69", "#dad8ce", "#24837b", "#fffcf0", "#66800b", "#af3029", "#bc5215", "#66800b", "#24837b", "#5e409d", "#6f6e69", "#bc5215") },
  { id: "nightfox", name: "Nightfox", scheme: "dark", group: "more", base: b("#131a24", "#192330", "#212e3f", "#cdcecf", "#aeafb0", "#39506d", "#719cd6", "#131a24", "#81b29a", "#c94f6d", "#dbc074", "#9d79d6", "#81b29a", "#f4a261", "#738091", "#719cd6") },
];

/** "#rrggbb" plus an alpha byte, for the four band tokens that may be translucent. */
const alpha = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;

/**
 * Maps Pocket Run's 16 colours onto CodeEditor's contract v2. Pocket Run's "sheet" is the editor
 * (CodeEditor's --bg), "paper" the page behind it (the sidebar here, and the program's terminal),
 * "bar" its header strips (floating layers and the run-log header). The colours Pocket Run doesn't
 * have are derived the way CSS color-mix() would (over()):
 *   action, location, control-on   = accent; action-hover: accent moved 15% away from its label
 *   link            accent lifted to 4.5:1 on the three panels
 *   focus           = ink (distinct from a chromatic accent, and 3:1 or more everywhere)
 *   text-secondary  ink 50% over muted, lifted to 4.5:1 on the three panels; info = muted
 *   selection       18% accent over the editor (opaque); active-line ink at 4% alpha;
 *   list-selected   ink at 10% alpha; error-band err at 14% alpha; call-site = err
 *   input-echo, brand = ink; on-brand = sheet; divider = rule
 *   border-strong   80% muted over the editor, lifted to 3:1
 *   syn-function    = syn-def (Pocket Run colours calls and definitions with it)
 *   syn-type/macro  = syn-keyword (most of these themes colour int/char and #include like keywords)
 *   syn-variable/operator = ink, syn-punctuation = muted
 * readablePalette() then lifts anything still under its contrast pair. The theme-file format does
 * not change.
 */
export function expandBase(base: BaseColors): Palette {
  const bg = base.sheet;
  const panels = [bg, base.paper, base.bar];
  return {
    bg,
    surface: base.paper,
    "surface-raised": base.bar,
    "terminal-bg": base.paper,
    "terminal-fg": base.ink,
    "runlog-bg": base.bar,
    divider: base.rule,
    border: base.rule,
    "border-strong": lift(over(bg, base.muted, 0.8), panels, 3),
    text: base.ink,
    "text-secondary": lift(over(base.muted, base.ink, 0.5), panels, 4.5),
    "text-muted": base.muted,
    "gutter-text": base.muted,
    action: base.accent,
    // Away from the label, so the hovered Run button reads at least as well as the resting one.
    "action-hover": over(base.accent, luminance(base["on-accent"]) > 0.18 ? "#000000" : "#ffffff", 0.15),
    "on-action": base["on-accent"],
    "control-on": base.accent,
    focus: base.ink,
    selection: over(bg, base.accent, 0.18),
    "list-selected": alpha(base.ink, 0.1),
    "active-line": alpha(base.ink, 0.04),
    location: base.accent,
    danger: base.err,
    warning: base.warn,
    success: base.ok,
    info: base.muted,
    "error-band": alpha(base.err, 0.14),
    "call-site": base.err,
    "input-echo": base.ink,
    link: lift(base.accent, panels, 4.5),
    brand: base.ink,
    "on-brand": base.sheet,
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
    accent: p.action, "on-accent": p["on-action"], ok: p.success, err: p.danger, warn: p.warning,
    "syn-keyword": p["syn-keyword"], "syn-string": p["syn-string"], "syn-number": p["syn-number"],
    "syn-comment": p["syn-comment"], "syn-def": p["syn-function"],
    "syn-type": p["syn-type"], "syn-variable": p["syn-variable"], "syn-operator": p["syn-operator"],
    "syn-macro": p["syn-macro"], "syn-punctuation": p["syn-punctuation"],
  };
}
