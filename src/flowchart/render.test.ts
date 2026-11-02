/// <reference types="node" />
// The SVG renderer: ISO 5807 shapes per box kind, every box named and mapped to its lines, code
// text only ever in text nodes, colours only from the theme's custom properties, and a text
// outline of the steps in reading order.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { labelRect, layoutChart, type LaidEdge } from "./layout";
import type { FlowChart, FlowNode } from "./model";
import { arrowCorners, arrowLength, kindHue, kindSwatch, LEGEND, renderChart, roundedPath, stepList, TRACE_LEGEND, traceSwatch } from "./render";
import { FakeElement, fakeDocument, serialize } from "./fixtures/fake-dom";
import { chartFile, fixture, ok, withPack } from "./fixtures/harness";
import { MARKS, MARKS_LINES, moduleTrace } from "./fixtures/trace-runs";
import { traceChart } from "./trace";

const test = withPack ? it : it.skip;
const SVG = "http://www.w3.org/2000/svg";

function draw(chart: FlowChart): FakeElement {
  return renderChart(chart, layoutChart(chart), fakeDocument as unknown as Document) as unknown as FakeElement;
}

const steps = (svg: FakeElement) => svg.all().filter((e) => e.getAttribute("role") === "listitem");

describe("flowchart renderer", () => {
  test("one shape per box kind (ISO 5807), each box named and mapped to its source lines", async () => {
    const file = await chartFile("c", fixture("early-return.c"));
    const find = ok(file.charts[1]);
    const main = ok(file.charts[0]);
    const goto = ok((await chartFile("c", fixture("goto.c"))).charts[0]);
    const io = ok((await chartFile("c", fixture("sequence.c"))).charts[0]);
    const shapeOf = (chart: FlowChart, kind: string) => {
      const svg = draw(chart);
      const id = chart.nodes.find((n) => n.kind === kind)!.id;
      const g = steps(svg).find((e) => e.getAttribute("data-node") === String(id))!;
      return g.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName !== "title" && c.tagName !== "text" && c.getAttribute("class") !== "fc-ring");
    };
    const tags = (els: FakeElement[]) => els.map((e) => e.tagName);
    expect(tags(shapeOf(find, "start"))).toEqual(["rect"]);
    expect(shapeOf(find, "start")[0].getAttribute("rx")).not.toBe("0");
    expect(tags(shapeOf(find, "end"))).toEqual(["rect"]);
    expect(tags(shapeOf(find, "process"))).toEqual(["rect"]);
    expect(shapeOf(find, "process")[0].getAttribute("rx")).toBe("2");
    expect(tags(shapeOf(find, "decision"))).toEqual(["polygon"]);
    expect(shapeOf(find, "decision")[0].getAttribute("points")!.split(" ").length).toBe(4);
    expect(tags(shapeOf(io, "io"))).toEqual(["polygon"]);
    expect(tags(shapeOf(main, "call"))).toEqual(["rect", "line", "line"]);
    expect(tags(shapeOf(goto, "connector"))).toEqual(["circle"]);

    const svg = draw(find);
    expect(svg.namespaceURI).toBe(SVG);
    expect(svg.tagName).toBe("svg");
    expect(svg.getAttribute("aria-label")).toBe("Flowchart of find");
    const items = steps(svg);
    expect(items.length).toBe(find.nodes.length);
    for (const [i, g] of items.entries()) {
      const node = find.nodes[i];
      expect(g.getAttribute("data-line-from")).toBe(String(node.from));
      expect(g.getAttribute("data-line-to")).toBe(String(node.to));
      expect(g.getAttribute("aria-label")).toContain(node.text);
      // The tooltip holds the full text.
      const title = g.children.find((c): c is FakeElement => c instanceof FakeElement && c.tagName === "title")!;
      expect(title.textContent).toContain(node.text);
    }
    // Kind, label and lines (the editor's line numbers).
    expect(items[0].getAttribute("aria-label")).toBe("Start, line 1");
    expect(items[2].getAttribute("aria-label")).toBe("Decision: i < n ?, line 2");
    expect(items[4].getAttribute("aria-label")).toBe("End: return i, line 4");
    // One Tab stop for the whole list (the view moves it): every box starts out of the Tab order,
    // with a ring the view shows for focus and for the caret's box.
    for (const g of items) {
      expect(g.getAttribute("tabindex")).toBe("-1");
      expect(g.children.filter((c) => c instanceof FakeElement && c.getAttribute("class") === "fc-ring").length).toBe(1);
    }
  });

  test("a merged box names its lines as a range; a note and an unreachable box say so", async () => {
    const main = ok((await chartFile("c", fixture("early-return.c"))).charts[0]);
    const items = steps(draw(main));
    expect(items[4].getAttribute("aria-label")).toBe("at = 0, never reached, line 14");
    const seq = ok((await chartFile("c", fixture("sequence.c"))).charts[0]);
    expect(steps(draw(seq))[1].getAttribute("aria-label")).toBe("int a = 1; int b = 2; int c = a + b, lines 3 to 5");
    const one = ok((await chartFile("cpp", fixture("one-step.cpp"))).charts[0]);
    expect(steps(draw(one))[2].getAttribute("aria-label")).toBe("try {, shown as one step, lines 8 to 12");
  });

  test("the steps sit in a list; the lines are hidden from screen readers (the list and the step list say it all)", async () => {
    const svg = draw(ok((await chartFile("c", fixture("else-if.c"))).charts[0]));
    const list = svg.all().find((e) => e.getAttribute("role") === "list")!;
    expect(steps(list).length).toBe(9);
    const edges = svg.all().find((e) => e.getAttribute("data-part") === "edges")!;
    expect(edges.getAttribute("aria-hidden")).toBe("true");
  });

  test("every edge is a line with rounded corners and an arrowhead, and its label is drawn", async () => {
    const chart = ok((await chartFile("c", fixture("switch.c"))).charts[0]);
    const layout = layoutChart(chart);
    const svg = renderChart(chart, layout, fakeDocument as unknown as Document) as unknown as FakeElement;
    const edges = svg.all().find((e) => e.getAttribute("data-part") === "edges")!;
    const lines = edges.all().filter((e) => e.tagName === "path");
    expect(lines.length).toBe(layout.edges.length);
    // A bend is a curve (Q), not a sharp corner, on every edge that turns.
    for (const [i, e] of layout.edges.entries()) if (e.points.length > 2) expect(lines[i].getAttribute("d"), `edge ${i}`).toContain("Q");
    expect(edges.all().filter((e) => e.getAttribute("data-part") === "arrow").length).toBe(layout.edges.length);
    const labels = edges.all().filter((e) => e.tagName === "text").map((e) => e.textContent);
    expect(labels.sort()).toEqual(["1, 7", "2", "3", "default"]);
  });

  test("attack text from the code stays text: no elements, no markup, no links in the SVG", async () => {
    const src = [
      "#include <stdio.h>",
      "int main(void) {",
      '  printf("</text><script>alert(1)</script>");',
      '  printf("<img src=x onerror=alert(1)>");',
      `  int ${"x"} = 1; /* ${String.fromCodePoint(0x202e)} */`,
      `  if (x == '${String.fromCodePoint(0x202e)}') x = 2;`,
      '  printf("<foreignObject><a href=\\"javascript:alert(1)\\">url(x)</a></foreignObject>");',
      "  return 0;",
      "}",
    ].join("\n");
    const svg = draw(ok((await chartFile("c", src)).charts[0]));
    const tags = new Set(svg.all().map((e) => e.tagName));
    for (const bad of ["script", "img", "foreignObject", "a", "iframe", "use", "image"]) expect(tags.has(bad), bad).toBe(false);
    for (const e of svg.all()) {
      for (const name of e.attributes.keys()) expect(name.startsWith("on") || name.includes("href"), `${e.tagName} ${name}`).toBe(false);
    }
    // The attack strings arrive as text, whole.
    const text = svg.texts().map((t) => t.data).join("\n");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).toContain("[U+202E]");
    expect(text).not.toContain(String.fromCodePoint(0x202e));
    const xml = serialize(svg);
    // Escaped text and names (aria-label, the tooltip) may quote these words, as text; the markup itself never has them.
    expect(xml).not.toMatch(/<script|<img|<foreignObject/);
    const markup = xml.replace(/>[^<]*</g, "><").replace(/="[^"]*"/g, '=""');
    for (const bad of ["href", "url(", "javascript:", "script", "foreignObject"]) expect(markup.includes(bad), bad).toBe(false);
    // The colours' url()-free styles: no style value can load anything.
    for (const e of svg.all()) expect(e.getAttribute("style") ?? "", e.tagName).not.toMatch(/url\(|@import|expression\(/);
  });

  test("colours come only from the theme's custom properties", async () => {
    const svg = draw(ok((await chartFile("cpp", fixture("ai-style.cpp"))).charts[0]));
    const styles = svg.all().map((e) => e.getAttribute("style") ?? "");
    const colours = styles.flatMap((s) => [...s.matchAll(/(?:fill|stroke|color):\s*([^;]+)/g)].map((m) => m[1].trim()));
    expect(colours.length).toBeGreaterThan(10);
    // A token, or a kind's tint: a token mixed over surface-raised (CHART_TINT).
    for (const c of colours) expect(c, c).toMatch(/^(var\(--[a-z-]+\)|none|color-mix\(in srgb, var\(--[a-z-]+\) \d+%, var\(--surface-raised\)\))$/);
    // Colour follows meaning: a decision is drawn in the warning hue, a plain step stays neutral.
    const shapeStyle = (kind: string) => svg.all().find((e) => e.getAttribute("data-kind") === kind)?.children.find((c) => c instanceof FakeElement && c.tagName !== "title" && c.getAttribute("class") !== "fc-ring") as FakeElement | undefined;
    expect(shapeStyle("decision")?.getAttribute("style")).toContain("stroke:var(--warning)");
    expect(shapeStyle("process")?.getAttribute("style")).toContain("stroke:var(--border-strong)");
    for (const e of svg.all()) {
      for (const attr of ["fill", "stroke", "color"]) expect(e.getAttribute(attr), `${e.tagName} ${attr}`).toBeNull();
    }
  });

  test("the module never parses markup and draws no outside references (source scan)", () => {
    const src = readFileSync("src/flowchart/render.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "createContextualFragment", "document.write", "foreignObject", "href", "url(", "eval(", "new Function"]) {
      expect(src.includes(bad), bad).toBe(false);
    }
    // No raw colours: every colour is a custom property.
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  test("stepList: a text outline in reading order, with where each step goes", async () => {
    const main = ok((await chartFile("c", fixture("else-if.c"))).charts[0]);
    expect(stepList(main).map((s) => s.text)).toEqual([
      "1. Start. Next: step 2.",
      "2. int n. Next: step 3.",
      '3. Input or output: scanf("%d", &n). Next: step 4.',
      "4. Decision: n > 0 ? Yes: step 5. No: step 6.",
      '5. Input or output: printf("positive"). Next: step 9.',
      "6. Decision: n < 0 ? Yes: step 7. No: step 8.",
      '7. Input or output: printf("negative"). Next: step 9.',
      '8. Input or output: printf("zero"). Next: step 9.',
      "9. End: return 0.",
    ]);
    const goto = ok((await chartFile("c", fixture("goto.c"))).charts[0]);
    expect(stepList(goto).map((s) => s.text)).toContain("6. Go to again: step 3.");
    // A goto whose label isn't in the chart is still a goto, never "Label ..." or "step NaN".
    const body = (code: string) => `int main(void) {\n  int x = 0;\n${code}\n  return x;\n}\n`;
    const nowhere = ok((await chartFile("c", body("  goto nowhere;"))).charts[0]);
    expect(stepList(nowhere).map((s) => s.text)).toContain("3. Go to nowhere (no such label). Next: step 4.");
    const folded = ok((await chartFile("c", body("#ifdef DEBUG\n  L: x++;\n#endif\n  goto L;"))).charts[0]);
    const words = stepList(folded).map((s) => s.text);
    expect(words).toContain("4. Go to L (label inside a step shown as one). Next: step 5.");
    expect(words.join(" ")).not.toContain("NaN");
    const early = ok((await chartFile("c", fixture("early-return.c"))).charts[0]);
    expect(stepList(early).map((s) => s.text)).toEqual([
      "1. Start. Next: step 2.",
      "2. int a[3] = {1, 2, 3}. Next: step 3.",
      "3. Call to find: int at = find(a, 3, 2). Next: step 4.",
      "4. End: return at.",
      "5. at = 0 (never reached). Next: step 6.",
      "6. End (never reached).",
    ]);
  });

  // The line always meets the arrowhead's base: a 9 px head when the last leg has room for it and a
  // corner, a smaller one (5 px at least) when a searched jump turns into a box's side just before it.
  it("the legend names every box kind once, and each swatch is its kind's shape in its kind's colours", () => {
    const kinds: FlowNode["kind"][] = ["start", "end", "process", "io", "decision", "call", "connector"];
    const named = LEGEND.flatMap((e) => (e.also ? [e.kind, e.also] : [e.kind]));
    expect([...named].sort()).toEqual([...kinds].sort());
    expect(LEGEND.map((e) => e.words)).toEqual(["Start and end", "Step", "Input or output", "Decision", "Function call", "Label or go to"]);
    const shapeTags: Record<string, string[]> = { start: ["rect"], end: ["rect"], process: ["rect"], io: ["polygon"], decision: ["polygon"], call: ["rect", "line", "line"], connector: ["circle"] };
    for (const kind of kinds) {
      const sw = kindSwatch(kind, fakeDocument as unknown as Document) as unknown as FakeElement;
      expect(sw.getAttribute("aria-hidden"), kind).toBe("true");
      const parts = sw.children.filter((c): c is FakeElement => c instanceof FakeElement);
      expect(parts.map((p) => p.tagName), kind).toEqual(shapeTags[kind]);
      const hue = kindHue(kind);
      const style = parts[0].getAttribute("style")!;
      // The view's own style strings: the hue's outline over its tint, or the neutral box.
      expect(style, kind).toContain(hue ? `stroke:var(--${hue})` : "stroke:var(--border-strong)");
      expect(style, kind).toContain(hue ? `color-mix(in srgb, var(--${hue})` : "fill:var(--surface-raised)");
    }
  });

  it("arrowheads fit their last leg, and the last corner's curve ends before the head", () => {
    const edge = (points: { x: number; y: number }[]): LaidEdge => ({ from: 1, to: 2, kind: "jump", points });
    const roomy = edge([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }]);
    expect(arrowLength(roomy)).toBe(9);
    expect(arrowCorners(roomy)).toEqual([{ x: 100, y: 40 }, { x: 104.5, y: 31 }, { x: 95.5, y: 31 }]);
    const tight = edge([{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: -4, y: 30 }]);
    expect(arrowLength(tight)).toBe(4);
    expect(arrowCorners(tight)[0]).toEqual({ x: -4, y: 30 });
    expect(arrowLength(edge([{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 8, y: 30 }]))).toBe(6);
    // A straight edge keeps the full head.
    expect(arrowLength(edge([{ x: 0, y: 0 }, { x: 0, y: 5 }]))).toBe(9);
    // roundedPath: every corner up to r, the last up to lastR (0 draws a sharp corner).
    const pts3 = [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 60 }];
    expect(roundedPath(pts3, 8, 0)).toBe("M0,0 L0,32 Q0,40 8,40 L40,40 L40,60");
    expect(roundedPath(pts3, 8, 3)).toBe("M0,0 L0,32 Q0,40 8,40 L37,40 Q40,40 40,43 L40,60");
    // A roomy last leg still keeps every corner within r.
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 60, y: 40 }], 8, 50)).toBe("M0,0 L0,32 Q0,40 8,40 L60,40");
  });

  test("on every fixture chart, each edge's last curve ends before its arrowhead's base", async () => {
    for (const name of ["break-continue.c", "nested-loops.c", "switch.c", "do-forever.c", "early-return.c", "else-if.c"]) {
      for (const c of (await chartFile("c", fixture(name))).charts) {
        if (!c.ok) continue;
        const layout = layoutChart(ok(c));
        const svg = renderChart(ok(c), layout, fakeDocument as unknown as Document) as unknown as FakeElement;
        const groups = svg.all().filter((e) => e.tagName === "g" && e.getAttribute("data-from") !== null);
        expect(groups).toHaveLength(layout.edges.length);
        layout.edges.forEach((e, i) => {
          const d = groups[i].children.find((x): x is FakeElement => x instanceof FakeElement && x.tagName === "path")!.getAttribute("d")!;
          const [end, before] = [e.points.at(-1)!, e.points.at(-2)!];
          const run = Math.hypot(end.x - before.x, end.y - before.y);
          // The last Q (the last corner) ends where the final straight run starts: at least a head away from the end.
          const lastQ = [...d.matchAll(/Q[-\d.]+,[-\d.]+ ([-\d.]+),([-\d.]+)/g)].at(-1);
          if (!lastQ || e.points.length < 3) return;
          const qEnd = { x: Number(lastQ[1]), y: Number(lastQ[2]) };
          const fromEnd = Math.hypot(end.x - qEnd.x, end.y - qEnd.y);
          expect(fromEnd, `${name} ${c.name} edge ${e.from}>${e.to}: run ${run}`).toBeGreaterThanOrEqual(arrowLength(e) - 0.001);
        });
      }
    }
  });
});

