// Keywords and snippets, and where they fit. Python gets our own list of keywords and snippets:
// lang-python 6.2.1's list lacks most keywords, and its class snippet over-indents the __init__
// body. C, C++ and headers share the C++ grammar but get different
// keyword lists, each with its snippets, and the common #include line while a directive is typed.
// No keyword, snippet or library name is offered where none fits: in strings and comments, on
// preprocessor lines, after `.`, `->` and `::` in C/C++, in import statements and after a dot in
// Python.
//
// This file is in the editor chunk (language-support.ts imports it), so keywords and snippets are
// offered even when the completion chunk (completion-code.ts: library and own names) can't load,
// as C and C++ keywords were before Tier 1 (Python then also had lang-python's built-in and local
// names, now the completion chunk's). It imports nothing from that chunk (completion-chunk.test.ts
// checks); the completion chunk imports the guards, the import-statement reader and the ranking helper from
// here. Python's built-in names are library-completion.ts's: with them here the editor chunk passed
// its 200 kB gzip budget (research doc section 3). Every instance is built once.

import {
  completeFromList, snippet, snippetCompletion, type Completion, type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

// ---------------------------------------------------------------- shared helpers

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** Whether `pos` is inside (or at the end of) a node named in `names`. */
export function inside(state: EditorState, pos: number, names: readonly string[]): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.includes(node.name)) return true;
  }
  return false;
}

/** The current line up to `pos`. */
export function lineBefore(state: EditorState, pos: number): string {
  return state.sliceDoc(state.doc.lineAt(pos).from, pos);
}

/** A result is refiltered, not asked again, while what was typed since its start is a word. */
export const WORD = /^\w*$/;

/** A source's own first check: true where it has nothing to offer at `pos`. Cheap: it runs on each key. */
export type Nothing = (state: EditorState, pos: number) => boolean;

/**
 * `source` where `nothing` doesn't hold; null elsewhere. CodeMirror 6.20.3 puts a source that
 * answered null back to pending on each key typed with the list open (@codemirror/autocomplete
 * dist/index.js, ActiveSource.update), so most keys run a new query 100 ms later. An empty answer
 * that stays valid while the word is typed avoids those queries, but then every key's refilter,
 * sort and redraw runs inside the key's own task: measured alone at 4x against this null answer,
 * lab INP 112-128 ms against 80-96 ms and more long tasks (2026-10-22, research doc section 3), so
 * the null answer stays.
 */
export function unless(nothing: Nothing, source: CompletionSource): CompletionSource {
  return (context) => (nothing(context.state, context.pos) ? null : source(context));
}

// ---------------------------------------------------------------- ranking

/**
 * The C names a beginner reaches for most, most common first (library-completion.ts BEGINNER
 * explains the ranking and has the other lists): the main, printf and scanf snippets below rank
 * with the library's functions of those names.
 */
export const BEGINNER_C_NAMES: readonly string[] = [
  "main", "printf", "scanf", "puts", "strlen", "strcpy", "strcmp", "strcat", "getchar", "putchar", "fgets", "malloc", "free",
  "rand", "srand", "sqrt", "pow", "abs", "exit",
];

/** The first name's boost; each later one gets one less. Below 100: a better match still wins. */
const BOOST_TOP = 90;

/** Each beginner list's boosts, made the first time the list is used. */
const BOOSTS = new WeakMap<readonly string[], ReadonlyMap<string, number>>();

/** `option` with its boost when its label is in the beginner list `names`. */
export function boosted<T extends Completion>(names: readonly string[], option: T): T {
  let boosts = BOOSTS.get(names);
  if (!boosts) BOOSTS.set(names, (boosts = new Map(names.map((name, i) => [name, BOOST_TOP - i]))));
  const boost = boosts.get(option.label);
  return boost === undefined ? option : { ...option, boost };
}

// ---------------------------------------------------------------- Python

/** lang-python 6.2.1's skip list (`dontComplete`, not exported): no globals inside these nodes. */
export const PYTHON_SKIP: readonly string[] = ["String", "FormatString", "Comment", "PropertyName"];

/** Nodes where no Python name fits (lang-python 6.2.1 names). */
export const PY_TEXT: readonly string[] = ["String", "FormatString", "Comment"];
/** A module name Python can import (ASCII names; that is every standard one). */
export const PY_IDENT = /^[A-Za-z_]\w*$/;

export type PythonImportContext =
  /** A (sub)module name after `import` or `from`: `parent` is the dotted part before it. */
  | { kind: "module"; parent: readonly string[]; from: number }
  /** A name after `from module import`. */
  | { kind: "member"; module: string; from: number }
  /** An alias after `as`, or a relative import: no name from any list fits. */
  | { kind: "none" };

