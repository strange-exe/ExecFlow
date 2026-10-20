import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, foldable, getIndentation, indentUnit, language } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import { C_KEYWORDS, CPP_KEYWORDS, PYTHON_GLOBALS, PYTHON_KEYWORDS } from "./keyword-completion";
import { languageForPath, languageSupport } from "./language-support";
import { loadLibrary } from "./library-data";

// With the completion code and the library data loaded, as in the app once a file has been shown:
// the header names on #include lines and the library functions are there too
// (library-completion.test.ts tests them; completion-loader.test.ts the time before they load).
beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
  expect(await loadLibrary("c")).toBe(true);
  expect(await loadLibrary("python")).toBe(true);
});

function stateFor(path: string, doc: string, extra: Extension = []): EditorState {
  const state = EditorState.create({ doc, extensions: [fileConf.of(fileExtensions(path)), extra] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Everything every completion source offers at `pos` (explicit completion, as Ctrl-Space asks). */
async function optionsAt(state: EditorState, pos: number): Promise<Completion[]> {
  const sources = state.languageDataAt<CompletionSource>("autocomplete", pos);
  const results = await Promise.all(sources.map((source) => source(new CompletionContext(state, pos, true))));
  return results.filter((r): r is CompletionResult => r != null).flatMap((r) => r.options);
}

async function labelsAt(state: EditorState, pos: number): Promise<string[]> {
  return (await optionsAt(state, pos)).map((o) => o.label);
}

/** Labels offered at the end of `marker` in `code`, the cursor right after what was typed. */
async function labelsAfter(path: string, code: string, marker: string): Promise<string[]> {
  const at = code.indexOf(marker);
  if (at < 0) throw new Error(`${marker} isn't in the sample`);
  return labelsAt(stateFor(path, code), at + marker.length);
}

/** Applies a completion the way the list does, on a stand-in for the view (state and dispatch). */
function accept(state: EditorState, option: Completion, from: number, to: number): EditorState {
  if (typeof option.apply !== "function") throw new Error(`${option.label} isn't a snippet`);
  const editor = { state, dispatch: (tr: Transaction) => void (editor.state = tr.state) };
  option.apply(editor as unknown as EditorView, option, from, to);
  return editor.state;
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

  it("offers nothing inside comments, strings and character literals, and only header names in include paths", async () => {
    const code = '// wh\n/* wh */\nchar *s = "wh";\nchar c = \'w\';\n#include <wh>\n';
    const state = stateFor("main.c", code);
    for (const at of [code.indexOf("wh") + 2, code.indexOf("wh */") + 2, code.indexOf('wh"') + 2, code.indexOf("w'") + 1]) {
      expect(await labelsAt(state, at), `at ${at}`).toEqual([]);
    }
    const inPath = await labelsAt(state, code.indexOf("wh>") + 2);
    expect(inPath).toContain("wchar.h");
    expect(inPath.every((l) => /\.h$/.test(l)), inPath.join(" ")).toBe(true);
  });

  it("has no duplicate keywords", () => {
    expect(new Set(C_KEYWORDS).size).toBe(C_KEYWORDS.length);
    expect(new Set(CPP_KEYWORDS).size).toBe(CPP_KEYWORDS.length);
    expect(new Set(PYTHON_KEYWORDS).size).toBe(PYTHON_KEYWORDS.length);
  });

  it("offers nothing in a read-only file: its sources go with the lock", async () => {
    for (const [path, doc] of [["main.py", "pr"], ["main.c", "int main(void) { wh }"], ["main.cpp", "int main() { wh }"]]) {
      const pos = doc.indexOf(doc.includes("wh") ? "wh" : "pr") + 2;
      expect(await labelsAt(stateFor(path, doc), pos), path).not.toEqual([]);
      const locked = stateFor(path, doc, EditorState.readOnly.of(true));
      expect(locked.languageDataAt("autocomplete", pos), path).toEqual([]);
      expect(await labelsAt(locked, pos), path).toEqual([]);
    }
  });
});

describe("Python completion", () => {
  it("offers the keywords lang-python 6.2.1 leaves out, besides its builtins and snippets", async () => {
    const labels = await labelsAfter("main.py", "def f(x):\n    ret", "ret");
    const missing = ["return", "elif", "else", "pass", "break", "continue", "lambda", "with", "yield", "raise", "except", "finally",
      "global", "nonlocal", "assert", "del", "in", "is", "not", "and", "or", "async", "await", "match", "case"];
    for (const word of missing) {
      const option = PYTHON_GLOBALS.find((o) => o.label === word);
      expect(option?.type, word).toBe("keyword");
      expect(option?.apply, `${word} is a plain keyword, not a snippet`).toBeUndefined();
    }
    expect(labels).toEqual(expect.arrayContaining([...missing, "print", "len", "range", "ValueError", "None", "def", "class"]));
  });

  it("keeps the local names: functions, parameters and assignments in scope", async () => {
    const labels = await labelsAfter("main.py", "total = 0\ndef add(amount):\n    am\n", "    am");
    expect(labels).toEqual(expect.arrayContaining(["total", "add", "amount"]));
  });

  it("offers nothing inside strings, f-strings, comments and after a dot (lang-python's skip list)", async () => {
    const code = 'name = "re"\nmsg = f"re"\n# re\nname.re\n';
    for (const marker of ['"re', 'f"re', "# re", ".re"]) {
      expect(await labelsAfter("main.py", code, marker), marker).toEqual([]);
    }
  });

  it("indents the class snippet's __init__ body one level deeper than the def (8 spaces, not 12)", async () => {
    const state = stateFor("main.py", "cla", indentUnit.of("    "));
    const option = (await optionsAt(state, 3)).find((o) => o.label === "class");
    expect(option).toBeDefined();
    const after = accept(state, option!, 0, 3);
    expect(after.doc.toString()).toBe("class name:\n    def __init__(self, params):\n        ");
  });

  it("is still lang-python's language: indentation and folding work as python() set them up", () => {
    const state = stateFor("main.py", "def f():\n    if x:\n        pass\n", indentUnit.of("    "));
    expect(state.facet(language)?.name).toBe("python");
    expect(getIndentation(state, state.doc.line(3).from)).toBe(8);
    expect(foldable(state, 0, state.doc.line(1).to)).toMatchObject({ from: state.doc.line(1).to });
  });
});

describe("C and C++ keywords in the right places only", () => {
  // Measured noise (research doc 1.3): these offered float/long, void/volatile, default/typedef, struct...
  it.each([
    ["main.c", "int f(struct P p) {\n  return p.lo;\n}", "p.lo"],
    ["main.c", "int f(struct P *q) {\n  return q->lo;\n}", "q->lo"],
    ["main.c", "int f(struct P p) {\n  p.\n}", "p."],
    ["main.c", "int f(struct P *q) {\n  q->\n}", "q->"],
    ["main.cpp", "int main() {\n  std::vector<int>::it\n}", "::it"],
    ["main.cpp", "int main() {\n  std::vector<int> v;\n}", "  std"],
    ["main.c", "#def", "#def"],
    ["main.c", "#define SIZE 10\n", "#define SIZE 10"],
    ["main.c", "#define MAX(a, b) ((a) > (b) ? (a) : (b))", "(b) ? (a"],
    ["main.c", "#define LOOP \\\n  wh", "  wh"],
    ["main.c", "#if defined(wh)\n#endif\n", "(wh"],
    ["main.c", "  #pragma on", "#pragma on"],
  ])("%s: nothing after %j", async (path, code, marker) => {
    expect(await labelsAfter(path, code, marker)).toEqual([]);
  });

  // Header names on an unfinished #include, std names after std::: library-completion.ts's lists
  // only (header names are "namespace" options; std names say where they are declared).
  it.each([
    ["main.c", "#include <st", "#include <st", "stdio.h"],
    ["main.c", "#include <st\nint main(void) {}\n", "#include <st", "stdio.h"],
    ["main.c", "#include <", "#include <", "stdio.h"],
    ["main.cpp", "#include <st", "#include <st", "string"],
    ["main.cpp", "int main() {\n  std::vo\n}", "std::vo", "vector"],
    ["main.cpp", "int main() {\n  std::\n}", "std::", "vector"],
    ["main.cpp", "std::st name;", "std::st", "string"],
  ])("%s: library names and no keywords after %j", async (path, code, marker, name) => {
    const options = await optionsAt(stateFor(path, code), code.indexOf(marker) + marker.length);
    expect(options.map((o) => o.label)).toContain(name);
    const fromLibrary = (o: Completion) => (marker.includes("#include") ? o.type === "namespace" : /^Declared in </.test(String(o.info)));
    expect(options.filter((o) => !fromLibrary(o)).map((o) => `${o.label} (${o.type})`)).toEqual([]);
  });

  it.each([
    ["main.c", "int main(void) {\n  wh\n}", "wh", "while"],
    ["main.c", "struct S { unsigned lo };", "unsigned lo", "long"],
    ["main.c", "int f(struct P p) {\n  return p.x + si;\n}", "+ si", "sizeof"],
    ["main.c", "#include <stdio.h>\nin", "\nin", "int"],
    ["main.c", "#define N 3\nint main(void) {\n  re\n}", "  re", "return"],
    ["main.cpp", "int main() {\n  std::vector<in> v;\n}", "<in", "int"],
    ["main.cpp", "int main() {\n  std::map<int, dou> m;\n}", ", dou", "double"],
    ["main.cpp", "int main() {\n  std::cout << th;\n}", "<< th", "this"],
    ["main.cpp", "int main() {\n  obj.call(nu);\n}", "(nu", "nullptr"],
    // Typed at the very end of the file, these parse as a NamespaceIdentifier with no `::` after it.
    ["main.cpp", "class Animal {};\nclass Dog : pu", ": pu", "public"],
    ["main.cpp", "class Dog : public Animal, pr", ", pr", "private"],
    ["main.cpp", "template <ty", "<ty", "typename"],
    ["main.c", "typedef st", "typedef st", "struct"],
  ])("%s: still offers keywords after %j", async (path, code, marker, word) => {
    expect(await labelsAfter(path, code, marker)).toContain(word);
  });

  it("offers keywords at the start of the line after a directive, which ends with its newline", async () => {
    const code = "#include <stdio.h>\n\nint x;";
    expect(await labelsAt(stateFor("main.c", code), code.indexOf("\n") + 1)).toContain("int");
  });
});

describe("keyword lists for our clang 8.0.1", () => {
  it("leaves out the C++20 words clang 8 rejects or doesn't support with our options", () => {
    for (const word of ["consteval", "constinit", "co_await", "co_return", "co_yield", "concept", "requires", "char8_t"]) {
      expect(CPP_KEYWORDS, word).not.toContain(word);
    }
    expect(CPP_KEYWORDS).toEqual(expect.arrayContaining(["constexpr", "nullptr", "static_assert", "decltype", "noexcept", "char16_t"]));
  });

  it("says that C's bool, true and false need <stdbool.h>, and C++'s don't", async () => {
    const code = "int main() {\n  b\n}";
    const detail = async (path: string) =>
      Object.fromEntries((await optionsAt(stateFor(path, code), code.indexOf(" b") + 2)).map((o) => [o.label, o.detail]));
    const c = await detail("main.c");
    for (const word of ["bool", "true", "false"]) expect(c[word], word).toBe("needs <stdbool.h>");
    expect(c.int).toBeUndefined();
    const cxx = await detail("main.cpp");
    for (const word of ["bool", "true", "false"]) expect(cxx[word], word).toBeUndefined();
  });
});
