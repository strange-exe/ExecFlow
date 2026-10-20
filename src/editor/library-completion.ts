// Suggestions from the library data (library-data.ts) and from the workspace's own files:
// - Python: module names after `import` and `from` (the standard library and the workspace's own
//   importable modules), a module's members after `from X import` and after `mod.` for a module this
//   file imported (`import math`, `import math as m`, `from os import path`), with the signature as
//   the detail. For your own module (`import helpers`) the members are its top-level defs, classes
//   and assignments, read from its syntax tree by the workspace index (workspace-index.ts).
// - C and C++: header names on `#include <` and `#include "` lines, library functions and macros
//   (detail: the prototype or value; info: our own one line naming the header), std:: names in
//   C++ (grouped by header), and snippets. Common names rank first among equal matches (BEGINNER).
// This file is in the completion chunk (completion-code.ts), which the editor chunk loads with
// import() (completion-loader.ts). language-support.ts puts each source in a file's own language
// data, inside writable(), so a read-only file has none. Nothing here offers a word inside a string
// or a comment. Every list is filtered by CodeMirror's matcher; sources return validFor, so typing
// inside a word refilters without a new query, except for a list built while data it needs was
// missing (late-data.ts: the next key asks again, and the query runs again once the data is there).

import {
  snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSection, type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView, PluginValue } from "@codemirror/view";
import { isHeader } from "../core/languages";
import { isConflictCopy, nameOf, parentOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { DEFAULT_BUILD, findQuotedInclude } from "../runner/cpp-build";
import { filePath, libraryContext, type LibraryContext } from "./completion-context";
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

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** Whether `pos` is inside (or at the end of) a node named in `names`. */
function inside(state: EditorState, pos: number, names: readonly string[]): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.includes(node.name)) return true;
  }
  return false;
}

/** The current line up to `pos`. */
function lineBefore(state: EditorState, pos: number): string {
  return state.sliceDoc(state.doc.lineAt(pos).from, pos);
}

/**
 * The library's data, or null: then the load starts, the source offers nothing from it (and no
 * validFor), and the query runs again once the data is there (late-data.ts).
 */
function loaded<K extends LibraryId>(id: K, context: CompletionContext) {
  const data = library(id);
  if (!data) whenDataArrives(context, loadLibrary(id));
  return data;
}

/** A result for `options` from `from`, refiltered as typed (validFor) only when nothing was missing. */
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

const WORD = /^\w*$/;

// ---------------------------------------------------------------- ranking

/**
 * The names a beginner reaches for most, most common first: our own short lists, from what
 * introductory courses use first. CodeMirror ranks options by how well they match what was typed
 * (a whole name, then a prefix, then letters in order with gaps: steps of 100 and more), then by
 * label. A boost is added to that score (-99 to 99), so these lead the options that match equally
 * well (`str`: strlen before strcat and struct; `import ma`: math before mailbox and marshal) and
 * never pass a better match. Library names carry no section in mixed lists (only the C++ header
 * groups and std:: names have one), because CodeMirror puts every option without a section above
 * every option with one, however well it matches (review finding RB-2, 2026-10-19).
 */
export const BEGINNER: Readonly<Record<"pyModules" | "cHeaders" | "cNames" | "cppHeaders" | "stdNames", readonly string[]>> = {
  pyModules: ["math", "random", "string", "time", "datetime", "collections", "sys", "os"],
  cHeaders: ["stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "stdbool.h", "time.h"],
  cNames: [
    "main", "printf", "scanf", "puts", "strlen", "strcpy", "strcmp", "strcat", "getchar", "putchar", "fgets", "malloc", "free",
    "rand", "srand", "sqrt", "pow", "abs", "exit",
  ],
  cppHeaders: ["iostream", "string", "vector", "algorithm", "cmath"],
  stdNames: ["cout", "cin", "endl", "string", "vector", "getline", "sort", "max", "min", "swap", "to_string"],
};

/** The first name's boost; each later one gets one less. Below 100: a better match still wins. */
const BOOST_TOP = 90;

const BOOSTS = new Map<readonly string[], ReadonlyMap<string, number>>(
  Object.values(BEGINNER).map((names) => [names, new Map(names.map((name, i) => [name, BOOST_TOP - i]))]),
);

/** `option` with its boost when its label is in the beginner list `names`. */
function boosted<T extends Completion>(names: readonly string[], option: T): T {
  const boost = BOOSTS.get(names)?.get(option.label);
  return boost === undefined ? option : { ...option, boost };
}

// ---------------------------------------------------------------- Python

/** Nodes where no Python name fits (lang-python 6.2.1 names). */
const PY_TEXT: readonly string[] = ["String", "FormatString", "Comment"];
/** A module name Python can import (ASCII names; that is every standard one). */
const PY_IDENT = /^[A-Za-z_]\w*$/;

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

/** Module names after `import` and `from`; names after `from X import`. */
export const pythonModuleSource: CompletionSource = (context: CompletionContext) => {
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
};

const MEMBER = /(?:^|[^\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(\w*)$/;

/**
 * Members after `mod.` (or `mod.sub.`) where this file imported `mod`: a standard module's from
 * the library data, your own module's (`import helpers`, then `helpers.`) from its syntax tree.
 */
export const pythonMemberSource: CompletionSource = (context: CompletionContext) => {
  const { state, pos } = context;
  if (inside(state, pos, PY_TEXT) || pythonImportContext(state, pos)) return null;
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
};

// ---------------------------------------------------------------- C and C++

export type CLang = "c" | "cpp";

/** @lezer/cpp 1.1.6 comment nodes, and the text nodes no name goes in. */
const C_COMMENTS: readonly string[] = ["LineComment", "BlockComment"];
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
  { label: "bits/stdc++.h", type: "namespace", info: "The whole C++ standard library at once (GCC's name; CodeEditor provides it)" },
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
        const newer = s.since !== order[0] ? `C++${s.since.slice(3)}` : null;
        return boosted(BEGINNER.stdNames, {
          label: s.name, type: s.kind, ...(newer ? { detail: newer } : {}), section: sectionFor(s.header),
          info: `Declared in <${s.header}>${newer ? `, since ${newer}` : ""}`,
        });
      });
  });
}

