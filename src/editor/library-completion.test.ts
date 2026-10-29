// The library suggestions (library-completion.ts) at the places a student types them: module names
// and members in Python, header names, library functions, std:: names and snippets in C and C++.
// Options are read straight from every source the file has at the position (Ctrl-Space or typing),
// before CodeMirror's matcher filters them.
import { CompletionContext, type Completion, type CompletionResult, type CompletionSection, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, indentUnit } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import { libraryContext, type LibraryContext } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import { C_SNIPPETS, CPP_SNIPPETS, pythonImportContext } from "./keyword-completion";
import { pythonImports, workspaceHeaders, workspaceModules } from "./library-completion";
import { library, libraryStatus, loadLibrary } from "./library-data";

// The completion code (completion-code.ts) as the app has it once a file has been shown; loading
// it doesn't load the library data, which the first describe below checks the absence of.
beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
});

interface Setup {
  files?: readonly string[];
  c?: string;
  cpp?: string;
  readOnly?: boolean;
  extra?: Extension;
}

function stateFor(path: string, doc: string, setup: Setup = {}): EditorState {
  const context: LibraryContext = { files: () => setup.files ?? [], standards: () => ({ c: setup.c ?? "gnu11", cpp: setup.cpp ?? "c++17" }) };
  const state = EditorState.create({
    doc,
    extensions: [fileConf.of(fileExtensions(path)), libraryContext.of(context), setup.readOnly ? EditorState.readOnly.of(true) : [], setup.extra ?? []],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/**
 * The answers that offer something (a source with nothing to offer at `pos` answers null).
 */
async function results(state: EditorState, pos: number, explicit = true): Promise<CompletionResult[]> {
  const sources = state.languageDataAt<CompletionSource>("autocomplete", pos);
  const all = await Promise.all(sources.map((source) => source(new CompletionContext(state, pos, explicit))));
  return all.filter((r): r is CompletionResult => r != null && r.options.length > 0);
}

/** Every option at the end of `marker` (the cursor right after what was typed). */
async function optionsAfter(path: string, code: string, marker: string, setup: Setup = {}, explicit = true): Promise<Completion[]> {
  const at = code.indexOf(marker);
  if (at < 0) throw new Error(`${marker} isn't in the sample`);
  return (await results(stateFor(path, code, setup), at + marker.length, explicit)).flatMap((r) => r.options);
}

async function labelsAfter(path: string, code: string, marker: string, setup: Setup = {}): Promise<string[]> {
  return (await optionsAfter(path, code, marker, setup)).map((o) => o.label);
}

const one = (options: Completion[], label: string, detail?: string) => {
  const found = options.filter((o) => o.label === label && (detail === undefined || o.detail === detail));
  expect(found, `${label}${detail ? ` (${detail})` : ""} offered once`).toHaveLength(1);
  return found[0];
};

const sectionName = (o: Completion) => (typeof o.section === "object" ? (o.section as CompletionSection).name : o.section);

/** Applies a snippet the way the list does, on a stand-in for the view. */
function accept(state: EditorState, option: Completion, from: number, to: number): EditorState {
  if (typeof option.apply !== "function") throw new Error(`${option.label} isn't a snippet`);
  const editor = { state, dispatch: (tr: Transaction) => void (editor.state = tr.state) };
  option.apply(editor as unknown as EditorView, option, from, to);
  return editor.state;
}

/** Labels from every source, called synchronously (no await, so no data can arrive meanwhile). */
function labelsNow(path: string, code: string, setup: Setup = {}): string[] {
  const state = stateFor(path, code, setup);
  return state.languageDataAt<CompletionSource>("autocomplete", code.length).flatMap((source) => {
    const result = source(new CompletionContext(state, code.length, true));
    if (result instanceof Promise) throw new Error("a library source answered asynchronously");
    return result ? result.options.map((o) => o.label) : [];
  });
}

// Runs first: in a fresh module nothing has loaded the data yet.
describe("before the library data has loaded", () => {
  it("offers what it offered without it, with no error, and the first request starts the load", async () => {
    expect(libraryStatus("python")).toBe("idle");
    expect(library("python")).toBeNull();
    // Your own modules are there without the data; the standard ones and members aren't yet.
    expect(labelsNow("main.py", "import he", { files: ["main.py", "helpers.py"] })).toEqual(["helpers"]);
    expect(labelsNow("main.py", "import math\nmath.sq")).toEqual([]);
    expect(libraryStatus("python")).toBe("loading");

    expect(libraryStatus("c")).toBe("idle");
    const c = labelsNow("main.c", "int main(void) {\n  pri");
    expect(c).toContain("int");
    expect(c.filter((l) => l === "printf")).toHaveLength(1); // the snippet, not yet the function
    expect(labelsNow("main.c", "#include <st")).toEqual([]);
    expect(labelsNow("main.cpp", "std::vec")).toEqual([]);
    expect(libraryStatus("c")).toBe("loading");

    expect(await loadLibrary("c")).toBe(true);
    expect(await loadLibrary("python")).toBe(true);
    expect(labelsNow("main.c", "#include <st")).toContain("stdio.h");
    expect(labelsNow("main.py", "import math\nmath.sq")).toContain("sqrt");
  });
});

describe("Python modules and members", () => {
  beforeAll(async () => {
    expect(await loadLibrary("python")).toBe(true);
  });

  it("`import ma` offers math and the other standard modules, and no builtins", async () => {
    const labels = await labelsAfter("main.py", "import ma", "import ma");
    expect(labels).toEqual(expect.arrayContaining(["math", "marshal", "random", "collections"]));
    expect(labels).not.toContain("map");
    expect(labels).not.toContain("max");
    // The modules a browser can't run are not offered.
    for (const absent of ["tkinter", "turtle", "subprocess", "socket", "threading"]) expect(labels, absent).not.toContain(absent);
    expect(one(await optionsAfter("main.py", "import ma", "import ma"), "math")).toMatchObject({ type: "namespace", info: "Python standard library module" });
  });

  it("offers modules after `from`, in a list after `import a, `, and a module's submodules after a dot", async () => {
    expect(await labelsAfter("main.py", "from ra", "from ra")).toContain("random");
    expect(await labelsAfter("main.py", "import sys, ma", "ma")).toContain("math");
    expect(await labelsAfter("main.py", "import os as o, ma", "ma")).toContain("math");
    expect(await labelsAfter("main.py", "import os.pa", "os.pa")).toEqual(["path"]);
  });

  it("`from math import fl` offers floor with its signature, and no builtins", async () => {
    const options = await optionsAfter("main.py", "from math import fl", "fl");
    expect(one(options, "floor")).toMatchObject({ type: "function", detail: "(x, /)", info: "Function in math" });
    expect(one(options, "pi")).toMatchObject({ type: "constant" });
    expect(options.map((o) => o.label)).not.toContain("float");
    // Later names in the list, and inside parentheses.
    expect(await labelsAfter("main.py", "from math import floor, sq", "sq")).toContain("sqrt");
    expect(await labelsAfter("main.py", "from math import (floor, sq", "sq")).toContain("sqrt");
    expect(await labelsAfter("main.py", "from os import pa", "pa")).toContain("path");
  });

  it("`math.sq` offers sqrt with its signature, for each way of importing", async () => {
    const options = await optionsAfter("main.py", "import math\nx = math.sq", "math.sq");
    expect(one(options, "sqrt")).toMatchObject({ type: "function", detail: "(x, /)" });
    expect(options.map((o) => o.label)).not.toContain("print");
    expect(await labelsAfter("main.py", "import math as m\nm.sq", "m.sq")).toContain("sqrt");
    expect(await labelsAfter("main.py", "def f():\n    import math\n    return math.fl", "math.fl")).toContain("floor");
    expect(await labelsAfter("main.py", "from os import path\npath.jo", "path.jo")).toContain("join");
    expect(await labelsAfter("main.py", "import os.path as p\np.jo", "p.jo")).toContain("join");
    expect(await labelsAfter("main.py", "import os.path\nos.path.jo", "os.path.jo")).toContain("join");
    // os itself has no member list (cut for size), but its submodule path is known.
    expect(await labelsAfter("main.py", "import os\nos.", "os.")).toEqual(["path"]);
    expect(await labelsAfter("main.py", "import random\nrandom.ra", "random.ra")).toContain("randint");
  });

  it("offers no members for a name the file didn't import, or one it imported from elsewhere", async () => {
    expect(await labelsAfter("main.py", "math.sq", "math.sq")).toEqual([]);
    expect(await labelsAfter("main.py", "from math import sqrt\nsqrt.x", "sqrt.x")).toEqual([]);
    expect(await labelsAfter("main.py", "from . import math\nmath.sq", "math.sq")).toEqual([]);
    expect(await labelsAfter("main.py", "import constructor\nconstructor.x", "constructor.x")).toEqual([]);
  });

  it("offers nothing inside strings, f-strings and comments", async () => {
    const code = 's = "import ma"\nimport math\nt = f"{x} math.sq"\n# math.sq\nu = """\nimport ma\n"""\n';
    const state = stateFor("main.py", code);
    for (const marker of ['"import ma', "} math.sq", "# math.sq", "\nimport ma\n"]) {
      const at = code.indexOf(marker) + marker.trimEnd().length;
      expect((await results(state, at)).flatMap((r) => r.options.map((o) => o.label)), marker).toEqual([]);
    }
  });

  it("offers nothing while an alias or a relative import is typed", async () => {
    expect(await labelsAfter("main.py", "import math as ma", "as ma")).toEqual([]);
    expect(await labelsAfter("main.py", "from math import floor as fl", "as fl")).toEqual([]);
    expect(await labelsAfter("main.py", "from .ma", ".ma")).toEqual([]);
    expect(await labelsAfter("main.py", "from . import ma", "import ma")).toEqual([]);
  });

  it("keeps plain names, builtins and keywords outside imports and after no dot", async () => {
    const labels = await labelsAfter("main.py", "import math\ntotal = 0\nto", "\nto");
    expect(labels).toEqual(expect.arrayContaining(["total", "print", "return", "math"]));
  });

  it("returns validFor, so typing more of the word refilters without a new query", async () => {
    const state = stateFor("main.py", "import math\nmath.sq");
    const [member] = await results(state, state.doc.length);
    expect(member.validFor).toBeInstanceOf(RegExp);
    expect((member.validFor as RegExp).test("sqr")).toBe(true);
    expect((member.validFor as RegExp).test("sq.")).toBe(false);
  });

  it("a read-only file offers no modules or members", async () => {
    expect(await labelsAfter("main.py", "import ma", "import ma", { readOnly: true })).toEqual([]);
    expect(await labelsAfter("main.py", "import math\nmath.sq", "math.sq", { readOnly: true })).toEqual([]);
  });
});

describe("the workspace's own Python modules", () => {
  const files = [
    "main.py", "helpers.py", "notes.txt", "pkg/__init__.py", "pkg/util.py", "pkg/deep/more.py", "data/readme.md",
    "random.py", "helpers.conflict-20261018-101500.py", "lab/main.py", "lab/tools.py", "my-file.py", ".hidden/x.py",
  ];

  it("are the .py files and package folders beside the file run, as the run's sys.path finds them", () => {
    const top = workspaceModules(files, "main.py").map((m) => `${m.name}${m.folder ? "/" : ""}`).sort();
    // Not: itself, a conflict copy, a folder without .py files, a name Python can't import.
    expect(top).toEqual(["helpers", "lab/", "pkg/", "random"]);
    expect(workspaceModules(files, "lab/main.py").map((m) => m.name)).toEqual(["tools"]);
    expect(workspaceModules(files, "main.py", ["pkg"]).map((m) => m.name).sort()).toEqual(["deep", "util"]);
  });

  it("are offered after import (before the standard ones of the same name), with their file", async () => {
    const options = await optionsAfter("main.py", "import he", "import he", { files });
    expect(one(options, "helpers")).toMatchObject({ type: "namespace", detail: "helpers.py", info: "Your file helpers.py" });
    expect(one(options, "pkg")).toMatchObject({ detail: "pkg/", info: "Your folder pkg/" });
    // random.py beside the file: one "random", the workspace's.
    expect(one(options, "random").detail).toBe("random.py");
    expect(await labelsAfter("main.py", "import pkg.", "pkg.", { files })).toEqual(expect.arrayContaining(["util", "deep"]));
    expect(await labelsAfter("main.py", "from pkg import ", "import ", { files })).toEqual(expect.arrayContaining(["util", "deep"]));
  });

  it("hide the standard members of the module they shadow (the run would load the workspace file)", async () => {
    expect(await labelsAfter("main.py", "import random\nrandom.ra", "random.ra", { files })).toEqual([]);
    expect(await labelsAfter("main.py", "from random import ra", "import ra", { files })).toEqual([]);
  });
});

describe("pythonImports and pythonImportContext", () => {
  it("read every name an import binds", () => {
    const state = stateFor("main.py", "import math as m, os.path\nfrom os import path as p, sep\nfrom . import local\nimport json\n");
    expect(Object.fromEntries(pythonImports(state))).toEqual({ m: "math", os: "os", p: "os.path", sep: "os.sep", json: "json" });
  });

  it("tell module, member and alias positions apart", () => {
    const at = (code: string) => pythonImportContext(stateFor("main.py", code), code.length);
    expect(at("import os.pa")).toEqual({ kind: "module", parent: ["os"], from: 10 });
    expect(at("from math import fl")).toEqual({ kind: "member", module: "math", from: 17 });
    expect(at("import math as m")).toEqual({ kind: "none" });
    expect(at("x = math.sq")).toBeNull();
    expect(at("important = 1")).toBeNull();
  });
});

describe("C and C++ headers on #include lines", () => {
  beforeAll(async () => {
    expect(await loadLibrary("c")).toBe(true);
  });

  it("`#include <st` offers C's headers in a C file, and libc++'s then C's in C++", async () => {
    const c = await optionsAfter("main.c", "#include <st", "<st");
    expect(c.map((o) => o.label)).toEqual(expect.arrayContaining(["stdio.h", "stdlib.h", "string.h", "sys/stat.h"]));
    expect(c.map((o) => o.label)).not.toContain("vector");
    expect(one(c, "stdio.h")).toMatchObject({ type: "namespace", apply: "stdio.h>" });
    expect(c.some((o) => o.label === "int"), "no keywords on an include line").toBe(false);

    const cxx = await optionsAfter("main.cpp", "#include <ve", "<ve");
    expect(sectionName(one(cxx, "vector"))).toBe("C++ library");
    expect(sectionName(one(cxx, "stdio.h"))).toBe("C library");
    // Never the ones that don't build with our clang 8 (gen-c-completions.mjs).
    for (const absent of ["filesystem", "thread", "future", "atomic", "regex"]) expect(cxx.map((o) => o.label), absent).not.toContain(absent);
    // A header follows the C++ rule, as its grammar does today.
    expect((await optionsAfter("util.h", "#include <ve", "<ve")).map((o) => o.label)).toContain("vector");
  });

  it("offers a C++17 or C++2a header only from that standard on, as the -std setting says (review F3)", async () => {
    const at = async (cpp: string, typed: string) => (await optionsAfter("main.cpp", `#include <${typed}`, `<${typed}`, { cpp })).map((o) => o.label);
    expect(await at("c++17", "sp")).not.toContain("span");
    expect(await at("c++2a", "sp")).toContain("span");
    expect(await at("c++14", "op")).not.toContain("optional");
    expect(await at("c++17", "op")).toContain("optional");
    expect(await at("c++2a", "bi")).not.toContain("bit");
    // An -std value the data doesn't know counts as the default (c++17).
    expect(await at("gnu++99", "op")).toContain("optional");
    expect(await at("gnu++99", "sp")).not.toContain("span");
  });

  it("offers the app's own bits/stdc++.h in C++ (the C/C++ worker writes it), never in C (review F4)", async () => {
    const cxx = await optionsAfter("main.cpp", "#include <bits/", "<bits/");
    expect(one(cxx, "bits/stdc++.h")).toMatchObject({
      type: "namespace", apply: "bits/stdc++.h>", info: "The whole C++ standard library at once (GCC's name; CodeEditor provides it)",
    });
    expect(sectionName(one(cxx, "bits/stdc++.h"))).toBe("C++ library");
    // The name keeps matching as it is typed, + included.
    const state = stateFor("main.cpp", "#include <bits/stdc+");
    const [list] = await results(state, state.doc.length);
    expect((list.validFor as RegExp).test("bits/stdc++.h")).toBe(true);
    expect((await optionsAfter("util.h", "#include <bi", "<bi")).map((o) => o.label)).toContain("bits/stdc++.h");
    expect((await optionsAfter("main.c", "#include <bi", "<bi")).map((o) => o.label)).not.toContain("bits/stdc++.h");
  });

  it("adds the closing > only when it isn't there, and refilters as the name grows", async () => {
    expect(one(await optionsAfter("main.c", "#include <st>", "<st"), "stdio.h").apply).toBe("stdio.h");
    const state = stateFor("main.c", "#include <st");
    const [result] = await results(state, state.doc.length);
    expect(result.from).toBe("#include <".length);
    expect((result.validFor as RegExp).test("sys/st")).toBe(true);
    expect((result.validFor as RegExp).test("st>")).toBe(false);
  });

  it("`#include \"` offers the workspace headers this file can include, found with the build's rule", async () => {
    const files = ["lab/main.c", "lab/util.h", "lab/inc/shapes.hpp", "common/list.h", "lab/notes.txt", "lab/util.conflict-20261018-101500.h", "lab/other.c"];
    const options = await optionsAfter("lab/main.c", '#include "', '"', { files });
    expect(options.map((o) => o.label)).toEqual(["util.h", "inc/shapes.hpp", "../common/list.h"]);
    expect(one(options, "util.h").apply).toBe('util.h"');
    // closeBrackets typed the closing quote: it isn't added again.
    expect(one(await optionsAfter("lab/main.c", '#include ""', '"', { files }), "util.h").apply).toBe("util.h");
    // A header doesn't offer itself.
    expect((await optionsAfter("lab/util.h", '#include "', '"', { files })).map((o) => o.label)).not.toContain("util.h");
    expect(workspaceHeaders(files, "lab/inc/shapes.hpp").map((h) => h.spelling)).toEqual(["../util.h", "../../common/list.h"]);
  });

  it("offers nothing in a comment, and nothing in a read-only file", async () => {
    expect(await labelsAfter("main.c", "/*\n#include <st", "<st")).toEqual([]);
    expect(await labelsAfter("main.c", "#include <st", "<st", { readOnly: true })).toEqual([]);
    expect(await labelsAfter("main.c", '#include "', '"', { files: ["main.c", "a.h"], readOnly: true })).toEqual([]);
  });

  it("offers the #include line while a directive is started, and nothing for other directives", async () => {
    expect(await labelsAfter("main.c", "#", "#")).toEqual(["#include <stdio.h>"]);
    expect(await labelsAfter("main.c", "#inc", "#inc")).toEqual(["#include <stdio.h>"]);
    expect(await labelsAfter("main.cpp", "  # in", "# in")).toEqual(["#include <iostream>"]);
    expect(await labelsAfter("main.c", "#def", "#def")).toEqual([]);
    expect(await labelsAfter("main.c", "// #inc", "#inc")).toEqual([]);
  });
});

describe("C and C++ library names", () => {
  beforeAll(async () => {
    expect(await loadLibrary("c")).toBe(true);
  });

  it("`pri` in a C file offers printf with its prototype and our own info naming the header, with no section", async () => {
    const options = await optionsAfter("main.c", "int main(void) {\n  pri\n}", "pri");
    const printf = one(options, "printf", "int printf(const char *, ...)");
    expect(printf).toMatchObject({ type: "function", info: "Declared in <stdio.h>" });
    // A section would put every keyword and snippet above every library name (review RB-2).
    expect(options.filter((o) => o.section !== undefined).map((o) => o.label), "no sections in the C word list").toEqual([]);
    expect(one(options, "EOF")).toMatchObject({ type: "constant", detail: "(-1)", info: "Defined in <stdio.h>" });
    // Never a function that doesn't link in the WASI C library.
    for (const absent of ["gets", "tmpfile", "popen", "system"]) expect(options.map((o) => o.label), absent).not.toContain(absent);
    // C's bool and NULL come once, from the keyword list (which says what they need).
    expect(one(options, "bool").detail).toBe("needs <stdbool.h>");
    one(options, "NULL");
  });

  it("boosts the beginner names, most common first, always below a better match (the boost stays under 100)", async () => {
    const options = await optionsAfter("main.c", "int main(void) {\n  str\n}", "str");
    const boost = (label: string) => options.find((o) => o.label === label && o.type === "function")?.boost;
    expect(boost("strlen")).toBeGreaterThan(boost("strcpy")!);
    expect(boost("strcpy")).toBeGreaterThan(boost("strcmp")!);
    expect(boost("strtok"), "an ordinary name has none").toBeUndefined();
    for (const o of options) if (o.boost !== undefined) expect(o.boost, o.label).toBeLessThan(100);
    // The printf statement and the printf function share the boost, so the statement (the keyword
    // list comes first) stays just above the function.
    const pri = await optionsAfter("main.c", "int main(void) {\n  pri\n}", "pri");
    expect(one(pri, "printf", "statement").boost).toBe(one(pri, "printf", "int printf(const char *, ...)").boost);
    expect(one(await optionsAfter("main.c", "#include <st", "<st"), "stdio.h").boost).toBeGreaterThan(
      one(await optionsAfter("main.c", "#include <st", "<st"), "stdlib.h").boost!,
    );
    expect(one(await optionsAfter("main.cpp", "int main() {\n  std::co\n}", "std::co"), "cout").boost).toBeDefined();
    expect(one(await optionsAfter("main.py", "import ma", "import ma"), "math").boost).toBeDefined();
    expect(one(await optionsAfter("main.py", "import ma", "import ma"), "marshal").boost).toBeUndefined();
  });

  it("shows no value for NULL in C++: the data holds C's ((void*)0), and C++ headers define it otherwise (review RB-5)", async () => {
    const options = await optionsAfter("main.cpp", "int main() {\n  NUL\n}", "NUL");
    const nulls = options.filter((o) => o.label === "NULL");
    expect(nulls).toHaveLength(1);
    expect(nulls[0].detail, "no C value in C++").toBeUndefined();
    expect(nulls[0].info).toBe("Defined in <stdio.h>");
    // Other values are the same in both languages and stay.
    expect(one(await optionsAfter("main.cpp", "int main() {\n  EO\n}", "EO"), "EOF").detail).toBe("(-1)");
  });

  it("follows the C standard in Settings: POSIX names and M_PI only in the gnu modes", async () => {
    const code = "int main(void) {\n  x\n}";
    const gnu = (await optionsAfter("main.c", code, "  x", { c: "gnu11" })).map((o) => o.label);
    const strict = (await optionsAfter("main.c", code, "  x", { c: "c11" })).map((o) => o.label);
    expect(gnu).toEqual(expect.arrayContaining(["M_PI", "fileno", "printf"]));
    expect(strict).toContain("printf");
    expect(strict).not.toContain("M_PI");
    expect(strict).not.toContain("fileno");
  });

  it("offers no library names where no keyword fits: after . -> ::, in strings, comments and directives", async () => {
    for (const [path, code, marker] of [
      ["main.c", "int f(struct P p) {\n  return p.pri;\n}", "p.pri"],
      ["main.c", "int f(struct P *q) {\n  return q->pri;\n}", "q->pri"],
      ["main.c", 'char *s = "pri";', '"pri'],
      ["main.c", "// pri", "// pri"],
      ["main.c", "#define X pri", "X pri"],
      ["main.cpp", "int main() {\n  obj::pri\n}", "::pri"],
    ]) {
      expect((await labelsAfter(path, code, marker)).filter((l) => l === "printf"), `${code}`).toEqual([]);
    }
  });

  it("`std::vec` in C++ offers vector, and each std name only from the C++ standard that has it", async () => {
    const code = "int main() {\n  std::vec\n}";
    const at = async (cpp: string) => (await optionsAfter("main.cpp", code, "std::vec", { cpp })).map((o) => o.label);
    const options = await optionsAfter("main.cpp", code, "std::vec");
    expect(one(options, "vector")).toMatchObject({ type: "class", info: "Declared in <vector>" });
    expect(sectionName(one(options, "vector"))).toBe("vector");
    expect(options.some((o) => o.label === "void" || o.label === "printf"), "no keywords or C names after std::").toBe(false);
    expect(await at("c++11")).toContain("vector");
    expect(await at("c++11")).not.toContain("make_unique");
    expect(await at("c++14")).toContain("make_unique");
    expect(await at("c++14")).not.toContain("clamp");
    expect(await at("c++17")).toEqual(expect.arrayContaining(["clamp", "make_unique", "vector", "cout"]));
    expect(one(options, "clamp")).toMatchObject({ detail: "C++17", info: "Declared in <algorithm>, since C++17" });
    // Never the names that crash or abort with our clang 8.
    for (const absent of ["shared_ptr", "make_shared", "thread"]) expect(await at("c++2a"), absent).not.toContain(absent);
  });

  it("offers std:: names in C++ only, and not in comments or strings", async () => {
    expect(await labelsAfter("main.c", "int main(void) {\n  std::vec\n}", "std::vec")).toEqual([]);
    expect(await labelsAfter("main.cpp", "// std::vec", "std::vec")).toEqual([]);
    expect(await labelsAfter("main.cpp", 'auto s = "std::vec";', "std::vec")).toEqual([]);
    expect(await labelsAfter("main.cpp", "::std::vec", "std::vec")).toContain("vector");
  });

  it("a read-only file offers no library names", async () => {
    expect(await labelsAfter("main.c", "int main(void) {\n  pri\n}", "pri", { readOnly: true })).toEqual([]);
    expect(await labelsAfter("main.cpp", "int main() {\n  std::vec\n}", "std::vec", { readOnly: true })).toEqual([]);
  });
});

describe("C and C++ snippets", () => {
  const insert = async (path: string, typed: string, label: string, detail?: string) => {
    const state = stateFor(path, typed, { extra: indentUnit.of("    ") });
    const option = one(await optionsAfter(path, typed, typed), label, detail);
    return accept(state, option, 0, typed.length).doc.toString();
  };

  it("main, loops, blocks, struct, printf and scanf in C", async () => {
    expect(await insert("main.c", "ma", "main", "function")).toBe("int main(void) {\n    \n    return 0;\n}");
    expect(await insert("main.c", "fo", "for", "loop")).toBe("for (int i = 0; i < n; i++) {\n    \n}");
    expect(await insert("main.c", "wh", "while", "loop")).toBe("while (condition) {\n    \n}");
    expect(await insert("main.c", "if", "if", "/ else block")).toBe("if (condition) {\n    \n} else {\n    \n}");
    expect(await insert("main.c", "sw", "switch", "block")).toBe("switch (expression) {\ncase constant:\n    \n    break;\ndefault:\n    break;\n}");
    expect(await insert("main.c", "st", "struct", "definition")).toBe("struct Name {\n    \n};");
    expect(await insert("main.c", "pri", "printf", "statement")).toBe('printf("\\n");');
    expect(await insert("main.c", "sc", "scanf", "statement")).toBe('scanf("%d", &variable);');
  });

  // "int main" + Enter (main on top and picked) gave "int int main(void) {", which doesn't compile
  // (review, 2026-10-28): after a return type the snippet inserts the rest of the function.
  it("main after a return type typed before it inserts the rest of the function, never a second type", async () => {
    const after = async (path: string, typed: string) => {
      const state = stateFor(path, typed, { extra: indentUnit.of("    ") });
      const option = one(await optionsAfter(path, typed, typed), "main", "function");
      return accept(state, option, typed.length - 2, typed.length).doc.toString();
    };
    expect(await after("main.c", "int ma")).toBe("int main(void) {\n    \n    return 0;\n}");
    expect(await after("main.c", "static int ma")).toBe("static int main(void) {\n    \n    return 0;\n}");
    // void main: no return value (C warns about the type, C++ refuses it; the text stays the student's).
    expect(await after("main.c", "void ma")).toBe("void main(void) {\n    \n}");
    expect(await after("main.cpp", "int ma")).toBe("int main() {\n    \n}");
    expect(await after("main.cpp", "void ma")).toBe("void main() {\n    \n}");
    // Not a type word before it (a longer word that ends in int): the whole function, as at a line's start.
    expect(await after("main.c", "    ma")).toBe("    int main(void) {\n        \n        return 0;\n    }");
    expect(await after("main.c", "print ma")).toBe("print int main(void) {\n    \n    return 0;\n}");
  });

  it("class and C++'s main in C++ only; the keywords stay plain words beside them", async () => {
    expect(await insert("main.cpp", "cl", "class", "definition")).toBe("class Name {\npublic:\n    \n};");
    expect(await insert("main.cpp", "ma", "main", "function")).toBe("int main() {\n    \n}");
    expect(C_SNIPPETS.some((s) => s.label === "class")).toBe(false);
    expect(CPP_SNIPPETS.some((s) => s.label === "class")).toBe(true);
    const labels = await labelsAfter("main.c", "fo", "fo");
    expect(labels.filter((l) => l === "for")).toHaveLength(2); // the keyword and the loop
  });

  it("the #include lines insert as they read", async () => {
    expect(await insert("main.c", "#in", "#include <stdio.h>")).toBe("#include <stdio.h>");
    expect(await insert("main.cpp", "#", "#include <iostream>")).toBe("#include <iostream>");
  });
});
