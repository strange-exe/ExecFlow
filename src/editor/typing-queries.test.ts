// What the list offers while a word is typed on with it open. A source with nothing to offer
// answers null (keyword-completion.ts unless), so CodeMirror 6.20.3 runs a new query on most keys
// (@codemirror/autocomplete dist/index.js, ActiveSource.update): the list typed on must offer what
// a list opened by the last key offers, and still the wanted name.
//
// The view is a stand-in that runs CodeMirror's own completion plugin (the ViewPlugin that
// autocompletion() returns, with its timers, queries and accept step) on each update: Vitest has no
// DOM here, and this keeps the real state machine instead of a model of it.
import { autocompletion, closeCompletion, CompletionContext, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, StateField, type Extension, type TransactionSpec } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { libraryContext } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import { unless } from "./keyword-completion";
import { loadLibrary } from "./library-data";

beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
  expect(await loadLibrary("c")).toBe(true);
  expect(await loadLibrary("python")).toBe(true);
});

const TYPING = autocompletion({ activateOnTyping: true });

/** CodeMirror's completion plugin, as autocompletion() returns it among its extensions. */
const completionPlugin = (() => {
  const plugin = (TYPING as readonly Extension[]).find((e): e is ViewPlugin<PluginValue> => e instanceof ViewPlugin);
  if (!plugin) throw new Error("autocompletion() returned no ViewPlugin");
  return plugin as unknown as { create(view: EditorView, arg: unknown): PluginValue & { update(u: ViewUpdate): void } };
})();

/** Its state field (where the list is drawn: tooltip.pos). */
const completionField = (() => {
  const field = (TYPING as readonly Extension[]).find((e) => e instanceof StateField);
  if (!field) throw new Error("autocompletion() returned no StateField");
  return field as StateField<{ tooltip: { pos: number } | null }>;
})();

class StandIn {
  state: EditorState;
  hasFocus = true;
  private readonly plugin: PluginValue & { update(u: ViewUpdate): void };

  constructor(state: EditorState) {
    this.state = state;
    this.plugin = completionPlugin.create(this as unknown as EditorView, undefined);
  }

  dispatch(...specs: TransactionSpec[]) {
    const startState = this.state;
    const tr = startState.update(...specs);
    this.state = tr.state;
    this.plugin.update({ state: tr.state, startState, transactions: [tr], selectionSet: tr.selection !== undefined, docChanged: tr.docChanged, view: this } as unknown as ViewUpdate);
  }

  setTabFocusMode() {}

  destroy() {
    this.plugin.destroy?.();
  }
}

const views: StandIn[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function open(path: string, doc: string): StandIn {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      TYPING,
      fileConf.of(fileExtensions(path)),
      libraryContext.of({ files: () => [path], standards: () => ({ c: "gnu11", cpp: "c++17" }) }),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new StandIn(state);
  views.push(view);
  return view;
}

const tick = () => new Promise((done) => setTimeout(done, 10));

/** Waits until no query is pending, and at least past the typing delay (100 ms) and the accept step (100 ms). */
async function settle(view: StandIn) {
  const start = Date.now();
  while (Date.now() - start < 260 || completionStatus(view.state) === "pending") {
    if (Date.now() - start > 3000) throw new Error("a query never answered");
    await tick();
  }
}

/** Types `text` one key at a time; returns the completion status right after each key (pending: a query starts). */
async function type(view: StandIn, text: string): Promise<(string | null)[]> {
  const after: (string | null)[] = [];
  for (const ch of text) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" });
    after.push(completionStatus(view.state));
    await settle(view);
  }
  return after;
}

const labels = (view: StandIn) => currentCompletions(view.state).map((c) => c.label);

const C_MAIN = "#include <stdio.h>\n\nint main(void) {\n    int total = 0;\n    ";

describe("typing on in a word with the list open", () => {
  it.each([
    ["main.c", "tot", "al", "in main", C_MAIN, "total"],
    ["main.cpp", "tot", "al", "in main", "#include <iostream>\n\nint main() {\n    int total = 0;\n    ", "total"],
    ["main.py", "tot", "al", "at file level", "total = 0\n", "total"],
    ["main.c", "pri", "ntf", "in main", C_MAIN, "printf"],
    // No own name in the file: the own-name source answers an empty list too.
    ["main.c", "pri", "ntf", "in a file that declares nothing", "#include <stdio.h>\n", "printf"],
    ["main.cpp", "co", "ut", "after std::", "#include <iostream>\n\nint main() {\n    std::", "cout"],
    ["main.c", "st", "di", "after #include <", "#include <", "stdio.h"],
    ["main.py", "pri", "nt", "at file level", "import math\n", "print"],
    ["main.py", "ma", "th", "after import", "import ", "math"],
    ["main.py", "sq", "rt", "after math.", "import math\nmath.", "sqrt"],
  ])("%s, %s then %s %s: the list still offers the name", async (path, first, more, _where, doc, wanted) => {
    const view = open(path, doc);
    await type(view, first);
    expect(completionStatus(view.state)).toBe("active");
    expect(labels(view)).toContain(wanted);
    await type(view, more);
    expect(completionStatus(view.state)).toBe("active");
    expect(labels(view)).toContain(wanted);
  });

  it("still asks again at a character that ends the word, as every source's validFor says", async () => {
    const view = open("main.c", C_MAIN);
    await type(view, "tot");
    expect(await type(view, " ")).toEqual(["pending"]);
    expect(completionStatus(view.state)).toBeNull(); // nothing fits after a space: the list closes
  });

  it.each([
    ["main.c", C_MAIN, "tota"],
    ["main.c", C_MAIN, "prin"],
    ["main.cpp", "int main() {\n    std::", "cou"],
    ["main.c", "#include <", "stdi"],
    ["main.py", "import math\n", "pri"],
    ["main.py", "import math\nmath.", "sq"],
    ["main.py", "", "import ma"],
  ])("%s: the list typed on in %j offers what a list opened by its last key offers", async (path, doc, typed) => {
    const kept = open(path, doc);
    await type(kept, typed);
    const fresh = open(path, doc + typed.slice(0, -1));
    await type(fresh, typed.slice(-1));
    expect(labels(kept).length).toBeGreaterThan(0);
    expect(labels(kept)).toEqual(labels(fresh));
  });

  it("a source with nothing to offer answers null, not an empty list that stays valid (keyword-completion.ts unless)", () => {
    const state = EditorState.create({ doc: "x = abz" });
    const context = new CompletionContext(state, state.doc.length, false);
    const offers = () => ({ from: "x = ".length, options: [{ label: "abzy" }] });
    expect(unless(() => true, offers)(context)).toBeNull();
    expect(unless(() => false, offers)(context)).toEqual(offers());
  });

  it("an empty answer never moves the list: it is drawn where the typed word starts", async () => {
    const view = open("main.c", C_MAIN);
    await type(view, "x = tot");
    expect(view.state.field(completionField).tooltip?.pos).toBe(view.state.doc.length - "tot".length);
    closeCompletion(view as unknown as EditorView);
    expect(completionStatus(view.state)).toBeNull();
  });
});
