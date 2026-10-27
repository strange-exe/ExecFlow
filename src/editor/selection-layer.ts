// The selection drawn line by line (0.7.0): each selected line's band ends where its text ends,
// plus one character's width when its line break is selected too, so an empty selected line still
// shows. CodeMirror's own layer fills every line between a selection's first and last from edge to
// edge, which turned three selected lines into one solid block (the owner's "heavy blue band").
// drawSelection() still draws the cursors; its selection layer is hidden (highlight.ts), and this
// one's bands carry its class, so the --selection colour applies. The bands are as tall as the
// line's block (the line pitch), so a run of lines meets without gaps.
// API: layer() and RectangleMarker, @codemirror/view 6.43 (codemirror.net/docs/ref/#view.layer).
import { EditorSelection } from "@codemirror/state";
import { Direction, layer, RectangleMarker, type EditorView, type LayerMarker } from "@codemirror/view";

const CLASS = "cm-selectionBackground";

/** The client position the layer's markers are measured from (CodeMirror's getBase). */
function base(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const left = view.textDirection === Direction.LTR ? rect.left : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return { left: left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY };
}

export function lineMarkers(view: EditorView): LayerMarker[] {
  const out: LayerMarker[] = [];
  const { doc } = view.state;
  const at = base(view);
  const breakWidth = view.defaultCharacterWidth;
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    for (const visible of view.visibleRanges) {
      const from = Math.max(range.from, visible.from);
      const to = Math.min(range.to, visible.to);
      if (from > to) continue;
      for (let pos = from; pos <= to; ) {
        const line = doc.lineAt(pos);
        const start = Math.max(from, line.from);
        const end = Math.min(to, line.to);
        const withBreak = range.to > line.to;
        const block = view.lineBlockAt(line.from);
        const top = view.documentTop + block.top - at.top;
        const height = block.height;
        if (start < end) {
          const pieces = RectangleMarker.forRange(view, CLASS, EditorSelection.range(start, end));
          // One visual row: its piece gets the line's full height. A wrapped line keeps the pieces
          // CodeMirror measured for its rows.
          const rows = pieces.length === 1 ? [new RectangleMarker(CLASS, pieces[0].left, top, pieces[0].width, height)] : [...pieces];
          if (withBreak && rows.length) {
            const last = rows[rows.length - 1];
            rows[rows.length - 1] = new RectangleMarker(CLASS, last.left, last.top, (last.width ?? 0) + breakWidth, last.height);
          }
          out.push(...rows);
        } else if (withBreak && start === line.to) {
          // An empty line, or the selection starting at a line's end: the line break alone.
          const caret = view.coordsAtPos(line.to, -1) ?? view.coordsAtPos(line.to, 1);
          if (caret) out.push(new RectangleMarker(CLASS, caret.left - at.left, top, breakWidth, height));
        }
        pos = line.to + 1;
      }
    }
  }
  return out;
}

export const selectionLayer = layer({
  above: false,
  // One class: CodeMirror adds it with classList.add, which takes a single token.
  class: "ce-selection-layer",
  markers: lineMarkers,
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
});
