/// <reference types="node" />
// plan-v2 P2, decision P-5, extended to every theme (UX polish C17, 2026-10-24): the editor's
// gutter-edge focus bar is the focus colour at 70% over the code ground wherever that step still
// keeps 3:1 or more against every ground the bar is drawn on (WCAG 1.4.11 and 2.4.7): the code, the
// cursor's line and the error band. In the palette themes the focus colour is the text colour, so the
// full-strength bar was the strongest line on screen (GitHub-style Light 15.8:1, Dracula 13.4,
// High contrast 18.5). Where the step would fail 3:1 (Deep Field light, Slate light and a few light
// palettes) the bar keeps --focus. The rule in tokens.css names its themes; this test derives the
// list from the colours, so a theme added or changed fails here until the list follows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHROME_SPEC } from "../editor/highlight";
import { contrast, over, resolve, type Palette } from "../theme/contrast";
import { DEEP_FIELD } from "../theme/palettes";
import { BUILT_IN, themePalette } from "../theme/themes";

const tokens = readFileSync("src/styles/tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const STEP = "color-mix(in srgb, var(--focus) 70%, var(--bg))";
const GROUNDS = ["bg", "active-line@bg", "error-band@bg"] as const;

/** A selector list split at its top-level commas (not those inside :is()). */
function selectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The selectors of the one rule that sets the stepped bar. */
function steppedRule(): { anyScheme: Set<string>; darkOnly: Set<string>; rules: number } {
  const blocks = [...tokens.matchAll(/([^{}]+)\{\s*--focus-bar:\s*([^;]+);\s*\}/g)];
  const stepped = blocks.filter((b) => b[2].trim() === STEP);
  const anyScheme = new Set<string>();
  const darkOnly = new Set<string>();
  for (const b of stepped) {
    for (const sel of selectorList(b[1])) {
      const target = sel.startsWith(':root[data-theme="dark"]') ? darkOnly : anyScheme;
      for (const m of sel.matchAll(/\[data-theme-id="([^"]+)"\]/g)) target.add(m[1]);
    }
  }
  return { anyScheme, darkOnly, rules: stepped.length };
}

const step = (p: Palette) => over(p.bg, p.focus.slice(0, 7), 0.7);
const passes = (p: Palette) => GROUNDS.every((g) => contrast(step(p), resolve(p, g)) >= 3);

/** Every built-in theme in every scheme it can be drawn in ("match device" in both). */
const drawn = BUILT_IN.flatMap((t) => (t.system ? (["light", "dark"] as const) : [t.scheme]).map((scheme) => ({ t, scheme, p: themePalette(t, scheme).palette })));

describe("the editor's focus bar (--focus-bar)", () => {
  it("is the focus colour by default, and the bar paints --focus-bar", () => {
    expect(tokens).toMatch(/:root \{\s*--focus-bar: var\(--focus\);\s*\}/);
    expect(CHROME_SPEC["&.cm-focused .cm-gutters::after"].backgroundColor).toBe("var(--focus-bar)");
  });

  it("one rule steps it to 70% toward the code ground, for exactly the themes where that keeps 3:1 on every ground", () => {
    const { anyScheme, darkOnly, rules } = steppedRule();
    expect(rules, "one stepped rule").toBe(1);
    const wrong: string[] = [];
    for (const { t, scheme, p } of drawn) {
      const listed = anyScheme.has(t.id) || (scheme === "dark" && darkOnly.has(t.id));
      if (listed !== passes(p)) wrong.push(`${t.id} (${scheme}): listed ${listed}, 70% step ${passes(p) ? "keeps" : "misses"} 3:1`);
    }
    expect(wrong).toEqual([]);
    // A theme drawn in one scheme only is listed without a scheme condition, and an id listed for
    // dark only is a "match device" theme (the light side of those keeps --focus).
    for (const id of darkOnly) expect(BUILT_IN.find((t) => t.id === id)?.system, id).toBe(true);
  });

  it("the stepped bar is a step down from the focus colour, never a new role, and keeps 3:1 on the code, the cursor's line and the error band", () => {
    for (const { t, scheme, p } of drawn.filter((d) => passes(d.p))) {
      for (const g of GROUNDS) expect(contrast(step(p), resolve(p, g)), `${t.id} ${scheme} ${g}`).toBeGreaterThanOrEqual(3);
      expect(contrast(step(p), p.bg), `${t.id} ${scheme}`).toBeLessThan(contrast(p.focus, p.bg));
    }
  });

  it("the palette themes that drew the strongest line now step down (GitHub-style Light, Dracula, High contrast)", () => {
    const { anyScheme } = steppedRule();
    for (const id of ["github-light", "dracula", "high-contrast"]) expect(anyScheme.has(id), id).toBe(true);
  });

  it("Deep Field dark keeps its measured step (#a2914d, 70% brass over the field); light keeps the focus colour", () => {
    const { anyScheme, darkOnly } = steppedRule();
    expect(step(DEEP_FIELD.dark)).toBe("#a2914d");
    expect(anyScheme.has("deep-field-dark") && darkOnly.has("deep-field")).toBe(true);
    const light = DEEP_FIELD.light;
    expect(contrast(light.focus, resolve(light, "error-band@bg"))).toBeGreaterThanOrEqual(3);
    expect(contrast(step(light), resolve(light, "error-band@bg"))).toBeLessThan(3);
    expect(anyScheme.has("deep-field-light")).toBe(false);
  });
});
