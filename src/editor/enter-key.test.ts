// Enter with the suggestion list open (the owner's request, 2026-10-28): with "Enter accepts the top
// suggestion" on (the default) the list opens with its first option picked and Enter accepts it,
// except where accepting would change nothing (the word is already typed in full) and the pick
// wasn't moved by hand: then Enter makes a new line. Off: nothing is picked until Down or Up, as
// from 2026-10-18 to 2026-10-28.
//
// The view is a stand-in that runs CodeMirror's own completion plugin on each update (as in
// typing-queries.test.ts), and keys run the state's real keymaps in precedence order, so the
// interaction of BASE's Enter, completionKeymap's Enter and defaultKeymap's Enter is the real one.
import {
  acceptCompletion, autocompletion, completionStatus, currentCompletions, selectedCompletion, snippetCompletion, type Completion,
} from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { keymap, ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { libraryContext } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import {
  BASE, DEFAULT_PREFS, ENTER_KEY, enterKeepsWord, ESCAPE_KEY, fileConf, fileExtensions, prefsConf, prefsExtension, READ_ONLY, readOnlyConf, WRITABLE,
  type EditorPrefs,
} from "./extensions";
import { loadLibrary } from "./library-data";

beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
  expect(await loadLibrary("c")).toBe(true);
  expect(await loadLibrary("python")).toBe(true);
});

/** CodeMirror's completion plugin (one instance for every autocompletion() call, autocomplete 6.20.3). */
const completionPlugin = (() => {
  const plugin = (autocompletion() as readonly Extension[]).find((e): e is ViewPlugin<PluginValue> => e instanceof ViewPlugin);
  if (!plugin) throw new Error("autocompletion() returned no ViewPlugin");
  return plugin as unknown as { create(view: EditorView, arg: unknown): PluginValue & { update(u: ViewUpdate): void } };
})();

class StandIn {
  state: EditorState;
  hasFocus = true;
  private readonly plugin: PluginValue & { update(u: ViewUpdate): void };

  constructor(state: EditorState) {
    this.state = state;
    // Bound, as EditorView binds it (view 6.43.14): commands like insertNewlineAndIndent take it apart.
    this.dispatch = this.dispatch.bind(this);
    this.plugin = completionPlugin.create(this as unknown as EditorView, undefined);
  }

