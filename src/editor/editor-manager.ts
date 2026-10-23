// Many files, one editor. Each open file keeps its own EditorState (undo history, selection,
// folds, search query and diagnostics live there), swapped into one view with setState, as the
// CodeMirror maintainer recommends. Scroll position isn't part of a state, so a scroll snapshot is
// kept per file. While a file is on screen its stored state is stale: everything reads the
// host's state for the active file (the known pitfall from the CodeMirror forum, thread 2946).
//
// Builds don't lock the editor: beginBuild snapshots each file (EditTracker), the tool works on
// the snapshot, and endBuild maps every diagnostic through the edits made since. Diagnostics for
// files that aren't open are kept as the tool reported them and applied when the file opens.

import { diagnosticCount, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension, type StateCommand, type StateEffect, type Text, type Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import { cmSeverity, currentDiagnostics, diagnosticMessage, mergeSource, sourceLabel, toCm, type Severity } from "./diagnostics";
import { EditTracker } from "./edit-tracker";
import {
  appHandlers, BASE, DEFAULT_PREFS, fileConf, fileExtensions, fileIdFacet, notifyDocChanged, prefsConf, prefsExtension,
  READ_ONLY, readOnlyConf, WRITABLE, type EditorPrefs, type FileId,
} from "./extensions";
import { IndexSlot, libraryContext, workspaceIndex, type LibraryContext } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import { viewHost, type EditorHost, type HostFactory } from "./host";
import { clampPos } from "./positions";
import { RUN_CHANNEL } from "./run-marks";
import type { Scheduler } from "./workspace-index";

export type { EditorPrefs, FileId };

/** Open files kept in memory. Clean files beyond this are dropped, least recently used first. */
export const MAX_SESSIONS = 30;

export interface EditorHooks {
  /** After a different file (or none) is shown. setState fires no update listener, so this is the signal. */
  onActiveChange?(id: FileId | null): void;
  onDirtyChange?(id: FileId, dirty: boolean): void;
  /** Diagnostics were set, cleared, moved by an edit or moved between open and closed files. Debounce if costly. */
  onDiagnosticsChange?(): void;
  /** A file's text changed. The id comes from the state itself, so a late handler can't mix files up. */
  onDocChanged?(id: FileId, state: EditorState): void;
  /**
   * The active file's cursor or selection moved, or its text changed (`state` is its new state).
   * Called in the same task as the editor's own update, so what it draws (the status bar's Ln/Col)
   * goes into the editor's frame instead of a frame of its own. Keep it cheap: it runs on every key.
   */
  onSelectionChange?(id: FileId, state: EditorState): void;
  /** Mod-Enter in the editor. */
  onRun?(id: FileId): void;
  /** Mod-s in the editor. */
  onSave?(id: FileId): void;
  /** A clean, inactive file was dropped to stay within maxSessions; open() it again to show it. */
  onEvict?(id: FileId): void;
}

export interface EditorManagerOptions {
  /** Where the EditorView is created (browser). */
  parent?: HTMLElement;
  /** Replaces the EditorView, e.g. host.ts headlessHost() in unit tests. */
  host?: HostFactory;
  hooks?: EditorHooks;
  prefs?: Partial<EditorPrefs>;
  /** The run lock, for every file. */
  readOnly?: boolean;
  maxSessions?: number;
  /** The workspace's files and build standards, read by the import and #include suggestions. */
  library?: LibraryContext;
  /**
   * Reads a stored file's text, for the names other files declare (workspace-index.ts): included
   * headers in C and C++, imported modules in Python. Without it, only the open file's own names.
   */
  readFile?(path: WsPath): Promise<string>;
  /** When the index parses (default: idle slices). Tests pass their own. */
  indexScheduler?: Scheduler;
}

export interface OpenOptions {
  /** Show it now (default true). */
  activate?: boolean;
  /** This file can't be edited (opaque entries). */
  readOnly?: boolean;
}

export interface BuildTicket {
  readonly seq: number;
  /**
   * Diagnostics of this channel ("build" by default) are replaced when the build ends. The run's
   * own errors ("build") also band their line in the editor (run-marks.ts); the idle check's don't.
   */
  readonly channel: string;
  /** The open files in the build, with their path and snapshot when it started. */
  readonly files: ReadonlyMap<FileId, { readonly path: WsPath; readonly tracker: EditTracker }>;
  /** Every workspace path in the build (open or not): their old diagnostics of this channel go. */
  readonly paths: ReadonlySet<WsPath>;
  /** The open files' text exactly as snapshotted: send these to the tool. */
  readonly sources: readonly WorkspaceFile[];
}

/** One row of the app's Problems list (the lint panel shows only the active file). */
export interface Problem {
  /** The open file it is in; null for a closed file or a problem with the whole program. */
  id: FileId | null;
  path: WsPath | null;
  severity: Severity;
  /** Message with notes, as text. */
  message: string;
  /** "clang -Wunused-variable", "python ZeroDivisionError", ... */
  source: string;
  channel: string;
  /** 1-based. */
  line: number;
  /** 1-based UTF-16 column; open files only. */
  col?: number;
  /** Current offsets for reveal(); open files only. */
  from?: number;
  to?: number;
  /** Located by searching the source (linker errors). */
  heuristic: boolean;
  /** The tool's own report, as it arrived (the error help reads its message, source and notes). */
  diag?: ToolDiagnostic;
}

interface Session {
  readonly id: FileId;
  path: WsPath;
  /** Stale while this file is active: use stateOf(). */
  state: EditorState;
  savedDoc: Text;
  dirty: boolean;
  scroll: StateEffect<unknown> | null;
  readonly trackers: Set<EditTracker>;
  readOnly: boolean;
  lastUsed: number;
}

/** A diagnostic stored for a closed file: positions in the file's own text, as a tool reports them. */
function relocate(raw: ToolDiagnostic, doc: Text, from: number, to: number, path: WsPath): ToolDiagnostic {
  const start = doc.lineAt(from);
  const end = doc.lineAt(to);
  return { ...raw, path, line: start.number, col: from - start.from, endLine: end.number, endCol: to - end.from, unit: "utf16", base: 0 };
}

function rawProblem(d: ToolDiagnostic, path: WsPath | null, channel: string): Problem {
  return {
    id: null,
    path,
    severity: cmSeverity(d.severity),
    message: diagnosticMessage(d),
    source: sourceLabel(d),
    channel,
    line: Math.max(1, Math.trunc(d.line) || 1),
    heuristic: Boolean(d.heuristic),
    diag: d,
  };
}

function compareProblems(a: Problem, b: Problem): number {
  if (a.path !== b.path) {
    if (a.path === null) return -1;
    if (b.path === null) return 1;
    return a.path < b.path ? -1 : 1;
  }
  return a.line - b.line || (a.col ?? 0) - (b.col ?? 0);
}

export class EditorManager {
  readonly host: EditorHost;
  private readonly hooks: EditorHooks;
  private readonly handlers: Extension;
  /**
   * Other files' names for suggestions; null without options.readFile. The index itself is made
   * in the completion chunk the first time a suggestion needs it (workspace-index.ts indexIn).
   */
  readonly index: IndexSlot | null;
  private readonly maxSessions: number;
  private readonly sessions = new Map<FileId, Session>();
  /** Closed files' diagnostics: path, then channel. */
  private readonly pending = new Map<WsPath, Map<string, ToolDiagnostic[]>>();
  /** Diagnostics with no file (path null), per channel. */
  private readonly program = new Map<string, ToolDiagnostic[]>();
  private readonly latest = new Map<string, number>();
  private readonly tickets = new Set<BuildTicket>();
  private active: Session | null = null;
  private prefs: EditorPrefs;
  private prefsExt: Extension;
  private readOnly: boolean;
  /** > 0 while the host applies transactions (update listeners run then): setState/dispatch would throw. */
  private depth = 0;
  private seq = 0;
  private clock = 0;

  constructor(options: EditorManagerOptions) {
    this.hooks = options.hooks ?? {};
    this.maxSessions = Math.max(1, Math.trunc(options.maxSessions ?? MAX_SESSIONS) || MAX_SESSIONS);
    this.prefs = { ...DEFAULT_PREFS, ...options.prefs };
    this.prefsExt = prefsExtension(this.prefs);
    this.readOnly = options.readOnly ?? false;
    // An open file's text is newer than storage while it is typed in: the index reads that one.
    this.index = options.readFile ? new IndexSlot({ read: options.readFile, live: (path) => this.liveDoc(path) }, options.indexScheduler) : null;
    this.handlers = [
      appHandlers.of({
        run: (id) => {
          if (id != null) this.hooks.onRun?.(id);
        },
        save: (id) => {
          if (id != null) this.hooks.onSave?.(id);
        },
        docChanged: (id, state) => this.hooks.onDocChanged?.(id, state),
      }),
      options.library ? libraryContext.of(options.library) : [],
      this.index ? workspaceIndex.of(this.index) : [],
    ];
    const factory = options.host ?? (options.parent ? viewHost(options.parent) : null);
    if (!factory) throw new Error("EditorManager needs a parent element or a host");
    this.host = factory(this.placeholder(), (trs, commit) => this.onTransactions(trs, commit));
    // In the browser the suggestion code (a chunk of its own) starts loading with the editor, not
    // with the first file shown: the editor is fetched early when the pointer heads for the file
    // list, and a returning user's open tab is read from storage meanwhile (completion-loader.ts).
    if (this.host.view) void loadCompletionCode();
  }

  // ------------------------------------------------------------------ reading

  get activeId(): FileId | null {
    return this.active?.id ?? null;
  }

  /** The EditorView, or null when headless. */
  get view(): EditorView | null {
    return this.host.view;
  }

  has(id: FileId): boolean {
    return this.sessions.has(id);
  }

  ids(): FileId[] {
    return [...this.sessions.keys()];
  }

  path(id: FileId): WsPath | null {
    return this.sessions.get(id)?.path ?? null;
  }

  idForPath(path: WsPath): FileId | null {
    for (const s of this.sessions.values()) if (s.path === path) return s.id;
    return null;
  }

  /** The file's current state (the live one when it is active). */
  state(id: FileId): EditorState | null {
    const s = this.sessions.get(id);
    return s ? this.stateOf(s) : null;
  }

  /** LF text exactly as the editor shows it: send this to tools and to storage. */
  text(id: FileId): string | null {
    return this.state(id)?.doc.toString() ?? null;
  }

  isDirty(id: FileId): boolean {
    const s = this.sessions.get(id);
    return s ? !this.stateOf(s).doc.eq(s.savedDoc) : false;
  }

  isReadOnly(id?: FileId): boolean {
    if (id === undefined) return this.readOnly;
    const s = this.sessions.get(id);
    return this.readOnly || (s?.readOnly ?? false);
  }

  getPrefs(): EditorPrefs {
    return { ...this.prefs };
  }

  // ------------------------------------------------------------------ files

  /**
   * Opens a file (its LF content) under a stable id. Returns false when the id is already open
   * (the content is then ignored). Stored diagnostics for the path are applied. Throws if another
   * id already has this path open.
   */
  open(id: FileId, path: WsPath, content: string, options: OpenOptions = {}): boolean {
    const { activate = true, readOnly = false } = options;
    if (this.sessions.has(id)) {
      if (activate) this.activate(id);
      return false;
    }
    const other = this.idForPath(path);
    if (other != null) throw new Error(`${path} is already open as ${other}`);
    const state = EditorState.create({ doc: content, extensions: this.extensionsFor(id, path, readOnly) });
    const s: Session = { id, path, state, savedDoc: state.doc, dirty: false, scroll: null, trackers: new Set(), readOnly, lastUsed: ++this.clock };
    this.sessions.set(id, s);
    const applied = this.applyPending(s);
    this.evict(id);
    if (activate) this.activate(id);
    if (applied) this.hooks.onDiagnosticsChange?.();
    return true;
  }

  /** Shows a file. Called during an update (an update listener), it runs in a microtask instead. */
  activate(id: FileId): boolean {
    const next = this.sessions.get(id);
    if (!next) return false;
    if (this.depth > 0) {
      queueMicrotask(() => this.activate(id));
      return true;
    }
    next.lastUsed = ++this.clock;
    if (next === this.active) return true;
    this.stashActive();
    const state = this.reconciled(next.state, next);
    // setState first: if the view refuses it, `active` still names the file the view shows, so
    // stateOf() never hands out one file's text as another's.
    this.host.setState(state);
    this.active = next;
    const scroll = next.scroll;
    next.scroll = null;
    this.host.dispatch(state.update({ effects: scroll ?? EditorView.scrollIntoView(state.selection.main.head, { y: "center" }) }));
    this.hooks.onActiveChange?.(id);
    return true;
  }

  /**
   * Closes a file. A file with unsaved changes stays open unless `force` (the caller confirms
   * first): returns { closed: false, dirty: true }. Its undo history goes; its diagnostics are
   * kept for when it opens again. The active file is replaced by `next`, or else by the most
   * recently used open file, or else by an empty read-only placeholder.
   */
  close(id: FileId, options: { force?: boolean; next?: FileId | null } = {}): { closed: boolean; dirty: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { closed: true, dirty: false };
    const state = this.stateOf(s);
    const dirty = !state.doc.eq(s.savedDoc);
    if (dirty && !options.force) return { closed: false, dirty: true };
    const had = this.stash(s, state, dirty);
    this.sessions.delete(id);
    if (s === this.active) {
      this.active = null;
      const next = options.next !== undefined ? options.next : this.mostRecent();
      if (next != null && this.sessions.has(next)) this.activate(next);
      else this.showPlaceholder();
    }
    if (had) this.hooks.onDiagnosticsChange?.();
    return { closed: true, dirty };
  }

  /** The file moved: same id, history and diagnostics; grammar and label follow the new name. */
  rename(id: FileId, path: WsPath): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.path === path) return true;
    const other = this.idForPath(path);
    if (other != null) throw new Error(`${path} is already open as ${other}`);
    s.path = path;
    // Anything stored for a closed file that used to have this name isn't about this file.
    this.pending.delete(path);
    this.apply(id, { effects: fileConf.reconfigure(fileExtensions(path)) });
    if (diagnosticCount(this.stateOf(s)) > 0) this.hooks.onDiagnosticsChange?.(); // Problems rows show the path
    return true;
  }

  /**
   * Marks the file saved as of `docAtSaveStart` (capture `state(id).doc` when the save starts):
   * edits typed while an async save runs stay dirty.
   */
  markSaved(id: FileId, docAtSaveStart: Text): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.savedDoc = docAtSaveStart;
    this.updateDirty(s, this.stateOf(s));
    return true;
  }

  /**
   * New content from outside (a pull). A clean file gets a fresh state (new history, cursor kept
   * where possible, old diagnostics dropped) and is marked saved; returns false for a dirty file,
   * which the user has to resolve. Doesn't call onDocChanged: the caller already has the text.
   */
  replaceContent(id: FileId, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const current = this.stateOf(s);
    if (!current.doc.eq(s.savedDoc)) return false;
    if (current.doc.toString() === text) return true;
    if (s === this.active && this.depth > 0) {
      queueMicrotask(() => this.replaceContent(id, text));
      return true;
    }
    const fresh = EditorState.create({ doc: text, extensions: this.extensionsFor(s.id, s.path, s.readOnly) });
    const head = Math.min(current.selection.main.head, fresh.doc.length);
    const next = head > 0 ? fresh.update({ selection: { anchor: head } }).state : fresh;
    for (const tracker of s.trackers) tracker.stale = true;
    s.trackers.clear();
    s.savedDoc = next.doc;
    s.dirty = false;
    s.scroll = null;
    const had = diagnosticCount(current) > 0;
    if (s === this.active) {
      this.host.setState(next);
      this.host.dispatch(next.update({ effects: EditorView.scrollIntoView(next.selection.main.head, { y: "center" }) }));
      // setState is no transaction, so onTransactions didn't see the cursor land in the new text.
      this.hooks.onSelectionChange?.(s.id, this.host.state);
    } else {
      s.state = next;
    }
    if (had) this.hooks.onDiagnosticsChange?.();
    return true;
  }

  // ------------------------------------------------------------------ changing a file

  /**
   * Applies a transaction spec to a file, active or not (a function gets the file's current
   * state). This is how diagnostics reach files that aren't on screen. For the active file during
   * an update, it runs in a microtask instead.
   */
  apply(id: FileId, spec: TransactionSpec | ((state: EditorState) => TransactionSpec)): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s === this.active) {
      if (this.depth > 0) {
        queueMicrotask(() => this.apply(id, spec));
        return true;
      }
      const state = this.host.state;
      this.host.dispatch(state.update(typeof spec === "function" ? spec(state) : spec));
    } else {
      this.commitInactive(s, s.state.update(typeof spec === "function" ? spec(s.state) : spec));
    }
    return true;
  }

  /** Runs a state command (undo, redo, ...) on a file, active or not. Not from inside an update listener. */
  command(id: FileId, cmd: StateCommand): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s === this.active) return cmd({ state: this.host.state, dispatch: (tr) => this.host.dispatch(tr) });
    return cmd({ state: s.state, dispatch: (tr) => this.commitInactive(s, tr) });
  }

  /** Selects [from, to] in a file, shows it centred and focuses the editor. */
  reveal(id: FileId, from: number, to: number = from): boolean {
    if (!this.sessions.has(id)) return false;
    if (this.depth > 0) {
      queueMicrotask(() => this.reveal(id, from, to));
      return true;
    }
    this.activate(id);
    const state = this.host.state;
    const anchor = clampPos(state.doc, from);
    const head = clampPos(state.doc, to);
    this.host.dispatch(state.update({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) }));
    this.host.focus();
    return true;
  }

  /** The run lock for every file (no id), or read-only for one file. Other files catch up when shown. */
  setReadOnly(on: boolean, id?: FileId): void {
    if (id !== undefined) {
      const s = this.sessions.get(id);
      if (!s) return;
      s.readOnly = on;
    } else {
      this.readOnly = on;
    }
    this.reconfigureActive();
  }

  setPrefs(prefs: Partial<EditorPrefs>): void {
    this.prefs = { ...this.prefs, ...prefs };
    this.prefsExt = prefsExtension(this.prefs);
    this.reconfigureActive();
  }

  /** Stored files changed (`paths`, or any file): the index reads them again when they are next needed. */
  indexChanged(paths?: readonly WsPath[]): void {
    this.index?.changed(paths);
  }

  // ------------------------------------------------------------------ builds and diagnostics

  /**
   * Snapshots the open files `ids` for a build. `paths` lists every workspace path in the build,
   * open or not, so their old diagnostics of this channel are replaced too. A newer ticket of the
   * same channel supersedes this one.
   */
  beginBuild(ids: readonly FileId[], options: { channel?: string; paths?: readonly WsPath[] } = {}): BuildTicket {
    const channel = options.channel ?? RUN_CHANNEL;
    for (const old of [...this.tickets]) if (old.channel === channel) this.release(old);
    const files = new Map<FileId, { path: WsPath; tracker: EditTracker }>();
    const sources: WorkspaceFile[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s || files.has(id)) continue;
      const tracker = new EditTracker(this.stateOf(s).doc);
      s.trackers.add(tracker);
      files.set(id, { path: s.path, tracker });
      sources.push({ path: s.path, text: tracker.doc.toString() });
    }
    const paths = new Set<WsPath>(options.paths ?? []);
    for (const f of files.values()) paths.add(f.path);
    const ticket: BuildTicket = { seq: ++this.seq, channel, files, paths, sources };
    this.latest.set(channel, ticket.seq);
    this.tickets.add(ticket);
    return ticket;
  }

  /** Drops a build that won't report (worker crashed, run cancelled before compiling). */
  cancelBuild(ticket: BuildTicket): void {
    this.release(ticket);
    if (this.latest.get(ticket.channel) === ticket.seq) this.latest.delete(ticket.channel);
  }

  /**
   * Shows a build's results: for each file in the build (and each file a result names) the
   * channel's diagnostics are replaced. Positions are converted on the snapshot the tool saw and
   * mapped through the edits made since. Results for closed files are stored. Returns false (and
   * changes nothing) when a newer build of the channel has started or the ticket was cancelled.
   */
  endBuild(ticket: BuildTicket, results: readonly ToolDiagnostic[]): boolean {
    const current = this.tickets.has(ticket) && this.latest.get(ticket.channel) === ticket.seq;
    this.release(ticket);
    if (!current) return false;
    const { channel } = ticket;
    const byPath = new Map<WsPath | null, ToolDiagnostic[]>();
    for (const d of results) {
      const key = d.path ?? null;
      let list = byPath.get(key);
      if (!list) byPath.set(key, (list = []));
      list.push(d);
    }
    const done = new Set<WsPath>();
    for (const [id, f] of ticket.files) {
      const s = this.sessions.get(id);
      if (!s) continue; // closed during the build: handled below as a closed path
      done.add(f.path);
      this.setPending(f.path, channel, []);
      if (f.tracker.stale) continue; // replaced by a pull: these positions mean nothing now
      const list: Diagnostic[] = [];
      for (const d of byPath.get(f.path) ?? []) {
        const diagnostic = toCm(f.tracker.doc, d);
        const at = f.tracker.mapRange(diagnostic.from, diagnostic.to);
        if (at) list.push({ ...diagnostic, ...at });
      }
      this.apply(id, (state) => mergeSource(state, channel, list));
    }
    const scope = new Set(ticket.paths);
    for (const key of byPath.keys()) if (key !== null) scope.add(key);
    for (const path of scope) {
      if (done.has(path)) continue;
      const list = byPath.get(path) ?? [];
      const id = this.idForPath(path);
      if (id == null) {
        this.setPending(path, channel, list);
      } else {
        // Open now but not snapshotted: the tool read it from storage, which matches a clean file.
        this.setPending(path, channel, []);
        this.apply(id, (state) => mergeSource(state, channel, list.map((d) => toCm(state.doc, d))));
      }
    }
    const programLevel = byPath.get(null) ?? [];
    if (programLevel.length) this.program.set(channel, programLevel);
    else this.program.delete(channel);
    this.hooks.onDiagnosticsChange?.();
    return true;
  }

  /** Every diagnostic: program-level first, then by path and line. */
  problems(): Problem[] {
    const out: Problem[] = [];
    for (const [channel, list] of this.program) for (const d of list) out.push(rawProblem(d, null, channel));
    for (const s of this.sessions.values()) {
      const state = this.stateOf(s);
      for (const { diagnostic, from, to } of currentDiagnostics(state)) {
        const line = state.doc.lineAt(from);
        out.push({
          id: s.id,
          path: s.path,
          severity: diagnostic.severity,
          message: diagnostic.message,
          source: diagnostic.source ?? "",
          channel: diagnostic.channel ?? "",
          line: line.number,
          col: from - line.from + 1,
          from,
          to,
          heuristic: Boolean(diagnostic.raw?.heuristic),
          ...(diagnostic.raw ? { diag: diagnostic.raw } : {}),
        });
      }
    }
    for (const [path, byChannel] of this.pending) {
      for (const [channel, list] of byChannel) for (const d of list) out.push(rawProblem(d, path, channel));
    }
    return out.sort(compareProblems);
  }

  /** A closed file was renamed (`to`) or deleted (null): its stored diagnostics follow or go. */
  movePending(from: WsPath, to: WsPath | null): void {
    const byChannel = this.pending.get(from);
    if (!byChannel) return;
    this.pending.delete(from);
    if (to != null) {
      for (const [channel, list] of byChannel) this.setPending(to, channel, list.map((d) => ({ ...d, path: to })));
    }
    this.hooks.onDiagnosticsChange?.();
  }

  destroy(): void {
    this.host.destroy();
    this.sessions.clear();
    this.active = null;
  }

  // ------------------------------------------------------------------ internals

  private stateOf(s: Session): EditorState {
    return s === this.active ? this.host.state : s.state;
  }

  /** The current text of the open file at `path`, or null when it isn't open. */
  private liveDoc(path: WsPath): Text | null {
    for (const s of this.sessions.values()) if (s.path === path) return this.stateOf(s).doc;
    return null;
  }

  private extensionsFor(id: FileId, path: WsPath, readOnly: boolean): Extension {
    return [
      this.handlers,
      BASE,
      fileIdFacet.of(id),
      fileConf.of(fileExtensions(path)),
      readOnlyConf.of(this.readOnly || readOnly ? READ_ONLY : WRITABLE),
      prefsConf.of(this.prefsExt),
    ];
  }

  private placeholder(): EditorState {
    return EditorState.create({
      extensions: [
        this.handlers,
        BASE,
        fileConf.of(EditorView.contentAttributes.of({ "aria-label": "Code editor, no file open" })),
        readOnlyConf.of(READ_ONLY),
        prefsConf.of(this.prefsExt),
      ],
    });
  }

  private showPlaceholder(): void {
    if (this.depth > 0) {
      queueMicrotask(() => {
        if (!this.active) this.showPlaceholder();
      });
      return;
    }
    this.host.setState(this.placeholder());
    this.hooks.onActiveChange?.(null);
  }

  /** Compartment changes a state needs to match the current lock and preferences (none: []). */
  private reconcileEffects(state: EditorState, s: Session | null): StateEffect<unknown>[] {
    const readOnly = s === null || this.readOnly || s.readOnly ? READ_ONLY : WRITABLE;
    const effects: StateEffect<unknown>[] = [];
    if (readOnlyConf.get(state) !== readOnly) effects.push(readOnlyConf.reconfigure(readOnly));
    if (prefsConf.get(state) !== this.prefsExt) effects.push(prefsConf.reconfigure(this.prefsExt));
    return effects;
  }

  private reconciled(state: EditorState, s: Session): EditorState {
    const effects = this.reconcileEffects(state, s);
    return effects.length ? state.update({ effects }).state : state;
  }

  private reconfigureActive(): void {
    if (this.depth > 0) {
      queueMicrotask(() => this.reconfigureActive());
      return;
    }
    const state = this.host.state;
    const effects = this.reconcileEffects(state, this.active);
    if (effects.length) this.host.dispatch(state.update({ effects }));
  }

  private stashActive(): void {
    const cur = this.active;
    if (!cur) return;
    cur.state = this.host.state;
    cur.scroll = this.host.scrollSnapshot();
  }

  private mostRecent(): FileId | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) if (!best || s.lastUsed > best.lastUsed) best = s;
    return best?.id ?? null;
  }

  /** The host's handler for the active file's transactions (typing, commands, apply()). */
  private onTransactions(trs: readonly Transaction[], commit: () => void): void {
    const s = this.active;
    const mine = s !== null && trs.length > 0 && trs[0].startState.facet(fileIdFacet) === s.id;
    const trackers = mine ? [...s.trackers] : [];
    this.depth++;
    try {
      commit();
    } finally {
      this.depth--;
    }
    if (mine && this.active === s && trs.some((tr) => tr.selection !== undefined || tr.docChanged)) this.hooks.onSelectionChange?.(s.id, this.host.state);
    if (!mine || !trs.some((tr) => tr.docChanged) || this.sessions.get(s.id) !== s) return;
    for (const tr of trs) if (tr.docChanged) for (const tracker of trackers) tracker.add(tr.changes);
    this.afterDocChange(s, trs[0].startState, this.host.state);
  }

  private commitInactive(s: Session, tr: Transaction): void {
    if (tr.startState !== s.state) throw new RangeError("The transaction doesn't start from the file's current state");
    s.state = tr.state;
    if (!tr.docChanged) return;
    for (const tracker of s.trackers) tracker.add(tr.changes);
    if (s.scroll) s.scroll = s.scroll.map(tr.changes) ?? null;
    notifyDocChanged(tr.state);
    this.afterDocChange(s, tr.startState, tr.state);
  }

  private afterDocChange(s: Session, before: EditorState, after: EditorState): void {
    this.updateDirty(s, after);
    if (diagnosticCount(before) > 0) this.hooks.onDiagnosticsChange?.();
  }

  private updateDirty(s: Session, state: EditorState): void {
    const dirty = !state.doc.eq(s.savedDoc);
    if (dirty === s.dirty) return;
    s.dirty = dirty;
    this.hooks.onDirtyChange?.(s.id, dirty);
  }

  /** Moves a file's diagnostics into the pending store before its state goes. Returns whether it had any. */
  private stash(s: Session, state: EditorState, dirty: boolean): boolean {
    let any = false;
    for (const { diagnostic, from, to } of currentDiagnostics(state)) {
      const { raw, channel } = diagnostic;
      if (!raw || channel == null) continue;
      any = true;
      // A dirty file closed without saving goes back to its saved text, so its current positions
      // would point into text that no longer exists: keep the tool's own report instead.
      const entry = dirty ? { ...raw, path: s.path } : relocate(raw, state.doc, from, to, s.path);
      const byChannel = this.pending.get(s.path) ?? new Map<string, ToolDiagnostic[]>();
      this.pending.set(s.path, byChannel);
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), entry]);
    }
    return any;
  }

  private applyPending(s: Session): boolean {
    const byChannel = this.pending.get(s.path);
    if (!byChannel) return false;
    this.pending.delete(s.path);
    let state = s.state;
    for (const [channel, list] of byChannel) {
      const doc = state.doc;
      state = state.update(mergeSource(state, channel, list.map((d) => toCm(doc, d)))).state;
    }
    s.state = state;
    return true;
  }

  private setPending(path: WsPath, channel: string, list: readonly ToolDiagnostic[]): void {
    const byChannel = this.pending.get(path);
    if (list.length) {
      const next = byChannel ?? new Map<string, ToolDiagnostic[]>();
      next.set(channel, [...list]);
      this.pending.set(path, next);
    } else if (byChannel) {
      byChannel.delete(channel);
      if (!byChannel.size) this.pending.delete(path);
    }
  }

  private release(ticket: BuildTicket): void {
    for (const [id, f] of ticket.files) this.sessions.get(id)?.trackers.delete(f.tracker);
    this.tickets.delete(ticket);
  }

  /** Drops least recently used clean, inactive files beyond maxSessions (never `keep`, never a dirty one). */
  private evict(keep: FileId): void {
    while (this.sessions.size > this.maxSessions) {
      let victim: Session | null = null;
      for (const s of this.sessions.values()) {
        if (s === this.active || s.id === keep || !s.state.doc.eq(s.savedDoc)) continue;
        if (!victim || s.lastUsed < victim.lastUsed) victim = s;
      }
      if (!victim) return;
      const had = this.stash(victim, victim.state, false);
      this.sessions.delete(victim.id);
      this.hooks.onEvict?.(victim.id);
      if (had) this.hooks.onDiagnosticsChange?.();
    }
  }
}
