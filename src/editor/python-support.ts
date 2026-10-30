// Python's language chunk: lang-python's grammar, indentation and folding (all in pythonLanguage),
// with our keywords, snippets and the completion chunk's sources. language-support.ts loads it with
// import() when a Python file opens, so the grammar is not part of the editor chunk, which keeps
// room under its 200 kB gzip budget (0.18.1). (The completion chunk still imports both grammars
// for the workspace index, so a session that shows a file soon has both anyway.)
// Like completion-code.ts, it imports the editor chunk's entry, so CodeMirror's core stays one
// chunk with the editor's code: without it Rolldown cut the core into two common chunks (107 + 25
// kB gzip, measured 2026-10-30). The module is already evaluated when this chunk loads, so the
// import runs nothing.
import "./editor-manager";

import { pythonLanguage } from "@codemirror/lang-python";
import { LanguageSupport } from "@codemirror/language";
import { suggestionLoaders } from "./completion-loader";
import { pythonKeywords } from "./keyword-completion";
import { PY_IMPORT_LINE, PY_MEMBER, source, typedWord, writable } from "./language-sources";

/**
 * What python() from lang-python gives (grammar, indentation, folding, local names: the open
 * file's own names, with their kinds), with our keywords, snippets and built-in names, plus module
 * names and members (your own modules' members through the workspace index).
 */
export const PYTHON_SUPPORT = new LanguageSupport(pythonLanguage, [
  source(pythonLanguage, (code) => code.pythonLocalNames, typedWord),
  writable(pythonLanguage, pythonKeywords),
  source(pythonLanguage, (code) => code.pythonBuiltins, typedWord),
  source(pythonLanguage, (code) => code.pythonModuleSource, PY_IMPORT_LINE),
  source(pythonLanguage, (code) => code.pythonMemberSource, PY_MEMBER),
  suggestionLoaders("python", "python"),
]);