const ALIAS = /^\s*(?:from\s+\S+\s+)?import\s.*\bas\s+\w*$/;
const IMPORT_LIST = /^\s*import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*([\w.]*)$/;
const FROM_MODULE = /^\s*from\s+([\w.]*)$/;
const FROM_NAMES = /^\s*from\s+([\w.]+)\s+import\s+\(?\s*(?:\w+(?:\s+as\s+\w+)?\s*,\s*)*(\w*)$/;

/**
 * What an import statement wants at `pos`, or null outside one (and inside strings and comments).
 * Read from the line's text, which an unfinished statement still has; one statement per line.
 */
export function pythonImportContext(state: EditorState, pos: number): PythonImportContext | null {
  if (inside(state, pos, PY_TEXT)) return null;
  const before = lineBefore(state, pos);
  if (ALIAS.test(before)) return { kind: "none" };
  const modules = IMPORT_LIST.exec(before) ?? FROM_MODULE.exec(before);
  if (modules) {
    const parts = modules[1].split(".");
    const word = parts.pop()!;
    // ".x" or "a..b": a relative import, which the run's single search folder can't serve.
    if (parts.some((p) => !PY_IDENT.test(p))) return { kind: "none" };
    return { kind: "module", parent: parts, from: pos - word.length };
  }
  const names = FROM_NAMES.exec(before);
  if (names) return names[1].split(".").every((p) => PY_IDENT.test(p)) ? { kind: "member", module: names[1], from: pos - names[2].length } : { kind: "none" };
  return null;
}

/** After a dot (`math.`, `"a".`, `1.`): no plain name fits there, only a member. */
export function afterDot(state: EditorState, pos: number): boolean {
  return /\.\w*$/.test(lineBefore(state, pos));
}

/**
 * Keywords lang-python's list leaves out. The rest (def, for, while, try, if, class, import, from)
 * are snippets below; False, None and True are keywords offered as constants (lang-python's kind).
 * Python's built-in names (print, len, ValueError) are library-completion.ts PYTHON_BUILTINS.
 */
export const PYTHON_KEYWORDS: readonly string[] = [
  "and", "as", "assert", "async", "await", "break", "case", "continue", "del", "elif", "else", "except", "finally",
  "global", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "with", "yield",
];
const PYTHON_CONSTANT_KEYWORDS: readonly string[] = ["False", "None", "True"];

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

/** Python's keywords and snippets. */
export const PYTHON_WORDS: readonly Completion[] = [
  ...PYTHON_CONSTANT_KEYWORDS.map((label) => ({ label, type: "constant" })),
  ...PYTHON_KEYWORDS.map((label) => ({ label, type: "keyword" })),
  ...PYTHON_SNIPPETS,
];

/**
 * Where plain names (local names, builtins, keywords) don't fit: in an import statement (`import ma`
 * wants a module, not map or max) or after a dot (`math.` wants a member): the library sources
 * offer those.
 */
export const noPlainNames: Nothing = (state, pos) => pythonImportContext(state, pos) !== null || afterDot(state, pos);

/** `source` where plain names fit (noPlainNames). */
export function plainNamesOnly(source: CompletionSource): CompletionSource {
  return unless(noPlainNames, source);
}

/** A fixed list of Python words, where plain names fit and not in lang-python's skip list. */
export function pythonWordSource(options: readonly Completion[]): CompletionSource {
  return unless((state, pos) => inside(state, pos, PYTHON_SKIP) || noPlainNames(state, pos), completeFromList([...options]));
}

/** Python's keywords and snippets (the built-in names are library-completion.ts pythonBuiltins). */
export const pythonKeywords: CompletionSource = pythonWordSource(PYTHON_WORDS);

// ---------------------------------------------------------------- C and C++

export type CLang = "c" | "cpp";

/** @lezer/cpp 1.1.6 nodes where keyword completion would only get in the way. */
export const CPP_SKIP: readonly string[] = [
  "LineComment", "BlockComment", "String", "RawString", "ConcatenatedString", "CharLiteral", "SystemLibString",
];

/** @lezer/cpp 1.1.6 comment nodes. */
export const C_COMMENTS: readonly string[] = ["LineComment", "BlockComment"];

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
  return unless(keywordsDontFit, source);
}

