import { afterEach, describe, expect, it } from "vitest";
import { emptyTree, fileAt, putFile } from "./clang-tree";

const bytes = (s: string) => new TextEncoder().encode(s);
const proto = Object.prototype as unknown as Record<string, unknown>;

describe("the compiler's file trees", () => {
  afterEach(() => {
    for (const k of ["remove", "x.c", "constructor.h"]) if (Object.hasOwn(proto, k)) delete proto[k];
  });

  it("puts files in folders it creates, and reads them back", () => {
    const tree = emptyTree();
    putFile(tree, "/w/lab/main.c", "int main(void) { return 0; }\n");
    putFile(tree, "/w/lab/util.h", bytes("#pragma once\n"));
    expect(new TextDecoder().decode(fileAt(tree, "/w/lab/main.c")!)).toBe("int main(void) { return 0; }\n");
    expect(fileAt(tree, "/w/lab/util.h")).toEqual(bytes("#pragma once\n"));
    expect(fileAt(tree, "/w/lab")).toBeNull();
    expect(fileAt(tree, "/w/nope.c")).toBeNull();
  });

  it("treats __proto__ and constructor as names: nothing lands on Object.prototype", () => {
    const tree = emptyTree();
    putFile(tree, "/w/__proto__/remove", bytes("1"));
    putFile(tree, "/w/__proto__", bytes("2")); // a file with that name beside nothing else
    putFile(tree, "/__proto__/x.c", bytes("3"));
    putFile(tree, "/w/constructor/constructor.h", bytes("4"));
    expect(Object.hasOwn(proto, "remove")).toBe(false);
    expect(Object.hasOwn(proto, "x.c")).toBe(false);
    expect(Object.hasOwn(proto, "constructor.h")).toBe(false);
    expect(({} as Record<string, unknown>).remove).toBeUndefined();
    expect(fileAt(tree, "/__proto__/x.c")).toEqual(bytes("3"));
    expect(fileAt(tree, "/w/constructor/constructor.h")).toEqual(bytes("4"));
    expect(fileAt(tree, "/w/toString")).toBeNull(); // inherited names are not files
  });
});
