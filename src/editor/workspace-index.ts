// The names other workspace files declare, for suggestions in the open file: the C/C++ headers it
// includes with quotes (own-completion.ts) and the Python modules it imports (library-completion.ts).
// The app gives the editor an IndexSlot through the workspaceIndex facet (completion-context.ts;
// editor-manager.ts makes it, the workbench says when stored files change), and indexIn() makes
// the index in it the first time a suggestion needs it: this file is in the completion chunk.
//
// Each file is read and parsed once per version, and only when a suggestion or the open file asks
// for it (never the whole workspace). A parse runs in idle slices of about SLICE_MS, so typing never
// waits on it (the research doc's rule: no task over 50 ms). A version is the open file's doc while
// it is open in a tab (newer than storage while it is typed in), else a counter that changed() moves.
// Until a file is done, get() answers null and the sources offer what they have; nextUpdate() lets
// them run again once it is (late-data.ts).

import { pythonLanguage } from "@codemirror/lang-python";
import type { EditorState, Text } from "@codemirror/state";
import { parser as cppParser } from "@lezer/cpp";
import { editorLanguage } from "../core/languages";
import { nameOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { workspaceIndex, type IndexSlot } from "./completion-context";
import { cFileNames, pyModuleNames, type OwnName } from "./own-names";

/** What the app gives the index. */
export interface IndexHost {
  /** A stored file's text (LF), as the editor would open it. */
  read(path: WsPath): Promise<string>;
  /** An open file's current text: newer than storage while it is typed in. Compared by identity. */
  live?(path: WsPath): Text | null;
}

/** What a file declares, and (C/C++) the spellings of its quoted includes, in order. */
export interface FileNames {
  readonly names: readonly OwnName[];
  readonly includes: readonly string[];
}

const NOTHING: FileNames = { names: [], includes: [] };

/** One slice's work: call `more()` now and then and stop when it says false. */
export type Slice = (more: () => boolean) => void;
export type Scheduler = (slice: Slice) => void;

/** About how long one idle slice works. */
export const SLICE_MS = 10;
/** An idle callback runs within this long even when the page never goes idle (ms). */
const IDLE_TIMEOUT = 200;

/**
 * Runs each slice when the page is idle (requestIdleCallback, for at most `sliceMs` or the time the
 * browser offers), or in a timer task of `sliceMs` where there is no requestIdleCallback (WebKit).
 */
export function idleScheduler(sliceMs = SLICE_MS, now: () => number = () => performance.now()): Scheduler {
  return (slice) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(
        (deadline) => {
          const budget = deadline.didTimeout ? sliceMs : Math.min(sliceMs, deadline.timeRemaining());
          const end = now() + Math.max(1, budget);
          slice(() => now() < end);
        },
        { timeout: IDLE_TIMEOUT },
      );
    } else {
      setTimeout(() => {
        const end = now() + sliceMs;
        slice(() => now() < end);
      }, 0);
    }
  };
}

/** The grammar a file is indexed with: Python, or the C++ one (C, C++ and headers), or none. */
function indexLanguage(path: WsPath): "python" | "c" | null {
  const id = editorLanguage(nameOf(path));
  return id === "python" ? "python" : id ? "c" : null;
}

/** Parses `text`, yielding after each parser step and each top-level item, and returns what it declares. */
function* scan(lang: "python" | "c", text: string): Generator<void, FileNames> {
  const parse = (lang === "python" ? pythonLanguage.parser : cppParser).startParse(text);
  let tree = parse.advance();
  while (!tree) {
    yield;
    tree = parse.advance();
  }
  const slice = (from: number, to: number) => text.slice(from, to);
  const names: OwnName[] = [];
  const includes: string[] = [];
  for (const found of lang === "python" ? pyModuleNames(tree.topNode, slice) : cFileNames(tree.topNode, slice, includes)) {
    if (found) names.push(found);
    yield;
  }
  return { names, includes };
}

/** How many generator steps run between two looks at the clock. */
const STEPS_PER_CHECK = 16;

type Version = Text | string;

