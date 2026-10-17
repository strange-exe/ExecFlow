import { describe, expect, it } from "vitest";
import { ACCEPTED_EXTENSIONS, detectLanguage, extensionOf } from "./languages";

describe("extensionOf", () => {
  it.each([
    ["main.py", ".py"],
    ["MAIN.PY", ".py"],
    ["archive.tar.gz", ".gz"],
    ["  spaced.cpp  ", ".cpp"],
    ["noext", ""],
    [".hidden", ""],
    ["trailing.", "."],
  ])("%s -> %s", (name, ext) => {
    expect(extensionOf(name)).toBe(ext);
  });
});

describe("detectLanguage", () => {
  it.each([
    ["a.py", "python"],
    ["a.pyw", "python"],
    ["a.c", "c"],
    ["a.C", "c"],
    ["a.cpp", "cpp"],
    ["a.cc", "cpp"],
    ["a.cxx", "cpp"],
    ["a.c++", "cpp"],
  ])("%s is %s", (name, id) => {
    expect(detectLanguage(name)?.id).toBe(id);
  });

  it.each(["a.js", "a.h", "a.txt", "README", "a.py.bak"])("%s is unsupported", (name) => {
    expect(detectLanguage(name)).toBeNull();
  });
});

it("accepts every registered extension in the file picker", () => {
  expect(ACCEPTED_EXTENSIONS.split(",")).toEqual([".py", ".pyw", ".c", ".cpp", ".cc", ".cxx", ".c++"]);
});
