import { describe, expect, it } from "vitest";
import type { EntryMeta } from "../core/types";
import { LANGUAGES } from "../core/languages";
import { ancestors, buildTree, checkName, conflictNameParts, newFileNote, starterText, targetFolder, typeAhead, visibleRows } from "./tree-model";

const entry = (path: string, kind: "file" | "dir" = "file", opaque = false): EntryMeta => ({
  path, kind, size: 0, mtime: 0, eol: "\n", bom: false, localSha: null, baseSha: null, ...(opaque ? { opaque: { sha: "a".repeat(40), mode: "100644" } } : {}),
});

const sample = [
  entry("src", "dir"), entry("src/util.c"), entry("src/util.h"), entry("main.c"), entry("file10.py"), entry("file2.py"),
  entry("data", "dir"), entry("data/logo.png", "file", true), entry("main.conflict-20261017-101500.c"), entry("Notes.txt"),
];

describe("buildTree", () => {
  it("puts folders first and sorts names the way people do (file2 before file10, ignoring case)", () => {
    expect(buildTree(sample).map((n) => n.name)).toEqual(["data", "src", "file2.py", "file10.py", "main.c", "main.conflict-20261017-101500.c", "Notes.txt"]);
  });

  it("nests children, records levels, and flags read-only and conflict copies", () => {
    const roots = buildTree(sample);
    const src = roots.find((n) => n.path === "src")!;
    expect(src.children.map((n) => n.path)).toEqual(["src/util.c", "src/util.h"]);
    expect(src.children[0].level).toBe(2);
    expect(roots.find((n) => n.path === "data")!.children[0].opaque).toBe(true);
    expect(roots.find((n) => n.name.includes("conflict"))!.conflict).toBe(true);
  });

  it("attaches an entry whose folder is missing to the top level instead of losing it", () => {
    expect(buildTree([entry("lost/x.py")]).map((n) => n.path)).toEqual(["lost/x.py"]);
  });
});

describe("visibleRows and type-ahead", () => {
  const roots = buildTree(sample);

  it("shows only what is inside expanded folders", () => {
    expect(visibleRows(roots, new Set()).length).toBe(7);
    expect(visibleRows(roots, new Set(["src"])).map((n) => n.path)).toContain("src/util.h");
  });

  it("finds the next row by its first letters, wrapping around", () => {
    const rows = visibleRows(roots, new Set());
    const main = rows.findIndex((r) => r.name === "main.c");
    expect(typeAhead(rows, -1, "m")).toBe(main);
    expect(typeAhead(rows, main, "m")).toBe(main + 1); // the same letter again: the next match
    expect(typeAhead(rows, main + 1, "m")).toBe(main); // and around
    expect(typeAhead(rows, 0, "no")).toBe(rows.findIndex((r) => r.name === "Notes.txt"));
    expect(typeAhead(rows, 0, "zzz")).toBe(-1);
  });
});

