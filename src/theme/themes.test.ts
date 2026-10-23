/// <reference types="node" />
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPalette, COLOR_VARS, oklch } from "./contrast";
import { BASE_TOKENS, DEEP_FIELD, POCKET_THEMES, SLATE } from "./palettes";
import {
  applyTheme, BUILT_IN, CHOSEN_KEY, chosenTheme, DEFAULT_THEME_ID, PAINT_KEY, paintFor, parseThemeFile, SLATE_SYSTEM_ID, themePalette, themeTemplate,
  type Theme,
} from "./themes";

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const pocketFile = () => ({ name: "Forest", scheme: "dark", colors: { ...POCKET_THEMES.find((t) => t.id === "nord")!.base } });
const byId = (id: string) => BUILT_IN.find((t) => t.id === id)!;

/** A localStorage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

/** Just enough of a document for applyTheme() and theme-boot.js: <html> and the two theme-color metas. */
function fakeDocument() {
  const props = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const metas = ["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"].map((media) => {
    const attrs: Record<string, string> = { media, content: "" };
    return {
      media,
      get content() { return attrs.content; },
      set content(v: string) { attrs.content = v; },
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => void (attrs[k] = v),
    };
  });
  const documentElement = { dataset, style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } };
  return { document: { documentElement, querySelectorAll: () => metas }, props, dataset, metas };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("built-in themes", () => {
  it("defaults to CodeEditor Deep Field following the device, painted by tokens.css", () => {
    const def = byId(DEFAULT_THEME_ID);
    expect(def.id).toBe("deep-field");
    expect(def.name).toBe("CodeEditor Deep Field (match device)");
    expect(def.system).toBe(true);
    expect(def.own).toBe("deep-field");
    expect(def.base).toBeUndefined();
    expect(paintFor(def)).toMatchObject({ palette: "deep-field", colors: null }); // no inline colours
    expect(themePalette(def, "dark").palette).toEqual(DEEP_FIELD.dark);
  });

  it("keeps CodeEditor Slate as a picker theme with its ids unchanged", () => {
    expect(SLATE_SYSTEM_ID).toBe("system");
    for (const [id, name, system] of [["system", "CodeEditor Slate (match device)", true], ["slate-light", "CodeEditor Slate Light", false], ["slate-dark", "CodeEditor Slate Dark", false]] as const) {
      const t = byId(id);
      expect(t, id).toMatchObject({ name, own: "slate", group: "codeeditor" });
      expect(Boolean(t.system), id).toBe(system);
      expect(paintFor(t)).toMatchObject({ palette: "slate", colors: null });
    }
    expect(themePalette(byId("slate-dark")).palette).toEqual(SLATE.dark);
  });

  it("lists CodeEditor's group in order: Deep Field x3, Slate x3, High contrast", () => {
    expect(BUILT_IN.filter((t) => t.group === "codeeditor").map((t) => t.id)).toEqual([
      "deep-field", "deep-field-light", "deep-field-dark", "system", "slate-light", "slate-dark", "high-contrast",
    ]);
  });

  it("offers Pocket Run's palettes, each with a unique id", () => {
    const ids = BUILT_IN.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["tokyo-night", "dracula", "one-dark-pro", "github-dark", "catppuccin-mocha", "rose-pine", "nord", "gruvbox-dark", "kanagawa", "everforest-dark", "ayu-dark", "night-owl", "solarized-light"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("offers the themes added after Pocket Run's, each in its scheme and next to its family", () => {
    const added = {
      "tokyo-night-storm": "dark", "catppuccin-macchiato": "dark", "catppuccin-frappe": "dark", "rose-pine-moon": "dark",
      "kanagawa-dragon": "dark", "kanagawa-lotus": "light", "everforest-light": "light", "ayu-light": "light", vesper: "dark",
      poimandres: "dark", "vitesse-dark": "dark", "vitesse-light": "light", "flexoki-dark": "dark", "flexoki-light": "light", nightfox: "dark",
    } as const;
    for (const [id, scheme] of Object.entries(added)) expect(byId(id), id).toMatchObject({ scheme });
    // Pocket Run's 21 (High contrast among them) and these 15; the README's theme table names the same 36.
    expect(POCKET_THEMES).toHaveLength(36);
    const order = POCKET_THEMES.map((t) => t.id);
    for (const [family, member] of [["tokyo-night", "tokyo-night-storm"], ["catppuccin-mocha", "catppuccin-macchiato"], ["rose-pine", "rose-pine-moon"], ["kanagawa", "kanagawa-dragon"], ["everforest-dark", "everforest-light"], ["ayu-mirage", "ayu-light"]]) {
      expect(order.indexOf(member), member).toBe(order.indexOf(family) + 1);
      expect(byId(member).group, member).toBe(byId(family).group);
    }
  });

  it("a palette theme paints inline colours and its own scheme", () => {
    const tokyo = byId("tokyo-night");
    const paint = paintFor(tokyo);
    expect(paint.scheme).toBe("dark");
    expect(paint.palette).toBe("palette");
    expect(paint.colors?.bg).toBe("#1a1b26");
  });

  it("a device that saved Slate's 'match device' (the old default) stays on Slate; nothing saved gets Deep Field", () => {
    vi.stubGlobal("localStorage", memoryStorage({ [CHOSEN_KEY]: "system" }));
    expect(chosenTheme()).toMatchObject({ id: "system", own: "slate", system: true });
    vi.stubGlobal("localStorage", memoryStorage());
    expect(chosenTheme()).toMatchObject({ id: "deep-field", own: "deep-field", system: true });
    vi.stubGlobal("localStorage", memoryStorage({ [CHOSEN_KEY]: "no-such-theme" }));
    expect(chosenTheme().id).toBe("deep-field");
  });
});

describe("applyTheme", () => {
  const paint = (theme: Theme, dark = false) => {
    const doc = fakeDocument();
    const storage = memoryStorage();
    vi.stubGlobal("document", doc.document);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q.includes("dark") }));
    doc.props.set("--bg", "#123456"); // left over from a palette theme
    applyTheme(theme);
    return { ...doc, stored: JSON.parse(storage.data.get(PAINT_KEY)!) };
  };

  it("Deep Field: no data-palette, no inline colours, the toolbar colour per scheme", () => {
    const r = paint(byId("deep-field"), true);
    expect(r.dataset.theme).toBe("dark");
    expect("palette" in r.dataset).toBe(false);
    expect(r.props.size).toBe(0);
    expect(r.metas.map((m) => m.content)).toEqual([DEEP_FIELD.light.surface, DEEP_FIELD.dark.surface]);
    expect(r.stored).toEqual({ system: true, scheme: "dark", palette: "deep-field", colors: null });
  });

  it("Slate: data-palette=slate, no inline colours, Slate's toolbar colour", () => {
    const r = paint(byId("slate-dark"));
    expect(r.dataset).toMatchObject({ theme: "dark", palette: "slate" });
    expect(r.props.size).toBe(0);
    expect(r.metas.map((m) => m.content)).toEqual([SLATE.dark.surface, SLATE.dark.surface]);
  });

  it("a palette theme: data-palette=palette and all 42 colours inline", () => {
    const dracula = byId("dracula");
    const r = paint(dracula);
    expect(r.dataset).toMatchObject({ theme: "dark", palette: "palette" });
    expect([...r.props.keys()].sort()).toEqual(COLOR_VARS.map((v) => `--${v}`).sort());
    expect(r.props.get("--bg")).toBe("#282a36");
    expect(r.metas.map((m) => m.content)).toEqual([themePalette(dracula).palette.surface, themePalette(dracula).palette.surface]);
  });
});

