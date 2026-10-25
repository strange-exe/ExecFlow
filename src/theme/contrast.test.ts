/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALPHA_OK, checkPalette, checkRules, COLOR_VARS, contrast, IMAGE_MIXES, isTokenValue, lift, over, PAIRS, readablePalette, resolve, UI_MIXES, type Palette,
} from "./contrast";
import { DEEP_FIELD, expandBase, POCKET_THEMES, SIGNAL, SLATE } from "./palettes";
import { BUILT_IN, themePalette } from "./themes";

const failures = (p: Palette) => checkPalette(p).filter((r) => !r.pass).map((r) => `${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`);
const SCHEMES = ["light", "dark"] as const;

describe("contrast math", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // Slate's Run label on its azure fill: light 5.59:1 (#fdfdff, no longer pure white), dark 7.58:1.
    expect(contrast(SLATE.light["on-action"], SLATE.light.action)).toBeCloseTo(5.59, 2);
    expect(contrast(SLATE.dark["on-action"], SLATE.dark.action)).toBeCloseTo(7.58, 2);
    // Deep Field's: the deep spruce fill in light 9.25:1, the pale celadon fill in dark 12.13:1.
    expect(contrast(DEEP_FIELD.light["on-action"], DEEP_FIELD.light.action)).toBeCloseTo(9.25, 2);
    expect(contrast(DEEP_FIELD.dark["on-action"], DEEP_FIELD.dark.action)).toBeCloseTo(12.13, 2);
  });

  it("mixes like color-mix(in srgb) and lifts towards black on light backgrounds", () => {
    expect(over("#000000", "#ffffff", 0.5)).toBe("#808080");
    const lifted = lift("#999999", ["#ffffff"], 4.5);
    expect(contrast(lifted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(parseInt(lifted.slice(1, 3), 16)).toBeLessThan(0x99);
    expect(lift("#000000", ["#ffffff"], 4.5)).toBe("#000000"); // already fine: unchanged
  });

  it("resolves UI mixes over the surface they are drawn on", () => {
    const p = DEEP_FIELD.light;
    expect(resolve(p, "hover@surface")).toBe(over(p.surface, p.text, UI_MIXES.hover.pct / 100));
    expect(resolve(p, "bg")).toBe(p.bg);
  });

  it("resolves the snippet image's mixes over the code ground (the highlight band and the background)", () => {
    expect(IMAGE_MIXES).toEqual({ mark: { top: "focus", pct: 12 }, mat: { top: "action", pct: 25 } });
    expect(resolve(DEEP_FIELD.light, "mark@bg")).toBe("#e9e9db");
    expect(resolve(DEEP_FIELD.dark, "mark@bg")).toBe("#2c3324");
    expect(resolve(DEEP_FIELD.light, "mat@bg")).toBe("#bad0c9");
    expect(resolve(SLATE.dark, "mat@bg")).toBe(over(SLATE.dark.bg, SLATE.dark.action, 0.25));
  });

  it("paints a band alone over its own ground, and stacks right to left", () => {
    const p = DEEP_FIELD.light;
    const band = (hex: string) => [hex.slice(0, 7), parseInt(hex.slice(7), 16) / 255] as const;
    const [selection, a] = band(p.selection);
    expect(resolve(p, "selection")).toBe(over(p.bg, selection, a));
    const [listSelected, b] = band(p["list-selected"]);
    expect(resolve(p, "list-selected")).toBe(over(p.surface, listSelected, b));
    // The same hexes the design record's checker (.claude/design/redesign/check-contrast.mjs) printed.
    expect(resolve(p, "error-band@selection@bg")).toBe("#f4d1c9");
    expect(resolve(p, "list-selected@surface")).toBe("#c3ddd0");
    expect(resolve(p, "hover@error-band@runlog-bg")).toBe("#e7cbce");
    expect(resolve(p, "active-line@selection@bg")).toBe("#eae9d8");
    expect(resolve(DEEP_FIELD.dark, "error-band@selection@bg")).toBe("#61312a");
    expect(resolve(DEEP_FIELD.dark, "error-band@bg")).toBe("#4f2327");
  });

  it("accepts alpha only on the four band tokens", () => {
    expect(isTokenValue("bg", "#f8fbf9")).toBe(true);
    expect(isTokenValue("bg", "#f8fbf980")).toBe(false);
    for (const band of ALPHA_OK) expect(isTokenValue(band, "#f8fbf980"), band).toBe(true);
    expect(isTokenValue("text", "url(javascript:alert(1))")).toBe(false);
    expect(isTokenValue("text", "red")).toBe(false);
    expect(isTokenValue("accent", "#0062d4"), "a v1 name is not a token any more").toBe(false);
    expect(isTokenValue("bg", undefined)).toBe(false);
  });
});