/** Header names on `#include <` and the workspace's own headers on `#include "`. */
export function includeSource(lang: CLang): CompletionSource {
  return (context) => {
    const { state, pos } = context;
    if (inside(state, pos, C_COMMENTS)) return null;
    const before = lineBefore(state, pos);
    const system = SYSTEM_INCLUDE.exec(before);
    if (system) {
      const lib = loaded("c", context);
      if (!lib) return null;
      const close = state.sliceDoc(pos, pos + 1) === ">" ? "" : ">";
      const options = headerOptions(lib, lang, contextOf(state).standards().cpp).map((o) => ({ ...o, apply: o.label + close }));
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
  };
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
    const std = contextOf(context.state).standards()[lang];
    return { from: word ? word.from : context.pos, options: [...libraryOptions(lib, lang, std, skip)], validFor: WORD };
  };
}

const STD_SCOPE = /(?:^|[^\w:])(?:::)?std::(\w*)$/;

/** Names after `std::`, as the file's C++ standard (Settings) has them. */
export const stdSource: CompletionSource = (context) => {
  const { state, pos } = context;
  if (inside(state, pos, C_TEXT)) return null;
  const m = STD_SCOPE.exec(lineBefore(state, pos));
  if (!m) return null;
  const lib = loaded("c", context);
  if (!lib) return null;
  return { from: pos - m[1].length, options: [...stdOptions(lib, contextOf(state).standards().cpp)], validFor: WORD };
};

// A tab after a newline is one indent unit past the first line's; ${name} fields with the same
// name are edited together (the loop variable). "\\n" is a backslash and n in the inserted code.
const LOOPS_AND_BLOCKS: readonly Completion[] = [
  snippetCompletion("for (int ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}", { label: "for", detail: "loop", type: "keyword" }),
  snippetCompletion("while (${condition}) {\n\t${}\n}", { label: "while", detail: "loop", type: "keyword" }),
  snippetCompletion("if (${condition}) {\n\t${}\n}", { label: "if", detail: "block", type: "keyword" }),
  snippetCompletion("if (${condition}) {\n\t${}\n} else {\n\t${}\n}", { label: "if", detail: "/ else block", type: "keyword" }),
  snippetCompletion("switch (${expression}) {\ncase ${constant}:\n\t${}\n\tbreak;\ndefault:\n\tbreak;\n}", { label: "switch", detail: "block", type: "keyword" }),
  snippetCompletion("struct ${Name} {\n\t${}\n};", { label: "struct", detail: "definition", type: "keyword" }),
  // With the library's printf and scanf boost (BEGINNER): the statement keeps its place just above the function.
  snippetCompletion('printf("${}\\n");', boosted(BEGINNER.cNames, { label: "printf", detail: "statement", type: "keyword" })),
  snippetCompletion('scanf("${%d}", &${variable});', boosted(BEGINNER.cNames, { label: "scanf", detail: "statement", type: "keyword" })),
];

/** Snippets for C files, offered with the keywords (and under the same guard). */
export const C_SNIPPETS: readonly Completion[] = [
  snippetCompletion("int main(void) {\n\t${}\n\treturn 0;\n}", boosted(BEGINNER.cNames, { label: "main", detail: "function", type: "keyword" })),
  ...LOOPS_AND_BLOCKS,
];

/** Snippets for C++ files and headers. */
export const CPP_SNIPPETS: readonly Completion[] = [
  snippetCompletion("int main() {\n\t${}\n}", boosted(BEGINNER.cNames, { label: "main", detail: "function", type: "keyword" })),
  ...LOOPS_AND_BLOCKS,
  snippetCompletion("class ${Name} {\npublic:\n\t${}\n};", { label: "class", detail: "definition", type: "keyword" }),
];

const INCLUDE_LINES: Readonly<Record<CLang, readonly Completion[]>> = {
  c: [snippetCompletion("#include <stdio.h>", { label: "#include <stdio.h>", type: "keyword" })],
  cpp: [snippetCompletion("#include <iostream>", { label: "#include <iostream>", type: "keyword" })],
};

const DIRECTIVE_START = /^\s*(#\s*(\w*))$/;

/** The common #include line, while `#include` is being typed at the start of a line ("#", "#in"). */
export function includeLineSource(lang: CLang): CompletionSource {
  return (context) => {
    const { state, pos } = context;
    if (inside(state, pos, C_COMMENTS)) return null;
    const m = DIRECTIVE_START.exec(lineBefore(state, pos));
    if (!m || !"include".startsWith(m[2])) return null;
    return { from: pos - m[1].length, options: [...INCLUDE_LINES[lang]], validFor: (text) => /^#\s*(\w*)$/.test(text) && "include".startsWith(text.replace(/^#\s*/, "")) };
  };
}
