/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPalette, COLOR_VARS, contrast, lift, over, PAIRS, readablePalette, resolve, UI_MIXES, type Palette } from "./contrast";
import { expandBase, POCKET_THEMES, SLATE } from "./palettes";
import { BUILT_IN, themePalette } from "./themes";

const failures = (p: Palette) => checkPalette(p).filter((r) => !r.pass).map((r) => `${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`);

describe("contrast math", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // Slate's light accent with its white label is 5.68:1, dark 7.58:1.
    expect(contrast(SLATE.light["on-accent"], SLATE.light.accent)).toBeCloseTo(5.68, 1);
    expect(contrast(SLATE.dark["on-accent"], SLATE.dark.accent)).toBeCloseTo(7.58, 1);
  });

  it("mixes like color-mix(in srgb) and lifts towards black on light backgrounds", () => {
    expect(over("#000000", "#ffffff", 0.5)).toBe("#808080");
    const lifted = lift("#999999", ["#ffffff"], 4.5);
    expect(contrast(lifted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(parseInt(lifted.slice(1, 3), 16)).toBeLessThan(0x99);
    expect(lift("#000000", ["#ffffff"], 4.5)).toBe("#000000"); // already fine: unchanged
  });

  it("resolves UI mixes over the surface they are drawn on", () => {
    const p = SLATE.light;
    expect(resolve(p, "hover@surface")).toBe(over(p.surface, p.text, UI_MIXES.hover.pct / 100));
    expect(resolve(p, "bg")).toBe(p.bg);
  });
});

describe("CodeEditor Slate", () => {
  it.each(["light", "dark"] as const)("%s passes every pair the UI draws, exactly as designed", (scheme) => {
    expect(failures(SLATE[scheme])).toEqual([]);
    expect(readablePalette(SLATE[scheme]).adjusted).toEqual([]);
  });

  it("checks the new UI pairs the brief lists (tree, tabs, lint, outlines, autocomplete, banner, receipt)", () => {
    const uses = PAIRS.map((p) => p.use).join("\n");
    for (const word of ["selected tree row", "active editor tab", "lint underline", "bracket outline", "autocomplete", "receipt chip", "status line", "Delete in a menu"]) {
      expect(uses, word).toContain(word);
    }
    expect(PAIRS.length).toBeGreaterThan(90);
  });

  it("tokens.css paints the same values as palettes.ts, light and dark", () => {
    const css = readFileSync("src/styles/tokens.css", "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      return css.slice(start, css.indexOf("}", start));
    };
    for (const [scheme, selector] of [["light", ":root {"], ["dark", ':root[data-theme="dark"] {']] as const) {
      for (const v of COLOR_VARS) expect(block(selector), `${scheme} --${v}`).toContain(`--${v}: ${SLATE[scheme][v]};`);
    }
  });

  it("tokens.css derives each UI mix exactly as the contrast check computes it", () => {
    const css = readFileSync("src/styles/tokens.css", "utf8");
    for (const [name, mix] of Object.entries(UI_MIXES)) {
      expect(css).toContain(`--${name}: color-mix(in srgb, var(--${mix.top}) ${mix.pct}%, transparent);`);
    }
  });

  it("theme-boot.js knows Slate's top-bar colours (no flash of the wrong toolbar colour)", () => {
    const boot = readFileSync("public/theme-boot.js", "utf8");
    expect(boot).toContain(`SLATE_SURFACE = { light: "${SLATE.light.surface}", dark: "${SLATE.dark.surface}" }`);
    expect(boot).toContain('"codeeditor:theme-paint"');
    expect(boot).toContain('"codeeditor:ligatures"');
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain(`content="${SLATE.light.surface}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${SLATE.dark.surface}" media="(prefers-color-scheme: dark)"`);
  });
});

describe("palette themes", () => {
  it.each(BUILT_IN.filter((t) => t.base).map((t) => [t.name, t] as const))("%s passes every pair after the guard", (_, theme) => {
    expect(failures(themePalette(theme).palette)).toEqual([]);
  });

  it("the guard keeps the theme's own colour where it already passes, and its hue where it lifts", () => {
    const dracula = POCKET_THEMES.find((t) => t.id === "dracula")!;
    const { palette, adjusted } = themePalette(dracula);
    expect(palette.bg).toBe(dracula.base.sheet);
    expect(palette["syn-string"]).toBe(dracula.base["syn-string"]);
    expect(adjusted).toContain("syn-comment"); // #6272a4 is too dim on the selection band
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(palette["syn-comment"].slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r); // still blue-violet
    expect(b).toBeGreaterThan(g);
  });

  it("a palette that fails is reported by checkPalette (the check can fail)", () => {
    const broken = { ...SLATE.light, "text-muted": "#c0c4cc" };
    expect(failures(broken).length).toBeGreaterThan(0);
    expect(failures(readablePalette(broken).palette)).toEqual([]);
  });

  it("expands Pocket Run's colours onto every variable of the contract", () => {
    const p = expandBase(POCKET_THEMES[0].base);
    expect(Object.keys(p).sort()).toEqual([...COLOR_VARS].sort());
    for (const v of COLOR_VARS) expect(p[v], v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("scripts/contrast-check.mjs", () => {
  it("passes for every theme and lists the pairs", () => {
    const out = execFileSync(process.execPath, ["scripts/contrast-check.mjs"], { encoding: "utf8", timeout: 60_000 });
    expect(out).toContain(`${PAIRS.length} pairs per theme`);
    expect(out).toContain("pass    CodeEditor Slate Light");
    expect(out).not.toMatch(/^FAIL/m);
  });

  it("exits with an error code and names the pair when a theme fails", () => {
    // Same script, with Slate's muted text made unreadable through a test-only override of the module.
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(s, c, n) { if (/^\\.{1,2}\\//.test(s) && !/\\.[cm]?[jt]s$/.test(s)) { try { return n(s + ".ts", c); } catch {} } return n(s, c); } });
      const { SLATE } = await import("./src/theme/palettes.ts");
      SLATE.light["text-muted"] = "#c0c4cc";
      await import("./scripts/contrast-check.mjs");
    `], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+\d+\s+CodeEditor Slate Light/);
    expect(run.stdout).toContain("text-muted #c0c4cc");
  });
});
