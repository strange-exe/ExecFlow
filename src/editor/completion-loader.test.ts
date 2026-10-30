// The time before the completion chunk (completion-code.ts) has arrived: every library and own-name
// source in a file's language data is a stand-in (completion-loader.ts lazySource). A query then
// offers only the keywords and snippets (keyword-completion.ts, with the language chunks) and starts the
// load; where a stand-in's source would offer names it runs again once the code is there, and the
// sources answer from then on. A failed load (offline before the chunk was ever cached) is quiet
// and is tried again later. This file's fresh module has not loaded the code.
// The view is a stand-in, as in late-data.test.ts: a state with autocompletion, focus and dispatch.
import { autocompletion, CompletionContext, completionStatus, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CODE_RETRY_MS, completionCode, loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import "./test-languages";

const tick = () => new Promise((done) => setTimeout(done, 0));

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await tick();
  expect(check(), what).toBe(true);
}

function setup(path: string, doc: string) {
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [autocompletion(), fileConf.of(fileExtensions(path))] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = {
    state,
    hasFocus: true,
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
    setTabFocusMode() {},
  };
  return { view, asView: view as unknown as EditorView };
}

/** Every source in the file's language data at the cursor, as typing (or Ctrl-Space) asks. */
async function ask(view: { state: EditorState }, asView: EditorView, explicit = false): Promise<(CompletionResult | null)[]> {
  const pos = view.state.selection.main.head;
  const sources = view.state.languageDataAt<CompletionSource>("autocomplete", pos);
  expect(sources.length, "the file has sources").toBeGreaterThan(0);
  return Promise.all(sources.map((source) => source(new CompletionContext(view.state, pos, explicit, asView))));
}

const labels = (results: (CompletionResult | null)[]) => results.flatMap((r) => (r ? r.options.map((o) => o.label) : []));

afterAll(() => {
  vi.doUnmock("./completion-code");
});

describe("before the completion code has arrived", () => {
  it("a failed load answers false, quietly, and is tried again only after CODE_RETRY_MS", async () => {
    vi.doMock("./completion-code", () => {
      throw new Error("offline before the chunk was ever cached");
    });
    let now = 1_000_000;
    expect(await loadCompletionCode(() => now)).toBe(false);
    expect(completionCode()).toBeNull();
    now += CODE_RETRY_MS - 1;
    expect(await loadCompletionCode(() => now)).toBe(false);
    vi.doUnmock("./completion-code");
    expect(await loadCompletionCode(() => now), "still inside the retry window").toBe(false);
    expect(completionCode()).toBeNull();
    now += 1;
    expect(await loadCompletionCode(() => now), "tried again after the window").toBe(true);
    expect(completionCode()).not.toBeNull();
  });
});

describe("the first query, before the code is there", () => {
  // vi.resetModules gives this describe a module graph where the code has not loaded yet.
  it("offers only keywords and snippets, runs again once the code arrives where it would offer names, and then offers your own names too", async () => {
    vi.resetModules();
    const loader = await import("./completion-loader");
    const extensions = await import("./extensions");
    // The fresh graph's language chunks, which use this graph's loader.
    const languages = await import("./language-support");
    await Promise.all([languages.loadLanguage("c"), languages.loadLanguage("python")]);
    expect(loader.completionCode()).toBeNull();
    const make = (path: string, doc: string) => {
      const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [autocompletion(), extensions.fileConf.of(extensions.fileExtensions(path))] });
      ensureSyntaxTree(state, state.doc.length, 5000);
      const view = {
        state,
        hasFocus: true,
        dispatch(spec: TransactionSpec) {
          view.state = view.state.update(spec).state;
        },
        setTabFocusMode() {},
      };
      return { view, asView: view as unknown as EditorView };
    };
    // A word typed: the keyword and name sources would offer names, so the query runs again.
    const typed = make("main.c", "int total;\nint main(void) {\n    ret");
    // After `= ` nothing is typed and the list wasn't asked for: no source offers anything there.
    const between = make("main.c", "int main(void) {\n    int x = ");
    // `#include <`: the header source would offer names.
    const include = make("main.c", "#include <");
    const python = make("main.py", "import math\nmath.");
    // The keywords and snippets are the language chunks': offered at once, and nothing else is.
    const first = (await ask(typed.view, typed.asView)).flatMap((r) => r?.options ?? []);
    expect(first.map((o) => o.label), "keywords before the code").toContain("return");
    expect(first.filter((o) => o.type === "function" || o.type === "variable").map((o) => o.label), "no own or library name before the code").toEqual([]);
    for (const v of [between, include, python]) expect(labels(await ask(v.view, v.asView)), "nothing before the code").toEqual([]);
    expect(completionStatus(typed.view.state)).toBeNull();
    await until(() => loader.completionCode() !== null, "the code loads (the first query started it)");
    await until(() => completionStatus(typed.view.state) === "pending", "a typed word's query runs again");
    await until(() => completionStatus(include.view.state) === "pending", "#include <'s query runs again");
    await until(() => completionStatus(python.view.state) === "pending", "math.'s query runs again");
    for (let i = 0; i < 5; i++) await tick();
    expect(completionStatus(between.view.state), "no query runs again where none would offer names").toBeNull();
    // From now on the sources answer at once: the file's own total is there with the keywords.
    const then = (await ask(typed.view, typed.asView)).flatMap((r) => r?.options ?? []);
    expect(then.map((o) => o.label)).toContain("return");
    expect(then.some((o) => o.label === "total" && o.type === "variable"), "the file's own total").toBe(true);
  });
});

describe("after the code has arrived", () => {
  it("the stand-ins are the real sources: the same keywords at once, with validFor", async () => {
    expect(await loadCompletionCode()).toBe(true);
    const { view, asView } = setup("main.py", "pri");
    const results = await ask(view, asView);
    expect(labels(results)).toContain("print");
    expect(results.find((r) => r?.options.some((o) => o.label === "print"))?.validFor).toBeInstanceOf(RegExp);
  });
});
