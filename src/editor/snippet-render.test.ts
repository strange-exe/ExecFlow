/// <reference types="node" />
import { readFileSync } from "node:fs";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_TOKENS } from "../core/snippet-dialog";
import { contrast } from "../theme/contrast";
import { OWN } from "../theme/palettes";
import { BUILT_IN, themePalette, type Scheme } from "../theme/themes";
import { EXTRA_SPECIALS } from "./extensions";
import { languageSupport } from "./language-support";
import {
  chooseScale, edgeThickness, layoutImage, markSpecials, pixelsOk, readbackRect, SIZES, styledLines, tabStop, treeFor, trimEnd, wrapRows,
  type Run, type StyledLine,
} from "./snippet-render";

// final-v3 sections 3, 4.1, 4.5, 4.6, 7.5 and 7.6. Special characters are built from code points.
const cp = (n: number) => String.fromCodePoint(n);
const python = (doc: string) => EditorState.create({ doc, extensions: languageSupport("python") });
const noYield = async () => {};

describe("treeFor (7.6, F16)", () => {
  it("plain text: no tree, not partial, and the yield is never called", async () => {
    const yieldTask = vi.fn(noYield);
    expect(await treeFor(EditorState.create({ doc: "hello\nworld" }), 11, 1000, yieldTask)).toEqual({ tree: null, partial: false });
    expect(yieldTask).not.toHaveBeenCalled();
  });

  it("Python of 20,000 characters: the live parse reaches the end (a snapshot would not)", async () => {
    const state = python("x = 1\n".repeat(3400));
    expect(syntaxTree(state).length, "precondition: a new state has parsed only its start").toBeLessThan(20000);
    const { tree, partial } = await treeFor(state, 20000, 1000, noYield);
    expect(partial).toBe(false);
    expect(tree!.length).toBeGreaterThanOrEqual(20000);
  });
});

describe("styledLines (the editor's own tag matching)", () => {
  it("colours Python by the highlight style's tokens, comments italic, spaces as text, equal runs merged", async () => {
    const state = python("def f():\n    return 1  # c");
    const { tree } = await treeFor(state, state.doc.length, 1000, noYield);
    const [one, two] = styledLines(state, tree, 1, 2);
    expect(one.number).toBe(1);
    expect(one.runs[0]).toEqual({ text: "def", token: "syn-keyword", italic: false });
    expect(one.runs[1]).toEqual({ text: " ", token: "text", italic: false });
    expect(one.runs[2]).toEqual({ text: "f", token: "syn-function", italic: false });
    expect(two.number).toBe(2);
    expect(two.runs).toEqual([
      { text: "    ", token: "text", italic: false },
      { text: "return", token: "syn-keyword", italic: false },
      { text: " ", token: "text", italic: false },
      { text: "1", token: "syn-number", italic: false },
      { text: "  ", token: "text", italic: false },
      { text: "# c", token: "syn-comment", italic: true },
    ]);
    for (const line of [one, two]) {
      for (let i = 1; i < line.runs.length; i++) {
        const [a, b] = [line.runs[i - 1], line.runs[i]];
        expect(a.token === b.token && a.italic === b.italic, `${a.text}|${b.text}`).toBe(false);
      }
    }
    expect(one.runs.map((r) => r.text).join("")).toBe("def f():");
  });

  it("plain text gives one text run per line, and a blank line none", () => {
    const state = EditorState.create({ doc: "a b\n\nc" });
    expect(styledLines(state, null, 1, 3)).toEqual([
      { number: 1, runs: [{ text: "a b", token: "text", italic: false }] },
      { number: 2, runs: [] },
      { number: 3, runs: [{ text: "c", token: "text", italic: false }] },
    ]);
    expect(styledLines(state, null, 3, 3)).toEqual([{ number: 3, runs: [{ text: "c", token: "text", italic: false }] }]);
  });
});

