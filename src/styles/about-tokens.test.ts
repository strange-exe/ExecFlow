/// <reference types="node" />
// The About page's own palette (redesign 9, "Living Graph", Electric Blue): every text, mark and
// boundary pair the page paints, in light and dark, against WCAG 2.2 AA with the relative-luminance
// formula. The preview page measured these in the browser; the product page checks them here, from
// the tokens file itself, so a changed value that fails is caught before it ships.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, over } from "../theme/contrast";

const css = readFileSync("src/styles/about-tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The --lg-* hex tokens of the first block that starts with `head`. */
function block(head: string): Record<string, string> {
  const start = css.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const text = css.slice(start + head.length, css.indexOf("}", start));
  return Object.fromEntries([...text.matchAll(/(--lg-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

const MODES = { light: block(":root {"), dark: block(':root[data-theme="dark"] {') };

type Need = 4.5 | 3;
// [what, foreground token, background token, ratio needed]
const PAIRS: [string, string, string, Need][] = [
  ["body text on the ground", "--lg-text", "--lg-ground", 4.5],
  ["muted text on the ground", "--lg-muted", "--lg-ground", 4.5],
  ["text on a surface (cards, the stage)", "--lg-text", "--lg-surface", 4.5],
  ["muted text on a surface", "--lg-muted", "--lg-surface", 4.5],
  ["text on the second surface (tabs, bars)", "--lg-text", "--lg-surface-2", 4.5],
  ["muted text on the second surface", "--lg-muted", "--lg-surface-2", 4.5],
  ["text on the raised surface (current line)", "--lg-text", "--lg-surface-3", 4.5],
  ["muted line numbers on the raised surface", "--lg-muted", "--lg-surface-3", 4.5],
  ["node labels on nodes", "--lg-text", "--lg-node", 4.5],
  ["edge labels on the graph pane", "--lg-muted", "--lg-pane", 4.5],
  ["taken-edge labels on the graph pane", "--lg-pulse-ink", "--lg-pane", 4.5],
  ["accent text on the ground (headline word, the wordmark's Flow)", "--lg-pulse-ink", "--lg-ground", 4.5],
  ["accent text on a surface (counts, numbers)", "--lg-pulse-ink", "--lg-surface", 4.5],
  ["accent text on the raised surface (counts on the current line)", "--lg-pulse-ink", "--lg-surface-3", 4.5],
  ["keywords on a surface", "--lg-active", "--lg-surface", 4.5],
  ["keywords on the current line", "--lg-active", "--lg-surface-3", 4.5],
  ["the primary button and count badges", "--lg-on-pulse", "--lg-pulse", 4.5],
  ["a taken edge on the graph pane", "--lg-flow", "--lg-pane", 3],
  ["an untaken dashed edge on the graph pane", "--lg-edge-idle", "--lg-pane", 3],
  ["a node outline on the graph pane", "--lg-node-edge", "--lg-pane", 3],
  ["the running node's outline on the graph pane", "--lg-active", "--lg-pane", 3],
  ["a control outline on a surface", "--lg-node-edge", "--lg-surface", 3],
  ["a control outline on the second surface", "--lg-node-edge", "--lg-surface-2", 3],
  ["a control outline on the ground", "--lg-node-edge", "--lg-ground", 3],
  ["the primary button's edge on the ground", "--lg-pulse-edge", "--lg-ground", 3],
  ["the focus ring on the ground", "--lg-focus", "--lg-ground", 3],
  ["the focus ring on a surface", "--lg-focus", "--lg-surface", 3],
  ["the focus ring on the graph pane", "--lg-focus", "--lg-pane", 3],
  ["the spine and ports on the ground (features graph)", "--lg-flow", "--lg-ground", 3],
];

/** What's new: each kind's glyph on its tag's tint (16 % of the hue over the card), and its word. */
const KINDS = ["--lg-added", "--lg-changed", "--lg-fixed"];

describe.each(Object.entries(MODES))("%s", (_mode, t) => {
  it("declares every token the pairs name", () => {
    const names = new Set([...PAIRS.flatMap(([, f, b]) => [f, b]), ...KINDS]);
    expect([...names].filter((n) => !t[n])).toEqual([]);
  });

  it.each(PAIRS)("%s: %s on %s, at least %s:1", (_what, fg, bg, need) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(need);
  });

  it.each(KINDS)("%s: the glyph 3:1 on its tint, the word 4.5:1 on it, and the hue 3:1 on the card", (kind) => {
    const tint = over(t["--lg-surface"], t[kind], 0.16);
    expect(contrast(t[kind], tint)).toBeGreaterThanOrEqual(3);
    expect(contrast(t["--lg-text"], tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t[kind], t["--lg-surface"])).toBeGreaterThanOrEqual(3);
  });

  it("the three kinds are three different hues", () => {
    expect(new Set(KINDS.map((k) => t[k])).size).toBe(3);
  });
});

it("the check can fail: a light grey on white is caught", () => {
  expect(contrast("#aaaaaa", "#ffffff")).toBeLessThan(4.5);
});
