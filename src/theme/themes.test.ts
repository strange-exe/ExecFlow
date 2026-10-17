import { describe, expect, it } from "vitest";
import { checkPalette } from "./contrast";
import { BASE_TOKENS, POCKET_THEMES, SLATE } from "./palettes";
import { BUILT_IN, DEFAULT_THEME_ID, parseThemeFile, paintFor, themePalette, themeTemplate } from "./themes";

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const pocketFile = () => ({ name: "Forest", scheme: "dark", colors: { ...POCKET_THEMES.find((t) => t.id === "nord")!.base } });

describe("built-in themes", () => {
  it("defaults to CodeEditor Slate following the device", () => {
    const def = BUILT_IN.find((t) => t.id === DEFAULT_THEME_ID)!;
    expect(def.system).toBe(true);
    expect(def.base).toBeUndefined();
    expect(paintFor(def).colors).toBeNull(); // tokens.css paints it, no inline colours
  });

  it("offers Pocket Run's palettes, each with a unique id", () => {
    const ids = BUILT_IN.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["tokyo-night", "dracula", "one-dark-pro", "github-dark", "catppuccin-mocha", "rose-pine", "nord", "gruvbox-dark", "kanagawa", "everforest-dark", "ayu-dark", "night-owl", "solarized-light"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("a palette theme paints inline colours and its own scheme", () => {
    const tokyo = BUILT_IN.find((t) => t.id === "tokyo-night")!;
    const paint = paintFor(tokyo);
    expect(paint.scheme).toBe("dark");
    expect(paint.colors?.bg).toBe("#1a1b26");
  });
});

describe("theme files", () => {
  it("loads a Pocket Run theme file unchanged, and the result is readable", () => {
    const parsed = parseThemeFile(json(pocketFile()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.id).toBe("custom:forest");
    expect(parsed.theme.custom).toBe(true);
    expect(checkPalette(themePalette(parsed.theme).palette).filter((r) => !r.pass)).toEqual([]);
  });

  it("accepts CodeEditor's extra syntax colours", () => {
    const file = pocketFile();
    const parsed = parseThemeFile(json({ ...file, colors: { ...file.colors, "syn-type": "#e5c07b" } }));
    expect(parsed.ok && themePalette(parsed.theme).palette["syn-type"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each([
    ["an unknown setting", { ...pocketFile(), css: "body{}" }, /Unknown setting/],
    ["a missing colour", { ...pocketFile(), colors: { paper: "#000000" } }, /Missing colours/],
    ["an unknown colour name", { ...pocketFile(), colors: { ...pocketFile().colors, background: "#000000" } }, /Unknown colour name/],
    ["a colour that isn't #rrggbb", { ...pocketFile(), colors: { ...pocketFile().colors, ink: "url(javascript:alert(1))" } }, /must be colours/],
    ["a bad scheme", { ...pocketFile(), scheme: "dim" }, /scheme/],
    ["no name", { ...pocketFile(), name: "  " }, /name/],
  ])("refuses %s", (_, data, error) => {
    const parsed = parseThemeFile(json(data));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("refuses files that aren't JSON, are too big, or hide characters", () => {
    expect(parseThemeFile(new TextEncoder().encode("{nope")).ok).toBe(false);
    expect(parseThemeFile(new Uint8Array(17 * 1024).fill(32)).ok).toBe(false);
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(parseThemeFile(json({ ...pocketFile(), name: `For${zeroWidth}est` })).ok).toBe(false);
  });

  it("a key whose JSON escape decodes to a direction character is named with it made visible", () => {
    // The file's bytes are plain ASCII (the six characters backslash-u-2-0-2-e), so checkBytes passes.
    const escape = `${String.fromCodePoint(0x5c)}u202e`;
    const rlo = String.fromCodePoint(0x202e);
    const text = JSON.stringify(pocketFile()).replace(/}$/, `,"${escape}evil":1}`);
    const colours = JSON.stringify({ ...pocketFile(), colors: { ...pocketFile().colors } }).replace(/"colors":\{/, `"colors":{"${escape}x":"#000000",`);
    for (const file of [text, colours]) {
      const parsed = parseThemeFile(new TextEncoder().encode(file));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).not.toContain(rlo);
      expect(parsed.error).toContain("[U+202E]");
    }
  });

  it("strips anything but letters, digits and simple punctuation from the name", () => {
    const parsed = parseThemeFile(json({ ...pocketFile(), name: "<img src=x onerror=alert(1)> Mine" }));
    expect(parsed.ok && parsed.theme.name).not.toMatch(/[<>=]/);
  });

  it("the template round-trips: Slate's own colours come back from a file", () => {
    const text = themeTemplate("My Slate", "light", SLATE.light);
    const data = JSON.parse(text);
    expect(Object.keys(data.colors)).toEqual(expect.arrayContaining([...BASE_TOKENS]));
    const parsed = parseThemeFile(new TextEncoder().encode(text));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(themePalette(parsed.theme).palette).toMatchObject({ bg: SLATE.light.bg, text: SLATE.light.text, "syn-type": SLATE.light["syn-type"] });
  });
});
