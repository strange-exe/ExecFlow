/// <reference types="node" />
// The Flowchart export (milestone 4): the SVG built from the same safe DOM as the view, with every
// colour resolved to #rrggbb, no rings or interactive attributes, nothing external, and the brand
// footer (mark, "Made with ExecFlow", the file and the function); the file-name rule; the scale cap.
import { describe, expect, it } from "vitest";
import { BRAND_MARK } from "../editor/brand-mark";
import { CHART_TOKENS, chooseExportScale, drawExport, exportFileName, exportSvg, FOOTER_TEXT, mixHex, printColors, type ExportLook } from "./export";
import { layoutChart } from "./layout";
import type { FlowChart } from "./model";
import { FakeElement, fakeDocument, serialize } from "./fixtures/fake-dom";
import { chartFile, fixture, ok, withPack } from "./fixtures/harness";

const test = withPack ? it : it.skip;
const doc = fakeDocument as unknown as Document;
const LOOK: ExportLook = { colors: printColors(), codeFont: "monospace", uiFont: "sans-serif" };

function svgOf(chart: FlowChart, file = "grades.c", look = LOOK): FakeElement {
  return exportSvg({ chart, layout: layoutChart(chart), file, look }, doc) as unknown as FakeElement;
}

const ALLOWED = new Set(["svg", "title", "rect", "g", "polyline", "polygon", "line", "circle", "text", "tspan", "path", "defs", "linearGradient", "stop"]);

/** The brand mark's gradient ids in the export: the only things a url() may name (brand-mark.ts). */
const gradientIds = (svg: FakeElement) => new Set(svg.all().filter((e) => e.tagName === "linearGradient").map((e) => e.getAttribute("id")!));