  dispatch(...args: (Transaction | TransactionSpec)[]) {
    const startState = this.state;
    const tr = args[0] instanceof Transaction ? args[0] : startState.update(...(args as TransactionSpec[]));
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

const prefsOf = (patch: Partial<EditorPrefs> = {}) => prefsExtension({ ...DEFAULT_PREFS, ...patch });

function open(path: string, doc: string, patch: Partial<EditorPrefs> = {}): StandIn {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      BASE,
      fileConf.of(fileExtensions(path)),
      readOnlyConf.of(WRITABLE),
      prefsConf.of(prefsOf(patch)),
      libraryContext.of({ files: () => [path], standards: () => ({ c: "gnu11", cpp: "c++17" }) }),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new StandIn(state);
  views.push(view);
  return view;
}

const tick = () => new Promise((done) => setTimeout(done, 10));

/** Waits until no query is pending, and well past the typing delay (100 ms) and interactionDelay (75 ms). */
async function settle(view: StandIn) {
  const start = Date.now();
  while (Date.now() - start < 260 || completionStatus(view.state) === "pending") {
    if (Date.now() - start > 3000) throw new Error("a query never answered");
    await tick();
  }
}

/** Types `text` one key at a time, as typing does (input.type), letting the list catch up after each key. */
async function type(view: StandIn, text: string) {
  for (const ch of text) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" });
    await settle(view);
  }
}

/** Backspace at the cursor, as the key does (delete.backward). */
function backspace(view: StandIn) {
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" });
}

/** A key, run through the state's keymaps in precedence order as the view does: the first binding that handles it wins. */
function press(view: StandIn, key: string): string {
  for (const list of view.state.facet(keymap)) {
    for (const binding of list) {
      if (binding.key !== key || !binding.run) continue;
      if (binding.run(view as unknown as EditorView)) return key;
    }
  }
  return "(unhandled)";
}

const labels = (view: StandIn) => currentCompletions(view.state).map((c) => c.label);
const text = (view: StandIn) => view.state.doc.toString();

describe("enterKeepsWord: when Enter makes a new line instead of accepting the picked option", () => {
  const plain: Completion = { label: "print", type: "function" };

  it("the word typed in full, the pick not moved: a new line", () => {
    expect(enterKeepsWord(plain, false, "print")).toBe(true);
    expect(enterKeepsWord(plain, false, "    x = print")).toBe(true);
    expect(enterKeepsWord({ label: "pi" }, false, "y = math.pi")).toBe(true);
    // apply text equal to the label inserts the same word.
    expect(enterKeepsWord({ label: "stdio.h", apply: "stdio.h" }, false, "#include <stdio.h")).toBe(true);
  });

  it("the pick moved by hand: Enter accepts, even the word typed in full", () => {
    expect(enterKeepsWord(plain, true, "print")).toBe(false);
  });

  it("a prefix, another word or another case: Enter accepts (it changes the text)", () => {
    expect(enterKeepsWord(plain, false, "pri")).toBe(false);
    expect(enterKeepsWord(plain, false, "Print")).toBe(false);
    expect(enterKeepsWord(plain, false, "")).toBe(false);
    // The word is longer: accepting would replace "my_print" (or "xprint") with "print".
    expect(enterKeepsWord(plain, false, "my_print")).toBe(false);
    expect(enterKeepsWord(plain, false, "xprint")).toBe(false);
  });

  it("an option that inserts more than its label (a snippet, an apply text) is accepted: it changes the text", () => {
    const def = snippetCompletion("def ${name}(${params}):\n\t${}", { label: "def", detail: "function" });
    expect(enterKeepsWord(def, false, "def")).toBe(false);
    expect(enterKeepsWord({ label: "stdio.h", apply: "stdio.h>" }, false, "#include <stdio.h")).toBe(false);
  });
});

describe("Enter with the list open", () => {
  it("on (the default): the list opens with the top option picked, and Enter accepts it without an arrow key", async () => {
    expect(DEFAULT_PREFS.enterAcceptsTop).toBe(true);
    const view = open("main.py", "");
    await type(view, "pri");
    expect(completionStatus(view.state)).toBe("active");
    expect(labels(view)[0]).toBe("print");
    expect(selectedCompletion(view.state)?.label).toBe("print");
    press(view, "Enter");
    expect(text(view)).toBe("print");
    expect(completionStatus(view.state)).toBeNull();
  });

  it("on: the word typed in full makes a new line (auto-indented), and the list closes", async () => {
    const view = open("main.py", "def f():\n    ");
    await type(view, "print");
    expect(selectedCompletion(view.state)?.label).toBe("print");
    press(view, "Enter");
    expect(text(view)).toBe("def f():\n    print\n    ");
    expect(completionStatus(view.state)).toBeNull();
  });

  it("on: an arrow key moves the pick by hand, and then Enter accepts even the word typed in full", async () => {
    const view = open("main.py", "");
    await type(view, "print");
    // Down then Up: back on the top option, but picked by hand.
    expect(press(view, "ArrowDown")).toBe("ArrowDown");
    expect(press(view, "ArrowUp")).toBe("ArrowUp");
    expect(selectedCompletion(view.state)?.label).toBe("print");
    press(view, "Enter");
    expect(text(view)).toBe("print");
    expect(completionStatus(view.state)).toBeNull();
  });

  it("on: a pick moved by hand is forgotten when the list closes, and when the list's options change under it", async () => {
    const view = open("main.py", "");
    await type(view, "print");
    press(view, "ArrowDown");
    press(view, "ArrowUp");
    press(view, "Escape");
    expect(completionStatus(view.state)).toBeNull();
    // Typed again: a new list, nothing moved by hand, so the exact word makes a new line again.
    view.dispatch({ changes: { from: 0, to: 5 }, selection: { anchor: 0 } });
    await type(view, "print");
    expect(selectedCompletion(view.state)?.label).toBe("print");
    press(view, "Enter");
    expect(text(view)).toBe("print\n");

    // Up on "pr" picks the last option by hand; typing on rebuilds the list with print on top, so the
    // pick is CodeMirror's again (not by hand), and the exact word makes a new line.
    const again = open("main.py", "");
    await type(again, "pr");
    press(again, "ArrowUp");
    const byHand = selectedCompletion(again.state)!;
    await type(again, "int");
    expect(selectedCompletion(again.state)).not.toBe(byHand);
    expect(selectedCompletion(again.state)?.label).toBe("print");
    press(again, "Enter");
    expect(text(again)).toBe("print\n");
  });

  // Review finding (2026-10-28): the pick moved to property by hand on "pr" came back once typing
  // filtered it out and in again, so "property" typed in full + Enter accepted instead of a new line.
  it("on: a pick moved by hand ends when the text changes, even when the list comes back to that option", async () => {
    const view = open("main.py", "");
    await type(view, "pr");
    press(view, "ArrowDown");
    expect(selectedCompletion(view.state)?.label).toBe("property");
    await type(view, "i"); // property is filtered out; print is picked
    backspace(view);
    await settle(view);
    await type(view, "operty");
    expect(labels(view)).toEqual(["property"]);
    expect(selectedCompletion(view.state)?.label).toBe("property");
    press(view, "Enter");
    expect(text(view)).toBe("property\n");

    // Moved to property by hand, then the rest typed: the word is typed in full, so a new line too.
    const typedOn = open("main.py", "");
    await type(typedOn, "pr");
    press(typedOn, "ArrowDown");
    await type(typedOn, "operty");
    expect(selectedCompletion(typedOn.state)?.label).toBe("property");
    press(typedOn, "Enter");
    expect(text(typedOn)).toBe("property\n");
  });

  it('C and C++: "int main" + Enter inserts the rest of main after the type, never a second type', async () => {
    for (const [path, want] of [["main.c", "int main(void) {\n    \n    return 0;\n}"], ["main.cpp", "int main() {\n    \n}"]]) {
      const view = open(path, "");
      await type(view, "int main");
      expect(selectedCompletion(view.state)?.label, path).toBe("main");
      press(view, "Enter");
      expect(text(view), path).toBe(want);
    }
  });

  it("on: a snippet typed in full is accepted (it inserts more than the word)", async () => {
    const view = open("main.py", "");
    await type(view, "def");
    expect(labels(view)[0]).toBe("def");
    expect(typeof selectedCompletion(view.state)?.apply).toBe("function");
    press(view, "Enter");
    expect(text(view)).toBe("def name(params):\n    ");
  });

  it("off: nothing is picked until an arrow key; Enter makes a new line, after Down it accepts", async () => {
    const view = open("main.py", "", { enterAcceptsTop: false });
    await type(view, "pri");
    expect(completionStatus(view.state)).toBe("active");
    expect(selectedCompletion(view.state)).toBeNull();
    press(view, "Enter");
    expect(text(view)).toBe("pri\n");

    const exact = open("main.py", "", { enterAcceptsTop: false });
    await type(exact, "print");
    press(exact, "Enter");
    expect(text(exact)).toBe("print\n");

    const down = open("main.py", "", { enterAcceptsTop: false });
    await type(down, "pri");
    press(down, "ArrowDown");
    expect(selectedCompletion(down.state)?.label).toBe("print");
    press(down, "Enter");
    expect(text(down)).toBe("print");

    // Off, Down on the word typed in full: picked by hand, so Enter accepts (as before 2026-10-28).
    const downExact = open("main.py", "", { enterAcceptsTop: false });
    await type(downExact, "print");
    press(downExact, "ArrowDown");
    press(downExact, "Enter");
    expect(text(downExact)).toBe("print");
  });

  it("flips both settings on a live state, all four ways, without a config merge conflict", async () => {
    const view = open("main.py", "");
    for (const [suggestOnTyping, enterAcceptsTop] of [[true, false], [false, false], [false, true], [true, true], [true, false], [true, true]]) {
      view.dispatch({ effects: prefsConf.reconfigure(prefsOf({ suggestOnTyping, enterAcceptsTop })) });
      view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
      await type(view, "pri");
      if (!suggestOnTyping) {
        expect(completionStatus(view.state), `${suggestOnTyping} ${enterAcceptsTop}`).toBeNull();
        continue;
      }
      expect(completionStatus(view.state)).toBe("active");
      expect(selectedCompletion(view.state)?.label ?? null, `${suggestOnTyping} ${enterAcceptsTop}`).toBe(enterAcceptsTop ? "print" : null);
      press(view, "Escape");
    }
    // The same prefs give the same extension value (compartments compare by identity).
    expect(prefsOf()).toEqual(prefsOf());
    expect((prefsOf() as Extension[])[1]).toBe((prefsOf() as Extension[])[1]);
  });

  it("a read-only file: Enter accepts nothing and changes nothing", async () => {
    const view = open("main.py", "");
    await type(view, "pri");
    expect(selectedCompletion(view.state)?.label).toBe("print");
    view.dispatch({ effects: readOnlyConf.reconfigure(READ_ONLY) });
    await settle(view);
    press(view, "Enter");
    expect(text(view)).toBe("pri");
  });

  it("runs before completionKeymap's Enter, beside ESCAPE_KEY, at the highest precedence", () => {
    const maps = EditorState.create({ extensions: [BASE, prefsConf.of(prefsOf())] }).facet(keymap);
    const at = (pick: (b: (typeof maps)[number][number]) => boolean) => maps.findIndex((list) => list.some(pick));
    const mine = at((b) => b === ENTER_KEY);
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(mine).toBe(at((b) => b === ESCAPE_KEY));
    const accept = at((b) => b.key === "Enter" && b.run === acceptCompletion);
    expect(accept).toBeGreaterThanOrEqual(0);
    expect(mine).toBeLessThan(accept);
  });
});

describe('"n = i" and Enter', () => {
  it("with no name i in the file, the top option is accepted (the cost of the default; Settings turns it off)", async () => {
    const view = open("main.py", "");
    await type(view, "n = i");
    const top = labels(view)[0];
    // id: Python's built-in id(), the first of the names that start with i.
    expect(top).toBe("id");
    expect(labels(view)).not.toContain("i");
    press(view, "Enter");
    expect(text(view)).toBe(`n = ${top}`);
  });

  it("with a name i in the file, i ranks first (an exact match) and Enter makes a new line", async () => {
    for (const doc of ["i = 0\n", "for i in range(3):\n    "]) {
      const view = open("main.py", doc);
      await type(view, "n = i");
      expect(labels(view)[0], doc).toBe("i");
      press(view, "Enter");
      expect(text(view), doc).toBe(`${doc}n = i\n${doc.endsWith("    ") ? "    " : ""}`);
    }
  });
});

describe("the word being typed as an option", () => {
  it("C and C++: the open file's own names leave out the word at the cursor", async () => {
    const view = open("main.c", "int counter;\n\nint main(void) {\n    int coun");
    await type(view, "t");
    expect(labels(view)).toContain("counter");
    expect(labels(view)).not.toContain("count");
  });

  // lang-python 6.2.1's localCompletionSource offers the name a def, class or for statement defines,
  // the one at the cursor included, whenever a query runs there (typed on, the list refilters that
  // query's options instead). That option is the word itself, an exact match on top, so Enter
  // after it makes a new line (enterKeepsWord) rather than accepting anything else.
  it.each([["def are"], ["class Fo"], ["for it"]])("Python: %s, when a query runs at the name being defined, offers it on top; Enter makes a new line", async (typed) => {
    const view = open("main.py", "");
    view.dispatch({ changes: { from: 0, insert: typed.slice(0, -1) }, selection: { anchor: typed.length - 1 } });
    await type(view, typed.slice(-1));
    const name = typed.split(" ")[1];
    expect(labels(view)[0]).toBe(name);
    expect(selectedCompletion(view.state)?.label).toBe(name);
    press(view, "Enter");
    expect(text(view)).toBe(`${typed}\n`);
  });
});
