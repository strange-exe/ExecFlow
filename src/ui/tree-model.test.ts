import { describe, expect, it } from "vitest";
import type { EntryMeta } from "../core/types";
import { ancestors, buildTree, checkName, targetFolder, typeAhead, visibleRows } from "./tree-model";

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
