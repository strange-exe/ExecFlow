// The last run's trace per file: shown only while the file's text is what ran, replaced by the next
// run (a run without a trace forgets it), and only the latest few files are kept.
import { describe, expect, it } from "vitest";
import type { RunTrace } from "../core/types";
import { KEPT_RUNS, lastRun, noteRun, onRun } from "./last-run";

const trace = (): RunTrace => ({ codes: [{ name: "<module>", line: 1 }], calls: Int32Array.from([0]), events: Int32Array.from([0, 1]), partial: false });

describe("last run per file", () => {
  it("belongs to the text that ran; a new run replaces it, and a run without a trace forgets it", () => {
    const heard: string[] = [];
    const off = onRun((id) => heard.push(id));
    const t = trace();
    noteRun("a", "x = 1\n", t);
    expect(lastRun("a", "x = 1\n")?.trace).toBe(t);
    expect(lastRun("a", "x = 2\n")).toBeNull(); // edited: stale
    const first = lastRun("a", "x = 1\n")!.serial;
    noteRun("a", "x = 1\n", trace());
    expect(lastRun("a", "x = 1\n")!.serial).toBeGreaterThan(first);
    noteRun("a", "x = 1\n", undefined);
    expect(lastRun("a", "x = 1\n")).toBeNull();
    off();
    noteRun("b", "", undefined);
    expect(heard).toEqual(["a", "a", "a"]);
  });

  it("keeps the latest KEPT_RUNS files", () => {
    for (let i = 0; i <= KEPT_RUNS; i++) noteRun(`f${i}`, "t", trace());
    expect(lastRun("f0", "t")).toBeNull();
    expect(lastRun("f1", "t")).not.toBeNull();
    // Running an old file again makes it the newest.
    noteRun("f1", "t", trace());
    noteRun("g", "t", trace());
    expect(lastRun("f1", "t")).not.toBeNull();
    expect(lastRun("f2", "t")).toBeNull();
  });
});