describe("markSpecials (the editor's placeholders)", () => {
  const text = (t: string, token: Run["token"] = "text"): Run => ({ text: t, token, italic: false });
  it("a direction character is a danger dot; a control character its control picture; a tab is left alone", () => {
    expect(markSpecials([text(`a${cp(0x202e)}b`)])).toEqual([text("a"), { text: cp(0x2022), token: "danger", italic: false, special: true }, text("b")]);
    expect(markSpecials([text(cp(7), "syn-string")])).toEqual([{ text: cp(0x2407), token: "danger", italic: false, special: true }]);
    expect(markSpecials([text("\tx")])).toEqual([text("\tx")]);
  });

  it("covers CodeMirror's default list and the app's EXTRA_SPECIALS, one placeholder per character", () => {
    const defaults = [0x0, 0x8, 0xb, 0x1f, 0x7f, 0x9f, 0xad, 0x61c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff, 0xfff9, 0xfffc];
    const extra = [0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0];
    for (const c of extra) expect(EXTRA_SPECIALS.test(cp(c)), c.toString(16)).toBe(true);
    for (const c of [...defaults, ...extra]) {
      const out = markSpecials([text(cp(c))]);
      expect(out, c.toString(16)).toEqual([{ text: c < 32 ? cp(0x2400 + c) : cp(0x2022), token: "danger", italic: false, special: true }]);
    }
    // Not special: a zero-width joiner (Indic scripts need it), a no-break space, plain letters.
    for (const c of [0x200d, 0xa0, 0x41, 0x9]) expect(markSpecials([text(cp(c))]), c.toString(16)).toEqual([text(cp(c))]);
  });
});

describe("tabStop, trimEnd and wrapRows", () => {
  it("tabStop: the next multiple of the tab width, skipping one closer than half a character", () => {
    expect([18, 36, 15, 31, 32].map((x) => tabStop(x, 9, 9, 4))).toEqual([36, 72, 36, 36, 72]);
  });

  it("trimEnd removes trailing spaces and tabs only", () => {
    expect(trimEnd("x = 1   ")).toBe("x = 1");
    expect(trimEnd("x\t \t")).toBe("x");
    expect(trimEnd(`x${cp(0x200b)}`)).toBe(`x${cp(0x200b)}`);
  });

  const line = (text: string, number = 1): StyledLine => ({ number, runs: [{ text, token: "text", italic: false }] });
  const rows = (text: string) => wrapRows(line(text), 12, 6, 4).map((r) => [r.runs.map((x) => x.text).join(""), r.number, r.indent]);

  it("breaks after a space at the threshold or later, else at the limit; continuation rows are indented", () => {
    expect(rows("print(a, b, cde_fgh)")).toEqual([["print(a, b, ", 1, 0], ["cde_fgh)", null, 4]]);
    expect(rows("abcdefghijklmnopqrstuvwxy")).toEqual([["abcdefghijkl", 1, 0], ["mnopqrst", null, 4], ["uvwxy", null, 4]]);
    expect(rows("  abcdefghijklmnop")).toEqual([["  abcdefghij", 1, 0], ["klmnop", null, 6]]);
    expect(rows("short")).toEqual([["short", 1, 0]]);
    expect(wrapRows({ number: 5, runs: [] }, 12, 6, 4)).toEqual([{ number: 5, indent: 0, runs: [] }]);
  });

  it("never splits a grapheme cluster and keeps the run styles", () => {
    const e = `e${cp(0x301)}`; // e and a combining acute: one cluster, one column
    const out = wrapRows({ number: 1, runs: [{ text: "abcdefghij", token: "syn-string", italic: false }, { text: `k${e}mn`, token: "syn-keyword", italic: true }] }, 12, 6, 4);
    expect(out[0].runs).toEqual([{ text: "abcdefghij", token: "syn-string", italic: false }, { text: `k${e}`, token: "syn-keyword", italic: true }]);
    expect(out[1].runs).toEqual([{ text: "mn", token: "syn-keyword", italic: true }]);
  });

  it("counts a tab to its stop when filling a row", () => {
    expect(rows("\tabcdefghijk")).toEqual([["\tabcdefgh", 1, 0], ["ijk", null, 8]]);
  });
});

