import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../core/types";
import { checkBuildOptions, cOnly, DEFAULT_BUILD, findQuotedInclude, includeClosure, semanticArgs, unitArgs, wantsPch } from "./cpp-build";
import { definesMain, includesBits, quotedIncludes, stripComments, stripCommentsAndStrings } from "./cpp-scan";
import { normalizeMemfsPath, parseDepfile } from "./cpp-depfile";

const COMMON = ["-disable-free", "-isysroot", "/", "-internal-isystem", "/include/c++/v1", "-internal-isystem", "/include", "-internal-isystem", "/lib/clang/8.0.1/include", "-ferror-limit", "19", "-fmessage-length", "80"];
const map = (spec: Record<string, string>) => new Map<string, WorkspaceFile>(Object.entries(spec).map(([path, text]) => [path, { path, text }]));

describe("compiler arguments", () => {
  it("compiles a C unit without libc++'s headers, with diagnostics made parseable", () => {
    const args = unitArgs({ unit: { path: "lab/main.c", lang: "c" }, root: "lab", common: COMMON, options: DEFAULT_BUILD, id: "abc", pch: "/pch/k.pch" });
    expect(args).not.toContain("/include/c++/v1");
    expect(args).not.toContain("-include-pch"); // never for C
    expect(args.slice(0, 2)).toEqual(["-cc1", "-emit-obj"]);
    expect(args.join(" ")).toContain("-std=gnu11 -O2 -Wall -iquote /w/lab -dependency-file /d/abc.d -MT obj -o /o/abc.o -x c /w/lab/main.c");
    // The later -fmessage-length / -ferror-limit win over binji's 80 and 19.
    expect(args.lastIndexOf("-fmessage-length")).toBeGreaterThan(args.indexOf("-fmessage-length"));
    expect(args[args.lastIndexOf("-fmessage-length") + 1]).toBe("0");
    // A C tentative definition ("int count;") is a common symbol, which crashes clang 8 for wasm.
    expect(args).toContain("-fno-common");
  });

  it("gives a C++ unit the precompiled header when asked", () => {
    const args = unitArgs({ unit: { path: "x.cpp", lang: "cpp" }, root: "", common: COMMON, options: DEFAULT_BUILD, id: "id", pch: "/pch/k.pch" });
    expect(args.join(" ")).toContain("-std=c++17 -O2 -Wall -iquote /w -include-pch /pch/k.pch");
    expect(args.slice(-3)).toEqual(["-x", "c++", "/w/x.cpp"]);
    expect(cOnly(COMMON)).toEqual(COMMON.filter((a, i) => !(a === "-internal-isystem" && COMMON[i + 1] === "/include/c++/v1") && a !== "/include/c++/v1"));
    // The PCH key's input: exactly what it was with the old empty defines list, so cached PCHs stay valid.
    expect(semanticArgs("cpp", DEFAULT_BUILD)).toEqual(["-std=c++17", "-O2"]);
    expect(semanticArgs("c", DEFAULT_BUILD)).toEqual(["-std=gnu11", "-O2"]);
  });

  it("keeps only options clang 8 accepts, and says what it changed", () => {
    const r = checkBuildOptions({ cStd: "c99", cxxStd: "c++20", opt: "1", warnings: ["-Wall", "-Wextra", "-o", "x"] });
    expect(r.options).toEqual({ cStd: "c99", cxxStd: "c++2a", opt: "1", warnings: ["-Wall", "-Wextra"] });
    expect(r.problems).toEqual(['the warning option "-o" was left out', 'the warning option "x" was left out']);
    const bad = checkBuildOptions({ cStd: "c23", cxxStd: "c++26", opt: "3" as never, warnings: [] });
    expect(bad.options).toMatchObject({ cStd: "gnu11", cxxStd: "c++17", opt: "2" });
    expect(bad.problems).toHaveLength(3);
    expect(checkBuildOptions(undefined)).toEqual({ options: DEFAULT_BUILD, problems: [] });
  });

  it("ignores a defines list an older page still sends (plan-v2 P4): no -D reaches clang, nothing reported", () => {
    const legacy = { ...DEFAULT_BUILD, defines: ["DEBUG=1", "bad name"] };
    const r = checkBuildOptions(legacy);
    expect(r).toEqual({ options: DEFAULT_BUILD, problems: [] });
    expect(r.options).not.toHaveProperty("defines");
    const args = unitArgs({ unit: { path: "x.c", lang: "c" }, root: "", common: COMMON, options: r.options, id: "id", pch: null });
    expect(args).not.toContain("-D");
    expect(args.join(" ")).not.toContain("DEBUG");
  });
});

