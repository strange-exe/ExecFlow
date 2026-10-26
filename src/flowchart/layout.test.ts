/// <reference types="node" />
// The structured layout: on every fixture and on random programs, boxes never overlap, every edge
// is an orthogonal polyline from its box to its target that never runs through a box, back edges
// run outside their loop, and the same model always gives the same layout.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNEL, labelRect, layoutChart, rectMeetsBox, type Layout, type LaidBox, type Point } from "./layout";
import { entryOf, type FlowChart, type Step } from "./model";
import { chartFile, fixture, ok, withPack } from "./fixtures/harness";
import { randomProgram } from "./fixtures/random";
import type { FlowLanguage } from "./pack";

const test = withPack ? it : it.skip;
const LANG: Record<string, FlowLanguage> = { c: "c", cpp: "cpp", py: "python" };

async function fixtureCharts(): Promise<{ name: string; chart: FlowChart }[]> {
  const out: { name: string; chart: FlowChart }[] = [];
  for (const file of readdirSync("src/flowchart/fixtures").filter((f) => /\.(c|cpp|py)$/.test(f))) {
    const result = await chartFile(LANG[file.split(".").pop()!], fixture(file));
    for (const c of result.charts) if (c.ok) out.push({ name: `${file}:${c.name}`, chart: ok(c) });
  }
  return out;
}

