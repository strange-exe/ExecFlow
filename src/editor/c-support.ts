// C and C++'s language chunk (headers too): they share lang-cpp's grammar. language-support.ts
// loads it with import() when a C, C++ or header file opens, as python-support.ts explains, and it
// imports the editor chunk's entry for the reason given there.
import "./editor-manager";

import { cpp, cppLanguage } from "@codemirror/lang-cpp";
import type { Extension } from "@codemirror/state";
import { suggestionLoaders } from "./completion-loader";
import { C_KEYWORDS, cKeywords, CPP_KEYWORDS, cppKeywords, includeLineSource, wordSource } from "./keyword-completion";
import { INCLUDE_PATH, source, STD_SCOPE, typedWord, writable } from "./language-sources";

const GRAMMAR = cpp();

/**
 * Each of C and C++ gets its keywords and snippets, your own names (the file's and its quoted
 * headers'), its library names (functions and macros, #include lines and headers; in C++ std::
 * names, and std names without the prefix after the file's own `using namespace std;`), and starts
 * loading the completion code, then the library data and the included headers' names, when one of
 * its files is shown. Your own and library names go only where a keyword could
 * (keyword-completion.ts wordSource).
 */
export const C_SUPPORT: Extension = [
  GRAMMAR,
  writable(cppLanguage, cKeywords),
  source(cppLanguage, (code) => wordSource(code.cOwnSource(C_KEYWORDS)), typedWord),
  source(cppLanguage, (code) => wordSource(code.cLibrarySource("c", C_KEYWORDS)), typedWord),
  source(cppLanguage, (code) => code.includeSource("c"), INCLUDE_PATH),
  writable(cppLanguage, includeLineSource("c")),
  suggestionLoaders("c", "c"),
];

export const CPP_SUPPORT: Extension = [
  GRAMMAR,
  writable(cppLanguage, cppKeywords),
  source(cppLanguage, (code) => wordSource(code.cOwnSource(CPP_KEYWORDS)), typedWord),
  source(cppLanguage, (code) => wordSource(code.cLibrarySource("cpp", CPP_KEYWORDS)), typedWord),
  source(cppLanguage, (code) => wordSource(code.usingStdSource), typedWord),
  source(cppLanguage, (code) => code.includeSource("cpp"), INCLUDE_PATH),
  writable(cppLanguage, includeLineSource("cpp")),
  source(cppLanguage, (code) => code.stdSource, STD_SCOPE),
  suggestionLoaders("c", "c"),
];
