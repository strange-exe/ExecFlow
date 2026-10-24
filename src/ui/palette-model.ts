// The command palette's model (no DOM): what it lists, and how typed text picks from it. Loaded with
// the palette's lazy chunk (palette.ts), never on a first visit.
//
// Matching is meant to be predictable for a beginner, not a fuzzy scatter of letters: a label
// matches when it starts with the text, a word in it does, it contains the text, every typed word
// is in it, or the text is the start of its words' initials ("nfe": New from example). Ranked in
// that order; ties keep the list's own order. .claude/design/batch3/p.md section 1.
import { nameOf, parentOf } from "../core/paths";
import type { EditorView } from "@codemirror/view";
import type { MenuItem } from "./menu";
import type { Notice } from "./notice";
import type { SettingsStore } from "./settings";
import { shortcutKeys } from "./shortcuts";

/** A range of a label to draw as matched (start inclusive, end exclusive). */
export interface Hit {
  start: number;
  end: number;
}

export interface Match {
  score: number;
  hits: Hit[];
}

const WORD_START = /[a-z0-9]/i;

/** Where each word of `text` starts (a letter or digit after anything else). */
function wordStarts(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (WORD_START.test(text[i]) && (i === 0 || !WORD_START.test(text[i - 1]))) out.push(i);
  }
  return out;
}

/**
 * How well `query` matches `label` (null: not at all). `also`: extra words that match without
 * being drawn ("color" for "colour").
 */
export function matchText(label: string, query: string, also = ""): Match | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return { score: 0, hits: [] };
  const l = label.toLowerCase();
  // A whole word beats the start of a longer one ("line" finds "Go to a line" before "lines").
  const whole = (end: number) => (end >= l.length || !WORD_START.test(l[end]) ? 20 : 0);
  if (l.startsWith(q)) return { score: 400 + whole(q.length), hits: [{ start: 0, end: q.length }] };
  const starts = wordStarts(label);
  for (const s of starts) if (l.startsWith(q, s)) return { score: 300 + whole(s + q.length), hits: [{ start: s, end: s + q.length }] };
  const at = l.indexOf(q);
  if (at >= 0) return { score: 200, hits: [{ start: at, end: at + q.length }] };
  const words = q.split(" ");
  if (words.length > 1) {
    const hits: Hit[] = [];
    for (const w of words) {
      const i = l.indexOf(w);
      if (i < 0) break;
      hits.push({ start: i, end: i + w.length });
    }
    if (hits.length === words.length) return { score: 150, hits: hits.sort((a, b) => a.start - b.start) };
  }
  if (q.length >= 2 && !q.includes(" ")) {
    const initials = starts.map((s) => l[s]).join("");
    if (initials.startsWith(q)) return { score: 100, hits: starts.slice(0, q.length).map((s) => ({ start: s, end: s + 1 })) };
  }
  const extra = also.toLowerCase();
  if (extra && words.every((w) => extra.includes(w))) return { score: 50, hits: [] };
  return null;
}

/** A file: its name counts before its folders; hits are on the name only. */
export function matchFile(path: string, query: string): Match | null {
  const name = matchText(nameOf(path), query);
  if (name) return { score: name.score + 10, hits: name.hits };
  const whole = matchText(path, query);
  return whole ? { score: whole.score - 10, hits: [] } : null;
}

// ---------------------------------------------------------------- the commands

export type Group = "Run" | "Files" | "Code" | "View" | "Settings" | "GitHub" | "Help";
export const GROUPS: readonly Group[] = ["Run", "Files", "Code", "View", "Settings", "GitHub", "Help"];

/** Editor commands run through palette-editor.ts (CodeMirror's own, in the editor chunk). */
export type EditorCommandId =
  | "gotoLine" | "find" | "replace" | "selectNext" | "selectAllMatches" | "addCursorAbove" | "addCursorBelow" | "moveLineUp" | "moveLineDown"
  | "comment" | "fold" | "unfold" | "foldAll" | "unfoldAll" | "nextProblem" | "undo" | "redo" | "tabFocus";

export interface PaletteCommand {
  id: string;
  label: string;
  group: Group;
  /** Keys as the Shortcuts list spells them (shortcutKeys). */
  keys?: string;
  /** Words that match without being drawn. */
  also?: string;
  run(opener: HTMLElement): void;
}

