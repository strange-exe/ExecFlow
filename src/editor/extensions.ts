// The extension set every file's EditorState is built from. BASE is created once and shared by
// all states (identical configuration everywhere); what differs per file or per moment lives in
// three compartments that also work across states: fileConf (grammar, completion, label, path),
// readOnlyConf (another tab is editing, storage is blocked, a conflict copy is being written, or an
// opaque file) and prefsConf (line wrapping, suggestions while typing; ligatures are CSS).
// App shortcuts and the doc-change hook reach the app through the appHandlers facet, and the
// workspace's files and build standards through completion-context.ts libraryContext, so BASE
// itself holds no reference to any manager.

import {
  autocompletion, clearSnippet, closeBrackets, closeBracketsKeymap, closeCompletion, completionStatus, pickedCompletion, type Completion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, linter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Facet, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap,
  lineNumbers, tooltips, ViewPlugin, type KeyBinding, type ViewUpdate,
} from "@codemirror/view";
import arrowSvg from "@phosphor-icons/core/assets/regular/arrow-elbow-down-right.svg?raw";
import { filePath } from "./completion-context";
import { isCallSite } from "./diagnostics";
import { editorTheme, foldMarker, highlightStyle } from "./highlight";
import { languageForPath, languageSupport } from "./language-support";
import { forgetWaiting } from "./late-data";
import { runMarks } from "./run-marks";
import { selectionLayer } from "./selection-layer";

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

/**
 * Escape closes the suggestion list, else ends a snippet, and does nothing more: the next Tab
 * indents. Only an Escape no binding used arms CodeMirror's "Escape then Tab" (view 6.43.14), so
 * with the list open the way out is Escape, Escape, Tab (or Ctrl-m); defaultKeymap's Escape clears
 * a selection first in the same way (simplifySelection). This Escape used to arm it
 * too, and then "Escape to dismiss the list, Tab to indent" left the editor (user report,
 * 2026-10-23; the risk named in .claude/research/autocomplete.md section 4). It must come before
 * autocompletion()'s keymap and the snippet keymap: same precedence, earlier in BASE (the snippet
 * keymap is appended to a state when its first snippet starts).
 */
export const ESCAPE_KEY: KeyBinding = {
  key: "Escape",
  run: (view) => {
    // Data a suggestion was waiting for doesn't open the list after Escape (late-data.ts).
    forgetWaiting(view);
    return closeCompletion(view) || clearSnippet(view);
  },
};

/**
 * A picked suggestion is an edit like typing, so a read-only file refuses it. The list's mouse
 * handler applies an option with no read-only check (autocomplete 6.20.3), and readOnly doesn't
 * stop dispatched changes. Only picks are dropped: a pull or another tab's save still replaces a
 * read-only file's text. (language-support.ts also removes the sources, which closes the list.)
 */
export const refuseReadOnlyPicks: Extension = EditorState.transactionFilter.of((tr) =>
  tr.startState.readOnly && tr.annotation(pickedCompletion) !== undefined ? [] : tr,
);

/**
 * A space between an option's label and its detail in the text itself ("if block", not "ifblock"
 * for a screen reader). CodeMirror only separates them on screen, with a margin on the detail.
 */
const SPACE_BEFORE_DETAIL = {
  render: (completion: Completion) => (completion.detail ? document.createTextNode(" ") : null),
  position: 70, // between the label (50) and the detail (80)
};

/** How far tooltips keep from the window's left and right edges. */
export const TOOLTIP_EDGE = 8;

/**
 * Tooltips (the suggestion list, lint and hover tooltips) stay TOOLTIP_EDGE px inside the window's
 * sides, so on a phone the list never touches the screen edge. Widths as CodeMirror's own default
 * measures them (the root's client size, view 6.43.14 windowSpace).
 */
export const tooltipSpace: Extension = tooltips({
  tooltipSpace: (view) => {
    const root = view.dom.ownerDocument.documentElement;
    return { top: 0, left: TOOLTIP_EDGE, right: root.clientWidth - TOOLTIP_EDGE, bottom: root.clientHeight };
  },
});

/**
 * The suggestion list's state on the editor element: data-completion is "closed", "pending" (a
 * query runs) or "active" (the list is open). Typing that would open the list makes it "pending"
 * in the same update, so tests can wait on it instead of on wording or time.
 */