describe("public/theme-boot.js (runs before any module)", () => {
  const source = readFileSync("public/theme-boot.js", "utf8");
  const boot = (stored: Record<string, string>, dark: boolean) => {
    const doc = fakeDocument();
    runInNewContext(source, { document: doc.document, localStorage: memoryStorage(stored), matchMedia: (q: string) => ({ matches: dark && q.includes("dark") }) });
    return doc;
  };
  const paintOf = (theme: Theme, scheme: "light" | "dark") => JSON.stringify({ ...paintFor(theme), scheme });

  it("nothing stored: Deep Field following the device, no data-palette", () => {
    for (const dark of [false, true]) {
      const r = boot({}, dark);
      expect(r.dataset.theme).toBe(dark ? "dark" : "light");
      expect("palette" in r.dataset).toBe(false);
      expect(r.props.size).toBe(0);
      expect(r.metas.map((m) => m.getAttribute("content"))).toEqual([DEEP_FIELD.light.surface, DEEP_FIELD.dark.surface]);
    }
  });

  it("a payload written before Deep Field (no palette field) paints Slate, its 'match device' included", () => {
    const r = boot({ "codeeditor:theme-paint": JSON.stringify({ system: true, scheme: "light", colors: null }) }, true);
    expect(r.dataset).toMatchObject({ theme: "dark", palette: "slate" });
    expect(r.metas.map((m) => m.getAttribute("content"))).toEqual([SLATE.light.surface, SLATE.dark.surface]);
    const fixed = boot({ "codeeditor:theme-paint": JSON.stringify({ system: false, scheme: "dark", colors: null }) }, false);
    expect(fixed.dataset).toMatchObject({ theme: "dark", palette: "slate" });
  });

  it("repaints what applyTheme() stored: Slate, Deep Field and a palette theme (band alpha only on bands)", () => {
    expect(boot({ "codeeditor:theme-paint": paintOf(byId("slate-light"), "light") }, true).dataset).toMatchObject({ theme: "light", palette: "slate" });
    const deep = boot({ "codeeditor:theme-paint": paintOf(byId("deep-field-dark"), "dark") }, false);
    expect(deep.dataset.theme).toBe("dark");
    expect("palette" in deep.dataset).toBe(false);
    const dracula = byId("dracula");
    const stored = JSON.parse(paintOf(dracula, "dark"));
    stored.colors.text = "#f8f8f2aa"; // alpha on a non-band token: refused
    stored.colors.bg = "url(x)"; // not a colour: refused
    const r = boot({ "codeeditor:theme-paint": JSON.stringify(stored) }, false);
    expect(r.dataset).toMatchObject({ theme: "dark", palette: "palette" });
    expect(r.props.get("--active-line")).toBe(themePalette(dracula).palette["active-line"]);
    expect(r.props.get("--active-line")).toHaveLength(9);
    expect(r.props.has("--text")).toBe(false);
    expect(r.props.has("--bg")).toBe(false);
    expect(r.props.size).toBe(COLOR_VARS.length - 2);
  });

  it("an unknown palette name falls back to Deep Field", () => {
    const r = boot({ "codeeditor:theme-paint": JSON.stringify({ system: false, scheme: "light", palette: "evil", colors: null }) }, false);
    expect("palette" in r.dataset).toBe(false);
    expect(r.dataset.theme).toBe("light");
  });

  it("applies the 42 colour names only: a layout or size token given a colour (a tampered payload) is refused", () => {
    const stored = JSON.parse(paintOf(byId("dracula"), "dark"));
    stored.colors["h-topbar"] = "#000000";
    stored.colors["code-size"] = "#000000";
    stored.colors["fs-1"] = "#000000";
    const r = boot({ "codeeditor:theme-paint": JSON.stringify(stored) }, false);
    for (const name of ["--h-topbar", "--code-size", "--fs-1"]) expect(r.props.has(name), name).toBe(false);
    expect([...r.props.keys()].sort()).toEqual(COLOR_VARS.map((v) => `--${v}`).sort());
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
    ["a translucent colour", { ...pocketFile(), colors: { ...pocketFile().colors, sheet: "#1e1e2e80" } }, /must be colours/],
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

  it("the template round-trips: an own palette's colours come back from a file, moved only where the guard must", () => {
    // The file carries 21 colours; the token each one becomes.
    const FILE_TO_TOKEN = {
      paper: "surface", sheet: "bg", bar: "surface-raised", ink: "text", muted: "text-muted", rule: "border", accent: "action",
      "on-accent": "on-action", ok: "success", err: "danger", warn: "warning", "syn-keyword": "syn-keyword", "syn-string": "syn-string",
      "syn-number": "syn-number", "syn-comment": "syn-comment", "syn-def": "syn-function", "syn-type": "syn-type", "syn-variable": "syn-variable",
      "syn-operator": "syn-operator", "syn-macro": "syn-macro", "syn-punctuation": "syn-punctuation",
    } as const;
    for (const [label, palette, scheme] of [["Slate light", SLATE.light, "light"], ["Slate dark", SLATE.dark, "dark"], ["Deep Field light", DEEP_FIELD.light, "light"], ["Deep Field dark", DEEP_FIELD.dark, "dark"]] as const) {
      const text = themeTemplate(`My ${label}`, scheme, palette);
      const data = JSON.parse(text);
      expect(Object.keys(data.colors).sort(), label).toEqual(Object.keys(FILE_TO_TOKEN).sort());
      for (const k of BASE_TOKENS) expect(data.colors[k], `${label} ${k}`).toBe(palette[FILE_TO_TOKEN[k]]);
      const parsed = parseThemeFile(new TextEncoder().encode(text));
      expect(parsed.ok, label).toBe(true);
      if (!parsed.ok) continue;
      const { palette: back, adjusted } = themePalette(parsed.theme);
      expect(back, label).toMatchObject({ bg: palette.bg, surface: palette.surface, text: palette.text, action: palette.action, "on-action": palette["on-action"], danger: palette.danger });
      // The 16-colour format derives its own bands (an opaque 18% selection under a 14% error band),
      // darker in light mode than the own palettes' tuned ones, so the guard may lift syntax
      // colours there: by small steps, hue kept, and reported. Everything else comes back exactly.
      for (const token of Object.values(FILE_TO_TOKEN)) {
        if (!adjusted.includes(token)) {
          expect(back[token], `${label} ${token}`).toBe(palette[token]);
          continue;
        }
        expect(token, `${label}: only syntax colours move`).toMatch(/^syn-/);
        const [was, now] = [oklch(palette[token]), oklch(back[token])];
        expect(Math.abs(was.h - now.h), `${label} ${token} keeps its hue`).toBeLessThan(5);
        expect(was.L - now.L, `${label} ${token} moves a small step`).toBeLessThan(0.05);
      }
    }
    // Slate dark's colours all pass the derived bands: its file comes back exactly.
    const dark = parseThemeFile(new TextEncoder().encode(themeTemplate("My Slate", "dark", SLATE.dark)));
    expect(dark.ok && themePalette(dark.theme).adjusted).toEqual([]);
  });
});