/** What the workbench lends the palette. Everything is asked for at the moment it is needed. */
export interface PaletteApi {
  readonly mac: boolean;
  /** A file is shown in the editor (the editor chunk has loaded). */
  fileOpen(): boolean;
  running(): boolean;
  /** Python is or was in use (Restart Python applies). */
  python(): boolean;
  connected(): boolean;
  canWrite(): boolean;
  /** Shows why the tab can't write, and returns true when it can't (workbench.ts explainReadOnly). */
  explainReadOnly(): boolean;
  /** Every file of the workspace, and whether it is opaque (read-only binary or special). */
  files(): readonly { path: string; opaque: boolean }[];
  /** The files open in tabs, in tab order. */
  openPaths(): readonly string[];
  activePath(): string | null;
  view(): EditorView | null;
  readonly settings: Pick<SettingsStore, "get" | "update">;
  readonly notice: Pick<Notice, "show">;
  /** Wider and narrower file list, as the file menu offers them (desktop only). */
  widthItems(): MenuItem[];
  readonly act: {
    run(): void;
    stop(): void;
    save(): void;
    open(path: string): void;
    close(): void;
    newFile(): void;
    newFolder(): void;
    examples(opener: HTMLElement): void;
    rename(): void;
    remove(): void;
    importFiles(): void;
    importFolder(): void;
    exportZip(): void;
    savePdf(opener: HTMLElement): void;
    capture(opener: HTMLElement): void;
    fileList(): void;
    output(): void;
    problems(): void;
    settings(opener: HTMLElement): void;
    shortcuts(opener: HTMLElement): void;
    connect(): void;
    syncNow(): void;
    syncWithMessage(opener: HTMLElement): void;
    restartPython(): void;
    clearOutput(): void;
  };
}

/** Commands that change the text: a tab that can't write explains instead (the menus' rule). */
const WRITES = new Set<EditorCommandId>(["moveLineUp", "moveLineDown", "comment", "undo", "redo"]);

/**
 * Runs a CodeMirror command on the shown file (palette-editor.ts, loaded the first time). One that
 * finds nothing to act on says so in the notice; the code keeps the focus.
 */
function runEditor(api: PaletteApi, id: EditorCommandId): void {
  const view = api.view();
  if (!view) return;
  view.focus();
  void import("./palette-editor").then(
    (m) => {
      const why = m.runEditorCommand(view, id);
      if (why) api.notice.show(why, { tone: "info" });
    },
    (e: unknown) => api.notice.show(`That command couldn't run: ${e instanceof Error && e.message ? e.message : "the editor didn't answer"}.`),
  );
}

/**
 * Copies the selection through CodeMirror's own copy handler (the code focused first), judged by its
 * effect as the code menu judges it (code-menu.ts copyThroughEditor): the copy event fired and was
 * cancelled, so CodeMirror filled the clipboard. Runs inside the key or click that chose it.
 */
function copyThroughEditor(view: EditorView): boolean {
  view.focus();
  let done = false;
  const listener = (e: ClipboardEvent) => (done = e.defaultPrevented);
  addEventListener("copy", listener);
  try {
    document.execCommand("copy");
  } catch {
    // judged by its effect
  } finally {
    removeEventListener("copy", listener);
  }
  return done;
}

function clipboard(api: PaletteApi, cut: boolean): void {
  const view = api.view();
  if (!view) return;
  const key = `${api.mac ? "Cmd" : "Ctrl"}+${cut ? "X" : "C"}`;
  if (!copyThroughEditor(view)) {
    api.notice.show(`Couldn't ${cut ? "cut" : "copy"} from here. Press ${key} in the code instead.`, { tone: "info" });
    return;
  }
  // The editor's own cut: one transaction, one undo step (as the code menu's Cut).
  if (cut) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
}

