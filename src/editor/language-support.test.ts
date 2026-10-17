import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fileConf, fileExtensions } from "./extensions";
import { C_KEYWORDS, CPP_KEYWORDS, languageForPath, languageSupport } from "./language-support";

function stateFor(path: string, doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [fileConf.of(fileExtensions(path))] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Labels every completion source offers at `pos` (explicit completion, as Ctrl-Space asks). */
async function labelsAt(state: EditorState, pos: number): Promise<string[]> {
  const sources = state.languageDataAt<CompletionSource>("autocomplete", pos);
  const results = await Promise.all(sources.map((source) => source(new CompletionContext(state, pos, true))));
  return results.filter((r): r is CompletionResult => r != null).flatMap((r) => r.options.map((o) => o.label));
}

describe("languageForPath", () => {
  it.each([
    ["main.py", "python"],
    ["lab/main.c", "c"],
    ["lab/v1.2/main.cpp", "cpp"],
    ["include/util.h", "cpp"],
    ["shapes.hpp", "cpp"],
    ["notes.txt", null],
    ["Makefile", null],
  ])("%s is edited as %s", (path, id) => {
    expect(languageForPath(path)).toBe(id);
  });
});

describe("languageSupport", () => {
  it("gives Python files the Python grammar and C, C++ and headers the C++ grammar", () => {
    expect(stateFor("a.py", "x = 1").facet(language)?.name).toBe("python");
    expect(stateFor("a.c", "int x;").facet(language)?.name).toBe("cpp");
    expect(stateFor("a.h", "int x;").facet(language)?.name).toBe("cpp");
    expect(stateFor("a.txt", "plain").facet(language)).toBeNull();
  });

  it("shares one instance per language", () => {
    expect(languageSupport("c")).toBe(languageSupport("c"));
    expect(languageSupport(null)).toEqual([]);
  });

  it("offers C keywords in C files and C++ keywords in C++ files", async () => {
    const c = stateFor("main.c", "int main(void) {\n  \n}");
    const cLabels = await labelsAt(c, 19);
    expect(cLabels).toEqual(expect.arrayContaining(["int", "while", "return", "NULL"]));
    expect(cLabels).not.toContain("class");

    const cxx = stateFor("main.cpp", "int main() {\n  \n}");
    expect(await labelsAt(cxx, 15)).toEqual(expect.arrayContaining(["class", "nullptr", "namespace", "int"]));
  });

  it("offers nothing inside comments, strings, character literals and include paths", async () => {
    const code = '// wh\n/* wh */\nchar *s = "wh";\nchar c = \'w\';\n#include <wh>\n';
    const state = stateFor("main.c", code);
    for (const at of [code.indexOf("wh") + 2, code.indexOf("wh */") + 2, code.indexOf('wh"') + 2, code.indexOf("w'") + 1, code.indexOf("wh>") + 2]) {
      expect(await labelsAt(state, at), `at ${at}`).toEqual([]);
    }
  });

  it("keeps Python's own completion (keywords and builtins)", async () => {
    const state = stateFor("main.py", "pr");
    expect(await labelsAt(state, 2)).toEqual(expect.arrayContaining(["print", "while"]));
  });

  it("has no duplicate keywords", () => {
    expect(new Set(C_KEYWORDS).size).toBe(C_KEYWORDS.length);
    expect(new Set(CPP_KEYWORDS).size).toBe(CPP_KEYWORDS.length);
  });
});
