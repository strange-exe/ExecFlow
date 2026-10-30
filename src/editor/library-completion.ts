// Suggestions from the library data (library-data.ts) and from the workspace's own files:
// - Python: module names after `import` and `from` (the standard library and the workspace's own
//   importable modules), a module's members after `from X import` and after `mod.` for a module this
//   file imported (`import math`, `import math as m`, `from os import path`), with the signature as
//   the detail. For your own module (`import helpers`) the members are its top-level defs, classes
//   and assignments, read from its syntax tree by the workspace index (workspace-index.ts).
// - C and C++: header names on `#include <` and `#include "` lines, library functions and macros
//   (detail: the prototype or value; info: our own one line naming the header), and std:: names in
//   C++ (grouped by header). Common names rank first among equal matches (BEGINNER). Keywords and
//   snippets are keyword-completion.ts's, in the editor chunk; Python's built-in names are here.
// This file is in the completion chunk (completion-code.ts), which the editor chunk loads with
// import() (completion-loader.ts). language-support.ts puts each source in a file's own language
// data, inside writable(), so a read-only file has none. Nothing here offers a word inside a string
// or a comment. Every list is filtered by CodeMirror's matcher; sources return validFor, so typing
// inside a word refilters without a new query, except for a list built while data it needs was
// missing (late-data.ts: the next key asks again, and the query runs again once the data is there).
// Where a source has nothing to offer (not an #include line, no `std::`), it answers null
// (keyword-completion.ts unless says why).