/** Interiors overlap (touching edges don't count). */
const overlaps = (a: LaidBox, b: LaidBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Does the axis-aligned segment p-q run through the box's interior or along its border? */
function hits(p: Point, q: Point, b: LaidBox): boolean {
  if (p.x === q.x) {
    const [y0, y1] = p.y < q.y ? [p.y, q.y] : [q.y, p.y];
    return p.x > b.x && p.x < b.x + b.w && y0 < b.y + b.h && y1 > b.y;
  }
  const [x0, x1] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
  return p.y > b.y && p.y < b.y + b.h && x0 < b.x + b.w && x1 > b.x;
}

/** On the box's border (within half a pixel). */
function onBorder(p: Point, b: LaidBox): boolean {
  const inX = p.x >= b.x - 0.5 && p.x <= b.x + b.w + 0.5;
  const inY = p.y >= b.y - 0.5 && p.y <= b.y + b.h + 0.5;
  const nearX = Math.abs(p.x - b.x) <= 0.5 || Math.abs(p.x - b.x - b.w) <= 0.5;
  const nearY = Math.abs(p.y - b.y) <= 0.5 || Math.abs(p.y - b.y - b.h) <= 0.5;
  return (inX && nearY) || (inY && nearX);
}

/** Node ids inside a step. */
function idsIn(step: Step, out: number[] = []): number[] {
  switch (step.t) {
    case "node":
    case "end":
    case "goto":
    case "label":
      out.push(step.id);
      break;
    case "seq":
      step.items.forEach((s) => idsIn(s, out));
      break;
    case "if":
      out.push(step.cond);
      idsIn(step.yes, out);
      idsIn(step.no, out);
      break;
    case "loop":
      if (step.cond !== null) out.push(step.cond);
      idsIn(step.body, out);
      if (step.update) idsIn(step.update, out);
      break;
    case "switch":
      out.push(step.cond);
      step.cases.forEach((c) => idsIn(c.body, out));
      break;
  }
  return out;
}

function loopsIn(step: Step, out: Extract<Step, { t: "loop" }>[] = []) {
  switch (step.t) {
    case "seq":
      step.items.forEach((s) => loopsIn(s, out));
      break;
    case "if":
      loopsIn(step.yes, out);
      loopsIn(step.no, out);
      break;
    case "loop":
      out.push(step);
      loopsIn(step.body, out);
      if (step.orelse) loopsIn(step.orelse, out);
      break;
    case "switch":
      step.cases.forEach((c) => loopsIn(c.body, out));
      break;
  }
  return out;
}

/** Every way the layout breaks its rules, as sentences (checked in plain code: a few million checks). */
function problems(chart: FlowChart, layout: Layout, name: string): string[] {
  const out: string[] = [];
  const box = new Map(layout.boxes.map((b) => [b.id, b]));
  // Every box once, inside the chart.
  const ids = layout.boxes.map((b) => b.id).sort((a, b) => a - b);
  if (ids.join() !== chart.nodes.map((n) => n.id).join()) out.push(`${name}: boxes ${ids.join()} are not the nodes`);
  for (const b of layout.boxes) {
    if (!(b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.width && b.y + b.h <= layout.height)) out.push(`${name}: box ${b.id} outside the chart`);
  }
  // No two boxes overlap.
  for (let i = 0; i < layout.boxes.length; i++) {
    for (let j = i + 1; j < layout.boxes.length; j++) {
      if (overlaps(layout.boxes[i], layout.boxes[j])) out.push(`${name}: boxes ${layout.boxes[i].id} and ${layout.boxes[j].id} overlap`);
    }
  }
  // Every drawn model edge has exactly one route, and only those.
  const key = (e: { from: number; to: number; label?: string }) => `${e.from}>${e.to}>${e.label ?? ""}`;
  const wanted = chart.edges.filter((e) => e.kind !== "link").map(key).sort();
  if (layout.edges.map(key).sort().join("|") !== wanted.join("|")) out.push(`${name}: routes ${layout.edges.map(key).sort().join(" ")} are not the edges ${wanted.join(" ")}`);
  for (const e of layout.edges) {
    const pts = e.points;
    const tag = `${name}: edge ${key(e)}`;
    if (pts.length < 2) out.push(`${tag} has ${pts.length} points`);
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1], pts[i]];
      if (!(p.x === q.x || p.y === q.y)) out.push(`${tag} is not orthogonal at ${q.x},${q.y}`);
      if (p.x === q.x && p.y === q.y) out.push(`${tag} has an empty segment at ${q.x},${q.y}`);
      // Straight runs are merged, so three points on one line mean the edge doubles back on itself.
      if (i >= 2) {
        const a = pts[i - 2];
        if ((a.x === p.x && p.x === q.x) || (a.y === p.y && p.y === q.y)) out.push(`${tag} doubles back at ${p.x},${p.y}`);
      }
      for (const b of layout.boxes) if (hits(p, q, b)) out.push(`${tag} runs through box ${b.id}`);
    }
    if (pts.length && !onBorder(pts[0], box.get(e.from)!)) out.push(`${tag} doesn't start on its box`);
    if (pts.length && !onBorder(pts.at(-1)!, box.get(e.to)!)) out.push(`${tag} doesn't end on its target`);
    if (e.label && !e.labelAt) out.push(`${tag} has no label position`);
  }
  // A loop's back edges (to its test, or from a do-while's test, or to a for(;;)'s first box) run
  // outside it: their lane is left of every box in the loop.
  for (const loop of loopsIn(chart.body)) {
    const ids = new Set(idsIn(loop));
    const minX = Math.min(...[...ids].map((id) => box.get(id)?.x ?? Infinity));
    const head = loop.cond ?? entryOf(loop.body);
    // A for(;;) whose body starts with a do-while shares its first box with the do-while's Yes edge.
    // A for(;;)'s first box may belong to a loop inside it, whose back edges go there too: then
    // which loop a back edge belongs to is ambiguous, and the inner loop's own check covers it.
    const nested = loopsIn(loop.body);
    const nestedTests = new Set(nested.map((l) => l.cond));
    if (loop.cond === null && nested.some((l) => idsIn(l).includes(head!))) continue;
    const mine = (x: { from: number; to: number }) => (loop.post ? x.from === loop.cond : x.to === head && !nestedTests.has(x.from));
    for (const e of layout.edges.filter((x) => x.kind === "back" && ids.has(x.from) && mine(x))) {
      const left = Math.min(...e.points.map((p) => p.x));
      if (!(left < minX)) out.push(`${name}: back edge ${key(e)} runs at x ${left}, not left of its loop (${minX})`);
    }
  }
  out.push(...spacingProblems(layout, name), ...labelProblems(layout, name));
  return out;
}

interface Seg {
  edge: number;
  /** The fixed coordinate (x of a vertical run, y of a horizontal one) and the span along the other axis. */
  at: number;
  a: number;
  b: number;
}

