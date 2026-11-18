// The step-through's marks in the code (run-step.ts): a count per line that ran by the step shown
// ("x7" in its own gutter), and the step's own line (a class on the line and on its gutter cells,
// drawn as a bar). Set by an effect, cleared by any edit: they belong to the text that ran.
import { EditorState, RangeSet } from "@codemirror/state";
import { gutterLineClass, type GutterMarker } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { EditorManager } from "./editor-manager";
import { BASE, fileExtensions } from "./extensions";
import { headlessHost, type EditorHost } from "./host";
import { countText, RUN_NOW_CLASS, runCountColumn, runStep, runStepExtension, setRunStep, type CountMarker } from "./run-step";

const DOC = "total = 0\nfor n in range(1, 7):\n    if n % 2 == 0:\n        total += n\nprint(total)\n";

function state(doc = DOC) {
  return EditorState.create({ doc, extensions: runStepExtension });
}

/** The counts the gutter shows: [line, text]. */
function counts(s: EditorState): [number, string][] {
  const out: [number, string][] = [];
  const marks = s.field(runStep);
  if (!marks) return out;
  marks.counts.between(0, s.doc.length, (from, _to, m) => void out.push([s.doc.lineAt(from).number, (m as CountMarker).text]));
  return out;
}

/** Lines whose gutter cells carry the step's class. */
function nowLines(s: EditorState): number[] {
  const out: number[] = [];
  for (const set of s.facet(gutterLineClass)) {
    (set as RangeSet<GutterMarker>).between(0, s.doc.length, (from, _to, m) => {
      if (m.elementClass === RUN_NOW_CLASS) out.push(s.doc.lineAt(from).number);
    });
  }
  return out;
}

const TIMES = String.fromCodePoint(0xd7);

