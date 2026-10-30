// Your own names in suggestions (own-completion.ts, and library-completion.ts for Python modules):
// the open C/C++ file's names, those of the headers it includes with quotes (through the workspace
// index), and a Python workspace module's members after `import helpers` / `helpers.`. Options are
// read straight from every source the file has at the position, before CodeMirror filters them.
import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { IndexSlot, libraryContext, workspaceIndex } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import { loadLibrary } from "./library-data";
import { headerClosure, namesReady } from "./own-completion";
import { indexIn, type Scheduler } from "./workspace-index";
import "./test-languages";

beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
  expect(await loadLibrary("c")).toBe(true);
  expect(await loadLibrary("python")).toBe(true);
});

const soon: Scheduler = (slice) => void setTimeout(() => slice(() => true), 0);

/** A workspace of stored files and its index; `reads` lists what the index read. */
function workspace(files: Record<string, string>) {
  const reads: string[] = [];
  const slot = new IndexSlot(
    {
      read: (path) => {
        reads.push(path);
        return Object.hasOwn(files, path) ? Promise.resolve(files[path]) : Promise.reject(new Error("missing"));
      },
    },
    soon,
  );
  const index = indexIn(slot);
  const paths = Object.keys(files);
  return {
    files,
    reads,
    index,
    state(path: string, doc: string, options: { readOnly?: boolean; noIndex?: boolean } = {}) {
      const state = EditorState.create({
        doc,
        extensions: [
          fileConf.of(fileExtensions(path)),
          libraryContext.of({ files: () => paths, standards: () => ({ c: "gnu11", cpp: "c++17" }) }),
          options.noIndex ? [] : workspaceIndex.of(slot),
          options.readOnly ? EditorState.readOnly.of(true) : [],
        ],
      });
      ensureSyntaxTree(state, state.doc.length, 5000);
      return state;
    },
    async settled() {
      for (let i = 0; i < 1000 && index.busy; i++) await new Promise((r) => setTimeout(r, 0));
      expect(index.busy).toBe(false);
    },
  };
}

async function optionsAt(state: EditorState, pos: number, explicit = true): Promise<Completion[]> {
  const sources = state.languageDataAt<CompletionSource>("autocomplete", pos);
  const results = await Promise.all(sources.map((source) => source(new CompletionContext(state, pos, explicit))));
  return results.filter((r): r is CompletionResult => r != null).flatMap((r) => r.options);
}

/** Options at the end of the last `marker` in the state's text. */
function after(state: EditorState, marker: string, explicit = true): Promise<Completion[]> {
  const text = state.doc.toString();
  const at = text.lastIndexOf(marker);
  if (at < 0) throw new Error(`${marker} isn't in the sample`);
  return optionsAt(state, at + marker.length, explicit);
}

const ownOf = (options: Completion[]) => options.filter((o) => /^(Function|Variable|Struct|Union|Class|Enum|Enum constant|Type|Macro) in /.test(String(o.info)));
const labels = (options: Completion[]) => options.map((o) => o.label);

