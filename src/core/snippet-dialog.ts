// Capture snippet: the pure parts only the dialog needs (final-v3 sections 4.3, 4.8, 5.3, 5.4 and
// 6.2): its title, the Colours choices and the preview's label, the image's colour tokens, the
// download's name, writing the remembered options, and every message the dialog speaks. A module of
// its own, imported by the lazy dialog chunk only, so none of it reaches the first visit; the shell
// keeps what it decides with (core/snippet.ts). Type-only imports from the shell module are free.
// Kept ASCII; no DOM types (the worker build type-checks src/core with the WebWorker library).
import { nameOf } from "./paths";
import { cleanFilename } from "./safety";
import {
  cleanImageOptions, IMAGE_OPTIONS_KEY, lineWords, refusalMessage, shown,
  type CaptureMessage, type ColorChoice, type Entry, type ImageOptions, type LinePlan, type OptionsStorage, type PaintInfo, type Tone,
} from "./snippet";

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
  const label = `Preview of ${shown(nameOf(name))}, ${lines}, ${colours}; line numbers ${options.numbers ? "shown" : "hidden"}; file name ${options.name ? "shown" : "hidden"}.`;
  return partial ? `${label} Some colours are missing.` : label;
}

/** The frame's name when there is no image to show. */
export const NO_PREVIEW = {
  "too-big": "No preview: that selection is too big for one image.",
  failed: "No preview: the image couldn't be made.",
} as const;

/** The 17 colour tokens the image draws (4.3). */
export const IMAGE_TOKENS = [
  "bg", "text", "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable", "syn-operator",
  "syn-macro", "syn-punctuation", "gutter-text", "danger", "divider", "text-secondary", "border",
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

export function writeImageOptions(storage: Pick<OptionsStorage, "setItem"> | null, options: ImageOptions): void {
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