function segmentsOf(layout: Layout): { v: Seg[]; h: Seg[] } {
  const v: Seg[] = [];
  const h: Seg[] = [];
  layout.edges.forEach((e, edge) => {
    for (let i = 1; i < e.points.length; i++) {
      const [p, q] = [e.points[i - 1], e.points[i]];
      if (p.x === q.x) v.push({ edge, at: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y) });
      else h.push({ edge, at: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) });
    }
  });
  return { v, h };
}

/**
 * Two different edges never run side by side closer than CHANNEL px (they share a line exactly,
 * where they join, or keep a readable channel between them).
 */
function spacingProblems(layout: Layout, name: string): string[] {
  const out: string[] = [];
  const { v, h } = segmentsOf(layout);
  for (const [segs, axis] of [[v, "x"], [h, "y"]] as const) {
    const sorted = [...segs].sort((s, t) => s.at - t.at);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].at - sorted[i].at < CHANNEL; j++) {
        const [s, t] = [sorted[i], sorted[j]];
        if (s.edge === t.edge || t.at === s.at) continue;
        const overlap = Math.min(s.b, t.b) - Math.max(s.a, t.a);
        if (overlap > 0) {
          const [e1, e2] = [layout.edges[s.edge], layout.edges[t.edge]];
          out.push(`${name}: edges ${e1.from}>${e1.to} and ${e2.from}>${e2.to} run ${t.at - s.at} px apart at ${axis} ${s.at} for ${overlap} px`);
        }
      }
    }
  }
  return out;
}

/** Places where a vertical run of one edge passes through a horizontal run of another (not at an end). */
function crossings(layout: Layout): string[] {
  const out: string[] = [];
  const { v, h } = segmentsOf(layout);
  for (const s of v) {
    for (const t of h) {
      if (s.edge === t.edge) continue;
      if (s.at > t.a && s.at < t.b && t.at > s.a && t.at < s.b) {
        const [e1, e2] = [layout.edges[s.edge], layout.edges[t.edge]];
        out.push(`${e1.from}>${e1.to} crosses ${e2.from}>${e2.to} at ${s.at},${t.at}`);
      }
    }
  }
  return out;
}

/** Edge labels touch no box, no edge (their own included) and no other label. */
function labelProblems(layout: Layout, name: string): string[] {
  const out: string[] = [];
  const { v, h } = segmentsOf(layout);
  const rects = layout.edges.flatMap((e) => (e.label && e.labelAt ? [{ e, r: labelRect(e.labelAt, e.label) }] : []));
  const hit = (r: { x0: number; y0: number; x1: number; y1: number }, x0: number, y0: number, x1: number, y1: number) => r.x0 < x1 && x0 < r.x1 && r.y0 < y1 && y0 < r.y1;
  for (const [i, { e, r }] of rects.entries()) {
    const tag = `${name}: label "${e.label}" of ${e.from}>${e.to}`;
    // The drawn shape: a decision's diamond leaves its corners free.
    for (const b of layout.boxes) if (rectMeetsBox(r, b)) out.push(`${tag} touches box ${b.id}`);
    for (const s of v) if (hit(r, s.at, s.a, s.at + 0.01, s.b)) out.push(`${tag} touches the line at x ${s.at}`);
    for (const s of h) if (hit(r, s.a, s.at, s.b, s.at + 0.01)) out.push(`${tag} touches the line at y ${s.at}`);
    for (const [j, o] of rects.entries()) if (j > i && hit(r, o.r.x0, o.r.y0, o.r.x1, o.r.y1)) out.push(`${tag} touches the label "${o.e.label}"`);
  }
  return out;
}

function expectGoodLayout(chart: FlowChart, layout: Layout, name = chart.name): void {
  expect(problems(chart, layout, name)).toEqual([]);
}

