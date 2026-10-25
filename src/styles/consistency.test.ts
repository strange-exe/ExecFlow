/// <reference types="node" />
// The visual system's consistency rules (UX polish, unit U2, 2026-10-24), read from the stylesheets
// themselves: icon sizes on one scale of tokens, one weight for section headings, titles and chrome
// text on their line-height tokens, one field-error look, one result line, dialog buttons at the
// primary height, footers that draw a rule only while the body scrolls, and the text roles of the
// sentences that carry meaning. e2e/dialogs-design.spec.ts measures the same things rendered.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, resolve } from "../theme/contrast";
import { BUILT_IN, themePalette } from "../theme/themes";

const DIR = "src/styles";
const sheets = readdirSync(DIR).filter((f) => f.endsWith(".css")).map((f) => ({ file: f, text: readFileSync(`${DIR}/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
const sheet = (file: string) => sheets.find((s) => s.file === file)!.text;

interface Rule { file: string; selectors: string[]; decls: Map<string, string> }

/** Every innermost `selector { declarations }` block (rules inside @media and @container included). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const { file, text } of sheets) {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1].trim();
      if (head.startsWith("@font-face")) continue;
      const decls = new Map<string, string>();
      for (const d of m[2].split(";")) {
        const i = d.indexOf(":");
        if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
      }
      out.push({ file, selectors: head.split(",").map((s) => s.trim()).filter(Boolean), decls });
    }
  }
  return out;
}
const ALL = rules();
/** The last compound selector: the element the rule styles. */
const subject = (sel: string) => sel.split(/\s+|>|\+|~/).filter(Boolean).at(-1) ?? "";
const rulesFor = (wanted: (sel: string) => boolean) => ALL.filter((r) => r.selectors.some(wanted));
const exact = (sel: string) => rulesFor((s) => s === sel);

/** The line height a rule sets: its own declaration, or the `/x` of a `font` shorthand. */
function lineHeight(r: Rule): string | undefined {
  if (r.decls.has("line-height")) return r.decls.get("line-height");
  const font = r.decls.get("font");
  return font ? /\/\s*(var\([^)]+\)|[\d.]+[a-z%]*)/.exec(font)?.[1] : undefined;
}

describe("icons render on one scale: 12, 14, 16, 18 and 20 px (C18)", () => {
  it("tokens.css declares the five icon sizes", () => {
    const t = sheet("tokens.css");
    for (const [name, px] of [["xs", 12], ["sm", 14], ["md", 16], ["lg", 18], ["xl", 20]] as const) expect(t).toMatch(new RegExp(`--icon-${name}: ${px}px;`));
  });

  // An icon's box: the .icon class, a class ending in -icon, and the named glyph boxes.
  const ICON = /(\.icon|-icon|\.toggle-caret|\.crumb-sep|\.palette-glass|\.brand-mark)(?![\w-])/;
  it("every icon width and height is an icon token (no em, no fraction, no raw px)", () => {
    const bad: string[] = [];
    for (const r of ALL) {
      if (!r.selectors.some((s) => ICON.test(subject(s)))) continue;
      for (const p of ["width", "height"]) {
        const v = r.decls.get(p);
        if (v !== undefined && !/^var\(--icon-(xs|sm|md|lg|xl)\)$/.test(v)) bad.push(`${r.file}: ${r.selectors.join(", ")} { ${p}: ${v} }`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the check can fail: an em size is caught", () => {
    expect(ICON.test(subject(".btn .icon"))).toBe(true);
    expect(ICON.test(subject(".icon-btn"))).toBe(false);
    expect(ICON.test(subject(".x .ext-icon"))).toBe(true);
  });
});

describe("type: one heading weight, titles and chrome on their line-height tokens (C16)", () => {
  it("section headings, group titles and legends are all at the label weight (500)", () => {
    const headings = rulesFor((s) => /^(\.section-title|\.steps-title|legend|\.theme-group)$/.test(subject(s)) || s.endsWith(" legend"));
    const weights = headings.filter((r) => r.decls.has("font-weight")).map((r) => `${r.selectors.join(", ")}: ${r.decls.get("font-weight")}`);
    expect(weights.length).toBeGreaterThanOrEqual(4);
    expect(weights.filter((w) => !w.endsWith(": var(--w-label)"))).toEqual([]);
    // h3 is bold by default: .section-title must set the weight itself.
    expect(exact(".section-title").some((r) => r.decls.get("font-weight") === "var(--w-label)")).toBe(true);
  });

  it("dialog and empty-state titles use their line-height tokens", () => {
    expect(exact(".dialog-title").map(lineHeight)).toContain("var(--lh-title)");
    expect(exact(".empty-title").map(lineHeight)).toContain("var(--lh-display)");
  });

  it("chrome text that inherited the body's 1.5 pairs its size token with the line-height token", () => {
    const pairs: Record<string, string> = {
      ".region-title": "var(--lh-2)", ".palette-btn": "var(--lh-2)", ".starter-lang": "var(--lh-hint)", ".problem-source": "var(--lh-hint)",
      ".problem-where": "var(--lh-hint)", ".starter-file": "var(--lh-2)",
    };
    const wrong = Object.entries(pairs).filter(([sel, lh]) => !exact(sel).some((r) => lineHeight(r) === lh)).map(([sel]) => sel);
    expect(wrong).toEqual([]);
  });
});

describe("text roles: sentences that carry meaning are not in the hint tier (C16)", () => {
  it("the delete confirmation's body is --text; the ledes and the waiting changes are --text-secondary", () => {
    const colour = (sel: string) => exact(sel).map((r) => r.decls.get("color")).filter(Boolean);
    expect(colour(".dialog.confirm .dialog-body")).toEqual(["var(--text)"]);
    expect(colour(".empty-lede")).toEqual(["var(--text-secondary)"]);
    expect(colour(".examples-lede")).toEqual(["var(--text-secondary)"]);
    expect(colour("#sync-message-waiting")).toEqual(["var(--text-secondary)"]);
  });

  it("the empty workspace's lede is not capped at 46ch inside its 540 px column (C18)", () => {
    expect(exact(".empty-lede").some((r) => r.decls.has("max-width"))).toBe(false);
  });
});

describe("dialogs: one button height, one footer rule, one field error, one result line (C14, C15)", () => {
  it("dialog buttons are the primary height; Sign in has no raw 44 px of its own", () => {
    expect(exact(".dialog-actions .btn").some((r) => r.decls.get("min-height") === "var(--primary-h)")).toBe(true);
    const raw = rulesFor((s) => /signin/.test(s)).filter((r) => /\b44px\b/.test(r.decls.get("min-height") ?? "")).map((r) => r.selectors.join(", "));
    expect(raw).toEqual([]);
    expect(exact(".signin-btn").some((r) => r.decls.get("min-height") === "var(--primary-h)")).toBe(true);
  });

  it("a footer draws its --divider rule only while the body scrolls; no footer variant draws its own", () => {
    expect(exact(".dialog[data-overflow] .dialog-actions").map((r) => r.decls.get("box-shadow"))).toContain("inset 0 1px 0 var(--divider)");
    const own = rulesFor((s) => /dialog-actions|-actions$/.test(subject(s)) || /\.(snippet|pdf|share)-actions/.test(s))
      .filter((r) => [...r.decls.keys()].some((k) => k.startsWith("border-top")))
      .map((r) => `${r.file}: ${r.selectors.join(", ")}`);
    expect(own).toEqual([]);
  });

  it("the field error is drawn by one rule (the band, the 2 px danger bar)", () => {
    const looks = ALL.filter((r) => r.selectors.some((s) => /field-error|args-error/.test(s)) && r.decls.get("background") === "var(--error-band)");
    expect(looks.map((r) => `${r.file}: ${r.selectors.join(", ")}`)).toHaveLength(1);
    expect(looks[0].file).toBe("app.css");
  });

  it("the result line is one component: its look is set once, and the dialogs' own result classes don't redraw it", () => {
    expect(exact(".result-line").length).toBeGreaterThanOrEqual(1);
    const redrawn = rulesFor((s) => /^\.(share-result|snippet-status|pdf-status|connect-result)(\[[^\]]*\])*$/.test(subject(s)) && !s.includes(".result-line"))
      .flatMap((r) => [...r.decls.keys()].filter((k) => /^(display|gap|font|font-size|font-weight|line-height|color|background|padding)$/.test(k)).map((k) => `${r.selectors.join(", ")} { ${k} }`));
    expect(redrawn).toEqual([]);
  });

  it("the Settings 'Default' tag is quiet text, not a button-like box (C18)", () => {
    const tag = exact(".tag");
    expect(tag.map((r) => r.decls.get("color"))).toContain("var(--text-secondary)");
    expect(tag.some((r) => [...r.decls.keys()].some((k) => k.startsWith("border") && !/^(0|none)$/.test(r.decls.get(k)!)))).toBe(false);
  });
});

describe("inline code in the error help is a chip (C18)", () => {
  it("on the hover ground with the 4 px radius", () => {
    const chip = exact(".err-help code");
    expect(chip.map((r) => r.decls.get("background"))).toContain("var(--hover)");
    expect(chip.map((r) => r.decls.get("border-radius"))).toContain("var(--r-key)");
  });

  it("its words keep 4.5:1 on the chip in every built-in theme, in the failed header and in Problems", () => {
    const bad: string[] = [];
    for (const t of BUILT_IN) {
      for (const scheme of t.system ? (["light", "dark"] as const) : [t.scheme]) {
        const p = themePalette(t, scheme).palette;
        for (const fg of ["text", "text-secondary"] as const) {
          for (const g of ["hover@error-band@runlog-bg", "hover@bg"] as const) {
            const c = contrast(p[fg], resolve(p, g));
            if (c < 4.5) bad.push(`${t.id} ${scheme} ${fg} on ${g}: ${c.toFixed(2)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
