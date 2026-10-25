import { describe, expect, it } from "vitest";
import { sizeModel } from "./splitter";

describe("sizeModel", () => {
  it("keeps the wanted size apart from the applied one: a window too small applies less, and the wanted size comes back with room", () => {
    let max = 480;
    const size = sizeModel({ min: 200, max: () => max, wanted: 248 });
    expect([size.wanted, size.value]).toEqual([248, 248]);
    // A phone-wide window (390 px: max(200, 390 - 360) = 200).
    max = 200;
    expect([size.wanted, size.value]).toEqual([248, 200]);
    // Wide again: the width the user had, not the one the narrow window allowed.
    max = 480;
    expect([size.wanted, size.value]).toEqual([248, 248]);
  });

  it("a user's choice becomes the wanted size, as far as the window allows it then", () => {
    let max = 480;
    const size = sizeModel({ min: 200, max: () => max, wanted: 248 });
    expect(size.set(320)).toBe(320);
    expect([size.wanted, size.value]).toEqual([320, 320]);
    expect(size.set(900)).toBe(480);
    expect(size.set(10)).toBe(200);
    max = 300;
    expect(size.value).toBe(200);
    expect(size.set(400)).toBe(300);
    max = 480;
    expect([size.wanted, size.value]).toEqual([300, 300]);
  });

  it("rounds, and a max below the min never applies less than the min", () => {
    const size = sizeModel({ min: 200, max: () => 120, wanted: 248.6 });
    expect(size.value).toBe(200);
    expect(size.wanted).toBe(249);
  });
});
