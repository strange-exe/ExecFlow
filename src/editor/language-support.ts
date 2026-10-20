// Grammar and completion per file. Python gets lang-python's grammar, indentation and folding (all
// in pythonLanguage); C, C++ and headers share the C++ grammar (core/languages.ts editorLanguage).
// Every completion source is a Language.data extension placed in each file's own compartment
// (extensions.ts fileConf), never added to the shared language, so a .c file never offers "class".
// Sources exist only while the file can be edited (writable() below).
// The sources themselves are in the completion chunk (completion-code.ts): keywords, snippets and
// built-in names (keyword-completion.ts), library names (library-completion.ts) and your own names
// (own-completion.ts, the workspace index). This file, in the editor chunk, only places them:
// completion-loader.ts loads that chunk when a file is first shown (suggestionLoaders), and a
// query that comes first runs again once it is there (lazySource). Every instance is built once
// and shared by all states.

import type { CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { cpp, cppLanguage } from "@codemirror/lang-cpp";
import { pythonLanguage } from "@codemirror/lang-python";
import { LanguageSupport, type Language } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { editorLanguage, type LanguageId } from "../core/languages";
import { nameOf } from "../core/paths";
import { lazySource, suggestionLoaders, type CompletionCode } from "./completion-loader";

/**
 * A completion source for `lang` that exists only while the state is writable. When a state turns
 * read-only (another tab took over editing, a copy being written) its sources go: autocomplete
 * finds no active source, so an open list closes, and Ctrl-Space offers nothing.
 */
function writable(lang: Language, source: CompletionSource): Extension {
  return lang.data.compute([EditorState.readOnly], (state) => (state.readOnly ? {} : { autocomplete: source }));
}

// Where each source offers names, for a query made before the completion code is there: only then
// does it run again once the code arrives (completion-loader.ts lazySource). Each says no more than
// its source's own first check.

/** A word typed, or Ctrl-Space: keywords, built-in, library and own names. */
const typedWord = (context: CompletionContext) => context.explicit || context.matchBefore(/\w+$/) !== null;

/** The line before the cursor matches `re`. */
const lineMatches = (re: RegExp) => (context: CompletionContext) =>
  re.test(context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos));

const PY_IMPORT_LINE = lineMatches(/^\s*(?:import|from)\s/);
const PY_MEMBER = lineMatches(/[A-Za-z_]\w*\.\w*$/);
const INCLUDE_PATH = lineMatches(/^\s*#\s*include\s*[<"]/);
const DIRECTIVE = lineMatches(/^\s*#\s*\w*$/);
const STD_SCOPE = lineMatches(/std::\w*$/);

/** `pick`'s source, writable only, from the completion chunk. */
function source(lang: Language, pick: (code: CompletionCode) => CompletionSource, wants: (context: CompletionContext) => boolean): Extension {
  return writable(lang, lazySource(pick, wants));
}

/**
 * What python() from lang-python gives (grammar, indentation, folding, local names: the open
 * file's own names, with their kinds), with our globals, plus module names and members (your own
 * modules' members through the workspace index).
 */
const PYTHON_SUPPORT = new LanguageSupport(pythonLanguage, [
  source(pythonLanguage, (code) => code.pythonLocalNames, typedWord),
  source(pythonLanguage, (code) => code.pythonGlobals, typedWord),
  source(pythonLanguage, (code) => code.pythonModuleSource, PY_IMPORT_LINE),
  source(pythonLanguage, (code) => code.pythonMemberSource, PY_MEMBER),
  suggestionLoaders("python", "python"),
]);

const CPP_SUPPORT = cpp();

/**
 * C and C++ (headers too, as today) share the grammar; each gets its keywords and snippets, your
 * own names (the file's and its quoted headers'), its library names (functions and macros,
 * #include lines and headers; std:: names in C++), and starts loading the completion code, then
 * the library data and the included headers' names, when one of its files is shown. Your own and
 * library names go only where a keyword could (keyword-completion.ts wordSource).
 */
const SUPPORT: Readonly<Record<LanguageId, Extension>> = {
  python: PYTHON_SUPPORT,
  c: [
    CPP_SUPPORT,
    source(cppLanguage, (code) => code.cKeywords, typedWord),
    source(cppLanguage, (code) => code.wordSource(code.cOwnSource(code.C_KEYWORDS)), typedWord),
    source(cppLanguage, (code) => code.wordSource(code.cLibrarySource("c", code.C_KEYWORDS)), typedWord),
    source(cppLanguage, (code) => code.includeSource("c"), INCLUDE_PATH),
    source(cppLanguage, (code) => code.includeLineSource("c"), DIRECTIVE),
    suggestionLoaders("c", "c"),
  ],
  cpp: [
    CPP_SUPPORT,
    source(cppLanguage, (code) => code.cppKeywords, typedWord),
    source(cppLanguage, (code) => code.wordSource(code.cOwnSource(code.CPP_KEYWORDS)), typedWord),
    source(cppLanguage, (code) => code.wordSource(code.cLibrarySource("cpp", code.CPP_KEYWORDS)), typedWord),
    source(cppLanguage, (code) => code.includeSource("cpp"), INCLUDE_PATH),
    source(cppLanguage, (code) => code.includeLineSource("cpp"), DIRECTIVE),
    source(cppLanguage, (code) => code.stdSource, STD_SCOPE),
    suggestionLoaders("c", "c"),
  ],
};

/** The grammar a workspace path is edited with (headers use C++), or null for plain text. */
export function languageForPath(path: string): LanguageId | null {
  return editorLanguage(nameOf(path));
}

/** Grammar, indentation, folding and completion for `id` (nothing for plain text). Shared instances. */
export function languageSupport(id: LanguageId | null): Extension {
  return id ? SUPPORT[id] : [];
}
