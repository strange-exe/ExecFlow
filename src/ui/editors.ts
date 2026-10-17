// CodeMirror and its grammars are most of the app's JavaScript (about 196 KB gzip), so the shell
// doesn't wait for them: the editor chunk loads the first time a file is opened (or the pointer or
// focus heads for the files). Until then the workbench talks to NO_EDITOR, which has no files open.
import type { EditorManager } from "../editor/editor-manager";

/** The part of EditorManager the workbench (and the sync screens) use while a file may be open. */
export type Editors = Pick<
  EditorManager,
  | "activeId"
  | "has"
  | "isDirty"
  | "isReadOnly"
  | "path"
  | "state"
  | "text"
  | "idForPath"
  | "markSaved"
  | "close"
  | "rename"
  | "replaceContent"
  | "reveal"
  | "setReadOnly"
  | "setPrefs"
  | "problems"
  | "movePending"
>;

/** Stands in for the editor before it has loaded: nothing is open, so every question has a plain answer. */
export function noEditor(): Editors & { readonly readOnly: boolean } {
  let readOnly = true;
  return {
    get readOnly() {
      return readOnly;
    },
    activeId: null,
    has: () => false,
    isDirty: () => false,
    isReadOnly: () => readOnly,
    path: () => null,
    state: () => null,
    text: () => null,
    idForPath: () => null,
    markSaved: () => false,
    close: () => ({ closed: true, dirty: false }),
    rename: () => false,
    replaceContent: () => false,
    reveal: () => false,
    setReadOnly(on: boolean, id?: string) {
      if (id === undefined) readOnly = on;
    },
    setPrefs() {},
    problems: () => [],
    movePending() {},
  };
}
