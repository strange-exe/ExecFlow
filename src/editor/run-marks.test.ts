import { diagnosticCount } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, gutterLineClass, type GutterMarker } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { ToolDiagnostic } from "../core/types";
import { callSiteMarks } from "../ui/run-diagnostics";
import { CALL_SITE_CLASS, currentDiagnostics, isCallSite, mergeSource, toCm } from "./diagnostics";
import { BASE, fileConf, fileExtensions, LINT_SPEC, withoutCallSites } from "./extensions";
import { CHROME_SPEC } from "./highlight";
import { bandsLine, CALL_LINE_CLASS, ERROR_LINE_CLASS, RUN_CHANNEL, runMarks, runMarksOf } from "./run-marks";

const CALC = "def ratio(a, b):\n    return a / b\n";
const MAIN = 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n';

/** What the Python runner reports for ratio(1, 0): the error in calc.py with its stack. */
const raised: ToolDiagnostic = {
  path: "calc.py", line: 2, col: 11, endCol: 16, unit: "utf16", base: 0, severity: "error", source: "python",
  code: "ZeroDivisionError", message: "ZeroDivisionError: division by zero",
  stack: [{ path: "main.py", line: 4, unit: "utf16", base: 0 }, { path: "calc.py", line: 2, unit: "utf16", base: 0 }],
};

function fileState(path: string, doc: string, extra: Extension = []): EditorState {
  return EditorState.create({ doc, extensions: [BASE, fileConf.of(fileExtensions(path)), extra] });
}

/** Sets one channel's diagnostics, as EditorManager.endBuild does. */
function report(state: EditorState, channel: string, list: readonly ToolDiagnostic[]): EditorState {
  return state.update(mergeSource(state, channel, list.map((d) => toCm(state.doc, d)))).state;
}

/** Line numbers that carry `cls` on their gutter cells (gutterLineClass, as the view reads it). */
function gutterLines(state: EditorState, cls: string): number[] {
  const out: number[] = [];
  for (const set of state.facet(gutterLineClass)) {
    set.between(0, state.doc.length, (from, _to, marker: GutterMarker) => {
      if (marker.elementClass === cls) out.push(state.doc.lineAt(from).number);
    });
  }
  return out.sort((a, b) => a - b);
}

/** Line numbers with a line decoration of `cls` among the editor's decorations. */
function decoratedLines(state: EditorState, cls: string): number[] {
  const out: number[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue; // view plugins: not part of a state
    source.between(0, state.doc.length, (from, _to, deco) => {
      if (deco.spec.class === cls) out.push(state.doc.lineAt(from).number);
    });
  }
  return out.sort((a, b) => a - b);
}

describe("the error-line band", () => {
  it("marks the line of a run's error, in the code and on every gutter cell of that line", () => {
    const state = report(fileState("calc.py", CALC), RUN_CHANNEL, [raised]);
    expect(decoratedLines(state, ERROR_LINE_CLASS)).toEqual([2]);
    expect(gutterLines(state, ERROR_LINE_CLASS)).toEqual([2]);
    // A line decoration starts at its line's start, whatever the diagnostic's column.
    expect(state.field(runMarks).lines.iter().from).toBe(state.doc.line(2).from);
  });

  it("does not band the idle check's errors, warnings or call sites", () => {
    let state = report(fileState("calc.py", CALC), "check", [raised]);
    expect(currentDiagnostics(state).map((d) => d.diagnostic.channel)).toEqual(["check"]);
    expect(decoratedLines(state, ERROR_LINE_CLASS)).toEqual([]);
    expect(gutterLines(state, ERROR_LINE_CLASS)).toEqual([]);
    state = report(state, RUN_CHANNEL, [{ ...raised, severity: "warning" }]);
    expect(currentDiagnostics(state).map((d) => `${d.diagnostic.channel} ${d.diagnostic.severity}`)).toEqual(["check error", "build warning"]);
    expect(decoratedLines(state, ERROR_LINE_CLASS)).toEqual([]);
    expect(bandsLine({ from: 0, to: 1, severity: "error", message: "x" })).toBe(false); // no channel
  });

  it("goes when the diagnostic goes: the next run, or an edit that removes the marked text", () => {
    const failed = report(fileState("calc.py", CALC), RUN_CHANNEL, [raised]);
    expect(decoratedLines(failed, ERROR_LINE_CLASS)).toEqual([2]);
    const nextRun = report(failed, RUN_CHANNEL, []);
    expect(decoratedLines(nextRun, ERROR_LINE_CLASS)).toEqual([]);
    expect(gutterLines(nextRun, ERROR_LINE_CLASS)).toEqual([]);
    // Deleting the whole line deletes the squiggle with it, and the band follows the lint state.
    const line = failed.doc.line(2);
    const edited = failed.update({ changes: { from: line.from, to: line.to + 1 } }).state;
    expect(diagnosticCount(edited)).toBe(0);
    expect(decoratedLines(edited, ERROR_LINE_CLASS)).toEqual([]);
  });

  it("moves with the text: a line typed above it moves the band down", () => {
    const failed = report(fileState("calc.py", CALC), RUN_CHANNEL, [raised]);
    const moved = failed.update({ changes: { from: 0, insert: "# note\n" } }).state;
    expect(decoratedLines(moved, ERROR_LINE_CLASS)).toEqual([3]);
    expect(gutterLines(moved, ERROR_LINE_CLASS)).toEqual([3]);
  });

  it("keeps its value while only the cursor moves, and stays empty (the same object) in a clean file", () => {
    const failed = report(fileState("calc.py", CALC), RUN_CHANNEL, [raised]);
    expect(failed.update({ selection: { anchor: 3 } }).state.field(runMarks)).toBe(failed.field(runMarks));
    const clean = fileState("calc.py", CALC);
    expect(clean.update({ changes: { from: 0, insert: "x" } }).state.field(runMarks)).toBe(clean.field(runMarks));
  });
});

