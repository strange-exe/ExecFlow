import { describe, expect, it } from "vitest";
import { LIGHTBULB_SOURCE } from "./error-help-view";
import { pathData } from "./icons";

describe("the error help's lightbulb", () => {
  // The same rule as icons.test.ts: drawn from path data only, nothing else that could be lost or let in.
  it("is drawn from path data only", () => {
    expect(LIGHTBULB_SOURCE).toMatch(/^<svg [^>]*viewBox="0 0 256 256"/);
    const tags = [...LIGHTBULB_SOURCE.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "path"]));
    expect(pathData(LIGHTBULB_SOURCE).length).toBeGreaterThan(0);
    for (const d of pathData(LIGHTBULB_SOURCE)) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
  });
});
