// What the app tells the suggestion sources: the workspace's files and build standards, the
// file's path, and the workspace index. The sources are a chunk of their own (completion-code.ts),
// loaded the first time they are needed (completion-loader.ts), so the editor chunk stays its
// pre-Tier 1 size (research doc section 3, "Bundle size"); the editor chunk still builds every
// state with these facets, so they live here. Types from the completion chunk are imported as
// types only, which the build erases.

import { Facet } from "@codemirror/state";
import type { WsPath } from "../core/types";
import type { IndexHost, Scheduler, WorkspaceIndex } from "./workspace-index";

/** What the library sources need from the app. Read at each request, so changes apply at once. */
export interface LibraryContext {
  /** Every file in the workspace, for import and `#include "` suggestions. */
  files(): readonly WsPath[];
  /** The -std settings C and C++ files build with (Settings): they decide which library names fit. */
  standards(): { c: string; cpp: string };
}

/**
 * Given once per manager (editor-manager.ts), the same way as extensions.ts appHandlers. Null
 * without one: library-completion.ts contextOf then uses no files and the default standards.
 */
export const libraryContext = Facet.define<LibraryContext, LibraryContext | null>({ combine: (values) => values[0] ?? null });

/** The workspace path of the file a state belongs to (extensions.ts fileExtensions sets it). */
export const filePath = Facet.define<WsPath, WsPath | null>({ combine: (values) => values[0] ?? null });

/**
 * The app's workspace index (the names other files declare), made the first time a suggestion
 * needs it: the class is in the completion chunk (workspace-index.ts indexIn). Before that nothing
 * has been read, so a change to stored files has nothing to forget.
 */
export class IndexSlot {
  /** Set by workspace-index.ts indexIn. */
  index: WorkspaceIndex | null = null;

  constructor(
    readonly host: IndexHost,
    readonly scheduler?: Scheduler,
  ) {}

  /** Stored files changed (WorkspaceIndex.changed). */
  changed(paths?: readonly WsPath[]): void {
    this.index?.changed(paths);
  }

  /** Reading or parsing is under way. */
  get busy(): boolean {
    return this.index?.busy ?? false;
  }
}

/** The app's index slot (editor-manager.ts gives it), or null: then only the open file's own names. */
export const workspaceIndex = Facet.define<IndexSlot, IndexSlot | null>({ combine: (values) => values[0] ?? null });
