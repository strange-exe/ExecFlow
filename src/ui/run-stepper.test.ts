// The run strip's stepper (run-stepper.ts): its words, its keys and its tick bar, from a step
// model (steps.ts). The DOM itself is checked in the browser (e2e/run-stepper.spec.ts).
import { describe, expect, it } from "vitest";
import type { RunStep, StepModel } from "../flowchart/steps";
import { changedNames, cutWords, keyStep, lastKnownStep, stepLabel, stepWords, TICK_CAP, ticksOf } from "./run-stepper";

/** A model of `total` steps whose values are known up to step `known` (inclusive). */
function fake(total: number, values: StepModel["values"] = "all", known = total - 1, steps: Partial<RunStep>[] = []): StepModel {
  const at = (k: number) => Math.min(total - 1, Math.max(0, Math.trunc(k) || 0));
  return {
    ok: true,
    total,
    partial: false,
    values,
    step: (k) => ({ k: at(k), kind: at(k) === 0 ? "start" : "line", line: at(k) === 0 ? null : at(k), node: 0, edges: [], edge: null, unsure: [], call: 0, event: at(k), ...steps[at(k)] }),
    varsAt: () => [],
    valuesKnownAt: (k) => values !== "none" && at(k) <= known,
    nodeCountsAt: () => new Int32Array(),
    lineCountsAt: () => new Map(),
    edgeCountsAt: () => new Int32Array(),
  };
}

describe("run stepper words", () => {
  it("labels the step against the last one, zero-padded to the last's width", () => {
    expect(stepLabel(0, 20)).toBe("step 00 / 19");
    expect(stepLabel(7, 20)).toBe("step 07 / 19");
    expect(stepLabel(19, 20)).toBe("step 19 / 19");
    expect(stepLabel(3, 4)).toBe("step 3 / 3");
    expect(stepLabel(42, 1001)).toBe("step 0042 / 1000");
    expect(stepLabel(0, 1)).toBe("step 0 / 0");
  });

  it("says each kind of step in a short sentence for the live region", () => {
    const m = fake(5, "all", 4, [{}, {}, { kind: "line", line: 12 }, { kind: "raise", line: 3 }, { kind: "return", line: null }]);
    expect(stepWords(m, 0)).toBe("Step 0 of 4, Start.");
    expect(stepWords(m, 2)).toBe("Step 2 of 4, line 12.");
    expect(stepWords(m, 3)).toBe("Step 3 of 4, line 3 raised an exception.");
    expect(stepWords(m, 4)).toBe("Step 4 of 4, the call returned.");
  });

  it("finds the last step with values, and says where they stopped", () => {
    expect(lastKnownStep(fake(20))).toBe(19);
    expect(lastKnownStep(fake(20, "cut", 6))).toBe(6);
    expect(lastKnownStep(fake(20, "cut", 0))).toBe(0);
    expect(lastKnownStep(fake(20, "none"))).toBe(-1);
    const cut = fake(20, "cut", 6);
    expect(cutWords(cut, 6)).toBeNull();
    expect(cutWords(cut, 7)).toBe("Values stopped being recorded after step 6.");
    expect(cutWords(fake(20), 19)).toBeNull();
    expect(cutWords(fake(20, "none"), 3)).toBeNull();
  });

  it("maps the stepping keys, clamped; others are not its keys", () => {
    expect(keyStep("ArrowRight", 3, 20)).toBe(4);
    expect(keyStep("ArrowLeft", 3, 20)).toBe(2);
    expect(keyStep("ArrowLeft", 0, 20)).toBe(0);
    expect(keyStep("ArrowRight", 19, 20)).toBe(19);
    expect(keyStep("Home", 9, 20)).toBe(0);
    expect(keyStep("End", 9, 20)).toBe(19);
    expect(keyStep("ArrowUp", 9, 20)).toBeNull();
    expect(keyStep("a", 9, 20)).toBeNull();
  });

  it("draws a tick per step after Start up to the cap, else a bar", () => {
    expect(ticksOf(5, 0)).toEqual({ kind: "ticks", ticks: ["", "", "", ""] });
    expect(ticksOf(5, 2)).toEqual({ kind: "ticks", ticks: ["done", "cur", "", ""] });
    expect(ticksOf(5, 4)).toEqual({ kind: "ticks", ticks: ["done", "done", "done", "cur"] });
    expect(ticksOf(TICK_CAP + 1, 3)).toMatchObject({ kind: "ticks" });
    expect(ticksOf(TICK_CAP + 2, 0)).toEqual({ kind: "bar", fraction: 0 });
    expect(ticksOf(101, 25)).toEqual({ kind: "bar", fraction: 0.25 });
    expect(ticksOf(1, 0)).toEqual({ kind: "ticks", ticks: [] });
  });
});

describe("run stepper changed marks", () => {
  /** Variables per step (index k), all in call 0 unless `calls` says otherwise. */
  function withVars(byStep: [string, string][][], known = byStep.length - 1, calls: number[] = []): StepModel {
    const base = fake(byStep.length, "all", known);
    return { ...base, step: (k) => ({ ...base.step(k), call: calls[k] ?? 0 }), varsAt: (k) => byStep[k] ?? [] };
  }

  it("marks a name whose value differs from the step before, and a name first set at this step", () => {
    const m = withVars([[], [["total", "0"]], [["total", "0"], ["n", "1"]], [["total", "0"], ["n", "2"]], [["total", "2"], ["n", "2"]]]);
    expect([...changedNames(m, 1)]).toEqual(["total"]);
    expect([...changedNames(m, 2)]).toEqual(["n"]);
    expect([...changedNames(m, 3)]).toEqual(["n"]);
    expect([...changedNames(m, 4)]).toEqual(["total"]);
  });

  it("marks nothing at Start, across a call boundary, or where the values weren't recorded", () => {
    const m = withVars([[], [["a", "1"]], [["x", "5"]], [["x", "6"]]], 2, [0, 0, 1, 1]);
    expect(changedNames(m, 0).size).toBe(0);
    expect(changedNames(m, 2).size, "a new call's names are its own, not changes").toBe(0);
    expect(changedNames(m, 3).size, "step 3's values are past the cut").toBe(0);
    expect(changedNames(fake(3, "none"), 1).size).toBe(0);
  });
});
