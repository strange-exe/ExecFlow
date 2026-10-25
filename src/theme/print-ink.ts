// The print-safe palette of Save as PDF (.claude/design/pdf.md): the default theme's light ink
// (Signal Light, palettes.ts DEFAULT_OWN) on white paper. Nothing is printed behind the code in this
// palette (paper is the ground), so each colour is checked against white: every text colour keeps 4.5:1
// there (print-ink.test.ts computes it with contrast.ts). The tokens are the ones the print layout
// paints: the code's ten syntax colours and plain text, the line numbers and continuation marks,
// the special-character placeholders, the path heading and its rule, and the footer.
import type { ColorVar } from "./contrast";
import { DEFAULT_OWN, OWN } from "./palettes";

/** The paper the print-safe ink is checked against (a sheet of paper, not a token). */
export const PAPER = "#ffffff";

/** The tokens the print layout paints with text, then the one rule it draws. */
export const PRINT_TEXT_TOKENS = [
  "text", "text-secondary", "gutter-text", "danger",
  "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable", "syn-operator", "syn-macro", "syn-punctuation",
] as const satisfies readonly ColorVar[];
export const PRINT_RULE_TOKENS = ["border"] as const satisfies readonly ColorVar[];

export type PrintToken = (typeof PRINT_TEXT_TOKENS)[number] | (typeof PRINT_RULE_TOKENS)[number];

/** The default theme's light values of the printed tokens. */
export const PRINT_INK: Readonly<Record<PrintToken, string>> = Object.freeze(
  Object.fromEntries([...PRINT_TEXT_TOKENS, ...PRINT_RULE_TOKENS].map((t) => [t, OWN[DEFAULT_OWN].light[t]])) as Record<PrintToken, string>,
);
