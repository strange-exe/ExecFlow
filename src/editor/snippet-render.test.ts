/// <reference types="node" />
import { readFileSync } from "node:fs";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_TOKENS } from "../core/snippet-dialog";
import { contrast, deltaE, IMAGE_MIXES, over } from "../theme/contrast";
import { OWN } from "../theme/palettes";
import { BUILT_IN, themePalette, type Scheme } from "../theme/themes";
import { EXTRA_SPECIALS } from "./extensions";
import { languageSupport } from "./language-support";
import "./test-languages";
import {
  BAR_STEP, cardRect, chooseScale, CREDIT, creditInk, creditMark, creditSize, edgeThickness, layoutImage, markSpecials, pixelsOk, readbackRect, SIZES, styledLines, tabStop, treeFor, trimEnd, windowBarGround, wrapRows,
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
  /** Round 1's look: the plain frame, no background (the card's size is the image's). */
  const plain = (numbers: boolean, name: boolean) => ({ numbers, name, frame: "plain", pad: 0 }) as const;
  const combos = [plain(true, true), plain(true, false), plain(false, true), plain(false, false)];
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
    const l = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, plain(true, true));
    expect(l).toMatchObject({ gutterRight: 26, codeX: 42, nameTop: 13, ruleY: 43.5, barBottom: 0, codeTop: 56.5, digits: 1, rows: 2, markRight: 26 });
    expect(SIZES).toEqual({ E: 1, P: 16, V: 12, G: 16, HG: 8, R: 8, MIN_COLS: 32 });
    const off = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, plain(false, false));
    expect(off).toMatchObject({ codeX: 17, codeTop: 13, digits: 0 });
  });

  it("the window frame: a bar of 8, the name's line box and 8, then the rule and 12, with or without the name", () => {
    for (const name of [true, false]) {
      const l = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, { numbers: true, name, frame: "window", pad: 0 });
      expect(l).toMatchObject({ nameTop: 9, barBottom: 39.5, ruleY: 39.5, codeTop: 52.5, cardWidth: 347, cardHeight: 52.5 + 45 + 13 });
    }
  });

  it("the background's padding surrounds the card: sizes for none, small, medium and large", () => {
    const m = { ch: 9, lineH: 22.5, widest: 144 };
    for (const [pad, size] of [[0, [347, 114.5]], [16, [379, 146.5]], [32, [411, 178.5]], [64, [475, 242.5]]] as const) {
      const l = layoutImage(numbered(2, 2), m, { ...plain(true, true), pad });
      expect([l.width, l.height], `pad ${pad}`).toEqual(size);
      expect([l.cardWidth, l.cardHeight, l.pad]).toEqual([347, 114.5, pad]);
    }
  });

  it("a wrapped row with numbers off: the hook mark at E + P and the code one character and the gap further right", () => {
    const l = layoutImage([{ number: 1 }, { number: null }], { ch: 9, lineH: 22.5, widest: 100 }, plain(false, false));
    expect(l.markRight).toBe(1 + 16 + 9);
    expect(l.codeX).toBe(1 + 16 + 9 + 16);
    expect(l.width).toBe(42 + 288 + 16 + 1);
  });

  it("the edge is max(1, round(scale)) pixels thick", () => {
    expect([1, 1.5, 2, 3].map(edgeThickness)).toEqual([1, 2, 2, 3]);
  });

  it("the chosen scale gives the exact size, ceil(CSS size x scale); a scale too big steps down, never up", () => {
    // The fixture at medium padding, 411 x 178.5 CSS px.
    expect(chooseScale(411, 178.5, 1)).toEqual({ scale: 1, width: 411, height: 179 });
    expect(chooseScale(411, 178.5, 2)).toEqual({ scale: 2, width: 822, height: 357 });
    expect(chooseScale(411, 178.5, 3)).toEqual({ scale: 3, width: 1233, height: 536 });
    expect(chooseScale(411, 178.5)).toEqual({ scale: 2, width: 822, height: 357 });
    // Case F (977 x 6819.5): 3x and 2x are over the area cap, 1.5x fits.
    expect(chooseScale(977, 6819.5, 3)).toEqual({ scale: 1.5, width: 1466, height: 10230 });
    expect(chooseScale(977, 6819.5, 1)).toEqual({ scale: 1, width: 977, height: 6820 });
    // 3x over the 16,384 px side cap, 2x within both caps.
    expect(chooseScale(400, 6000, 3)).toEqual({ scale: 2, width: 800, height: 12000 });
    expect(chooseScale(2486, 9077, 3)).toBeNull();
  });

  it('the "Made with ExecFlow" line: in a background it fills a bottom band of at least its line box and 7 above and below; without one it is the card\'s last row', () => {
    const m = { ch: 9, lineH: 22.5, widest: 144 };
    // 15 px code: a 12 px credit on an 18 px line box, a band of 32: medium and large keep their size, small grows at its foot only.
    for (const [pad, padBottom, height] of [[16, 32, 162.5], [32, 32, 178.5], [64, 64, 242.5]] as const) {
      const l = layoutImage(numbered(2, 2), m, { ...plain(true, true), pad, credit: true });
      expect([l.width, l.height, l.padBottom, l.cardHeight], `pad ${pad}`).toEqual([347 + 2 * pad, height, padBottom, 114.5]);
      expect(l.credit).toEqual({ top: 114.5 + (padBottom - 18) / 2, right: 347, size: 12 });
    }
    // No background: 4 under the code, the line box, 8 and the edge; right-aligned with the code's padding.
    const card = layoutImage(numbered(2, 2), m, { ...plain(true, true), credit: true });
    expect(card.credit).toEqual({ top: 56.5 + 45 + 4, right: 347 - 17, size: 12 });
    expect([card.width, card.height, card.padBottom]).toEqual([347, 56.5 + 45 + 4 + 18 + 8 + 1, 0]);
    // Off: exactly round 2's layout.
    const off = layoutImage(numbered(2, 2), m, { ...plain(true, true), pad: 16 });
    expect([off.height, off.padBottom, off.credit]).toEqual([146.5, 16, null]);
    // 20 px code: a 17 px credit on a 25.5 px box needs a 39.5 band, over medium's 32; 11 px is the floor.
    expect(layoutImage(numbered(2, 2), { ch: 12, lineH: 30, widest: 144 }, { ...plain(true, true), pad: 32, credit: true }).padBottom).toBe(39.5);
    expect(creditSize(18)).toBe(CREDIT.MIN_SIZE);
  });

  it("round 3: the brand mark sits before the credit's text, at the text's size, centred on its line box; the layout's size is unchanged", () => {
    const m = { ch: 9, lineH: 22.5, widest: 144 };
    const l = layoutImage(numbered(2, 2), m, { ...plain(true, true), pad: 32, credit: true });
    // "Made with ExecFlow" at 12 px in the code font (0.6 em advance): 144 px wide.
    const mark = creditMark(l.credit!, 144);
    expect(mark.size).toBe(12);
    expect(mark.x + mark.size + CREDIT.MARK_GAP * 12).toBeCloseTo(347 - 144, 9);
    expect(mark.y).toBeCloseTo(l.credit!.top + (18 - 12) / 2, 9);
    // Inside the image: the mark never needs room the layout doesn't give (the card is at least 32 columns).
    expect(mark.x).toBeGreaterThan(0);
    expect([l.width, l.height]).toEqual([411, 178.5]);
    // The smallest credit (11 px) on the narrowest card (32 columns of 6.6 px): still inside the card's padding.
    const small = layoutImage(numbered(1, 1), { ch: 6.6, lineH: 16.5, widest: 10 }, { ...plain(false, false), credit: true });
    const at = creditMark(small.credit!, 20 * 6.6);
    expect(at.size).toBe(CREDIT.MIN_SIZE);
    expect(at.x).toBeGreaterThanOrEqual(1 + 16);
  });

  it("the card's place leaves the credit's taller band under it", () => {
    const l = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, { ...plain(true, true), pad: 16, credit: true });
    for (const s of [1, 1.5, 2, 3]) {
      const bitmap = { width: Math.ceil(l.width * s), height: Math.ceil(l.height * s) };
      const card = cardRect(l, bitmap, s);
      expect(card.h, `scale ${s}`).toBe(bitmap.height - Math.round(16 * s) - Math.round(32 * s));
      expect(Math.abs(card.h - 114.5 * s), `scale ${s}: the card's own height`).toBeLessThanOrEqual(1);
    }
  });

  it("the card sits inside the padding in whole bitmap pixels at every scale", () => {
    const l = layoutImage(numbered(2, 2), { ch: 9, lineH: 22.5, widest: 144 }, { ...plain(true, true), pad: 32 });
    for (const s of [1, 1.5, 2, 3]) {
      const fit = chooseScale(l.width, l.height, 3)!;
      const bitmap = { width: Math.ceil(l.width * s), height: Math.ceil(l.height * s) };
      const card = cardRect(l, bitmap, s);
      expect(Number.isInteger(card.x), `scale ${s}`).toBe(true);
      expect(card).toEqual({ x: 32 * s, y: 32 * s, w: bitmap.width - 64 * s, h: bitmap.height - 64 * s, r: 8 * s });
      expect(fit.scale).toBe(3);
    }
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

  it("reads a row of the card's straight left edge, below its corner, above the code, left of every box, at every scale and option", () => {
    const rowsAt = [{ number: 2 }, { number: 3 }];
    for (const s of [1, 1.5, 2, 3]) {
      const t = edgeThickness(s);
      for (const pad of [0, 16, 32, 64]) {
        for (const frame of ["plain", "window"] as const) {
          for (const numbers of [true, false]) {
            for (const name of [true, false]) {
              const what = `scale ${s}, pad ${pad}, ${frame}, numbers ${numbers}, name ${name}`;
              const l = layoutImage(rowsAt, { ch: 9, lineH: 22.5, widest: 144 }, { numbers, name, frame, pad });
              const card = cardRect(l, { width: Math.ceil(l.width * s), height: Math.ceil(l.height * s) }, s);
              const r = readbackRect(card, t);
              expect(r, what).toEqual({ x: card.x, y: card.y + Math.ceil(8 * s) + 1, w: t + 3, h: 1 });
              // Below the rounded corner (the edge is straight there) and the edge's own thickness.
              expect(r.y - card.y, what).toBeGreaterThan(card.r);
              expect(r.y - card.y, what).toBeGreaterThanOrEqual(t);
              // Above the first box drawn on the ground: the plain name, or the code; inside the window's bar.
              const firstBox = frame === "window" ? l.barBottom : name ? l.nameTop : l.codeTop;
              expect(r.y + r.h - card.y, what).toBeLessThanOrEqual(Math.floor(firstBox * s));
              // The ground pixel, left of the numbers, the name and the code.
              expect(t + 2, what).toBeLessThan(Math.floor((1 + 16) * s));
            }
          }
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

describe("the window bar's ground", () => {
  it("is the chrome's ground where the chrome has its own; else the hovered-chrome ground, when that is farther from the code", () => {
    expect(windowBarGround({ bg: "#13201b", surface: "#152a22", text: "#e9eae4" }), "Deep Field dark: dE 0.036").toBe("#152a22");
    // Nord paints its chrome in its code ground: UI_MIXES.hover (text at 7%) over it.
    expect(windowBarGround({ bg: "#2e3440", surface: "#2e3440", text: "#d8dee9" })).toBe(over("#2e3440", "#d8dee9", 0.07));
    // A text colour that would bring the bar nearer the code ground keeps the chrome's.
    expect(windowBarGround({ bg: "#808080", surface: "#7a7a7a", text: "#848484" })).toBe("#7a7a7a");
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
  for (const family of ["signal", "deep-field", "slate"] as const) for (const scheme of ["light", "dark"] as const) cases.push([`OWN ${family} ${scheme}`, OWN[family][scheme]]);

  it.each(cases)("%s", (_, p) => {
    for (const t of IMAGE_TOKENS) expect(p[t], t).toMatch(HEX6);
    expect(TEXT_TOKENS).toHaveLength(14);
    for (const t of TEXT_TOKENS) expect(contrast(p[t], p.bg), `${t} on bg`).toBeGreaterThanOrEqual(4.5);
    // Round 2: every colour drawn on a highlighted line's band (the name never is), the window bar's
    // name and placeholders, as the renderer mixes them (contrast.ts IMAGE_MIXES).
    const band = over(p.bg, p.focus, IMAGE_MIXES.mark.pct / 100);
    for (const t of TEXT_TOKENS.filter((x) => x !== "text-secondary")) expect(contrast(p[t], band), `${t} on the highlight band ${band}`).toBeGreaterThanOrEqual(4.5);
    // The window bar's ground as the renderer picks it: visibly not the code ground (OKLab 0.02, the
    // just-noticeable difference CSS Color 4's gamut mapping uses), so Window never looks like Plain;
    // never closer to the code ground than the chrome is.
    const bar = windowBarGround({ bg: p.bg, surface: p.surface, text: p.text });
    expect(deltaE(bar, p.bg), `the window bar ${bar} against the code ground ${p.bg}`).toBeGreaterThanOrEqual(0.02);
    expect(deltaE(bar, p.bg)).toBeGreaterThanOrEqual(deltaE(p.surface, p.bg));
    if (deltaE(p.surface, p.bg) >= BAR_STEP) expect(bar, "a chrome of its own: the bar is the chrome's ground").toBe(p.surface);
    for (const t of ["text-secondary", "danger"] as const) expect(contrast(p[t], bar), `${t} on the window bar ${bar}`).toBeGreaterThanOrEqual(4.5);
    // Batch 4: the "Made with ExecFlow" line on its ground, the background (the mat) or the code's.
    const mat = over(p.bg, p.action, IMAGE_MIXES.mat.pct / 100);
    const ink = { bg: p.bg, action: p.action, "text-secondary": p["text-secondary"] };
    expect(contrast(creditInk(ink, true), mat), `the credit ${creditInk(ink, true)} on the background ${mat}`).toBeGreaterThanOrEqual(4.5);
    expect(creditInk(ink, false), "on the code ground the file name's own colour, unmoved").toBe(p["text-secondary"]);
    if (contrast(p["text-secondary"], mat) >= 4.5) expect(creditInk(ink, true), "moved only when it has to").toBe(p["text-secondary"]);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.divider.slice(i, i + 2), 16));
    // A white placeholder fails the readback on the edge pixels, whatever the ground (bg or the window's bar).
    expect(r >= 247 && g >= 247 && b >= 247, `divider ${p.divider} is within 8 of white`).toBe(false);
  });
});

describe("source guard: the new modules", () => {
  const MODULES = [
    "src/core/snippet.ts", "src/core/snippet-dialog.ts", "src/core/code-menu.ts", "src/ui/menu-place.ts", "src/ui/code-menu.ts", "src/ui/snippet-image.ts",
    "src/ui/snippet-dialog.ts", "src/ui/snippet-flow.ts", "src/editor/snippet-render.ts", "src/editor/snippet-canvas.ts",
    // Save as PDF (batch 4): its print-safe ink lives in src/theme/print-ink.ts only.
    "src/core/print.ts", "src/editor/print-render.ts", "src/ui/print-dialog.ts", "src/ui/print-view.ts",
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
    // Save as PDF is lazy the same way (its dialog, layout, core and renderer).
    expect(text).not.toMatch(/^import (?!type )[^;]*from "(\.\.\/core\/|\.\.\/editor\/|\.\/)print(-dialog|-view|-render)?"/m);
  });
  it("the code menu cuts through the editor and never reads the clipboard", () => {
    const text = readFileSync("src/ui/code-menu.ts", "utf8");
    expect(text).not.toMatch(/execCommand\(\s*"cut"/);
    expect(text).not.toMatch(/readText/);
    expect(text).toMatch(/execCommand\(\s*"copy"/);
  });
});
