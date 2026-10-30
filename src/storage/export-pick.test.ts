import { describe, expect, it } from "vitest";
import { pickExport, zipBase, zipName } from "./export-pick";
import type { ExportData } from "./workspace";

const file = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text), mtime: 0 });
const DATA: ExportData = {
  files: [
    file("lab1/main.c", "int main(void) { return 0; }\n"),
    file("lab1/util.h", "#pragma once\n"),
    file("lab1/data/in.txt", "3 4\n"),
    file("lab10/main.c", "x\n"),
    file("notes.txt", "hello\n"),
    file("a/b/lab/main.py", "print(1)\n"),
  ],
  dirs: ["lab1/empty", "spare"],
  skipped: ["lab1/logo.png"],
};
const paths = (d: ExportData) => d.files.map((f) => f.path);

describe("what a pick of files and folders covers", () => {
  it("a folder covers everything under it, and nothing that only starts with its name", () => {
    const d = pickExport(DATA, ["lab1"]);
    expect(paths(d)).toEqual(["lab1/main.c", "lab1/util.h", "lab1/data/in.txt"]);
    expect(d.dirs).toEqual(["lab1/empty"]);
    expect(d.skipped).toEqual(["lab1/logo.png"]); // read-only GitHub files are named, not dropped silently
  });

  it("files and folders together, each once, in the workspace's order", () => {
    expect(paths(pickExport(DATA, ["notes.txt", "lab1/util.h", "lab1", "notes.txt"]))).toEqual(["lab1/main.c", "lab1/util.h", "lab1/data/in.txt", "notes.txt"]);
    expect(pickExport(DATA, ["spare"]).dirs).toEqual(["spare"]); // an empty folder is still a folder
    expect(paths(pickExport(DATA, []))).toEqual([]);
  });

  it("the zip starts at the folder that holds the pick, so it unpacks to one folder", () => {
    expect(zipBase(["a/b/lab"])).toBe("a/b");
    expect(zipBase(["lab1"])).toBe("");
    expect(zipBase(["lab1/main.c", "lab1/util.h"])).toBe("lab1");
    expect(zipBase(["lab1/main.c", "lab1/data/in.txt"])).toBe("lab1");
    expect(zipBase(["lab1", "notes.txt"])).toBe("");
    expect(zipBase(["lab1/main.c", "lab10/main.c"])).toBe(""); // "lab1" is not a folder of "lab10"
    const d = pickExport(DATA, ["a/b/lab"], zipBase(["a/b/lab"]));
    expect(paths(d)).toEqual(["lab/main.py"]);
    expect(pickExport(DATA, ["lab1/main.c", "lab1/data/in.txt"], "lab1").files.map((f) => f.path)).toEqual(["main.c", "data/in.txt"]);
  });

  it("names the zip after the one folder picked, the folder holding the pick, or the workspace", () => {
    expect(zipName(["a/b/lab"], "My work")).toBe("lab.zip");
    expect(zipName(["lab1/main.c", "lab1/util.h"], "My work")).toBe("lab1.zip");
    expect(zipName(["lab1", "notes.txt"], "My work")).toBe("My-work.zip");
    expect(zipName(["lab1", "notes.txt"], "***")).toBe("files.zip");
  });
});
