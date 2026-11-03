// For unit tests (imported for its effect): every language's chunk (language-support.ts) is loaded
// before the file's tests run, as in the app once a file of each language has opened. Tests of the
// time before a chunk arrives (language-arrival.test.ts) leave this out.
import { ensureSyntaxTree, language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { beforeAll } from "vitest";
import { loadLanguage } from "./language-support";

beforeAll(async () => {
  await Promise.all([loadLanguage("python"), loadLanguage("c"), loadLanguage("cpp")]);
});

/**
 * `state` with its whole syntax tree, as the editor has it once its parser has caught up. A new
 * state is parsed for 20 ms and up to 3000 characters only, and ensureSyntaxTree finishes that
 * parse without changing what syntaxTree(state) returns; the next state takes the finished tree.
 * (Without this, tests passed on an idle machine and failed under load, on a half-parsed file.)
 */
export function parsed(state: EditorState): EditorState {
  if (!state.facet(language)) return state; // a file with no grammar (a.txt) has no tree to wait for
  if (!ensureSyntaxTree(state, state.doc.length, 5000)) throw new Error("the file didn't parse in 5 s");
  return state.update({}).state;
}
