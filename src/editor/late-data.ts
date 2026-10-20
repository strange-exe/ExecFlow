// Suggestions asked for before the data they need has arrived: the library data still loading
// (library-data.ts), or a header or module the workspace index hasn't read yet (workspace-index.ts).
// The source offers what there is, without validFor, so the next key asks again instead of
// refiltering an incomplete list. And once the data arrives the query runs again, but only if
// nothing has happened since: the same text, the same cursor, the editor still focused, and the
// list not closed with Escape. Without this the list kept its incomplete result (validFor), or
// stayed closed, until another key or Ctrl-Space (review finding RB-1, 2026-10-19).
//
// The query runs again through startCompletion, which marks it explicit. Sources only wait for data
// where they would offer names anyway (a word typed, or a place like `helpers.` or `#include <` that
// always has a list), so the explicit query offers what the typed one would have.

import { startCompletion, type CompletionContext } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

interface Waiting {
  doc: Text;
  head: number;
  /** The arrivals already listened to, so many queries before one arrival add one listener. */
  arrivals: Set<Promise<boolean | void>>;
}

const waiting = new WeakMap<EditorView, Waiting>();

/**
 * A source answered `context` without data that `arrival` brings: when it resolves (to anything but
 * false: a library that failed to load brings nothing, and asking again would only fail again), the
 * query runs again where it was asked (see above). Without a view (CompletionResult.update) it does nothing.
 */
export function whenDataArrives(context: CompletionContext, arrival: Promise<boolean | void>): void {
  const { view } = context;
  if (!view) return;
  let entry = waiting.get(view);
  if (!entry || entry.doc !== context.state.doc || entry.head !== context.pos) {
    entry = { doc: context.state.doc, head: context.pos, arrivals: new Set() };
    waiting.set(view, entry);
  }
  if (entry.arrivals.has(arrival)) return;
  entry.arrivals.add(arrival);
  const mine = entry;
  void arrival.then(
    (brought) => {
      if (brought !== false) runAgain(view, mine);
    },
    () => undefined,
  );
}

/** The user closed the list (Escape): data that arrives later doesn't open it again. */
export function forgetWaiting(view: EditorView): void {
  waiting.delete(view);
}

function runAgain(view: EditorView, entry: Waiting): void {
  if (waiting.get(view) !== entry) return;
  waiting.delete(view);
  const { state } = view;
  // (A file that turned read-only meanwhile has no sources left: language-support.ts writable().)
  if (state.doc !== entry.doc || state.selection.main.head !== entry.head || !view.hasFocus) return;
  startCompletion(view);
}
