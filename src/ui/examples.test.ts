// freeName (examples.ts): a taken name gets "-2", "-3"... and the result is always a name storage
// accepts, so a long shared or example name that is taken can still be added.
import { describe, expect, it } from "vitest";
import { tryNormalizePath } from "../core/paths";
import { freeName } from "./examples";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("freeName", () => {
  it("shortens the stem of a 255-byte name, so the free name is still at most 255 bytes", () => {
    const name = "a".repeat(252) + ".py";
    const taken = new Set([name]);
    const free = freeName(name, (p) => taken.has(p));
    expect(free).toBe("a".repeat(250) + "-2.py");
    expect(bytes(free)).toBeLessThanOrEqual(255);
    expect(tryNormalizePath(free)).toBe(free);
  });

  it("skips numbers that are taken after shortening too", () => {
    const name = "a".repeat(252) + ".py";
    const taken = new Set([name, "a".repeat(250) + "-2.py", "a".repeat(250) + "-3.py"]);
    expect(freeName(name, (p) => taken.has(p))).toBe("a".repeat(250) + "-4.py");
  });

  it("a name that is almost all extension is cut as a whole", () => {
    const name = "a." + "b".repeat(253);
    const free = freeName(name, (p) => p === name);
    expect(tryNormalizePath(free)).toBe(free);
    expect(free.endsWith("-2")).toBe(true);
  });

  it("shortens by whole characters, never splitting one", () => {
    // 85 three-byte characters: 255 bytes, no extension.
    const name = String.fromCodePoint(0x928).repeat(85);
    const free = freeName(name, (p) => p === name);
    expect(bytes(free)).toBeLessThanOrEqual(255);
    expect(tryNormalizePath(free)).toBe(free);
    expect(free).toBe(String.fromCodePoint(0x928).repeat(84) + "-2");
  });
});
