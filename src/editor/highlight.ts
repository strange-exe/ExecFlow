// Syntax colours and the editor's chrome, written only with the theme layer's CSS variables
// (src/theme/contrast.ts), so light, dark and the picker's other themes switch with the page and no
// state ever needs reconfiguring. No raw colours here; tests check every value.
//
// Selectors mirror the shape of CodeMirror's base-theme selectors ("&light .x" becomes ".x"), so
// each override has the same specificity and wins by coming later.

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.character, t.docString, t.escape, t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.literal], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  // Calls like print() and printf(): beginners read code by its function calls.
  {
    tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName), t.standard(t.variableName)],
    color: "var(--syn-function)",
  },
  { tag: [t.typeName, t.standard(t.typeName), t.className, t.definition(t.className), t.namespace], color: "var(--syn-type)" },
  { tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.labelName, t.attributeName], color: "var(--syn-variable)" },
  {
    tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator,
      t.definitionOperator, t.derefOperator, t.typeOperator, t.controlOperator],
    color: "var(--syn-operator)",
  },
  { tag: [t.processingInstruction, t.meta, t.macroName, t.special(t.name)], color: "var(--syn-macro)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket, t.brace, t.angleBracket], color: "var(--syn-punctuation)" },
]);

const FOCUS_RING = "2px solid var(--focus)";
const CONTROL = { borderRadius: "6px", minHeight: "24px", fontSize: "inherit", boxSizing: "border-box" };

/** Spec of the chrome theme (exported for the no-raw-colours test). */
export const CHROME_SPEC = {
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--bg)" },
  // The editor fills its region, so the ring sits inside the edge where no ancestor can clip it.
  "&.cm-focused": { outline: FOCUS_RING, outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "var(--code-size)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-cursor": { borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { background: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-specialChar": { color: "var(--danger)" },
  ".cm-placeholder": { color: "var(--text-muted)" },

  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--gutter-text)", borderColor: "var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--text)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-raised)", border: "1px solid var(--border-strong)", color: "var(--text-muted)" },

  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "1px solid var(--border-strong)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--danger)" },
  ".cm-selectionMatch": { backgroundColor: "transparent", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch": { backgroundColor: "transparent", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--selection)", outline: "2px solid var(--accent)" },

  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", fontFamily: "var(--font-ui)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel label": { display: "inline-flex", alignItems: "center", gap: "4px", minHeight: "24px", fontSize: "inherit" },
  ".cm-textfield": { ...CONTROL, backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border-strong)", padding: "2px 6px" },
  ".cm-button": {
    ...CONTROL, backgroundImage: "none", backgroundColor: "var(--surface-raised)", color: "var(--text)",
    border: "1px solid var(--border-strong)", padding: "2px 10px", cursor: "pointer",
  },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--surface)" },
  ".cm-panel [name=close], .cm-dialog-close": { color: "var(--text)", minWidth: "24px", minHeight: "24px", borderRadius: "6px", cursor: "pointer" },
  ".cm-panels :focus-visible, .cm-tooltip :focus-visible": { outline: FOCUS_RING, outlineOffset: "2px" },

  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)", color: "var(--text)", border: "1px solid var(--border-strong)",
    borderRadius: "6px", fontFamily: "var(--font-ui)",
  },
  ".cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-code)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": { borderBottom: "1px solid var(--border)", opacity: "1", color: "var(--text-muted)" },
  // The selected option keeps a bar as well as the fill, so it isn't marked by colour alone.
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--selection)", color: "var(--text)", boxShadow: "inset 2px 0 0 var(--accent)" },
  ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": { background: "var(--active-line)" },
  ".cm-completionDetail": { color: "var(--text-muted)" },
  ".cm-snippetField": { backgroundColor: "var(--selection)" },
  ".cm-snippetFieldPosition": { borderLeftColor: "var(--text-muted)" },
};

export const editorTheme = EditorView.theme(CHROME_SPEC);