describe("include closure and the precompiled header", () => {
  const files = map({
    "p/main.cpp": '#include "inc/common.h"\nint main() {}\n',
    "p/inc/common.h": '#include "types.h"\n#include "../util.h"\n',
    "p/inc/types.h": "struct T {};\n",
    "p/util.h": "#include <bits/stdc++.h>\n",
    "p/other.cpp": '#include "util.h" // via -iquote? no: next to it\n',
    "p/plain.cpp": "#include <cstdio>\n// #include <bits/stdc++.h>\n",
  });

  it("follows quoted includes next to the includer, then the root", () => {
    expect(includeClosure("p/main.cpp", files, "p")).toEqual(["p/inc/common.h", "p/inc/types.h", "p/util.h"]);
    const viaRoot = map({ "p/src/a.cpp": '#include "util.h"\n', "p/util.h": "" });
    expect(includeClosure("p/src/a.cpp", viaRoot, "p")).toEqual(["p/util.h"]);
  });

  it("takes each file's include spellings from includesOf when given (the editor's syntax trees), with the same rule", () => {
    const spellings: Record<string, string[]> = { "p/main.cpp": ["inc/types.h", "util.h"], "p/inc/types.h": ["../util.h"] };
    const asked: string[] = [];
    const closure = includeClosure("p/main.cpp", files, "p", (file) => {
      asked.push(file.path);
      return spellings[file.path] ?? [];
    });
    // Not common.h, which only the text includes; util.h once, though named twice.
    expect(closure).toEqual(["p/inc/types.h", "p/util.h"]);
    expect(asked).toEqual(["p/main.cpp", "p/inc/types.h", "p/util.h"]);
  });

  it("findQuotedInclude: beside the includer first, then the root; never above the workspace", () => {
    const has = (p: string) => ["p/util.h", "p/src/util.h", "p/inc/types.h", "top.h"].includes(p);
    expect(findQuotedInclude("p/src", "util.h", has, "p")).toBe("p/src/util.h");
    expect(findQuotedInclude("p/inc", "util.h", has, "p")).toBe("p/util.h");
    expect(findQuotedInclude("p/src", "../inc/types.h", has, "p")).toBe("p/inc/types.h");
    expect(findQuotedInclude("p", "../top.h", has, "p")).toBe("top.h");
    expect(findQuotedInclude("", "../top.h", has, "")).toBeNull();
    expect(findQuotedInclude("p", "missing.h", has, "p")).toBeNull();
  });

  it("uses the PCH only for C++ units that reach bits/stdc++.h", () => {
    expect(wantsPch({ path: "p/main.cpp", lang: "cpp" }, files, "p")).toBe(true);
    expect(wantsPch({ path: "p/other.cpp", lang: "cpp" }, files, "p")).toBe(true);
    expect(wantsPch({ path: "p/plain.cpp", lang: "cpp" }, files, "p")).toBe(false);
    expect(wantsPch({ path: "p/main.cpp", lang: "c" }, files, "p")).toBe(false);
  });

  it("leaves the PCH out when a macro is defined before bits/stdc++.h (it is loaded before line 1)", () => {
    const want = (spec: Record<string, string>) => wantsPch({ path: "q/main.cpp", lang: "cpp" }, map(spec), "q");
    const BITS = "#include <bits/stdc++.h>\n";
    // #define NDEBUG first must still turn assert() off, which a PCH built without it can't do.
    expect(want({ "q/main.cpp": `#define NDEBUG\n${BITS}int main() {}\n` })).toBe(false);
    expect(want({ "q/main.cpp": `#undef assert\n${BITS}` })).toBe(false);
    expect(want({ "q/main.cpp": `#pragma pack(1)\n${BITS}` })).toBe(false);
    expect(want({ "q/main.cpp": `#ifdef LOCAL\n${BITS}#endif\n` })).toBe(false); // conditional include
    expect(want({ "q/main.cpp": `#ifdef LOCAL\n#include "all.h"\n#endif\n`, "q/all.h": BITS })).toBe(false);
    expect(want({ "q/main.cpp": `#define _CRT_SECURE_NO_WARNINGS\n#include "common.h"\n`, "q/common.h": BITS })).toBe(false);
    expect(want({ "q/main.cpp": `#include "macros.h"\n${BITS}`, "q/macros.h": "#pragma once\n#define int long long\n" })).toBe(false);
    // Macros after the include, other library headers, guards, #pragma once and comments are fine.
    expect(want({ "q/main.cpp": `// solution\n#include <iostream>\n${BITS}#define ll long long\nint main() {}\n` })).toBe(true);
    expect(want({ "q/main.cpp": `#include "decls.h"\n#include "common.h"\n`, "q/decls.h": "#pragma once\n#ifdef __cplusplus\nint f();\n#endif\n", "q/common.h": `#ifndef COMMON_H\n#define COMMON_H\n${BITS}#endif\n` })).toBe(true);
    // A guard-shaped pair in the unit itself is a real definition.
    expect(want({ "q/main.cpp": `#ifndef NDEBUG\n#define NDEBUG\n#endif\n${BITS}` })).toBe(false);
  });
});