/** The commands that apply now, in their list order (grouped as GROUPS). */
export function buildCommands(api: PaletteApi): PaletteCommand[] {
  const k = shortcutKeys(api.mac);
  const [foldKey, unfoldKey] = k.fold.split(" or ");
  const [foldAllKey, unfoldAllKey] = k.foldAll.split(" or ");
  const [cursorUp, cursorDown] = k.addCursor.split(" or ");
  const [lineUp, lineDown] = k.moveLine.split(" or ");
  const file = api.fileOpen();
  const s = api.settings.get();
  const list: (PaletteCommand | false)[] = [];
  const add = (id: string, group: Group, label: string, run: (opener: HTMLElement) => void, keys?: string, also?: string) => list.push({ id, group, label, run, keys, also });
  const editor = (id: EditorCommandId, label: string, keys?: string, also?: string) =>
    add(id, "Code", label, () => (WRITES.has(id) && api.explainReadOnly() ? undefined : runEditor(api, id)), keys, also);
  const toggle = (label: string, on: boolean) => `Turn ${label} ${on ? "off" : "on"}`;

  // Run, or Stop while a program runs (Run's own button turns into Stop then; Run explains itself
  // with nothing runnable open).
  if (api.running()) add("stop", "Run", "Stop the program", () => api.act.stop(), k.stop, "kill end");
  else add("run", "Run", "Run the open file", () => api.act.run(), k.run, "start execute");
  // Restart Python waits for the run to end, as its button does (disabled while running).
  if (api.python() && !api.running()) add("restart-python", "Run", "Restart Python", () => api.act.restartPython(), undefined, "reset");
  add("clear-output", "Run", "Clear the output", () => api.act.clearOutput(), undefined, "console erase");

  // Files: the file menu's actions (they explain a read-only tab themselves).
  add("new-file", "Files", "New file", () => api.act.newFile(), undefined, "create add");
  add("new-folder", "Files", "New folder", () => api.act.newFolder(), undefined, "create directory");
  add("examples", "Files", "New from example...", (o) => api.act.examples(o), undefined, "sample template starter program");
  if (file) {
    add("save", "Files", "Save now", () => api.act.save(), k.save, "sync");
    add("close", "Files", "Close the open file", () => api.act.close(), k.close, "tab");
    add("rename", "Files", "Rename the open file", () => api.act.rename(), undefined, "move");
    add("delete", "Files", "Delete the open file", () => api.act.remove(), undefined, "remove trash");
    add("capture", "Files", "Capture snippet of the selected lines...", (o) => api.act.capture(o), undefined, "image picture screenshot png");
  }
  add("import-files", "Files", "Import files", () => api.act.importFiles(), undefined, "upload open add");
  add("import-folder", "Files", "Import a folder", () => api.act.importFolder(), undefined, "upload directory");
  add("export", "Files", "Export workspace (.zip)", () => api.act.exportZip(), undefined, "download backup zip");
  add("save-pdf", "Files", "Save as PDF...", (o) => api.act.savePdf(o), undefined, "print printer export paper document");
  add("file-list", "Files", "Go to the file list", () => api.act.fileList(), k.fileList, "tree explorer sidebar");
  for (const item of api.widthItems()) add(`width-${item.label}`, "Files", item.label, () => item.run(), undefined, "sidebar size");

  // Code: only with a file shown (they act on it).
  if (file) {
    editor("gotoLine", "Go to a line", k.gotoLine, "jump number");
    editor("find", "Find in the file", k.find, "search");
    editor("replace", "Replace in the file", k.find, "search change");
    editor("selectNext", "Select the next match of the selection too", k.selectNext, "multiple cursors occurrence");
    editor("selectAllMatches", "Select every match of the selection", k.selectAllMatches, "multiple cursors occurrences");
    editor("addCursorAbove", "Add a cursor on the line above", cursorUp, "multiple cursors");
    editor("addCursorBelow", "Add a cursor on the line below", cursorDown, "multiple cursors");
    editor("moveLineUp", "Move the line up", lineUp);
    editor("moveLineDown", "Move the line down", lineDown);
    editor("comment", "Comment or uncomment the line", k.comment, "toggle");
    editor("fold", "Fold the block at the cursor", foldKey, "collapse hide");
    editor("unfold", "Unfold the block at the cursor", unfoldKey, "expand show");
    editor("foldAll", "Fold every block", foldAllKey, "collapse all");
    editor("unfoldAll", "Unfold every block", unfoldAllKey, "expand all");
    editor("nextProblem", "Go to the next problem in the file", k.nextProblem, "error warning diagnostic");
    editor("undo", "Undo", k.undo);
    editor("redo", "Redo", k.redo);
    add("cut", "Code", "Cut", () => (api.explainReadOnly() ? undefined : clipboard(api, true)), k.cut, "clipboard");
    add("copy", "Code", "Copy", () => clipboard(api, false), k.copy, "clipboard");
    add("select-all", "Code", "Select all", () => {
      const view = api.view();
      view?.focus();
      view?.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    }, k.selectAll);
    editor("tabFocus", "Turn Tab-moves-focus on or off", k.tabFocus, "keyboard trap leave");
  }

  // View.
  add("output", "View", "Go to the output", () => api.act.output(), k.output, "console terminal panel");
  add("problems", "View", "Show the problems", () => api.act.problems(), undefined, "errors warnings panel");

  // Settings that are actions (Settings itself holds the rest).
  add("settings", "Settings", "Open Settings", (o) => api.act.settings(o), undefined, "preferences options");
  add("theme", "Settings", "Change the colour theme...", (o) => api.act.settings(o), undefined, "color dark light mode appearance");
  add("wrap", "Settings", toggle("line wrapping", s.lineWrapping), () => {
    const on = api.settings.update({ lineWrapping: !api.settings.get().lineWrapping }).lineWrapping;
    api.notice.show(`Line wrapping is ${on ? "on" : "off"}.`, { tone: "info" });
  }, undefined, "wrap long lines");
  add("suggest", "Settings", toggle("suggestions while typing", s.suggestOnTyping), () => {
    const on = api.settings.update({ suggestOnTyping: !api.settings.get().suggestOnTyping }).suggestOnTyping;
    api.notice.show(`Suggestions while typing are ${on ? "on" : "off"}.`, { tone: "info" });
  }, undefined, "autocomplete completion");
  const size = (by: number) => () => {
    const px = api.settings.update({ codeSize: api.settings.get().codeSize + by }).codeSize;
    api.notice.show(`The code text is ${px} px.`, { tone: "info" });
  };
  add("text-larger", "Settings", "Make the code text larger", size(1), undefined, "font size zoom bigger");
  add("text-smaller", "Settings", "Make the code text smaller", size(-1), undefined, "font size zoom");

  // GitHub.
  if (api.connected()) {
    add("sync", "GitHub", "Sync with GitHub now", () => api.act.syncNow(), undefined, "push pull upload");
    add("sync-message", "GitHub", "Sync now with a message...", (o) => api.act.syncWithMessage(o), undefined, "commit describe push upload");
    add("auto-sync", "GitHub", toggle("automatic sync", s.autoSync), () => {
      const on = api.settings.update({ autoSync: !api.settings.get().autoSync }).autoSync;
      api.notice.show(`Automatic sync is ${on ? "on" : "off"}.`, { tone: "info" });
    }, undefined, "auto");
  } else add("connect", "GitHub", "Connect GitHub...", () => api.act.connect(), undefined, "repository sync login");

  add("shortcuts", "Help", "Keyboard shortcuts", (o) => api.act.shortcuts(o), k.shortcuts, "keys help");
  return list.filter((c): c is PaletteCommand => c !== false);
}

