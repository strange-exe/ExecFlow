import {
  clearSnippet, completionKeymap, completionStatus, hasNextSnippetField, insertCompletionText, pickedCompletion, snippetCompletion, startCompletion,
  type Completion,
} from "@codemirror/autocomplete";
import { defaultKeymap, insertBlankLine, insertNewlineAndIndent } from "@codemirror/commands";
import { getIndentUnit } from "@codemirror/language";
import { EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { BIDI_CONTROL, HIDDEN } from "../core/safety";
import { ALPHA_OK, COLOR_VARS, PAIRS } from "../theme/contrast";
import extensionsSource from "./extensions.ts?raw";
import {
  APP_KEYS, appHandlers, BASE, DEFAULT_PREFS, ENTER_KEY, ESCAPE_KEY, EXTRA_SPECIALS, fileConf, fileExtensions, fileIdFacet, LINT_SPEC, notifyDocChanged,
  prefsConf, prefsExtension, READ_ONLY, TOOLTIP_EDGE,
} from "./extensions";
import { CHROME_SPEC, highlightStyle } from "./highlight";

/**
 * The theme layer's colour variables (src/theme/contrast.ts COLOR_VARS) plus the non-colour tokens
 * the editor reads from tokens.css; nothing else may colour the editor.
 */
// --focus-bar: --focus, one step quieter in Deep Field dark (tokens.css; src/styles/focus-bar.test.ts).
const THEME_VARS = new Set([...COLOR_VARS.map((v) => `--${v}`), "--font-ui", "--font-code", "--code-size", "--r-control", "--shadow-pop", "--focus-bar"]);

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
    const prop = where.trim().split(" ").pop()!;
    // A mask only gives a shape (alpha); its colour is the element's own background. So a mask may
    // be an SVG data URL, as long as the SVG itself names no colour but currentColor.
    if (/^(Webkit)?[Mm]ask$/.test(prop)) {
      const svg = decodeURIComponent(/^url\("data:image\/svg\+xml,([^"]+)"\) center \/ contain no-repeat$/.exec(value)?.[1] ?? "");
      expect(svg, `${where}: an SVG data URL`).toMatch(/^<svg /);
      expect(svg.replace(/"currentColor"/g, ""), `${where}: no colour in the mask`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|(fill|stroke)="/i);
      return;
    }
    expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|data:|url\(/i);
    if (COLOUR_PROP.test(prop)) expect(value.replace(NOT_A_COLOUR, ""), `${where}: ${value}`).toBe("");
  });

  it("syntax colours are --syn-* variables and nothing else", () => {
    const rules = highlightStyle.module!.getRules();
    const colours = [...rules.matchAll(/color:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(colours.length).toBeGreaterThanOrEqual(10);
    for (const colour of colours) expect(colour).toMatch(/^var\(--syn-[a-z]+\)$/);
    expect(new Set(colours).size).toBe(10);
  });

  it("checks every colour the suggestion list draws, on each fill an option can have (theme/contrast.ts PAIRS)", () => {
    const token = (value: string) => /^var\(--([a-z-]+)\)$/.exec(value)![1];
    const s = CHROME_SPEC;
    const selected = s[".cm-tooltip-autocomplete ul li[aria-selected]"];
    // A band token (it may be translucent) is painted over the list's own ground, so its rows are
    // written as a stack: "list-selected@surface-raised".
    const ground = token(s[".cm-tooltip"].backgroundColor);
    const onList = (fill: string) => ((ALPHA_OK as readonly string[]).includes(fill) ? `${fill}@${ground}` : fill);
    const fills = [ground, onList(token(selected.background)), onList(token(s[".cm-tooltip-autocomplete-disabled ul li[aria-selected]"].background))];
    expect(fills).toEqual(["surface-raised", "list-selected@surface-raised", "active-line@surface-raised"]);
    // Deep Field's floating layer: a control edge and the control radius; the picked option keeps
    // a location bar besides its fill (not colour alone).
    expect(s[".cm-tooltip"]).toMatchObject({ border: "1px solid var(--border-strong)", borderRadius: "var(--r-control)" });
    expect(selected.boxShadow).toBe("inset 2px 0 0 var(--location)");
    const inks = [
      s[".cm-tooltip"].color, selected.color, s[".cm-completionIcon"].color, s[".cm-completionDetail"].color,
      s[".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after"].color,
      s[".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section"].color,
    ];
    for (const fill of fills) {
      for (const ink of inks.map(token)) expect(PAIRS.some((p) => p.fg === ink && p.bg === fill && p.min >= 4.5), `${ink} on ${fill}`).toBe(true);
    }
  });

  it("caps the list's width so it keeps TOOLTIP_EDGE from both sides of the window, borders included", () => {
    // 1 px tooltip border on each side (the .cm-tooltip rule above); e2e/suggestions.spec.ts measures 320 and 390 px.
    expect(CHROME_SPEC[".cm-tooltip.cm-tooltip-autocomplete > ul"].maxWidth).toBe(`min(700px, calc(100vw - ${2 * TOOLTIP_EDGE + 2}px))`);
  });

  it("draws the focus bar: no frame round the editor, a 2 px --focus bar on the gutter's right edge", () => {
    // The frame is off, and must stay off explicitly: CodeMirror's base theme draws 1px dotted #212121.
    expect(CHROME_SPEC["&.cm-focused"]).toEqual({ outline: "none" });
    // The indicator (2.4.7; 3:1 is checked in the browser by e2e/a11y.spec.ts): full height, opaque,
    // over the gutter cells, and never in the way of a click on the gutter. The transparent outline
    // inside its own 2 px is what forced colours (Windows High Contrast) paint, where the fill
    // becomes Canvas (e2e/a11y.spec.ts measures that too).
    expect(CHROME_SPEC["&.cm-focused .cm-gutters::after"]).toEqual({
      content: "''", position: "absolute", top: "0", bottom: "0", right: "0", width: "2px",
      backgroundColor: "var(--focus-bar)", outline: "1px solid transparent", outlineOffset: "-1px", zIndex: "1", pointerEvents: "none",
    });
    // --focus-bar is --focus except in Deep Field dark (src/styles/focus-bar.test.ts checks that value).
    // PAIRS checks --focus against the gutter's grounds: the code ground, the cursor line, the error band.
    for (const bg of ["bg", "active-line@bg", "error-band@bg"]) {
      expect(PAIRS.some((p) => p.fg === "focus" && p.bg === bg && p.min >= 3), `focus on ${bg}`).toBe(true);
    }
  });

  it("checks every colour the run marks draw against the grounds they sit on (theme/contrast.ts PAIRS)", () => {
    const has = (fg: string, bg: string, min: number) => PAIRS.some((p) => p.fg === fg && p.bg === bg && p.min >= min);
    // The error line: its number in --text, the danger bar and squiggle, every syntax colour.
    expect(has("text", "error-band@bg", 4.5)).toBe(true);
    expect(has("danger", "error-band@bg", 3)).toBe(true);
    for (const v of COLOR_VARS.filter((c) => c.startsWith("syn-"))) expect(has(v, "error-band@bg", 4.5), v).toBe(true);
    // The call site: the outline and the arrow, on the code and on the cursor's line (the cursor goes there).
    expect(has("call-site", "bg", 3) && has("call-site", "active-line@bg", 3)).toBe(true);
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

/** A stand-in for the view: its state, dispatch (transactions or specs) and the tab-focus switch. */
function standIn(initial: EditorState) {
  const armed: unknown[] = [];
  const target = {
    state: initial,
    dispatch(...args: (Transaction | TransactionSpec)[]) {
      target.state = (args[0] instanceof Transaction ? args[0] : target.state.update(...(args as TransactionSpec[]))).state;
    },
    setTabFocusMode(to?: boolean | number) {
      armed.push(to);
    },
  };
  return { target, view: target as unknown as EditorView, armed };
}

/** Starts a snippet with two fields at the cursor, as accepting one from the list does. */
function startSnippet(view: EditorView) {
  const option = snippetCompletion("f(${a}, ${b})", { label: "f" });
  (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, 0, 0);
}

describe("suggestions", () => {
  const state = EditorState.create({ doc: "x", extensions: BASE });
  const maps = state.facet(keymap);
  const at = (b: KeyBinding, m = maps) => m.findIndex((list) => list.includes(b));

  it("installs each completionKeymap binding once: autocompletion() does, at the highest precedence", () => {
    for (const binding of completionKeymap) expect(maps.filter((m) => m.includes(binding)).length, binding.key ?? binding.mac).toBe(1);
    // Highest precedence: ahead of defaultKeymap (whose Enter inserts a new line), and after ENTER_KEY
    // (enter-key.test.ts), which leaves it Enter unless the word is already typed in full.
    const enter = completionKeymap.find((b) => b.key === "Enter")!;
    const newLine = maps.findIndex((m) => m.some((b) => b.key === "Enter" && b.run === insertNewlineAndIndent));
    expect(newLine).toBeGreaterThanOrEqual(0);
    expect(at(enter)).toBeLessThan(newLine);
    expect(at(ENTER_KEY)).toBeLessThan(at(enter));
  });

  it("tries ESCAPE_KEY before completionKeymap's Escape and before the snippet keymap", () => {
    expect(at(ESCAPE_KEY)).toBeGreaterThanOrEqual(0);
    expect(at(ESCAPE_KEY)).toBeLessThan(at(completionKeymap.find((b) => b.key === "Escape")!));
    const { target, view } = standIn(EditorState.create({ extensions: BASE }));
    startSnippet(view);
    const later = target.state.facet(keymap);
    const snippetEscape = later.findIndex((list) => list.some((b) => b.key === "Escape" && b.run === clearSnippet));
    expect(snippetEscape).toBeGreaterThan(at(ESCAPE_KEY, later));
  });

  // Arming here made "Escape to dismiss the list, then Tab to indent" leave the editor (2026-10-23).
  it("Escape with the list active closes it and doesn't arm Escape-then-Tab: the next Tab indents", () => {
    const { target, view, armed } = standIn(EditorState.create({ doc: "pr", selection: { anchor: 2 }, extensions: [BASE, fileConf.of(fileExtensions("main.py"))] }));
    expect(startCompletion(view)).toBe(true);
    expect(completionStatus(target.state)).not.toBeNull();
    expect(ESCAPE_KEY.run!(view)).toBe(true);
    expect(completionStatus(target.state)).toBeNull();
    expect(armed).toEqual([]);
  });

  it("Escape in a snippet ends it without arming; with neither, it leaves Escape to CodeMirror", () => {
    const { target, view, armed } = standIn(EditorState.create({ extensions: BASE }));
    expect(ESCAPE_KEY.run!(view)).toBe(false);
    startSnippet(view);
    expect(hasNextSnippetField(target.state)).toBe(true);
    expect(ESCAPE_KEY.run!(view)).toBe(true);
    expect(hasNextSnippetField(target.state)).toBe(false);
    expect(armed).toEqual([]);
  });

  it("a read-only file refuses a picked suggestion (typed or snippet) but takes other changes", () => {
    // What the list's mouse handler dispatches for a plain option (applyCompletion, autocomplete 6.20.3).
    const pick = (s: EditorState) => s.update({ ...insertCompletionText(s, "print", 0, 2), annotations: pickedCompletion.of({ label: "print" }) });
    const typed = (lock: Extension) => EditorState.create({ doc: "pr", selection: { anchor: 2 }, extensions: [BASE, lock] });
    const locked = typed(READ_ONLY);
    expect(pick(locked).state.doc.toString()).toBe("pr");
    const { target, view } = standIn(locked);
    startSnippet(view);
    expect(target.state.doc.toString()).toBe("pr");
    // A pull or another tab's save replaces a read-only file's text programmatically.
    expect(locked.update({ changes: { from: 0, to: 2, insert: "print" } }).state.doc.toString()).toBe("print");
    expect(pick(typed([])).state.doc.toString()).toBe("print");
  });

  it("calls the list Suggestions", () => {
    expect(state.phrase("Completions")).toBe("Suggestions");
  });

  it("opens the list while typing only with the setting on; flipping it has no config merge conflict", () => {
    const prefs = (suggestOnTyping: boolean) => prefsExtension({ ...DEFAULT_PREFS, suggestOnTyping });
    /** Types "p" into a Python file: with activateOnTyping, the same update starts a query ("pending"). */
    const typed = (s: EditorState) => s.update({ changes: { from: 0, insert: "p" }, selection: { anchor: 1 }, userEvent: "input.type" }).state;
    const create = (on: boolean) => EditorState.create({ extensions: [BASE, fileConf.of(fileExtensions("main.py")), prefsConf.of(prefs(on))] });
    expect(DEFAULT_PREFS.suggestOnTyping).toBe(true);
    expect(completionStatus(typed(create(true)))).toBe("pending");
    const off = create(false);
    expect(completionStatus(typed(off))).toBeNull();
    // Flip it both ways on a live state: the config is read on the next keystroke, which would throw
    // "Config merge conflict for field activateOnTyping" if a second place set it.
    const on = off.update({ effects: prefsConf.reconfigure(prefs(true)) }).state;
    expect(completionStatus(typed(on))).toBe("pending");
    const offAgain = on.update({ effects: prefsConf.reconfigure(prefs(false)) }).state;
    expect(completionStatus(typed(offAgain))).toBeNull();
    // Ctrl-Space (startCompletion) still opens it with the setting off.
    const { target, view } = standIn(EditorState.create({ doc: "pr", selection: { anchor: 2 }, extensions: [BASE, fileConf.of(fileExtensions("main.py")), prefsConf.of(prefs(false))] }));
    expect(startCompletion(view)).toBe(true);
    expect(completionStatus(target.state)).toBe("pending");
  });
});
