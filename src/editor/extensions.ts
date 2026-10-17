// The extension set every file's EditorState is built from. BASE is created once and shared by
// all states (identical configuration everywhere); what differs per file or per moment lives in
// three compartments that also work across states: fileConf (grammar, completion, label),
// readOnlyConf (the run lock or an opaque file) and prefsConf (line wrapping; ligatures are CSS).
// App shortcuts and the doc-change hook reach the app through the appHandlers facet, so BASE
// itself holds no reference to any manager.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, linter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Facet, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap,
  lineNumbers, type KeyBinding,
} from "@codemirror/view";
import { editorTheme, highlightStyle } from "./highlight";
import { languageForPath, languageSupport } from "./language-support";

/** Stable id of an open file (not its path, so a rename keeps history and diagnostics). */
export type FileId = string;

/** The file a state belongs to. Read it from the state, never from "the active tab". */
export const fileIdFacet = Facet.define<FileId, FileId | null>({ combine: (values) => values[0] ?? null });

export interface AppHandlers {
  /** Mod-Enter. */
  run?(id: FileId | null): void;
  /** Mod-s (the browser's "Save page" never opens). */
  save?(id: FileId | null): void;
  /** The file's text changed (typing, undo, apply()). `state` is the file's new state. */
  docChanged?(id: FileId, state: EditorState): void;
}

const NO_HANDLERS: AppHandlers = {};
export const appHandlers = Facet.define<AppHandlers, AppHandlers>({ combine: (values) => values[0] ?? NO_HANDLERS });

/** Calls the doc-change handler for the file `state` belongs to (the view's update listener does this). */
export function notifyDocChanged(state: EditorState): void {
  const id = state.facet(fileIdFacet);
  if (id != null) state.facet(appHandlers).docChanged?.(id, state);
}

/**
 * Run and Save. Highest precedence: defaultKeymap binds Mod-Enter to insertBlankLine. They also
 * work while the search panel has focus, and always stop the browser's own handling.
 */
export const APP_KEYS: readonly KeyBinding[] = [
  {
    key: "Mod-Enter",
    scope: "editor search-panel",
    preventDefault: true,
    run: (view) => {
      view.state.facet(appHandlers).run?.(view.state.facet(fileIdFacet));
      return true;
    },
  },
  {
    key: "Mod-s",
    scope: "editor search-panel",
    preventDefault: true,
    run: (view) => {
      view.state.facet(appHandlers).save?.(view.state.facet(fileIdFacet));
      return true;
    },
  },
];

