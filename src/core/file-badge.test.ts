import { describe, expect, it } from "vitest";
import { BADGE_LOOK, BADGE_WORDS, badgeKind, badgeWord } from "./file-badge";

describe("file badges", () => {
  it("knows every type the app opens, and nothing else", () => {
    expect(["a.py", "a.pyw", "a.c", "a.cpp", "a.cc", "a.cxx", "a.c++", "a.h", "a.hpp", "a.inc", "a.txt", "a.md", "a.json", "a.in", "a.out", "a.dat", "a.csv"].map(badgeKind)).toEqual([
      "python", "python", "c", "cpp", "cpp", "cpp", "cpp", "header", "header", "header", "text", "text", "text", "text", "text", "text", "text",
    ]);
    expect([".bashrc", "Makefile", "logo.png", "a.PY"].map(badgeKind)).toEqual([null, null, null, "python"]);
  });

  it("gives each look a word for every type, and the shown look's by default", () => {
    for (const look of ["sheet", "hue", "tile"] as const) {
      for (const kind of ["python", "c", "cpp", "header", "text"] as const) expect(BADGE_WORDS[look][kind]).toMatch(/^\S{1,3}$/);
    }
    expect(badgeWord("main.py")).toBe(BADGE_WORDS[BADGE_LOOK].python);
    expect(badgeWord("util.cpp", "tile")).toBe("C++");
    expect(badgeWord("Makefile")).toBe("");
  });
});
