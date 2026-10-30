// Suggestions asked for before the data they need has arrived (the library data still loading, a
// header or module the workspace index hasn't read yet). The source offers what there is, without
// validFor (so the next key asks again instead of refiltering an incomplete list), and once the data
// arrives the query runs again where it was asked, as if the key had been pressed then (review
// finding RB-1, 2026-10-19: "helpers." stayed empty, and "hel" kept a list without helper).
// The view is a stand-in: a state with autocompletion, focus, and dispatch.
import { autocompletion, CompletionContext, completionStatus, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { IndexSlot, libraryContext, workspaceIndex } from "./completion-context";
import { ESCAPE_KEY, fileConf, fileExtensions } from "./extensions";
import { whenDataArrives } from "./late-data";
import { cLibrarySource, pythonMemberSource } from "./library-completion";
import { libraryStatus } from "./library-data";
import { cOwnSource } from "./own-completion";
import { indexIn, type Scheduler } from "./workspace-index";
import "./test-languages";

const soon: Scheduler = (slice) => void setTimeout(() => slice(() => true), 0);

/** A tick for the index, the library chunk and the re-run (each waits on a promise or a timer). */
const tick = () => new Promise((done) => setTimeout(done, 0));

/** Waits up to 3 s (timers are coarse on Windows: about 16 ms a tick). */
async function until(check: () => boolean, what: string) {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await tick();
  expect(check(), what).toBe(true);
}

function setup(files: Record<string, string>, path: string, doc: string) {
  const slot = new IndexSlot({ read: (p) => (Object.hasOwn(files, p) ? Promise.resolve(files[p]) : Promise.reject(new Error("missing"))) }, soon);
  const index = indexIn(slot);
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      autocompletion(),
      fileConf.of(fileExtensions(path)),
      libraryContext.of({ files: () => Object.keys(files), standards: () => ({ c: "gnu11", cpp: "c++17" }) }),
      workspaceIndex.of(slot),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = {
    state,
    hasFocus: true,
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
    setTabFocusMode() {},
  };
  return { index, view, asView: view as unknown as EditorView };
}

async function ask(source: CompletionSource, view: EditorView, explicit = false): Promise<CompletionResult | null> {
  return source(new CompletionContext(view.state, view.state.selection.main.head, explicit, view));
}

const labelsOf = (r: CompletionResult | null) => (r ? r.options.map((o) => o.label) : []);

// Runs first: in this file's fresh module nothing has loaded the C library yet.
describe("library data that is still loading", () => {
  it("`pri` asked before the C library has loaded runs again once it has, and then offers printf", async () => {
    expect(libraryStatus("c")).toBe("idle");
    const { view, asView } = setup({ "main.c": "" }, "main.c", "int main(void) {\n  pri");
    const source = cLibrarySource("c");
    expect(await ask(source, asView)).toBeNull();
    expect(completionStatus(view.state), "nothing runs again before the data is there").toBeNull();
    await until(() => libraryStatus("c") === "ready", "the C library loads");
    await until(() => completionStatus(view.state) === "pending", "the query runs again once the data is there");
    expect(labelsOf(await ask(source, asView))).toContain("printf");
  });
});

describe("a quoted header the index hasn't read yet (C)", () => {
  const files = { "main.c": "", "util.h": "int helper(int x);\n" };
  const doc = '#include "util.h"\nint x = hel';

  it("offers no validFor while the header is unknown, and runs the query again when the index has read it", async () => {
    const { index, view, asView } = setup(files, "main.c", doc);
    const source = cOwnSource();
    const first = await ask(source, asView);
    expect(labelsOf(first)).not.toContain("helper");
    // An incomplete list is asked for again at the next key, never refiltered.
    expect(first?.validFor, "no validFor on a list built without the header").toBeUndefined();
    await until(() => !index.busy && index.get("util.h") !== null, "the index reads util.h");
    await until(() => completionStatus(view.state) === "pending", "the query runs again once util.h is known");
    const again = await ask(source, asView);
    expect(labelsOf(again)).toContain("helper");
    expect(again?.validFor, "a complete list keeps validFor").toBeInstanceOf(RegExp);
  });

  it("does not run it again when the text or the cursor moved, focus left, Escape was pressed, or the file turned read-only", async () => {
    const cases: [string, (v: { state: EditorState; hasFocus: boolean; dispatch(spec: TransactionSpec): void }, asView: EditorView) => void][] = [
      ["typed on", (v) => v.dispatch({ changes: { from: v.state.doc.length, insert: "p" }, selection: { anchor: v.state.doc.length + 1 } })],
      // The text changed elsewhere, the cursor's offset didn't: still not the place it was asked.
      ["text changed before the cursor", (v) => v.dispatch({ changes: { from: 0, to: 1, insert: "/" } })],
      ["cursor moved", (v) => v.dispatch({ selection: { anchor: 0 } })],
      ["focus left", (v) => void (v.hasFocus = false)],
      ["Escape", (_v, asView) => void ESCAPE_KEY.run!(asView)],
      ["read-only", (v) => v.dispatch({ effects: fileConf.reconfigure([fileExtensions("main.c"), EditorState.readOnly.of(true)]) })],
    ];
    for (const [what, act] of cases) {
      const { index, view, asView } = setup(files, "main.c", doc);
      await ask(cOwnSource(), asView);
      act(view, asView);
      await until(() => !index.busy && index.get("util.h") !== null, `${what}: the index reads util.h`);
      for (let i = 0; i < 5; i++) await tick();
      expect(completionStatus(view.state), what).toBeNull();
    }
  });
});

describe("whenDataArrives", () => {
  it("runs the query again when the data came, not when its load failed (asking again would only fail again)", async () => {
    const { view, asView } = setup({ "main.c": "" }, "main.c", "int x = pri");
    const context = () => new CompletionContext(view.state, view.state.doc.length, false, asView);
    whenDataArrives(context(), Promise.resolve(false));
    for (let i = 0; i < 5; i++) await tick();
    expect(completionStatus(view.state), "after a failed load").toBeNull();
    whenDataArrives(context(), Promise.resolve(true));
    await until(() => completionStatus(view.state) === "pending", "after the data came");
  });
});

describe("your own Python module the index hasn't read yet", () => {
  it("`helpers.` offers nothing at first, then runs again when helpers.py is read, and offers greet", async () => {
    const files = { "main.py": "", "helpers.py": "def greet(name):\n    return name\n" };
    const { index, view, asView } = setup(files, "main.py", "import helpers\nhelpers.");
    expect(await ask(pythonMemberSource, asView)).toBeNull();
    await until(() => !index.busy && index.get("helpers.py") !== null, "the index reads helpers.py");
    await until(() => completionStatus(view.state) === "pending", "the query runs again once helpers.py is known");
    const again = await ask(pythonMemberSource, asView);
    expect(labelsOf(again)).toContain("greet");
  });
});
