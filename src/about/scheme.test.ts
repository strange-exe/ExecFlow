/// <reference types="node" />
// The About page's light/dark toggle (redesign 9): it follows the theme-boot.js scheme (the device,
// or the editor's saved theme) until the page's own toggle is pressed; that choice is remembered for
// this page only, and public/about-boot.js applies it before the first paint (no flash).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABOUT_SCHEME_KEY, GROUND, otherScheme, savedScheme } from "./scheme";

const boot = readFileSync("public/about-boot.js", "utf8");
const tokens = readFileSync("src/styles/about-tokens.css", "utf8");
const html = readFileSync("about.html", "utf8");

describe("the toggle's choice", () => {
  it("flips between light and dark", () => {
    expect(otherScheme("light")).toBe("dark");
    expect(otherScheme("dark")).toBe("light");
  });

  it("reads back only light or dark; anything else (nothing, a damaged value) means no choice", () => {
    expect(savedScheme("light")).toBe("light");
    expect(savedScheme("dark")).toBe("dark");
    for (const v of [null, undefined, "", "Dark", "system", "{}", 1]) expect(savedScheme(v)).toBeNull();
  });

  it("is kept under a codeeditor: key, so Sign out and clear removes it with the rest", () => {
    expect(ABOUT_SCHEME_KEY).toMatch(/^codeeditor:/);
  });
});

describe("public/about-boot.js (a blocking file: the CSP forbids inline scripts)", () => {
  it("reads the same key, accepts only light or dark, and sets data-theme", () => {
    expect(boot).toContain(`"${ABOUT_SCHEME_KEY}"`);
    expect(boot).toMatch(/saved === "light" \|\| saved === "dark"/);
    expect(boot).toContain("dataset.theme");
    // Storage can throw (private windows, blocked site data): the read is guarded.
    expect(boot).toMatch(/try \{[^}]*localStorage\.getItem/);
  });

  it("paints the browser's toolbar in the page's ground, the same colours as the tokens and the page's metas", () => {
    const ground = (block: RegExp) => block.exec(tokens)?.[1]?.match(/--lg-ground:\s*(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
    expect(ground(/:root \{([^}]*)\}/)).toBe(GROUND.light);
    expect(ground(/:root\[data-theme="dark"\] \{([^}]*)\}/)).toBe(GROUND.dark);
    expect(boot).toContain(`light: "${GROUND.light}"`);
    expect(boot).toContain(`dark: "${GROUND.dark}"`);
    expect(html).toContain(`<meta name="theme-color" content="${GROUND.light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${GROUND.dark}" media="(prefers-color-scheme: dark)" />`);
  });

  it("runs after theme-boot.js, before the stylesheet", () => {
    const at = (s: string) => html.indexOf(s);
    expect(at('<script src="theme-boot.js"></script>')).toBeGreaterThan(0);
    expect(at('<script src="about-boot.js"></script>')).toBeGreaterThan(at('<script src="theme-boot.js"></script>'));
    expect(at('<link rel="stylesheet" href="/src/styles/about.css" />')).toBeGreaterThan(at('<script src="about-boot.js"></script>'));
  });
});
