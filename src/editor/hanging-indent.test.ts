import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hangColumns, hangStyle } from "./hanging-indent";
import { CHROME_SPEC } from "./highlight";

describe("hanging indent", () => {
  it("hangs two columns past the line's own indent, tabs counted to the tab size", () => {
    expect(hangColumns("print(1)", 4)).toBe(2);
    expect(hangColumns("    print(1)", 4)).toBe(6);
    expect(hangColumns("\tprint(1)", 4)).toBe(6);
    expect(hangColumns("  \tx", 4)).toBe(6);
    expect(hangColumns("", 4)).toBe(2);
    expect(hangColumns("        ", 4)).toBe(10);
  });

  it("marks the line with its hang; app.css (below 900 px) pads by it and cancels it on the first row", () => {
    expect(hangStyle(6)).toBe("--hang: 6ch");
    const css = readFileSync("src/styles/app.css", "utf8");
    const rule = ".cm-content.cm-lineWrapping > .cm-line.cm-hang { padding-left: calc(8px + var(--hang)); text-indent: calc(var(--hang) * -1); }";
    const at = css.indexOf(rule);
    expect(at, "the rule").toBeGreaterThan(0);
    // Inside the phone block only: the nearest media query before it is the phone's.
    expect(css.slice(0, at).lastIndexOf("@media")).toBe(css.slice(0, at).lastIndexOf("@media (max-width: 899px) {"));
    // The 8 px is the editor theme's own left padding of a line, which the rule replaces.
    expect(CHROME_SPEC[".cm-line"].padding).toBe("0 12px 0 8px");
  });
});
