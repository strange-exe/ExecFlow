// What the language chunks (python-support.ts, c-support.ts) build their completion from. Every
// completion source is a Language.data extension placed in each file's own compartment
// (extensions.ts fileConf), never added to the shared language, so a .c file never offers "class".
// Sources exist only while the file can be edited (writable() below).
// Keywords and snippets (keyword-completion.ts) come with the language chunks, so they are offered
// even when the completion chunk can't load. Library names (library-completion.ts) and your own
// names (own-completion.ts, the workspace index) are in the completion chunk (completion-code.ts):
// completion-loader.ts loads it when a file is first shown (suggestionLoaders), and a query that
// comes first runs again once it is there (lazySource). Every instance is built once and shared by
// all states.

import type { CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import type { Language } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { lazySource, type CompletionCode } from "./completion-loader";

/**
 * A completion source for `lang` that exists only while the state is writable. When a state turns
 * read-only (another tab took over editing, a copy being written) its sources go: autocomplete
 * finds no active source, so an open list closes, and Ctrl-Space offers nothing.
 */
export function writable(lang: Language, source: CompletionSource): Extension {
  return lang.data.compute([EditorState.readOnly], (state) => (state.readOnly ? {} : { autocomplete: source }));
}

// Where each source offers names, for a query made before the completion code is there: only then
// does it run again once the code arrives (completion-loader.ts lazySource). Each says no more than
// its source's own first check.

/** A word typed, or Ctrl-Space: keywords, built-in, library and own names. */
export const typedWord = (context: CompletionContext) => context.explicit || context.matchBefore(/\w+$/) !== null;

/** The line before the cursor matches `re`. */
const lineMatches = (re: RegExp) => (context: CompletionContext) =>
  re.test(context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos));

export const PY_IMPORT_LINE = lineMatches(/^\s*(?:import|from)\s/);
export const PY_MEMBER = lineMatches(/[A-Za-z_]\w*\.\w*$/);
export const INCLUDE_PATH = lineMatches(/^\s*#\s*include\s*[<"]/);
export const STD_SCOPE = lineMatches(/std::\w*$/);

/** `pick`'s source, writable only, from the completion chunk. */
export function source(lang: Language, pick: (code: CompletionCode) => CompletionSource, wants: (context: CompletionContext) => boolean): Extension {
  return writable(lang, lazySource(pick, wants));
}