describe("C and C++: the open file's own names", () => {
  const MAIN = [
    "#define LIMIT 10",
    "struct point { int x; int y; };",
    "enum color { RED, GREEN };",
    "typedef unsigned long ulong;",
    "static int counter = 0;",
    "int add(int a, int b) {",
    "  return a + b;",
    "}",
    "int main(void) {",
    "  int local = 0;",
    "  ad",
    "}",
  ].join("\n");

  it("offers each function, type, constant, global and macro with its kind, declaration and where it is", async () => {
    const ws = workspace({ "main.c": MAIN });
    const own = ownOf(await after(ws.state("main.c", MAIN), "  ad"));
    expect(own.map((o) => `${o.label} ${o.type}`)).toEqual([
      "LIMIT constant", "point class", "color enum", "RED constant", "GREEN constant", "ulong type", "counter variable", "add function",
      "main function",
    ]);
    expect(own.find((o) => o.label === "add")).toEqual({ label: "add", type: "function", detail: "int add(int a, int b)", info: "Function in main.c" });
    // Locals and parameters are not file-level names.
    expect(labels(own)).not.toContain("local");
    expect(labels(own)).not.toContain("a");
  });

  it("leaves out the word being typed, which parses as a name too", async () => {
    // Typing a second variable's name: `coun` is already a declared name in the tree.
    const code = "int counter = 0, coun;\n";
    const ws = workspace({ "main.c": code });
    expect(labels(ownOf(await after(ws.state("main.c", code), "coun")))).toEqual(["counter"]);
    // At the end of a file an unfinished `int coun` is no name at all.
    const end = "int counter;\nint coun";
    expect(labels(ownOf(await after(workspace({ "main.c": end }).state("main.c", end), "int coun")))).toEqual(["counter"]);
  });

  it("works in C++ files and headers too, and in a file with no index (no other files)", async () => {
    const code = "class Dog { };\nusing Name = const char *;\nint main() {\n  Do\n}";
    const ws = workspace({ "main.cpp": code });
    expect(labels(ownOf(await after(ws.state("main.cpp", code, { noIndex: true }), "  Do")))).toEqual(["Dog", "Name", "main"]);
    const header = "int add(int a, int b);\nint use(void);\n";
    expect(labels(ownOf(await after(workspace({ "util.h": header }).state("util.h", header), "int use")))).toEqual(["add"]);
  });

  it.each([
    ["after a dot", "struct point { int x; };\nint main(void) {\n  struct point p;\n  p.\n}", "p."],
    ["after ->", "struct point { int x; };\nint f(struct point *q) {\n  return q->x;\n}", "q->"],
    ["on a preprocessor line", "#define LIMIT 10\n#if LIM", "#if LIM"],
    ["in a string", 'int counter;\nconst char *s = "cou";', '"cou'],
    ["in a comment", "int counter;\n// cou", "// cou"],
    ["after std::", "int vec;\nstd::ve", "std::ve"],
  ])("offers none %s", async (_, code, marker) => {
    const path = marker === "std::ve" ? "main.cpp" : "main.c";
    const ws = workspace({ [path]: code });
    expect(ownOf(await after(ws.state(path, code), marker))).toEqual([]);
  });

  it("offers none in a read-only file", async () => {
    const ws = workspace({ "main.c": MAIN });
    expect(ownOf(await after(ws.state("main.c", MAIN, { readOnly: true }), "  ad"))).toEqual([]);
  });

  it("opens with typing only on a word, and with Ctrl-Space anywhere", async () => {
    const code = "int counter;\nint main(void) {\n  \n}";
    const ws = workspace({ "main.c": code });
    const state = ws.state("main.c", code);
    const pos = code.indexOf("  \n") + 2;
    expect(ownOf(await optionsAt(state, pos, false))).toEqual([]);
    expect(labels(ownOf(await optionsAt(state, pos, true)))).toContain("counter");
  });

  it("doesn't repeat a word the keyword list offers, even when the user's macro defines it", async () => {
    // After #define, @lezer/cpp reads a keyword as an Identifier (probes/keyword-tokens.log).
    const code = "#define _Noreturn __attribute__((noreturn))\nint main(void) {\n  _No\n}";
    const options = await after(workspace({ "main.c": code }).state("main.c", code), "  _No");
    expect(options.filter((o) => o.label === "_Noreturn")).toHaveLength(1);
    expect(options.find((o) => o.label === "_Noreturn")).toMatchObject({ type: "keyword" }); // the keyword list's, not "Macro in main.c"
  });
});

