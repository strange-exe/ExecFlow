// Loads the completion chunk (completion-code.ts: the library and own-name sources, the workspace
// index) with import() the first time a shown file or a suggestion source needs it, so it is not
// part of the editor chunk (research doc section 3, "Bundle size"). Showing a file starts the load,
// so the code is normally there before the first key. A query that comes before it offers nothing
// from those sources, without validFor, and runs again once the code arrives (late-data.ts), if
// nothing has happened since: the same text, cursor and focus, and no Escape. The service worker
// precaches the chunk with every other one, so this works offline after the first visit. If the
// code can't load (the network goes between the editor chunk and this one on a first visit, say),
// those sources offer nothing, the keywords and snippets (keyword-completion.ts, the language chunks')
// still do, and this code throws and logs nothing; the browser still
// reports its own failed request (Chromium in the console). A query after CODE_RETRY_MS tries
// again, and when that load works the shown files' loaders start (Loaders). Chromium and Firefox
// then fetch the chunk again, as the HTML Standard says (a failed fetch leaves the module map,
// html.spec.whatwg.org "fetch a single module script"). Playwright 1.64's WebKit answered from its
// failed first try instead, in the page and after reloads in the same browser context (measured
// 2026-10-21; whether Safari does the same is not verified).

import type { CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { whenDataArrives } from "./late-data";
import type { LibraryId } from "./library-data";

export type CompletionCode = typeof import("./completion-code");

/** A failed load is tried again at most this often (as library-data.ts RETRY_MS). */
export const CODE_RETRY_MS = 30_000;

let code: CompletionCode | null = null;
let pending: Promise<boolean> | null = null;
let failedAt = Number.NEGATIVE_INFINITY;
/** Called once when the code arrives after a failed load (Loaders that couldn't start). */
const waiting = new Set<(code: CompletionCode) => void>();

/** The completion code once it has loaded, else null. */
export function completionCode(): CompletionCode | null {
  return code;
}

/**
 * Starts loading the completion code (once; a failure is retried after CODE_RETRY_MS) and
 * resolves true when it is there. Never rejects and never logs.
 */
export function loadCompletionCode(now: () => number = Date.now): Promise<boolean> {
  if (code) return Promise.resolve(true);
  if (pending) return pending;
  if (now() - failedAt < CODE_RETRY_MS) return Promise.resolve(false);
  pending = import("./completion-code").then(
    (module) => {
      code = module;
      pending = null;
      const run = [...waiting];
      waiting.clear();
      for (const start of run) start(module);
      return true;
    },
    () => {
      pending = null;
      failedAt = now();
      return false;
    },
  );
  return pending;
}

/**
 * A source from the completion code (`pick` builds it once, when the code is there). Until then it
 * offers nothing and starts the load; where the source would offer names (`wants`: a word typed,
 * Ctrl-Space, `#include <`...), the query runs again once the code arrives. That run is explicit
 * (late-data.ts), so `wants` must hold only where the typed query would offer the same.
 */
export function lazySource(pick: (code: CompletionCode) => CompletionSource, wants: (context: CompletionContext) => boolean): CompletionSource {
  let source: CompletionSource | null = null;
  return (context) => {
    if (!source && code) source = pick(code);
    if (source) return source(context);
    const arrival = loadCompletionCode();
    if (wants(context)) whenDataArrives(context, arrival);
    return null;
  };
}

/**
 * While a file is shown: loads the completion code, then runs its loaders for the file's language
 * (library-completion.ts libraryLoader starts loading the library data and marks data-library on
 * the editor element; own-completion.ts ownNamesLoader asks the index for the files the open
 * file's suggestions need and marks data-index). Until the code is there the element says what
 * those loaders say from their start, "loading" and "pending"; if it can't load, data-library is
 * "failed", and the loaders start when a later load works (a query after CODE_RETRY_MS tries).
 */
export function suggestionLoaders(library: LibraryId, names: "c" | "python"): Extension {
  return ViewPlugin.define((view) => new Loaders(view, library, names));
}

class Loaders implements PluginValue {
  private inner: PluginValue[] = [];
  private live = true;
  private readonly startLater = (c: CompletionCode) => {
    if (this.live) this.start(c);
  };

  constructor(
    private readonly view: EditorView,
    private readonly library: LibraryId,
    private readonly names: "c" | "python",
  ) {
    if (code) {
      this.start(code);
      return;
    }
    view.dom.setAttribute("data-library", "loading");
    view.dom.setAttribute("data-index", "pending");
    void loadCompletionCode().then(() => {
      if (!this.live) return;
      if (code) {
        this.start(code);
      } else {
        view.dom.setAttribute("data-library", "failed");
        view.dom.removeAttribute("data-index");
        waiting.add(this.startLater);
      }
    });
  }

  private start(c: CompletionCode): void {
    this.inner = [c.libraryLoader(this.view, this.library), c.ownNamesLoader(this.view, this.names)];
  }

  update(update: ViewUpdate): void {
    for (const plugin of this.inner) plugin.update?.(update);
  }

  destroy(): void {
    this.live = false;
    waiting.delete(this.startLater);
    for (const plugin of this.inner) plugin.destroy?.();
    if (!this.inner.length) {
      this.view.dom.removeAttribute("data-library");
      this.view.dom.removeAttribute("data-index");
    }
  }
}