export class WorkspaceIndex {
  private readonly entries = new Map<WsPath, { version: Version; found: FileNames }>();
  /** Per-path counters that changed() moves; `epoch` moves them all. */
  private readonly counters = new Map<WsPath, number>();
  private epoch = 0;
  private readonly queue: WsPath[] = [];
  private readonly queued = new Set<WsPath>();
  private readonly listeners = new Set<() => void>();
  /** nextUpdate()'s promise and its resolve, shared until the next notify(). */
  private next: { promise: Promise<void>; resolve: () => void } | null = null;
  private running = false;
  /** Files read and parsed so far (each version counts once). */
  parsed = 0;

  constructor(
    private readonly host: IndexHost,
    private readonly schedule: Scheduler = idleScheduler(),
  ) {}

  /** What `path` declares at its current version, or null until that is known (asking for it). */
  get(path: WsPath): FileNames | null {
    const entry = this.entries.get(path);
    if (entry && entry.version === this.versionOf(path)) return entry.found;
    this.want(path);
    return null;
  }

  /**
   * Stored files changed (saved, created, renamed, deleted, pulled): `paths`, or every file. Their
   * names are read again when next asked for. An open file's entry for its current text stays.
   */
  changed(paths?: readonly WsPath[]): void {
    if (paths) {
      for (const path of paths) this.counters.set(path, (this.counters.get(path) ?? 0) + 1);
    } else {
      this.epoch++;
    }
    for (const path of paths ?? [...this.entries.keys()]) {
      const entry = this.entries.get(path);
      if (entry && entry.version !== this.versionOf(path)) this.entries.delete(path);
    }
    this.notify();
  }

  /** Calls `listener` whenever a file's names become known or stored files change. */
  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Resolves the next time a file's names become known or stored files change (late-data.ts runs
   * a suggestion query again then). One promise for all callers until it resolves.
   */
  nextUpdate(): Promise<void> {
    if (!this.next) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      this.next = { promise, resolve };
    }
    return this.next.promise;
  }

  /** Reading or parsing is under way. */
  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  private versionOf(path: WsPath): Version {
    return this.host.live?.(path) ?? `${this.epoch}.${this.counters.get(path) ?? 0}`;
  }

  private notify(): void {
    const next = this.next;
    this.next = null;
    next?.resolve();
    for (const listener of [...this.listeners]) listener();
  }

  private want(path: WsPath): void {
    if (this.queued.has(path)) return;
    this.queued.add(path);
    this.queue.push(path);
    void this.drain();
  }

  /** Works through the queue one file at a time: read, then parse in slices. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let path = this.queue.shift(); path !== undefined; path = this.queue.shift()) {
        this.queued.delete(path);
        const version = this.versionOf(path);
        if (this.entries.get(path)?.version === version) continue;
        const lang = indexLanguage(path);
        let text: string | null = null;
        if (lang) text = typeof version === "string" ? await this.host.read(path).catch(() => null) : version.toString();
        // Changed while it was read: changed() told the sources, which ask again for the new version.
        if (this.versionOf(path) !== version) continue;
        let found = NOTHING;
        if (lang && text !== null) {
          try {
            found = await this.inSlices(scan(lang, text));
          } catch {
            found = NOTHING; // a file the parser can't handle offers nothing, quietly
          }
        }
        if (this.versionOf(path) !== version) continue;
        this.entries.set(path, { version, found });
        this.parsed++;
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }

  /** Runs `work` to its end in scheduled slices; resolves with its result. */
  private inSlices<T>(work: Generator<void, T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const slice: Slice = (more) => {
        try {
          for (let steps = 1; ; steps++) {
            const step = work.next();
            if (step.done) return resolve(step.value);
            if (steps % STEPS_PER_CHECK === 0 && !more()) break;
          }
          this.schedule(slice);
        } catch (error) {
          reject(error);
        }
      };
      this.schedule(slice);
    });
  }
}

/** The index in `slot`, made now if this is the first time it is needed. */
export function indexIn(slot: IndexSlot): WorkspaceIndex {
  return (slot.index ??= new WorkspaceIndex(slot.host, slot.scheduler));
}

/** The app's index for `state` (editor-manager.ts gives the slot), or null: then only the open file's own names. */
export function indexOf(state: EditorState): WorkspaceIndex | null {
  const slot = state.facet(workspaceIndex);
  return slot ? indexIn(slot) : null;
}
