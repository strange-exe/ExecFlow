import { describe, expect, it } from "vitest";
import type { ToolDiagnostic } from "../core/types";
import { callSiteMarks, MAX_CALL_MARKS } from "./run-diagnostics";

const at = (path: string, line: number) => ({ path, line, unit: "utf16" as const, base: 0 as const });

const raised: ToolDiagnostic = {
  ...at("calc.py", 2),
  col: 11,
  severity: "error",
  source: "python",
  code: "ZeroDivisionError",
  message: "ZeroDivisionError: division by zero",
  stack: [at("main.py", 4), at("calc.py", 2)],
};

describe("callSiteMarks", () => {
  it("marks the call in the file that ran, not the error's own line", () => {
    expect(callSiteMarks([raised])).toEqual([
      { ...at("main.py", 4), severity: "info", source: "python", code: "ZeroDivisionError", message: "This call led to ZeroDivisionError in calc.py, line 2." },
    ]);
  });

  it("ignores warnings, errors without a stack or a file, and repeated frames", () => {
    const warning: ToolDiagnostic = { ...raised, severity: "warning" };
    const noStack: ToolDiagnostic = { ...raised, stack: undefined };
    const noPath: ToolDiagnostic = { ...raised, path: null };
    expect(callSiteMarks([warning, noStack, noPath])).toEqual([]);
    const twice: ToolDiagnostic = { ...raised, stack: [at("main.py", 4), at("main.py", 4), at("util.py", 9), at("calc.py", 2)] };
    expect(callSiteMarks([twice, raised]).map((d) => `${d.path}:${d.line}`)).toEqual(["main.py:4", "util.py:9"]);
  });

  it("stops at a fixed number of marks (deep recursion)", () => {
    const deep: ToolDiagnostic = { ...raised, stack: Array.from({ length: 50 }, (_, i) => at("rec.py", i + 10)) };
    expect(callSiteMarks([deep])).toHaveLength(MAX_CALL_MARKS);
  });
});
