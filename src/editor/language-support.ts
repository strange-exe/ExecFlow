// Grammar and completion per file. Python gets @codemirror/lang-python, which already completes
// keywords, builtins and local names. C, C++ and headers share the C++ grammar (core/languages.ts
// editorLanguage) but get different keyword lists. The C/C++ completion source is a
// cppLanguage.data.of(...) extension placed in each file's own compartment (extensions.ts
// fileConf), never added to the shared cppLanguage, so a .c file never offers "class".
// Every instance is built once and shared by all states.

import { completeFromList, ifNotIn, type Completion } from "@codemirror/autocomplete";
import { cpp, cppLanguage } from "@codemirror/lang-cpp";
import { python } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";
import { editorLanguage, type LanguageId } from "../core/languages";
import { nameOf } from "../core/paths";

/** @lezer/cpp 1.1.6 nodes where keyword completion would only get in the way. */
export const CPP_SKIP: readonly string[] = [
  "LineComment", "BlockComment", "String", "RawString", "ConcatenatedString", "CharLiteral", "SystemLibString",
];

const C_TYPES = ["char", "double", "float", "int", "long", "short", "signed", "unsigned", "void", "bool", "_Bool", "_Complex"];

/** C17 keywords plus bool/true/false/NULL, which students meet through stdbool.h and stdio.h. */
export const C_KEYWORDS: readonly string[] = [
  ...C_TYPES,
  "auto", "break", "case", "const", "continue", "default", "do", "else", "enum", "extern", "for", "goto", "if",
  "inline", "register", "restrict", "return", "sizeof", "static", "struct", "switch", "typedef", "union",
  "volatile", "while", "_Alignas", "_Alignof", "_Atomic", "_Generic", "_Imaginary", "_Noreturn",
  "_Static_assert", "_Thread_local", "true", "false", "NULL",
];

const CPP_TYPES = ["bool", "char", "char8_t", "char16_t", "char32_t", "double", "float", "int", "long", "short", "signed", "unsigned", "void", "wchar_t", "auto"];

/** C++20 keywords. */
export const CPP_KEYWORDS: readonly string[] = [
  ...CPP_TYPES,
  "alignas", "alignof", "and", "and_eq", "asm", "bitand", "bitor", "break", "case", "catch", "class", "compl",
  "concept", "const", "consteval", "constexpr", "constinit", "const_cast", "continue", "co_await", "co_return",
  "co_yield", "decltype", "default", "delete", "do", "dynamic_cast", "else", "enum", "explicit", "export",
  "extern", "false", "for", "friend", "goto", "if", "inline", "mutable", "namespace", "new", "noexcept", "not",
  "not_eq", "nullptr", "operator", "or", "or_eq", "private", "protected", "public", "register",
  "reinterpret_cast", "requires", "return", "sizeof", "static", "static_assert", "static_cast", "struct",
  "switch", "template", "this", "thread_local", "throw", "true", "try", "typedef", "typeid", "typename", "union",
  "using", "virtual", "volatile", "while", "xor", "xor_eq",
];

const CONSTANTS = new Set(["true", "false", "NULL", "nullptr"]);

function options(words: readonly string[], types: readonly string[]): Completion[] {
  return [...new Set(words)].map((label) => ({
    label,
    type: types.includes(label) ? "type" : CONSTANTS.has(label) ? "constant" : "keyword",
  }));
}

const CPP_SUPPORT = cpp();

const SUPPORT: Readonly<Record<LanguageId, Extension>> = {
  python: python(),
  c: [CPP_SUPPORT, cppLanguage.data.of({ autocomplete: ifNotIn([...CPP_SKIP], completeFromList(options(C_KEYWORDS, C_TYPES))) })],
  cpp: [CPP_SUPPORT, cppLanguage.data.of({ autocomplete: ifNotIn([...CPP_SKIP], completeFromList(options(CPP_KEYWORDS, CPP_TYPES))) })],
};

/** The grammar a workspace path is edited with (headers use C++), or null for plain text. */
export function languageForPath(path: string): LanguageId | null {
  return editorLanguage(nameOf(path));
}

/** Grammar, indentation, folding and completion for `id` (nothing for plain text). Shared instances. */
export function languageSupport(id: LanguageId | null): Extension {
  return id ? SUPPORT[id] : [];
}