describe("the call-site marker", () => {
  const [call] = callSiteMarks([raised]);
  const failedMain = () => report(fileState("main.py", MAIN), RUN_CHANNEL, [call]);

  it("comes from the run's stack with the call-site role", () => {
    expect(call).toMatchObject({ path: "main.py", line: 4, severity: "info", role: "call-site" });
  });

  it("gives its line the ce-call-line gutter class, and no band", () => {
    const state = failedMain();
    expect(gutterLines(state, CALL_LINE_CLASS)).toEqual([4]);
    expect(decoratedLines(state, ERROR_LINE_CLASS)).toEqual([]);
    expect(gutterLines(state, ERROR_LINE_CLASS)).toEqual([]);
    expect(runMarksOf(report(state, RUN_CHANNEL, [])).gutter.size).toBe(0);
  });

  it("keeps its range class (the dashed outline) and is filtered out of the lint gutter (no info square)", () => {
    const state = failedMain();
    const own = toCm(state.doc, call);
    expect(own.markClass?.split(" ")).toContain(CALL_SITE_CLASS);
    expect(isCallSite(own)).toBe(true);
    const plainInfo = toCm(state.doc, { ...call, role: undefined });
    const error = toCm(state.doc, { ...raised, path: "main.py", line: 4 });
    expect(withoutCallSites([own, plainInfo, error]).map((d) => d.severity)).toEqual(["info", "error"]);
    expect(withoutCallSites([own, plainInfo, error])[0]).toBe(plainInfo);
  });

  it("is drawn by the theme: a 2 px dashed --call-site outline and a --call-site arrow in the lint column", () => {
    expect(LINT_SPEC[`.cm-lintRange.${CALL_SITE_CLASS}` as ".cm-lintRange.ce-call-site"]).toMatchObject({
      textDecorationLine: "none", outline: "2px dashed var(--call-site)",
    });
    const arrow = LINT_SPEC[`.cm-gutter-lint .cm-gutterElement.${CALL_LINE_CLASS}::before` as ".cm-gutter-lint .cm-gutterElement.ce-call-line::before"];
    expect(arrow).toMatchObject({ content: "''", backgroundColor: "var(--call-site)" });
    expect(arrow.mask).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(arrow.WebkitMask).toBe(arrow.mask);
  });
});

describe("the band's theme", () => {
  it("paints --error-band on the line and its gutter cells, the number in --text, a 2 px --danger bar", () => {
    expect(CHROME_SPEC[`.cm-line.${ERROR_LINE_CLASS}` as ".cm-line.ce-error-line"]).toEqual({ backgroundColor: "var(--error-band)" });
    expect(CHROME_SPEC[`.cm-gutterElement.${ERROR_LINE_CLASS}` as ".cm-gutterElement.ce-error-line"]).toEqual({
      backgroundColor: "var(--error-band)", color: "var(--text)",
    });
    expect(CHROME_SPEC[".cm-lineNumbers .cm-gutterElement.ce-error-line"]).toEqual({ boxShadow: "inset 2px 0 0 var(--danger)" });
  });
});
