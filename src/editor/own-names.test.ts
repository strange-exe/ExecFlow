// The names a C, C++ or Python file declares (own-names.ts), read from real @lezer/cpp 1.1.6 and
// lang-python 6.2.1 parses: kinds, details, what the info says, and what stays out.
import { pythonLanguage } from "@codemirror/lang-python";
import { parser as cppParser } from "@lezer/cpp";
import { describe, expect, it } from "vitest";
import { cFileNames, DETAIL_MAX, oneLine, ownOptions, pyModuleNames, type OwnName } from "./own-names";

function cNames(text: string, includes?: string[]): OwnName[] {
  const tree = cppParser.parse(text);
  return [...cFileNames(tree.topNode, (a, b) => text.slice(a, b), includes)].filter((n): n is OwnName => n !== null);
}

function pyNames(text: string): OwnName[] {
  const tree = pythonLanguage.parser.parse(text);
  return [...pyModuleNames(tree.topNode, (a, b) => text.slice(a, b))].filter((n): n is OwnName => n !== null);
}

/** label: kind (what) detail, one string per name, for compact expectations. */
const shown = (names: OwnName[]) => names.map((n) => `${n.label}: ${n.type} (${n.what}) ${n.detail}`);

const HEADER = [
  "#ifndef UTIL_H",
  "#define UTIL_H",
  "#define MAX 100",
  "#define SQ(x) ((x) * (x))",
  "int add(int a, int b);",
  "static int counter = 0, other;",
  "const char *names[3];",
  "struct point { int x; int y; };",
  "union value { int i; float f; };",
  "enum color { RED, GREEN = 2, BLUE };",
  "typedef struct point point_t;",
  "typedef int (*cmp_fn)(const void *, const void *);",
  "typedef enum { LOW, HIGH } level;",
  'extern "C" { int cfun(void); }',
  "int *make(void) {",
  "  int local = 1;",
  "  return 0;",
  "}",
  "void (*handler)(int);",
  "#endif",
].join("\n");

describe("C names", () => {
  it("finds functions, globals, structs, unions, enums and their constants, typedefs and macros, each with its kind", () => {
    expect(shown(cNames(HEADER))).toEqual([
      "MAX: constant (Macro) #define MAX 100",
      "SQ: function (Macro) #define SQ(x) ((x) * (x))",
      "add: function (Function) int add(int a, int b)",
      "counter: variable (Variable) static int counter = 0, other",
      "other: variable (Variable) static int counter = 0, other",
      "names: variable (Variable) const char *names[3]",
      "point: class (Struct) struct point",
      "value: class (Union) union value",
      "color: enum (Enum) enum color",
      "RED: constant (Enum constant) enum color",
      "GREEN: constant (Enum constant) enum color",
      "BLUE: constant (Enum constant) enum color",
      "point_t: type (Type) typedef struct point point_t",
      "cmp_fn: type (Type) typedef int (*cmp_fn)(const void *, const void *)",
      "LOW: constant (Enum constant) enum",
      "HIGH: constant (Enum constant) enum",
      "level: type (Type) typedef enum { LOW, HIGH } level",
      "cfun: function (Function) int cfun(void)",
      "make: function (Function) int *make(void)",
      "handler: variable (Variable) void (*handler)(int)",
    ]);
  });

  it("leaves out locals, parameters, members, header guards and uses of a type", () => {
    const labels = cNames(HEADER).map((n) => n.label);
    for (const absent of ["UTIL_H", "local", "a", "b", "x", "y", "i", "f"]) expect(labels, absent).not.toContain(absent);
    // `struct point p;` uses the type; only the variable is new.
    expect(shown(cNames("struct point p;\nenum color c;\n"))).toEqual([
      "p: variable (Variable) struct point p",
      "c: variable (Variable) enum color c",
    ]);
  });

  it("puts a function's head on one line and caps long details", () => {
    const [add] = cNames("int\nadd(int a,\n    int b)\n{\n  return a + b;\n}\n");
    expect(add).toMatchObject({ label: "add", type: "function", detail: "int add(int a, int b)" });
    const long = `int table[] = { ${Array.from({ length: 80 }, (_, i) => i).join(", ")} };`;
    const [table] = cNames(long);
    expect(table.detail.length).toBe(DETAIL_MAX);
    expect(table.detail.endsWith("...")).toBe(true);
    // A macro keeps its whole value, braces too.
    expect(cNames("#define BEGIN {\n")[0].detail).toBe("#define BEGIN {");
  });

  it("finds C++ classes, aliases and templates, but not namespace members or out-of-class methods", () => {
    const code = [
      "class Dog { public: void bark(); };",
      "namespace ns { int hidden(); }",
      "template <typename T> T maxof(T a, T b) { return a; }",
      "template <typename T> struct Box { T v; };",
      "using u8 = unsigned char;",
      "void Dog::bark() {}",
      "struct Fwd;",
    ].join("\n");
    expect(shown(cNames(code))).toEqual([
      "Dog: class (Class) class Dog",
      "maxof: function (Function) T maxof(T a, T b)",
      "Box: class (Struct) struct Box",
      "u8: type (Type) using u8 = unsigned char",
    ]);
  });

  it("reads the quoted include spellings in order, not system headers or commented-out lines", () => {
    const includes: string[] = [];
    cNames('#include <stdio.h>\n#include "util.h"\n// #include "old.h"\n/* #include "older.h" */\n#include "lib/shapes.h"\nint x;\n', includes);
    expect(includes).toEqual(["util.h", "lib/shapes.h"]);
  });

  it("records where each name is, so the word being typed can be left out", () => {
    const code = "int main(void) {\n  return 0;\n}\nint coun";
    const names = cNames(code);
    expect(names.map((n) => n.label)).toEqual(["main"]); // `int coun` parses as an unfinished definition: no function
    const [main] = names;
    expect(code.slice(main.from, main.to)).toBe("main");
  });

  it("yields once per top-level item, so a long file can be walked in slices", () => {
    const code = "int a;\n;\nint b;\n";
    const steps = [...cFileNames(cppParser.parse(code).topNode, (x, y) => code.slice(x, y))];
    expect(steps.map((s) => s?.label ?? null)).toEqual(["a", null, "b"]);
  });
});

