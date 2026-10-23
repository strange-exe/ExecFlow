// Syntax colours and the editor's chrome, written only with the theme layer's CSS variables
// (src/theme/contrast.ts), so light, dark and the picker's other themes switch with the page and no
// state ever needs reconfiguring. No raw colours here; tests check every value.
//
// Selectors mirror the shape of CodeMirror's base-theme selectors ("&light .x" becomes ".x"), so
// each override has the same specificity and wins by coming later.

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import keySvg from "@phosphor-icons/core/assets/regular/key.svg?raw";

/**
 * The keyword kind icon. CodeMirror draws it as the key emoji with a text-presentation selector,
 * which WebKit ignores (a colour emoji that no theme colour reaches). Phosphor's key, used as a
 * mask over the icon's own colour, is the same symbol in every engine. (CSP: img-src allows data:.)
 */
const KEY_MASK = `url("data:image/svg+xml,${encodeURIComponent(keySvg)}") center / contain no-repeat`;

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
const CONTROL = { borderRadius: "var(--r-control)", minHeight: "24px", fontSize: "inherit", boxSizing: "border-box" };

/** Spec of the chrome theme (exported for the no-raw-colours test). */
export const CHROME_SPEC = {
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--bg)" },
  // Focus is not a frame round the whole editor (it out-shouted the code and the gutter clipped
  // it) but a 2 px --focus bar along the gutter's right edge, full height, with the caret in
  // --focus (layout v2 idea 11). The outline stays off: CodeMirror's base theme would otherwise
  // draw a 1 px dotted one. The gutters are position: sticky (set inline by CodeMirror), so the bar
  // is placed against them, stays put on horizontal scroll and paints over every gutter cell,
  // a banded one too. e2e/audit.ts focusStop() measures it (2.4.7, and 3:1 against the gutter).
  // Forced colours (Windows High Contrast) turn every author background into the system Canvas, so
  // the fill alone would vanish there; the transparent outline drawn inside the bar's own 2 px then
  // takes a system colour and becomes the bar (CSS Color Adjust 1, section 3.1). Elsewhere it is
  // invisible. (A media query can't carry this: "&" selectors don't work inside @media here.)
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-gutters::after": {
    content: "''", position: "absolute", top: "0", bottom: "0", right: "0", width: "2px",
    // --focus-bar is --focus, one step quieter in Deep Field dark (tokens.css, plan-v2 P2).
    backgroundColor: "var(--focus-bar)", outline: "1px solid transparent", outlineOffset: "-1px", zIndex: "1", pointerEvents: "none",
  },
  // 15 px code at 1.5: a 22.5 px line pitch (Deep Field type scale).
  ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "var(--code-size)", lineHeight: "1.5" },
  // The caret is the user's hand: the focus colour, not the action colour.
  ".cm-content": { caretColor: "var(--focus)", padding: "8px 0" },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--focus)" },
  ".cm-cursor": { borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { background: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-specialChar": { color: "var(--danger)" },
  ".cm-placeholder": { color: "var(--text-muted)" },

  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--gutter-text)", borderColor: "var(--border)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--text)" },
  // The line where the run's own error was raised (run-marks.ts): --error-band across the code and
  // every gutter cell, the line number in --text, and a 2 px --danger bar on the leading edge, so the
  // line stays findable in grayscale and when the band's red drops out (colour vision). Two classes
  // against .cm-activeLine's one: on the cursor's line the band wins (the contract checks
  // error-band@bg, not both stacked). The band is translucent, so the selection drawn under the
  // line still shows through it.
  ".cm-line.ce-error-line": { backgroundColor: "var(--error-band)" },
  ".cm-gutterElement.ce-error-line": { backgroundColor: "var(--error-band)", color: "var(--text)" },
  ".cm-lineNumbers .cm-gutterElement.ce-error-line": { boxShadow: "inset 2px 0 0 var(--danger)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-raised)", border: "1px solid var(--border-strong)", color: "var(--text-muted)" },

  // The selection colour is for selected text only: a matching bracket is an outline.
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--border-strong)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--danger)" },
  ".cm-selectionMatch": { backgroundColor: "transparent", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch": { backgroundColor: "transparent", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--selection)", outline: "2px solid var(--location)" },

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
  ".cm-panel [name=close], .cm-dialog-close": { color: "var(--text)", minWidth: "24px", minHeight: "24px", borderRadius: "var(--r-control)", cursor: "pointer" },
  ".cm-panels :focus-visible, .cm-tooltip :focus-visible": { outline: FOCUS_RING, outlineOffset: "2px" },

  // Floating layers (the suggestion list, lint and hover tooltips): the lifted ground, a control
  // edge, the control radius and, in light mode only, the one soft shadow (--shadow-pop is none in
  // dark mode, where the lifted ground carries the depth).
  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)", color: "var(--text)", border: "1px solid var(--border-strong)",
    borderRadius: "var(--r-control)", boxShadow: "var(--shadow-pop)", fontFamily: "var(--font-ui)",
  },
  ".cm-tooltip-section:not(:first-child)": { borderTop: "1px solid var(--border)" },
  // The list scrolls inside the rounded tooltip: its own corners follow, so a picked first or last
  // option's fill stays inside them (the tooltip can't clip: the option info panel sits outside it).
  // Its width cap leaves the 8 px edges (extensions.ts TOOLTIP_EDGE) and the tooltip's 1 px borders:
  // CodeMirror's own 95vw left the list 6 px from the right edge at 320 px (review RB-6).
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-code)", maxHeight: "calc(24px * 7.5)", borderRadius: "inherit", maxWidth: "min(700px, calc(100vw - 18px))",
  },
  // Options are pointer targets: 24 px at least (WCAG 2.5.8), 44 px on touch screens like .menu-item.
  // One line each (the list doesn't wrap), so the line height centres the text in the row.
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { minHeight: "24px", lineHeight: "24px", padding: "0 8px 0 6px" },
  "@media (pointer: coarse)": {
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "calc(44px * 5.5)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { minHeight: "44px", lineHeight: "44px" },
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": { borderBottom: "1px solid var(--border)", opacity: "1", color: "var(--text-muted)" },
  // The selected option keeps a bar as well as the fill, so it isn't marked by colour alone.
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--list-selected)", color: "var(--text)", boxShadow: "inset 2px 0 0 var(--location)" },
  ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": { background: "var(--active-line)" },
  // Kind icons, details and the "more options" marks: solid muted text, not CodeMirror's 60% and
  // 50% opacity, so src/theme/contrast.ts can check them in every theme. The text has a real space
  // before the detail (extensions.ts SPACE_BEFORE_DETAIL), which replaces the base theme's margin.
  ".cm-completionIcon": { opacity: "1", color: "var(--text-muted)" },
  ".cm-completionIcon-keyword": {
    "&:after": {
      content: "''", display: "inline-block", width: "0.9em", height: "0.9em", verticalAlign: "-0.1em",
      backgroundColor: "var(--text-muted)", WebkitMask: KEY_MASK, mask: KEY_MASK,
    },
  },
  ".cm-completionDetail": { color: "var(--text-muted)", marginLeft: "0" },
  ".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after": { opacity: "1", color: "var(--text-muted)" },
  // A picked option's info (our own line, "Declared in <stdio.h>") sits beside the list. Where there
  // is no room beside it (a phone), CodeMirror puts it over the next option, which then can't be read
  // or tapped: there it isn't drawn. It stays the option's description for screen readers.
  ".cm-completionInfo.cm-completionInfo-left-narrow, .cm-completionInfo.cm-completionInfo-right-narrow": { visibility: "hidden" },
  ".cm-snippetField": { backgroundColor: "var(--selection)" },
  ".cm-snippetFieldPosition": { borderLeftColor: "var(--text-muted)" },
};

