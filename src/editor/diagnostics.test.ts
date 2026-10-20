import { forEachDiagnostic, linter, type Diagnostic } from "@codemirror/lint";
import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { ToolDiagnostic } from "../core/types";
import {
  CALL_SITE_CLASS, cleanText, cmSeverity, diagnosticMessage, isCallSite, mergeSource, sourceLabel, toCm, type EditorDiagnostic,
} from "./diagnostics";

const doc = (text: string) => Text.of(text.split("\n"));
const clang = (over: Partial<ToolDiagnostic>): ToolDiagnostic => ({
  path: "main.c", line: 1, unit: "utf8-byte", base: 1, severity: "error", message: "something is wrong", source: "clang", ...over,
});
const SOURCE = doc("int main(void) {\n    retur 0;\n}");
const text = (d: { from: number; to: number }, t: Text = SOURCE) => t.sliceString(d.from, d.to);

describe("toCm positions", () => {
  it("uses the reported range (end exclusive)", () => {
    const d = toCm(SOURCE, clang({ line: 2, col: 5, endLine: 2, endCol: 10 }));
    expect(text(d)).toBe("retur");
  });

  it("without an end, marks the word that starts at the column", () => {
    expect(text(toCm(SOURCE, clang({ line: 2, col: 5 })))).toBe("retur");
    expect(text(toCm(SOURCE, clang({ line: 1, col: 5 })))).toBe("main");
  });

  it("without an end and no word there, marks the rest of the line", () => {
    expect(text(toCm(SOURCE, clang({ line: 1, col: 9 })))).toBe("(void) {");
  });

  it("without a column, marks the whole line from its first non-space character", () => {
    expect(text(toCm(SOURCE, clang({ line: 2 })))).toBe("retur 0;");
  });

  it("with an end line but no end column, runs to the end of that line", () => {
    expect(text(toCm(SOURCE, clang({ line: 1, col: 5, endLine: 2 })))).toBe("main(void) {\n    retur 0;");
  });

  it("clamps a line past the end of the file to the last line", () => {
    const d = toCm(SOURCE, clang({ line: 40, col: 1 }));
    expect(SOURCE.lineAt(d.from).number).toBe(3);
    expect(d.to).toBeLessThanOrEqual(SOURCE.length);
  });

  it("clamps line 0, negative and NaN lines to the first line", () => {
    for (const line of [0, -3, Number.NaN]) expect(toCm(SOURCE, clang({ line, col: 1 })).from).toBe(0);
  });

  it("clamps a column past the end of the line to a point at the line end (clang's 'expected ;')", () => {
    const d = toCm(SOURCE, clang({ line: 2, col: 300 }));
    expect(d.from).toBe(SOURCE.line(2).to);
    expect(d.to).toBe(d.from);
  });

  it("never gives to < from, even for an end before the start", () => {
    const d = toCm(SOURCE, clang({ line: 2, col: 9, endLine: 1, endCol: 1 }));
    expect(d.to).toBe(d.from);
    const e = toCm(SOURCE, clang({ line: 2, col: 9, endCol: 2 }));
    expect(e.to).toBe(e.from);
  });

  it("clamps an end past the end of the file", () => {
    const d = toCm(SOURCE, clang({ line: 3, col: 1, endLine: 99, endCol: 99 }));
    expect(d.to).toBe(SOURCE.length);
  });

  it("converts Python's 0-based UTF-16 wire columns", () => {
    const py = doc("x = 1 / 0");
    expect(text(toCm(py, { path: "main.py", line: 1, col: 4, endCol: 9, unit: "utf16", base: 0, severity: "error", message: "ZeroDivisionError: division by zero", source: "python" }), py)).toBe("1 / 0");
  });

  it("works on an empty file", () => {
    const empty = doc("");
    const d = toCm(empty, clang({ line: 3, col: 7 }));
    expect([d.from, d.to]).toEqual([0, 0]);
  });
});