describe("structured layout", () => {
  test("every fixture: no overlaps, routed orthogonal edges that miss every box, back edges outside", async () => {
    const charts = await fixtureCharts();
    expect(charts.length).toBeGreaterThan(15);
    for (const { name, chart } of charts) expectGoodLayout(chart, layoutChart(chart), name);
  });

  test("deterministic: the same model gives the same layout", async () => {
    for (const { chart } of await fixtureCharts()) {
      expect(JSON.stringify(layoutChart(chart))).toBe(JSON.stringify(layoutChart(structuredClone(chart))));
    }
  });

  test("sequences stack top-down on one spine; a decision's branches sit left and right and rejoin below", async () => {
    const main = ok((await chartFile("c", fixture("else-if.c"))).charts[0]);
    const l = layoutChart(main);
    const b = (id: number) => l.boxes.find((x) => x.id === id)!;
    const cx = (id: number) => b(id).x + b(id).w / 2;
    // Start, int n, scanf, the first test: one column, top to bottom.
    for (const id of [1, 2, 3]) {
      expect(cx(id)).toBe(cx(0));
      expect(b(id).y).toBeGreaterThan(b(id - 1).y + b(id - 1).h);
    }
    // "n > 0 ?" Yes (printf positive) on the left, No (n < 0 ?) on the right, both below it.
    expect(cx(4)).toBeLessThan(cx(3));
    expect(cx(5)).toBeGreaterThan(cx(3));
    expect(b(4).y).toBeGreaterThan(b(3).y + b(3).h);
    // return 0 below everything, back on the spine.
    expect(cx(8)).toBe(cx(0));
    for (const x of l.boxes.filter((x) => x.id !== 8)) expect(b(8).y).toBeGreaterThan(x.y + x.h);
  });

  test("a continue or break beside a loop's test stays inside the loop's exit lane: no crossing", async () => {
    const src = `#include <stdio.h>\nint main(void) {\n  int n, score;\n  scanf("%d", &n);\n  for (int i = 0; i < n; i++) {\n    scanf("%d", &score);\n    if (score < 0) continue;\n    printf("%d", score);\n  }\n  return 0;\n}\n`;
    // And with a body box wider than the test's run past its label (a call to a function in the file).
    const wide = `char grade(int s) { return s > 50 ? 'P' : 'F'; }\n${src.replace(`printf("%d", score)`, `printf("%c", grade(score))`)}`;
    for (const [name, code] of [["narrow", src], ["wide", wide]]) {
      for (const jump of ["continue", "break"]) {
        const result = (await chartFile("c", code.replace("continue", jump))).charts.find((c) => c.name === "main")!;
        const chart = ok(result);
        const l = layoutChart(chart);
        expectGoodLayout(chart, l, `${name} ${jump}`);
        expect(crossings(l), `${name} ${jump}`).toEqual([]);
      }
    }
  });

  test("a 400-step chart lays out quickly", async () => {
    const body = Array.from({ length: 95 }, (_, i) => `  if (x > ${i}) { x--; continue; } else if (x == ${i}) break;\n  printf("%d", x);`).join("\n");
    const src = `#include <stdio.h>\nint main(void) {\n  int x = 99;\n  while (x) {\n${body}\n  }\n  return 0;\n}\n`;
    const result = (await chartFile("c", src)).charts[0];
    const chart = ok(result);
    expect(chart.nodes.length).toBeGreaterThan(300);
    const t = performance.now();
    const l = layoutChart(chart);
    const ms = performance.now() - t;
    expectGoodLayout(chart, l);
    expect(l.edges.filter((e) => e.kind === "jump").length).toBeGreaterThan(100);
    expect(ms, `layout took ${Math.round(ms)} ms`).toBeLessThan(250);
  }, 30_000);
});

describe("structured layout on random programs", () => {
  test("300 random programs: every layout invariant holds", async () => {
    let checked = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const file = await chartFile("c", randomProgram(seed));
      const result = file.charts[0];
      if (!result.ok) continue;
      const l = layoutChart(result);
      expectGoodLayout(result, l, `seed ${seed}`);
      checked++;
      for (const e of l.edges) kinds.add(e.kind);
    }
    // The generator really exercised the layout: most programs charted, with jumps and back edges.
    expect(checked).toBeGreaterThan(250);
    expect([...kinds].sort()).toEqual(["back", "flow", "jump"]);
  }, 60_000);
});