export const completionAttribute = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.mark(view.state);
    }
    update(update: ViewUpdate) {
      this.mark(update.state);
    }
    private mark(state: EditorState) {
      const status = completionStatus(state) ?? "closed";
      if (this.view.dom.dataset.completion !== status) this.view.dom.dataset.completion = status;
    }
  },
);

// CodeMirror already shows most invisible and direction-control characters as a red dot. These
// are the rest of the ones core/safety.ts treats as hidden or direction-changing (embeddings,
// first-strong isolate, word joiner, Mongolian vowel separator, Hangul fillers), so nothing that
// can hide code stays invisible. Code points rather than literal characters keep this file ASCII.
// (From Pocket Run's editor.ts, same author, MIT.)
export const EXTRA_SPECIALS = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0].map((c) => String.fromCodePoint(c)).join("")}]`,
);

/**
 * The call-site arrow (Phosphor's arrow-elbow-down-right), a mask over --call-site like the
 * suggestion list's keyword icon (highlight.ts). (CSP: img-src allows data:.)
 */
const ARROW_MASK = `url("data:image/svg+xml,${encodeURIComponent(arrowSvg)}") center / contain no-repeat`;

/**
 * The lint gutter's marker filter: a call site (diagnostics.ts isCallSite) gets the arrow drawn by
 * its line class (run-marks.ts) instead of an info square, so the lint column shows one mark.
 */
export function withoutCallSites(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => !isCallSite(d));
}

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
  ".cm-lintRange-info": { backgroundImage: "none", textDecorationStyle: "dotted", textDecorationColor: "var(--info)" },
  ".cm-lintRange-hint": { backgroundImage: "none", textDecorationStyle: "dotted", textDecorationColor: "var(--text-muted)" },
  // The panel's selected diagnostic: a fill, while its own severity mark keeps the underline.
  ".cm-lintRange-active": { backgroundColor: "var(--selection)", textDecorationLine: "none" },
  ".cm-lintPoint:after": { borderBottomColor: "var(--danger)" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "var(--warning)" },
  ".cm-lintPoint-info:after": { borderBottomColor: "var(--info)" },
  ".cm-lintPoint-hint:after": { borderBottomColor: "var(--text-muted)" },

  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--info)" },
  ".cm-diagnostic-hint": { borderLeftColor: "var(--text-muted)" },
  ".ce-diag-severity": { fontWeight: "600" },
  ".cm-diagnosticSource": { color: "var(--text-muted)", opacity: "1", fontSize: "85%" },
  ".cm-diagnosticAction": {
    backgroundColor: "transparent", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-control)",
    minHeight: "24px", padding: "2px 8px",
  },
  ".cm-panel.cm-panel-lint ul [aria-selected]": { backgroundColor: "var(--active-line)", boxShadow: "inset 2px 0 0 var(--border-strong)" },
  ".cm-panel.cm-panel-lint ul:focus [aria-selected]": { backgroundColor: "var(--list-selected)", color: "var(--text)", boxShadow: "inset 2px 0 0 var(--location)" },
  ".cm-panel.cm-panel-lint ul:focus-visible": { outlineOffset: "-2px" },

  ".cm-lint-marker": { content: "normal", width: "0.8em", height: "0.8em", margin: "0.1em", boxSizing: "border-box" },
  ".cm-lint-marker-error": { content: "normal", backgroundColor: "var(--danger)", borderRadius: "50%" },
  ".cm-lint-marker-warning": { content: "normal", backgroundColor: "var(--warning)", clipPath: "polygon(50% 0, 100% 100%, 0 100%)" },
  ".cm-lint-marker-info": { content: "normal", backgroundColor: "var(--info)", borderRadius: "1px" },
  ".cm-lint-marker-hint": { content: "normal", border: "2px solid var(--text-muted)", borderRadius: "50%" },

  // A call that led to an error in another place (diagnostics.ts CALL_SITE_CLASS): a 2 px dashed
  // outline instead of the info underline, and an arrow in the lint column instead of the info
  // square (withoutCallSites; the line class comes from run-marks.ts CALL_LINE_CLASS). The arrow sits
  // in the column the square used, so the gutter never widens. --call-site, never the action colour.
  ".cm-lintRange.ce-call-site": {
    textDecorationLine: "none", outline: "2px dashed var(--call-site)", outlineOffset: "1px", borderRadius: "2px",
  },
  ".cm-gutter-lint .cm-gutterElement.ce-call-line::before": {
    content: "''", display: "block", width: "0.9em", height: "0.9em", margin: "0.05em",
    backgroundColor: "var(--call-site)", WebkitMask: ARROW_MASK, mask: ARROW_MASK,
  },
};

export const lintTheme = EditorView.theme(LINT_SPEC);

/** Per-file: grammar and completion, the accessible name, and a data attribute for tests. */
export const fileConf = new Compartment();
/**
 * Read-only: every file while another tab edits or storage is blocked, one file while its conflict
 * copy is written, opaque files. EditorState.readOnly only: `editable` stays true (focus, select, copy, search).
 */
export const readOnlyConf = new Compartment();
/** User preferences that need reconfiguration (line wrapping, suggestions while typing). */
export const prefsConf = new Compartment();

export const READ_ONLY: Extension = EditorState.readOnly.of(true);
export const WRITABLE: Extension = [];

export interface EditorPrefs {
  lineWrapping: boolean;
  /** The list opens as you type (Settings, "Suggestions while typing"); Ctrl-Space always opens it. */
  suggestOnTyping: boolean;
}

export const DEFAULT_PREFS: Readonly<EditorPrefs> = { lineWrapping: false, suggestOnTyping: true };

/**
 * "Suggestions while typing". This is the only place activateOnTyping is set: autocompletion() in
 * BASE leaves it out, because two different values throw "Config merge conflict for field
 * activateOnTyping" (@codemirror/state 6.7.6). Everything else autocompletion() returns is a
 * shared instance (autocomplete 6.20.3), which a state includes only once.
 */
const WHILE_TYPING = { on: autocompletion({ activateOnTyping: true }), off: autocompletion({ activateOnTyping: false }) };

/** A new extension value each call: compartments compare by identity, so build it once per change. */
export function prefsExtension(prefs: EditorPrefs): Extension {
  return [prefs.lineWrapping ? EditorView.lineWrapping : [], prefs.suggestOnTyping ? WHILE_TYPING.on : WHILE_TYPING.off];
}

/** What fileConf holds for `path`. */
export function fileExtensions(path: string): Extension {
  const lang = languageForPath(path);
  return [
    languageSupport(lang),
    filePath.of(path),
    EditorView.contentAttributes.of({ "aria-label": `Code editor, ${path}` }),
    EditorView.editorAttributes.of({ "data-language": lang ?? "plain" }),
  ];
}

export const BASE: Extension = [
  Prec.highest(keymap.of([...APP_KEYS])),
  Prec.highest(keymap.of([ESCAPE_KEY])),
  lineNumbers(),
  foldGutter({ markerDOM: foldMarker }),
  lintGutter({ markerFilter: withoutCallSites }),
  highlightActiveLineGutter(),
  highlightSpecialChars({ addSpecialChars: EXTRA_SPECIALS }),
  history(),
  drawSelection(),
  // The selection's bands, line by line (selection-layer.ts; drawSelection's own layer is hidden).
  selectionLayer,
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  // Installs completionKeymap itself, at the highest precedence (after ESCAPE_KEY above).
  // selectOnOpen false (the user's choice, 2026-10-18): nothing is picked when the list opens, so
  // Enter makes a new line as usual; Down picks the first option, Up the last, then Enter accepts
  // (acceptCompletion returns false with nothing picked, autocomplete 6.20.3). A click still accepts.
  // activateOnTyping is left to prefsConf (prefsExtension): set in one place only.
  autocompletion({ addToOptions: [SPACE_BEFORE_DETAIL], selectOnOpen: false }),
  completionAttribute,
  tooltipSpace,
  refuseReadOnlyPicks,
  EditorState.phrases.of({ Completions: "Suggestions" }),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search({ top: true }),
  // Installs the lint state up front (no source: diagnostics come from builds via mergeSource),
  // so every state has the same configuration from the start.
  linter(null),
  // The error-line band and the call-site line, read from the lint state (run-marks.ts).
  runMarks,
  indentUnit.of("    "),
  EditorState.tabSize.of(4),
  // Tab indents (indentWithTab). Escape then Tab, or Ctrl-m (Shift-Alt-m on macOS), leaves the
  // editor: CodeMirror's keyboard-trap escape hatch; the UI lists it in its shortcuts help.
  keymap.of([
    ...closeBracketsKeymap, ...searchKeymap, ...lintKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
  ]),
  syntaxHighlighting(highlightStyle),
  editorTheme,
  lintTheme,
  EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) notifyDocChanged(update.state);
  }),
];
