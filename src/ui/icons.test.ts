import { describe, expect, it } from "vitest";
import { ICON_NAMES, iconSource, pathData } from "./icons";

describe("inlined Phosphor icons", () => {
  it.each(ICON_NAMES)("%s is drawn from path data only", (name) => {
    const source = iconSource(name);
    expect(source).toMatch(/^<svg [^>]*viewBox="0 0 256 256"/);
    expect(pathData(source).length).toBeGreaterThan(0);
    // No other shapes, scripts or links that drawing only <path d> would silently lose or let in.
    const tags = [...source.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "path"]));
    for (const d of pathData(source)) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
  });
});
