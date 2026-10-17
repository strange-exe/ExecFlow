import { defaultKeymap, insertBlankLine } from "@codemirror/commands";
import { getIndentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { BIDI_CONTROL, HIDDEN } from "../core/safety";
import extensionsSource from "./extensions.ts?raw";
import { APP_KEYS, appHandlers, BASE, EXTRA_SPECIALS, fileConf, fileExtensions, fileIdFacet, LINT_SPEC, notifyDocChanged } from "./extensions";
import { CHROME_SPEC, highlightStyle } from "./highlight";

/** The theme layer's variables (src/theme/contrast.ts); nothing else may colour the editor. */
const THEME_VARS = new Set(
  ("--bg --surface --surface-raised --border --border-strong --text --text-muted --accent --accent-hover --accent-ink " +
    "--focus --danger --warning --success --selection --active-line --gutter-text --terminal-bg --terminal-fg " +
    "--syn-keyword --syn-string --syn-number --syn-comment --syn-function --syn-type --syn-variable --syn-operator " +
    "--syn-macro --syn-punctuation --font-ui --font-code --code-size").split(" "),
);

type Spec = { [key: string]: string | number | Spec };

function declarations(spec: Spec, path = ""): [string, string][] {
  return Object.entries(spec).flatMap(([key, value]): [string, string][] =>
    typeof value === "object" ? declarations(value, `${path} ${key}`) : [[`${path} ${key}`, String(value)]],
  );
}

const COLOUR_PROP = /colou?r|background|border|outline|shadow|caret|decoration/i;
// Words a colour-bearing value may contain besides var(--token): keywords, lengths and styles.
const NOT_A_COLOUR = /var\(--[a-z-]+\)|-?\d*\.?\d+(px|em|%)?|\b(solid|dotted|dashed|wavy|transparent|none|inset|underline|normal|inherit)\b|[\s,]/g;

describe("themes use only the theme layer's variables", () => {
  const all = [...declarations(CHROME_SPEC as Spec), ...declarations(LINT_SPEC as Spec)];

  it.each(all)("%s: %s", (where, value) => {
    for (const [, name] of value.matchAll(/var\((--[a-z-]+)\)/g)) expect(THEME_VARS.has(name), `${where} uses ${name}`).toBe(true);
    expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|data:|url\(/i);
    const prop = where.trim().split(" ").pop()!;
    if (COLOUR_PROP.test(prop)) expect(value.replace(NOT_A_COLOUR, ""), `${where}: ${value}`).toBe("");
  });

  it("syntax colours are --syn-* variables and nothing else", () => {
    const rules = highlightStyle.module!.getRules();
    const colours = [...rules.matchAll(/color:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(colours.length).toBeGreaterThanOrEqual(10);
    for (const colour of colours) expect(colour).toMatch(/^var\(--syn-[a-z]+\)$/);
    expect(new Set(colours).size).toBe(10);
  });

  it("draws a visible focus ring", () => {
    expect(CHROME_SPEC["&.cm-focused"].outline).toBe("2px solid var(--focus)");
  });

  it("replaces every lint SVG with a token-coloured underline or shape", () => {
    for (const sev of ["error", "warning", "info", "hint"]) {
      expect(LINT_SPEC[`.cm-lintRange-${sev}` as keyof typeof LINT_SPEC]).toMatchObject({ backgroundImage: "none" });
      expect(LINT_SPEC[`.cm-lint-marker-${sev}` as keyof typeof LINT_SPEC]).toMatchObject({ content: "normal" });
    }
  });
});

describe("EXTRA_SPECIALS", () => {
  // @codemirror/view 6.43.14 already marks these (its Specials regex), besides C0/C1 controls.
  const CODEMIRROR_MARKS = new Set([0x00ad, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202d, 0x202e, 0x2066, 0x2067, 0x2069, 0xfeff]);
  const hidden = new RegExp(HIDDEN.source);

  it("together with CodeMirror's own list, marks every character core/safety.ts treats as hidden or bidi", () => {
    const missing: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (!hidden.test(ch) && !BIDI_CONTROL.test(ch)) continue;
      if (!CODEMIRROR_MARKS.has(c) && !EXTRA_SPECIALS.test(ch)) missing.push(c.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("is written as code points: extensions.ts stays plain ASCII", () => {
    expect(extensionsSource).toContain("0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0");
    const nonAscii = [...extensionsSource].filter((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== "\n"));
    expect(nonAscii).toEqual([]);
  });
});

describe("BASE", () => {
  const state = EditorState.create({ doc: "x", extensions: BASE });

  it("indents with four spaces and has tab size 4", () => {
    expect(getIndentUnit(state)).toBe(4);
    expect(state.tabSize).toBe(4);
  });

  it("puts Run and Save ahead of defaultKeymap's Mod-Enter (insertBlankLine)", () => {
    const maps = state.facet(keymap);
    const app = maps.findIndex((m) => m.some((b) => b === APP_KEYS[0]));
    const fallback = maps.findIndex((m) => m.some((b) => b.key === "Mod-Enter" && b.run === insertBlankLine));
    expect(app).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(app);
    expect(defaultKeymap.some((b) => b.key === "Mod-Enter")).toBe(true);
  });

  it("turns off autocapitalize, autocorrect and spellcheck", () => {
    expect(state.facet(EditorView.contentAttributes)).toContainEqual({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  });

  it("labels each file's editor with its path and language", () => {
    const st = EditorState.create({ extensions: [BASE, fileConf.of(fileExtensions("lab/main.c"))] });
    expect(st.facet(EditorView.contentAttributes)).toContainEqual({ "aria-label": "Code editor, lab/main.c" });
    expect(st.facet(EditorView.editorAttributes)).toContainEqual({ "data-language": "c" });
  });
});

describe("app keys", () => {
  const calls: [string, string | null][] = [];
  const handlers = appHandlers.of({ run: (id) => calls.push(["run", id]), save: (id) => calls.push(["save", id]) });

  it("call the injected handlers with the file id read from the state, and always stop the browser", () => {
    const view = { state: EditorState.create({ extensions: [handlers, fileIdFacet.of("f1")] }) } as EditorView;
    const [run, save] = APP_KEYS;
    expect([run.key, save.key]).toEqual(["Mod-Enter", "Mod-s"]);
    expect(run.run!(view)).toBe(true);
    expect(save.run!(view)).toBe(true);
    expect(calls).toEqual([["run", "f1"], ["save", "f1"]]);
    expect(APP_KEYS.every((k) => k.preventDefault && k.scope!.split(" ").includes("search-panel"))).toBe(true);
  });

  it("still swallow Mod-s when nothing handles it (no Save page dialog)", () => {
    const view = { state: EditorState.create({}) } as EditorView;
    expect(APP_KEYS[1].run!(view)).toBe(true);
  });

  it("report doc changes for the file the state belongs to, and not for a state without a file", () => {
    const seen: string[] = [];
    const docChanged = appHandlers.of({ docChanged: (id) => seen.push(id) });
    notifyDocChanged(EditorState.create({ extensions: [docChanged, fileIdFacet.of("f9")] }));
    notifyDocChanged(EditorState.create({ extensions: [docChanged] }));
    expect(seen).toEqual(["f9"]);
  });
});