describe("the run trace on the chart", () => {
  async function traced() {
    const chart = ok((await chartFile("python", MARKS)).charts[0]);
    const layout = layoutChart(chart);
    const trace = traceChart(chart, moduleTrace(MARKS_LINES), true)!;
    const svg = renderChart(chart, layout, fakeDocument as unknown as Document, undefined, trace) as unknown as FakeElement;
    const groups = svg.all().filter((e) => e.tagName === "g" && e.getAttribute("data-from") !== null);
    return { chart, layout, trace, svg, groups };
  }
  const tracePath = (g: FakeElement) => g.children.find((c): c is FakeElement => c instanceof FakeElement && c.getAttribute("data-part") === "trace");
  const widthOf = (e: FakeElement) => Number(/stroke-width:([\d.]+)/.exec(e.getAttribute("style")!)![1]);

  test("each connector the run took is drawn at its count's width over the plain line; the rest stay plain", async () => {
    const { chart, layout, groups } = await traced();
    const byText = (text: string, label?: string) => layout.edges.findIndex((e) => chart.nodes[e.from].text.startsWith(text) && (label === undefined || e.label === label));
    const expectWidth = (i: number, count: number, width: number) => {
      const g = groups[i];
      expect(g.getAttribute("data-count"), `edge ${i}`).toBe(String(count));
      const plain = g.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === "path" && c.getAttribute("data-part") === null);
      expect(plain).toHaveLength(1);
      expect(widthOf(plain[0])).toBe(1.5);
      const over = tracePath(g)!;
      expect(over.getAttribute("d")).toBe(plain[0].getAttribute("d"));
      expect(over.getAttribute("pathLength")).toBe("1");
      expect(widthOf(over)).toBe(width);
    };
    expectWidth(byText("i < n", "Yes"), 5, 4);
    expectWidth(byText("i < n", "No"), 1, 1.5);
    expectWidth(byText("marks[i] > best", "Yes"), 2, 2.5);
    expectWidth(byText("marks[i] > best", "No"), 3, 3);
    expectWidth(byText("i += 1"), 5, 4);
    // Every edge of this run was taken: each has its trace path, in run order (--fc-i from 0).
    expect(groups.every((g) => tracePath(g))).toBe(true);
    const steps = groups.map((g) => Number(/--fc-i:(\d+)/.exec(tracePath(g)!.getAttribute("style")!)![1]));
    expect(Math.min(...steps)).toBe(0);
    expect(steps[byText("i < n", "Yes")]).toBeLessThan(steps[byText("i < n", "No")]);
  });

  test("a pass-count chip on each branch and on the loop's way back, after its label; none on plain steps", async () => {
    const { chart, layout, svg } = await traced();
    const counts = svg.all().find((e) => e.getAttribute("data-part") === "counts")!;
    expect(counts.getAttribute("aria-hidden")).toBe("true");
    const chips = counts.children.filter((c): c is FakeElement => c instanceof FakeElement);
    expect(chips.map((c) => c.textContent).sort()).toEqual(["1x", "2x", "3x", "5x", "5x"]);
    for (const c of chips) {
      const [rect, text] = c.children as FakeElement[];
      expect(rect.tagName).toBe("rect");
      expect(rect.getAttribute("style")).toBe("fill:var(--surface-raised);stroke:var(--border-strong);stroke-width:1");
      expect(text.getAttribute("style")).toContain("font-family:var(--font-code);font-size:11px");
      expect(c.getAttribute("data-count") + "x").toBe(text.textContent);
    }
    // "Yes 5x": the chip starts after the label's text.
    const yes = layout.edges.find((e) => e.label === "Yes" && chart.nodes[e.from].text.startsWith("i < n"))!;
    const after = labelRect(yes.labelAt!, "Yes").x1;
    const chip = chips.find((c) => c.textContent === "5x" && Math.abs(Number((c.children[0] as FakeElement).getAttribute("x")) - after - 3) < 0.01);
    expect(chip, "a 5x chip just after the loop's Yes").toBeDefined();
    const rect = chip!.children[0] as FakeElement;
    // Level with the label: its middle on the label's x-height (12 px text, baseline labelAt.y).
    expect(Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")) / 2).toBeCloseTo(yes.labelAt!.y - 4, 0);
    // The chips come after every connector (drawn over them) and before the boxes.
    const order = svg.children.map((c) => (c as FakeElement).getAttribute("data-part"));
    expect(order).toEqual(["edges", "counts", "steps"]);
  });

  test("no chip covers a box (a decision by its diamond), a branch label or another chip", async () => {
    // Nested ifs, elif, continue and break: Yes labels on a decision's left corner (anchored at
    // their end) as well as its right and its foot. The run: every score once, 102 breaks.
    const src = [
      "scores = [55, 91, 78, 0, 64, 88, 102]",
      "passed = 0",
      "for s in scores:",
      "    if s == 0:",
      "        continue",
      "    if s > 100:",
      "        break",
      "    if s >= 90:",
      "        print('A')",
      "    elif s >= 75:",
      "        print('B')",
      "    else:",
      "        print('C')",
      "    passed += 1",
      "print(passed)",
      "",
    ].join("\n");
    const lines = [1, 2, ...[[3, 4, 6, 8, 10, 13, 14], [3, 4, 6, 8, 9, 14], [3, 4, 6, 8, 10, 11, 14], [3, 4, 5], [3, 4, 6, 8, 10, 13, 14], [3, 4, 6, 8, 10, 11, 14], [3, 4, 6, 7]].flat(), 15];
    const chart = ok((await chartFile("python", src)).charts[0]);
    const layout = layoutChart(chart);
    const trace = traceChart(chart, moduleTrace(lines), true)!;
    const svg = renderChart(chart, layout, fakeDocument as unknown as Document, undefined, trace) as unknown as FakeElement;
    const chips = svg.all().filter((e) => e.getAttribute("data-part") === "count");
    expect(chips.map((c) => c.textContent).sort()).toEqual(["1x", "1x", "1x", "2x", "2x", "4x", "5x", "5x", "6x", "7x"]);
    const rects = chips.map((c) => {
      const r = c.children[0] as FakeElement;
      const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(r.getAttribute(k)));
      return { text: c.textContent, x, y, w, h };
    });
    const inBox = (b: (typeof layout.boxes)[number], px: number, py: number) =>
      b.kind === "decision"
        ? Math.abs(px - (b.x + b.w / 2)) / (b.w / 2) + Math.abs(py - (b.y + b.h / 2)) / (b.h / 2) < 1
        : px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h;
    const problems: string[] = [];
    for (const [i, c] of rects.entries()) {
      // Every point of the chip, a pixel apart, against every box's own shape.
      for (const b of layout.boxes) {
        let hit = false;
        for (let px = c.x; px <= c.x + c.w && !hit; px++) for (let py = c.y; py <= c.y + c.h && !hit; py++) hit = inBox(b, px, py);
        if (hit) problems.push(`chip ${c.text} over box ${chart.nodes[b.id].text}`);
      }
      const apart = (a: { x0: number; y0: number; x1: number; y1: number }) => c.x + c.w <= a.x0 || c.x >= a.x1 || c.y + c.h <= a.y0 || c.y >= a.y1;
      for (const e of layout.edges) if (e.label !== undefined && e.labelAt && !apart(labelRect(e.labelAt, e.label))) problems.push(`chip ${c.text} over label ${e.label}`);
      for (const d of rects.slice(i + 1)) if (!apart({ x0: d.x, y0: d.y, x1: d.x + d.w, y1: d.y + d.h })) problems.push(`chip ${c.text} over chip ${d.text}`);
    }
    expect(problems).toEqual([]);
  });

  test("without a trace the drawing is exactly the plain chart", async () => {
    const { chart, layout } = await traced();
    const plain = serialize(renderChart(chart, layout, fakeDocument as unknown as Document) as unknown as FakeElement);
    expect(serialize(renderChart(chart, layout, fakeDocument as unknown as Document, undefined, null) as unknown as FakeElement)).toBe(plain);
    expect(plain).not.toContain("data-count");
    expect(plain).not.toContain('data-part="trace"');
  });

  test("an edge the run didn't take has no trace path and no chip", async () => {
    const chart = ok((await chartFile("python", "a = 2\nif a == 1:\n    print(1)\nelse:\n    print(2)\n")).charts[0]);
    const layout = layoutChart(chart);
    const trace = traceChart(chart, moduleTrace([1, 2, 5]), true)!;
    const svg = renderChart(chart, layout, fakeDocument as unknown as Document, undefined, trace) as unknown as FakeElement;
    const groups = svg.all().filter((e) => e.tagName === "g" && e.getAttribute("data-from") !== null);
    const yes = layout.edges.findIndex((e) => e.label === "Yes");
    const no = layout.edges.findIndex((e) => e.label === "No");
    expect(tracePath(groups[yes])).toBeUndefined();
    expect(groups[yes].getAttribute("data-count")).toBeNull();
    expect(groups[no].getAttribute("data-count")).toBe("1");
    const chips = svg.all().filter((e) => e.getAttribute("data-part") === "count");
    expect(chips.map((c) => c.textContent)).toEqual(["1x"]);
  });

  test("Steps as text carries the counts; the legend gains the trace's two rows", async () => {
    const { chart, trace } = await traced();
    const words = stepList(chart, trace).map((s) => s.text);
    expect(words.find((w) => w.includes("Decision: i < n ?"))).toMatch(/Yes: step \d+\. No: step \d+\. Last run: Yes 5 times, No 1 time\.$/);
    expect(words.find((w) => w.includes("Decision: marks[i] > best ?"))).toMatch(/Last run: Yes 2 times, No 3 times\.$/);
    expect(words.find((w) => w.includes("i += 1"))).toMatch(/Last run: 5 times\.$/);
    // Without a trace, the outline is as before.
    expect(stepList(chart).map((s) => s.text).join(" ")).not.toContain("Last run");
    expect(TRACE_LEGEND.map((e) => e.words)).toEqual(["Thicker ran more often", "Times that way ran"]);
    const width = traceSwatch("width", fakeDocument as unknown as Document) as unknown as FakeElement;
    expect(width.getAttribute("aria-hidden")).toBe("true");
    expect((width.children as FakeElement[]).map(widthOf)).toEqual([1.5, 4]);
    const count = traceSwatch("count", fakeDocument as unknown as Document) as unknown as FakeElement;
    expect(count.textContent).toBe("5x");
  });
});
