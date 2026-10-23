// Save as PDF (.claude/design/pdf.md): the pure parts of the print export. The export is the
// browser's own print dialog ("Save as PDF" is a printer there) over a print-only layout of the
// chosen files, so the PDF has selectable text in the app's own fonts and no library is needed.
// This module holds what the dialog decides with: its options (memory, cleaning, migration), the
// page furniture's CSS (named pages and margin boxes, every piece of file text escaped), the
// document title the browser names the PDF after, the line cap and every message. Imported by the
// lazy print chunk only. Kept ASCII; no DOM types (the worker build type-checks src/core with the
// WebWorker library).
import { nameOf } from "./paths";
import { shown } from "./snippet";

// ---------------------------------------------------------------- the options

/** "print": the light print-safe ink on white paper; "theme": the editor's colours, its ground printed too. */
export type PrintColours = "print" | "theme";

export interface PrintOptions {
  readonly colours: PrintColours;
  readonly numbers: boolean;
  /** The footer on every page: the file, the page number (where the browser can count pages), the date and "Made with CodeEditor". */
  readonly footer: boolean;
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = Object.freeze({ colours: "print", numbers: true, footer: true });

/** One device key of its own, like the snippet image's (a per-viewer convenience). */
export const PRINT_OPTIONS_KEY = "codeeditor:print";

/** Stored options cleaned field by field: unknown keys dropped, anything odd falls back to its default (also the migration). */
export function cleanPrintOptions(value: unknown): PrintOptions {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_PRINT_OPTIONS;
  return {
    colours: v.colours === "print" || v.colours === "theme" ? v.colours : d.colours,
    numbers: typeof v.numbers === "boolean" ? v.numbers : d.numbers,
    footer: typeof v.footer === "boolean" ? v.footer : d.footer,
  };
}

interface OptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (SecurityError): the defaults then. */
export function readPrintOptions(storage: Pick<OptionsStorage, "getItem"> | null): PrintOptions {
  try {
    return cleanPrintOptions(JSON.parse(storage?.getItem(PRINT_OPTIONS_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_PRINT_OPTIONS };
  }
}

export function writePrintOptions(storage: Pick<OptionsStorage, "setItem"> | null, options: PrintOptions): void {
  try {
    storage?.setItem(PRINT_OPTIONS_KEY, JSON.stringify(cleanPrintOptions(options)));
  } catch {
    // storage blocked: the change lasts for this opening
  }
}

// ---------------------------------------------------------------- the files

/** The most lines one export prints, all files together: a page per about 60 lines, so about 330 pages. */
export const PRINT_LINE_CAP = 20_000;

/** Why the chosen files can't be printed, or null. `lines`: each chosen file's line count. */
export function choiceProblem(lines: readonly number[]): string | null {
  if (!lines.length) return "Choose at least one file.";
  const total = lines.reduce((n, l) => n + l, 0);
  if (total > PRINT_LINE_CAP) return `That's ${total.toLocaleString("en")} lines. One PDF can hold up to ${PRINT_LINE_CAP.toLocaleString("en")}, so choose fewer files.`;
  return null;
}

/**
 * The document's title while the print dialog is open: browsers name the saved PDF after it
 * ("main.py.pdf"), and Firefox and Safari print it in their own page header. Untrusted text: shown().
 */
export function printTitle(paths: readonly string[]): string {
  if (!paths.length) return "CodeEditor";
  const first = shown(nameOf(paths[0]));
  if (paths.length === 1) return first;
  const more = paths.length - 1;
  return `${first} and ${more} more ${more === 1 ? "file" : "files"}`;
}

// ---------------------------------------------------------------- page furniture (CSS)

/**
 * `text` as a CSS string's contents: every character but ASCII letters, digits and the space is
 * written as a hexadecimal escape followed by a space (CSS Syntax 3, "consume an escaped code
 * point"), so a file name can never end the string, the rule or the sheet. Direction and invisible
 * characters were made visible by shown() first.
 */
export function cssText(text: string): string {
  let out = "";
  for (const ch of shown(text)) {
    out += /^[A-Za-z0-9 ]$/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `;
  }
  return out;
}

/** The named page of the file at `index` (CSS Paged Media: `page`), so its footer can name it. */
export const pageName = (index: number): string => `ce-file-${index}`;

/** A plain #rrggbb colour (the footer's ink goes into the sheet only in this form). */
const HEX = /^#[0-9a-f]{6}$/i;

/** The words of the footer that never change. */
export const MADE_WITH = "Made with CodeEditor";

export interface FooterSpec {
  /** The chosen files' paths, in print order. */
  readonly paths: readonly string[];
  /** The date as the footer shows it. */
  readonly date: string;
  /** #rrggbb ink of the footer text. */
  readonly ink: string;
  /** The footer's font-family value, from the app's own stylesheet. */
  readonly font: string;
}

/**
 * The page rules: page margins for every page, and with the footer on, one named page per file
 * whose bottom margin boxes say the file's path and the date, "Page 2 of 5", and "Made with
 * CodeEditor" (CSS Paged Media 3, margin boxes and the page and pages counters; Chromium 131 and
 * later draw them, the other engines skip the at-rules and get the in-page footer instead). The
 * empty top box keeps Chromium's own header (its date and the page title) off these pages, as
 * the bottom boxes keep its own footer off (measured with page.pdf's displayHeaderFooter, which
 * draws the print dialog's "Headers and footers"). The font comes from the app's stylesheet, never
 * from file text; the ink is checked as #rrggbb.
 */
export function pageRules(spec: FooterSpec | null): string {
  const rules = ["@page { margin: 14mm 14mm 16mm 14mm; }"];
  // Footer off: empty boxes still keep the browser's own header and footer (its address and title) off the paper.
  if (!spec) return [...rules, '@page { @top-center { content: ""; } @bottom-center { content: ""; } }'].join("\n");
  const font = spec.font.replace(/[^A-Za-z0-9 ,"'-]/g, "");
  const box = `font-family: ${font}; font-size: 8pt;${HEX.test(spec.ink) ? ` color: ${spec.ink};` : ""}`;
  spec.paths.forEach((path, i) => {
    rules.push(
      `@page ${pageName(i)} {`,
      '  @top-center { content: ""; }',
      `  @bottom-left { content: "${cssText(`${path}, ${spec.date}`)}"; ${box} text-align: left; vertical-align: top; }`,
      `  @bottom-center { content: "Page " counter(page) " of " counter(pages); ${box} vertical-align: top; }`,
      `  @bottom-right { content: "${cssText(MADE_WITH)}"; ${box} text-align: right; vertical-align: top; }`,
      "}",
    );
  });
  return rules.join("\n");
}

/** The in-page footer's text where the browser draws no margin boxes (Firefox, Safari): no page number, which needs them. */
export const fallbackFooter = (path: string, date: string): string => `${shown(path)}, ${date}. ${MADE_WITH}`;

// ---------------------------------------------------------------- messages

/** The one line that says what happens next, under the dialog's title. */
export const NEXT_STEP = 'Your browser\'s print dialog opens next. Choose "Save as PDF" as the printer.';

export type PrintMessage =
  | { readonly kind: "preparing" }
  | { readonly kind: "no-files" }
  | { readonly kind: "too-many"; readonly text: string }
  | { readonly kind: "read-failed"; readonly path: string }
  | { readonly kind: "partial"; readonly paths: readonly string[] }
  | { readonly kind: "prepare-failed" }
  | { readonly kind: "print-failed" };

export function printMessage(m: PrintMessage): { text: string; tone: "info" | "error" } {
  switch (m.kind) {
    case "preparing":
      return { text: "Preparing the pages...", tone: "info" };
    case "no-files":
      return { text: "Choose at least one file.", tone: "error" };
    case "too-many":
      return { text: m.text, tone: "error" };
    case "read-failed":
      return { text: `Couldn't read ${shown(m.path)}. Try again.`, tone: "error" };
    case "partial":
      return { text: `Some colours are missing in ${m.paths.map((p) => shown(nameOf(p))).join(", ")}: the file was still being read.`, tone: "info" };
    case "prepare-failed":
      return { text: "Couldn't prepare the pages. Check the connection, then try again.", tone: "error" };
    case "print-failed":
      return { text: "This browser couldn't open its print dialog, so no PDF was made.", tone: "error" };
  }
}