describe("layoutImage and chooseScale (4.1, 4.5)", () => {
  const numbered = (first: number, count: number) => Array.from({ length: count }, (_, i) => ({ number: first + i }));
  const combos = [{ numbers: true, name: true }, { numbers: true, name: false }, { numbers: false, name: true }, { numbers: false, name: false }];
  // name, first line, rows, ch, lineH, widest row (px), default CSS size, scale, bitmaps (default, header off, numbers off, both off)
  it.each([
    ["A: 9 lines", 4, 9, 9, 22.5, 342, [410, 272], 2, [[820, 544], [820, 457], [752, 544], [752, 457]]],
    ["B: 200 lines, 100 cols", 1, 200, 9, 22.5, 900, [977, 4569.5], 1.5, [[1466, 6855], [1466, 6789], [1401, 6855], [1401, 6789]]],
    ["C: 300 lines, 100 cols, 20 px", 1, 300, 12, 30, 1200, [1286, 9077], 1, [[1286, 9077], [1286, 9026], [1234, 9077], [1234, 9026]]],
    ["D: as C, wide characters", 1, 300, 12, 30, 2400, [2486, 9077], null, null],
    ["E: 1 short line", 7, 1, 9, 22.5, 9, [347, 92], 2, [[694, 184], [694, 97], [644, 184], [644, 97]]],
    ["F: 300 lines, 100 cols, 15 px", 1, 300, 9, 22.5, 900, [977, 6819.5], 1.5, [[1466, 10230], [1466, 10164], [1401, 10230], [1401, 10164]]],
    ["the fixture, lines 2 to 3", 2, 2, 9, 22.5, 144, [347, 114.5], 2, [[694, 229], [694, 142], [644, 229], [644, 142]]],
    ["300 lines of x", 1, 300, 9, 22.5, 9, [365, 6819.5], 2, [[730, 13639], [730, 13552], [644, 13639], [644, 13552]]],
  ] as [string, number, number, number, number, number, [number, number], number | null, [number, number][] | null][])(
    "%s",
    (_, first, count, ch, lineH, widest, css, scale, bitmaps) => {
      const layouts = combos.map((o) => layoutImage(numbered(first, count), { ch, lineH, widest }, o));
      expect([layouts[0].width, layouts[0].height]).toEqual(css);
      const scales = layouts.map((l) => chooseScale(l.width, l.height));
      if (bitmaps === null) {
        expect(scales).toEqual([null, null, null, null]);
      } else {
        expect(scales.map((s) => s?.scale)).toEqual([scale, scale, scale, scale]);
        expect(scales.map((s) => [s?.width, s?.height])).toEqual(bitmaps);
      }
    },
  );

  it("places the fixture exactly: gutter, code, name row, rule", () => {
    const l = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, { numbers: true, name: true });
    expect(l).toMatchObject({ gutterRight: 26, codeX: 42, nameTop: 13, ruleY: 43.5, codeTop: 56.5, digits: 1, rows: 2, markRight: 26 });
    expect(SIZES).toEqual({ E: 1, P: 16, V: 12, G: 16, HG: 8, MIN_COLS: 32 });
    const off = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, { numbers: false, name: false });
    expect(off).toMatchObject({ codeX: 17, codeTop: 13, digits: 0 });
  });

  it("a wrapped row with numbers off: the hook mark at E + P and the code one character and the gap further right", () => {
    const l = layoutImage([{ number: 1 }, { number: null }], { ch: 9, lineH: 22.5, widest: 100 }, { numbers: false, name: false });
    expect(l.markRight).toBe(1 + 16 + 9);
    expect(l.codeX).toBe(1 + 16 + 9 + 16);
    expect(l.width).toBe(42 + 288 + 16 + 1);
  });

  it("the edge is max(1, round(scale)) pixels thick", () => {
    expect([1, 1.5, 2].map(edgeThickness)).toEqual([1, 2, 2]);
  });
});

describe("the readback (7.5)", () => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** t edge pixels, then two ground pixels and the ground pixel read: t + 3 RGBA pixels. */
  function strip(t: number, edge: number[], ground: number[], alpha = 255): Uint8ClampedArray {
    const out = new Uint8ClampedArray((t + 3) * 4);
    for (let i = 0; i < t + 3; i++) out.set([...(i < t ? edge : ground), alpha], i * 4);
    return out;
  }
  const divider = "#adc0b4";
  const bg = "#f8fbf9";

  it("reads a row inside the top padding, outside the edge and every box, at every scale and option", () => {
    const rowsAt = [{ number: 2 }, { number: 3 }];
    for (const s of [1, 1.5, 2]) {
      const t = edgeThickness(s);
      const r = readbackRect(t);
      expect(r).toEqual({ x: 0, y: t + 2, w: t + 3, h: 1 });
      for (const numbers of [true, false]) {
        for (const name of [true, false]) {
          const l = layoutImage(rowsAt, { ch: 9, lineH: 22.5, widest: 144 }, { numbers, name });
          const firstBox = (name ? l.nameTop : l.codeTop) * s;
          expect(r.y, `scale ${s}: below the top edge`).toBeGreaterThanOrEqual(t);
          expect(r.y + r.h, `scale ${s}: above the name box and the rows`).toBeLessThanOrEqual(Math.floor(firstBox));
          expect(r.x + t - 1, "the edge pixels").toBeLessThan(t);
          expect(t + 2, "the ground pixel, left of the numbers, the name and the code").toBeLessThan(Math.floor((1 + 16) * s));
          expect(t + 2).toBeGreaterThanOrEqual(t);
        }
      }
    }
  });

  it("pixelsOk: exact passes, a tolerance of 8 passes and 9 fails, alpha must be 255", () => {
    for (const t of [1, 2]) {
      const e = rgb(divider);
      const g = rgb(bg);
      expect(pixelsOk(strip(t, e, g), divider, bg, t)).toBe(true);
      expect(pixelsOk(strip(t, e.map((c) => c + 8), g.map((c) => c - 8)), divider, bg, t)).toBe(true);
      expect(pixelsOk(strip(t, e.map((c) => c + 9), g), divider, bg, t)).toBe(false);
      expect(pixelsOk(strip(t, e, [g[0], g[1] - 9, g[2]]), divider, bg, t)).toBe(false);
      expect(pixelsOk(strip(t, e, g, 254), divider, bg, t)).toBe(false);
    }
  });

  it("a white placeholder fails for every built-in theme's divider; so does Firefox's repeated random pattern", () => {
    const white = new Uint8ClampedArray(5 * 4).fill(255);
    for (const theme of BUILT_IN) {
      for (const scheme of schemesOf(theme)) {
        const p = themePalette(theme, scheme).palette;
        expect(pixelsOk(white, p.divider, p.bg, 2), `${theme.id} ${scheme}`).toBe(false);
      }
    }
    const pattern = Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 17 + i : (i * 53 + 11) % 256));
    const noise = new Uint8ClampedArray(5 * 4).map((_, i) => pattern[i % 32]);
    expect(pixelsOk(noise, divider, bg, 2)).toBe(false);
  });
});