describe("the pairs the UI draws (contract v2)", () => {
  it("has the 200 rows of the contract, 196 of them unique, every ground a known token or mix", () => {
    expect(PAIRS.length).toBe(200);
    expect(new Set(PAIRS.map((p) => `${p.fg}|${p.bg}|${p.min}`)).size).toBe(196);
    const known: readonly string[] = [...COLOR_VARS, ...Object.keys(UI_MIXES), ...Object.keys(IMAGE_MIXES)];
    for (const p of PAIRS) for (const part of p.bg.split("@")) expect(known, `${p.bg}`).toContain(part);
    // Pinned rows: the first, the re-grounded panel-tab row, the last of v2 and the last.
    expect(PAIRS[0]).toMatchObject({ fg: "text", bg: "bg", min: 4.5 });
    expect(PAIRS[44]).toMatchObject({ fg: "location", bg: "surface", min: 3 });
    expect(PAIRS[184]).toMatchObject({ fg: "text-secondary", bg: "hover@error-band@runlog-bg", min: 4.5 });
    expect(PAIRS[197]).toMatchObject({ fg: "danger", bg: "mark@bg", min: 4.5 });
    // The window bar's other ground (snippet-render.ts windowBarGround): its name and placeholders at the text minimum.
    expect(PAIRS.slice(198)).toMatchObject([{ fg: "text-secondary", bg: "hover@surface", min: 4.5 }, { fg: "danger", bg: "hover@surface", min: 4.5 }]);
    // The snippet image's highlighted lines: every colour drawn on the band, at the text minimum.
    expect(PAIRS.filter((p) => p.bg === "mark@bg").map((p) => p.fg).sort()).toEqual(
      ["danger", "gutter-text", "syn-comment", "syn-function", "syn-keyword", "syn-macro", "syn-number", "syn-operator", "syn-punctuation", "syn-string", "syn-type", "syn-variable", "text"],
    );
  });

  it("never uses a band token as a foreground (bands are grounds)", () => {
    expect(PAIRS.filter((p) => (ALPHA_OK as readonly string[]).includes(p.fg)).map((p) => `${p.fg} on ${p.bg}`)).toEqual([]);
  });

  it("checks the UI pairs the brief lists (tree, tabs, lint, outlines, suggestions, run log, menus, error marks)", () => {
    const uses = PAIRS.map((p) => p.use).join("\n");
    for (const word of ["selected tree row", "active editor tab", "lint underline", "bracket outline", "suggestion list", "run-log header", "Delete in a menu", "error line", "call-site", "error jump"]) {
      expect(uses, word).toContain(word);
    }
  });
});

describe("CodeEditor Deep Field (the default)", () => {
  it.each(SCHEMES)("%s passes every pair the UI draws, exactly as designed", (scheme) => {
    expect(failures(DEEP_FIELD[scheme])).toEqual([]);
    expect(readablePalette(DEEP_FIELD[scheme]).adjusted).toEqual([]);
  });

  it.each(SCHEMES)("%s keeps every role distinct and every region step and band visible", (scheme) => {
    const { distinct, steps } = checkRules(DEEP_FIELD[scheme], { scheme, separation: "surface" });
    expect(distinct).toHaveLength(13);
    // 13 light, 15 dark, each with the snippet image's highlight band and background (batch 3).
    expect(steps).toHaveLength(scheme === "light" ? 15 : 17);
    expect(steps.filter((s) => s.a === "mark@bg" || s.a === "mat@bg").map((s) => `${s.a} ${s.pass}`)).toEqual(["mark@bg true", "mat@bg true"]);
    expect([...distinct, ...steps].filter((r) => !r.pass).map((r) => `${r.a} vs ${r.b}`)).toEqual([]);
  });

  it("has no pure black or white, and alpha only on the four band tokens", () => {
    for (const scheme of SCHEMES) {
      for (const v of COLOR_VARS) {
        const value = DEEP_FIELD[scheme][v];
        expect(isTokenValue(v, value), `${scheme} --${v} ${value}`).toBe(true);
        expect(["#000000", "#ffffff"], `${scheme} --${v}`).not.toContain(value.slice(0, 7));
      }
    }
  });
});