// CodeMirror already shows most invisible and direction-control characters as a red dot. These
// are the rest of the ones core/safety.ts treats as hidden or direction-changing (embeddings,
// first-strong isolate, word joiner, Mongolian vowel separator, Hangul fillers), so nothing that
// can hide code stays invisible. Code points rather than literal characters keep this file ASCII.
// (From Pocket Run's editor.ts, same author, MIT.)
export const EXTRA_SPECIALS = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0].map((c) => String.fromCodePoint(c)).join("")}]`,
);

/**
 * @codemirror/lint draws underlines and gutter markers as data: SVGs with fixed colours. These
 * draw them with the theme's tokens instead, and with a different shape per severity (circle,
 * triangle, square, ring) so the gutter doesn't rely on colour alone.
 */
export const LINT_SPEC = {
  ".cm-lintRange": {
    backgroundImage: "none", paddingBottom: "0", textDecorationLine: "underline", textDecorationThickness: "1.5px",
    textUnderlineOffset: "3px", textDecorationSkipInk: "none",
  },
  ".cm-lintRange-error": { backgroundImage: "none", textDecorationStyle: "wavy", textDecorationColor: "var(--danger)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecorationStyle: "wavy", textDecorationColor: "var(--warning)" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecorationStyle: "dotted", textDecorationColor: "var(--accent)" },
  ".cm-lintRange-hint": { backgroundImage: "none", textDecorationStyle: "dotted", textDecorationColor: "var(--text-muted)" },
  // The panel's selected diagnostic: a fill, while its own severity mark keeps the underline.
  ".cm-lintRange-active": { backgroundColor: "var(--selection)", textDecorationLine: "none" },
  ".cm-lintPoint:after": { borderBottomColor: "var(--danger)" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "var(--warning)" },
  ".cm-lintPoint-info:after": { borderBottomColor: "var(--accent)" },
  ".cm-lintPoint-hint:after": { borderBottomColor: "var(--text-muted)" },

  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--accent)" },
  ".cm-diagnostic-hint": { borderLeftColor: "var(--text-muted)" },
  ".ce-diag-severity": { fontWeight: "600" },
  ".cm-diagnosticSource": { color: "var(--text-muted)", opacity: "1", fontSize: "85%" },
  ".cm-diagnosticAction": {
    backgroundColor: "transparent", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "6px",
    minHeight: "24px", padding: "2px 8px",
  },
  ".cm-panel.cm-panel-lint ul [aria-selected]": { backgroundColor: "var(--active-line)", boxShadow: "inset 2px 0 0 var(--border-strong)" },
  ".cm-panel.cm-panel-lint ul:focus [aria-selected]": { backgroundColor: "var(--selection)", color: "var(--text)", boxShadow: "inset 2px 0 0 var(--accent)" },
  ".cm-panel.cm-panel-lint ul:focus-visible": { outlineOffset: "-2px" },

  ".cm-lint-marker": { content: "normal", width: "0.8em", height: "0.8em", margin: "0.1em", boxSizing: "border-box" },
  ".cm-lint-marker-error": { content: "normal", backgroundColor: "var(--danger)", borderRadius: "50%" },
  ".cm-lint-marker-warning": { content: "normal", backgroundColor: "var(--warning)", clipPath: "polygon(50% 0, 100% 100%, 0 100%)" },
  ".cm-lint-marker-info": { content: "normal", backgroundColor: "var(--accent)", borderRadius: "1px" },
  ".cm-lint-marker-hint": { content: "normal", border: "2px solid var(--text-muted)", borderRadius: "50%" },
};

export const lintTheme = EditorView.theme(LINT_SPEC);

/** Per-file: grammar and completion, the accessible name, and a data attribute for tests. */
export const fileConf = new Compartment();
/** The run lock / opaque files. EditorState.readOnly only: `editable` stays true (focus, select, copy, search). */
export const readOnlyConf = new Compartment();
/** User preferences that need reconfiguration (line wrapping). */
export const prefsConf = new Compartment();

export const READ_ONLY: Extension = EditorState.readOnly.of(true);
export const WRITABLE: Extension = [];

export interface EditorPrefs {
  lineWrapping: boolean;
}

export const DEFAULT_PREFS: Readonly<EditorPrefs> = { lineWrapping: false };

/** A new extension value each call: compartments compare by identity, so build it once per change. */
export function prefsExtension(prefs: EditorPrefs): Extension {
  return [prefs.lineWrapping ? EditorView.lineWrapping : []];
}

/** What fileConf holds for `path`. */
export function fileExtensions(path: string): Extension {
  const lang = languageForPath(path);
  return [
    languageSupport(lang),
    EditorView.contentAttributes.of({ "aria-label": `Code editor, ${path}` }),
    EditorView.editorAttributes.of({ "data-language": lang ?? "plain" }),
  ];
}

export const BASE: Extension = [
  Prec.highest(keymap.of([...APP_KEYS])),
  lineNumbers(),
  foldGutter(),
  lintGutter(),
  highlightActiveLineGutter(),
  highlightSpecialChars({ addSpecialChars: EXTRA_SPECIALS }),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  // Installs the lint state up front (no source: diagnostics come from builds via mergeSource),
  // so every state has the same configuration from the start.
  linter(null),
  indentUnit.of("    "),
  EditorState.tabSize.of(4),
  // Tab indents (indentWithTab). Escape then Tab, or Ctrl-m (Shift-Alt-m on macOS), leaves the
  // editor: CodeMirror's keyboard-trap escape hatch; the UI lists it in its shortcuts help.
  keymap.of([
    ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...lintKeymap, ...defaultKeymap, ...historyKeymap,
    ...foldKeymap, indentWithTab,
  ]),
  syntaxHighlighting(highlightStyle),
  editorTheme,
  lintTheme,
  EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) notifyDocChanged(update.state);
  }),
];
