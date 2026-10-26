/// <reference types="node" />
// The brand mark drawn in exports (Capture snippet's credit; the Flowchart export later): the same
// geometry as public/icons/mark-v2.svg, as canvas paths and as an SVG built element by element.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_MARK, brandMarkSvg, drawBrandMark, glyphPathData } from "./brand-mark";

const SOURCE = readFileSync("public/icons/mark-v2.svg", "utf8");
const attr = (tag: string, name: string) => new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(SOURCE)?.[1];

/** An SVG path's M, L and l commands (with implicit repeats) as absolute polylines. */
function polylines(d: string): [number, number][][] {
  const tokens = d.match(/[MLml]|-?\d*\.?\d+/g) ?? [];
  const out: [number, number][][] = [];
  let cmd = "";
  let at: [number, number] = [0, 0];
  for (let i = 0; i < tokens.length; ) {
    if (/[MLml]/.test(tokens[i])) cmd = tokens[i++];
    const x = Number(tokens[i++]);
    const y = Number(tokens[i++]);
    const rel = cmd === "l" || cmd === "m";
    at = rel ? [at[0] + x, at[1] + y] : [x, y];
    if (cmd === "M" || cmd === "m") {
      out.push([at]);
      cmd = cmd === "M" ? "L" : "l";
    } else out.at(-1)!.push(at);
  }
  return out;
}

describe("the brand mark's geometry is mark-v2.svg's", () => {
  it("the tile: the rect, its corner radius and its blue; the 32-unit view box", () => {
    expect(attr("svg", "viewBox")).toBe(`0 0 ${BRAND_MARK.view} ${BRAND_MARK.view}`);
    const { tile } = BRAND_MARK;
    expect(["x", "y", "width", "height", "rx"].map((a) => Number(attr("rect", a)))).toEqual([tile.x, tile.y, tile.size, tile.size, tile.radius]);
    expect(attr("rect", "fill")).toBe(tile.fill);
    expect(tile.fill).toBe("#2f5bea");
  });

  it("the glyph: the same two chevrons, stroke, width, caps and joins", () => {
    const { glyph } = BRAND_MARK;
    expect(polylines(attr("path", "d")!)).toEqual(glyph.lines);
    expect(polylines(glyphPathData())).toEqual(glyph.lines);
    expect(attr("path", "stroke")).toBe(glyph.stroke);
    expect(glyph.stroke).toBe("#ffffff");
    expect(Number(attr("path", "stroke-width"))).toBe(glyph.width);
    expect([attr("path", "stroke-linecap"), attr("path", "stroke-linejoin"), attr("path", "fill")]).toEqual(["round", "round", "none"]);
  });

  it("the parser reads relative commands (so a changed file is caught)", () => {
    expect(polylines("M12 10 6.5 16l5.5 6")).toEqual([[[12, 10], [6.5, 16], [12, 22]]]);
    expect(polylines("M1 1l1 1M5 5L6 6")).toEqual([[[1, 1], [2, 2]], [[5, 5], [6, 6]]]);
  });
});

/** A 2D context that records what is drawn: every path point, fills and strokes with their styles. */
function recorder() {
  const calls: { op: string; args: number[]; style?: Record<string, unknown> }[] = [];
  let points: [number, number][] = [];
  const ctx = {
    fillStyle: "" as string, strokeStyle: "" as string, lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    beginPath: () => (points = []),
    moveTo: (x: number, y: number) => (calls.push({ op: "moveTo", args: [x, y] }), points.push([x, y])),
    lineTo: (x: number, y: number) => (calls.push({ op: "lineTo", args: [x, y] }), points.push([x, y])),
    arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => (calls.push({ op: "arcTo", args: [x1, y1, x2, y2, r] }), points.push([x1, y1], [x2, y2])),
    closePath: () => calls.push({ op: "closePath", args: [] }),
    fill: () => calls.push({ op: "fill", args: [], style: { fillStyle: ctx.fillStyle, points: [...points] } }),
    stroke: () => calls.push({ op: "stroke", args: [], style: { strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, lineJoin: ctx.lineJoin, points: [...points] } }),
  };
  return { ctx, calls };
}

