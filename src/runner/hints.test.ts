import { describe, expect, it } from "vitest";
import type { RunStatus, ToolDiagnostic, WorkspaceFile } from "../core/types";
import { cleanToolOutput, parseClangOutput, parseLldOutput, workspaceMap } from "./clang-diagnostics";
import { includeClosure } from "./cpp-build";
import { cppHints } from "./hints";

const wrap = (body: string) => `#include <stdio.h>\nint main(){ char opt, s[50]; int n; ${body} return 0; }`;
const one = (code: string, status: RunStatus, diagnostics: ToolDiagnostic[] = []) =>
  cppHints({ sources: [{ path: "main.c", text: code }], units: ["main.c"], diagnostics, status });
const first = (code: string, status: RunStatus) => one(code, status)[0]?.message ?? null;

describe("hints for C and C++ programs (from Pocket Run)", () => {
  it.each([
    ['scanf("%c",&opt);', /" %c"/],
    ['scanf ( "%c" , &opt );', /" %c"/],
    ['if (scanf("%c%c", &opt, &opt) == 2) {}', /" %c"/],
    ["gets(s);", /fgets/],
    ["getch();", /Turbo C/],
    ["clrscr();", /Turbo C/],
  ])("explains %s", (body, hint) => {
    expect(first(wrap(body), "ok")).toMatch(hint);
  });

  it("explains conio.h and void main", () => {
    expect(first("#include <conio.h>\nint main(){ return 0; }", "build-failed")).toMatch(/Turbo C/);
    expect(first('#include <stdio.h>\nvoid main(){ printf("hi"); }', "error")).toMatch(/int main/);
  });

  it.each([
    'scanf(" %c",&opt);',
    'scanf("%d %c",&n,&opt);',
    'printf("%c", opt);',
    "fgets(s, sizeof s, stdin);",
    "getchar();",
    '/* gets(s); */ puts("gets(");',
  ])("stays quiet for %s", (body) => {
    expect(first(wrap(body), "ok")).toBeNull();
  });

  it('keeps the scanf("%c") tip for programs that compiled', () => {
    expect(first(wrap('scanf("%c",&opt);'), "build-failed")).toBeNull();
  });

  it("points at the line it is about (UTF-16, base 0)", () => {
    const [h] = one("#include <stdio.h>\nint main(void) {\n  char s[9]; gets(s);\n}\n", "build-failed");
    expect(h).toMatchObject({ path: "main.c", line: 3, col: 13, unit: "utf16", base: 0, severity: "info", source: "hint", code: "gets" });
  });
});

// Hints for multi-file programs, fed the real toolchain output kept in __fixtures__/.
interface Fixture {
  files: Record<string, string>;
  units: { unit: string; object: string; ok: boolean; output: string }[];
  link?: { ok: boolean; output: string };
}
const fixtures = import.meta.glob<Fixture>("./__fixtures__/*.json", { eager: true, import: "default" });

function hintsFor(name: string): ToolDiagnostic[] {
  const f = fixtures[`./__fixtures__/${name}.json`];
  const sources: WorkspaceFile[] = Object.entries(f.files).map(([path, text]) => ({ path, text }));
  const files = new Map(sources.map((s) => [s.path, s]));
  const root = f.units[0].unit.slice(0, f.units[0].unit.lastIndexOf("/"));
  const map = workspaceMap(files.keys());
  const diagnostics = f.units.flatMap((u) => parseClangOutput(cleanToolOutput(u.output).text, map, `/w/${u.unit}`).diagnostics);
  if (f.link) {
    const objects = new Map(f.units.map((u) => [u.object, u.unit]));
    diagnostics.push(...parseLldOutput(cleanToolOutput(f.link.output).text, {
      unitOfObject: (o) => objects.get(o) ?? null, text: (p) => files.get(p)?.text, includesOf: (u) => includeClosure(u, files, root),
    }).diagnostics);
  }
  const failed = f.units.some((u) => !u.ok) || (f.link && !f.link.ok);
  return cppHints({ sources, units: f.units.map((u) => u.unit), diagnostics, status: failed ? "build-failed" : "ok" });
}
const codes = (name: string) => hintsFor(name).map((h) => h.code);

describe("hints for multi-file programs", () => {
  it('explains extern "C" when C++ calls a C function, at the declaration in the header', () => {
    const [h] = hintsFor("lld-extern-c");
    expect(h.code).toBe("extern-c");
    expect(h.message).toContain('extern "C"');
    expect(h).toMatchObject({ path: "o/add.h", line: 1, col: 4 });
  });

  it("explains a function that is declared but never defined", () => {
    const hints = hintsFor("lld-undefined-c");
    expect(hints.map((h) => h.code)).toEqual(["gets", "never-defined"]);
    expect(hints[1]).toMatchObject({ path: "n/main.c", line: 2, col: 4 });
    expect(hints[1].message).toContain("helper is declared but never defined");
  });

  it("explains missing vtables, missing main, exceptions and the WebAssembly backend", () => {
    expect(codes("lld-vtable")).toContain("vtable");
    expect(codes("lld-no-main")).toEqual(["no-main"]);
    expect(codes("cpp-exceptions")).toEqual(["exceptions"]);
    expect(codes("backend-thread-local")).toEqual(["backend"]);
  });

  it("explains a C++ header in a C file", () => {
    expect(hintsFor("cpp-header-in-c")).toMatchObject([{ code: "cpp-header-in-c", path: "k2/main.c", line: 1 }]);
  });

  it("explains duplicates: an included .c file, a definition in a header", () => {
    expect(codes("lld-included-source")).toEqual(["include-source"]);
    expect(hintsFor("lld-included-source")[0]).toMatchObject({ path: "q/main.c", line: 1 });
    expect(codes("lld-header-definition")).toEqual(["defined-in-header"]);
    expect(codes("lld-duplicate")).toEqual([]);
  });

  it("explains two mains", () => {
    const d: ToolDiagnostic[] = [{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", message: "duplicate symbol: main (defined in a.c and b.c)", source: "wasm-ld" }];
    expect(one("int main(void) { return 0; }", "build-failed", d).map((h) => h.code)).toEqual(["two-mains"]);
  });

  it("says nothing for a program that builds cleanly", () => {
    expect(hintsFor("ok-multi")).toEqual([]);
  });
});