describe("flowchart SVG export", () => {
  test("every colour is resolved to #rrggbb; no var(), class, ring or Tab stop is left", async () => {
    const main = ok((await chartFile("c", fixture("switch.c"))).charts[0]);
    const svg = svgOf(main);
    const xml = serialize(svg);
    expect(xml).not.toContain("var(");
    expect(xml).not.toContain("fc-ring");
    const ids = gradientIds(svg);
    expect(ids.size, "one gradient: the brand mark's tile").toBe(1);
    for (const e of svg.all()) {
      expect(ALLOWED.has(e.tagName), e.tagName).toBe(true);
      for (const name of e.attributes.keys()) {
        expect(name === "class" || name === "tabindex" || name === "role" && e !== svg || name.startsWith("on") || name.includes("href") || name.startsWith("data-"), `${e.tagName} ${name}`).toBe(false);
        if (name === "id") expect(e.tagName, "only a gradient has an id").toBe("linearGradient");
      }
      for (const attr of ["fill", "stroke", "stop-color"]) {
        const v = e.getAttribute(attr);
        // A fill may name the mark's own gradient, on the mark's tile only; every other colour is resolved.
        const ownGradient = attr === "fill" && e.tagName === "rect" && /^url\(#([a-z][a-z0-9-]*)\)$/.exec(v ?? "")?.[1];
        if (ownGradient) expect(ids.has(ownGradient), `${v} names a gradient in this SVG`).toBe(true);
        else if (v !== null) expect(v, `${e.tagName} ${attr}`).toMatch(/^(#[0-9a-f]{6}|none)$/);
      }
      const style = e.getAttribute("style") ?? "";
      for (const m of style.matchAll(/(?:fill|stroke):\s*([^;]+)/g)) expect(m[1].trim(), style).toMatch(/^(#[0-9a-f]{6}|none)$/);
      expect(style).not.toMatch(/url\(|@import|expression\(/);
    }
    // The ground is the print-safe paper.
    expect(svg.children.find((c): c is FakeElement => c instanceof FakeElement && c.tagName === "rect")!.getAttribute("fill")).toBe("#ffffff");
  });

  test("the footer: the brand mark, then Made with ExecFlow, then the file and the function, under the chart", async () => {
    const main = ok((await chartFile("c", fixture("switch.c"))).charts[0]);
    const layout = layoutChart(main);
    const svg = svgOf(main, "lab1/switch.c");
    const footer = svg.all().find((e) => e.getAttribute("data-part") === null && e.getAttribute("aria-label") === null && e.tagName === "g" && e.all().some((x) => x.tagName === "svg"))!;
    expect(footer).toBeDefined();
    const mark = footer.all().find((e) => e.tagName === "svg")!;
    const gradient = mark.all().find((e) => e.tagName === "linearGradient")!;
    expect(mark.all().find((e) => e.tagName === "rect")!.getAttribute("fill")).toBe(`url(#${gradient.getAttribute("id")})`);
    expect(gradient.all().filter((e) => e.tagName === "stop").map((s) => [Number(s.getAttribute("offset")), s.getAttribute("stop-color")])).toEqual(BRAND_MARK.tile.gradient.stops);
    const texts = footer.all().filter((e) => e.tagName === "text").map((t) => t.textContent);
    expect(texts).toEqual([FOOTER_TEXT, "switch.c, function main"]);
    // Under the chart, in reading order left to right.
    expect(Number(mark.getAttribute("y"))).toBeGreaterThan(layout.height - 1);
    const xs = [mark, ...footer.all().filter((e) => e.tagName === "text")].map((e) => Number(e.getAttribute("x")));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // The file and function end where the rule ends, so the space between the two reads as layout.
    const where = footer.all().filter((e) => e.tagName === "text").at(-1)!;
    const rule = footer.all().find((e) => e.tagName === "line")!;
    expect(where.getAttribute("text-anchor")).toBe("end");
    expect(Number(where.getAttribute("x"))).toBe(Number(rule.getAttribute("x2")));
    // The title names the chart.
    expect(svg.all().find((e) => e.tagName === "title")!.textContent).toBe("Flowchart of main in switch.c");
    expect(svg.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
  });

  test("a chart narrower than the footer widens the image to hold it", async () => {
    const tiny = ok((await chartFile("python", "x = 1\n")).charts[0]);
    const svg = svgOf(tiny, "a-rather-long-file-name-for-the-footer.py");
    const width = Number(svg.getAttribute("width"));
    expect(width).toBeGreaterThan(layoutChart(tiny).width);
    // A Python file's top level is named so in the footer.
    const last = svg.all().filter((e) => e.tagName === "text").at(-1)!;
    expect(last.textContent).toBe("a-rather-long-file-name-for-the-footer.py, top level");
    // Right-aligned inside the margin, and (at the footer's 7 px a character) clear of the credit.
    const credit = svg.all().filter((e) => e.tagName === "text").at(-2)!;
    expect(Number(last.getAttribute("x"))).toBeLessThanOrEqual(width - 24);
    expect(Number(last.getAttribute("x")) - [...last.textContent].length * 7).toBeGreaterThanOrEqual(Number(credit.getAttribute("x")) + FOOTER_TEXT.length * 7 + 16);
  });

  test("Match the editor uses the colours it is given", async () => {
    const main = ok((await chartFile("c", fixture("sequence.c"))).charts[0]);
    const colors = Object.fromEntries(CHART_TOKENS.map((t, i) => [t, `#${(0x101010 * (i + 1)).toString(16).padStart(6, "0")}`])) as ExportLook["colors"];
    const xml = serialize(svgOf(main, "sequence.c", { colors, codeFont: "monospace", uiFont: "sans-serif" }));
    // The tokens this chart draws with (a sequence: terminators, steps, an output; no branch, no call).
    for (const t of ["surface-raised", "border-strong", "text", "text-secondary", "success", "info"] as const) expect(xml, t).toContain(colors[t]);
    // A kind's tint is resolved: its hue at CHART_TINT percent over surface-raised, never a color-mix.
    expect(xml).toContain(mixHex(colors.success, colors["surface-raised"], 14));
    expect(xml).not.toContain("color-mix");
    expect(mixHex("#ffffff", "#000000", 50)).toBe("#808080");
  });

  test("names and labels with markup and direction characters stay text", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const src = `int main(void) {\n  printf("</text><script>alert(1)</script>");\n  return 0;\n}\n`;
    const main = ok((await chartFile("c", src)).charts[0]);
    const svg = svgOf(main, `<img src=x onerror=alert(1)>${rlo}.c`);
    const tags = new Set(svg.all().map((e) => e.tagName));
    expect(tags.has("script") || tags.has("img") || tags.has("foreignObject")).toBe(false);
    const text = svg.texts().map((t) => t.data).join("\n");
    expect(text).toContain("<img src=x onerror=alert(1)>[U+202E].c, function main");
    expect(text).not.toContain(rlo);
    expect(text).toContain("</text><script>alert(1)</script>");
  });
});

describe("export file names", () => {
  it("is <file>-<function>-flowchart.<ext>, with every unsafe run of characters as one dash", () => {
    expect(exportFileName("grades.c", "main", "png")).toBe("grades-c-main-flowchart.png");
    expect(exportFileName("lab 2/my file?.cpp", "Shape::area<int>", "svg")).toBe("my-file-cpp-Shape-area-int-flowchart.svg");
    expect(exportFileName("main.py", "Program", "svg")).toBe("main-py-Program-flowchart.svg");
    const rlo = String.fromCodePoint(0x202e);
    expect(exportFileName(`ev${rlo}il.c`, "m".repeat(200), "png")).toMatch(/^ev-U-202E-il-c-m{1,60}-flowchart\.png$/);
    expect(exportFileName("...", "", "png")).toBe("chart-flowchart.png");
  });

  it("keeps letters of every script (a Hindi function name), and cuts long names by character, never inside a pair", () => {
    const ganana = String.fromCodePoint(0x917, 0x923, 0x928, 0x93e); // "ganana", with a vowel sign
    expect(exportFileName("grades.c", ganana, "png")).toBe(`grades-c-${ganana}-flowchart.png`);
    // Long names: the whole name fits the 100-unit file-name cap with its extension, and a letter
    // outside the BMP (two UTF-16 units) is never cut in half.
    const script = String.fromCodePoint(0x1d49c).repeat(100);
    for (const [file, fn, ext] of [["a.c", script, "svg"], ["f".repeat(90) + ".c", "g".repeat(90), "png"]] as const) {
      const name = exportFileName(file, fn, ext);
      expect(name.endsWith(`-flowchart.${ext}`), name).toBe(true);
      expect(name.length).toBeLessThanOrEqual(100);
      expect([...name].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false);
    }
    expect(exportFileName("a.c", script, "svg").startsWith(`a-c-${String.fromCodePoint(0x1d49c)}`)).toBe(true);
  });
});

/** One paint call a fake 2D context saw: what it painted, in which colour and width, and the path it painted. */
type Op = { op: "fill" | "stroke" | "text"; color: string; width?: number; weight?: string; d?: string };

/** A 2D context that records every paint call (and the path since beginPath) until the chart's restore(). */
function recordingContext() {
  const ops: Op[] = [];
  /** Each stroke's join, with the miter limit when it is "miter" (the canvas default limit is 10). */
  const joins: string[] = [];
  let path: string[] = [];
  let open = true;
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    lineJoin: "",
    lineCap: "",
    miterLimit: 10,
    setTransform() {},
    fillRect() {},
    save() {},
    translate() {},
    restore() {
      open = false;
    },
    beginPath() {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => path.push(`L${x},${y}`),
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => path.push(`Q${cx},${cy} ${x},${y}`),
    arcTo() {},
    arc() {},
    closePath() {},
    // The brand mark's tile in the footer (after the chart's restore, so not recorded here).
    createLinearGradient: () => ({ addColorStop() {} }),
    fill() {
      if (open) ops.push({ op: "fill", color: ctx.fillStyle });
    },
    stroke() {
      if (open) ops.push({ op: "stroke", color: ctx.strokeStyle, width: ctx.lineWidth, d: path.join(" ") });
      if (open) joins.push(ctx.lineJoin === "miter" ? `miter ${ctx.miterLimit}` : ctx.lineJoin);
    },
    fillText() {
      // Edge labels only (12 px): box labels are 13 px code, notes 11 px.
      if (open && / 12px /.test(` ${ctx.font} `)) ops.push({ op: "text", color: ctx.fillStyle, weight: ctx.font.startsWith("600 ") ? "600" : "400" });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, joins };
}

const styleOf = (e: FakeElement) => new Map((e.getAttribute("style") ?? "").split(";").filter(Boolean).map((kv) => kv.split(":") as [string, string]));

/** The same paint calls, read from the SVG export's drawing, in its order. */
function svgOps(drawing: FakeElement): Op[] {
  const ops: Op[] = [];
  for (const e of drawing.all()) {
    const s = styleOf(e);
    if (e.tagName === "text") {
      if (s.get("font-size") === "12px") ops.push({ op: "text", color: s.get("fill")!, weight: s.get("font-weight") ?? "400" });
      continue;
    }
    if (!["path", "polygon", "rect", "circle", "line"].includes(e.tagName)) continue;
    const fill = s.get("fill");
    if (fill && fill !== "none") ops.push({ op: "fill", color: fill });
    const stroke = s.get("stroke");
    if (stroke && stroke !== "none") ops.push({ op: "stroke", color: stroke, width: Number(s.get("stroke-width")), ...(e.tagName === "path" ? { d: e.getAttribute("d")! } : {}) });
  }
  return ops;
}

describe("flowchart PNG export", () => {
  test("paints in the SVG's colours: hue tints and outlines, Yes and No connectors and heads, rounded corners, bold edge labels", async () => {
    const src = ["int sq(int x) { return x * x; }", "int main(void) {", "  int n;", '  scanf("%d", &n);', "  if (n > 0) {", '    printf("%d", sq(n));', "  } else {", "    n = 0;", "  }", "  return 0;", "}", ""].join("\n");
    const main = ok((await chartFile("c", src)).charts.find((c) => c.name === "main")!);
    // The chart has every hue: terminators, a decision with Yes and No, input and a call.
    expect(new Set(main.nodes.map((n) => n.kind))).toEqual(new Set(["start", "end", "decision", "io", "call", "process"]));
    expect(main.edges.map((e) => e.label).filter(Boolean).sort()).toEqual(["No", "Yes"]);
    const layout = layoutChart(main);
    const drawing = (svgOf(main).all().filter((e) => e.tagName === "svg")[1] as FakeElement);
    const { ctx, ops, joins } = recordingContext();
    drawExport(ctx, { chart: main, layout, file: "grades.c", look: LOOK }, 2);
    // Connectors join round; boxes keep the SVG's default miter join and its default limit of 4, so
    // a narrow diamond corner bevels in the PNG as it does in the SVG.
    expect(new Set(joins)).toEqual(new Set(["round", "miter 4"]));
    // Paint for paint in the SVG's order and colours; each connector on the SVG's own path, corner
    // for corner, stopping under its arrowhead (only the connectors' paths are compared).
    const want = svgOps(drawing);
    const got = ops.map((o, i) => (want[i]?.d === undefined ? { ...o, d: undefined } : o));
    expect(got).toEqual(want.map((o) => ({ ...o, d: o.d })));
    expect(want.some((o) => o.d?.includes("Q"))).toBe(true);
    // The colours are really the hues, not the old plain ink.
    const c = LOOK.colors;
    expect(ops).toContainEqual({ op: "fill", color: mixHex(c.warning, c["surface-raised"], 14) });
    expect(ops).toContainEqual(expect.objectContaining({ op: "stroke", color: c.success, width: 1.5 }));
    expect(ops).toContainEqual(expect.objectContaining({ op: "stroke", color: c.danger, width: 1.5 }));
    expect(ops).toContainEqual({ op: "text", color: c.text, weight: "600" });
  });
});

describe("the PNG's scale", () => {
  it("is 2x when the bitmap fits; steps down past the browsers' safe size, and says so; null past 0.25x", () => {
    expect(chooseExportScale(800, 600)).toEqual({ scale: 2, width: 1600, height: 1200, reduced: false });
    const big = chooseExportScale(900, 12_000)!;
    expect(big.reduced).toBe(true);
    expect(big.scale).toBeLessThan(2);
    expect(big.height).toBeLessThanOrEqual(16_384);
    expect(big.width * big.height).toBeLessThanOrEqual(16_777_216);
    expect(chooseExportScale(90_000, 90_000)).toBeNull();
  });
});