// ---------------------------------------------------------------- results

export interface FileOption {
  kind: "file";
  path: string;
  hits: Hit[];
  /** The folder, shown quietly after the name ("" at the top level). */
  folder: string;
  current: boolean;
}

export interface CommandOption {
  kind: "command";
  command: PaletteCommand;
  hits: Hit[];
}

export type Option = FileOption | CommandOption;

export interface ResultGroup {
  title: string;
  options: Option[];
}

export interface Results {
  commandsOnly: boolean;
  groups: ResultGroup[];
  /** Files left out by the cap: "type more of the name". */
  moreFiles: number;
  count: number;
}

/** Files listed with nothing typed (open ones first), and at most with a query. */
export const FILES_IDLE = 10;
export const FILES_MAX = 50;

/**
 * What the palette shows for `value`. A leading ">" limits it to commands; without it, files come
 * first, then commands. Nothing typed: the open files, then the rest, capped; commands by group.
 */
export function results(value: string, files: readonly { path: string; opaque: boolean }[], openPaths: readonly string[], active: string | null, commands: readonly PaletteCommand[]): Results {
  const commandsOnly = value.startsWith(">");
  const query = (commandsOnly ? value.slice(1) : value).trim();
  const groups: ResultGroup[] = [];
  let moreFiles = 0;
  if (!commandsOnly) {
    const fileOption = (path: string, hits: Hit[]): FileOption => ({ kind: "file", path, hits, folder: parentOf(path), current: path === active });
    let found: FileOption[];
    if (!query) {
      const open = new Set(openPaths);
      const ordered = [...openPaths.filter((p) => files.some((f) => f.path === p)), ...files.map((f) => f.path).filter((p) => !open.has(p))];
      found = ordered.slice(0, FILES_IDLE).map((p) => fileOption(p, []));
      moreFiles = Math.max(0, ordered.length - FILES_IDLE);
    } else {
      const ranked = files
        .map((f, i) => ({ f, i, m: matchFile(f.path, query) }))
        .filter((x): x is { f: (typeof files)[number]; i: number; m: Match } => x.m !== null)
        .sort((a, b) => b.m.score - a.m.score || a.i - b.i);
      found = ranked.slice(0, FILES_MAX).map((x) => fileOption(x.f.path, x.m.hits));
      moreFiles = Math.max(0, ranked.length - FILES_MAX);
    }
    if (found.length) groups.push({ title: "Files", options: found });
  }
  if (!query && commandsOnly) {
    for (const g of GROUPS) {
      const options = commands.filter((c) => c.group === g).map((c): CommandOption => ({ kind: "command", command: c, hits: [] }));
      if (options.length) groups.push({ title: g, options });
    }
  } else {
    const ranked = commands
      .map((c, i) => ({ c, i, m: matchText(c.label, query, c.also) }))
      .filter((x): x is { c: PaletteCommand; i: number; m: Match } => x.m !== null)
      .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
      .map((x): CommandOption => ({ kind: "command", command: x.c, hits: x.m.hits }));
    if (ranked.length) groups.push({ title: "Commands", options: ranked });
  }
  return { commandsOnly, groups, moreFiles, count: groups.reduce((n, g) => n + g.options.length, 0) };
}
