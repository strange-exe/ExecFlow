import { describe, expect, it } from "vitest";
import { PathError, conflictName, foldKey, isConflictCopy, isInside, joinPath, nameOf, normalizePath, parentOf, splitExtension, tryNormalizePath } from "./paths";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe("normalizePath", () => {
  it("accepts ordinary nested paths, dotfiles and non-Latin names", () => {
    expect(normalizePath("lab-07/marks.c")).toBe("lab-07/marks.c");
    expect(normalizePath(".gitignore")).toBe(".gitignore");
    expect(normalizePath("notes/" + cp(0x928, 0x94b, 0x91f) + ".txt")).toBe("notes/" + cp(0x928, 0x94b, 0x91f) + ".txt");
  });

  it("returns the NFC form, so the same name typed two ways is one file", () => {
    expect(normalizePath("caf" + "e" + cp(0x301) + ".py")).toBe("caf" + cp(0xe9) + ".py");
  });

  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["a/", "trailing slash"],
    ["a//b", "empty segment"],
    ["../x.py", "parent segment"],
    ["a/./b", "dot segment"],
    [".git/config", ".git folder"],
    ["src/.GIT/hooks", ".git in any case"],
    ["a" + String.fromCharCode(92) + "b.c", "backslash"],
    ["a:b.c", "colon"],
    ["what?.py", "question mark"],
    ["main.py.", "trailing dot"],
    ["main.py ", "trailing space"],
    ["con.py", "reserved name"],
    ["lab/LPT1", "reserved name in a folder"],
    ["a" + cp(0x0a) + "b", "line feed"],
    ["main" + cp(0x202e) + "yp.exe", "Trojan Source"],
    ["ma" + cp(0x200b) + "in.py", "zero-width space"],
    ["x".repeat(256), "segment over 255 bytes"],
    [Array(33).fill("d").join("/"), "too deep"],
  ])("refuses %j (%s)", (input) => {
    expect(() => normalizePath(input)).toThrow(PathError);
    expect(tryNormalizePath(input)).toBeNull();
  });

  it("counts segment length in UTF-8 bytes", () => {
    expect(() => normalizePath(cp(0x928).repeat(85))).not.toThrow(); // 255 bytes
    expect(() => normalizePath(cp(0x928).repeat(86))).toThrow(PathError); // 258 bytes
  });

  it("a reserved name over 255 bytes is refused for its length, so the message never quotes it", () => {
    const long = "con." + "a".repeat(300);
    expect(() => normalizePath(long)).toThrow("a name is too long");
    expect(() => normalizePath("con.py")).toThrow('"con.py" is a reserved name on Windows');
  });

  it("checks the global hidden-character regex the same way every time", () => {
    const bad = "a" + cp(0x2060) + "b";
    expect(tryNormalizePath(bad)).toBeNull();
    expect(tryNormalizePath(bad)).toBeNull();
    expect(tryNormalizePath(bad)).toBeNull();
  });
});

describe("path helpers", () => {
  it("split and join", () => {
    expect(parentOf("a/b/c.py")).toBe("a/b");
    expect(parentOf("c.py")).toBe("");
    expect(nameOf("a/b/c.py")).toBe("c.py");
    expect(joinPath("", "c.py")).toBe("c.py");
    expect(joinPath("a", "c.py")).toBe("a/c.py");
    expect(splitExtension(".bashrc")).toEqual({ stem: ".bashrc", ext: "" });
    expect(splitExtension("a.tar.gz")).toEqual({ stem: "a.tar", ext: ".gz" });
  });

  it("isInside does not confuse sibling prefixes", () => {
    expect(isInside("lab/x.c", "lab")).toBe(true);
    expect(isInside("lab", "lab")).toBe(true);
    expect(isInside("lab2/x.c", "lab")).toBe(false);
    expect(isInside("anything", "")).toBe(true);
  });

  it("foldKey finds case-only collisions", () => {
    expect(foldKey("Main.py")).toBe(foldKey("main.PY"));
  });
});

describe("conflict copies", () => {
  const when = new Date(2026, 9, 17, 9, 5, 3);

  it("keeps the extension and folder, and counts up when the name is taken", () => {
    expect(conflictName("lab/marks.c", when, () => false)).toBe("lab/marks.conflict-20261017-090503.c");
    const taken = new Set(["lab/marks.conflict-20261017-090503.c"]);
    expect(conflictName("lab/marks.c", when, (p) => taken.has(p))).toBe("lab/marks.conflict-20261017-090503-2.c");
    expect(conflictName("Makefile", when, () => false)).toBe("Makefile.conflict-20261017-090503");
  });

  it("are recognised so builds can skip them", () => {
    expect(isConflictCopy("lab/marks.conflict-20261017-090503.c")).toBe(true);
    expect(isConflictCopy("lab/marks.conflict-20261017-090503-2.c")).toBe(true);
    expect(isConflictCopy("Makefile.conflict-20261017-090503")).toBe(true);
    expect(isConflictCopy("lab/marks.c")).toBe(false);
    expect(isConflictCopy("lab/conflict-notes.c")).toBe(false);
  });
});