describe("C and C++: names from headers included with quotes", () => {
  const FILES = {
    // A conflict copy never reaches a build, so including one by name finds nothing.
    "main.c": '#include <stdio.h>\n#include "util.h"\n#include "util.conflict-20261018-101500.h"\nint main(void) {\n  he\n}\n',
    "util.h": '#include "lib/deep.h"\nint helper(int x);\n',
    "lib/deep.h": "#define DEPTH 3\nstruct node { int v; };\n",
    "other.h": "int unrelated(void);\n",
    "util.conflict-20261018-101500.h": "int stale(void);\n",
  };

  it("offers a quoted header's names (and those it includes), but not an unrelated header's, which is never read", async () => {
    const ws = workspace(FILES);
    const state = ws.state("main.c", FILES["main.c"]);
    // The first request asks the index; the headers are known once it has parsed them.
    expect(labels(ownOf(await after(state, "  he")))).toEqual(["main"]);
    await ws.settled();
    expect(labels(ownOf(await after(state, "  he")))).toEqual(["main", "helper"]); // util.h known; its include asked for now
    await ws.settled();
    const own = ownOf(await after(state, "  he"));
    expect(own.map((o) => `${o.label} ${o.type} ${String(o.info)}`)).toEqual([
      "main function Function in main.c",
      "helper function Function in util.h",
      "DEPTH constant Macro in lib/deep.h",
      "node class Struct in lib/deep.h",
    ]);
    expect(own.find((o) => o.label === "helper")?.detail).toBe("int helper(int x)");
    expect([...ws.reads].sort()).toEqual(["lib/deep.h", "util.h"]);
    expect(labels(own)).not.toContain("unrelated");
    expect(labels(own)).not.toContain("stale");
  });

  it("follows the build's include rule: beside the including file first, then the program's folder", async () => {
    const files = {
      "lab/main.c": '#include "shapes/shape.h"\nint main(void) {\n  ar\n}\n',
      "lab/shapes/shape.h": '#include "area.h"\n#include "common.h"\n',
      "lab/shapes/area.h": "double area(double r);\n", // beside shape.h
      "lab/common.h": "int shared;\n", // not beside shape.h: found in the program's folder
      "area.h": "int wrong_area;\n",
    };
    const ws = workspace(files);
    const state = ws.state("lab/main.c", files["lab/main.c"]);
    for (let i = 0; i < 3; i++) {
      headerClosure(state, "lab/main.c", ws.index);
      await ws.settled();
    }
    expect(headerClosure(state, "lab/main.c", ws.index)).toEqual({ paths: ["lab/shapes/shape.h", "lab/shapes/area.h", "lab/common.h"], complete: true });
    expect(labels(ownOf(await after(state, "  ar")))).toEqual(["main", "area", "shared"]);
  });

  it("refreshes a header's names after it changes, and the open file's as it is typed", async () => {
    const ws = workspace({ ...FILES });
    let state = ws.state("main.c", FILES["main.c"]);
    for (let i = 0; i < 3; i++) {
      namesReady(state, "c");
      await ws.settled();
    }
    expect(namesReady(state, "c")).toBe(true);
    ws.files["util.h"] = "int helper(int x);\nint helper2(void);\n";
    ws.index.changed(["util.h"]);
    expect(namesReady(state, "c")).toBe(false);
    await ws.settled();
    expect(namesReady(state, "c")).toBe(true);
    let own = labels(ownOf(await after(state, "  he")));
    expect(own).toEqual(["main", "helper", "helper2"]); // deep.h is no longer included
    // A new include typed in the open file is followed at once (its syntax tree), its names once read.
    state = state.update({ changes: { from: 0, insert: '#include "other.h"\n' } }).state;
    ensureSyntaxTree(state, state.doc.length, 5000);
    expect(namesReady(state, "c")).toBe(false);
    await ws.settled();
    own = labels(ownOf(await after(state, "  he")));
    expect(own).toEqual(["main", "unrelated", "helper", "helper2"]);
  });

  it("puts a name declared in two places once: the open file's first", async () => {
    const files = { "main.c": '#include "util.h"\nint helper(int x) {\n  return x;\n}\nint main(void) {\n  he\n}\n', "util.h": "int helper(int x);\n" };
    const ws = workspace(files);
    const state = ws.state("main.c", files["main.c"]);
    headerClosure(state, "main.c", ws.index);
    await ws.settled();
    const helper = ownOf(await after(state, "  he")).filter((o) => o.label === "helper");
    expect(helper).toEqual([{ label: "helper", type: "function", detail: "int helper(int x)", info: "Function in main.c" }]);
  });
});

