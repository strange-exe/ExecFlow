// Your own names in suggestions (Tier 1 of the autocomplete research):
// - C and C++: what the open file declares (functions, structs, unions, enums and their constants,
//   typedefs, globals, #define macros: own-names.ts), read from its syntax tree as you type, and what
//   the workspace headers it includes with quotes declare, transitively (the build's own include
//   rule, cpp-build.ts includeClosure), from the workspace index. The word being typed is left out.
// - Python: lang-python's localCompletionSource already offers the open file's names (functions,
//   classes, assignments, parameters, loop variables and imports, with their kinds), so nothing is
//   added for the file itself; a workspace module's members come from library-completion.ts.
// ownNamesLoader asks the index for those files while a file is shown, so they are usually parsed
// before the first suggestion, and marks the editor with data-index (pending or ready) for tests.
// A suggestion asked for before then runs again once they are (late-data.ts).
// This file is in the completion chunk (completion-code.ts).

import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView, PluginValue } from "@codemirror/view";
import { isConflictCopy, parentOf } from "../core/paths";
import type { WorkspaceFile, WsPath } from "../core/types";
import { includeClosure } from "../runner/cpp-build";
import { filePath } from "./completion-context";
import { whenDataArrives } from "./late-data";
import { contextOf, pythonImportedModules, workspaceModuleFile } from "./library-completion";
import { cFileNames, ownOptions, type OwnName } from "./own-names";
import { indexOf, type WorkspaceIndex } from "./workspace-index";

type Tree = ReturnType<typeof syntaxTree>;

const WORD = /^\w*$/;

/** The open file's names and quoted includes, per syntax tree (a new tree comes with each edit). */
const openFiles = new WeakMap<Tree, { names: readonly OwnName[]; includes: readonly string[] }>();

/** What the open C or C++ file declares, and its quoted include spellings. */
export function openFileNames(state: EditorState): { names: readonly OwnName[]; includes: readonly string[] } {
  const tree = syntaxTree(state);
  let found = openFiles.get(tree);
  if (!found) {
    const includes: string[] = [];
    const names: OwnName[] = [];
    for (const name of cFileNames(tree.topNode, (from, to) => state.sliceDoc(from, to), includes)) if (name) names.push(name);
    openFiles.set(tree, (found = { names, includes }));
  }
  return found;
}

/** The workspace files includeClosure may find (conflict copies never reach a build), per file list. */
const buildFiles = new WeakMap<readonly WsPath[], ReadonlyMap<WsPath, WorkspaceFile>>();

function filesForBuild(files: readonly WsPath[], open: WsPath): ReadonlyMap<WsPath, WorkspaceFile> {
  let map = buildFiles.get(files);
  if (!map) {
    // No text: includeClosure gets each file's includes from includesOf below, not from its text.
    map = new Map(files.filter((p) => !isConflictCopy(p)).map((path) => [path, { path, text: "" }]));
    buildFiles.set(files, map);
  }
  return map.has(open) ? map : new Map([...map, [open, { path: open, text: "" }]]);
}

/**
 * The workspace headers the open file at `path` includes with quotes, transitively, in the order
 * the build finds them (next to the including file first, then in the program's root folder, which
 * the editor takes to be the open file's folder). The open file's includes come from its syntax
 * tree, the others' from the index; `complete` is false while one of them isn't known yet (it has
 * been asked for).
 */
export function headerClosure(state: EditorState, path: WsPath, index: WorkspaceIndex): { paths: WsPath[]; complete: boolean } {
  let complete = true;
  const includesOf = (file: WorkspaceFile): readonly string[] => {
    if (file.path === path) return openFileNames(state).includes;
    const known = index.get(file.path);
    if (!known) complete = false;
    return known?.includes ?? [];
  };
  const paths = includeClosure(path, filesForBuild(contextOf(state).files(), path), parentOf(path), includesOf);
  return { paths, complete };
}

/**
 * Your own C and C++ names for the word being typed (or Ctrl-Space): the open file's first, then
 * each included header's, one option per name, leaving out the word at the cursor and any word in
 * `keywords` (the keyword list offers those). language-support.ts adds the keyword guard: nothing
 * after `.`, `->` or `::`, on preprocessor lines, in strings and comments.
 */
export function cOwnSource(keywords: readonly string[] = []): CompletionSource {
  const skip = new Set(keywords);
  return (context) => {
    const word = context.matchBefore(/\w+$/);
    if (!word && !context.explicit) return null;
    const { state, pos } = context;
    const path = state.facet(filePath);
    const seen = new Set<string>(skip);
    const options: Completion[] = [];
    const add = (names: readonly OwnName[], where: string, typed: boolean) => {
      const list = ownOptions(names, where);
      names.forEach((n, i) => {
        // The word being typed parses as a name too (`int coun` at the end of a file): not offered.
        if (seen.has(n.label) || (typed && n.from < pos && pos <= n.to)) return;
        seen.add(n.label);
        options.push(list[i]);
      });
    };
    add(openFileNames(state).names, path ?? "this file", true);
    const index = indexOf(state);
    let complete = true;
    if (index && path) {
      const closure = headerClosure(state, path, index);
      complete = closure.complete;
      for (const header of closure.paths) {
        const known = index.get(header);
        if (known) add(known.names, header, false);
        else complete = false;
      }
      // A header the index hasn't read yet: no validFor (the next key asks again), and the query
      // runs again once the index has read it (late-data.ts).
      if (!complete) whenDataArrives(context, index.nextUpdate());
    }
    if (!options.length) return null;
    return { from: word ? word.from : pos, options, ...(complete ? { validFor: WORD } : {}) };
  };
}

/**
 * Whether everything the open file's suggestions need from other files is known: a C or C++ file's
 * included headers, or the workspace modules a Python file imports. Asks the index for what isn't.
 */
export function namesReady(state: EditorState, lang: "c" | "python"): boolean {
  const index = indexOf(state);
  const path = state.facet(filePath);
  if (!index || !path) return true;
  if (lang === "c") return headerClosure(state, path, index).complete;
  const files = contextOf(state).files();
  let ready = true;
  for (const module of pythonImportedModules(state)) {
    const file = workspaceModuleFile(files, path, module.split("."));
    if (file && !index.get(file)) ready = false;
  }
  return ready;
}

/** How long typing must pause before the open file's needs are looked at again (ms). */
const RECHECK_MS = 250;

/**
 * While a file is shown (completion-loader.ts suggestionLoaders): asks the index for the files its
 * suggestions need (again once typing pauses after edits, and whenever the index learns something),
 * and says on the editor element whether they are all known: data-index="pending" (from the edit
 * on) or "ready".
 */
export function ownNamesLoader(view: EditorView, lang: "c" | "python"): PluginValue {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const mark = (state: "pending" | "ready") => {
    if (live && view.dom.getAttribute("data-index") !== state) view.dom.setAttribute("data-index", state);
  };
  const check = () => {
    timer = null;
    if (live) mark(namesReady(view.state, lang) ? "ready" : "pending");
  };
  const recheck = () => {
    mark("pending");
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(check, RECHECK_MS);
  };
  const stop = indexOf(view.state)?.onUpdate(recheck);
  recheck();
  return {
    update(update) {
      if (update.docChanged) recheck();
    },
    destroy() {
      live = false;
      stop?.();
      if (timer !== null) clearTimeout(timer);
      view.dom.removeAttribute("data-index");
    },
  };
}
