/// <reference types="node" />
// The brand mark drawn in exports (Capture snippet's credit; the Flowchart export later): the same
// geometry as public/icons/mark-v2.svg, as canvas paths and as an SVG built element by element.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_MARK, brandMarkSvg, drawBrandMark, glyphPathData, rampColor, tileColorAt } from "./brand-mark";

const SOURCE = readFileSync("public/icons/mark-v2.svg", "utf8");
const attr = (tag: string, name: string) => new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(SOURCE)?.[1];

/** The owner's pick (HANDOFF.md, 2026-10-30): "C. Blue to teal", top-left to bottom-right. */
const PICKED = { x1: 0, y1: 0, x2: 1, y2: 1, stops: [[0, "#3561f0"], [0.5, "#2a5ee0"], [1, "#1a7a9a"]] };

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** WCAG 2.2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgbOf(hex).map((v) => v / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** The picked ramp at t, worked out here from the stops (sRGB, as SVG and canvas gradients interpolate). */
function expectedAt(t: number): number[] {
  const s = PICKED.stops as [number, string][];
  const i = t <= 0.5 ? 1 : 2;
  const f = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
  return rgbOf(s[i - 1][1]).map((v, j) => Math.round(v + (rgbOf(s[i][1])[j] - v) * f));
}

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
  it("the tile: the rect and its corner radius; the 32-unit view box", () => {
    expect(attr("svg", "viewBox")).toBe(`0 0 ${BRAND_MARK.view} ${BRAND_MARK.view}`);
    const { tile } = BRAND_MARK;
    expect(["x", "y", "width", "height", "rx"].map((a) => Number(attr("rect", a)))).toEqual([tile.x, tile.y, tile.size, tile.size, tile.radius]);
  });

  it("the tile's fill is the picked blue-to-teal gradient, in the file and in BRAND_MARK, and nothing else", () => {
    const { tile } = BRAND_MARK;
    expect(JSON.parse(JSON.stringify(tile.gradient))).toEqual(PICKED);
    expect("fill" in tile, "no flat fill left beside the gradient").toBe(false);
    // The file: one linearGradient, its own id, in bounding-box units, top-left to bottom-right.
    expect(SOURCE.match(/<linearGradient\b/g), "one gradient").toHaveLength(1);
    expect(SOURCE.match(/\sid="/g), "one id in the file").toHaveLength(1);
    const id = attr("linearGradient", "id")!;
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(attr("rect", "fill")).toBe(`url(#${id})`);
    expect(attr("linearGradient", "gradientUnits") ?? "objectBoundingBox").toBe("objectBoundingBox");
    expect(["x1", "y1", "x2", "y2"].map((a) => Number(attr("linearGradient", a)))).toEqual([PICKED.x1, PICKED.y1, PICKED.x2, PICKED.y2]);
    const stops = [...SOURCE.matchAll(/<stop\b[^>]*\soffset="([^"]*)"[^>]*\sstop-color="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]);
    expect(stops).toEqual(PICKED.stops);
    expect(SOURCE.match(/<stop\b/g)).toHaveLength(PICKED.stops.length);
  });

  it("the app's own mark draws the same logo: tokens.css holds the stops, the rail paints them corner to corner, no theme colour", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const app = readFileSync("src/styles/app.css", "utf8");
    const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(tokens)?.[1];
    expect(["logo-from", "logo-mid", "logo-to"].map((n) => [n, token(n)])).toEqual([["logo-from", "#3561f0"], ["logo-mid", "#2a5ee0"], ["logo-to", "#1a7a9a"]]);
    expect(["logo-from", "logo-mid", "logo-to"].map(token)).toEqual(BRAND_MARK.tile.gradient.stops.map(([, c]) => c));
    const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.>]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(app)?.[1] ?? "";
    // 135deg on a square box is the SVG's x1=0 y1=0 x2=1 y2=1: the gradient line runs corner to
    // corner (its length w*sin + h*cos is the diagonal), 0 at the top-left, 1 at the bottom-right.
    expect(rule(".rail-mark")).toMatch(/background:\s*linear-gradient\(135deg, var\(--logo-from\), var\(--logo-mid\) 50%, var\(--logo-to\)\);/);
    expect(app, "the mark no longer takes the theme's brand colours").not.toMatch(/\.mark-tile|\.mark-glyph/);
  });

  it("white chevrons pass 4.5:1 at every point of the ramp, and the tile passes 3:1 on #0d1117", () => {
    for (let i = 0; i <= 100; i++) {
      const c = rampColor(i / 100);
      expect(contrast("#ffffff", c), `white on ${c} at t=${i / 100}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, "#0d1117"), `${c} on #0d1117 at t=${i / 100}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("rampColor and tileColorAt: the stops at their offsets, sRGB in between, the tile's own box along its diagonal", () => {
    expect([0, 0.5, 1].map(rampColor)).toEqual(["#3561f0", "#2a5ee0", "#1a7a9a"]);
    for (const t of [0.1, 0.25, 0.3, 0.6, 0.75, 0.9]) expect(rgbOf(rampColor(t)), `t=${t}`).toEqual(expectedAt(t));
    expect([-1, 2].map(rampColor), "clamped").toEqual(["#3561f0", "#1a7a9a"]);
    // The tile spans 1 to 31 units: its corners are the end stops, its centre the middle one.
    expect(tileColorAt(1, 1)).toBe("#3561f0");
    expect(tileColorAt(31, 31)).toBe("#1a7a9a");
    expect(tileColorAt(16, 16)).toBe("#2a5ee0");
    expect(tileColorAt(31, 1), "the other diagonal is all the middle stop").toBe("#2a5ee0");
    expect(rgbOf(tileColorAt(16, 5))).toEqual(expectedAt((15 / 30 + 4 / 30) / 2));
    expect(tileColorAt(0, 0), "outside the tile: clamped").toBe("#3561f0");
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
  const gradients: { args: number[]; stops: [number, string][] }[] = [];
  const ctx = {
    fillStyle: "" as unknown, strokeStyle: "" as unknown, lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    createLinearGradient: (...args: number[]) => {
      const g = { args, stops: [] as [number, string][], addColorStop: (o: number, c: string) => void g.stops.push([o, c]) };
      gradients.push(g);
      return g;
    },
    beginPath: () => (points = []),
    moveTo: (x: number, y: number) => (calls.push({ op: "moveTo", args: [x, y] }), points.push([x, y])),
    lineTo: (x: number, y: number) => (calls.push({ op: "lineTo", args: [x, y] }), points.push([x, y])),
    arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => (calls.push({ op: "arcTo", args: [x1, y1, x2, y2, r] }), points.push([x1, y1], [x2, y2])),
    closePath: () => calls.push({ op: "closePath", args: [] }),
    fill: () => calls.push({ op: "fill", args: [], style: { fillStyle: ctx.fillStyle, points: [...points] } }),
    stroke: () => calls.push({ op: "stroke", args: [], style: { strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, lineJoin: ctx.lineJoin, points: [...points] } }),
  };
  return { ctx, calls, gradients };
}

describe("drawBrandMark (canvas)", () => {
  for (const [x, y, size] of [[0, 0, 32], [100, 40, 12], [7.5, 3.25, 18]] as const) {
    it(`fills the tile and strokes the glyph at ${x}, ${y}, ${size} px`, () => {
      const { ctx, calls, gradients } = recorder();
      drawBrandMark(ctx as unknown as CanvasRenderingContext2D, x, y, size);
      const k = size / 32;
      const fills = calls.filter((c) => c.op === "fill");
      const strokes = calls.filter((c) => c.op === "stroke");
      expect(fills).toHaveLength(1);
      expect(strokes).toHaveLength(1);
      expect(calls.indexOf(fills[0]), "the tile first, the glyph over it").toBeLessThan(calls.indexOf(strokes[0]));
      // The tile's fill is one linear gradient over the tile's own box, top-left to bottom-right, with the picked stops.
      expect(gradients).toHaveLength(1);
      expect(fills[0].style!.fillStyle).toBe(gradients[0]);
      [x + 1 * k, y + 1 * k, x + 31 * k, y + 31 * k].forEach((v, i) => expect(gradients[0].args[i], `gradient arg ${i}`).toBeCloseTo(v, 9));
      expect(gradients[0].stops).toEqual(PICKED.stops);
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
    expect(svg.children.map((c) => c.tag)).toEqual(["defs", "rect", "path"]);
    const [defs, rect, path] = svg.children;
    expect(defs.attrs.size).toBe(0);
    expect(defs.children.map((c) => c.tag)).toEqual(["linearGradient"]);
    const [gradient] = defs.children;
    const id = gradient.attrs.get("id")!;
    expect(Object.fromEntries(gradient.attrs)).toEqual({ id, x1: "0", y1: "0", x2: "1", y2: "1" });
    expect(gradient.children.map((s) => Object.fromEntries(s.attrs))).toEqual(PICKED.stops.map(([o, c]) => ({ offset: String(o), "stop-color": c })));
    expect(Object.fromEntries(rect.attrs)).toEqual({ x: "1", y: "1", width: "30", height: "30", rx: "7", fill: `url(#${id})` });
    expect(Object.fromEntries(path.attrs)).toEqual({
      d: glyphPathData(), fill: "none", stroke: "#ffffff", "stroke-width": "3.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    expect(polylines(path.attrs.get("d")!)).toEqual(BRAND_MARK.glyph.lines);
  });

  it("gives every mark its own gradient id, so several marks in one document each paint their own tile", () => {
    const { doc } = fakeDocument();
    const ids = Array.from({ length: 5 }, () => {
      const svg = brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, 16) as unknown as FakeNode;
      return svg.children[0].children[0].attrs.get("id")!;
    });
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("makes no script, no link, no event handler and no reference but the tile's to its own gradient", () => {
    const { doc, made } = fakeDocument();
    brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, 20);
    expect(made.map((n) => n.tag).sort()).toEqual(["defs", "linearGradient", "path", "rect", "stop", "stop", "stop", "svg"]);
    const ownId = made.find((n) => n.tag === "linearGradient")!.attrs.get("id");
    for (const n of made) {
      for (const [name, value] of n.attrs) {
        expect(name, `${n.tag} ${name}`).not.toMatch(/^on|href$|^src$|^style$/i);
        if (name === "id") expect(n.tag, "only the gradient has an id").toBe("linearGradient");
        // The one url() allowed: the tile's fill, naming the gradient made with it.
        const allowed = n.tag === "rect" && name === "fill" && value === `url(#${ownId})`;
        if (!allowed) expect(value, `${n.tag} ${name}`).not.toMatch(/url\(|#[^0-9a-f]|javascript:|data:|https?:|</i);
        expect(value, `${n.tag} ${name}`).not.toMatch(/javascript:|data:|https?:|</i);
      }
    }
  });

  it("refuses a size that is not a positive finite number (it is written into an attribute)", () => {
    const { doc } = fakeDocument();
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => brandMarkSvg(doc as unknown as Pick<Document, "createElementNS">, bad), String(bad)).toThrow(RangeError);
  });
});
