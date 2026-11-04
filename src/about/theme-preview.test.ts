import { describe, expect, it } from "vitest";
import { BUILT_IN } from "../theme/themes";
import { firstPreview, previewThemes, shortName } from "./theme-preview";

describe("the About page's theme preview", () => {
  it("lists every built-in look once, never a match-device entry", () => {
    const list = previewThemes(BUILT_IN);
    expect(list.some((t) => t.system)).toBe(false);
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    expect(list.length).toBe(BUILT_IN.length - BUILT_IN.filter((t) => t.system).length);
  });

  it("names a theme without the product's prefix", () => {
    expect(shortName(BUILT_IN.find((t) => t.id === "signal-dark")!)).toBe("Signal Dark");
    expect(shortName(BUILT_IN.find((t) => t.id === "nord")!)).toBe("Nord");
  });

  it.each([
    [null, "light", "signal-light"],
    [null, "dark", "signal-dark"],
    ["nord", "light", "nord"],
    ["github-light", "dark", "github-light"],
    // A match-device choice shows its variant in the page's scheme.
    ["signal", "dark", "signal-dark"],
    ["deep-field", "light", "deep-field-light"],
    ["system", "dark", "slate-dark"],
    // A custom theme's id or a damaged value is not in the list.
    ["custom-1a2b", "light", "signal-light"],
    ["<img src=x onerror=alert(1)>", "dark", "signal-dark"],
  ] as const)("shows %s first on a %s page as %s", (chosen, scheme, want) => {
    expect(firstPreview(BUILT_IN, chosen, scheme)).toBe(want);
  });
});
