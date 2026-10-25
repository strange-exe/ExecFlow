/// <reference types="node" />
// The stylesheets against the token contract. CSS ignores an undefined var() silently (the
// declaration just falls back to its initial value), so a missed rename such as a leftover
// var(--accent) would pass every other test and quietly paint nothing; and nothing else stops a raw
// colour from slipping into a component rule. These two checks do.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LINT_SPEC } from "../editor/extensions";
import { CHROME_SPEC } from "../editor/highlight";
import { COLOR_VARS, UI_MIXES } from "../theme/contrast";

const DIR = "src/styles";
const sheets = readdirSync(DIR).filter((f) => f.endsWith(".css")).map((f) => ({ file: f, text: readFileSync(`${DIR}/${f}`, "utf8") }));
const tokens = sheets.find((s) => s.file === "tokens.css")!.text;

/** Custom properties tokens.css declares (colours, mixes, fonts, sizes, space, shape, heights, motion). */
const DECLARED = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
/** Set at run time by the app's own code, or locally on one rule (with where). */
const RUNTIME = new Set([
  "--sidebar-w", // src/ui/layout.ts, the file list's width
  "--editor-rows", // src/ui/layout.ts, the editor's share of the centre column
  "--panel-rows", // src/ui/layout.ts, the panel's share
  "--level", // src/ui/tree.ts, a tree row's depth
  "--tail", // src/ui/tree.ts, a conflict copy name's uncut end, in ch
  "--row-h", // app.css, declared on .tree-row
]);
/** The theme picker's preview tiles set their own colours as --tile-* on each tile. */
const RUNTIME_PREFIX = "--tile-";

const allowed = (name: string) =>
  (COLOR_VARS as readonly string[]).includes(name.slice(2)) ||
  name.slice(2) in UI_MIXES ||
  DECLARED.has(name) ||
  RUNTIME.has(name) ||
  name.startsWith(RUNTIME_PREFIX);

/** Every var(--x) in `text` that names nothing the contract or the app defines. */
function undefinedVars(text: string): string[] {
  return [...new Set([...text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))].filter((name) => !allowed(name));
}

// Colour-bearing properties, and what their values may contain besides var(--token): lengths,
// numbers, line styles and the keywords that name no colour. color-mix() of tokens is allowed.
const COLOUR_PROPERTY = /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|accent-color|caret-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color)$/;
const NOT_A_COLOUR = /var\(\s*--[a-z0-9-]+(\s*,\s*[^()]*)?\)|color-mix\(in srgb,|-?\d*\.?\d+(px|em|rem|%|ch|deg)?|\b(solid|dashed|dotted|double|none|transparent|currentColor|inherit|initial|unset|inset|underline|wavy)\b|[\s,()]/gi;
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** Declarations outside tokens.css that carry a raw colour. */
function rawColours(text: string): string[] {
  const out: string[] = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = m;
    if (prop.startsWith("--")) continue;
    if (LITERAL.test(value.replace(/color-mix\(in srgb,/g, ""))) out.push(`${prop}: ${value.trim()}`);
    else if (COLOUR_PROPERTY.test(prop) && value.replace(NOT_A_COLOUR, "") !== "") out.push(`${prop}: ${value.trim()}`);
  }
  return out;
}

describe("every var() names a real token", () => {
  it.each(sheets.map((s) => [s.file, s.text] as const))("%s", (_, text) => {
    expect(undefinedVars(text)).toEqual([]);
  });

  it("the editor's chrome and lint specs (CHROME_SPEC, LINT_SPEC)", () => {
    expect(undefinedVars(JSON.stringify(CHROME_SPEC))).toEqual([]);
    expect(undefinedVars(JSON.stringify(LINT_SPEC))).toEqual([]);
  });

  it("the check can fail: a v1 name, a typo and an undeclared size are caught", () => {
    expect(undefinedVars(".btn.primary { background: var(--accent); color: var(--on-accent); }")).toEqual(["--accent", "--on-accent"]);
    expect(undefinedVars(".x { color: var(--txet); font-size: var(--text-xs); border-radius: var(--r-panel); }")).toEqual(["--txet", "--text-xs", "--r-panel"]);
    expect(undefinedVars(".x { color: var(--text); width: var(--sidebar-w, 248px); background: var(--tile-bg); }")).toEqual([]);
  });

  it("every run-time name on the list is really set by the app", () => {
    const app = readFileSync(`${DIR}/app.css`, "utf8") + readFileSync("src/ui/layout.ts", "utf8") + readFileSync("src/ui/tree.ts", "utf8");
    for (const name of RUNTIME) expect(app, name).toMatch(new RegExp(`["\`\\s{;]${name}[:"]|${name}: `));
  });
});

describe("components hold no raw colour (only tokens.css and palettes.ts do)", () => {
  it.each(sheets.filter((s) => s.file !== "tokens.css").map((s) => [s.file, s.text] as const))("%s", (_, text) => {
    expect(rawColours(text)).toEqual([]);
  });

  it("the checks read the real stylesheet: one changed declaration in app.css is caught", () => {
    const app = sheets.find((s) => s.file === "app.css")!.text;
    expect(app).toContain("  background: var(--bg);\n");
    expect(rawColours(app.replace("  background: var(--bg);\n", "  background: #fdfdff;\n"))).toEqual(["background: #fdfdff"]);
    expect(rawColours(app.replace("  background: var(--bg);\n", "  background: white;\n"))).toEqual(["background: white"]);
    expect(undefinedVars(app.replace("  background: var(--bg);\n", "  background: var(--accent);\n"))).toEqual(["--accent"]);
  });

  it("the check can fail: hex, rgb(), hsl(), oklch() and named colours are caught", () => {
    expect(rawColours(".a { color: #fff; } .b { background: rgb(0 0 0 / 0.5); } .c { border: 1px solid hsl(0 0% 50%); }")).toHaveLength(3);
    expect(rawColours(".d { outline: 2px solid red; } .e { box-shadow: 0 0 4px oklch(0.5 0.1 20); } .f { fill: rebeccapurple; }")).toHaveLength(3);
    expect(rawColours(".g { color: var(--text); border: 1px solid var(--border); background: transparent; border-color: color-mix(in srgb, var(--on-action) 55%, transparent); }")).toEqual([]);
  });
});
