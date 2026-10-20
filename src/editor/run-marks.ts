// What a failed run leaves in the code besides the lint marks (layout v2 idea 5):
// - the error-line band: every line where the run's own error was raised gets a line class
//   (`ce-error-line`) and the same class on its cell in every gutter, so code and gutter carry the
//   band together;
// - the call-site line: the line of a call that led to an error in another place gets a class on
//   its gutter cells (`ce-call-line`), which the lint column draws as an arrow.
// Both are read from the lint state, never kept on their own, so they live exactly as long as the
// squiggles they belong to: the next run, or an edit that removes a diagnostic, clears them. The
// idle check's errors (channel "check") are marked by their squiggle and gutter dot only.
// Colours and shapes: highlight.ts CHROME_SPEC and extensions.ts LINT_SPEC.

import { forEachDiagnostic, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { RangeSet, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet } from "@codemirror/view";
import { isCallSite, type EditorDiagnostic } from "./diagnostics";

/** The channel a run's own diagnostics use (a Python run or a C/C++ build): EditorManager's default. */
export const RUN_CHANNEL = "build";

export const ERROR_LINE_CLASS = "ce-error-line";
export const CALL_LINE_CLASS = "ce-call-line";

/** A class on one line's cell in every gutter (it draws nothing itself). */
class LineClass extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof LineClass && other.elementClass === this.elementClass;
  }
}

const ERROR_GUTTER = new LineClass(ERROR_LINE_CLASS);
const CALL_GUTTER = new LineClass(CALL_LINE_CLASS);
const ERROR_LINE = Decoration.line({ class: ERROR_LINE_CLASS });

/** The run's own errors band their line; warnings, the idle check and call sites don't. */
export function bandsLine(d: Diagnostic): boolean {
  return d.severity === "error" && (d as EditorDiagnostic).channel === RUN_CHANNEL && !isCallSite(d);
}

export interface RunMarks {
  /** The band's line decorations. */
  readonly lines: DecorationSet;
  /** The classes on the gutter cells of banded and call-site lines. */
  readonly gutter: RangeSet<GutterMarker>;
}

const NONE: RunMarks = { lines: Decoration.none, gutter: RangeSet.empty };

/** The marks for every diagnostic in `state`, at its current (mapped) position. */
export function runMarksOf(state: EditorState): RunMarks {
  const errors = new Set<number>();
  const calls = new Set<number>();
  forEachDiagnostic(state, (d, from) => {
    // A diagnostic marks the line it starts on: the line that raised, or the call.
    const line = state.doc.lineAt(from).from;
    if (bandsLine(d)) errors.add(line);
    else if (isCallSite(d)) calls.add(line);
  });
  if (!errors.size && !calls.size) return NONE;
  const lines: Range<Decoration>[] = [...errors].map((at) => ERROR_LINE.range(at));
  const gutter: Range<GutterMarker>[] = [
    ...[...errors].map((at) => ERROR_GUTTER.range(at)),
    ...[...calls].map((at) => CALL_GUTTER.range(at)),
  ];
  return { lines: Decoration.set(lines, true), gutter: RangeSet.of(gutter, true) };
}

/**
 * Recomputed whenever the diagnostics are set or the text changes (positions move, and an edit can
 * remove a diagnostic); other transactions keep the value, so nothing redraws while the cursor
 * moves. With no marks the value is always the same NONE object, so typing in a clean file changes
 * nothing either.
 */
export const runMarks = StateField.define<RunMarks>({
  create: (state) => runMarksOf(state),
  update: (marks, tr) =>
    tr.docChanged || tr.effects.some((e) => e.is(setDiagnosticsEffect)) ? runMarksOf(tr.state) : marks,
  provide: (field) => [
    EditorView.decorations.from(field, (marks) => marks.lines),
    gutterLineClass.from(field, (marks) => marks.gutter),
  ],
});