export const editorTheme = EditorView.theme(CHROME_SPEC);

/** The kind classes autocomplete 6.20.3's base theme draws an icon for (a glyph in ::after; keyword: KEY_MASK above). */
const ICON_KINDS = ["function", "method", "class", "interface", "variable", "constant", "type", "enum", "property", "keyword", "namespace", "text"];

/**
 * Lays out one of each kind icon, unseen, so the first suggestion list doesn't pay for them in a
 * keystroke: the glyphs are outside the code font's Latin subset, so the browser looks a system
 * fallback font up for each (about 40-45 ms of the first list's 88-165 ms task at 4x CPU
 * slowdown), and the keyword icon's mask is an SVG document of its own (about 15-20 ms; speed
 * profile, 2026-10-19). They sit in the editor element, where the icon styles apply, in the list's
 * font, hidden from sight and from screen readers, and go two frames later.
 */
export function warmListIcons(view: EditorView): void {
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;font-family:var(--font-code)";
  for (const kind of ICON_KINDS) {
    const icon = document.createElement("div");
    icon.className = `cm-completionIcon cm-completionIcon-${kind}`;
    holder.append(icon);
  }
  view.dom.append(holder);
  holder.getBoundingClientRect(); // style and layout now: the fallback fonts and the mask's image
  requestAnimationFrame(() => requestAnimationFrame(() => holder.remove()));
}
