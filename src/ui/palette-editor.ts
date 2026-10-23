// The palette's editor commands: CodeMirror's own, so a command does exactly what its keys do in
// the code. A lazy chunk loaded only when such a command runs, and those are listed only while a
// file is shown, so the editor chunk has always loaded by then.
//
// The import below says so to the bundler (the completion-code.ts pattern): this chunk depends on
// the editor chunk's entry, so the CodeMirror modules it uses stay in the editor chunk instead of
// moving to a common chunk of their own, which Rolldown makes for any module two entries import
// (rolldown.rs/in-depth/automatic-code-splitting). The module is already evaluated, so it runs nothing.
import "../editor/editor-manager";
import { addCursorAbove, addCursorBelow, moveLineDown, moveLineUp, redo, toggleComment, toggleTabFocusMode, undo } from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { nextDiagnostic } from "@codemirror/lint";
import { gotoLine, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { Command, EditorView } from "@codemirror/view";
import type { EditorCommandId } from "./palette-model";

/** Opens the search panel and puts the caret in its replace field (a read-only file has none: find stays). */
const replace: Command = (view) => {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
  field?.focus();
  field?.select();
  return true;
};

export const EDITOR_COMMANDS: Record<EditorCommandId, Command> = {
  gotoLine,
  find: openSearchPanel,
  replace,
  selectNext: selectNextOccurrence,
  selectAllMatches: selectSelectionMatches,
  addCursorAbove,
  addCursorBelow,
  moveLineUp,
  moveLineDown,
  comment: toggleComment,
  fold: foldCode,
  unfold: unfoldCode,
  foldAll,
  unfoldAll,
  nextProblem: nextDiagnostic,
  undo,
  redo,
  tabFocus: toggleTabFocusMode,
};

/**
 * What the notice says when a command finds nothing to act on (CodeMirror's command returned false:
 * @codemirror/lint 6.9.7, language 6.13.1, commands 6.11.1, search 6.7.2). The keys say nothing in
 * that case either; chosen from a list, silence looked like a broken command. Every id has a
 * sentence, though some commands always act (they open a panel or switch a mode).
 */
export const CANT_ACT: Record<EditorCommandId, string> = {
  gotoLine: "Go to a line couldn't open here.",
  find: "Find couldn't open here.",
  replace: "Replace couldn't open here.",
  selectNext: "No next match to add. Select a word that appears again in the file.",
  selectAllMatches: "Select some text first (one selection), then every match of it is selected.",
  addCursorAbove: "There's no line above to add a cursor on.",
  addCursorBelow: "There's no line below to add a cursor on.",
  moveLineUp: "The line is already at the top.",
  moveLineDown: "The line is already at the bottom.",
  comment: "This file's language has no comments.",
  fold: "No block starts on this line, so there's nothing to fold.",
  unfold: "Nothing is folded on this line.",
  foldAll: "There are no blocks to fold in this file.",
  unfoldAll: "Nothing is folded.",
  nextProblem: "There's no other problem in this file.",
  undo: "Nothing to undo.",
  redo: "Nothing to redo.",
  tabFocus: "Tab-moves-focus couldn't change here.",
};

/**
 * Runs `id` on `view` with the code focused first (a panel it opens takes the focus from there).
 * Returns what to say when it found nothing to act on, or null when it acted.
 */
export function runEditorCommand(view: EditorView, id: EditorCommandId): string | null {
  view.focus();
  return EDITOR_COMMANDS[id](view) ? null : CANT_ACT[id];
}