import type { Completion, CompletionContext, CompletionResult, CompletionSection, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView, PluginValue } from "@codemirror/view";
import { isHeader } from "../core/languages";
import { isConflictCopy, nameOf, parentOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { DEFAULT_BUILD, findQuotedInclude } from "../runner/cpp-build";
import { filePath, libraryContext, type LibraryContext } from "./completion-context";
import {
  BEGINNER_C_NAMES, boosted, C_COMMENTS, CPP_KEYWORDS, inside, lineBefore, PY_IDENT, PY_TEXT, pythonImportContext, pythonWordSource,
  unless, WORD, type CLang, type Nothing,
} from "./keyword-completion";
import { whenDataArrives } from "./late-data";
import { library, libraryStatus, loadLibrary, type CLibrary, type LibraryId, type PythonKind, type PythonLibrary } from "./library-data";
import { ownOptions } from "./own-names";
import { indexOf } from "./workspace-index";

// ---------------------------------------------------------------- what the app tells the editor

const NO_CONTEXT: LibraryContext = { files: () => [], standards: () => ({ c: DEFAULT_BUILD.cStd, cpp: DEFAULT_BUILD.cxxStd }) };

/** The app's library context (completion-context.ts libraryContext), or no files and the default standards. */
export function contextOf(state: EditorState): LibraryContext {
  return state.facet(libraryContext) ?? NO_CONTEXT;
}

/**
 * While a file that uses `id`'s data is shown (completion-loader.ts suggestionLoaders): starts
 * loading it, and says how far the load got on the editor element (data-library: loading, ready or
 * failed), for tests to wait on.
 */
export function libraryLoader(view: EditorView, id: LibraryId): PluginValue {
  let live = true;
  const mark = () => {
    if (live) view.dom.setAttribute("data-library", libraryStatus(id));
  };
  void loadLibrary(id).then(mark);
  mark();
  return {
    destroy() {
      live = false;
      view.dom.removeAttribute("data-library");
    },
  };
}

// ---------------------------------------------------------------- shared helpers

/**
 * The library's data, or null: then the load starts, the source offers nothing from it (and no
 * validFor), and the query runs again once the data is there (late-data.ts).
 */
function loaded<K extends LibraryId>(id: K, context: CompletionContext) {
  const data = library(id);
  if (!data) whenDataArrives(context, loadLibrary(id));
  return data;
}

/** A result for `options` from `from`, refiltered as typed (validFor) only when nothing was missing; null with no option. */
function result(from: number, options: readonly Completion[], complete: boolean, validFor: RegExp = WORD): CompletionResult | null {
  return options.length ? { from, options: [...options], ...(complete ? { validFor } : {}) } : null;
}

/**
 * Section headings (the header a name is declared in) are drawn for the eye only: each option's
 * info says the same in words, and the info is what a screen reader is pointed at.
 */
function sectionHeading(section: CompletionSection): HTMLElement {
  const heading = document.createElement("completion-section");
  heading.textContent = section.name;
  heading.setAttribute("aria-hidden", "true");
  return heading;
}

const sections = new Map<string, CompletionSection>();

/** One section per header; "dynamic": the section with the best match comes first. */
function sectionFor(name: string, rank: CompletionSection["rank"] = "dynamic"): CompletionSection {
  const key = `${name}\n${rank}`;
  let section = sections.get(key);
  if (!section) sections.set(key, (section = { name, rank, header: sectionHeading }));
  return section;
}

/** Own-property lookup: a typed name like "constructor" must not reach Object.prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------- ranking

/**
 * The names a beginner reaches for most, most common first: our own short lists, from what
 * introductory courses use first. CodeMirror ranks options by how well they match what was typed
 * (a whole name, then a prefix, then letters in order with gaps: steps of 100 and more), then by
 * label. A boost is added to that score (-99 to 99, keyword-completion.ts boosted), so these lead
 * the options that match equally well (`str`: strlen before strcat and struct; `import ma`: math
 * before mailbox and marshal) and never pass a better match. Library names carry no section in
 * mixed lists (only the C++ header groups and std:: names have one), because CodeMirror puts every
 * option without a section above every option with one, however well it matches (review finding
 * RB-2, 2026-10-19). cNames is keyword-completion.ts's, which the C snippets rank with too.
 */
export const BEGINNER: Readonly<Record<"pyModules" | "cHeaders" | "cNames" | "cppHeaders" | "stdNames", readonly string[]>> = {
  pyModules: ["math", "random", "string", "time", "datetime", "collections", "sys", "os"],
  cHeaders: ["stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "stdbool.h", "time.h"],
  cNames: BEGINNER_C_NAMES,
  cppHeaders: ["iostream", "string", "vector", "algorithm", "cmath"],
  stdNames: ["cout", "cin", "endl", "string", "vector", "getline", "sort", "max", "min", "swap", "to_string"],
};

// ---------------------------------------------------------------- Python
// (pythonImportContext, what an import statement wants at the cursor, is keyword-completion.ts's.)

// lang-python 6.2.1's built-in names, copied as it lists them (its arrays aren't exported), without
// False, None and True (keywords: keyword-completion.ts, in the editor chunk).
const PYTHON_CONSTANTS = [
  "__annotations__", "__builtins__", "__debug__", "__doc__", "__import__", "__name__", "__loader__", "__package__",
  "__spec__",
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

/** Python's built-in names (the builtins module, as lang-python lists it). */
export const PYTHON_BUILTINS: readonly Completion[] = [
  ...PYTHON_CONSTANTS.map((label) => ({ label, type: "constant" })),
  ...PYTHON_TYPES.map((label) => ({ label, type: "type" })),
  ...PYTHON_CLASSES.map((label) => ({ label, type: "class" })),
  ...PYTHON_FUNCTIONS.map((label) => ({ label, type: "function" })),
];

/** Python's built-in names, where the keywords go (keyword-completion.ts pythonWordSource). */
export const pythonBuiltins: CompletionSource = pythonWordSource(PYTHON_BUILTINS);

/**
 * The names this file's import statements bind, anywhere in it, to the module path each stands
 * for: `import math` (math), `import math as m` (m: math), `import os.path` (os), `import os.path
 * as p` (p: os.path), `from os import path` (path: os.path). Relative imports are left out.
 */
export function pythonImports(state: EditorState): Map<string, string> {
  const bound = new Map<string, string>();
  scanImports(state, bound);
  return bound;
}

/**
 * Every module path this file's import statements name: `import a.b` (a.b), `from x import y` (x,
 * and x.y in case y is a submodule), also `from x import` before any name is typed.
 */
export function pythonImportedModules(state: EditorState): Set<string> {
  const modules = new Set<string>();
  scanImports(state, new Map(), modules);
  return modules;
}

function scanImports(state: EditorState, bound: Map<string, string>, modules?: Set<string>): void {
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "ImportStatement") return;
      const tokens: { name: string; text: string }[] = [];
      for (let c = node.node.firstChild; c; c = c.nextSibling) tokens.push({ name: c.name, text: state.sliceDoc(c.from, c.to) });
      readImport(tokens, bound, modules);
      return false;
    },
  });
}

function readImport(tokens: readonly { name: string; text: string }[], bound: Map<string, string>, modules?: Set<string>): void {
  let i = 1;
  const at = (name: string, k = i) => tokens[k]?.name === name;
  /** VariableName ("." VariableName)* from i. */
  const dotted = (): string[] => {
    const parts: string[] = [];
    while (at("VariableName")) {
      parts.push(tokens[i++].text);
      if (!at(".") || !at("VariableName", i + 1)) break;
      i++;
    }
    return parts;
  };
  /** `as alias` from i, or null. */
  const alias = (): string | null => {
    if (!at("as") || !at("VariableName", i + 1)) return null;
    i += 2;
    return tokens[i - 1].text;
  };
  if (at("import", 0)) {
    while (i < tokens.length) {
      const parts = dotted();
      if (!parts.length) {
        i++;
        continue;
      }
      const name = alias();
      bound.set(name ?? parts[0], name ? parts.join(".") : parts[0]);
      modules?.add(parts.join("."));
    }
  } else if (at("from", 0)) {
    const module = dotted();
    if (!module.length || !at("import")) return; // a relative import, or unfinished
    modules?.add(module.join("."));
    for (i++; i < tokens.length; ) {
      if (!at("VariableName")) {
        i++;
        continue;
      }
      const name = tokens[i++].text;
      bound.set(alias() ?? name, `${module.join(".")}.${name}`);
      modules?.add(`${module.join(".")}.${name}`);
    }
  }
}

