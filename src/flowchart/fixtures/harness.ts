/// <reference types="node" />
// Test harness (unit tests only, never imported by the app): the real flowchart engine with the
// real .wasm files from public/flowchart/ (scripts/fetch-flowchart-grammars.mjs), read from disk,
// plus helpers that print a chart as plain lists for exact comparisons.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { FlowEngine, LoadError, type LoadFile } from "../engine";
import type { ChartResult, ChartStub, FlowChart, FlowFile, Step } from "../model";
import { FLOWCHART_DIR, type FlowLanguage } from "../pack";

export const PACK_DIR = join("public", "flowchart", FLOWCHART_DIR);
/** The parser files are there (locally after npm run dev/build; CI fetches them before the unit tests). */
export const havePack = existsSync(join(PACK_DIR, "web-tree-sitter.wasm"));
/** Tests that need the files: skipped when they are missing locally, failing in CI. */
export const withPack = havePack || process.env.CI ? true : false;

export const diskLoader: LoadFile = async (file) => new Uint8Array(readFileSync(join(PACK_DIR, file)));

/** A loader that fails for `file` the first `times` calls, the way `how` says, and counts calls. */
export function flaky(file: string, how: "missing" | "garbage", times = 1) {
  const calls: string[] = [];
  let left = times;
  const load: LoadFile = async (name) => {
    calls.push(name);
    if (name === file && left > 0) {
      left--;
      if (how === "missing") throw new Error(`HTTP 404 for ${name}`);
      return new TextEncoder().encode("not the real file");
    }
    return diskLoader(name);
  };
  return { load, calls };
}

/** The LoadError `p` rejects with. */
export async function failure(p: Promise<unknown>): Promise<LoadError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LoadError) return e;
    throw e;
  }
  throw new Error("expected a LoadError");
}

let shared: FlowEngine | null = null;
export const engine = () => (shared ??= new FlowEngine(diskLoader));

export const fixture = (name: string) => readFileSync(join("src", "flowchart", "fixtures", name), "utf8");

export async function chartFile(language: FlowLanguage, source: string): Promise<FlowFile> {
  const e = engine();
  await e.prepare(language);
  const outcome = e.chart(language, source);
  if (outcome.type !== "charts") throw new Error(`expected charts, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}

export function ok(result: ChartResult | ChartStub): FlowChart {
  if (result.ok === null) throw new Error(`chart ${result.name} wasn't made (not picked)`);
  if (!result.ok) throw new Error(`chart ${result.name} is too big: ${result.tooBig}`);
  return result;
}

/** "id kind text" per box, plus " [note]" and " -> callee". */
export function nodesOf(chart: FlowChart): string[] {
  return chart.nodes.map((n) => `${n.id} ${n.kind} ${n.text}${n.note ? ` [${n.note}]` : ""}${n.callee ? ` -> ${n.callee}` : ""}`);
}

/** "from->to label (kind)" per edge, sorted. */
export function edgesOf(chart: FlowChart): string[] {
  return chart.edges.map((e) => `${e.from}->${e.to}${e.label ? ` ${e.label}` : ""}${e.kind === "flow" ? "" : ` (${e.kind})`}`).sort();
}

/** Decision boxes that belong to a switch (their out-edges are cases, not Yes/No). */
function switchConds(step: Step, out: Set<number>): Set<number> {
  switch (step.t) {
    case "seq":
      step.items.forEach((s) => switchConds(s, out));
      break;
    case "if":
      switchConds(step.yes, out);
      switchConds(step.no, out);
      break;
    case "loop":
      switchConds(step.body, out);
      if (step.update) switchConds(step.update, out);
      if (step.orelse) switchConds(step.orelse, out);
      break;
    case "switch":
      out.add(step.cond);
      step.cases.forEach((c) => switchConds(c.body, out));
      break;
  }
  return out;
}

/**
 * The model's invariants: every box reachable from Start or listed unreachable; every path ends
 * at an end terminator (only ends have no way out); decisions have exactly a Yes and a No, a
 * switch one edge per case plus default; Start has one way out and none in.
 */
export function expectInvariants(chart: FlowChart): void {
  const out = (id: number) => chart.edges.filter((e) => e.from === id);
  // Reachability, recomputed here.
  const seen = new Set([chart.start]);
  const queue = [chart.start];
  while (queue.length) for (const e of out(queue.shift()!)) if (!seen.has(e.to)) seen.add(e.to), queue.push(e.to);
  expect(chart.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id), "unreachable boxes are reported").toEqual(chart.unreachable);
  for (const n of chart.nodes) {
    expect(n.id).toBe(chart.nodes.indexOf(n));
    if (n.kind === "end") expect(out(n.id), `end ${n.id} has no way out`).toEqual([]);
    else expect(out(n.id).length, `box ${n.id} (${n.text}) has a way out`).toBeGreaterThan(0);
  }
  expect(out(chart.start).length).toBe(1);
  expect(chart.edges.filter((e) => e.to === chart.start)).toEqual([]);
  const switches = switchConds(chart.body, new Set());
  for (const n of chart.nodes.filter((x) => x.kind === "decision")) {
    const labels = out(n.id).map((e) => e.label);
    if (switches.has(n.id)) {
      expect(new Set(labels).size, `switch ${n.id}: one edge per case`).toBe(labels.length);
      expect(labels).toContain("default");
    } else {
      expect([...labels].sort(), `decision ${n.id} (${n.text})`).toEqual(["No", "Yes"]);
    }
  }
  for (const e of chart.edges) {
    expect(e.from).toBeLessThan(chart.nodes.length);
    expect(e.to).toBeLessThan(chart.nodes.length);
  }
}
