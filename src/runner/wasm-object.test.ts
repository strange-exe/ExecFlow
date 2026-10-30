/// <reference types="node" />
// The symbol table of real objects compiled by LLVM 22 for wasm32-wasip1 (__fixtures__/main-objects.json).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { definedFunctions, definesMain } from "./wasm-object";

const fixture = JSON.parse(readFileSync("src/runner/__fixtures__/main-objects.json", "utf8")) as Record<string, { source: string; object: string }>;
const object = (label: string) => new Uint8Array(Buffer.from(fixture[label].object, "base64"));

describe("definedFunctions", () => {
  it("lists main under its WASI names", () => {
    expect(definedFunctions(object("c main(void)"))).toContain("__main_void");
    expect(definedFunctions(object("cpp main()"))).toContain("__main_void");
    expect(definedFunctions(object("c main(argc, argv)"))).toContain("__main_argc_argv");
    expect(definedFunctions(object("cpp main(argc, argv)"))).toContain("__main_argc_argv");
  });
  it("lists a helper's own functions, and not the functions it only calls", () => {
    expect(definedFunctions(object("c no main"))).toEqual(["helper"]);
    const caller = definedFunctions(object("c calls main"));
    expect(caller).toContain("again");
    expect(caller.some((n) => n.includes("main"))).toBe(false);
  });
  it("refuses bytes that aren't a WebAssembly object, and a cut-off one", () => {
    expect(() => definedFunctions(new TextEncoder().encode("int main(void) {}"))).toThrow(/not a WebAssembly object/);
    const whole = object("c main(void)");
    expect(() => definedFunctions(whole.slice(0, whole.length - 20))).toThrow(/wasm object/);
  });
});

describe("definesMain", () => {
  it("is true when any file defines main, either way", () => {
    expect(definesMain([object("c no main"), object("c main(void)")])).toBe(true);
    expect(definesMain([object("cpp main(argc, argv)")])).toBe(true);
  });
  it("is false for helpers alone, and for a file that only calls main", () => {
    expect(definesMain([object("c no main"), object("c calls main")])).toBe(false);
    expect(definesMain([])).toBe(false);
  });
});
