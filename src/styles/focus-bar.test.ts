/// <reference types="node" />
// plan-v2 P2: the editor's gutter-edge focus bar, one measured step quieter in Deep Field dark. The
// value in tokens.css is the brass at 70% over the code ground (the role stays: the student's hand),
// and it keeps 3:1 or more against every ground the bar is drawn on (WCAG 1.4.11 and 2.4.7): the
// code, the cursor's line and the error band. Light keeps --focus (its 4.62:1 on the error band
// leaves no room for a step down). Measured by .claude/verify/batch3/p/probes/focusbar.probe.spec.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHROME_SPEC } from "../editor/highlight";
import { contrast, over, resolve } from "../theme/contrast";
import { DEEP_FIELD } from "../theme/palettes";

const tokens = readFileSync("src/styles/tokens.css", "utf8");

describe("the editor's focus bar (--focus-bar)", () => {
  const rule = /:root\[data-theme="dark"\]:is\(\[data-theme-id="deep-field"\], \[data-theme-id="deep-field-dark"\]\) \{\s*--focus-bar: (#[0-9a-f]{6});\s*\}/.exec(tokens);

  it("is the focus colour everywhere but Deep Field dark, and the bar paints it", () => {
    expect(tokens).toMatch(/:root \{\s*--focus-bar: var\(--focus\);\s*\}/);
    expect(CHROME_SPEC["&.cm-focused .cm-gutters::after"].backgroundColor).toBe("var(--focus-bar)");
    expect(rule, "the Deep Field dark rule").not.toBeNull();
  });

  it("in Deep Field dark: brass at 70% over the code ground, 3:1 or more on every ground it meets", () => {
    const dark = DEEP_FIELD.dark;
    const bar = rule![1];
    for (const ground of ["bg", "active-line@bg", "error-band@bg"] as const) {
      expect(contrast(bar, resolve(dark, ground)), ground).toBeGreaterThanOrEqual(3);
    }
    expect(bar).toBe(over(dark.bg, dark.focus, 0.7));
    // A step down from the focus colour itself, not a new colour role.
    expect(contrast(bar, dark.bg)).toBeLessThan(contrast(dark.focus, dark.bg) * 0.6);
  });

  it("light keeps the focus colour: a step down there would fail 3:1 on the error band", () => {
    const light = DEEP_FIELD.light;
    expect(contrast(light.focus, resolve(light, "error-band@bg"))).toBeGreaterThanOrEqual(3);
    expect(contrast(over(light.bg, light.focus, 0.7), resolve(light, "error-band@bg"))).toBeLessThan(3);
  });
});
