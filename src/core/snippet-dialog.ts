// Capture snippet: the pure parts only the dialog needs (final-v3 sections 4.3, 4.8, 5.3, 5.4 and
// 6.2; round 2, .claude/design/batch3/s.md): its title, the options (their memory, cleaning and
// migration), the Colours choices and the preview's label, the image's colour tokens, the highlight
// field's parsing and messages, the size line, the download's name, and every message the dialog
// speaks. A module of its own, imported by the lazy dialog chunk only, so none of it reaches the
// first visit; the shell keeps what it decides with (core/snippet.ts). Type-only imports from the
// shell module are free. Kept ASCII; no DOM types (the worker build type-checks src/core with the
// WebWorker library).
import { nameOf } from "./paths";
import { cleanFilename } from "./safety";
import {
  lineWords, refusalMessage, shown,
  type CaptureMessage, type ColorChoice, type Entry, type LinePlan, type LineSpan, type PaintInfo, type Tone,
} from "./snippet";

// ---------------------------------------------------------------- the options (5.4; round 2)

export type Scale = 1 | 2 | 3;
export type Padding = "small" | "medium" | "large";
export type Frame = "plain" | "window";

/** What is remembered on this device. */
export interface StoredOptions {
  readonly colors: ColorChoice;
  readonly numbers: boolean;
  readonly name: boolean;
  /** The export's scale; the bitmap steps down only when it can't fit (the size line says so). */
  readonly scale: Scale;
  /** A solid mat around the code card; off: the card alone with transparent corners. */
  readonly background: boolean;
  /** The mat's width (with the background on). */
  readonly padding: Padding;
  /** Window: a title bar with the file name instead of the plain header. */
  readonly frame: Frame;
}
/** What one image is drawn with: the stored options and this opening's highlighted lines (sorted, unique; never stored). */
export interface ImageOptions extends StoredOptions {
  readonly highlight: readonly number[];
}

export const DEFAULT_IMAGE_OPTIONS: StoredOptions = Object.freeze({
  colors: "match", numbers: true, name: true, scale: 2, background: true, padding: "medium", frame: "plain",
});
/** CSS px around the card at scale 1. */
export const PADDING: Readonly<Record<Padding, number>> = Object.freeze({ small: 16, medium: 32, large: 64 });
/** One device key of its own (5.4): a per-viewer convenience, cleared by "Sign out and clear this computer". */
export const IMAGE_OPTIONS_KEY = "codeeditor:snippet-image";

const oneOf = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

/**
 * Stored options cleaned field by field: unknown keys dropped, anything odd falls back to its
 * default. This is also the migration: a round-1 value ({colors, numbers, name}) keeps its three
 * fields and gains the defaults of the rest.
 */
export function cleanImageOptions(value: unknown): StoredOptions {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_IMAGE_OPTIONS;
  return {
    colors: oneOf(v.colors, ["match", "light", "dark"] as const, d.colors),
    numbers: typeof v.numbers === "boolean" ? v.numbers : d.numbers,
    name: typeof v.name === "boolean" ? v.name : d.name,
    scale: oneOf(v.scale, [1, 2, 3] as const, d.scale),
    background: typeof v.background === "boolean" ? v.background : d.background,
    padding: oneOf(v.padding, ["small", "medium", "large"] as const, d.padding),
    frame: oneOf(v.frame, ["plain", "window"] as const, d.frame),
  };
}