describe("Python module names", () => {
  it("finds top-level defs, classes and assignments, decorated ones too, with their kinds", () => {
    const code = [
      "import os",
      "X = 1",
      "Y: int = 2",
      "a, b = 1, 2",
      "first = second = 0",
      "def greet(name,",
      "          greeting='hi'):",
      "    inner = 1",
      "async def go():",
      "    pass",
      "class Point(Base):",
      "    z = 3",
      "@dec",
      "def wrapped():",
      "    pass",
      "if True:",
      "    hidden = 1",
      "obj.attr = 5",
    ].join("\n");
    expect(shown(pyNames(code))).toEqual([
      "X: variable (Variable) X = 1",
      "Y: variable (Variable) Y: int = 2",
      "a: variable (Variable) a, b = 1, 2",
      "b: variable (Variable) a, b = 1, 2",
      "first: variable (Variable) first = second = 0",
      "second: variable (Variable) first = second = 0",
      "greet: function (Function) def greet(name, greeting='hi')",
      "go: function (Function) async def go()",
      "Point: class (Class) class Point(Base)",
      "wrapped: function (Function) def wrapped()",
    ]);
  });
});

describe("oneLine and ownOptions", () => {
  it("collapses whitespace and drops a closing ; or {", () => {
    const text = "struct  point\n{";
    expect(oneLine((a, b) => text.slice(a, b), 0, text.length)).toBe("struct point");
  });

  it("makes one option per name with the declaration as detail and our own info, once per list", () => {
    const names = cNames("int add(int a, int b);\n");
    const options = ownOptions(names, "lib/util.h");
    expect(options).toEqual([{ label: "add", type: "function", detail: "int add(int a, int b)", info: "Function in lib/util.h" }]);
    expect(ownOptions(names, "lib/util.h")).toBe(options);
    expect(ownOptions(names, "other.h")[0].info).toBe("Function in other.h");
  });
});

// Review finding S1 (2026-10-19): text typed or pasted into a file (imports refuse such files) could
// put a direction override into a suggestion's detail or label, where nothing marks it and it
// reorders what is shown ("Trojan Source"). Built from code points, so this file stays ASCII.
describe("direction and hidden characters", () => {
  const RLO = String.fromCodePoint(0x202e);
  const ISOLATE = String.fromCodePoint(0x2066);
  const ZWSP = String.fromCodePoint(0x200b);
  // The characters core/safety.ts treats as direction controls or hidden, from their code points.
  const unsafe = new RegExp(`[${[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200e, 0x200f, 0x2060, 0xfeff].map((c) => String.fromCodePoint(c)).join("")}]`);

  it("never reach a detail: they are taken out of the declaration shown", () => {
    const names = cNames(`static const char *greeting_text = "${RLO}// admin ok";\n#define BANNER "${ISOLATE}x${ZWSP}"\n`);
    expect(names.map((n) => n.label)).toEqual(["greeting_text", "BANNER"]);
    for (const n of names) expect(unsafe.test(n.detail), `${n.label}: ${JSON.stringify(n.detail)}`).toBe(false);
    expect(names[0].detail).toBe('static const char *greeting_text = "// admin ok"');
    const py = pyNames(`banner = "${RLO}x"\n`);
    expect(py.map((n) => n.detail)).toEqual(['banner = "x"']);
  });

  it("leave a name that contains one out of the suggestions (accepting it would type the hidden character)", () => {
    expect(cNames(`int ad${RLO}min = 1;\nint plain = 2;\n`).map((n) => n.label)).toEqual(["plain"]);
    expect(pyNames(`sh${RLO}ow = 1\nshown = 2\ndef f${ZWSP}x():\n    pass\n`).map((n) => n.label)).toEqual(["shown"]);
  });
});