describe("run step marks in the code", () => {
  it("count text: a times sign and the count, nothing for none", () => {
    expect(countText(7)).toBe(`${TIMES}7`);
    expect(countText(12345)).toBe(`${TIMES}12345`);
  });

  it("shows nothing until a step is set", () => {
    const s = state();
    expect(s.field(runStep)).toBeNull();
    expect(counts(s)).toEqual([]);
    expect(nowLines(s)).toEqual([]);
  });

  it("marks each line that ran with its count, and the step's line with its class", () => {
    const s = state().update({ effects: setRunStep.of({ counts: new Map([[1, 1], [2, 7], [3, 6], [4, 3]]), now: 3 }) }).state;
    expect(counts(s)).toEqual([[1, `${TIMES}1`], [2, `${TIMES}7`], [3, `${TIMES}6`], [4, `${TIMES}3`]]);
    expect(nowLines(s)).toEqual([3]);
    // The line itself carries the class too (its bar and wash), once.
    const decos: number[] = [];
    s.field(runStep)!.now.between(0, s.doc.length, (from, _to, d) => {
      if (d.spec.class === RUN_NOW_CLASS) decos.push(s.doc.lineAt(from).number);
    });
    expect(decos).toEqual([3]);
  });

  it("a step with no line (Start, a return) marks no line; counts stay", () => {
    const s = state().update({ effects: setRunStep.of({ counts: new Map([[1, 1]]), now: null }) }).state;
    expect(counts(s)).toEqual([[1, `${TIMES}1`]]);
    expect(nowLines(s)).toEqual([]);
  });

  it("ignores lines the text doesn't have (never throws)", () => {
    const s = state("a = 1\n").update({ effects: setRunStep.of({ counts: new Map([[1, 2], [9, 3], [0, 1], [-4, 1]]), now: 40 }) }).state;
    expect(counts(s)).toEqual([[1, `${TIMES}2`]]);
    expect(nowLines(s)).toEqual([]);
  });

  it("any edit clears them: they belong to the text that ran", () => {
    let s = state().update({ effects: setRunStep.of({ counts: new Map([[2, 7]]), now: 2 }) }).state;
    s = s.update({ selection: { anchor: 3 } }).state;
    expect(counts(s)).toHaveLength(1);
    s = s.update({ changes: { from: 0, insert: "# x\n" } }).state;
    expect(s.field(runStep)).toBeNull();
    expect(counts(s)).toEqual([]);
    expect(nowLines(s)).toEqual([]);
  });

  it("a null step clears them", () => {
    let s = state().update({ effects: setRunStep.of({ counts: new Map([[2, 7]]), now: 2 }) }).state;
    s = s.update({ effects: setRunStep.of(null) }).state;
    expect(s.field(runStep)).toBeNull();
  });

  it("is part of every file's editor, before the line numbers", () => {
    const s = EditorState.create({ doc: DOC, extensions: BASE });
    expect(s.field(runStep, false)).toBeNull();
  });

  it("EditorManager.showRunStep sets them on a file, open or in the background, and scrolls only when asked", () => {
    const factory = headlessHost();
    let host: EditorHost | null = null;
    const mgr = new EditorManager({ host: (initial, on) => (host = factory(initial, on)) });
    mgr.open("a", "a.py", DOC);
    mgr.open("b", "b.py", "x = 1\n");
    mgr.activate("a");
    expect(mgr.showRunStep("b", { counts: new Map([[1, 1]]), now: 1 }, true)).toBe(true);
    expect(counts(mgr.state("b")!)).toEqual([[1, `${TIMES}1`]]);
    const scrolls: unknown[] = [];
    const live = host!;
    const dispatch = live.dispatch.bind(live);
    live.dispatch = (tr) => {
      // The scroll effect's type isn't exported: any effect besides the marks is the scroll.
      for (const e of tr.effects) if (!e.is(setRunStep)) scrolls.push(e.value);
      dispatch(tr);
    };
    mgr.showRunStep("a", { counts: new Map([[4, 3]]), now: 4 }, false);
    expect(scrolls).toHaveLength(0);
    mgr.showRunStep("a", { counts: new Map([[4, 3]]), now: 4 }, true);
    expect(scrolls).toHaveLength(1);
    expect(counts(mgr.state("a")!)).toEqual([[4, `${TIMES}3`]]);
    // A step without a line scrolls nowhere; null clears.
    mgr.showRunStep("a", { counts: new Map(), now: null }, true);
    expect(scrolls).toHaveLength(1);
    mgr.showRunStep("a", null, false);
    expect(mgr.state("a")!.field(runStep)).toBeNull();
    expect(mgr.showRunStep("nope", null, false)).toBe(false);
  });

  it("the count column belongs to Python files only (C and C++ have no steps)", () => {
    const has = (path: string) => [fileExtensions(path)].flat(9).includes(runCountColumn);
    expect(has("a.py")).toBe(true);
    expect(has("a.c")).toBe(false);
    expect(has("a.cpp")).toBe(false);
    expect(has("notes.txt")).toBe(false);
  });

  it("clearing a file that has no marks dispatches nothing (an edit already cleared them)", () => {
    // CodeMirror's update drops DOM input it hasn't read yet: a stray transaction right after an
    // edit (Firefox reads typing in parts) lost the typed text. An edit clears the marks itself.
    const factory = headlessHost();
    let host: EditorHost | null = null;
    const mgr = new EditorManager({ host: (initial, on) => (host = factory(initial, on)) });
    mgr.open("a", "a.py", DOC);
    mgr.open("b", "b.py", "x = 1\n");
    mgr.activate("a");
    let dispatched = 0;
    const live = host!;
    const dispatch = live.dispatch.bind(live);
    live.dispatch = (tr) => {
      dispatched++;
      dispatch(tr);
    };
    const before = mgr.state("b");
    expect(mgr.showRunStep("a", null, false)).toBe(false);
    expect(mgr.showRunStep("b", null, false)).toBe(false);
    expect(dispatched).toBe(0);
    expect(mgr.state("b")).toBe(before);
    // With marks, null clears them (one transaction); an edit clears them with no transaction of ours.
    mgr.showRunStep("a", { counts: new Map([[1, 1]]), now: 1 }, false);
    expect(dispatched).toBe(1);
    live.dispatch(mgr.state("a")!.update({ changes: { from: 0, insert: "#\n" } }));
    expect(mgr.state("a")!.field(runStep)).toBeNull();
    dispatched = 0;
    expect(mgr.showRunStep("a", null, false)).toBe(false);
    expect(dispatched).toBe(0);
  });
});
