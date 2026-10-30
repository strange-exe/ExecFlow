import { describe, expect, it } from "vitest";
import { contrast, resolve, TEXT, type ColorVar } from "./contrast";
import {
  CURATED, curatedFamilies, customFamily, FAMILIES, familyMatches, otherFamilies, PREVIEW_COLORS, PREVIEW_LINES, schemesText, variantName,
  variantShown, type PreviewRole,
} from "./families";
import { BUILT_IN, themePalette, type Theme } from "./themes";

const byId = new Map(BUILT_IN.map((t) => [t.id, t]));

describe("theme families", () => {
  it("hold every built-in theme exactly once, 22 families", () => {
    const ids = FAMILIES.flatMap((fam) => fam.variants.map((v) => v.id));
    expect(ids.length).toBe(BUILT_IN.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(BUILT_IN.map((t) => t.id).sort());
    expect(FAMILIES.length).toBe(22);
    expect(new Set(FAMILIES.map((fam) => fam.id)).size).toBe(22);
  });

  it("label each variant with words its theme's accessible name contains (label in name), names otherwise unchanged", () => {
    for (const fam of FAMILIES) {
      const labels = fam.variants.map((v) => v.label);
      expect(new Set(labels).size, `${fam.id}: labels differ`).toBe(labels.length);
      for (const v of fam.variants) {
        const theme = byId.get(v.id)!;
        const name = variantName(theme, v.label);
        expect(name.toLowerCase()).toContain(v.label.toLowerCase());
        expect(name.startsWith(theme.name), `${v.id}: the theme's own name leads`).toBe(true);
      }
    }
    expect(variantName(byId.get("slate-dark")!, "Dark")).toBe("CodeEditor Slate Dark");
    expect(variantName(byId.get("signal")!, "Match device")).toBe("CodeEditor Signal (match device)");
    expect(variantName(byId.get("dracula")!, "Dark")).toBe("Dracula, Dark");
    expect(variantName(byId.get("kanagawa")!, "Wave")).toBe("Kanagawa, Wave");
  });

  it("start with the curated row, then the other families A to Z with none repeated", () => {
    expect(curatedFamilies().map((fam) => fam.id)).toEqual(["signal", "slate", "high-contrast", "github", "tokyo-night", "catppuccin"]);
    const rest = otherFamilies();
    expect(rest.length + CURATED.length).toBe(FAMILIES.length);
    expect(rest.some((fam) => CURATED.includes(fam.id))).toBe(false);
    const names = rest.map((fam) => fam.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    expect(names[0]).toBe("Ayu");
  });

  it("filter variants by scheme: match device counts as both", () => {
    expect(variantShown(byId.get("signal")!, "light")).toBe(true);
    expect(variantShown(byId.get("signal")!, "dark")).toBe(true);
    expect(variantShown(byId.get("signal-dark")!, "light")).toBe(false);
    expect(variantShown(byId.get("signal-dark")!, "dark")).toBe(true);
    expect(variantShown(byId.get("catppuccin-latte")!, "dark")).toBe(false);
    expect(variantShown(byId.get("catppuccin-latte")!, "all")).toBe(true);
    const light = FAMILIES.filter((fam) => fam.variants.some((v) => variantShown(byId.get(v.id)!, "light")));
    expect(light.map((fam) => fam.id)).toEqual(["signal", "deep-field", "slate", "github", "tokyo-night", "catppuccin", "rose-pine", "gruvbox", "kanagawa", "everforest", "ayu", "solarized", "vitesse", "flexoki"]);
  });

  it("search by family name, variant label or theme name, ignoring case and punctuation", () => {
    const find = (q: string) => FAMILIES.filter((fam) => familyMatches(fam, byId, q)).map((fam) => fam.id);
    expect(find("")).toHaveLength(22);
    expect(find("  ")).toHaveLength(22);
    expect(find("latte")).toEqual(["catppuccin"]);
    expect(find("ROSE-pine")).toEqual(["rose-pine"]);
    expect(find("tokyo storm")).toEqual(["tokyo-night"]);
    expect(find("night")).toEqual(["tokyo-night", "night-owl", "nightfox"]);
    expect(find("zzz")).toEqual([]);
  });

  it("describe a family's schemes in words", () => {
    const of = (id: string) => FAMILIES.find((fam) => fam.id === id)!.variants.map((v) => byId.get(v.id)!);
    expect(schemesText(of("signal"))).toBe("Light, dark, match device");
    expect(schemesText(of("dracula"))).toBe("Dark");
    expect(schemesText(of("github"))).toBe("Light and dark");
    expect(schemesText(of("catppuccin"))).toBe("Light and dark");
  });

  it("make a loaded theme a family of one", () => {
    const theme = { id: "custom:mine", name: "Mine", scheme: "dark", group: "yours", custom: true } as Theme;
    expect(customFamily(theme)).toEqual({ id: "custom:mine", name: "Mine", variants: [{ id: "custom:mine", label: "Dark" }], custom: true });
  });
});

describe("the code preview", () => {
  it("draws every syntax colour the editor paints, a failed line, and plain text", () => {
    const roles = new Set(PREVIEW_LINES.flatMap((l) => l.parts.map(([role]) => role)));
    const syntax = Object.values(PREVIEW_COLORS).filter((v) => v.startsWith("syn-"));
    expect(syntax).toHaveLength(10);
    for (const [role, v] of Object.entries(PREVIEW_COLORS) as [PreviewRole, ColorVar][]) {
      if (role === "gutter") continue;
      expect(roles.has(role), `${role} (${v}) appears in the preview`).toBe(true);
    }
    expect(PREVIEW_LINES.filter((l) => l.failed)).toHaveLength(1);
    // Spaces only are drawn as plain text; every visible character has a colour of its own role.
    for (const line of PREVIEW_LINES) for (const [role, text] of line.parts) if (role === "text") expect(text.trim()).toBe("");
  });

  // Every theme's preview text on its own grounds, at 4.5:1 (body text): the code on the theme's
  // editor ground, the failed line on its error band over that ground, the line numbers, and Run's
  // label on its fill. "Match device" themes are checked in both schemes.
  it("passes 4.5:1 for every piece of text in every palette", () => {
    const failures: string[] = [];
    for (const theme of BUILT_IN) {
      for (const scheme of theme.system ? (["light", "dark"] as const) : [theme.scheme]) {
        const p = themePalette(theme, scheme).palette;
        const check = (fg: ColorVar, ground: Parameters<typeof resolve>[1], what: string) => {
          const ratio = contrast(resolve(p, fg), resolve(p, ground));
          if (ratio < TEXT) failures.push(`${theme.id} ${scheme}: ${what} ${fg} on ${ground} ${ratio.toFixed(2)}`);
        };
        for (const line of PREVIEW_LINES) {
          const ground = line.failed ? "error-band@bg" : "bg";
          check("gutter-text", ground, "line number");
          for (const [role] of line.parts) check(PREVIEW_COLORS[role], ground, role);
        }
        check("on-action", "action", "Run");
      }
    }
    expect(failures).toEqual([]);
  });
});
