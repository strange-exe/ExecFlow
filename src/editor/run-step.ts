// The step-through's marks in the code (Workbench stage 3, option A's mock): after a Python run, each
// line that ran shows how many times it had run by the step shown ("x7", mono, in the trace's ink) in
// a gutter of its own before the line numbers, and the step's own line carries a class on the line
// and on its gutter cells: highlight.ts draws a bar in the focus pink and a faint wash, so the line is
// marked by a shape too, never by colour alone. The workbench sets both for each step the stepper
// shows (EditorManager.showRunStep); any edit clears them, as they belong to the text that ran.
import { Prec, RangeSet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, gutterLineClass, type DecorationSet } from "@codemirror/view";

/** What a step shows in the code: line counts so far (1-based line -> times), and its line (or none). */
export interface RunStepMarks {
  counts: ReadonlyMap<number, number>;
  now: number | null;
}

export const setRunStep = StateEffect.define<RunStepMarks | null>();

export const RUN_NOW_CLASS = "ce-run-now";
const TIMES = String.fromCodePoint(0xd7);

/** "x7": the multiplication sign and the count. */
export const countText = (n: number) => `${TIMES}${n}`;

/** A line's count in the run-count gutter. */
export class CountMarker extends GutterMarker {
  readonly text: string;
  constructor(readonly count: number) {
    super();
    this.text = countText(count);
  }

  eq(other: GutterMarker): boolean {
    return other instanceof CountMarker && other.count === this.count;
  }

  toDOM(view: EditorView): Node {
    // Text only (a number the app made, never the program's text).
    return view.dom.ownerDocument.createTextNode(this.text);
  }
}

/** A class on the step's line's cell in every gutter (it draws nothing itself). */
class NowClass extends GutterMarker {
  elementClass = RUN_NOW_CLASS;
  eq(other: GutterMarker): boolean {
    return other instanceof NowClass;
  }
}
const NOW_GUTTER = new NowClass();
const NOW_LINE = Decoration.line({ class: RUN_NOW_CLASS });

export interface RunStepState {
  readonly counts: RangeSet<GutterMarker>;
  readonly now: DecorationSet;
  readonly nowGutter: RangeSet<GutterMarker>;
}

export const runStep = StateField.define<RunStepState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setRunStep)) continue;
      const marks = e.value;
      if (!marks) return null;
      const doc = tr.state.doc;
      const has = (line: number) => Number.isInteger(line) && line >= 1 && line <= doc.lines;
      const lines = [...marks.counts].filter(([line, n]) => has(line) && n > 0).sort((a, b) => a[0] - b[0]);
      const counts: Range<GutterMarker>[] = lines.map(([line, n]) => new CountMarker(n).range(doc.line(line).from));
      const now = marks.now !== null && has(marks.now) ? doc.line(marks.now).from : null;
      return {
        counts: RangeSet.of(counts),
        now: now === null ? Decoration.none : Decoration.set([NOW_LINE.range(now)]),
        nowGutter: now === null ? RangeSet.empty : RangeSet.of([NOW_GUTTER.range(now)]),
      };
    }
    // The marks are of the text that ran: an edit makes them wrong, so they go.
    return tr.docChanged ? null : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (v) => v?.now ?? Decoration.none),
    gutterLineClass.from(field, (v) => v?.nowGutter ?? RangeSet.empty),
  ],
});

/** The column's hidden spacer ("x99"), classed so that app.css can drop it on narrow screens. */
class SpacerMarker extends CountMarker {
  elementClass = "ce-run-spacer";
}

/**
 * The run-count column, for the files that have steps (Python: extensions.ts fileExtensions). From
 * 900 px its width is held from the start (two digits' worth, the spacer), so the counts arriving
 * after a run move no code; below that the code wraps and every column costs code width, so the
 * spacer is dropped (app.css) and the column comes with the counts. Prec.high puts it before the
 * line numbers.
 */
export const runCountColumn: Extension = Prec.high(
  gutter({
    class: "ce-run-counts",
    markers: (view) => view.state.field(runStep, false)?.counts ?? RangeSet.empty,
    initialSpacer: () => new SpacerMarker(99),
  }),
);

/** In every file's state (the marks can be set on any file; only Python shows them). */
export const runStepExtension: Extension = [runStep];
