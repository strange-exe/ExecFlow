import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../core/types";
import { memfsPath, planProgram, quoteDir, unitLanguage } from "./program";

const MAIN = "int main(void) { return 0; }\n";
const LIB = "int helper(void) { return 1; }\n";
const files = (spec: Record<string, string>): WorkspaceFile[] => Object.entries(spec).map(([path, text]) => ({ path, text }));
const plan = (entry: string, spec: Record<string, string>) => {
  const r = planProgram(entry, files(spec));
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
};

describe("which files make up a C/C++ program", () => {
  it("builds the entry with the other sources of its folder, entry first", () => {
    const p = plan("calc/main.c", { "calc/ops.c": LIB, "calc/main.c": MAIN, "calc/ops.h": "int helper(void);\n", "other/x.c": LIB });
    expect(p.root).toBe("calc");
    expect(p.units).toEqual([{ path: "calc/main.c", lang: "c" }, { path: "calc/ops.c", lang: "c" }]);
    expect(p.skipped).toEqual([]);
    // Every C/C++ file is mounted, so includes across folders work; only the units are compiled.
    expect(p.mounted.map((f) => f.path).sort()).toEqual(["calc/main.c", "calc/ops.c", "calc/ops.h", "other/x.c"]);
  });

  it("leaves out other files with their own main() and says which", () => {
    const p = plan("lab/ex2.c", { "lab/ex1.c": MAIN, "lab/ex2.c": MAIN, "lab/ex3.cpp": "int main() {}\n", "lab/common.c": LIB });
    expect(p.units.map((u) => u.path)).toEqual(["lab/ex2.c", "lab/common.c"]);
    expect(p.skipped).toEqual(["lab/ex1.c", "lab/ex3.cpp"]);
  });

  it("includes sub-folders, but not ones that hold their own program, dot-folders or conflict copies", () => {
    const p = plan("main.cpp", {
      "main.cpp": "int main() {}\n",
      "src/a.cpp": LIB,
      "src/deep/b.cc": LIB,
      "tests/test_a.cpp": "int main() { return 0; }\n",
      "tests/helper.cpp": LIB,
      ".vscode/scratch.c": LIB,
      "src/a.conflict-20261017-090503.cpp": LIB,
      "README.md": "# hi\n",
    });
    expect(p.root).toBe("");
    expect(p.units).toEqual([
      { path: "main.cpp", lang: "cpp" },
      { path: "src/a.cpp", lang: "cpp" },
      { path: "src/deep/b.cc", lang: "cpp" },
    ]);
    expect(p.skipped).toEqual([]);
    expect(p.mounted.some((f) => f.path.includes(".conflict-"))).toBe(false);
    expect(p.mounted.some((f) => f.path === "README.md")).toBe(false);
  });

  it("does not count main in comments or strings", () => {
    const p = plan("a/main.c", { "a/main.c": MAIN, "a/util.c": '/* int main(void) */\nconst char *s = "int main(";\n' + LIB });
    expect(p.units.map((u) => u.path)).toEqual(["a/main.c", "a/util.c"]);
  });

  it("refuses headers and other files as entries", () => {
    expect(planProgram("a/util.h", files({ "a/util.h": "" }))).toMatchObject({ ok: false, reason: expect.stringContaining("header") });
    expect(planProgram("notes.txt", files({ "notes.txt": "" }))).toMatchObject({ ok: false });
    expect(planProgram("a/missing.c", files({}))).toMatchObject({ ok: false });
  });

  it("can run a conflict copy on purpose, on its own", () => {
    const p = plan("main.conflict-20261017-090503.c", { "main.c": MAIN, "main.conflict-20261017-090503.c": MAIN });
    expect(p.units.map((u) => u.path)).toEqual(["main.conflict-20261017-090503.c"]);
    expect(p.skipped).toEqual(["main.c"]);
  });

  it("knows unit languages and the compiler's paths", () => {
    expect(["a.c", "a.cpp", "a.cc", "a.cxx", "a.c++", "a.h", "a.hpp", "a.py"].map(unitLanguage)).toEqual(["c", "cpp", "cpp", "cpp", "cpp", null, null, null]);
    expect(memfsPath("my prog/main.c")).toBe("/w/my prog/main.c");
    expect(quoteDir("")).toBe("/w");
    expect(quoteDir("a/b", "/w2")).toBe("/w2/a/b");
  });
});