describe("Python: your own modules' members", () => {
  const FILES = {
    "main.py": "import helpers\nimport helpers as h\nfrom pkg import mod\nimport math\n",
    "helpers.py": "import os\n\ndef greet(name):\n    return name\n\nclass Point:\n    pass\n\nLIMIT = 3\nLIMIT = 4\n\nif True:\n    hidden = 1\n",
    "pkg/__init__.py": "VERSION = '1'\n",
    "pkg/mod.py": "def run():\n    pass\n",
    "other.py": "def never():\n    pass\n",
  };

  async function membersAt(ws: ReturnType<typeof workspace>, code: string, marker: string) {
    const state = ws.state("main.py", code);
    for (let i = 0; i < 2; i++) {
      namesReady(state, "python");
      await ws.settled();
    }
    expect(namesReady(state, "python")).toBe(true);
    return after(state, marker);
  }

  it("helpers. lists its top-level defs, classes and assignments, with their kinds and where they are", async () => {
    const ws = workspace(FILES);
    const code = `${FILES["main.py"]}helpers.`;
    const options = await membersAt(ws, code, "helpers.");
    expect(options.map((o) => `${o.label} ${o.type} ${String(o.info)}`)).toEqual([
      "greet function Function in helpers.py",
      "Point class Class in helpers.py",
      "LIMIT variable Variable in helpers.py",
    ]);
    expect(options[0].detail).toBe("def greet(name)");
    // Only the modules main.py imports were read.
    expect([...ws.reads].sort()).toEqual(["helpers.py", "pkg/__init__.py", "pkg/mod.py"]);
  });

  it("also after an alias, after `from helpers import`, and for a package and its modules", async () => {
    const ws = workspace(FILES);
    expect(labels(await membersAt(ws, `${FILES["main.py"]}h.`, "h."))).toEqual(["greet", "Point", "LIMIT"]);
    expect(labels(await membersAt(ws, `${FILES["main.py"]}from helpers import `, "import "))).toEqual(["greet", "Point", "LIMIT"]);
    expect(labels(await membersAt(ws, `${FILES["main.py"]}mod.`, "mod."))).toEqual(["run"]);
    expect(labels(await membersAt(ws, `${FILES["main.py"]}import pkg\npkg.`, "pkg."))).toEqual(["VERSION", "mod"]);
  });

  it("reads the module of a `from helpers import` line before any name is typed after it", async () => {
    const ws = workspace(FILES);
    const code = "from helpers import ";
    const state = ws.state("main.py", code);
    expect(namesReady(state, "python")).toBe(false); // helpers.py asked for while the file is shown
    await ws.settled();
    expect(namesReady(state, "python")).toBe(true);
    expect(labels(await after(state, "import "))).toEqual(["greet", "Point", "LIMIT"]);
  });

  it("leaves standard modules to the library data, and offers nothing before the module is read", async () => {
    const ws = workspace(FILES);
    const code = `${FILES["main.py"]}helpers.`;
    expect(await after(ws.state("main.py", code), "helpers.")).toEqual([]); // asked for now
    await ws.settled();
    expect(labels(await after(ws.state("main.py", code), "helpers."))).toContain("greet");
    expect(labels(await after(ws.state("main.py", `${FILES["main.py"]}math.sq`), "math.sq"))).toContain("sqrt");
  });

  it("the open file's own names come from lang-python's local names alone, once each, with kinds", async () => {
    const code = "def greet(name):\n    return name\n\nclass Point:\n    pass\n\ncount = 1\ngr";
    const options = await after(workspace({ "main.py": code }).state("main.py", code), "\ngr");
    for (const [label, type] of [["greet", "function"], ["Point", "class"], ["count", "variable"]]) {
      expect(options.filter((o) => o.label === label), label).toEqual([{ label, type }]);
    }
  });

  it("leaves out an open file's local name that holds a direction or hidden character (review S1)", async () => {
    const RLO = String.fromCodePoint(0x202e);
    const code = `sh${RLO}ow = 1\nshown = 2\nsh`;
    const found = labels(await after(workspace({ "main.py": code }).state("main.py", code), "\nsh"));
    expect(found).toContain("shown");
    expect(found.filter((l) => l.includes(RLO))).toEqual([]);
  });
});
