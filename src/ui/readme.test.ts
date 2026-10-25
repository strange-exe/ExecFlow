// The README says what the app does: these checks keep the parts that drift (plan-v2 P3) in step
// with the code: the theme table against palettes.ts, the Keyboard section against shortcuts.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POCKET_THEMES } from "../theme/palettes";
import { shortcutGroups } from "./shortcuts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README", () => {
  it("names every palette theme in Settings in its theme table, each with a source and a licence", () => {
    const table = readme.slice(readme.indexOf("| Theme | Source | Licence |"));
    const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Theme") && !l.startsWith("|---")).map((l) => l.split("|").map((c) => c.trim()));
    const named = rows.flatMap((r) => r[1].split(", "));
    for (const theme of POCKET_THEMES) expect(named, theme.name).toContain(theme.name);
    for (const r of rows) {
      expect(r[2], r[1]).not.toBe("");
      expect(r[3], r[1]).toMatch(/MIT|Apache-2\.0/);
    }
  });

  it("opens the Shortcuts list with the keys the list itself names (Ctrl+/, no lone ?), and names the palette's keys", () => {
    const keys = shortcutGroups(false).flatMap((g) => g.rows).find(([, what]) => what.startsWith("Show these shortcuts"))![0];
    expect(keys).toBe("Ctrl /");
    expect(readme).toContain("Ctrl+/ (Cmd+/ on macOS)");
    expect(readme).not.toContain("`?`");
    expect(readme).toContain("F1 or Ctrl+Shift+P");
    expect(readme).toContain("Ctrl+P");
  });
});
