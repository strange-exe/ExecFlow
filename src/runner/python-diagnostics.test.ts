import { describe, expect, it } from "vitest";
import { checkDiagnostics, fromPythonJson, MAX_DIAGNOSTICS, MAX_STACK } from "./python-diagnostics";

const known = new Set(["main.py", "pkg/util.py"]);

describe("fromPythonJson", () => {
  it("keeps the helper's location and stack, with Python's unit and base", () => {
    const [d] = fromPythonJson([{
      severity: "error", path: "pkg/util.py", line: 7, col: 22, endLine: 7, endCol: 27,
      message: "ZeroDivisionError: division by zero", code: "ZeroDivisionError",
      stack: [{ path: "main.py", line: 5, col: 6, endLine: 5, endCol: 20 }, { path: "pkg/util.py", line: 7, col: 22, endLine: 7, endCol: 27 }],
    }], known);
    expect(d).toEqual({
      path: "pkg/util.py", line: 7, col: 22, endLine: 7, endCol: 27, unit: "utf16", base: 0,
      severity: "error", message: "ZeroDivisionError: division by zero", source: "python", code: "ZeroDivisionError",
      stack: [
        { path: "main.py", line: 5, col: 6, endLine: 5, endCol: 20, unit: "utf16", base: 0 },
        { path: "pkg/util.py", line: 7, col: 22, endLine: 7, endCol: 27, unit: "utf16", base: 0 },
      ],
    });
  });

  it("a whole-program problem has no path", () => {
    expect(fromPythonJson([{ severity: "error", path: null, line: 1, message: "MemoryError" }], known)).toEqual([
      { path: null, line: 1, unit: "utf16", base: 0, severity: "error", message: "MemoryError", source: "python" },
    ]);
  });

  it("a location outside the run's files falls back to the innermost workspace frame", () => {
    const [d] = fromPythonJson([{ severity: "error", path: "made-at-runtime.py", line: 3, col: 0, endCol: 4, message: "x",
      stack: [{ path: "main.py", line: 2, col: 0, endLine: 2, endCol: 9 }, { path: "made-at-runtime.py", line: 3 }] }], known);
    expect([d.path, d.line, d.col, d.endCol]).toEqual(["main.py", 2, 0, 9]);
    expect(d.stack).toHaveLength(1);
  });

  it("turns a missing or backwards end into a point marker", () => {
    const [a, b] = fromPythonJson([
      { severity: "error", path: "main.py", line: 2, col: 5, message: "a" },
      { severity: "error", path: "main.py", line: 2, col: 5, endLine: 2, endCol: 1, message: "b" },
    ], known);
    expect([a.col, a.endLine, a.endCol]).toEqual([5, 2, 5]);
    expect([b.col, b.endLine, b.endCol]).toEqual([5, 2, 5]);
  });

  it("keeps a multi-line range", () => {
    const [d] = fromPythonJson([{ severity: "error", path: "main.py", line: 5, col: 8, endLine: 7, endCol: 3, message: "ValueError: no k" }], known);
    expect([d.line, d.col, d.endLine, d.endCol]).toEqual([5, 8, 7, 3]);
  });

  it("a line without a column stays a whole-line marker", () => {
    const [d] = fromPythonJson([{ severity: "warning", path: "main.py", line: 4, message: "w" }], known);
    expect(d).toEqual({ path: "main.py", line: 4, unit: "utf16", base: 0, severity: "warning", message: "w", source: "python" });
  });

  it("drops entries it can't read and caps everything", () => {
    const junk = [null, 7, "x", { severity: "fatal", path: "main.py", line: 1, message: "m" }, { severity: "error", path: "main.py", line: 1 },
      { severity: "error", path: "main.py", line: 0, message: "line 0" }, { severity: "error", path: "main.py", line: 1.5, message: "half" }];
    const out = fromPythonJson(junk, known);
    expect(out.map((d) => d.message)).toEqual(["line 0", "half"]);
    expect(out.every((d) => d.path === null)).toBe(true); // unusable lines: the program as a whole
    expect(fromPythonJson("not a list", known)).toEqual([]);
    const many = Array.from({ length: MAX_DIAGNOSTICS + 50 }, () => ({ severity: "info", path: "main.py", line: 1, message: "m" }));
    expect(fromPythonJson(many, known)).toHaveLength(MAX_DIAGNOSTICS);
    const deep = { severity: "error", path: "main.py", line: 1, message: "RecursionError", stack: Array.from({ length: 900 }, (_, i) => ({ path: "main.py", line: i + 1 })) };
    const [d] = fromPythonJson([deep], known);
    expect(d.stack).toHaveLength(MAX_STACK);
    expect(d.stack!.at(-1)!.line).toBe(900); // the innermost frames are kept
    const [long] = fromPythonJson([{ severity: "error", path: "main.py", line: 1, message: "x".repeat(10_000), code: "y".repeat(500) }], known);
    expect(long.message).toHaveLength(4000);
    expect(long.code).toHaveLength(100);
  });

  it("negative columns are not columns", () => {
    const [d] = fromPythonJson([{ severity: "error", path: "main.py", line: 3, col: -1, endCol: 4, message: "m" }], known);
    expect(d.col).toBeUndefined();
  });
});

describe("checkDiagnostics (worker messages are untrusted)", () => {
  const good = { path: "main.py", line: 1, col: 0, endLine: 1, endCol: 4, unit: "utf16", base: 0, severity: "error", message: "NameError", source: "python" };
  it("accepts what the worker produces", () => {
    expect(checkDiagnostics([good], known)).toEqual([good]);
  });
  it("rejects other units, bases and sources (the C/C++ tools' shapes are not Python's)", () => {
    expect(checkDiagnostics([{ ...good, unit: "utf8-byte" }, { ...good, base: 1 }, { ...good, source: "clang" }], known)).toEqual([]);
  });
  it("re-checks paths and numbers", () => {
    expect(checkDiagnostics([{ ...good, path: "../../etc/passwd" }], known)[0].path).toBeNull();
    expect(checkDiagnostics([{ ...good, line: "1" }], known)[0].path).toBeNull();
    expect(checkDiagnostics({ length: 1, 0: good }, known)).toEqual([]);
  });
});
