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
  "--code-cols", // src/ui/layout.ts, the code card's share beside the console (1100 px and wider)
  "--console-cols", // src/ui/layout.ts, the console card's share beside the code
  "--level", // src/ui/tree.ts, a tree row's depth
  "--tail", // src/ui/tree.ts, a conflict copy name's uncut end, in ch
  "--row-h", // app.css, declared on .tree-row
  "--kind", // about.css, a What's new change tag's hue, declared on each kind's rule
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
// numbers, line styles and the keywords that name no colour. color-mix() of tokens is allowed, and
// so are gradients of tokens (the What's new current-release border and ground): their function
// names and "from"/"to" name no colour, and a literal inside one still fails LITERAL below.
const COLOUR_PROPERTY = /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|accent-color|caret-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color)$/;
const NOT_A_COLOUR = /var\(\s*--[a-z0-9-]+(\s*,\s*[^()]*)?\)|color-mix\(in srgb,|(repeating-)?(linear|radial|conic)-gradient\(|-?\d*\.?\d+(px|em|rem|%|ch|deg)?|\b(solid|dashed|dotted|double|none|transparent|currentColor|inherit|initial|unset|inset|underline|wavy|from|to)\b|[\s,()]/gi;
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
    const app = readFileSync(`${DIR}/app.css`, "utf8") + readFileSync(`${DIR}/about.css`, "utf8") + readFileSync("src/ui/layout.ts", "utf8") + readFileSync("src/ui/tree.ts", "utf8");
    for (const name of RUNTIME) expect(app, name).toMatch(new RegExp(`["\`\\s{;]${name}[:"]|${name}: `));
  });
});

describe("type, shape and desktop heights (redesign 2, option a)", () => {
  const body = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
  /** The declarations of the first block that starts with `head`, as name to value. */
  const block = (head: string) => {
    const start = body.indexOf(head);
    expect(start, head).toBeGreaterThanOrEqual(0);
    const text = body.slice(start + head.length, body.indexOf("}", start));
    return Object.fromEntries([...text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const root = Object.assign({}, ...[...body.matchAll(/(?:^|\n):root \{([^}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]))));

  it("Geist for the interface, JetBrains Mono for code, the log and file names, in every theme", () => {
    expect(root["--font-ui"]).toMatch(/^"Geist", /);
    expect(root["--font-code"]).toMatch(/^"JetBrains Mono", /);
    expect(root["--font-name"]).toBe("var(--font-code)");
    // "Joined symbols" switches ligatures only, never the font.
    expect(body).not.toMatch(/data-ligatures="on"\][^{]*\{[^}]*--font-code/);
    expect(body).not.toMatch(/Source Sans 3|Source Code Pro/);
  });

  it("the type scale and shapes", () => {
    expect(root).toMatchObject({
      "--fs-hint": "12px", "--lh-hint": "16px", "--fs-2": "13px", "--lh-2": "18px", "--fs-1": "14px", "--lh-1": "20px", "--lh-prose": "22px",
      "--fs-section": "16px", "--lh-section": "22px", "--fs-title": "20px", "--lh-title": "26px", "--fs-display": "30px", "--lh-display": "36px",
      "--tracking-title": "-0.02em", "--r-key": "5px", "--r-control": "8px", "--r-dialog": "14px",
    });
  });

  it("roomier bars on desktop only (a fine pointer, 900 px and wider); touch and phones keep their 44 px targets", () => {
    expect(block("@media (min-width: 900px) and (pointer: fine) {\n  :root {")).toEqual({
      // Workbench Pro (S2): a 56 px top bar, the console's 44 px head, 32 px rows (the tree's, menus').
      "--h-topbar": "56px", "--h-head": "44px", "--h-panel-bar": "44px", "--h-row": "32px", "--h-status": "28px", "--tool": "30px", "--primary-h": "32px",
    });
    expect(block("@media (pointer: coarse), (max-width: 899px) {\n  :root {")).toMatchObject({ "--h-row": "44px", "--tool": "44px", "--primary-h": "44px" });
    // The rail (900 px and wider), and the phone's bottom view bar: 52 px items in 4 + 8 px of padding.
    expect({ rail: root["--rail-w"], viewbar: root["--h-viewbar"] }).toEqual({ rail: "64px", viewbar: "64px" });
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
