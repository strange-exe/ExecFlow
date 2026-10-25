// The one place EditorManager touches a view. In the browser the host is a real EditorView; in
// unit tests (and anywhere without a DOM) it is a headless stand-in that holds one EditorState and
// applies transactions the same way, so the manager's state logic runs under Node unchanged.

import type { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { atIdle, loadCodeItalic } from "../theme/fonts";
import { notifyDocChanged } from "./extensions";
import { warmListIcons } from "./highlight";

/**
 * Called with the transactions the host is about to apply. `commit()` applies them (for a view,
 * `view.update(trs)`, which also runs update listeners); the handler must call it exactly once.
 */
export type TransactionsHandler = (trs: readonly Transaction[], commit: () => void) => void;

export interface EditorHost {
  /** The state on screen (the active file's live state). */
  readonly state: EditorState;
  setState(state: EditorState): void;
  dispatch(tr: Transaction): void;
  /** Scroll position to restore when the same document is shown again (null without a view). */
  scrollSnapshot(): StateEffect<unknown> | null;
  focus(): void;
  destroy(): void;
  /** The real view, or null when headless. */
  readonly view: EditorView | null;
}

export type HostFactory = (initial: EditorState, onTransactions: TransactionsHandler) => EditorHost;

/** A real EditorView mounted in `parent`. */
export function viewHost(parent: HTMLElement): HostFactory {
  return (initial, onTransactions) => {
    const view = new EditorView({
      parent,
      state: initial,
      dispatchTransactions: (trs, v) => onTransactions(trs, () => v.update(trs)),
    });
    // First uses that cost a long task when they come with a key: the code font's italic (the
    // first edit's unsaved tab name) and the suggestion list's kind icons. Done once the page is
    // idle after the view exists.
    atIdle(() => {
      loadCodeItalic();
      if (view.dom.isConnected) warmListIcons(view);
    });
    return {
      view,
      get state() {
        return view.state;
      },
      setState: (state) => view.setState(state),
      dispatch: (tr) => view.dispatch(tr),
      scrollSnapshot: () => view.scrollSnapshot(),
      focus: () => view.focus(),
      destroy: () => view.destroy(),
    };
  };
}

/**
 * A view without a DOM. It behaves like EditorView where the manager can tell the difference:
 * a transaction must start from the current state; setState and dispatch throw while an update
 * is in progress; and the doc-change handler runs inside the update, as BASE's update listener
 * does in a view. (View plugins, scrolling and focus don't exist here.)
 */
export function headlessHost(): HostFactory {
  return (initial, onTransactions) => {
    let state = initial;
    let updating = false;
    const idle = (what: string) => {
      if (updating) throw new Error(`Calls to EditorView.${what} are not allowed while an update is in progress`);
    };
    return {
      view: null,
      get state() {
        return state;
      },
      setState(next) {
        idle("setState");
        state = next;
      },
      dispatch(tr) {
        idle("update");
        onTransactions([tr], () => {
          idle("update");
          if (tr.startState !== state) throw new RangeError("Trying to update state with a transaction that doesn't start from the previous state.");
          updating = true;
          try {
            state = tr.state;
            if (tr.docChanged) notifyDocChanged(state);
          } finally {
            updating = false;
          }
        });
      },
      scrollSnapshot: () => null,
      focus() {},
      destroy() {},
    };
  };
}