describe("source scanning", () => {
  it("blanks comments, strings and characters but keeps offsets and lines", () => {
    const src = 'int a = 1; // main(\n/* int main( */ char c = \'"\'; const char *s = "x\\"y"; auto r = R"x(int main()";)x"; int n = 1\'000;\n';
    const code = stripCommentsAndStrings(src);
    expect(code).toHaveLength(src.length);
    expect(code.split("\n")).toHaveLength(src.split("\n").length);
    expect(code).not.toMatch(/main|"x|\(int/);
    expect(code).toContain("int n = 1'000;");
    expect(stripComments(src)).toContain('"x\\"y"');
  });

  it("finds main, quoted includes and bits/stdc++.h outside comments", () => {
    expect(definesMain("int main(void) {}")).toBe(true);
    expect(definesMain("signed main() {}")).toBe(true);
    expect(definesMain("// int main()\nint maine(void);")).toBe(false);
    expect(quotedIncludes('#include "a.h"\n  #  include "dir//b.h"\n// #include "c.h"\n#include <d.h>\n')).toEqual(["a.h", "dir//b.h"]);
    expect(includesBits("#include<bits/stdc++.h>")).toBe(true);
    expect(includesBits("/* #include <bits/stdc++.h> */")).toBe(false);
  });
});

describe("depfiles", () => {
  it("reads prerequisites with continuations, escaped spaces and $$", () => {
    expect(parseDepfile("obj: /w/p/main.c /w/p/util.h \\\n  /w/p/inc/../a.h\n")).toEqual(["/w/p/main.c", "/w/p/util.h", "/w/p/a.h"]);
    expect(parseDepfile("obj: /w/my\\ prog/main.c /w/my\\ prog/my\\ util.h /w/cost$$.h\n")).toEqual(["/w/my prog/main.c", "/w/my prog/my util.h", "/w/cost$.h"]);
    expect(parseDepfile("")).toEqual([]);
  });

  it("normalises memfs paths", () => {
    expect(normalizeMemfsPath("/w/p/src/../inc//./a.h")).toBe("/w/p/inc/a.h");
    expect(normalizeMemfsPath("main.c")).toBe("/main.c");
  });
});
