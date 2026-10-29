/// <reference types="node" />
// Not type-checked by either tsconfig (src/workers is worker-only, tests are excluded there); Vitest runs it.
// The worker gives a whole job one deadline inside the page's clock: the parse and the layout share
// it, so a parse that used most of its time leaves the layout only what is left, never a fresh second.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARSE_TIMEOUT_MS } from "../flowchart/client";
import { JOB_MS, LAYOUT_MS } from "../flowchart/layout";

/** The fake clock (performance.now() ms) and what the worker passed on. */
const run = vi.hoisted(() => ({ clock: 0, parseMs: 0, chartDeadline: undefined as number | undefined, layoutDeadline: undefined as number | undefined }));

vi.mock("../flowchart/engine", () => ({
  LoadError: class LoadError extends Error {},
  FlowEngine: class {
    prepare() {
      return Promise.resolve();
    }
    chart(_language: string, _source: string, _pick: unknown, deadline?: number) {
      run.chartDeadline = deadline;
      run.clock += run.parseMs; // the parse (and the adapter) took this long
      return { type: "charts", file: { charts: [] } };
    }
  },
}));
vi.mock("../flowchart/picked", () => ({
  layOutPicked: (file: unknown, _pick: unknown, deadline: number) => {
    run.layoutDeadline = deadline;
    return { file, picked: 0, layout: null };
  },
}));

type Scope = { onmessage: ((e: { data: unknown }) => Promise<void>) | null; postMessage: (m: { type: string }) => void };

describe("the flowchart worker's deadline", () => {
  const posted: { type: string }[] = [];
  let scope: Scope;

  beforeEach(async () => {
    vi.resetModules();
    posted.length = 0;
    Object.assign(run, { clock: 10_000, chartDeadline: undefined, layoutDeadline: undefined });
    vi.spyOn(performance, "now").mockImplementation(() => run.clock);
    scope = { onmessage: null, postMessage: (m) => posted.push(m) };
    vi.stubGlobal("self", scope);
    await import("./flowchart.worker");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ask = () => scope.onmessage!({ data: { type: "chart", id: 1, language: "c", source: "int main(void) {}\n", pick: null } });

  it(`fits inside the page's ${PARSE_TIMEOUT_MS} ms clock, with room for the messages`, () => {
    expect(JOB_MS).toBeLessThanOrEqual(PARSE_TIMEOUT_MS - 150);
    expect(LAYOUT_MS).toBeLessThan(JOB_MS);
  });

  it("a slow parse leaves the layout only the rest of the job's time", async () => {
    run.parseMs = 1400;
    await ask();
    expect(posted.map((m) => m.type)).toEqual(["parsing", "charts"]);
    // The clock starts when "parsing" is posted (at 10 000), as the page's does.
    expect(run.chartDeadline).toBe(10_000 + JOB_MS);
    expect(run.layoutDeadline).toBe(10_000 + JOB_MS);
  });

  it("a quick parse gives the layout its own full deadline", async () => {
    run.parseMs = 20;
    await ask();
    expect(run.layoutDeadline).toBe(10_020 + LAYOUT_MS);
  });
});
