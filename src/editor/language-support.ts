// Grammar and completion per file. Python gets lang-python's grammar (python-support.ts); C, C++
// and headers share the C++ grammar (c-support.ts; core/languages.ts editorLanguage). Each is a
// chunk of its own, loaded with import() the first time a file of its language opens: the grammars
// were a third of the editor chunk, which had reached about 195 of its 200 kB gzip budget (0.18.1).
// This module imports no CodeMirror code, so the shell can start a language's load together with
// the editor chunk's (workbench.ts activate) instead of after it. Until a language is there its
// files are plain text; EditorManager gives them the grammar when it arrives (needLanguage).

import type { Extension } from "@codemirror/state";
import { editorLanguage, type LanguageId } from "../core/languages";
import { nameOf } from "../core/paths";

const CHUNKS: Readonly<Record<LanguageId, () => Promise<Extension>>> = {
  python: () => import("./python-support").then((m) => m.PYTHON_SUPPORT),
  c: () => import("./c-support").then((m) => m.C_SUPPORT),
  cpp: () => import("./c-support").then((m) => m.CPP_SUPPORT),
};

const loaded = new Map<LanguageId, Extension>();
const loading = new Map<LanguageId, Promise<void>>();

/** The grammar a workspace path is edited with (headers use C++), or null for plain text. */
export function languageForPath(path: string): LanguageId | null {
  return editorLanguage(nameOf(path));
}

/** Grammar, indentation, folding and completion for `id`; nothing for plain text or before it loads. Shared instances. */
export function languageSupport(id: LanguageId | null): Extension {
  return (id && loaded.get(id)) || [];
}

/** Plain text, or a language whose chunk is here. */
export function languageLoaded(id: LanguageId | null): boolean {
  return id === null || loaded.has(id);
}

/** Loads `id`'s chunk once; a failed load is tried again on the next call. */
export function loadLanguage(id: LanguageId | null): Promise<void> {
  if (id === null || loaded.has(id)) return Promise.resolve();
  let pending = loading.get(id);
  if (!pending) {
    pending = CHUNKS[id]().then(
      (support) => void loaded.set(id, support),
      (e: unknown) => {
        loading.delete(id);
        throw e;
      },
    );
    loading.set(id, pending);
  }
  return pending;
}