function schemesOf(theme: (typeof BUILT_IN)[number]): Scheme[] {
  return theme.system ? ["light", "dark"] : [theme.scheme];
}

describe("the image's colours in every theme (4.6)", () => {
  const HEX6 = /^#[0-9a-f]{6}$/i;
  const TEXT_TOKENS = IMAGE_TOKENS.filter((t) => t === "text" || t === "text-secondary" || t === "gutter-text" || t === "danger" || t.startsWith("syn-"));
  const cases: [string, Record<string, string>][] = [];
  for (const theme of BUILT_IN) for (const scheme of schemesOf(theme)) cases.push([`${theme.id} ${scheme}`, themePalette(theme, scheme).palette]);
  for (const family of ["deep-field", "slate"] as const) for (const scheme of ["light", "dark"] as const) cases.push([`OWN ${family} ${scheme}`, OWN[family][scheme]]);

  it.each(cases)("%s", (_, p) => {
    for (const t of IMAGE_TOKENS) expect(p[t], t).toMatch(HEX6);
    expect(TEXT_TOKENS).toHaveLength(14);
    for (const t of TEXT_TOKENS) expect(contrast(p[t], p.bg), `${t} on bg`).toBeGreaterThanOrEqual(4.5);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.divider.slice(i, i + 2), 16));
    expect(r >= 247 && g >= 247 && b >= 247, `divider ${p.divider} is within 8 of white`).toBe(false);
  });
});

describe("source guard: the new modules", () => {
  const MODULES = [
    "src/core/snippet.ts", "src/core/snippet-dialog.ts", "src/core/code-menu.ts", "src/ui/menu-place.ts", "src/ui/code-menu.ts", "src/ui/snippet-image.ts",
    "src/ui/snippet-dialog.ts", "src/ui/snippet-flow.ts", "src/editor/snippet-render.ts", "src/editor/snippet-canvas.ts",
  ];
  it.each(MODULES)("%s holds no colour literal, no image element, no object URL and no HTML sink", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(text).not.toMatch(/\b(rgba?|hsla?)\(/);
    expect(text).not.toMatch(/\bh\(\s*"img"|createElement\(\s*"img"|new Image\(/);
    expect(text).not.toMatch(/createObjectURL|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  // What only the dialog needs stays out of the first visit (final-v3 section 10's budget): the shell's
  // modules import the dialog's modules by type only, or lazily with import().
  it.each(["src/core/snippet.ts", "src/ui/snippet-image.ts", "src/ui/code-menu.ts", "src/ui/workbench.ts"])("%s never imports the dialog's modules at run time", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/^import (?!type )[^;]*from "(\.\.\/core\/|\.\/|\.\.\/ui\/)snippet-(dialog|flow)"/m);
    expect(text).not.toMatch(/^import (?!type )[^;]*from "(\.\.\/editor\/|\.\/)snippet-(render|canvas)"/m);
  });
  it("the code menu cuts through the editor and never reads the clipboard", () => {
    const text = readFileSync("src/ui/code-menu.ts", "utf8");
    expect(text).not.toMatch(/execCommand\(\s*"cut"/);
    expect(text).not.toMatch(/readText/);
    expect(text).toMatch(/execCommand\(\s*"copy"/);
  });
});