/** localStorage, structurally. */
export interface OptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (SecurityError): the defaults then, and changes last for the opening. */
export function readImageOptions(storage: Pick<OptionsStorage, "getItem"> | null): StoredOptions {
  try {
    return cleanImageOptions(JSON.parse(storage?.getItem(IMAGE_OPTIONS_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_IMAGE_OPTIONS };
  }
}

/** The same image: every option and the same highlighted lines. */
export function sameOptions(a: ImageOptions, b: ImageOptions): boolean {
  return a.colors === b.colors && a.numbers === b.numbers && a.name === b.name && a.scale === b.scale && a.background === b.background
    && a.padding === b.padding && a.frame === b.frame && a.highlight.length === b.highlight.length && a.highlight.every((n, i) => n === b.highlight[i]);
}

/** The preview's data-preview-options: "match numbers name 2x medium plain", then " hl:3,5-7" when lines are highlighted. */
export function optionsWord(o: ImageOptions): string {
  const words = [o.colors, o.numbers ? "numbers" : "no-numbers", o.name ? "name" : "no-name", `${o.scale}x`, o.background ? o.padding : "none", o.frame];
  return o.highlight.length ? `${words.join(" ")} hl:${rangesOf(o.highlight).join(",")}` : words.join(" ");
}

// ---------------------------------------------------------------- highlighted lines (round 2)

/** Sorted unique numbers as ranges: [3, 5, 6, 7] gives ["3", "5-7"]. */
export function rangesOf(lines: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return out;
}

/** A valid example for this capture: "2-3", "4-6", or the one line. */
export const highlightExample = (plan: LineSpan): string => (plan.last > plan.first ? `${plan.first}-${Math.min(plan.first + 2, plan.last)}` : `${plan.first}`);

/** The field's hint, under it. */
export function highlightHint(plan: LineSpan): string {
  if (plan.first === plan.last) return `Type ${plan.first} to highlight line ${plan.first}.`;
  return `Numbers or ranges from ${plan.first} to ${plan.last}, separated by commas, such as ${highlightExample(plan)}.`;
}

export type HighlightParse = { readonly ok: true; readonly lines: readonly number[] } | { readonly ok: false; readonly message: string };

/** The longest piece of the student's text a message repeats. */
const QUOTE_MAX = 16;

/**
 * The highlight field: line numbers and ranges inside the captured lines, separated by commas or
 * spaces ("3-5, 8"). Lenient (Tesler's law): spaces around a hyphen, a reversed range, repeats. An
 * empty field highlights nothing. Anything else is refused with a message that says what to type.
 */
export function parseHighlight(text: string, plan: LineSpan): HighlightParse {
  const items = text.replace(/\s*-\s*/g, "-").split(/[\s,]+/).filter(Boolean);
  const lines = new Set<number>();
  for (const item of items) {
    const m = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(item);
    if (!m) {
      const quoted = shown(item.length > QUOTE_MAX ? `${item.slice(0, QUOTE_MAX)}...` : item);
      return { ok: false, message: `"${quoted}" isn't a line number or a range such as ${highlightExample(plan)}.` };
    }
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (lo < plan.first || hi > plan.last) {
      const shows = `it shows ${lineWords(plan.first, plan.last)}`;
      return { ok: false, message: lo === hi ? `Line ${lo} isn't in the image: ${shows}.` : `Lines ${lo} to ${hi} aren't all in the image: ${shows}.` };
    }
    for (let n = lo; n <= hi; n++) lines.add(n);
  }
  return { ok: true, lines: [...lines].sort((x, y) => x - y) };
}

// ---------------------------------------------------------------- the size line (round 2)

/** Under the Scale choices: the PNG's exact pixel size, and the step taken when the chosen scale can't fit. */
export function sizeLine(width: number, height: number, requested: Scale, used: number): string {
  const size = `${width} x ${height} pixels`;
  return used === requested ? `${size}.` : `${size}. ${requested}x is too big for this image, so it is ${used}x.`;
}

/** The dialog's title: line numbers only, never the file's name. */
export function dialogTitle(plan: LinePlan): string {
  return plan.ok ? `Capture snippet of ${lineWords(plan.first, plan.last)}` : "Capture snippet of the selected lines";
}

// ---------------------------------------------------------------- colours

/** The three Colours choices, each labelled with what it gives (4.3). Theme names are user text: shown(). */
export function colorChoices(paint: PaintInfo): { value: ColorChoice; label: string }[] {
  if (paint.family === "palette") {
    return [
      { value: "match", label: paint.themeName ? `Match the editor (${shown(paint.themeName)})` : "Match the editor" },
      { value: "light", label: "CodeEditor Deep Field Light" },
      { value: "dark", label: "CodeEditor Deep Field Dark" },
    ];
  }
  return [
    { value: "match", label: `Match the editor (${paint.scheme})` },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
}

const OWN_PHRASE: Record<ColorChoice, string> = { match: "in the editor's colours", light: "in light colours", dark: "in dark colours" };
const PALETTE_PHRASE: Record<ColorChoice, string> = {
  match: "in the editor's colours",
  light: "in CodeEditor Deep Field Light colours",
  dark: "in CodeEditor Deep Field Dark colours",
};

/** The preview's text alternative (5.3), also the dialog's description. */
export function previewLabel(plan: LinePlan, name: string, options: ImageOptions, paint: PaintInfo, partial: boolean): string {
  const lines = plan.ok || plan.reason === "cap" ? lineWords(plan.first, plan.last) : "the selected lines";
  const colours = (paint.family === "palette" ? PALETTE_PHRASE : OWN_PHRASE)[options.colors];
  // Round 1's sentence first, unchanged; round 2's look in a second one.
  const look = [options.frame === "window" ? "Window frame" : "Plain frame", options.background ? `${options.padding} background` : "no background"];
  if (options.highlight.length) {
    const words = rangesOf(options.highlight).map((r) => (r.includes("-") ? `lines ${r.replace("-", " to ")}` : `line ${r}`));
    look.push(`highlighted: ${words.join(", ")}`);
  }
  const label = `Preview of ${shown(nameOf(name))}, ${lines}, ${colours}; line numbers ${options.numbers ? "shown" : "hidden"}; file name ${options.name ? "shown" : "hidden"}. ${look.join(", ")}.`;
  return partial ? `${label} Some colours are missing.` : label;
}

/** The frame's name when there is no image to show. */
export const NO_PREVIEW = {
  "too-big": "No preview: that selection is too big for one image.",
  failed: "No preview: the image couldn't be made.",
} as const;

/**
 * The 20 colour tokens the image draws (4.3): round 1's 17, plus round 2's `surface` (the window
 * frame's bar), `focus` and `action` (the highlight band and the background are mixes of them over
 * bg: contrast.ts IMAGE_MIXES).
 */
export const IMAGE_TOKENS = [
  "bg", "text", "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable", "syn-operator",
  "syn-macro", "syn-punctuation", "gutter-text", "danger", "divider", "text-secondary", "border", "surface", "focus", "action",
] as const;
export type ImageToken = (typeof IMAGE_TOKENS)[number];
export type ImageColors = Readonly<Record<ImageToken, string>>;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Every image token as #rrggbb (trimmed), or null: a render with anything else fails, never guesses.
 * A three-digit #rgb is the same colour written short and is spelled out: the production build's
 * CSS minifier shortens tokens.css values (Slate's --syn-number is served in its three-digit form),
 * and a custom property computes to the text as written.
 */
export function checkColors(values: Readonly<Record<string, string | undefined>>): ImageColors | null {
  const out: Partial<Record<ImageToken, string>> = {};
  for (const token of IMAGE_TOKENS) {
    const value = values[token]?.trim() ?? "";
    if (!HEX.test(value)) return null;
    out[token] = value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
  }
  return out as ImageColors;
}

// ---------------------------------------------------------------- the download's name

/**
 * "main-py-lines-4-12.png" (4.8): the name's stem and extension letters, then the lines. With the
 * file name hidden: "code-lines-4-12.png", so the name reaches neither the picture nor the file.
 */
export function downloadName(path: string, first: number, last: number, options: { name: boolean }): string {
  const lines = first === last ? `line-${first}` : `lines-${first}-${last}`;
  let stem = "code";
  let ext = "";
  if (options.name) {
    const name = nameOf(path);
    const dot = name.lastIndexOf(".");
    const hasExt = dot > 0;
    stem = slug(hasExt ? name.slice(0, dot) : name).slice(0, 60).replace(/-+$/, "") || "code";
    ext = hasExt ? slug(name.slice(dot + 1)).slice(0, 10).replace(/-+$/, "") : "";
  }
  return cleanFilename(`${stem}${ext ? `-${ext}` : ""}-${lines}.png`);
}

/** Letters, digits, _ and - only; every other run of characters becomes one -; no - at either end. */
const slug = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------- the dialog's options

/** Writes the stored fields only (never the highlighted lines). */
export function writeImageOptions(storage: Pick<OptionsStorage, "setItem"> | null, options: StoredOptions): void {
  try {
    storage?.setItem(IMAGE_OPTIONS_KEY, JSON.stringify(cleanImageOptions(options)));
  } catch {
    // storage blocked: the change lasts for this opening
  }
}

// ---------------------------------------------------------------- messages (final-v3 section 6.2)

/**
 * Every capture text, string for string. `open`: the dialog is open (its status line speaks);
 * otherwise the page's notice line does, and the texts drop "Close this and" (an export that
 * settles after the dialog closed). Refusals and the chunk's failure are the shell's own texts.
 */
export function captureMessage(m: CaptureMessage, at: { coarse: boolean; entry: Entry; open: boolean }): { text: string; tone: Tone } {
  const info = (text: string) => ({ text, tone: "info" as const });
  const error = (text: string) => ({ text, tone: "error" as const });
  switch (m.kind) {
    case "refused":
    case "chunk-failed":
      return refusalMessage(m, at);
    case "making-preview":
      return info("Making the preview...");
    case "updating-preview":
      return info("Updating the preview...");
    case "preview-failed":
      return error(at.open ? "Couldn't make the image. Close this and try again." : "Couldn't make the image. Try again.");
    case "partial":
      return info("Some colours are missing: the file was still being read.");
    case "gaps":
      return info("The image includes the lines between your selections.");
    case "making-png":
      return info("Making the PNG...");
    case "copied":
      return { text: at.open ? "Copied the image." : `Copied an image of ${m.what}.`, tone: "success" };
    case "downloaded":
      return { text: `Downloading ${m.file}.`, tone: "success" };
    case "denied":
      return error(at.open ? "Couldn't copy the image. Use Download instead." : "Couldn't copy the image.");
    case "failed":
      switch (m.reason) {
        case "device":
          return error(at.open ? "Couldn't make an image this big on this device. Close this and select fewer lines." : "Couldn't make an image this big on this device. Select fewer lines.");
        case "privacy":
          return error("This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.");
        case "updating":
          if (at.open) return info(`The preview was still updating. Press ${m.action === "copy" ? "Copy" : "Download"} again.`);
          return info(`The preview was still updating, so nothing was ${m.action === "copy" ? "copied" : "downloaded"}. Try again.`);
        case "other":
          return error("Couldn't make the image. Try again.");
      }
  }
  return error("Couldn't make the image. Try again.");
}
