// A hanging indent for wrapped lines (phone layout, option A, 2026-11-03): below 900 px, where long
// lines always wrap, a line's second and later rows start two columns past the line's own indent,
// so a wrapped row never reads as a new line of code. Each line on screen is marked with its hang
// (class cm-hang, --hang); app.css, below 900 px only, gives it a padding of its hang and a
// text-indent of minus that, which leaves the first row where it was (its own spaces still drawn)
// and moves the rest. From 900 px the mark changes nothing (that width keeps its own wrapping).
// Only the lines in view are marked.
import { countColumn, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** The columns a wrapped line's later rows start at: its indent (tabs counted to `tabSize`) and 2. */
export function hangColumns(text: string, tabSize: number): number {
  const indent = /^[ \t]*/.exec(text)![0];
  return countColumn(indent, tabSize) + 2;
}

/** The line's style for a hang of `columns` (app.css reads --hang). */
export function hangStyle(columns: number): string {
  return `--hang: ${columns}ch`;
}

const marks = new Map<number, Decoration>();
const mark = (columns: number) => {
  let deco = marks.get(columns);
  if (!deco) marks.set(columns, (deco = Decoration.line({ attributes: { class: "cm-hang", style: hangStyle(columns) } })));
  return deco;
};

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tab = view.state.tabSize;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      builder.add(line.from, line.from, mark(hangColumns(line.text, tab)));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const hangingIndent: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = decorate(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