describe("CodeEditor Signal (the default)", () => {
  it.each(SCHEMES)("%s passes every pair the UI draws, exactly as designed", (scheme) => {
    expect(failures(SIGNAL[scheme])).toEqual([]);
    expect(readablePalette(SIGNAL[scheme]).adjusted).toEqual([]);
  });

  it.each(SCHEMES)("%s keeps every role distinct and every region step and band visible (separation: surface)", (scheme) => {
    const { distinct, steps } = checkRules(SIGNAL[scheme], { scheme, separation: "surface" });
    expect(distinct).toHaveLength(13);
    expect(steps).toHaveLength(scheme === "light" ? 15 : 17);
    expect([...distinct, ...steps].filter((r) => !r.pass).map((r) => `${r.a} vs ${r.b}`)).toEqual([]);
  });

  it("is a valid token for every name, alpha only on the four band tokens", () => {
    for (const scheme of SCHEMES) {
      for (const v of COLOR_VARS) {
        const value = SIGNAL[scheme][v];
        expect(isTokenValue(v, value), `${scheme} --${v} ${value}`).toBe(true);
        expect(value.length === 9, `${scheme} --${v} translucent`).toBe((ALPHA_OK as readonly string[]).includes(v));
      }
    }
  });

  it("one electric blue for the action, location and checked controls; a teal focus apart from it", () => {
    for (const scheme of SCHEMES) {
      const p = SIGNAL[scheme];
      expect(p.location, scheme).toBe(p.action);
      expect(p["control-on"], scheme).toBe(p.action);
      expect(p.focus, scheme).not.toBe(p.action);
      expect(p["input-echo"], scheme).toBe(p.focus);
    }
    expect(contrast(SIGNAL.light["on-action"], SIGNAL.light.action)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(SIGNAL.dark["on-action"], SIGNAL.dark.action)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("CodeEditor Slate (a picker theme)", () => {
  it.each(SCHEMES)("%s passes every pair as designed (nothing moved)", (scheme) => {
    expect(failures(SLATE[scheme])).toEqual([]);
    expect(readablePalette(SLATE[scheme]).adjusted).toEqual([]);
  });

  it.each(SCHEMES)("%s fixes the defects: the selection shows on the cursor and error lines, and the band is a red band", (scheme) => {
    const { steps } = checkRules(SLATE[scheme], { scheme, separation: "surface" });
    const defects = steps.filter((s) => /^(active-line@selection@bg|error-band@)/.test(s.a));
    // selection on the cursor line, on the error line; band vs bg, active line, selection; band chroma x3.
    expect(defects.map((s) => `${s.a} vs ${s.b}`)).toEqual([
      "error-band@bg vs bg", "error-band@bg vs active-line@bg", "active-line@selection@bg vs active-line@bg",
      "error-band@selection@bg vs error-band@bg", "error-band@bg vs selection@bg",
      "error-band@bg vs danger", "error-band@surface vs danger", "error-band@runlog-bg vs danger",
    ]);
    expect(defects.filter((s) => !s.pass).map((s) => `${s.a} vs ${s.b}`)).toEqual([]);
  });

  it("misses only the distinctness rules that are its v1 identity (one azure)", () => {
    for (const scheme of SCHEMES) {
      const { distinct } = checkRules(SLATE[scheme], { scheme, separation: "surface" });
      // A pinned list: a new muddle fails here.
      expect(distinct.filter((r) => !r.pass).map((r) => `${r.a}/${r.b}`), scheme).toEqual(["focus/action", "focus/location", "syn-function/action"]);
    }
  });
});

describe("tokens.css and the first paint", () => {
  const css = readFileSync("src/styles/tokens.css", "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(selector);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };

  it("paints the same values as palettes.ts: Signal, Deep Field and Slate, light and dark", () => {
    const blocks = [
      [DEEP_FIELD.light, ":root {"],
      [DEEP_FIELD.dark, ':root[data-theme="dark"] {'],
      [SIGNAL.light, ':root[data-palette="signal"] {'],
      [SIGNAL.dark, ':root[data-palette="signal"][data-theme="dark"] {'],
      [SLATE.light, ':root[data-palette="slate"] {'],
      [SLATE.dark, ':root[data-palette="slate"][data-theme="dark"] {'],
    ] as const;
    for (const [palette, selector] of blocks) {
      const text = block(selector);
      for (const v of COLOR_VARS) expect(text, `${selector} --${v}`).toContain(`\n  --${v}: ${palette[v]};\n`);
      // Exactly the 42 colour tokens (and no v1 name such as --accent).
      const declared = [...text.matchAll(/\n {2}--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => !["scrim", "shadow-pop", "status-edge"].includes(n));
      expect(declared.sort(), selector).toEqual([...COLOR_VARS].sort());
    }
  });

  it("e2e/signal.spec.ts checks Signal's own values (its copy, written out so the spec can fail on any build)", () => {
    const spec = readFileSync("e2e/signal.spec.ts", "utf8");
    for (const scheme of SCHEMES) {
      const line = new RegExp(`^  ${scheme}: \\{([^}]+)\\}`, "m").exec(spec)?.[1] ?? "";
      const pairs = [...line.matchAll(/([a-z-]+): "(#[0-9a-f]{6})"/g)];
      expect(pairs.length, scheme).toBeGreaterThanOrEqual(6);
      for (const [, name, hex] of pairs) expect(hex, `${scheme} ${name}`).toBe(SIGNAL[scheme][name as keyof Palette]);
    }
  });

  it("derives each UI mix exactly as the contrast check computes it", () => {
    for (const [name, mix] of Object.entries(UI_MIXES)) {
      expect(css).toContain(`--${name}: color-mix(in srgb, var(--${mix.top}) ${mix.pct}%, transparent);`);
    }
  });

  it("theme-boot.js knows the three own palettes' chrome colours, and index.html starts on Signal's, the default's (no flash)", () => {
    const boot = readFileSync("public/theme-boot.js", "utf8");
    expect(boot).toContain(
      `OWN_SURFACE = { signal: { light: "${SIGNAL.light.surface}", dark: "${SIGNAL.dark.surface}" }, "deep-field": { light: "${DEEP_FIELD.light.surface}", dark: "${DEEP_FIELD.dark.surface}" }, slate: { light: "${SLATE.light.surface}", dark: "${SLATE.dark.surface}" } }`,
    );
    expect(boot).toContain('"codeeditor:theme-paint"');
    expect(boot).toContain('"codeeditor:ligatures"');
    const bands = /BANDS = \{ ([^}]+) \}/.exec(boot)?.[1] ?? "";
    expect(bands.split(",").map((s) => s.trim().split(":")[0].replace(/"/g, "")).sort()).toEqual([...ALPHA_OK].sort());
    // It paints the colour contract's names and nothing else (review S, 2026-10-18).
    const colors = /COLORS = "([a-z0-9 -]+)"/.exec(boot)?.[1] ?? "";
    expect(colors.split(" ")).toEqual([...COLOR_VARS]);
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain(`content="${SIGNAL.light.surface}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${SIGNAL.dark.surface}" media="(prefers-color-scheme: dark)"`);
    // The installed app's title bar and splash screen (the web app manifest in vite.config.ts): the
    // default's dark chrome and code ground, as for the toolbar's dark side.
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toContain(`theme_color: "${SIGNAL.dark.surface}"`);
    expect(config).toContain(`background_color: "${SIGNAL.dark.bg}"`);
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
    expect(adjusted).toContain("syn-comment"); // #6272a4 is too dim on the selection and error bands
    expect(palette["syn-comment"]).not.toBe(dracula.base["syn-comment"]);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(palette["syn-comment"].slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r); // still blue-violet
    expect(b).toBeGreaterThan(g);
  });

  it("a palette that fails is reported by checkPalette (the check can fail), and the guard repairs it", () => {
    const broken = { ...DEEP_FIELD.light, "text-muted": "#c0c4cc" };
    expect(failures(broken).length).toBeGreaterThan(0);
    expect(failures(readablePalette(broken).palette)).toEqual([]);
  });

  it("expands Pocket Run's colours onto every variable of the contract, alpha only on the four bands", () => {
    for (const theme of POCKET_THEMES) {
      const p = expandBase(theme.base);
      expect(Object.keys(p).sort(), theme.id).toEqual([...COLOR_VARS].sort());
      for (const v of COLOR_VARS) {
        expect(isTokenValue(v, p[v]), `${theme.id} --${v} ${p[v]}`).toBe(true);
        expect(p[v].length === 9, `${theme.id} --${v} translucent`).toBe(["active-line", "list-selected", "error-band"].includes(v));
      }
    }
  });

  it("the guard picks a readable brand glyph when the tile and glyph are too close", () => {
    const p = { ...DEEP_FIELD.light, brand: "#808080", "on-brand": "#888888" };
    const { palette, adjusted } = readablePalette(p);
    expect(adjusted).toContain("on-brand");
    expect(palette.brand).toBe("#808080"); // the tile never moves
    expect(contrast(palette["on-brand"], palette.brand)).toBeGreaterThanOrEqual(3);
  });
});

describe("scripts/contrast-check.mjs", () => {
  it("passes for every theme and lists the pairs", () => {
    const out = execFileSync(process.execPath, ["scripts/contrast-check.mjs"], { encoding: "utf8", timeout: 60_000 });
    expect(out).toContain(`${PAIRS.length} pairs per theme`);
    expect(out).toContain("pass    CodeEditor Signal Light");
    expect(out).toContain("pass    CodeEditor Signal Dark");
    expect(out).toContain("pass    CodeEditor Deep Field Light");
    expect(out).toContain("pass    CodeEditor Deep Field Dark");
    expect(out).toContain("pass    CodeEditor Slate Light");
    expect(out).not.toMatch(/^FAIL/m);
    // Signal, like Deep Field, is held to every rule; only Slate's misses are reported.
    const after = (name: string) => out.slice(out.indexOf(name)).split("\n")[1];
    for (const name of ["CodeEditor Signal Light", "CodeEditor Signal Dark"]) {
      expect(after(name), name).toContain("rules: every distinctness rule and region step passes");
      expect(after(name), name).not.toContain("reported only");
    }
  });

  it("fails when Signal misses a distinctness rule (a rule miss in an own palette other than Slate is an error)", () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(s, c, n) { if (/^\\.{1,2}\\//.test(s) && !/\\.[cm]?[jt]s$/.test(s)) { try { return n(s + ".ts", c); } catch {} } return n(s, c); } });
      const { SIGNAL } = await import("./src/theme/palettes.ts");
      SIGNAL.dark.focus = SIGNAL.dark.action;
      SIGNAL.dark["input-echo"] = SIGNAL.dark.action;
      await import("./scripts/contrast-check.mjs");
    `], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/CodeEditor Signal Dark[^\n]*\n\s+rules: missed [^\n]*focus/);
  });

  it("exits with an error code and names the pair when a theme fails", () => {
    // Same script, with Deep Field's muted text made unreadable through a test-only override of the module.
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(s, c, n) { if (/^\\.{1,2}\\//.test(s) && !/\\.[cm]?[jt]s$/.test(s)) { try { return n(s + ".ts", c); } catch {} } return n(s, c); } });
      const { DEEP_FIELD } = await import("./src/theme/palettes.ts");
      DEEP_FIELD.light["text-muted"] = "#c0c4cc";
      await import("./scripts/contrast-check.mjs");
    `], { encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+\d+\s+CodeEditor Deep Field Light/);
    expect(run.stdout).toContain("text-muted #c0c4cc");
  });
});