describe("toCm text", () => {
  it("maps severities one to one, and anything unexpected to error", () => {
    expect(["error", "warning", "info", "hint"].map((s) => cmSeverity(s as ToolDiagnostic["severity"]))).toEqual(["error", "warning", "info", "hint"]);
    expect(cmSeverity("fatal" as ToolDiagnostic["severity"])).toBe("error");
  });

  it("appends notes, naming the file only when it is another one", () => {
    const d = clang({
      message: "redefinition of 'f'",
      notes: [
        { path: "main.c", line: 3, col: 5, unit: "utf8-byte", base: 1, message: "previous definition is here" },
        { path: "util.h", line: 7, unit: "utf8-byte", base: 1, message: "declared here" },
        { path: null, line: 1, unit: "utf8-byte", base: 1, message: "in the program" },
      ],
    });
    expect(diagnosticMessage(d)).toBe("redefinition of 'f'\nnote: previous definition is here (line 3)\nnote: declared here (util.h:7)\nnote: in the program");
    expect(toCm(SOURCE, d).message).toBe(diagnosticMessage(d));
  });

  it("labels the source with the warning flag or exception type, and says when the line was guessed", () => {
    expect(sourceLabel(clang({ code: "-Wunused-variable" }))).toBe("clang -Wunused-variable");
    expect(sourceLabel(clang({ source: "wasm-ld", heuristic: true }))).toBe("wasm-ld, location estimated");
    expect(toCm(SOURCE, clang({ source: "python", code: "ZeroDivisionError" })).markClass).toBe("ce-diag ce-diag-python");
  });

  it("marks a call site's range ce-call-site and keeps its severity and words", () => {
    const call = clang({ source: "python", severity: "info", role: "call-site", message: "This call led to ZeroDivisionError in calc.py, line 2." });
    const d = toCm(SOURCE, call);
    expect(d.markClass).toBe(`ce-diag ce-diag-python ${CALL_SITE_CLASS}`);
    expect([d.severity, d.message]).toEqual(["info", "This call led to ZeroDivisionError in calc.py, line 2."]);
    expect(isCallSite(d)).toBe(true);
    // Only the role makes a call site: an info diagnostic of the tool's own is not one.
    const info = toCm(SOURCE, { ...call, role: undefined });
    expect(info.markClass).toBe("ce-diag ce-diag-python");
    expect(isCallSite(info)).toBe(false);
    expect(isCallSite({ from: 0, to: 1, severity: "info", message: "no raw report" })).toBe(false);
  });

  it("strips colour codes, control and direction characters but keeps tabs and line breaks", () => {
    const esc = String.fromCharCode(27);
    const dirty = `${esc}[91merror${esc}[0m:\tbad${String.fromCharCode(0)}${String.fromCodePoint(0x202e)}\nnext`;
    expect(cleanText(dirty)).toBe("error:\tbad\nnext");
    expect(cleanText("x".repeat(5000)).length).toBe(4003);
  });

  it("renders the severity as a word in front of the message, as text nodes", () => {
    type Fake = { tag: string; className: string; textContent: string; children: unknown[] };
    const fakeDocument = {
      createElement: (tag: string) => {
        const el: Fake & { append(...nodes: unknown[]): void } = {
          tag, className: "", textContent: "", children: [],
          append(...nodes) { this.children.push(...nodes); },
        };
        return el;
      },
      createTextNode: (data: string) => ({ data }),
    };
    const view = { dom: { ownerDocument: fakeDocument } } as unknown as EditorView;
    const d = toCm(SOURCE, clang({ severity: "warning", message: "<b>unused</b> variable 'x'" }));
    const node = d.renderMessage!(view) as unknown as Fake;
    const [word, rest] = node.children as [Fake, { data: string }];
    expect([word.tag, word.className, word.textContent]).toEqual(["strong", "ce-diag-severity", "Warning"]);
    expect(rest.data).toBe(": <b>unused</b> variable 'x'");
  });
});

describe("mergeSource", () => {
  const base = () => EditorState.create({ doc: "alpha beta gamma\ndelta", extensions: [linter(null)] });
  const at = (from: number, to: number, message: string): Diagnostic => ({ from, to, severity: "error", message });
  const listOf = (state: EditorState) => {
    const out: { from: number; to: number; message: string; channel?: string }[] = [];
    forEachDiagnostic(state, (d, from, to) => out.push({ from, to, message: d.message, channel: (d as EditorDiagnostic).channel }));
    return out;
  };

  it("keeps the other channels' diagnostics and replaces only its own", () => {
    let state = base();
    state = state.update(mergeSource(state, "build", [at(0, 5, "build 1")])).state;
    state = state.update(mergeSource(state, "lint", [at(6, 10, "lint 1")])).state;
    expect(listOf(state).map((d) => [d.message, d.channel])).toEqual([["build 1", "build"], ["lint 1", "lint"]]);

    state = state.update(mergeSource(state, "build", [at(11, 16, "build 2")])).state;
    expect(listOf(state).map((d) => d.message)).toEqual(["lint 1", "build 2"]);

    state = state.update(mergeSource(state, "build", [])).state;
    expect(listOf(state).map((d) => d.message)).toEqual(["lint 1"]);
  });

  it("keeps the other channel at its current, edited position", () => {
    let state = base();
    state = state.update(mergeSource(state, "lint", [at(6, 10, "beta")])).state;
    state = state.update({ changes: { from: 0, insert: ">> " } }).state;
    state = state.update(mergeSource(state, "build", [at(0, 2, "arrows")])).state;
    const lint = listOf(state).find((d) => d.channel === "lint")!;
    expect(state.doc.sliceString(lint.from, lint.to)).toBe("beta");
  });

  it("clamps positions outside the document instead of letting the gutter throw", () => {
    let state = base();
    const length = state.doc.length;
    state = state.update(mergeSource(state, "build", [at(length + 50, length + 90, "past the end"), at(-4, 3, "before the start")])).state;
    const list = listOf(state);
    expect(list.map((d) => [d.from, d.to])).toEqual([[0, 3], [length, length]]);
  });

  it("sets the diagnostics again even when the channel is empty before and after", () => {
    // An edit that deletes an error's text drops it from the lint state, while its gutter mark
    // stays until the next set: skipping an "empty to empty" set left that mark behind.
    let state = base();
    state = state.update(mergeSource(state, "check", [at(0, 5, "syntax")])).state;
    state = state.update({ changes: { from: 0, to: 5 } }).state;
    expect(listOf(state)).toHaveLength(0);
    expect(state.update(mergeSource(state, "check", [])).effects).toHaveLength(1);
  });

  it("installs the lint state on a state that didn't have it", () => {
    let state = EditorState.create({ doc: "x" });
    state = state.update(mergeSource(state, "build", [at(0, 1, "x")])).state;
    expect(listOf(state)).toHaveLength(1);
  });
});