describe("drawBrandMark (canvas)", () => {
  for (const [x, y, size] of [[0, 0, 32], [100, 40, 12], [7.5, 3.25, 18]] as const) {
    it(`fills the tile and strokes the glyph at ${x}, ${y}, ${size} px`, () => {
      const { ctx, calls } = recorder();
      drawBrandMark(ctx as unknown as CanvasRenderingContext2D, x, y, size);
      const k = size / 32;
      const fills = calls.filter((c) => c.op === "fill");
      const strokes = calls.filter((c) => c.op === "stroke");
      expect(fills).toHaveLength(1);
      expect(strokes).toHaveLength(1);
      expect(calls.indexOf(fills[0]), "the tile first, the glyph over it").toBeLessThan(calls.indexOf(strokes[0]));
      expect(fills[0].style!.fillStyle).toBe("#2f5bea");
      // The tile's path spans the rect exactly (1 to 31 units, corners rounded inside it).
      const tp = fills[0].style!.points as [number, number][];
      const xs = tp.map((p) => p[0]);
      const ys = tp.map((p) => p[1]);
      expect(Math.min(...xs)).toBeCloseTo(x + 1 * k, 9);
      expect(Math.max(...xs)).toBeCloseTo(x + 31 * k, 9);
      expect(Math.min(...ys)).toBeCloseTo(y + 1 * k, 9);
      expect(Math.max(...ys)).toBeCloseTo(y + 31 * k, 9);
      expect(calls.filter((c) => c.op === "arcTo").map((c) => c.args[4])).toEqual([7 * k, 7 * k, 7 * k, 7 * k].map((r) => expect.closeTo(r, 9)));
      expect(strokes[0].style).toMatchObject({ strokeStyle: "#ffffff", lineCap: "round", lineJoin: "round" });
      expect(strokes[0].style!.lineWidth).toBeCloseTo(3.5 * k, 9);
      const glyph = (strokes[0].style!.points as [number, number][]).map(([px, py]) => [(px - x) / k, (py - y) / k]);
      const expected = BRAND_MARK.glyph.lines.flat();
      expect(glyph).toHaveLength(expected.length);
      glyph.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(expected[i][0], 9);
        expect(p[1]).toBeCloseTo(expected[i][1], 9);
      });
    });
  }
});

interface FakeNode {
  ns: string;
  tag: string;
  attrs: Map<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  append(...nodes: FakeNode[]): void;
  appendChild(node: FakeNode): FakeNode;
}

/** createElementNS only: no innerHTML, no parser, so the builder can only make elements. */
function fakeDocument() {
  const made: FakeNode[] = [];
  return {
    made,
    doc: {
      createElementNS(ns: string, tag: string): FakeNode {
        const node: FakeNode = {
          ns, tag, attrs: new Map(), children: [],
          setAttribute(name, value) { node.attrs.set(name, String(value)); },
          append(...nodes) { node.children.push(...nodes); },
          appendChild(n) { node.children.push(n); return n; },
        };
        made.push(node);
        return node;
      },
    },
  };
}

describe("brandMarkSvg (SVG built with createElementNS)", () => {
  const SVG = "http://www.w3.org/2000/svg";
  it("an svg with the tile and the glyph, at the size asked for, decorative", () => {
    const { doc, made } = fakeDocument();
    const svg = brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, 14) as unknown as FakeNode;
    expect(made.every((n) => n.ns === SVG), "every element in the SVG namespace").toBe(true);
    expect(svg.tag).toBe("svg");
    expect(Object.fromEntries(svg.attrs)).toMatchObject({ viewBox: "0 0 32 32", width: "14", height: "14", "aria-hidden": "true", focusable: "false" });
    expect(svg.children.map((c) => c.tag)).toEqual(["rect", "path"]);
    const [rect, path] = svg.children;
    expect(Object.fromEntries(rect.attrs)).toEqual({ x: "1", y: "1", width: "30", height: "30", rx: "7", fill: "#2f5bea" });
    expect(Object.fromEntries(path.attrs)).toEqual({
      d: glyphPathData(), fill: "none", stroke: "#ffffff", "stroke-width": "3.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    expect(polylines(path.attrs.get("d")!)).toEqual(BRAND_MARK.glyph.lines);
  });

  it("makes no script, no link, no event handler and no external reference", () => {
    const { doc, made } = fakeDocument();
    brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, 20);
    expect(made.map((n) => n.tag).sort()).toEqual(["path", "rect", "svg"]);
    for (const n of made) {
      for (const [name, value] of n.attrs) {
        expect(name, `${n.tag} ${name}`).not.toMatch(/^on|href$|^src$|^style$/i);
        expect(value, `${n.tag} ${name}`).not.toMatch(/url\(|javascript:|data:|https?:|</i);
      }
    }
  });

  it("refuses a size that is not a positive finite number (it is written into an attribute)", () => {
    const { doc } = fakeDocument();
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, bad), String(bad)).toThrow(RangeError);
  });
});
