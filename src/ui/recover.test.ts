import { describe, expect, it } from "vitest";
import { decodeStash, encodeStash, MAX_STASH_CHARS, textHash } from "./recover";

describe("textHash", () => {
  it("tells texts apart and is stable", () => {
    expect(textHash("a = 1\n")).toBe(textHash("a = 1\n"));
    expect(textHash("a = 1\n")).not.toBe(textHash("a = 2\n"));
    expect(textHash("")).toMatch(/^0:/);
    expect(textHash("ab")).not.toBe(textHash("ba"));
  });
});

describe("the recovery stash", () => {
  const file = { path: "src/main.py", base: textHash("a = 1\n"), text: "a = 1\nb = 2" };

  it("round-trips", () => {
    expect(decodeStash(encodeStash([file]))).toEqual([file]);
  });

  it("stores nothing for no files, and stops before the size cap", () => {
    expect(encodeStash([])).toBeNull();
    const big = { ...file, text: "x".repeat(MAX_STASH_CHARS) };
    expect(decodeStash(encodeStash([file, big]))).toEqual([file]);
    expect(encodeStash([{ ...big, text: "x".repeat(MAX_STASH_CHARS + 1) }])).toBeNull();
  });

  it("keeps only well-formed entries with clean paths, once each", () => {
    const raw = JSON.stringify({
      v: 1,
      files: [file, file, { path: "../escape.py", base: "x", text: "" }, { path: "/abs.py", base: "x", text: "" }, { path: "ok.py", base: 1, text: "" }, null, "x"],
    });
    expect(decodeStash(raw)).toEqual([file]);
    expect(decodeStash("not json")).toEqual([]);
    expect(decodeStash(JSON.stringify({ v: 2, files: [file] }))).toEqual([]);
    expect(decodeStash(null)).toEqual([]);
  });
});