export interface WorkspaceModule {
  name: string;
  /** The module's file, or its folder (a package). */
  path: WsPath;
  folder: boolean;
}

/**
 * The workspace's own modules a Python file at `from` can import, below the dotted `parent`. A run
 * puts the folder of the file it runs first on sys.path (python-helper.ts __ce_run), and the
 * editor takes the open file as that file: `name.py` beside it is module `name`, and a folder
 * beside it holding .py files is package `name` (a namespace package needs no __init__.py), as
 * python-helper.ts _local_module finds them. Conflict copies are never sent to a run.
 */
export function workspaceModules(files: readonly WsPath[], from: WsPath, parent: readonly string[] = []): WorkspaceModule[] {
  const base = [parentOf(from), ...parent].filter((p) => p !== "").join("/");
  const prefix = base ? `${base}/` : "";
  const found = new Map<string, WorkspaceModule>();
  for (const path of files) {
    if (!path.endsWith(".py") || !path.startsWith(prefix) || path === from || isConflictCopy(path)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const folder = slash >= 0;
    const name = folder ? rest.slice(0, slash) : rest.slice(0, -3);
    if (!PY_IDENT.test(name) || name === "__init__") continue;
    // A file and a folder of one name: the file is what the run finds first (_local_module).
    if (!found.has(name) || (!folder && found.get(name)!.folder)) found.set(name, { name, path: folder ? `${prefix}${name}` : path, folder });
  }
  return [...found.values()];
}

/**
 * The workspace module a dotted module path names for a file at `from` (`helpers`, `pkg.mod`), or
 * null: when its first part isn't a workspace module, or a part past a module file (an attribute,
 * whose type isn't known here).
 */
export function workspaceModule(files: readonly WsPath[], from: WsPath, dotted: readonly string[]): WorkspaceModule | null {
  let found: WorkspaceModule | null = null;
  for (let i = 0; i < dotted.length; i++) {
    if (found && !found.folder) return null;
    found = workspaceModules(files, from, dotted.slice(0, i)).find((m) => m.name === dotted[i]) ?? null;
    if (!found) return null;
  }
  return found;
}

/** The file whose top-level names are a workspace module's members: the .py, or a package's __init__.py. */
function moduleFile(files: readonly WsPath[], m: WorkspaceModule): WsPath | null {
  if (!m.folder) return m.path;
  const init = `${m.path}/__init__.py`;
  return files.includes(init) ? init : null;
}

/**
 * The file a dotted name's members come from: that of the longest prefix that is a workspace
 * module (`helpers.greet` is helpers.py), or null when none is.
 */
export function workspaceModuleFile(files: readonly WsPath[], from: WsPath, dotted: readonly string[]): WsPath | null {
  for (let n = dotted.length; n > 0; n--) {
    const m = workspaceModule(files, from, dotted.slice(0, n));
    if (m) return moduleFile(files, m);
  }
  return null;
}

/**
 * A workspace module's members: the top-level defs, classes and assignments of its file (from the
 * workspace index, once it has read that file), then a package's own modules. One option per name.
 * `complete` is false while the index hasn't read the file: the query then runs again once it has.
 */
function workspaceMemberOptions(
  context: CompletionContext, files: readonly WsPath[], from: WsPath, dotted: readonly string[], m: WorkspaceModule,
): { options: Completion[]; complete: boolean } {
  const file = moduleFile(files, m);
  const index = indexOf(context.state);
  const known = file && index ? index.get(file) : null;
  const complete = !file || !index || known !== null;
  if (!complete) whenDataArrives(context, index!.nextUpdate());
  const out: Completion[] = [];
  const seen = new Set<string>();
  const add = (option: Completion) => {
    if (seen.has(option.label)) return;
    seen.add(option.label);
    out.push(option);
  };
  if (known && file) ownOptions(known.names, file).forEach(add);
  if (m.folder) workspaceModules(files, from, dotted).map(ownModuleOption).forEach(add);
  return { options: out, complete };
}

const PY_KIND_WORD: Readonly<Record<PythonKind, string>> = { class: "Class", constant: "Constant", function: "Function", namespace: "Module", variable: "Variable" };
const PY_KINDS = Object.keys(PY_KIND_WORD) as PythonKind[];

const pyCache = new WeakMap<PythonLibrary, Map<string, readonly Completion[]>>();

function cachedPy(lib: PythonLibrary, key: string, build: () => Completion[]): readonly Completion[] {
  let byKey = pyCache.get(lib);
  if (!byKey) pyCache.set(lib, (byKey = new Map()));
  let list = byKey.get(key);
  if (!list) byKey.set(key, (list = build()));
  return list;
}

/** Submodules the data knows of `module` ("os" has "path" through "os.path"). */
function submoduleNames(lib: PythonLibrary, module: string): string[] {
  const prefix = `${module}.`;
  return Object.keys(lib.members).filter((key) => key.startsWith(prefix) && !key.includes(".", prefix.length)).map((key) => key.slice(prefix.length));
}

/** The standard modules: top-level ones, or the submodules the data knows below `parent`. */
function stdModuleOptions(lib: PythonLibrary, parent: string): readonly Completion[] {
  return cachedPy(lib, `modules:${parent}`, () =>
    parent
      ? submoduleNames(lib, parent).map((label) => ({ label, type: "namespace", info: "Python standard library module" }))
      : lib.modules.map((label) => boosted(BEGINNER.pyModules, { label, type: "namespace", info: "Python standard library module" })),
  );
}

/** A module's members, kind by kind, with the signature as the detail, then its known submodules. */
function memberOptions(lib: PythonLibrary, module: string): readonly Completion[] {
  return cachedPy(lib, `members:${module}`, () => {
    const out: Completion[] = [];
    const kinds = own(lib.members, module);
    for (const kind of PY_KINDS) {
      const names = kinds?.[kind];
      if (!names) continue;
      for (const [label, signature] of Object.entries(names)) {
        out.push({ label, type: kind, ...(signature ? { detail: signature } : {}), info: `${PY_KIND_WORD[kind]} in ${module}` });
      }
    }
    for (const label of submoduleNames(lib, module)) {
      if (!out.some((o) => o.label === label)) out.push({ label, type: "namespace", info: `Module ${module}.${label}` });
    }
    return out;
  });
}

function ownModuleOption(m: WorkspaceModule): Completion {
  const shown = m.folder ? `${nameOf(m.path)}/` : nameOf(m.path);
  return { label: m.name, type: "namespace", detail: shown, info: m.folder ? `Your folder ${m.path}/` : `Your file ${m.path}` };
}

/** Outside an import statement, or where no name from any list fits in one (an alias). */
const notInImport: Nothing = (state, pos) => {
  const at = pythonImportContext(state, pos);
  return !at || at.kind === "none";
};

/** Module names after `import` and `from`; names after `from X import`. */
export const pythonModuleSource: CompletionSource = unless(notInImport, (context: CompletionContext) => {
  const { state } = context;
  const at = pythonImportContext(state, context.pos);
  if (!at || at.kind === "none") return null;
  const path = state.facet(filePath);
  const files = path ? contextOf(state).files() : [];
  const ownTop = path ? workspaceModules(files, path) : [];
  /** A workspace module of this name hides the standard one: its members are unknown here. */
  const shadowed = (top: string) => ownTop.some((m) => m.name === top);
  let options: readonly Completion[];
  let complete = true;
  /** The standard library's data, or null (it loads, and complete turns false). */
  const lib = () => {
    const data = loaded("python", context);
    if (!data) complete = false;
    return data;
  };
  if (at.kind === "module") {
    const ownHere = path ? workspaceModules(files, path, at.parent) : [];
    const names = new Set(ownHere.map((m) => m.name));
    const std = at.parent.length > 0 && shadowed(at.parent[0]) ? null : lib();
    const stdOptions = std ? stdModuleOptions(std, at.parent.join(".")) : [];
    options = [...ownHere.map(ownModuleOption), ...stdOptions.filter((o) => !names.has(o.label))];
  } else {
    const parts = at.module.split(".");
    if (path && shadowed(parts[0])) {
      // Your own module: what its file declares (and a package's modules).
      const m = workspaceModule(files, path, parts);
      const found = m ? workspaceMemberOptions(context, files, path, parts, m) : null;
      options = found?.options ?? [];
      complete = found?.complete ?? true;
    } else {
      const std = lib();
      options = std ? memberOptions(std, at.module) : [];
    }
  }
  return result(at.from, options, complete);
});

const MEMBER = /(?:^|[^\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(\w*)$/;

/** Not after `name.` (in text, in an import statement, or with no dotted name before the cursor). */
const notAfterName: Nothing = (state, pos) => inside(state, pos, PY_TEXT) || pythonImportContext(state, pos) !== null || !MEMBER.test(lineBefore(state, pos));

/**
 * Members after `mod.` (or `mod.sub.`) where this file imported `mod`: a standard module's from
 * the library data, your own module's (`import helpers`, then `helpers.`) from its syntax tree.
 */
export const pythonMemberSource: CompletionSource = unless(notAfterName, (context: CompletionContext) => {
  const { state, pos } = context;
  const m = MEMBER.exec(lineBefore(state, pos));
  if (!m) return null;
  const [head, ...rest] = m[1].split(".");
  const target = pythonImports(state).get(head);
  if (!target) return null;
  const dotted = [...target.split("."), ...rest];
  const path = state.facet(filePath);
  let options: readonly Completion[];
  let complete = true;
  const files = path ? contextOf(state).files() : [];
  if (path && workspaceModules(files, path).some((w) => w.name === dotted[0])) {
    // Your own module hides a standard one of the same name.
    const own = workspaceModule(files, path, dotted);
    const found = own ? workspaceMemberOptions(context, files, path, dotted, own) : null;
    options = found?.options ?? [];
    complete = found?.complete ?? true;
  } else {
    const lib = loaded("python", context);
    options = lib ? memberOptions(lib, dotted.join(".")) : [];
    complete = lib !== null;
  }
  return result(pos - m[2].length, options, complete);
});

// ---------------------------------------------------------------- C and C++

/** @lezer/cpp 1.1.6 text nodes no name goes in (comments, strings, characters). */
const C_TEXT: readonly string[] = [...C_COMMENTS, "String", "RawString", "ConcatenatedString", "CharLiteral"];

const SYSTEM_INCLUDE = /^\s*#\s*include\s*<([^<>"\s]*)$/;
const QUOTED_INCLUDE = /^\s*#\s*include\s*"([^"]*)$/;
const HEADER_CHARS = /^[\w./+-]*$/;

/** `../`s first in a spelling, so headers beside the file sort before ones further away. */
function relativeSpelling(dir: WsPath, path: WsPath): string {
  const from = dir ? dir.split("/") : [];
  const to = path.split("/");
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...Array<string>(from.length - same).fill(".."), ...to.slice(same)].join("/");
}

/**
 * The workspace headers a file at `from` can include with quotes, each with its spelling. The
 * build looks next to the including file, then in the program's root folder (the folder of the
 * file run, which the editor takes to be this file's folder): findQuotedInclude is the build's own
 * rule, and a spelling is kept only when it finds exactly that header.
 */
export function workspaceHeaders(files: readonly WsPath[], from: WsPath): { spelling: string; path: WsPath }[] {
  const dir = parentOf(from);
  const exists = new Set(files.filter((p) => !isConflictCopy(p)));
  const out: { spelling: string; path: WsPath; up: number; depth: number }[] = [];
  for (const path of exists) {
    if (path === from || !isHeader(nameOf(path))) continue;
    const spelling = relativeSpelling(dir, path);
    if (findQuotedInclude(dir, spelling, (p) => exists.has(p), dir) !== path) continue;
    const parts = spelling.split("/");
    out.push({ spelling, path, up: parts.filter((p) => p === "..").length, depth: parts.length });
  }
  // Beside the file first, then in its sub-folders, then further away.
  return out
    .sort((a, b) => a.up - b.up || a.depth - b.depth || (a.spelling < b.spelling ? -1 : 1))
    .map(({ spelling, path }) => ({ spelling, path }));
}

const libCache = new WeakMap<CLibrary, Map<string, readonly Completion[]>>();

function cachedC(lib: CLibrary, key: string, build: () => Completion[]): readonly Completion[] {
  let byKey = libCache.get(lib);
  if (!byKey) libCache.set(lib, (byKey = new Map()));
  let list = byKey.get(key);
  if (!list) byKey.set(key, (list = build()));
  return list;
}

/**
 * The data (c-library.json, scripts/gen-c-completions.mjs) was read from clang 8's headers and names
 * its standards that way. Standards added with clang 22 in 0.17.0 read as the newest the data has.
 */
const DATA_MODE: Record<string, string> = { "c++20": "c++2a", "c++23": "c++2a", c23: "c17", gnu23: "gnu17" };
export const dataMode = (std: string): string => DATA_MODE[std] ?? std;

/** The C++ standard `std` names, as an index into the data's order (an unknown value counts as the default, c++17). */
function cxxLevel(lib: CLibrary, std: string): number {
  const order = lib.header.modes.cpp;
  return order.includes(std) ? order.indexOf(std) : order.indexOf(DEFAULT_BUILD.cxxStd);
}

/**
 * Header names: C's for C; for C++ (and headers) libc++'s first, then C's, in two groups. A libc++
 * header with nothing in it before a later standard (<span>, <optional>) only from that one on.
 */
function headerOptions(lib: CLibrary, lang: CLang, cxxStd: string): readonly Completion[] {
  return cachedC(lib, `headers:${lang}:${lang === "cpp" ? cxxStd : ""}`, () => {
    const c = lib.headers.c.map((label) => boosted(BEGINNER.cHeaders, { label, type: "namespace" }));
    if (lang === "c") return c;
    const cpp = sectionFor("C++ library", 0);
    const cLib = sectionFor("C library", 1);
    const level = cxxLevel(lib, cxxStd);
    const fits = (h: string) => {
      const since = lib.headers.since && own(lib.headers.since, h);
      return !since || lib.header.modes.cpp.indexOf(since) <= level;
    };
    return [
      ...lib.headers.cpp.filter(fits).map((label) => boosted(BEGINNER.cppHeaders, { label, type: "namespace", section: cpp })),
      ...APP_HEADERS.map((o) => ({ ...o, section: cpp })),
      ...c.map((o) => ({ ...o, section: cLib })),
    ];
  });
}

/**
 * C++ headers the app adds to the sysroot: src/workers/clang.worker.ts writes include/bits/stdc++.h
 * (GCC's all-in-one header, which students write a lot) on every boot, so it builds like libc++'s
 * own, and the build precompiles it (cpp-build.ts wantsPch). Not in the generated data, which holds
 * only what the sysroot ships (review finding F4, 2026-10-19).
 */
const APP_HEADERS: readonly Completion[] = [
  { label: "bits/stdc++.h", type: "namespace", info: "The whole C++ standard library at once (GCC's name; ExecFlow provides it)" },
];

/**
 * Macro values the data holds as C has them (gnu11) that C++ defines otherwise: in C++ the
 * sysroot's include/stddef.h defines NULL as 0L and clang's own stddef.h as __null (stdio.h takes
 * it from stddef.h). In C++ they are shown without a value (review finding RB-5, 2026-10-19).
 */
const C_ONLY_VALUES: ReadonlySet<string> = new Set(["NULL"]);

/**
 * Library functions and macros declared under `std` (an -std value; an unknown one keeps only the
 * names every mode has), except `skip`: words the language's keyword list already offers (C's
 * bool and NULL, which say there which header they need).
 */
function libraryOptions(lib: CLibrary, lang: CLang, std: string, skip: ReadonlySet<string>): readonly Completion[] {
  return cachedC(lib, `names:${lang}:${std}`, () => {
    const fits = (entry: { name: string; modes?: readonly string[] }) => !skip.has(entry.name) && (!entry.modes || entry.modes.includes(std));
    const valueOf = (m: { name: string; value?: string }) => (lang === "cpp" && C_ONLY_VALUES.has(m.name) ? undefined : m.value);
    // No section: these share the list with keywords, snippets and your own names, and rank with
    // them by match (see BEGINNER). The info names the header.
    return [
      ...lib.functions.filter(fits).map((f) => boosted(BEGINNER.cNames, {
        label: f.name, type: "function", detail: f.proto, info: `Declared in <${f.header}>`,
      })),
      ...lib.macros.filter(fits).map((m) => {
        const value = valueOf(m);
        return boosted(BEGINNER.cNames, {
          label: m.name, type: m.kind === "type" ? "type" : "constant", ...(value ? { detail: value } : {}), info: `Defined in <${m.header}>`,
        });
      }),
    ];
  });
}

/** std:: names the C++ standard `std` has (an unknown value counts as the default, c++17). */
function stdOptions(lib: CLibrary, std: string): readonly Completion[] {
  return cachedC(lib, `std:${std}`, () => {
    const order = lib.header.modes.cpp;
    const limit = cxxLevel(lib, std);
    return lib.std
      .filter((s) => order.includes(s.since) && order.indexOf(s.since) <= limit)
      .map((s) => {
        const newer = s.since !== order[0] ? `C++${s.since === "c++2a" ? "20" : s.since.slice(3)}` : null;
        return boosted(BEGINNER.stdNames, {
          label: s.name, type: s.kind, ...(newer ? { detail: newer } : {}), section: sectionFor(s.header),
          info: `Declared in <${s.header}>${newer ? `, since ${newer}` : ""}`,
        });
      });
  });
}

/** Not on an unfinished `#include <` or `#include "` line (or in a comment). */
const notAnInclude: Nothing = (state, pos) => {
  const before = lineBefore(state, pos);
  return !(SYSTEM_INCLUDE.test(before) || QUOTED_INCLUDE.test(before)) || inside(state, pos, C_COMMENTS);
};

/** Header names on `#include <` and the workspace's own headers on `#include "`. */
export function includeSource(lang: CLang): CompletionSource {
  return unless(notAnInclude, (context) => {
    const { state, pos } = context;
    const before = lineBefore(state, pos);
    const system = SYSTEM_INCLUDE.exec(before);
    if (system) {
      const lib = loaded("c", context);
      if (!lib) return null;
      const close = state.sliceDoc(pos, pos + 1) === ">" ? "" : ">";
      const options = headerOptions(lib, lang, dataMode(contextOf(state).standards().cpp)).map((o) => ({ ...o, apply: o.label + close }));
      return { from: pos - system[1].length, options, validFor: HEADER_CHARS };
    }
    const quoted = QUOTED_INCLUDE.exec(before);
    const path = state.facet(filePath);
    if (!quoted || !path) return null;
    const close = state.sliceDoc(pos, pos + 1) === '"' ? "" : '"';
    const headers = workspaceHeaders(contextOf(state).files(), path);
    if (!headers.length) return null;
    return {
      from: pos - quoted[1].length,
      // sortText keeps the build's order (beside the file first): the matcher sorts by score, then by it.
      options: headers.map((h, i) => ({ label: h.spelling, type: "namespace", apply: h.spelling + close, sortText: String(i).padStart(5, "0") })),
      validFor: /^[^"]*$/,
    };
  });
}

/**
 * Library functions and macros for a word being typed (or Ctrl-Space), leaving out the words in
 * `keywords`. language-support.ts adds the keyword guard (no names after `.`, `->` or `::`, on
 * preprocessor lines, in strings and comments).
 */
export function cLibrarySource(lang: CLang, keywords: readonly string[] = []): CompletionSource {
  const skip = new Set(keywords);
  return (context) => {
    const word = context.matchBefore(/\w+$/);
    if (!word && !context.explicit) return null;
    const lib = loaded("c", context);
    if (!lib) return null;
    const std = dataMode(contextOf(context.state).standards()[lang]);
    return { from: word ? word.from : context.pos, options: [...libraryOptions(lib, lang, std, skip)], validFor: WORD };
  };
}

const STD_SCOPE = /(?:^|[^\w:])(?:::)?std::(\w*)$/;

/** Not right after `std::` (or in a comment, a string or a character). */
const notAfterStd: Nothing = (state, pos) => !STD_SCOPE.test(lineBefore(state, pos)) || inside(state, pos, C_TEXT);

/** Names after `std::`, as the file's C++ standard (Settings) has them. */
export const stdSource: CompletionSource = unless(notAfterStd, (context) => {
  const { state, pos } = context;
  const m = STD_SCOPE.exec(lineBefore(state, pos))!;
  const lib = loaded("c", context);
  if (!lib) return null;
  return { from: pos - m[1].length, options: [...stdOptions(lib, dataMode(contextOf(state).standards().cpp))], validFor: WORD };
});

// ---------------------------------------------------------------- C++: after `using namespace std;`
// Design decision 17 (review RB-7): std names without the prefix where the file's own
// `using namespace std;` is in scope, by the C++ standard's rule. A using-directive may appear at
// namespace scope or block scope, never class scope, and the namespace's names can be used in the
// scope where it appears, after it ([namespace.udir]/2-3, eel.is/c++draft/namespace.udir). A
// namespace's scope is every body of that namespace ([basic.scope.namespace]/1), the file's is the
// global namespace's, and a block is a compound statement: a function or lambda body, or a block
// inside one ([basic.scope.block]/1). `extern "C++" { }` makes no scope, and a directive in the
// unnamed namespace or an inline one counts in the namespace around it (namespaceName). Not
// followed: a directive in an included header, a member function defined outside its namespace
// (`void app::f() {}` sees app's directives), a directive naming a namespace that itself uses std
// (`using namespace app;`: transitive, so std's names count), an inline namespace opened again
// without `inline` (its directives count only in it), and #if: a directive in a branch that is not
// compiled still counts.

/** `using namespace std;` or `using namespace ::std;`, as its node's text. */
const USING_STD = /^using\s+namespace\s+(?:::\s*)?std\s*;$/;

type CppNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

function isUsingStd(state: EditorState, node: CppNode): boolean {
  return node.name === "UsingDeclaration" && USING_STD.test(state.sliceDoc(node.from, node.to));
}

/**
 * A namespace definition's name, part by part (`a::b` is two parts), as unqualified lookup sees it:
 * without the unnamed namespace and without an inline part (`inline namespace v1` is [],
 * `a::inline b` is [a]). The namespace around either one uses it as if by a using-directive
 * ([namespace.unnamed]/1, eel.is/c++draft/namespace.unnamed; [namespace.def.general]/6,
 * eel.is/c++draft/namespace.def.general), and using-directives are transitive for unqualified
 * lookup ([namespace.udir], Note 4), so a `using namespace std;` in it counts in the namespace
 * around it, and the namespace around it counts in it as for any namespace inside another.
 */
function namespaceName(state: EditorState, ns: CppNode): string[] {
  const parts: string[] = [];
  let inline = false;
  for (let c = ns.firstChild; c; c = c.nextSibling) {
    if (c.name === "inline") inline = true;
    else if (c.name === "Identifier") {
      if (!inline) parts.push(state.sliceDoc(c.from, c.to));
      inline = false;
    }
  }
  return parts;
}

/** Where a namespace-scope directive ends, and the namespace whose scope it is in ([] for the file's). */
interface NamespaceDirective {
  end: number;
  namespace: readonly string[];
}

const namespaceDirectives = new WeakMap<ReturnType<typeof syntaxTree>, readonly NamespaceDirective[]>();

/**
 * The file's directives at namespace scope: its own items, and those of namespace and linkage
 * bodies, never inside a function or a class. Once per syntax tree.
 */
function directivesAtNamespaceScope(state: EditorState): readonly NamespaceDirective[] {
  const tree = syntaxTree(state);
  let found = namespaceDirectives.get(tree);
  if (found) return found;
  const out: NamespaceDirective[] = [];
  const scan = (scope: CppNode, namespace: readonly string[]) => {
    for (let c = scope.firstChild; c; c = c.nextSibling) {
      if (isUsingStd(state, c)) out.push({ end: c.to, namespace });
      else if (c.name === "NamespaceDefinition" || c.name === "LinkageSpecification") {
        const body = c.getChild("CompoundStatement");
        if (body) scan(body, c.name === "NamespaceDefinition" ? [...namespace, ...namespaceName(state, c)] : namespace);
      }
    }
  };
  scan(tree.topNode, []);
  namespaceDirectives.set(tree, (found = out));
  return found;
}

/** Whether `pos` is inside a compound statement's braces (one still open at the end of the file counts). */
function within(node: CppNode, pos: number): boolean {
  return pos > node.from && (pos < node.to || node.lastChild?.name !== "}");
}

/** Whether the file's own `using namespace std;` is in scope at `pos` (see above). */
export function usingStdAt(state: EditorState, pos: number): boolean {
  const namespace: string[] = [];
  for (let n: CppNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== "CompoundStatement" || !within(n, pos)) continue;
    const owner = n.parent?.name;
    if (owner === "NamespaceDefinition") {
      namespace.unshift(...namespaceName(state, n.parent!));
    } else if (owner !== "LinkageSpecification") {
      // A block: a directive among its own statements before the cursor.
      for (let c = n.firstChild; c && c.to <= pos; c = c.nextSibling) if (isUsingStd(state, c)) return true;
    }
  }
  return directivesAtNamespaceScope(state).some(
    (d) => d.end <= pos && d.namespace.length <= namespace.length && d.namespace.every((part, i) => part === namespace[i]),
  );
}

/** <cmath>, <cstdlib>...: a C header's C++ name, whose functions are the C library's own. */
function cWrapper(lib: CLibrary, header: string): boolean {
  return header.startsWith("c") && lib.headers.c.includes(`${header.slice(1)}.h`);
}

/**
 * std names without the prefix, as the C++ standard `std` has them: no section, so they rank with
 * the other names by how well they match (review finding RB-2), each a little below the names that
 * match as well (your own names, keywords and the C library's have boosts of 0 and up), the
 * beginner's first (BEGINNER.stdNames). Left out: keywords, and the C library's functions that a
 * C header's C++ name brings into std (sqrt from <cmath>), which the C list offers already.
 */
function usingStdOptions(lib: CLibrary, std: string): readonly Completion[] {
  return cachedC(lib, `using-std:${std}`, () => {
    const order = lib.header.modes.cpp;
    const limit = cxxLevel(lib, std);
    const cNames = new Set([...lib.functions.map((f) => f.name), ...lib.macros.map((m) => m.name)]);
    const keywords = new Set(CPP_KEYWORDS);
    return lib.std
      .filter((s) => order.includes(s.since) && order.indexOf(s.since) <= limit)
      .filter((s) => !keywords.has(s.name) && !(cNames.has(s.name) && cWrapper(lib, s.header)))
      .map((s) => {
        const newer = s.since !== order[0] ? `C++${s.since === "c++2a" ? "20" : s.since.slice(3)}` : null;
        const rank = BEGINNER.stdNames.indexOf(s.name);
        return {
          label: s.name, type: s.kind, ...(newer ? { detail: newer } : {}), boost: rank >= 0 ? -1 - rank : -20,
          info: `std::${s.name}, declared in <${s.header}>${newer ? `, since ${newer}` : ""}`,
        };
      });
  });
}

/**
 * std names without the prefix, for a word being typed (or Ctrl-Space) where the file's own
 * `using namespace std;` is in scope (usingStdAt). language-support.ts adds the keyword guard (no
 * names after `.`, `->` or `::`, on preprocessor lines, in strings and comments). Without one in
 * scope it answers null (keyword-completion.ts unless says why).
 */
export const usingStdSource: CompletionSource = (context) => {
  const word = context.matchBefore(/\w+$/);
  if (!word && !context.explicit) return null;
  if (!usingStdAt(context.state, context.pos)) return null;
  const lib = loaded("c", context);
  if (!lib) return null;
  return { from: word ? word.from : context.pos, options: [...usingStdOptions(lib, dataMode(contextOf(context.state).standards().cpp))], validFor: WORD };
};