describe("names typed in the tree", () => {
  const existing = sample.map((e) => e.path);

  it("accepts a new name, and a path that makes folders on the way", () => {
    expect(checkName("", "hello.py", existing)).toEqual({ ok: true, path: "hello.py" });
    expect(checkName("src", "lib/math.c", existing)).toEqual({ ok: true, path: "src/lib/math.c" });
  });

  it("explains what is wrong, as a sentence", () => {
    for (const [typed, error] of [
      ["", /Type a name/],
      ["a//b.py", /empty/],
      ["../x.py", /can't be used/],
      ["con.c", /reserved/],
      ["what?.py", /can't contain/],
      ["main.c", /already called "main.c"/],
      ["MAIN.C", /differ only in capitals/],
    ] as const) {
      const r = checkName("", typed, existing);
      expect(r.ok, typed).toBe(false);
      if (!r.ok) {
        expect(r.error, typed).toMatch(error);
        expect(r.error, typed).toMatch(/^[A-Z"].*[.]$/);
      }
    }
  });

  it("lets a rename change only the letter case, but not move a folder into itself", () => {
    expect(checkName("", "Main.c", existing, "main.c")).toEqual({ ok: true, path: "Main.c" });
    expect(checkName("", "src/inner", existing, "src").ok).toBe(false);
  });
});

describe("helpers", () => {
  it("lists the folders above a path and picks where New file goes", () => {
    expect(ancestors("a/b/c.py")).toEqual(["a", "a/b"]);
    expect(targetFolder(null)).toBe("");
    expect(targetFolder({ path: "src", kind: "dir" })).toBe("src");
    expect(targetFolder({ path: "src/util.c", kind: "file" })).toBe("src");
  });
});

describe("conflict copy names", () => {
  it("split before the time, so a cut name still shows when the copy was made and its extension", () => {
    expect(conflictNameParts("main.conflict-20261024-231921.py")).toEqual({ stem: "main.conflict-20261024-", tail: "231921.py" });
    expect(conflictNameParts("lab1/marks.conflict-20261017-090503-2.c")).toEqual({ stem: "marks.conflict-20261017-", tail: "090503-2.c" });
    expect(conflictNameParts("notes.conflict-20261017-090503")).toEqual({ stem: "notes.conflict-20261017-", tail: "090503" });
    // The parts are the name, exactly: nothing added or lost.
    for (const name of ["main.conflict-20261024-231921.py", "a.b.conflict-20261024-231921-12.cpp"]) {
      const parts = conflictNameParts(name)!;
      expect(parts.stem + parts.tail).toBe(name);
    }
  });

  it("leaves every other name whole", () => {
    for (const name of ["main.py", "conflict-20261024-231921.py", "main.conflict.py", "x.conflict-2026-231921.py"]) expect(conflictNameParts(name), name).toBeNull();
  });
});

describe("new file names", () => {
  it("say nothing for a file that runs", () => {
    for (const name of ["main.py", "lab1/main.c", "a.cpp", "b.cc", "c.cxx", "d.c++", "e.pyw", "MAIN.PY"]) expect(newFileNote(name), name).toBeNull();
  });

  it("say before creating that a name without an extension won't run, and ask for Enter again", () => {
    const note = newFileNote("hello")!;
    expect(note.bare).toBe(true);
    expect(note.text).toMatch(/no extension/i);
    expect(note.text).toMatch(/\.py, \.c or \.cpp/);
    expect(note.confirm).toMatch(/Enter again/);
    // A hidden-file name and a trailing dot have no extension either.
    expect(newFileNote(".env")?.bare).toBe(true);
    expect(newFileNote("lab1/notes")?.bare).toBe(true);
  });

  it("say that other files don't run, without asking again (a data file is a deliberate choice)", () => {
    const text = newFileNote("input.txt")!;
    expect(text.bare).toBe(false);
    expect(text.text).toMatch(/won't run/);
    const header = newFileNote("util.h")!;
    expect(header.bare).toBe(false);
    expect(header.text).toMatch(/header/i);
    expect(newFileNote("main.")?.bare).toBe(false);
  });
});

describe("a new file's first text", () => {
  const sample = (id: string) => LANGUAGES.find((l) => l.id === id)!.sample;

  it("is the empty-state starter for a runnable language", () => {
    expect(starterText("hello.py", [])).toBe(sample("python"));
    expect(starterText("lab1/main.c", ["main.py", "lab1"])).toBe(sample("c"));
    expect(starterText("ex.cc", [])).toBe(sample("cpp"));
  });

  it("is empty beside another file of the same program (a C helper beside main.c, a Python module beside main.py)", () => {
    // C and C++ sources in one folder build together: a second main() would leave the helper out.
    expect(starterText("lab1/util.c", ["lab1", "lab1/main.c"])).toBe("");
    expect(starterText("lab1/util.cpp", ["lab1", "lab1/main.c"])).toBe("");
    expect(starterText("helpers.py", ["main.py"])).toBe("");
    // Another folder, or another language, is another program.
    expect(starterText("lab2/main.c", ["lab1/main.c"])).toBe(sample("c"));
    expect(starterText("main.py", ["main.c"])).toBe(sample("python"));
    // Conflict copies are never part of a program.
    expect(starterText("main.c", ["main.conflict-20261024-231921.c"])).toBe(sample("c"));
  });

  it("is empty for a package's __init__.py and other dunder files (package plumbing: __init__.py runs on import)", () => {
    expect(starterText("shapes/__init__.py", [])).toBe("");
    expect(starterText("__main__.py", [])).toBe("");
  });

  it("is empty for anything that doesn't run", () => {
    for (const name of ["notes.txt", "util.h", "README", "data/in.csv"]) expect(starterText(name, []), name).toBe("");
  });
});
