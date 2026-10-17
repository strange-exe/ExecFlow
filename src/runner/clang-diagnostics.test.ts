import { describe, expect, it } from "vitest";
import type { ToolDiagnostic, WorkspaceFile } from "../core/types";
import {
  cleanToolOutput, dedupeDiagnostics, parseClangOutput, parseLldOutput, symbolSearchName, systemHeaderName, unescapeClang, workspaceMap,
} from "./clang-diagnostics";
import { includeClosure } from "./cpp-build";

// Real output of the shipped clang 8 / wasm-ld 8, captured once with the worker's exact flags
// (by a capture harness kept outside the repo): { files, units: [{ unit, object, ok, output }], link? }.
interface Fixture {
  name: string;
  files: Record<string, string>;
  units: { unit: string; object: string; ok: boolean; output: string }[];
  link?: { ok: boolean; output: string };
}
const fixtures = import.meta.glob<Fixture>("./__fixtures__/*.json", { eager: true, import: "default" });
const fixture = (name: string): Fixture => {
  const f = fixtures[`./__fixtures__/${name}.json`];
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

function compile(name: string): ToolDiagnostic[] {
  const f = fixture(name);
  const map = workspaceMap(Object.keys(f.files));
  return dedupeDiagnostics(f.units.flatMap((u) => {
    const parsed = parseClangOutput(cleanToolOutput(u.output).text, map, `/w/${u.unit}`);
    expect(parsed.unparsed, `${name}: every line understood`).toEqual([]);
    return parsed.diagnostics;
  }));
}

function link(name: string): ToolDiagnostic[] {
  const f = fixture(name);
  const files = new Map<string, WorkspaceFile>(Object.entries(f.files).map(([path, text]) => [path, { path, text }]));
  const root = f.units[0].unit.includes("/") ? f.units[0].unit.slice(0, f.units[0].unit.lastIndexOf("/")) : "";
  const objects = new Map(f.units.map((u) => [u.object, u.unit]));
  const parsed = parseLldOutput(cleanToolOutput(f.link!.output).text, {
    unitOfObject: (o) => objects.get(o) ?? null,
    text: (p) => files.get(p)?.text,
    includesOf: (u) => includeClosure(u, files, root),
  });
  expect(parsed.unparsed).toEqual([]);
  return parsed.diagnostics;
}

const at = (d: ToolDiagnostic) => `${d.path}:${d.line}:${d.col ?? ""}${d.endCol !== undefined ? `-${d.endLine}:${d.endCol}` : ""}`;

describe("clang output", () => {
  it("reads errors, warnings, flags and a fix-it (UTF-8 byte columns, base 1)", () => {
    const d = compile("c-errors");
    // (clang skips -Wunused-variable in a function that has errors)
    expect(d.map((x) => [x.severity, at(x), x.message])).toEqual([
      ["error", "a/main.c:5:24", "expected ';' after expression"],
      ["error", "a/main.c:6:10", "use of undeclared identifier 'x'"],
    ]);
    expect(compile("warnings-notes-fixits").find((x) => x.code === "-Wint-conversion")).toMatchObject({ severity: "warning", line: 6, col: 7, endLine: 6, endCol: 17 });
    const semi = d.find((x) => x.message.startsWith("expected ';'"))!;
    expect(semi.fixes).toEqual([{ path: "a/main.c", line: 5, col: 24, endLine: 5, endCol: 24, unit: "utf8-byte", base: 1, insert: ";" }]);
    expect(d.every((x) => x.unit === "utf8-byte" && x.base === 1 && x.source === "clang")).toBe(true);
  });

  it("puts an error inside a header on the header, says where it was included, and reports it once for two units", () => {
    const d = compile("header-error-two-units");
    const err = d.filter((x) => x.message === "expected expression");
    expect(err).toHaveLength(1);
    expect(at(err[0])).toBe("b/util.h:4:12");
    expect(err[0].notes).toEqual([{ path: "b/main.c", line: 1, unit: "utf8-byte", base: 1, message: "included from here" }]);
    const warn = d.find((x) => x.severity === "warning")!;
    expect(at(warn)).toBe("b/util.h:5:17");
    expect(warn.fixes?.[0]).toMatchObject({ path: "b/util.h", line: 5, col: 17, insert: ";" });
  });

  it("normalises ../ in include paths and keeps the include chain (innermost first)", () => {
    const [d] = compile("nested-include");
    expect(at(d)).toBe("c/lib/inner.h:1:33");
    expect(d.notes?.map((n) => `${n.path}:${n.line}`)).toEqual(["c/inc/outer.h:1", "c/main.c:1"]);
  });

  it("keeps byte columns after non-ASCII text, with the highlighted range", () => {
    const [d] = compile("utf8-column");
    expect(d.message).toBe("invalid operands to binary expression ('const char *' and 'double')");
    const line = fixture("utf8-column").files["d/main.c"].split("\n")[2];
    const bytes = new TextEncoder().encode(line);
    // col is the 1-based byte column of "+"; the range ends after "1.5".
    expect(new TextDecoder().decode(bytes.slice(d.col! - 1, d.col!))).toBe("+");
    expect(new TextDecoder().decode(bytes.slice(d.col! - 1, d.endCol! - 1))).toBe("+ 1.5");
    expect(d.col).toBeGreaterThan(line.indexOf("+") + 1); // bytes, not UTF-16 units
  });

  it("decodes non-ASCII identifiers in messages as UTF-8 (no mojibake)", () => {
    const [d] = compile("utf8-identifier");
    expect(d.message).toBe(`use of undeclared identifier 'na${String.fromCodePoint(0xef)}ve'`);
  });

  it("keeps notes with their own locations; note fix-its (alternatives) are not applied with the warning", () => {
    const d = compile("warnings-notes-fixits");
    const conflict = d.find((x) => x.message === "conflicting types for 'f'")!;
    expect(conflict.notes).toEqual([{ path: "f/main.c", line: 3, col: 5, unit: "utf8-byte", base: 1, message: "previous definition is here" }]);
    const parens = d.find((x) => x.code === "-Wparentheses")!;
    expect(parens.notes?.map((n) => n.message)).toEqual([
      "place parentheses around the assignment to silence this warning",
      "use '==' to turn this assignment into an equality comparison",
    ]);
    expect(parens.fixes).toBeUndefined();
    expect(d.some((x) => x.code === "-Wimplicit-function-declaration")).toBe(true);
    expect(d.some((x) => x.code === "-Wformat")).toBe(true);
  });

  it("shows notes from system headers by header name, without a workspace path", () => {
    const d = compile("cpp-class-header");
    expect(at(d[0])).toBe("g/shape.h:5:42");
    expect(d[0].notes?.[0]).toMatchObject({ path: "g/main.cpp", line: 3, message: "included from here" });
    const conv = d.find((x) => x.message.startsWith("no viable conversion"))!;
    expect(at(conv)).toBe("g/main.cpp:7:15-7:20");
    expect(conv.notes?.[0]).toMatchObject({ path: null, message: expect.stringMatching(/^<string>:800: candidate constructor not viable/) });
  });

  it("moves an error inside the standard library to the user's line that led there, once", () => {
    const d = compile("cpp-template-sort");
    expect(d).toHaveLength(1);
    expect(at(d[0])).toBe("h/main.cpp:6:8");
    expect(d[0].message).toMatch(/^invalid operands to binary expression \('const P' and 'const P'\) \(and \d+ more errors inside the standard library\)$/);
    expect(d[0].notes?.[0].message).toBe("reported inside <algorithm>, line 716");
  });

  it("reads messages without a location", () => {
    const d = compile("too-many-errors");
    const last = d[d.length - 1];
    expect(last).toMatchObject({ path: null, severity: "error", message: "too many errors emitted, stopping now", code: "-ferror-limit=" });
    expect(d.filter((x) => x.path === "j/main.c")).toHaveLength(50);
    const backend = compile("backend-thread-local");
    expect(backend).toHaveLength(1);
    expect(backend[0]).toMatchObject({ path: null, severity: "error" });
    expect(backend[0].message).toMatch(/^error in backend: Cannot select: .*GlobalTLSAddress.*\nIn function: __original_main$/);
  });

  it("handles missing headers, macro notes and paths with spaces", () => {
    expect(compile("include-not-found").map((x) => [at(x), x.message])).toEqual([["k/main.c:2:10-2:21", "'missing.h' file not found"]]);
    const [macro] = compile("macro-expansion");
    expect(at(macro)).toBe("l/main.c:3:10");
    expect(macro.notes).toEqual([{ path: "l/main.c", line: 1, col: 31, unit: "utf8-byte", base: 1, message: "expanded from macro 'TWICE'" }]);
    expect(compile("space-in-path").map(at)).toEqual(["my prog/main.c:2:36"]);
  });

  it("removes the toolchain's own wrapper and recognises a crash of the tool itself", () => {
    expect(cleanToolOutput("x\n\x1b[91mError: process exited with code 1.\x1b[0m\n")).toEqual({ text: "x\n", internalError: null });
    const crash = cleanToolOutput("\x1b[91mError: memory access out of bounds\nRuntimeError: memory access out of bounds\n    at wasm://wasm/1\x1b[0m\n");
    expect(crash).toEqual({ text: "", internalError: "memory access out of bounds" });
  });

  it("unescapes fix-it text (octal UTF-8 bytes, quotes, backslashes)", () => {
    expect(unescapeClang("h\\303\\251llo \\\"q\\\" a\\\\b\\n")).toBe(`h${String.fromCodePoint(0xe9)}llo "q" a\\b\n`);
    const out = parseClangOutput(
      '/w/a.c:1:5: error: x\n int a\n     ^\n     ;\nfix-it:"/w/a.c":{1:5-1:5}:"\\342\\202\\254"\n',
      workspaceMap(["a.c"]), "/w/a.c",
    );
    expect(out.diagnostics[0].fixes?.[0].insert).toBe(String.fromCodePoint(0x20ac));
  });

  it("is not fooled by a source line that looks like a diagnostic", () => {
    const fake = "/w/a.c:9:9: error: fake";
    const out = parseClangOutput(`/w/a.c:2:1: error: real\n ${fake}\n ^\n`, workspaceMap(["a.c"]), "/w/a.c");
    expect(out.diagnostics.map((d) => d.message)).toEqual(["real"]);
  });

  it("names system headers", () => {
    expect(systemHeaderName("/include/c++/v1/vector")).toBe("<vector>");
    expect(systemHeaderName("/include/stdio.h")).toBe("<stdio.h>");
    expect(systemHeaderName("/lib/clang/8.0.1/include/stddef.h")).toBe("<stddef.h>");
  });
});

describe("wasm-ld output", () => {
  it("locates undefined symbols at their first use in the unit (heuristic)", () => {
    const d = link("lld-undefined-c");
    expect(d.map((x) => [x.message, at(x), x.heuristic])).toEqual([
      ["undefined symbol: gets", "n/main.c:5:2-5:6", true],
      ["undefined symbol: helper", "n/main.c:6:9-6:15", true],
    ]);
    expect(d[0].unit).toBe("utf16");
  });

  it("finds a C++ call to a C function", () => {
    const d = link("lld-extern-c");
    expect(d.map((x) => [x.message, at(x)])).toEqual([["undefined symbol: add(int, int)", "o/main.cpp:4:22-4:25"]]);
  });

  it("marks both definitions of a duplicate symbol", () => {
    expect(link("lld-duplicate").map((x) => [at(x), x.message])).toEqual([
      ["p/main.c:1:4-1:9", "duplicate symbol: value (defined in p/main.c and p/other.c)"],
      ["p/other.c:1:4-1:9", "duplicate symbol: value (defined in p/main.c and p/other.c)"],
    ]);
    // A definition in a header is reported once, in the header.
    expect(link("lld-header-definition").map(at)).toEqual(["r/counter.h:1:4-1:11"]);
  });

  it("reports a missing main for the program as a whole", () => {
    expect(link("lld-no-main")).toEqual([{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", message: "undefined symbol: main", source: "wasm-ld" }]);
  });

  it("finds the class of a missing vtable and C++ methods and templates", () => {
    const vt = link("lld-vtable");
    expect(vt.map((x) => [x.message, at(x)])).toEqual([
      ["undefined symbol: vtable for Shape", "t/main.cpp:1:0-1:12"],
      ["undefined symbol: Shape::area() const", "t/main.cpp:7:11-7:15"],
    ]);
    const methods = link("lld-cpp-method");
    expect(methods.map((x) => [x.message, at(x)])).toEqual([
      ["undefined symbol: ns::A::f(int) const", "u/main.cpp:4:11-4:12"],
      ["undefined symbol: int ns::g<int>(int)", "u/main.cpp:4:22-4:23"],
    ]);
  });

  it("drops lld's repeat of a duplicate main (__original_main)", () => {
    const out = parseLldOutput("wasm-ld: error: duplicate symbol: __original_main\n>>> defined in /o/a.o\n>>> defined in /o/b.o\n", {
      unitOfObject: () => null, text: () => undefined, includesOf: () => [],
    });
    expect(out.diagnostics).toEqual([]);
  });

  it("names the search target of demangled symbols", () => {
    expect(symbolSearchName("gets")).toEqual({ name: "gets", kind: "plain" });
    expect(symbolSearchName("add(int, int)")).toEqual({ name: "add", kind: "function" });
    expect(symbolSearchName("ns::A::f(int) const").name).toBe("f");
    expect(symbolSearchName("int ns::g<int>(int)").name).toBe("g");
    expect(symbolSearchName("Shape::~Shape()").name).toBe("~Shape");
    expect(symbolSearchName("operator<<(std::ostream&, X const&)").name).toBe("operator<<");
    expect(symbolSearchName("X::operator()(int)").name).toBe("operator()");
    expect(symbolSearchName("typeinfo for ns::Base<int>")).toEqual({ name: "Base", kind: "class" });
  });
});
