/// <reference types="node" />
// The SVG renderer: ISO 5807 shapes per box kind, every box named and mapped to its lines, code
// text only ever in text nodes, colours only from the theme's custom properties, and a text
// outline of the steps in reading order.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutChart } from "./layout";
import type { FlowChart } from "./model";
import { renderChart, stepList } from "./render";
import { FakeElement, fakeDocument, serialize } from "./fixtures/fake-dom";
import { chartFile, fixture, ok, withPack } from "./fixtures/harness";

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
      return g.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName !== "title" && c.tagName !== "text");
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
    expect(items[2].getAttribute("aria-label")).toBe("Decision: i < n ?");
    expect(items[4].getAttribute("aria-label")).toBe("End: return i");
  });

  test("the steps sit in a list; the lines are hidden from screen readers (the list and the step list say it all)", async () => {
    const svg = draw(ok((await chartFile("c", fixture("else-if.c"))).charts[0]));
    const list = svg.all().find((e) => e.getAttribute("role") === "list")!;
    expect(steps(list).length).toBe(9);
    const edges = svg.all().find((e) => e.getAttribute("data-part") === "edges")!;
    expect(edges.getAttribute("aria-hidden")).toBe("true");
  });

  test("every edge is a polyline with an arrowhead, and its label is drawn", async () => {
    const chart = ok((await chartFile("c", fixture("switch.c"))).charts[0]);
    const layout = layoutChart(chart);
    const svg = renderChart(chart, layout, fakeDocument as unknown as Document) as unknown as FakeElement;
    const edges = svg.all().find((e) => e.getAttribute("data-part") === "edges")!;
    expect(edges.all().filter((e) => e.tagName === "polyline").length).toBe(layout.edges.length);
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
    for (const c of colours) expect(c, c).toMatch(/^(var\(--[a-z-]+\)|none)$/);
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
});