// A tab after a newline is one indent unit past the first line's; ${name} fields with the same
// name are edited together (the loop variable). "\\n" is a backslash and n in the inserted code.
const LOOPS_AND_BLOCKS: readonly Completion[] = [
  snippetCompletion("for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}", { label: "for", detail: "loop", type: "keyword" }),
  snippetCompletion("while (${condition}) {\n\t${}\n}", { label: "while", detail: "loop", type: "keyword" }),
  snippetCompletion("if (${condition}) {\n\t${}\n}", { label: "if", detail: "block", type: "keyword" }),
  snippetCompletion("if (${condition}) {\n\t${}\n} else {\n\t${}\n}", { label: "if", detail: "/ else block", type: "keyword" }),
  snippetCompletion("switch (${expression}) {\ncase ${constant}:\n\t${}\n\tbreak;\ndefault:\n\tbreak;\n}", { label: "switch", detail: "block", type: "keyword" }),
  snippetCompletion("struct ${Name} {\n\t${}\n};", { label: "struct", detail: "definition", type: "keyword" }),
  // With the library's printf and scanf boost (BEGINNER_C_NAMES): the statement keeps its place just above the function.
  snippetCompletion('printf("${}\\n");', boosted(BEGINNER_C_NAMES, { label: "printf", detail: "statement", type: "keyword" })),
  snippetCompletion('scanf("${%d}", &${variable});', boosted(BEGINNER_C_NAMES, { label: "scanf", detail: "statement", type: "keyword" })),
];

/** A return type typed just before main, a word of its own (`int `, `static int `, `void `). */
const MAIN_TYPE = /(?:^|[^\w$])(int|void)\s+$/;

/**
 * The main snippet: the whole function where main starts the declaration, and only the rest of it
 * after a return type typed before it. With the top option picked, "int main" + Enter used to
 * write "int int main(void) {", which doesn't compile (review, 2026-10-28). After void the body
 * has no `return 0;`, and the type stays the one typed (the compiler says what it thinks of it).
 */
function mainSnippet(templates: Readonly<Record<"whole" | "int" | "void", string>>): Completion {
  const apply = { whole: snippet(templates.whole), int: snippet(templates.int), void: snippet(templates.void) };
  return boosted(BEGINNER_C_NAMES, {
    label: "main",
    detail: "function",
    type: "keyword",
    apply: (view, completion, from, to) => {
      const type = MAIN_TYPE.exec(lineBefore(view.state, from))?.[1] as "int" | "void" | undefined;
      apply[type ?? "whole"](view, completion, from, to);
    },
  });
}

/** Snippets for C files, offered with the keywords (and under the same guard). */
export const C_SNIPPETS: readonly Completion[] = [
  mainSnippet({ whole: "int main(void) {\n\t${}\n\treturn 0;\n}", int: "main(void) {\n\t${}\n\treturn 0;\n}", void: "main(void) {\n\t${}\n}" }),
  ...LOOPS_AND_BLOCKS,
];

/** Snippets for C++ files and headers. */
export const CPP_SNIPPETS: readonly Completion[] = [
  mainSnippet({ whole: "int main() {\n\t${}\n}", int: "main() {\n\t${}\n}", void: "main() {\n\t${}\n}" }),
  ...LOOPS_AND_BLOCKS,
  snippetCompletion("class ${Name} {\npublic:\n\t${}\n};", { label: "class", detail: "definition", type: "keyword" }),
];

/** C's keywords and snippets, where a keyword fits. */
export const cKeywords: CompletionSource = wordSource(completeFromList([...options(C_KEYWORDS, C_TYPES, C_DETAILS), ...C_SNIPPETS]));

/** C++'s keywords and snippets (headers too), where a keyword fits. */
export const cppKeywords: CompletionSource = wordSource(completeFromList([...options(CPP_KEYWORDS, CPP_TYPES), ...CPP_SNIPPETS]));

const INCLUDE_LINES: Readonly<Record<CLang, readonly Completion[]>> = {
  c: [snippetCompletion("#include <stdio.h>", { label: "#include <stdio.h>", type: "keyword" })],
  cpp: [snippetCompletion("#include <iostream>", { label: "#include <iostream>", type: "keyword" })],
};

const DIRECTIVE_START = /^\s*(#\s*(\w*))$/;

/** Not while `#include` is being typed at the start of a line ("#", "#in"), or in a comment. */
const notIncludeDirective: Nothing = (state, pos) => {
  const m = DIRECTIVE_START.exec(lineBefore(state, pos));
  return !m || !"include".startsWith(m[2]) || inside(state, pos, C_COMMENTS);
};

/** The common #include line, while `#include` is being typed at the start of a line ("#", "#in"). */
export function includeLineSource(lang: CLang): CompletionSource {
  return unless(notIncludeDirective, (context) => {
    const m = DIRECTIVE_START.exec(lineBefore(context.state, context.pos))!;
    return {
      from: context.pos - m[1].length,
      options: [...INCLUDE_LINES[lang]],
      validFor: (text) => /^#\s*(\w*)$/.test(text) && "include".startsWith(text.replace(/^#\s*/, "")),
    };
  });
}
