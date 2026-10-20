// Keywords, snippets and built-in names, and where they fit. Python gets lang-python's local-name
// source (the open file's own names, with their kinds) and our own list of globals: lang-python
// 6.2.1's list lacks most keywords, and its class snippet over-indents the __init__ body. C, C++
// and headers share the C++ grammar but get different keyword lists, each with its snippets
// (library-completion.ts C_SNIPPETS, CPP_SNIPPETS). No keyword, snippet or library name is
// offered where none fits: in strings and comments, on preprocessor lines, after `.`, `->` and
// `::` in C/C++, in import statements and after a dot in Python.
// This file is in the completion chunk (completion-code.ts) with the library and own-name sources;
// language-support.ts places each source in a file's language data. Every instance is built once.

import { completeFromList, ifNotIn, snippetCompletion, type Completion, type CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { localCompletionSource } from "@codemirror/lang-python";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { afterDot, C_SNIPPETS, CPP_SNIPPETS, pythonImportContext } from "./library-completion";
import { safeLabel } from "./own-names";

// ---------------------------------------------------------------- Python

/** lang-python 6.2.1's skip list (`dontComplete`, not exported): no globals inside these nodes. */
export const PYTHON_SKIP: readonly string[] = ["String", "FormatString", "Comment", "PropertyName"];

// lang-python 6.2.1's built-in names, copied as it lists them (its arrays aren't exported).
const PYTHON_CONSTANTS = [
  "__annotations__", "__builtins__", "__debug__", "__doc__", "__import__", "__name__", "__loader__", "__package__",
  "__spec__", "False", "None", "True",
];
const PYTHON_TYPES = [
  "ArithmeticError", "AssertionError", "AttributeError", "BaseException", "BlockingIOError", "BrokenPipeError",
  "BufferError", "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError",
  "ConnectionRefusedError", "ConnectionResetError", "DeprecationWarning", "EOFError", "Ellipsis", "EncodingWarning",
  "EnvironmentError", "Exception", "FileExistsError", "FileNotFoundError", "FloatingPointError", "FutureWarning",
  "GeneratorExit", "IOError", "ImportError", "ImportWarning", "IndentationError", "IndexError", "InterruptedError",
  "IsADirectoryError", "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError", "ModuleNotFoundError",
  "NameError", "NotADirectoryError", "NotImplemented", "NotImplementedError", "OSError", "OverflowError",
  "PendingDeprecationWarning", "PermissionError", "ProcessLookupError", "RecursionError", "ReferenceError",
  "ResourceWarning", "RuntimeError", "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError",
  "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "TypeError", "UnboundLocalError",
  "UnicodeDecodeError", "UnicodeEncodeError", "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning",
  "ValueError", "Warning", "ZeroDivisionError",
];
const PYTHON_CLASSES = [
  "bool", "bytearray", "bytes", "classmethod", "complex", "float", "frozenset", "int", "list", "map", "memoryview",
  "object", "range", "set", "staticmethod", "str", "super", "tuple", "type",
];
const PYTHON_FUNCTIONS = [
  "abs", "aiter", "all", "anext", "any", "ascii", "bin", "breakpoint", "callable", "chr", "compile", "delattr", "dict",
  "dir", "divmod", "enumerate", "eval", "exec", "exit", "filter", "format", "getattr", "globals", "hasattr", "hash",
  "help", "hex", "id", "input", "isinstance", "issubclass", "iter", "len", "license", "locals", "max", "min", "next",
  "oct", "open", "ord", "pow", "print", "property", "quit", "repr", "reversed", "round", "setattr", "slice", "sorted",
  "sum", "vars", "zip",
];

/**
 * Keywords lang-python's list leaves out. The rest (def, for, while, try, if, class, import, from)
 * are snippets below; False, None and True are constants.
 */
export const PYTHON_KEYWORDS: readonly string[] = [
  "and", "as", "assert", "async", "await", "break", "case", "continue", "del", "elif", "else", "except", "finally",
  "global", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "with", "yield",
];

// lang-python 6.2.1's snippets. A tab after a newline is one indent unit past the first line's.
const PYTHON_SNIPPETS: readonly Completion[] = [
  snippetCompletion("def ${name}(${params}):\n\t${}", { label: "def", detail: "function", type: "keyword" }),
  snippetCompletion("for ${name} in ${collection}:\n\t${}", { label: "for", detail: "loop", type: "keyword" }),
  snippetCompletion("while ${}:\n\t${}", { label: "while", detail: "loop", type: "keyword" }),
  snippetCompletion("try:\n\t${}\nexcept ${error}:\n\t${}", { label: "try", detail: "/ except block", type: "keyword" }),
  snippetCompletion("if ${}:\n\t\n", { label: "if", detail: "block", type: "keyword" }),
  snippetCompletion("if ${}:\n\t${}\nelse:\n\t${}", { label: "if", detail: "/ else block", type: "keyword" }),
  // Two tabs before the body, not lang-python's three (which put it 12 spaces in, not 8).
  snippetCompletion("class ${name}:\n\tdef __init__(self, ${params}):\n\t\t${}", { label: "class", detail: "definition", type: "keyword" }),
  snippetCompletion("import ${module}", { label: "import", detail: "statement", type: "keyword" }),
  snippetCompletion("from ${module} import ${names}", { label: "from", detail: "import", type: "keyword" }),
];

/** Every fixed Python suggestion: built-in names, keywords and snippets. */
export const PYTHON_GLOBALS: readonly Completion[] = [
  ...PYTHON_CONSTANTS.map((label) => ({ label, type: "constant" })),
  ...PYTHON_TYPES.map((label) => ({ label, type: "type" })),
  ...PYTHON_CLASSES.map((label) => ({ label, type: "class" })),
  ...PYTHON_FUNCTIONS.map((label) => ({ label, type: "function" })),
  ...PYTHON_KEYWORDS.map((label) => ({ label, type: "keyword" })),
  ...PYTHON_SNIPPETS,
];

/**
 * Plain names (local names, builtins, keywords) don't fit in an import statement (`import ma` wants
 * a module, not map or max) or after a dot (`math.` wants a member): the library sources offer those.
 */
function plainNamesOnly(source: CompletionSource): CompletionSource {
  return (context) => (pythonImportContext(context.state, context.pos) || afterDot(context.state, context.pos) ? null : source(context));
}

/**
 * lang-python's local names without any that hold a direction or hidden character (own-names.ts
 * safeLabel; review finding S1): accepting one would type it, and the list wouldn't mark it.
 * localCompletionSource answers synchronously (lang-python 6.2.1).
 */
const safeLocalNames: CompletionSource = (context) => {
  const result = localCompletionSource(context);
  if (!result || result.options.every((o) => safeLabel(o.label))) return result;
  return { ...result, options: result.options.filter((o) => safeLabel(o.label)) };
};

/** The open Python file's own names (lang-python's local-name source), where plain names fit. */
export const pythonLocalNames: CompletionSource = plainNamesOnly(safeLocalNames);

/** Python's built-in names, keywords and snippets, where plain names fit. */
export const pythonGlobals: CompletionSource = ifNotIn([...PYTHON_SKIP], plainNamesOnly(completeFromList([...PYTHON_GLOBALS])));

// ---------------------------------------------------------------- C and C++

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

/** Words C has only through a header (-std=gnu11, src/runner/cpp-build.ts). */
const C_DETAILS: Readonly<Record<string, string>> = { bool: "needs <stdbool.h>", true: "needs <stdbool.h>", false: "needs <stdbool.h>" };

const CPP_TYPES = ["bool", "char", "char16_t", "char32_t", "double", "float", "int", "long", "short", "signed", "unsigned", "void", "wchar_t", "auto"];

/**
 * C++17 keywords, as our clang 8.0.1 accepts them. Left out: consteval and constinit (not keywords
 * before Clang 17 and 10), co_await, co_return and co_yield (only with -fcoroutines-ts, which the
 * build options can't pass), concept and requires (concepts arrived in Clang 10), and char8_t
 * (not in the default -std=c++17).
 */
export const CPP_KEYWORDS: readonly string[] = [
  ...CPP_TYPES,
  "alignas", "alignof", "and", "and_eq", "asm", "bitand", "bitor", "break", "case", "catch", "class", "compl",
  "const", "constexpr", "const_cast", "continue", "decltype", "default", "delete", "do", "dynamic_cast", "else",
  "enum", "explicit", "export", "extern", "false", "for", "friend", "goto", "if", "inline", "mutable", "namespace",
  "new", "noexcept", "not", "not_eq", "nullptr", "operator", "or", "or_eq", "private", "protected", "public",
  "register", "reinterpret_cast", "return", "sizeof", "static", "static_assert", "static_cast", "struct", "switch",
  "template", "this", "thread_local", "throw", "true", "try", "typedef", "typeid", "typename", "union", "using",
  "virtual", "volatile", "while", "xor", "xor_eq",
];

const CONSTANTS = new Set(["true", "false", "NULL", "nullptr"]);

function options(words: readonly string[], types: readonly string[], details: Readonly<Record<string, string>> = {}): Completion[] {
  return [...new Set(words)].map((label) => ({
    label,
    type: types.includes(label) ? "type" : CONSTANTS.has(label) ? "constant" : "keyword",
    ...(Object.hasOwn(details, label) ? { detail: details[label] } : {}),
  }));
}

/** On a preprocessor line (`#def`, an unfinished `#include <st`), or a line a backslash continues one onto. */
function onPreprocessorLine(state: EditorState, pos: number): boolean {
  let line = state.doc.lineAt(pos);
  let text = state.sliceDoc(line.from, pos);
  while (line.number > 1) {
    const prev = state.doc.line(line.number - 1);
    if (!prev.text.endsWith("\\")) break;
    line = prev;
    text = prev.text;
  }
  return /^\s*#/.test(text);
}

/**
 * Places where no keyword can follow (node names checked against @lezer/cpp 1.1.6 parses): comments,
 * strings and include paths; preprocessor lines; a member name after `.` or `->` (FieldIdentifier
 * in a FieldExpression, or the FieldExpression itself while nothing is typed yet); and either side
 * of `::` (the NamespaceIdentifier before it, the `::` token, the name right after it). Only a
 * NamespaceIdentifier that `::` follows: at the end of a file the parser also takes an unfinished
 * `class Dog : pu`, `typedef st` or `template <ty` for one, and those want keywords.
 */
export function keywordsDontFit(state: EditorState, pos: number): boolean {
  const inner = syntaxTree(state).resolveInner(pos, -1);
  for (let node: typeof inner | null = inner; node; node = node.parent) {
    if (CPP_SKIP.includes(node.name)) return true;
    if (node.type.isTop) break;
  }
  if (onPreprocessorLine(state, pos)) return true;
  if (inner.name === "FieldExpression" || (inner.name === "FieldIdentifier" && inner.parent?.name === "FieldExpression")) return true;
  if (inner.name === "NamespaceIdentifier" && inner.nextSibling?.name === "::") return true;
  return inner.name === "::" || inner.prevSibling?.name === "::";
}

/** `source` where a keyword could go (keywordsDontFit): keywords, snippets, your own and library names. */
export function wordSource(source: CompletionSource): CompletionSource {
  return (context: CompletionContext) => (keywordsDontFit(context.state, context.pos) ? null : source(context));
}

/** C's keywords and snippets, where a keyword fits. */
export const cKeywords: CompletionSource = wordSource(completeFromList([...options(C_KEYWORDS, C_TYPES, C_DETAILS), ...C_SNIPPETS]));

/** C++'s keywords and snippets (headers too), where a keyword fits. */
export const cppKeywords: CompletionSource = wordSource(completeFromList([...options(CPP_KEYWORDS, CPP_TYPES), ...CPP_SNIPPETS]));
