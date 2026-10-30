// The workbench controller: wires storage (one writer tab per workspace), the editor, the file
// tree, tabs, runs, the Output and Problems panels, settings and the keyboard. DOM is built by
// layout.ts and the component modules; this file decides what happens.
import type { EditorState } from "@codemirror/state";
import { detectLanguage, isHeader, LANGUAGES, type LanguageId } from "../core/languages";
import { conflictName, foldKey, isInside, joinPath, nameOf, parentOf } from "../core/paths";
import type { EntryMeta, RunResult, RunStatus, ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import type { EditorManager, FileId, Problem } from "../editor/editor-manager";
import { toLineCol } from "../editor/positions";
import { deleteAllLocalData, isClosedError, isVersionError, openWorkspaceDb, StorageError, type UiState, type WorkspaceDb, type WorkspaceRecord } from "../storage/db";
import { createTabCoordinator, relayChanges, type ReadOnlyReason, type TabCoordinator } from "../storage/tabs";
import { createWorkspaceStore, type WorkspaceStore } from "../storage/workspace";
import { attachCodeMenu } from "./code-menu";
import type { AddRefusal } from "./code-link-dialog";
import { confirmDialog } from "./dialogs";
import { ariaMod, h, isMac, isTyping, listNames, plural, shown } from "./dom";
import { noEditor, type Editors } from "./editors";
import { emptyWorkspace, noFileOpen, openingFile } from "./empty-state";
import { icon } from "./icons";
import { MOVE_PATH, moveRole } from "../core/move-protocol";
import { downloadPicked, exportZip, pickFiles, workspaceZip } from "./import-export";
import { describeImport, showRefusals } from "./import-notice";
import { createLayout, NARROW, WIDE } from "./layout";
import type { Splitter } from "./splitter";
import { closeMenus, menuButton, openMenu, type MenuItem } from "./menu";
import { createAnnouncer, createNotice } from "./notice";
import type { PaletteApi } from "./palette-model";
import { FAILED, OutputView, statusWord, type LiftedError } from "./output";
import { countProblems, describeCounts, ProblemsView, SEVERITY_WORD, type RenderHelp } from "./problems";
import { Runtimes, runtimeOf, type RuntimeKind } from "./run";
import { dropStash, readStash, textHash, writeStash } from "./recover";
import { callSiteMarks } from "./run-diagnostics";
import { mainToOffer, phaseLabel } from "./run-words";
import { buildOptions, createSettingsStore, runLimits } from "./settings";
import { whatsNew } from "../about/whats-new";
import { paletteKey } from "./palette-keys";
import { createSnippetCapture } from "./snippet-image";
import { mountSync, type SyncHooks } from "./sync-entry";
import { TabStrip } from "./tabs";
import type { ChartHost, FlowchartView } from "./flowchart-view";
import { FileTree } from "./tree";
import { starterText, type TreeNode } from "./tree-model";

const WORKSPACE_NAME = "Workspace";
const AUTOSAVE_MS = 400;
const CHECK_MS = 500;
const STDIN_KEY = "codeeditor:stdin";

interface OpenFile {
  id: FileId;
  path: WsPath;
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong.");

function announcement(r: RunResult, summary: string, path: WsPath, timeLimitS: number): string {
  switch (r.status) {
    case "ok":
      return `Finished: ${nameOf(path)} exited with code 0.`;
    case "error":
      return `${statusWord(r)}${summary ? `: ${summary}` : ""}.`;
    case "build-failed":
      return `Build failed${summary ? `: ${summary}` : ""}.`;
    case "timeout":
      return `Stopped: still running after the ${timeLimitS} second limit.`;
    case "output-limit":
      return "Stopped: the program printed more than the output limit.";
    case "stopped":
      return "Stopped.";
    case "crashed":
      // The message is its own plain sentence ("The program ran out of stack memory: ..."), B13.
      return `Crashed.${r.message ? ` ${r.message}` : ""}`;
    case "unavailable":
      return `Couldn't run${r.message ? `: ${r.message}` : "."}`;
  }
}

/** A compiler-style line for the console: "main.c:3:5: error: expected ';'". */
function diagnosticLine(d: ToolDiagnostic): string {
  const col = d.col === undefined ? "" : `:${d.base === 0 ? d.col + 1 : d.col}`;
  const where = d.path ? `${d.path}:${d.line}${col}: ` : "";
  return `${where}${(SEVERITY_WORD[d.severity] ?? "Error").toLowerCase()}: ${d.message.split("\n")[0]}`;
}

export async function startWorkbench(root: HTMLElement): Promise<void> {
  const L = createLayout(root);
  // A notice's button that had focus goes away with it: focus moves to the code (or Run, or, with
  // nothing open and so no Run, the Shortcuts button beside the notice).
  const isShown = (el: HTMLElement) => el.getClientRects().length > 0;
  const notice = createNotice({
    returnFocus: () => (manager && editors.activeId ? L.editorHost.querySelector<HTMLElement>(".cm-content") : null) ?? (isShown(L.runButton) ? L.runButton : L.status.shortcuts),
  });
  L.noticeHost.append(notice.element);
  const announcer = createAnnouncer();
  root.append(announcer.element);
  const settings = createSettingsStore();
  const runtimes = new Runtimes();
  const output = new OutputView();
  L.outputPanel.append(output.element);
  const problemsView = new ProblemsView();
  L.problemsPanel.append(problemsView.element);
  L.editorPanel.append(
    h("span", { id: "editor-help", hidden: true }, `Tab indents. To move on, press Escape and then Tab (Escape first closes suggestions or clears a selection), or press ${isMac() ? "Shift Option M" : "Control M"} so that Tab moves the focus. With code selected, Shift F10 opens its menu.`),
  );
  root.style.setProperty("--code-size", `${settings.get().codeSize}px`);
  try {
    output.stdin.value = sessionStorage.getItem(STDIN_KEY) ?? "";
  } catch {
    // storage blocked
  }
  output.stdin.addEventListener("input", () => {
    try {
      sessionStorage.setItem(STDIN_KEY, output.stdin.value);
    } catch {
      // storage blocked
    }
  });

  // ---------------------------------------------------------------- storage and the writer lock
  let db: WorkspaceDb;
  let store: WorkspaceStore;
  let record: WorkspaceRecord;
  let tab: TabCoordinator | null = null;
  try {
    db = await openWorkspaceDb({
      onBlocking({ blockedVersion, close }) {
        // Another tab is clearing this computer (or a newer version needs the database).
        // Still starting up: nothing can be unsaved yet (and the editor state below isn't set up).
        if (root.dataset.state !== "ready") {
          close();
          notice.show("ExecFlow's data on this computer changed in another tab. Reload to continue.", { tone: "warning", action: { label: "Reload", run: () => location.reload() } });
          return;
        }
        // Being deleted: another tab is clearing this computer (a tab that missed its message).
        if (blockedVersion === null) {
          close();
          void clearedElsewhere();
          return;
        }
        void saves.flushAll().finally(() => {
          close();
          editors.setReadOnly(true);
          notice.show("A newer version of ExecFlow was opened in another tab.", { tone: "warning", action: { label: "Reload", run: () => location.reload() } });
        });
      },
      onTerminated() {
        notice.show("The browser closed ExecFlow's storage (it may have been cleared). Reload to continue.", { action: { label: "Reload", run: () => location.reload() } });
      },
    });
    store = createWorkspaceStore(db, { canWrite: () => tab?.canWrite() ?? false });
    record = await store.ensureWorkspace(WORKSPACE_NAME);
  } catch (e) {
    root.dataset.state = "failed";
    // The empty workspace's layout (no head, no panel), which shows the centre column again.
    root.dataset.files = "none";
    L.emptyHost.replaceChildren(
      h(
        "div",
        { class: "empty-state", "data-empty": "storage" },
        h("h2", { class: "empty-title" }, "ExecFlow can't open its storage"),
        h("p", { class: "empty-lede" }, isVersionError(e) ? "A newer version of ExecFlow is open in another tab. Reload this page." : `This browser refused to keep files for this site (${errorText(e)}). A private window or blocked site data can cause this.`),
      ),
    );
    return;
  }
  const ws = record.id;
  tab = createTabCoordinator(ws, {
    readRev: async () => (await store.getWorkspace(ws))?.rev ?? null,
    flush: async () => void (await saves.flushAll()),
    onStolen: () => saves.drop(),
  });
  store.onChange(relayChanges(tab, ws));
  const canWrite = () => tab?.canWrite() ?? false;
  // Each file's command-line arguments, kept with the workspace's UI state (track R, batch 3).
  output.useArgs({ load: async () => (await store.getUiState(ws)).args ?? {}, save: (path, text) => store.setRunArgs(ws, path, text) });

  // ---------------------------------------------------------------- editor, tree, tabs
  const open: OpenFile[] = [];
  /** Files with error diagnostics: the tree and the tabs mark them. */
  let errorPaths = new Set<WsPath>();
  let seq = 0;
  const newId = () => `f${++seq}`;
  const fileOf = (id: FileId | null) => (id ? (open.find((f) => f.id === id) ?? null) : null);
  let previousActive: FileId | null = null;

  // The editor chunk loads the first time a file is opened (editors.ts): until then `editors` is a
  // stand-in with nothing open, and `manager` is null. Code that needs a file open uses `manager`.
  const idle = noEditor();
  let editors: Editors = idle;
  let manager: EditorManager | null = null;
  let loadingEditor: Promise<EditorManager> | null = null;
  /** The Flowchart view, a lazy chunk loaded when its tab or phone view first opens (see chartHost). */
  let chartView: FlowchartView | null = null;
  function loadEditor(): Promise<EditorManager> {
    loadingEditor ??= import("../editor/editor-manager").then(
      ({ EditorManager }) => {
        manager ??= new EditorManager({
          parent: L.editorHost,
          prefs: { lineWrapping: settings.get().lineWrapping, suggestOnTyping: settings.get().suggestOnTyping, enterAcceptsTop: settings.get().enterAcceptsTop },
          readOnly: idle.readOnly,
          // Read at each suggestion request: import and #include names, and the -std settings
          // that decide which library names fit.
          library: {
            files: textFiles,
            standards: () => ({ c: settings.get().cStd, cpp: settings.get().cxxStd }),
          },
          // Other files' names (included headers, imported modules), read when they are needed.
          readFile: (path) => store.readFile(ws, path),
          hooks: {
            onActiveChange(id) {
              if (previousActive && previousActive !== id) void saves.save(previousActive);
              previousActive = id;
              afterActiveChange();
            },
            onDirtyChange(id, dirty) {
              tabs.setDirty(id, dirty);
              // Phones have no tab strip: the top bar's file name says it too.
              if (id === editors.activeId) L.setCrumb(fileOf(id)?.path ?? null, dirty);
            },
            onDocChanged(id) {
              saves.schedule(id);
              sync.onLocalChange(); // the top bar shows the change at once, not after the autosave
              scheduleCheck(id);
              // An edit is the next step after a failed run: Run takes its filled style again.
              editedAfterRun();
              if (id === editors.activeId) chartView?.docChanged();
            },
            // Ln/Col in the editor's own update, not a frame of its own after the key (see showPosition).
            onSelectionChange: (_id, state) => {
              showPosition(state);
              chartView?.caretMoved();
            },
            onDiagnosticsChange: scheduleProblems,
            onRun: () => void run({ key: true }),
            onSave: () => void saveAndSync(),
          },
        });
        editors = manager;
        // How to leave the editor, read with it (WCAG 2.1.2: Tab indents here, so the way out is
        // said where it is needed, not only in the Shortcuts dialog). CodeMirror keeps attributes
        // it didn't set, so this one stays across files.
        manager.view?.contentDOM.setAttribute("aria-describedby", "editor-help");
        return manager;
      },
      (e: unknown) => {
        loadingEditor = null; // a later open tries again
        throw e;
      },
    );
    return loadingEditor;
  }
  // Every committed write in this tab (saves too) tells the editor's names index which stored
  // files changed; another tab's writes arrive through reloadFromStorage.
  store.onChange((e) => {
    if (e.ws === ws && e.paths.length && e.reason !== "sha" && e.reason !== "ui") manager?.indexChanged(e.paths);
  });
  // Heading for the files or the starters is a good sign a file opens next: fetch the editor then.
  // The first reason is kept on #app (data-editor-prefetch) for tests: the first-visit budget is the
  // shell alone, so a test can tell a hover or focus from a load that shouldn't have happened.
  const prefetchEditor = (e?: Event) => {
    root.dataset.editorPrefetch ??= e ? `${e.type} ${(e.target as Element | null)?.id || (e.currentTarget as Element | null)?.id || "?"}` : "restore";
    void loadEditor().catch(() => {});
  };
  for (const region of [L.sidebar, L.emptyHost]) {
    region.addEventListener("pointerover", prefetchEditor, { once: true });
    region.addEventListener("focusin", prefetchEditor, { once: true });
  }
  const focusEditor = () => manager?.host.focus();
  const tree = new FileTree(
    {
      open: (path, focus) => void openFile(path, { focus }),
      create: createEntry,
      rename: renameEntry,
      remove: (node) => void removeEntry(node),
      menu: (node, at) => openMenu(menuFor(node), at, { label: node ? `Actions for ${node.name}` : "File actions", returnFocus: (document.activeElement as HTMLElement) ?? L.treeHost }),
      expandedChanged: () => persistUi(),
    },
    "files-title",
  );
  L.treeHost.append(tree.element, tree.descriptions);
  // The empty space below the files: a click chooses nothing (New file then goes to the top level),
  // a right-click offers the top-level actions.
  L.treeHost.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[role=treeitem], .tree-new")) tree.clearSelection();
  });
  L.treeHost.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest("[role=treeitem], .tree-new")) return;
    e.preventDefault();
    tree.clearSelection();
    openMenu(menuFor(null), { x: e.clientX, y: e.clientY }, { label: "File actions", returnFocus: moreButton });
  });
  const tabs = new TabStrip(
    {
      activate: (id) => void activate(id),
      close: (id) => void closeFile(id),
      focusEditor,
    },
    "editor-panel",
  );
  L.tabHost.append(tabs.element);

  // Sidebar actions: New file, New folder, and a menu button for the rest.
  const newFileButton = h("button", { type: "button", class: "icon-btn", id: "new-file", "aria-label": "New file", title: "New file" }, icon("file-plus"));
  const newFolderButton = h("button", { type: "button", class: "icon-btn", id: "new-folder", "aria-label": "New folder", title: "New folder" }, icon("folder-plus"));
  const moreButton = h("button", { type: "button", class: "icon-btn", id: "file-actions", "aria-label": "More file actions", title: "More file actions" }, icon("dots-three"));
  L.sidebarActions.append(newFileButton, newFolderButton, moreButton);
  newFileButton.addEventListener("click", () => startCreate("file"));
  newFolderButton.addEventListener("click", () => startCreate("dir"));
  // Capture snippet (an image of the selected lines, .claude/design/snippet-image/final-v3.md): the
  // file menu's item, the editor head's button and the code menu share one entry. `narrow` asks the
  // window now: where focus goes at close follows the width the student sees, and the layout's own
  // query can lag a resize until the next frame (WebKit kept it wide, so focus went to the hidden list).
  const snippet = createSnippetCapture({
    root, notice, editors: () => editors, view: () => manager?.view ?? null, fileOf,
    narrow: () => matchMedia(NARROW).matches, closeDrawer: () => L.closeDrawer(), filesButton: L.drawerToggle, fileActions: moreButton,
  });
  // The editor context menu: a right-click on selected code (or Shift+F10 with code selected).
  attachCodeMenu(L.editorHost, {
    view: () => manager?.view ?? null, activeId: () => editors.activeId, capture: (opener) => snippet.open(opener, "context"),
    notice, explainReadOnly, canWrite, mac: isMac(), root,
  });
  L.snippetButton.addEventListener("click", (e) => {
    // The second click of a double click does nothing (the Run rule).
    if (e.detail > 1) return;
    snippet.open(L.snippetButton, e.detail > 0 ? "head-pointer" : "head-key");
  });
  // Grouped by separators: the file's own actions (open, run, close, share); new, rename, delete; import and export; Capture snippet; the file list's width.
  menuButton(moreButton, "File actions", () => [
    ...menuFor(tree.selectedNode()),
    { label: "Import files", icon: "upload-simple", separatorBefore: true, run: () => void importFrom(false, targetDir()) },
    { label: "Import a folder", icon: "folder-plus", run: () => void importFrom(true, targetDir()) },
    { label: "Export workspace (.zip)", icon: "download-simple", run: () => void exportWorkspace() },
    { label: "Choose files to download or share...", icon: "list-checks", run: () => void chooseFiles(moreButton) },
    { label: "Save as PDF...", icon: "printer", run: () => openPrint(moreButton) },
    ...snippet.menuItems(),
    ...widthItems(),
  ]);

  const targetDir = (): WsPath => {
    const node = tree.selectedNode();
    return node ? (node.kind === "dir" ? node.path : parentOf(node.path)) : "";
  };

  /** Why this tab can't write, in one sentence. */
  const readOnlyText = () => (tab?.reason === "no-locks" ? "This browser can't keep tabs in step, so this tab is read-only." : "This tab is read-only: the workspace is open for editing in another tab. Choose Edit here to edit in this tab.");
  function explainReadOnly(): boolean {
    if (canWrite()) return false;
    notice.show(readOnlyText(), { tone: "info" });
    return true;
  }

  function startCreate(kind: "file" | "dir", dir?: WsPath) {
    if (explainReadOnly()) return;
    if (!L.drawerOpen()) L.openDrawer();
    tree.startCreate(kind, dir);
  }

  function menuFor(node: TreeNode | null): MenuItem[] {
    const dir = node ? (node.kind === "dir" ? node.path : parentOf(node.path)) : "";
    const items: MenuItem[] = [];
    if (node?.kind === "file" && !node.opaque) {
      items.push({ label: "Open", icon: "file", run: () => void openFile(node.path, { focus: true }) });
      if (detectLanguage(node.path)) items.push({ label: "Run", icon: "play-fill", shortcut: isMac() ? "Cmd Enter" : "Ctrl Enter", run: () => void openFile(node.path, { focus: false }).then(() => run()) });
      // Closing without a keyboard, for screen readers on touch (the tab's own x is mouse-only).
      const openTab = open.find((f) => f.path === node.path);
      if (openTab) items.push({ label: "Close tab", icon: "x", shortcut: "Alt W", run: () => void closeFile(openTab.id) });
    }
    // Share link (.claude/design/batch5/share-link.md): any file, a read-only one too (the repository link works for it).
    if (node?.kind === "file") items.push({ label: "Share link...", icon: "link-simple", run: () => sync.share(node.path, focused()) });
    // Download (0.18.0): a file as itself, a folder as a .zip; a read-only GitHub file has no bytes here.
    if (node?.kind === "file" && !node.opaque) items.push({ label: "Download", icon: "download-simple", run: () => void downloadPaths([node.path]) });
    if (node?.kind === "dir") items.push({ label: "Download as .zip", icon: "download-simple", run: () => void downloadPaths([node.path]) });
    items.push(
      { label: "New file", icon: "file-plus", separatorBefore: true, run: () => startCreate("file", dir) },
      { label: "New folder", icon: "folder-plus", run: () => startCreate("dir", dir) },
      { label: "New from example...", icon: "code-simple", run: () => openExamples() },
    );
    if (node) {
      items.push(
        { label: "Rename", icon: "pencil-simple", shortcut: "F2", run: () => (explainReadOnly() ? undefined : tree.startRename(node.path)) },
        { label: "Delete", icon: "trash", shortcut: "Delete", danger: true, run: () => void removeEntry(node) },
      );
    }
    return items;
  }

  // ---------------------------------------------------------------- autosave
  /**
   * The text each open file was loaded with or last saved as: what its unsaved typing is based on.
   * Every save is a compare-and-set against it (storage saveFile `expect`), so text that reached
   * storage some other way (a sync pull, an import, a program's file, another tab) is never
   * overwritten unseen: both versions are kept instead (keepBoth).
   */
  const based = new Map<FileId, string>();
  /** Replaces a clean open file's text (a pull, an import) and records it as the new base. */
  function replaceText(id: FileId, text: string): boolean {
    if (!editors.replaceContent(id, text)) return false;
    based.set(id, text);
    return true;
  }
  /** Conflict copies keepBoth made, for the sync report to name (reloadFromStorage collects them). */
  const copiesMade = new Map<FileId, { path: WsPath; copy: WsPath }>();

  /**
   * The stored text changed under unsaved typing. Like a sync conflict: the stored version keeps the
   * name and the open tab shows it; the typing is saved as a conflict copy next to it.
   */
  async function keepBoth(id: FileId, path: WsPath): Promise<boolean> {
    let theirs: string;
    try {
      theirs = await store.readFile(ws, path);
    } catch (e) {
      notice.show(`${nameOf(path)} couldn't be saved: ${storageMessage(e)}`);
      return false;
    }
    // Typing pauses for the moment the copy is written, so nothing typed meanwhile is left out of it.
    editors.setReadOnly(true, id);
    try {
      const mine = editors.text(id) ?? "";
      const taken = new Set((await store.loadTree(ws)).map((e) => foldKey(e.path)));
      const copy = conflictName(path, new Date(), (p) => taken.has(foldKey(p)));
      await store.createFile(ws, copy, mine);
      const state = editors.state(id);
      if (state) editors.markSaved(id, state.doc);
      if (!replaceText(id, theirs)) based.set(id, theirs);
      copiesMade.set(id, { path, copy });
      await refreshTree();
      notice.show(`${nameOf(path)} changed outside the editor while you were typing. That version keeps the name; yours is saved as ${nameOf(copy)}.`, {
        tone: "warning",
        action: { label: `Open ${nameOf(copy)}`, run: () => void openFile(copy, { focus: true }) },
      });
      announcer.say(`${nameOf(path)} changed elsewhere. Your version is saved as ${nameOf(copy)}.`);
      return true;
    } catch (e) {
      notice.show(`${nameOf(path)} changed outside the editor while you were typing, and your version couldn't be saved as a copy (${storageMessage(e)}). It is still open here, unsaved.`);
      return false;
    } finally {
      editors.setReadOnly(false, id);
    }
  }

  const saves = (() => {
    const timers = new Map<FileId, ReturnType<typeof setTimeout>>();
    const chains = new Map<FileId, Promise<boolean>>();

    async function write(id: FileId, durability: "default" | "strict"): Promise<boolean> {
      if (!editors.has(id) || !editors.isDirty(id)) return true;
      // A tab without the writer lock never writes (storage refuses too).
      if (!canWrite()) return false;
      const path = editors.path(id)!;
      const doc = editors.state(id)!.doc;
      const text = doc.toString();
      try {
        await store.saveFile(ws, path, text, { durability, expect: based.get(id) });
        based.set(id, text);
        editors.markSaved(id, doc);
        sync.onLocalChange();
        scheduleSyncCount();
        return true;
      } catch (e) {
        if (e instanceof StorageError && e.code === "changed") return keepBoth(id, path);
        notice.show(`${nameOf(path)} couldn't be saved: ${errorText(e)}`);
        return false;
      }
    }

    function save(id: FileId, durability: "default" | "strict" = "default"): Promise<boolean> {
      clearTimeout(timers.get(id));
      timers.delete(id);
      const next = (chains.get(id) ?? Promise.resolve(true)).then(() => write(id, durability));
      chains.set(id, next);
      void next.finally(() => {
        if (chains.get(id) === next) chains.delete(id);
      });
      return next;
    }

    return {
      schedule(id: FileId) {
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => void save(id), AUTOSAVE_MS));
      },
      save,
      /** Saves every unsaved file now; resolves true if all of them were saved. */
      async flushAll(durability: "default" | "strict" = "default"): Promise<boolean> {
        const ids = new Set([...timers.keys(), ...chains.keys(), ...open.map((f) => f.id).filter((id) => editors.isDirty(id))]);
        const results = await Promise.all([...ids].map((id) => save(id, durability)));
        return results.every(Boolean);
      },
      /** The lock was taken without a handover: pending saves would race the new writer. */
      drop() {
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
      },
    };
  })();
  // The last save can't be relied on while the page goes away: also stash unsaved typing
  // synchronously (recover.ts), and use the stash on the next start (recoverTyping).
  function stashTyping() {
    if (!canWrite()) return;
    const dirty = open.filter((f) => editors.isDirty(f.id) && based.has(f.id));
    writeStash(ws, dirty.map((f) => ({ path: f.path, base: textHash(based.get(f.id)!), text: editors.text(f.id) ?? "" })));
  }
  addEventListener("pagehide", () => {
    stashTyping();
    void saves.flushAll();
  });
  addEventListener("beforeunload", stashTyping);
  // Only the writer stashes, so only the writer drops: closing the writer brings a read-only tab of
  // the same workspace into view, and that tab must leave the writer's stash for Edit here to use.
  addEventListener("pageshow", (e) => {
    if (e.persisted && canWrite()) dropStash(ws);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stashTyping();
      void saves.flushAll();
    } else if (started && canWrite()) {
      // Still here: the saves started on hide carry the text.
      dropStash(ws);
    }
  });
  addEventListener("blur", () => void saves.flushAll());
  L.editorHost.addEventListener("focusout", () => {
    const id = editors.activeId;
    if (id) void saves.save(id);
  });

  async function saveAndSync() {
    const ok = await saves.flushAll("strict");
    if (!canWrite()) return void explainReadOnly();
    if (ok) await sync.syncNow();
  }

  // ---------------------------------------------------------------- tree data and UI state
  let entries: EntryMeta[] = [];
  /** Set once another tab clears this computer (clearedElsewhere): nothing opens or loads after it. */
  let wiped: Promise<void> | null = null;
  let uiQueued = false;
  /** The workspace's text files, one array per tree read (the editor caches by it). */
  let textFileList: { from: EntryMeta[]; paths: WsPath[] } | null = null;
  function textFiles(): WsPath[] {
    if (textFileList?.from !== entries) textFileList = { from: entries, paths: entries.filter((e) => e.kind === "file" && !e.opaque).map((e) => e.path) };
    return textFileList.paths;
  }

  async function refreshTree() {
    entries = await store.loadTree(ws);
    tree.setEntries(entries);
    renderEmpty();
    // New, renamed, deleted and imported files change the unsynced count too.
    scheduleSyncCount();
  }

  /** Keeps which files are open (and which folders) at once: a reload right after must find them. */
  function persistUi() {
    if (uiQueued) return;
    uiQueued = true;
    queueMicrotask(() => {
      uiQueued = false;
      if (!canWrite()) return;
      const ui: UiState = {
        openTabs: open.map((f) => f.path),
        activePath: fileOf(editors.activeId)?.path ?? null,
        expanded: tree.expandedPaths(),
      };
      void store.setUiState(ws, ui).catch(() => {});
    });
  }

  // ---------------------------------------------------------------- opening, switching, closing
  const opening = new Map<WsPath, Promise<OpenFile | null>>();

  function openFile(path: WsPath, options: { focus?: boolean; activate?: boolean } = {}): Promise<OpenFile | null> {
    const pending = opening.get(path);
    if (pending) return pending;
    // Opening can wait for storage and, the first time, for the editor to download. If the user
    // has moved on meanwhile (into a menu, a dialog or a text field), the file opens without
    // taking focus. (The tree redraws its items while a file opens, so "the same element" can't
    // be the test.)
    const focusedAtStart = document.activeElement;
    const focusStayed = () => {
      const now = document.activeElement;
      return now === focusedAtStart || !(now instanceof Element) || (!now.closest(".menu, dialog[open]") && !isTyping(now));
    };
    const job = (async () => {
      const entry = entries.find((e) => e.path === path) ?? (await store.getEntry(ws, path));
      if (!entry || entry.kind !== "file") return null;
      if (entry.opaque) {
        notice.show(`${nameOf(path)} is read-only (binary or special file), so it can't be shown here. It stays in the repository as it is.`, { tone: "info" });
        return null;
      }
      let file = open.find((f) => f.path === path);
      if (!file) {
        file = { id: newId(), path };
        const at = open.findIndex((f) => f.id === editors.activeId);
        open.splice(at < 0 ? open.length : at + 1, 0, file);
      }
      if (options.activate !== false) await activate(file.id);
      if (options.focus && focusStayed()) {
        if (L.narrow()) {
          L.closeDrawer(false);
          L.showView("code");
        }
        focusEditor();
      }
      return file;
    })().finally(() => opening.delete(path));
    opening.set(path, job);
    return job;
  }

  /** Shows an open file, loading its text again if the editor dropped it to save memory. */
  async function activate(id: FileId) {
    const file = fileOf(id);
    if (!file) return;
    const drop = (message: string) => {
      notice.show(message);
      if (open.includes(file)) open.splice(open.indexOf(file), 1);
      renderTabs();
    };
    let ed: EditorManager;
    try {
      ed = await loadEditor();
    } catch {
      return drop(`The editor couldn't load, so ${nameOf(file.path)} can't be shown. Check the connection, then open it again.`);
    }
    if (!ed.has(id)) {
      let text: string;
      try {
        text = await store.readFile(ws, file.path);
      } catch (e) {
        return drop(`${nameOf(file.path)} couldn't be opened: ${errorText(e)}`);
      }
      if (!ed.has(id)) {
        ed.open(id, file.path, text, { activate: true });
        based.set(id, text);
      } else ed.activate(id);
    } else {
      ed.activate(id);
    }
    renderTabs();
    persistUi();
  }

  async function closeFile(id: FileId) {
    const file = fileOf(id);
    if (!file) return;
    const index = open.indexOf(file);
    const neighbour = open[index + 1] ?? open[index - 1] ?? null;
    // Files autosave, so a tab is never unsaved for long: save now, then close.
    const saved = await saves.save(id);
    if (!editors.close(id, { next: neighbour && editors.has(neighbour.id) ? neighbour.id : null }).closed) {
      const ok = await confirmDialog({
        title: `Close ${nameOf(file.path)} without saving?`,
        body: [saved ? "It has changes that weren't saved yet." : "Its latest changes couldn't be saved. Closing it loses them."],
        confirm: "Close without saving",
        danger: true,
      });
      if (!ok) return;
      editors.close(id, { force: true, next: null });
    }
    based.delete(id);
    open.splice(open.indexOf(file), 1);
    if (editors.activeId === null && neighbour && open.includes(neighbour)) await activate(neighbour.id);
    renderTabs();
    persistUi();
    afterActiveChange();
  }

  /** The failed run's first error, for the editor head's error jump (renderJump). */
  let runError: Problem | null = null;
  /** Its exception class as the tool reported it (liftError's head). */
  let runErrorCode: string | undefined;
  /**
   * The last finished run's file, and whether that run failed and nothing was edited since (decision
   * 1, limited by the owner on 2026-10-24 to the file that failed): see renderLastRun.
   */
  let lastRun: { path: WsPath; failed: boolean } | null = null;

  /**
   * The failed run's error follows its file: renamed, the jump and the lifted exception name the new
   * path (and open it); deleted, both go (review B, 2026-10-18: they kept the old name and a click
   * did nothing).
   */
  function followError(from: WsPath, to: WsPath | null) {
    // The last run's file is followed too: renamed, the header names it and Run still steps back
    // there; deleted, the header keeps its old name and Run steps back nowhere.
    if (lastRun?.path === from && to !== null) {
      lastRun = { ...lastRun, path: to };
      renderLastRun();
    }
    if (!runError || runError.path !== from) return;
    runError = to === null ? null : { ...runError, path: to };
    renderJump();
    output.relift(runError ? liftError(runError, runErrorCode) : null);
  }

  function renderTabs() {
    tabs.set(open.map((f) => ({ id: f.id, path: f.path, dirty: editors.isDirty(f.id), readOnly: false, errors: errorPaths.has(f.path) })), editors.activeId);
    const active = editors.activeId;
    if (active && open.length) {
      L.editorPanel.setAttribute("role", "tabpanel");
      L.editorPanel.setAttribute("aria-labelledby", `tab-${active}`);
    } else {
      L.editorPanel.removeAttribute("role");
      L.editorPanel.removeAttribute("aria-labelledby");
    }
    L.setCrumb(fileOf(active)?.path ?? null, active !== null && editors.isDirty(active));
    // Below 900 px there is no tab strip: the drawer's tree marks the files open in a tab.
    tree.setOpenFiles(L.narrow() ? new Set(open.map((f) => f.path)) : new Set());
    renderJump();
  }
  L.onNarrowChange(() => renderTabs());

  /** While start-up reopens the files left open last time: the one it shows first (see start). */
  let restoring: WsPath | null = null;
  /** The file start-up is reopening, while it exists and nothing is open yet. */
  const reopening = () =>
    restoring !== null && editors.activeId === null && entries.some((e) => e.path === restoring && e.kind === "file" && !e.opaque) ? restoring : null;

  /**
   * The layout's state, read by app.css. data-open: the editor head and Run show, because a file is
   * open, start-up is reopening one, or a program is still running or waiting (its Stop, its output
   * and its input field stay even after its file is closed or deleted: review B, 2026-10-18).
   * data-files="none": the empty workspace's layout (no panel and no view switch, the starters
   * lead), only with no files and nothing running. data-restoring: Run keeps its place, unseen,
   * until the reopened file can run.
   */
  function renderShell() {
    const running = root.dataset.run === "running" || root.dataset.run === "waiting";
    const back = reopening() !== null;
    const open = editors.activeId !== null || back || running;
    root.dataset.open = String(open);
    root.dataset.files = tree.isEmpty && !running ? "none" : "some";
    // Nothing open: Run is shown disabled, still a Tab stop that says why (Workbench Pro, item 7).
    if (open) {
      L.runButton.removeAttribute("aria-disabled");
      L.runButton.removeAttribute("aria-describedby");
    } else {
      L.runButton.setAttribute("aria-disabled", "true");
      L.runButton.setAttribute("aria-describedby", "run-why");
    }
    root.toggleAttribute("data-restoring", back);
    if (root.dataset.files === "none" && L.view() !== "code") L.showView("code");
  }

  function renderEmpty() {
    const none = editors.activeId === null;
    L.editorPanel.dataset.empty = String(none);
    L.editorHost.inert = none;
    renderShell();
    if (!none) return L.emptyHost.replaceChildren();
    const back = reopening();
    L.emptyHost.replaceChildren(
      back
        ? openingFile(nameOf(back))
        : tree.isEmpty
          ? emptyWorkspace(
              {
                newFile: () => startCreate("file"),
                create: (lang) => void createStarter(lang),
                importFiles: () => void importFrom(false, ""),
                importFolder: () => void importFrom(true, ""),
                connect: () => sync.connect(),
                examples: (opener) => openExamples(opener),
              },
              false,
            )
          : noFileOpen(),
    );
  }

  function afterActiveChange() {
    const file = fileOf(editors.activeId);
    tree.setActive(file?.path ?? null);
    output.showArgsFor(file?.path ?? null);
    renderTabs();
    renderEmpty();
    const lang = file ? detectLanguage(file.path)?.id ?? null : null;
    runtimes.prepare(lang);
    if (lang === "python" && file) scheduleCheck(file.id);
    renderStatus();
    renderLastRun();
    schedulePosition();
    chartView?.fileChanged();
  }

  // ---------------------------------------------------------------- creating, renaming, deleting
  function storageMessage(e: unknown): string {
    return e instanceof StorageError ? e.message : errorText(e);
  }

  async function createEntry(kind: "file" | "dir", path: WsPath): Promise<string | null> {
    if (explainReadOnly()) return "This tab is read-only.";
    try {
      if (kind === "file") await store.createFile(ws, path, starterText(path, entries.filter((e) => e.kind === "file").map((e) => e.path)));
      else await store.createDir(ws, path);
    } catch (e) {
      return storageMessage(e);
    }
    await refreshTree();
    if (kind === "file") await openFile(path, { focus: true });
    else tree.reveal(path);
    return null;
  }

  async function createStarter(lang: LanguageId) {
    if (explainReadOnly()) return;
    const language = LANGUAGES.find((l) => l.id === lang)!;
    const path = language.defaultFilename;
    try {
      if (!entries.some((e) => foldKey(e.path) === foldKey(path))) await store.createFile(ws, path, language.sample);
    } catch (e) {
      return notice.show(storageMessage(e));
    }
    await refreshTree();
    await openFile(path, { focus: true });
    announcer.say(`Created ${path}. Press ${isMac() ? "Command" : "Control"} Enter to run it.`);
  }

  async function renameEntry(from: WsPath, to: WsPath): Promise<string | null> {
    if (explainReadOnly()) return "This tab is read-only.";
    await saves.flushAll();
    let moved: { from: WsPath; to: WsPath }[];
    try {
      moved = await store.renamePath(ws, from, to);
    } catch (e) {
      return storageMessage(e);
    }
    for (const m of moved) {
      const file = open.find((f) => f.path === m.from);
      if (file) {
        file.path = m.to;
        if (editors.has(file.id)) editors.rename(file.id, m.to);
      } else {
        editors.movePending(m.from, m.to);
      }
      recordMove(m.from, m.to);
      followError(m.from, m.to);
    }
    tree.moved(from, to);
    await refreshTree();
    renderTabs();
    renderStatus();
    persistUi();
    tree.reveal(to);
    return null;
  }

  async function removeEntry(node: TreeNode) {
    if (explainReadOnly()) return;
    const inside = node.kind === "dir" ? entries.filter((e) => e.kind === "file" && isInside(e.path, node.path)).length : 0;
    const body = [
      node.kind === "dir"
        ? inside
          ? `The folder and the ${plural(inside, "file")} in it are deleted from this computer.`
          : "The empty folder is deleted from this computer."
        : `${node.name} is deleted from this computer.`,
    ];
    if (node.opaque && sync.connected()) body.push("It came from GitHub as a read-only file, so the next sync brings it back. Delete it on GitHub to remove it for good.");
    else if (sync.connected()) body.push("The next sync deletes it from the GitHub repository too (its history keeps old versions).");
    const ok = await confirmDialog({ title: `Delete ${node.name}?`, body, confirm: "Delete", danger: true });
    if (!ok) return;
    await saves.flushAll();
    let deleted: WsPath[];
    try {
      deleted = await store.deletePath(ws, node.path);
    } catch (e) {
      return notice.show(storageMessage(e));
    }
    for (const path of deleted) {
      const file = open.find((f) => f.path === path);
      if (file) {
        editors.close(file.id, { force: true, next: null });
        based.delete(file.id);
        open.splice(open.indexOf(file), 1);
      } else {
        editors.movePending(path, null);
      }
      recordMove(path, null);
      followError(path, null);
    }
    if (editors.activeId === null && open.length) await activate(open[open.length - 1].id);
    await refreshTree();
    renderTabs();
    afterActiveChange();
    persistUi();
    announcer.say(`Deleted ${node.name}.`);
    tree.focus();
  }

  // ---------------------------------------------------------------- import and export
  async function importFrom(folder: boolean, dir: WsPath) {
    if (explainReadOnly()) return;
    const target = (name: string) => (dir ? `${dir}/${name}` : name);
    let existing = new Map((await store.loadTree(ws)).map((e) => [foldKey(e.path), e]));
    const stats = await store.workspaceStats(ws).catch(() => null);
    const budget = stats && {
      files: stats.limits.maxFiles - stats.files,
      bytes: stats.limits.maxBytes - stats.bytes,
      isNew: (name: string) => existing.get(foldKey(target(name)))?.kind !== "file",
    };
    const picked = await pickFiles(folder, budget ?? undefined);
    if (!picked) return;
    existing = new Map((await store.loadTree(ws)).map((e) => [foldKey(e.path), e]));
    const targets = picked.files.map((f) => target(f.name));
    const clashes = targets.filter((p) => existing.get(foldKey(p))?.kind === "file");
    const clashKeys = new Set(clashes.map(foldKey));
    let replace = false;
    if (clashes.length) {
      replace = await confirmDialog({
        title: `Replace ${plural(clashes.length, "file")}?`,
        body: [`${listNames(clashes.map(nameOf))} already ${clashes.length === 1 ? "exists" : "exist"} here. Replace ${clashes.length === 1 ? "it" : "them"} with the imported ${clashes.length === 1 ? "copy" : "copies"}? This can't be undone.`],
        confirm: "Replace",
        cancel: "Keep mine",
        danger: true,
      });
    }
    let result;
    try {
      result = await store.importFiles(ws, dir, picked.files, { replace });
    } catch (e) {
      return notice.show(storageMessage(e));
    }
    // Replaced files that are open take the imported text.
    for (const path of result.replaced) {
      const file = open.find((f) => f.path === path);
      if (file && editors.has(file.id)) replaceText(file.id, await store.readFile(ws, path));
    }
    await refreshTree();
    // Files the user chose to keep aren't "left out" news.
    const refused = [...picked.skipped, ...result.refused.filter((r) => replace || !r.path || !clashKeys.has(foldKey(r.path)))];
    const summary = describeImport({ added: result.added.length + result.replaced.length, refused, hidden: result.hidden.map((x) => x.path) });
    const opener = moreButton;
    notice.show(summary.text, { tone: summary.tone, action: summary.folded ? { label: "Show all", run: () => showRefusals(refused, opener) } : undefined });
    const first = result.added[0] ?? result.replaced[0];
    if (first) {
      tree.reveal(first);
      if (detectLanguage(first)) await openFile(first);
    }
  }

  /** Downloads a file as itself, or a folder or several picks as a .zip (0.18.0). */
  async function downloadPaths(picks: readonly WsPath[], shown?: ReadonlySet<string>) {
    await saves.flushAll();
    try {
      const { count, skipped, name, zip } = await downloadPicked(store, ws, picks, record.name, shown);
      const leftOut = skipped.length ? ` Left out ${listNames(skipped.map(nameOf))}: read-only files from GitHub are only stored there.` : "";
      if (!count) notice.show(skipped.length ? `Nothing to download.${leftOut}` : "Nothing to download: there are no files in it.", { tone: "info" });
      else notice.show(`Saved ${zip ? `${plural(count, "file")} as ${name}` : name}.${leftOut}`, { tone: "success" });
    } catch (e) {
      notice.show(`The download didn't work: ${errorText(e)}`);
    }
  }

  /** "Choose files to download or share..." (choose-files-dialog.ts, a lazy chunk). */
  let chooseChunk: Promise<typeof import("./choose-files-dialog")> | null = null;
  async function chooseFiles(opener: HTMLElement | null) {
    await saves.flushAll();
    try {
      const m = await (chooseChunk ??= import("./choose-files-dialog").catch((e: unknown) => {
        chooseChunk = null;
        throw e;
      }));
      await m.openChooseFiles({
        files: () => store.loadRunFiles(ws, ""),
        readOnly: entries.filter((e) => e.kind === "file" && e.opaque).map((e) => e.path),
        initial: tree.selectedNode()?.path ?? null,
        workspace: record.name,
        download: (picks, shown) => downloadPaths(picks, shown),
        origin: location.origin,
      }, opener);
    } catch (e) {
      notice.show(`Choose files couldn't open: ${errorText(e)}`);
    }
  }

  async function exportWorkspace() {
    await saves.flushAll();
    try {
      const { count, skipped } = await exportZip(store, ws, record.name);
      notice.show(`Saved ${plural(count, "file")} as a .zip.${skipped.length ? ` Left out ${listNames(skipped.map(nameOf))}: read-only files from GitHub are only stored there.` : ""}`, { tone: "success" });
    } catch (e) {
      notice.show(`The export didn't work: ${errorText(e)}`);
    }
  }

  // ---------------------------------------------------------------- error help (a lazy chunk)
  let helpChunk: Promise<RenderHelp> | null = null;
  let renderHelp: RenderHelp | null = null;
  let renderLimit: typeof import("./error-help-view").renderLimitHelp | null = null;
  /**
   * The plain-language error help (error-help-view.ts and its table), loaded once a run starts or
   * a problem is listed. It only adds words under an error: if it can't load, the errors show as
   * before, and the next run or problem tries again.
   */
  function loadHelp(): Promise<RenderHelp> {
    helpChunk ??= import("./error-help-view").then(
      (m) => {
        renderLimit = m.renderLimitHelp;
        return (renderHelp = m.renderHelp);
      },
      (e: unknown) => {
        helpChunk = null;
        throw e;
      },
    );
    return helpChunk;
  }
  /** Counts runs, so help that arrives late is never added to a newer run's header. */
  let runSerial = 0;
  function showRunHelp(d: ToolDiagnostic | undefined) {
    if (!d) return;
    const serial = runSerial;
    const show = (render: RenderHelp) => {
      if (serial === runSerial) output.setHelp(render(d, "run-help"));
    };
    if (renderHelp) show(renderHelp);
    else loadHelp().then(show, () => {});
  }

  // ---------------------------------------------------------------- problems and the Python check
  let problemsFrame = 0;
  function scheduleProblems() {
    problemsFrame ||= requestAnimationFrame(() => {
      problemsFrame = 0;
      const list = editors.problems();
      problemsView.set(list);
      if (problemsView.wantsHelp) loadHelp().then((render) => problemsView.useHelp(render), () => {});
      const withErrors = new Set(list.filter((p) => p.severity === "error" && p.path).map((p) => p.path!));
      if (withErrors.size !== errorPaths.size || [...withErrors].some((p) => !errorPaths.has(p))) {
        errorPaths = withErrors;
        tree.setErrors(errorPaths);
        renderTabs();
      }
      const counts = countProblems(list);
      for (const [tab, count] of [[L.panelTabs.problems, L.panelTabs.count], [L.viewTabs.problems, L.viewTabs.count]] as const) {
        count.textContent = counts.total ? String(counts.total) : "";
        count.dataset.count = String(counts.total);
        count.dataset.errors = String(counts.errors);
        tab.setAttribute("aria-label", counts.total ? `Problems, ${describeCounts(counts)}` : "Problems");
      }
      // The collapsed panel opens for the first problem of the session (as it does for every run).
      if (counts.total && !problemsSeen) {
        problemsSeen = true;
        L.expandPanel();
      }
      // The error jump and the lifted exception go with their error (deleted, or no longer in the
      // build's results), so the header never names a place Problems no longer has.
      if (runError && !list.some((p) => p.channel === "build" && p.severity === "error" && p.path === runError!.path)) {
        runError = null;
        renderJump();
        output.relift(null);
      }
    });
  }
  let problemsSeen = false;
  problemsView.onOpen = (p) => void revealProblem(p);

  async function revealProblem(p: Problem) {
    if (!p.path) return;
    const file = await openFile(p.path, { focus: false });
    if (!file || !editors.has(file.id)) return;
    if (L.narrow()) L.showView("code");
    const rows = editors.problems().filter((q) => q.id === file.id && q.line === p.line);
    const match = rows.find((q) => q.message === p.message) ?? rows[0];
    if (match?.from !== undefined) editors.reveal(file.id, match.from, match.to);
    else {
      const doc = editors.state(file.id)!.doc;
      editors.reveal(file.id, doc.line(Math.min(Math.max(1, p.line), doc.lines)).from);
    }
  }

  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleCheck(id: FileId) {
    const path = editors.path(id);
    if (!path || detectLanguage(path)?.id !== "python") return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void runCheck(id), CHECK_MS);
  }
  async function runCheck(id: FileId) {
    const ed = manager;
    if (!ed?.has(id) || runtimes.state("python") !== "ready") return;
    const ticket = ed.beginBuild([id], { channel: "check" });
    const source = ticket.sources[0];
    if (!source) return ed.cancelBuild(ticket);
    const found = await runtimes.check(source.path, source.text);
    if (found === null) ed.cancelBuild(ticket);
    else ed.endBuild(ticket, found);
  }

  // ---------------------------------------------------------------- running
  function setRunning(state: "idle" | "running" | "waiting") {
    root.dataset.run = state;
    const running = state !== "idle";
    L.runButton.dataset.running = String(running);
    L.runLabel.textContent = running ? "Stop" : "Run";
    // The shortcut is in the tooltip and aria-keyshortcuts, not drawn inside the button.
    L.runButton.title = running ? `Stop (${isMac() ? "Cmd" : "Ctrl"}+.)` : `Run (${isMac() ? "Cmd" : "Ctrl"}+Enter)`;
    L.runButton.setAttribute("aria-keyshortcuts", `${ariaMod()}+${running ? "Period" : "Enter"}`);
    L.runButton.querySelector(".run-icon")!.replaceChildren(icon(running ? "stop-fill" : "play-fill"));
    L.panelActions.querySelector<HTMLButtonElement>("#restart-python")!.disabled = running;
    // A run in progress keeps Stop and the panel on screen, even with no file open.
    renderShell();
    renderStatus();
  }

  /**
   * After a failed run Run steps back to the secondary (outline) style until the next edit or run:
   * the next step is a fix, not a re-run. It stays enabled, with its label, id and shortcut. Only
   * while the file that failed is open (owner, 2026-10-24): any other file's Run is its own,
   * filled. And while another file is open the run-log header says whose run it shows ("Last run:
   * util.c"), so a never-run file doesn't seem to have failed (B11).
   */
  function renderLastRun() {
    const active = fileOf(editors.activeId)?.path ?? null;
    if (lastRun?.failed && lastRun.path === active) root.dataset.lastRun = "failed";
    else delete root.dataset.lastRun;
    const running = root.dataset.run === "running" || root.dataset.run === "waiting";
    // The name, or the path when the open file has the same name (lab1/util.c is not lab2/util.c).
    const owner = active !== null && lastRun && lastRun.path !== active && nameOf(lastRun.path) === nameOf(active) ? lastRun.path : nameOf(lastRun?.path ?? "");
    if (lastRun && !running) output.showRunOwner(owner, lastRun.path !== active);
  }

  /** An edit after a failed run (in any file: the fix may be in a file the program uses). Cheap per key. */
  function editedAfterRun() {
    if (!lastRun?.failed) return;
    lastRun = { ...lastRun, failed: false };
    renderLastRun();
  }

  /**
   * "Error in calc.py, line 2" in the editor head while the failed run's first error is in a file
   * other than the active one; it opens that line the way its Problems row does.
   */
  function renderJump() {
    const show = runError !== null && runError.path !== null && fileOf(editors.activeId)?.path !== runError.path;
    L.errorJump.hidden = !show;
    if (!show || !runError?.path) return;
    L.errorJumpWords.textContent = `Error in ${nameOf(runError.path)}, line ${runError.line}`;
    L.errorJump.title = runError.message.split("\n")[0];
  }
  L.errorJump.addEventListener("click", () => {
    if (runError) void revealProblem(runError);
  });

  /**
   * The header's lifted exception: "ZeroDivisionError" (the exception class, or "Error" for a
   * compiler error) at 600, the rest of the message, then "calc.py, line 2"; it opens that line.
   */
  function liftError(p: Problem, code: string | undefined): LiftedError {
    const message = p.message.split("\n")[0];
    const head = code && message.startsWith(code) ? code : "Error";
    return {
      head,
      rest: message.startsWith(head) ? message.slice(head.length) : `: ${message}`,
      where: `${nameOf(p.path ?? "")}, line ${p.line}`,
      open: () => void revealProblem(p),
    };
  }

  /**
   * When Run was pressed for the run in progress (0: none). It is set at once, before saving and
   * reading the files, so a second press of the same gesture (a double-click, Ctrl+Enter twice)
   * can't start a second run that wipes the first one's output; the runtime itself is busy only
   * once the program starts.
   */
  let runPressed = 0;
  /** Stop was pressed while the run was still starting: it ends before the program runs. */
  let stopAsked = false;
  /** Files renamed (to) or deleted (null) while a program runs: its diagnostics follow them. */
  let runMoves: Map<WsPath, WsPath | null> | null = null;
  const SAME_GESTURE_MS = 400;

  function recordMove(from: WsPath, to: WsPath | null) {
    // A file's arguments follow its rename and go with its delete (as they do in storage).
    output.argsMoved(from, to);
    // The file Run waited for is gone from its path: the waiting press goes with it.
    if (runAfterPack && (runAfterPack.path === from || runAfterPack.path.startsWith(from + "/"))) dropPackRun();
    if (!runMoves) return;
    for (const [k, v] of runMoves) if (v === from) runMoves.set(k, to);
    runMoves.set(from, to);
  }

  function stopRun() {
    if (!runPressed) return;
    if (runtimes.running) runtimes.stop();
    else stopAsked = true;
  }

  /**
   * Run, or Stop while a program runs. `repeat`: the second click of a double-click (the browser
   * decides what a double-click is), or a held key repeating. `key`: Ctrl+Enter, which has the
   * Stop key Ctrl+. beside it, so a second Ctrl+Enter right after the first is a double press.
   */
  async function run(how: { repeat?: boolean; key?: boolean } = {}) {
    if (runPressed) {
      // The rest of the gesture that started the run: ignore it. (A plain click on Stop always stops.)
      if (how.repeat || (how.key && performance.now() - runPressed < SAME_GESTURE_MS)) return;
      return stopRun();
    }
    runPressed = performance.now();
    stopAsked = false;
    // The last build's "Run main.c" offer goes at once: pressed while this run starts, it would be Stop.
    output.offerMain(null);
    // A new run: Run takes its filled style again, and the last run's error jump goes.
    if (lastRun) lastRun = { ...lastRun, failed: false };
    runError = null;
    renderJump();
    setRunning("running");
    renderLastRun();
    try {
      await runProgram();
    } finally {
      runPressed = 0;
      stopAsked = false;
      runMoves = null;
      setRunning("idle");
      renderLastRun();
    }
  }

  /** The finished run's file (where it is now, if it moved meanwhile), and whether the run failed. */
  function finishedRun(path: WsPath, failed: boolean, moves: Map<WsPath, WsPath | null>) {
    lastRun = { path: moves.get(path) ?? path, failed };
  }

  /**
   * Run was pressed for this C or C++ file before the one-time download was in: it runs once the
   * download finishes, if it is still the open file and nothing else runs (B10, 2026-10-24). Run,
   * Download, done: two presses instead of Run, Download, Run again.
   */
  // Keyed by the open file's editor id too: a file renamed, deleted, or replaced at the same path
  // (a sync, delete and create) is not the file Run was pressed for.
  let runAfterPack: { path: WsPath; id: FileId } | null = null;
  const PACK_NOTICE = "C and C++ need a one-time download first. The button is in the Output panel.";
  /** The pack notice this code showed (by its exact words, never a part a file name could carry). */
  let packNotice: string | null = null;
  function showPackNotice(text: string) {
    packNotice = text;
    notice.show(text, { tone: "info" });
  }
  /** The notice above, cleared once its button has been used (only if it is still the one shown). */
  function clearPackNotice() {
    if (packNotice !== null && notice.text === shown(packNotice)) notice.clear();
    packNotice = null;
  }
  /** The press that waited for the download is dropped: nothing on screen may still promise it. */
  function dropPackRun() {
    runAfterPack = null;
    clearPackNotice();
    renderPack();
  }
  /** Whether a download was running at the last change: one that falls back to absent has failed. */
  let packWasDownloading = false;
  function runIfPackArrived() {
    const cpp = runtimes.cppRunner;
    if (!cpp || cpp.state === "checking") return;
    if (cpp.state === "downloading") {
      packWasDownloading = true;
      return;
    }
    const failed = packWasDownloading && cpp.state === "absent";
    packWasDownloading = false;
    if (cpp.state === "absent") {
      // A failed download ends the wait: a much later download must not run an old press.
      if (failed && runAfterPack) dropPackRun();
      return;
    }
    clearPackNotice();
    const queued = runAfterPack;
    runAfterPack = null;
    const open = fileOf(editors.activeId);
    if (queued === null || runPressed || cpp.state === "failed" || open?.path !== queued.path || open.id !== queued.id) return;
    void run();
  }

  /** "Run lab1/main.c" from a failed build of a file without main(): opens that file and runs it. */
  async function runOffered(path: WsPath) {
    // A run already starting or running: the offer is stale (Run removes it), never a Stop.
    if (runPressed) return;
    const file = await openFile(path, { focus: true });
    if (file && fileOf(editors.activeId)?.path === path) await run();
  }

  /** The help for a run stopped at its time or output limit (a lazy chunk, as the error help is). */
  function showLimitHelp(status: RunStatus, limits: { seconds: number; chars: number }) {
    const serial = runSerial;
    const show = () => {
      if (serial === runSerial && renderLimit) output.setHelp(renderLimit(status, limits, "run-help"));
    };
    if (renderLimit) show();
    else loadHelp().then(show, () => {});
  }

  async function runProgram() {
    const file = fileOf(editors.activeId);
    const ed = manager;
    if (!file || !ed) return notice.show("Open a Python, C or C++ file first, then run it.", { tone: "info" });
    const lang = detectLanguage(file.path)?.id;
    if (!lang) {
      return notice.show(
        isHeader(file.path)
          ? `${nameOf(file.path)} is a header: run the .c or .cpp file that includes it.`
          : `${nameOf(file.path)} isn't a Python, C or C++ file, so it can't run. Files ending .py, .c or .cpp do.`,
        { tone: "info" },
      );
    }
    if (runtimeOf(lang) === "cpp") {
      const cpp = (await runtimes.loadCpp()).runner;
      if (cpp.state === "checking") {
        // The compiler worker answers "is the pack installed?" within moments of starting.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 10_000);
          const off = cpp.subscribe((s) => {
            if (s !== "checking") done();
          });
          function done() {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      }
      if (cpp.state === "absent") {
        runAfterPack = { path: file.path, id: file.id };
        renderPack();
        L.showPanelTab("output");
        if (L.narrow()) L.showView("output");
        showPackNotice(PACK_NOTICE);
        output.focusPackButton();
        return;
      }
      if (cpp.state === "downloading") {
        runAfterPack = { path: file.path, id: file.id };
        renderPack();
        return showPackNotice(`The C/C++ download is still running. ${nameOf(file.path)} runs as soon as it finishes.`);
      }
    }
    // Arguments that can't be split (an unclosed quote, over a limit): the field explains, and
    // nothing runs. Focus moves there and reads the message; if it was there already, it is said.
    // The field is a lazy chunk: if it can't load, Run says so and runs nothing (the arguments are unknown).
    const args = await output.argsFor(file.path).catch((e: unknown) => e as Error);
    if (args instanceof Error) return notice.show(`The Arguments field couldn't load (${errorText(args)}), so nothing ran. Press Run again.`);
    if (!args.ok) {
      L.showPanelTab("output");
      if (L.narrow()) L.showView("output");
      if (output.explainArgs(args.reason)) announcer.say(args.reason);
      return;
    }
    notice.clear();
    const moves = new Map<WsPath, WsPath | null>();
    runMoves = moves;
    await saves.flushAll();
    const rootDir = lang === "python" ? "" : parentOf(file.path);
    let files: WorkspaceFile[];
    try {
      files = await store.loadRunFiles(ws, rootDir);
    } catch (e) {
      return notice.show(`Couldn't read the program's files: ${storageMessage(e)}`);
    }
    if (stopAsked) return notice.show(`Stopped before ${nameOf(file.path)} started.`, { tone: "info" });
    // The file itself was renamed or deleted while it was saved and read: run nothing stale.
    if (moves.has(file.path)) return notice.show(`${nameOf(file.path)} moved while it was getting ready to run. Press Run again.`, { tone: "info" });
    const paths = [...new Set([...files.map((f) => f.path), file.path])];
    const ids = paths.map((p) => ed.idForPath(p)).filter((id): id is FileId => id !== null);
    const ticket = ed.beginBuild(ids, { channel: "build", paths });
    const byPath = new Map(files.map((f) => [f.path, f]));
    for (const s of ticket.sources) byPath.set(s.path, { path: s.path, text: s.text });
    const current = settings.get();
    runSerial++;
    output.begin(nameOf(file.path), args.shown);
    // Code the last run wrote and nobody kept is left out now (it would be built into this run).
    discardHeld("next-run");
    // Ready before the run can fail, so its help shows with the error (a failed load says nothing).
    loadHelp().catch(() => {});
    // The panel opens on Run (to its remembered height) and shows Output.
    L.showPanelTab("output");
    if (L.narrow()) L.showView("output");
    setRunning("running");
    output.setPhase(lang === "python" ? "running" : "compiling", lang === "python" ? "Running" : "Compiling");
    announcer.say(`Running ${nameOf(file.path)}.`);
    try {
      const { result, summary } = await runtimes.run(
        { lang, entry: file.path, files: [...byPath.values()], stdin: output.stdin.value, args: args.args, limits: runLimits(current), build: buildOptions(current) },
        {
          onOutput: (stream, text) => output.write(stream, text),
          onPhase: (phase, detail, progress) => output.setPhase(phase, phaseLabel(phase, detail, lang, progress)),
          onInputRequest: () => {
            setRunning("waiting");
            // The header adds "(timer paused)": time spent waiting doesn't count.
            output.setPhase("waiting", "Waiting for input");
            // The field the program waits on must be in view: the panel may have been collapsed, or
            // Problems (on a phone, the Code view) chosen, while it ran (review B, 2026-10-18).
            L.showPanelTab("output");
            if (L.narrow()) L.showView("output");
            output.waitInput((line) => {
              setRunning("running");
              output.setPhase("running", "Running");
              runtimes.provideInput(line);
            });
          },
        },
      );
      // A file deleted during the run takes its errors with it; a renamed one keeps them under its
      // new name (endBuild stores a closed file's results under the path the tool saw).
      const marks = [...result.diagnostics, ...callSiteMarks(result.diagnostics)].filter((d) => !(d.path && moves.get(d.path) === null));
      ed.endBuild(ticket, marks);
      for (const [from, to] of moves) if (to !== null) ed.movePending(from, to);
      // The run's first error: the editor head's jump (when it is in another file) and the header's
      // lifted exception.
      const failed = FAILED.has(result.status);
      const first = failed ? marks.find((d) => d.severity === "error" && d.path) : undefined;
      const firstPath = first?.path ? (moves.get(first.path) ?? first.path) : null;
      runError = first && firstPath
        ? { id: null, path: firstPath, severity: "error", message: first.message, source: first.source, channel: "build", line: first.line, heuristic: Boolean(first.heuristic) }
        : null;
      runErrorCode = first?.code;
      renderJump();
      if (result.status === "error" || result.status === "build-failed" || result.status === "crashed") revealRunProblem(ed, file.id);
      if (lang === "python") {
        // The run reported this file's errors itself; the idle check's copies would be duplicates.
        ed.endBuild(ed.beginBuild(ids, { channel: "check", paths }), []);
      } else if (result.status === "build-failed") {
        // The compiler's messages, as it would print them (the Problems list has them as links).
        for (const d of result.diagnostics.slice(0, 50)) output.write(d.severity === "error" ? "stderr" : "stdout", `${diagnosticLine(d)}\n`);
      } else {
        const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
        if (warnings) output.note(`The build had ${plural(warnings, "warning")}: see Problems, or the marks in the code.`, "warning");
      }
      if (result.skipped?.length) {
        const names = result.skipped.map(nameOf);
        output.note(names.length === 1
          ? `Skipped ${names[0]}: it has its own main(), so it is a separate program.`
          : `Skipped ${listNames(names)}: they have their own main(), so they are separate programs.`);
      }
      if (result.message) output.note(result.message, result.status === "ok" ? "info" : "warning");
      // A failed build wrote a line per compiler error: the danger line in the log is the lifted
      // (first) error's own line, not the last one (review B, 2026-10-18).
      output.finish(result, first && runError ? liftError(runError, first.code) : null, result.status === "build-failed" && first ? diagnosticLine(first) : undefined);
      // The help explains the lifted error, or an error of the whole program (a crash) when no
      // error has a place; a run stopped at a limit gets the limit's help (B13).
      showRunHelp(failed ? (first ?? marks.find((d) => d.severity === "error")) : undefined);
      if (result.status === "timeout" || result.status === "output-limit") showLimitHelp(result.status, { seconds: current.timeLimitS, chars: runLimits(current).outputCap });
      // A file without main() whose folder has a program: offer to run that one (B13).
      const program = mainToOffer(result);
      if (program) output.offerMain({ path: program, run: () => void runOffered(program) });
      finishedRun(file.path, failed, moves);
      announcer.say(announcement(result, summary, file.path, current.timeLimitS));
      void saveWritten(result.written, parentOf(file.path));
    } catch (e) {
      ed.cancelBuild(ticket);
      output.fail(errorText(e));
      finishedRun(file.path, true, moves);
      announcer.say(`Couldn't run: ${errorText(e)}`);
    } finally {
      setRunning("idle");
      // A counter tests (and anything else) can wait on: one more finished run.
      root.dataset.runs = String(Number(root.dataset.runs ?? 0) + 1);
    }
  }

  /**
   * After a failed run, the file that ran shows the line that needs attention: the cursor goes
   * to its first error, or else to the call that led to an error in
   * another file, and that line scrolls into view. Focus stays where it is (the console, the field).
   */
  function revealRunProblem(ed: EditorManager, id: FileId) {
    if (ed.activeId !== id) return;
    const rows = ed.problems().filter((p) => p.id === id && p.channel === "build" && p.from !== undefined);
    const row = rows.find((p) => p.severity === "error") ?? rows.find((p) => p.severity === "info");
    if (row?.from === undefined) return;
    ed.apply(id, { selection: { anchor: row.from }, scrollIntoView: true });
    schedulePosition();
  }

  /**
   * New code a run wrote (a .py, .c, .cpp or header file), held until the student keeps it: later
   * builds would use it, and the run may be someone else's program from a code link (owner, 0.18.0,
   * 2026-10-30: "Ask first"). A pinned notice asks; dismissing it, or the next run, leaves it out.
   */
  const HELD_KEY = "written-code";
  let held: WorkspaceFile[] | null = null;
  function holdWritten(files: WorkspaceFile[]) {
    held = files;
    // Every file is named before Keep: a short list, or all of them in Output (never "and N more").
    const all = listNames(files.map((f) => f.path), Infinity);
    const one = files.length === 1;
    const names = files.length <= 3 ? all : `${plural(files.length, "code file")} (listed in Output)`;
    output.note(`The program wrote ${all}. Code a program writes is added to your files only if you keep it: see the question at the bottom.`, "warning");
    notice.show(`The program wrote ${names}, code that later runs would build. Keep ${one ? "it" : "them"} in your files?`, {
      tone: "warning",
      action: { label: one ? "Keep it" : "Keep them", run: () => void keepHeld() },
      pin: { key: HELD_KEY, onDismiss: () => discardHeld("dismissed") },
    });
  }
  async function keepHeld() {
    const files = held;
    held = null;
    notice.unpin(HELD_KEY);
    if (!files) return;
    if (!canWrite()) return void notice.show(readOnlyText(), { tone: "info" });
    await saveChanges(files.map((file) => ({ file, target: file.path, replace: false })));
  }
  function discardHeld(why: "dismissed" | "next-run") {
    if (!held) return;
    const names = listNames(held.map((f) => f.path));
    held = null;
    if (why === "next-run") notice.unpin(HELD_KEY);
    output.note(`${names} ${why === "next-run" ? "from the last run was" : "was"} left out of your files.`, "warning");
  }

  /** Saves files a run wrote (created, or saved over a file that isn't code), and says which. */
  async function saveChanges(saving: { file: WorkspaceFile; target: WsPath; replace: boolean }[]) {
    if (!saving.length) return;
    // Unsaved typing reaches storage first, so the program's text replaces a saved file, never typing.
    await saves.flushAll();
    const saved: WsPath[] = [];
    for (const c of saving) {
      try {
        if (c.replace) await store.saveFile(ws, c.target, c.file.text);
        else await store.createFile(ws, c.target, c.file.text);
        const id = editors.idForPath(c.target);
        if (id) replaceText(id, c.file.text);
        saved.push(c.target);
      } catch (e) {
        output.note(`${c.target} wasn't saved: ${storageMessage(e)}`, "warning");
      }
    }
    await refreshTree();
    if (saved.length) {
      output.note(`Saved ${listNames(saved)} to your files.`);
      announcer.say(`The program saved ${plural(saved.length, "file")} to your files.`);
    }
  }

  /**
   * Files the program wrote land in the workspace like on a disk: new files are created and changed
   * ones saved, with a line in Output instead of a question. The exceptions are code: a program that
   * wrote over a .py, .c, .cpp or header file is not saved over the code the user typed, and new code
   * it wrote waits for the student to keep it (holdWritten). Only files inside the program's own
   * folder count (C and C++ only see that folder; Python sees every file but runs in its folder), so
   * a program from a shared folder can't change files in the student's other folders.
   */
  async function saveWritten(all: WorkspaceFile[] | undefined, folder: WsPath | "") {
    if (!all?.length) return;
    const written = all.filter((f) => isInside(f.path, folder));
    const outside = all.filter((f) => !written.includes(f));
    if (outside.length) output.note(`${listNames(outside.map((f) => f.path), Infinity)} ${outside.length === 1 ? "is" : "are"} outside ${folder}, the program's folder, so ${outside.length === 1 ? "it wasn't" : "they weren't"} saved to your files.`, "warning");
    if (!written.length) return;
    if (!canWrite()) {
      output.note(`This tab is read-only, so ${listNames(written.map((f) => f.path))} wasn't saved to your files.`, "warning");
      return;
    }
    const byKey = new Map<string, WorkspaceFile>();
    for (const f of written) byKey.set(foldKey(f.path), f);
    const current = new Map((await store.loadTree(ws)).map((e) => [foldKey(e.path), e]));
    const changes: { file: WorkspaceFile; target: WsPath; replace: boolean }[] = [];
    for (const [key, file] of byKey) {
      const existing = current.get(key);
      if (existing?.opaque || existing?.kind === "dir") continue;
      if (existing) {
        const text = await store.readFile(ws, existing.path).catch(() => null);
        if (text === file.text) continue;
      }
      changes.push({ file, target: existing?.path ?? file.path, replace: Boolean(existing) });
    }
    const isCode = (path: string) => Boolean(detectLanguage(nameOf(path))) || isHeader(nameOf(path));
    const kept = changes.filter((c) => c.replace && isCode(c.target));
    const fresh = changes.filter((c) => !c.replace && isCode(c.target));
    const saving = changes.filter((c) => !kept.includes(c) && !fresh.includes(c));
    if (kept.length) output.note(`The program wrote over ${listNames(kept.map((c) => c.target))}. Your code was kept, not replaced.`, "warning");
    await saveChanges(saving);
    if (fresh.length) holdWritten(fresh.map((c) => ({ path: c.target, text: c.file.text })));
  }

  // C/C++ download offer (in Output while a C or C++ file is open).
  let packShown = false;
  output.onPackDownload = () => {
    runtimes.cppRunner?.download();
    // The service worker keeps the app (and, in WebKit, the pack's cache) for offline use: main.ts.
    document.dispatchEvent(new CustomEvent("codeeditor:offline-wanted"));
    // "The button is in the Output panel" has been followed: the offer now shows the progress.
    clearPackNotice();
    renderPack();
  };
  function renderPack() {
    const file = fileOf(editors.activeId);
    const lang = file ? detectLanguage(file.path)?.id : null;
    const runner = runtimes.cppRunner;
    const cpp = runner && (runner.state === "absent" || runner.state === "downloading") ? runner : null;
    // Only once the pack is in (or the runner isn't there yet) may a later offer open the panel again.
    if (!cpp) packShown = false;
    if (!cpp || (lang !== "c" && lang !== "cpp")) return output.showPack({ state: "hidden", loaded: 0, total: 0 });
    // The offer is something to act on before any run: a collapsed panel opens to show it, once per
    // offer rather than on every visit to a C file, so a panel the user collapsed again stays so
    // (review B, 2026-10-18).
    if (!packShown) L.expandPanel();
    packShown = true;
    output.showPack({
      state: cpp.state === "downloading" ? "downloading" : cpp.error ? "failed" : "offer",
      loaded: cpp.progress.loaded,
      total: cpp.progress.total,
      error: cpp.error,
      then: runAfterPack !== null && runAfterPack.path === file?.path ? nameOf(runAfterPack.path) : undefined,
    });
  }

  // Panel actions: Restart Python, Clear.
  const restartButton = h("button", { type: "button", class: "btn ghost small", id: "restart-python", title: "Start Python again with a clean state" }, icon("arrow-clockwise"), "Restart Python");
  const clearButton = h("button", { type: "button", class: "btn ghost small", id: "clear-output", title: "Clear the output" }, icon("eraser"), h("span", { class: "label-wide" }, "Clear"));
  clearButton.setAttribute("aria-label", "Clear the output");
  function restartPython() {
    runtimes.restartPython();
    announcer.say("Restarting Python.");
    notice.show("Python is starting again with a clean state.", { tone: "info" });
  }
  restartButton.addEventListener("click", restartPython);
  clearButton.addEventListener("click", () => output.clear());
  // Maximise / restore the panel: resizing without dragging (WCAG 2.2 SC 2.5.7). Desktop only;
  // below 900 px Output fills the screen anyway. It sizes the console with whichever splitter sizes
  // it at this width (beside the code from 1100 px, under it below), each keeping its own restore size.
  const restoreTo = new Map<Splitter, number>();
  const maxButton = h("button", { type: "button", class: "icon-btn small panel-max", id: "panel-max", "aria-pressed": "false" });
  const renderMax = () => {
    const panelSize = L.panelSplitter();
    const on = panelSize.value >= panelSize.max();
    maxButton.setAttribute("aria-pressed", String(on));
    maxButton.setAttribute("aria-label", "Maximise the panel");
    maxButton.title = on ? "Restore the panel's size" : "Maximise the panel";
    maxButton.replaceChildren(icon(on ? "corners-in" : "corners-out"));
  };
  maxButton.addEventListener("click", () => {
    const panelSize = L.panelSplitter();
    const back = restoreTo.get(panelSize) ?? panelSize.initial;
    if (panelSize.value >= panelSize.max()) panelSize.set(back < panelSize.max() ? back : panelSize.initial);
    else {
      restoreTo.set(panelSize, panelSize.value);
      panelSize.set(panelSize.max());
    }
    L.expandPanel();
    renderMax();
  });
  for (const split of [L.splitters.panel, L.splitters.console]) for (const type of ["keyup", "pointerup", "dblclick"]) split.element.addEventListener(type, renderMax);
  matchMedia(WIDE).addEventListener("change", renderMax);
  renderMax();
  // Input (text given to the program first) opens its box above the log, so it shows Output; the
  // caret goes into the box it opened (it sat four Tab stops past the toggle: review B, 2026-10-18).
  // OutputView's own listener, added first, has opened or closed the box by now.
  output.inputToggle.addEventListener("click", () => {
    L.showPanelTab("output");
    if (output.inputToggle.getAttribute("aria-expanded") === "true") output.stdin.focus();
  });
  L.panelActions.append(output.inputToggle, restartButton, clearButton);
  L.panelHeadTools.append(maxButton);

  // ---------------------------------------------------------------- the Flowchart view
  // Nothing of it loads on the first visit: its chunk (view, layout, renderer) the first time the
  // Flowchart tab or phone view opens, the worker and the grammars when it first draws.
  const chartHost: ChartHost = {
    file: () => {
      const id = editors.activeId;
      const file = fileOf(id);
      const text = id ? editors.text(id) : null;
      return id && file && text !== null ? { id, path: file.path, text } : null;
    },
    select: (id, from, to, focus) => {
      const state = editors.state(id);
      if (!state) return;
      const line = (n: number) => state.doc.line(Math.min(Math.max(1, n), state.doc.lines));
      manager?.reveal(id, line(from).from, line(to).to, focus);
    },
    caretLine: () => {
      const id = editors.activeId;
      const state = id ? editors.state(id) : null;
      return state ? state.doc.lineAt(state.selection.main.head).number : null;
    },
    showCode: () => {
      if (L.narrow()) L.showView("code");
    },
  };
  let loadingChart: Promise<FlowchartView> | null = null;
  function ensureChart(): Promise<FlowchartView> {
    loadingChart ??= import("./flowchart-view").then(
      ({ createFlowchartView }) => (chartView = createFlowchartView(L.flowchartPanel, chartHost)),
      (e: unknown) => {
        // A failed chunk can stay failed for this page (WebKit): the words say to reload.
        L.flowchartPanel.replaceChildren(h("p", { class: "fc-load-error", role: "status" }, "Couldn't load the flowchart view. Check the connection, then reload the page."));
        loadingChart = null;
        throw e;
      },
    );
    return loadingChart;
  }
  L.onChartVisibleChange((visible) => {
    if (visible) void ensureChart().then((v) => v.setVisible(L.chartVisible()), () => {});
    else chartView?.setVisible(false);
  });

  /** The file list's width in steps, from the More file actions menu (no dragging needed). */
  const WIDTH_STEP = 64;
  function widthItems(): MenuItem[] {
    if (L.narrow()) return [];
    const side = L.splitters.sidebar;
    const items: MenuItem[] = [];
    if (side.value < side.max()) items.push({ label: "Wider file list", icon: "corners-out", run: () => side.set(side.value + WIDTH_STEP) });
    if (side.value > side.min) items.push({ label: "Narrower file list", icon: "corners-in", run: () => side.set(side.value - WIDTH_STEP) });
    if (items.length) items[0].separatorBefore = true;
    return items;
  }

  // ---------------------------------------------------------------- status bar
  const RUNTIME_WORDS: Record<string, string> = {
    "python:idle": "Python starts on first run",
    "python:booting": "Starting Python",
    "python:ready": "Python ready",
    "python:running": "Python running",
    "python:failed": "Python couldn't start",
    "cpp:not-loaded": "C/C++ loading",
    "cpp:checking": "Checking for C/C++",
    "cpp:absent": "C/C++ needs a one-time download",
    "cpp:downloading": "Downloading C/C++",
    "cpp:idle": "C/C++ starts on first run",
    "cpp:booting": "Starting the C/C++ compiler",
    "cpp:ready": "C/C++ ready",
    "cpp:running": "C/C++ running",
    "cpp:failed": "C/C++ couldn't start",
    // 0.17.0: no C++ exception instructions in this browser's WebAssembly (runner/wasm-features.ts).
    "cpp:unsupported": "C/C++ needs a newer browser",
  };
  function renderStatus() {
    const file = fileOf(editors.activeId);
    const lang = file ? detectLanguage(file.path) : null;
    L.status.lang.textContent = file ? (lang?.label ?? (isHeader(file.path) ? "C/C++ header" : "Plain text")) : "";
    L.status.lang.hidden = !file;
    root.dataset.runnable = String(Boolean(lang));
    const kind: RuntimeKind | null = lang ? runtimeOf(lang.id) : null;
    const el = L.status.runtime;
    el.hidden = !kind;
    restartButton.hidden = kind !== "python" && runtimes.state("python") === "idle";
    if (kind) {
      const state = runtimes.state(kind);
      el.dataset.runtime = kind;
      el.dataset.state = state;
      const failed = state === "failed" || state === "unsupported";
      const busy = state === "booting" || state === "checking" || state === "downloading" || state === "not-loaded" || state === "running";
      let words = RUNTIME_WORDS[`${kind}:${state}`] ?? state;
      if (kind === "cpp" && state === "downloading" && runtimes.cppRunner) {
        const { loaded, total } = runtimes.cppRunner.progress;
        words = `Downloading C/C++ ${total ? Math.floor((loaded / total) * 100) : 0}%`;
      }
      // Python's first start downloads it (B9): said as the C/C++ download is.
      const python = kind === "python" ? runtimes.pythonDownload() : null;
      if (python) words = python.total ? `Downloading Python ${Math.floor((Math.min(python.loaded, python.total) / python.total) * 100)}%` : "Downloading Python";
      el.replaceChildren(icon(failed ? "x-circle" : busy ? "arrow-clockwise" : state === "absent" ? "download-simple" : "check-circle"), h("span", null, words));
      // The top bar shortens or hides the words when it is narrow (app.css): the tooltip keeps them.
      el.title = words;
    }
    renderPack();
  }
  runtimes.onChange(() => {
    // The download offer goes once the pack is in: focus inside it moves to Run (whose press it
    // stood for), never to the page.
    const packFocus = output.packHasFocus();
    renderStatus();
    if (packFocus && output.packHidden && isShown(L.runButton)) L.runButton.focus();
    runIfPackArrived();
    const file = fileOf(editors.activeId);
    if (file && runtimes.state("python") === "ready" && detectLanguage(file.path)?.id === "python") scheduleCheck(file.id);
  });

  /**
   * The status bar's Ln/Col for the active file's state (hidden with no file). While typing it is
   * written from the editor's own update (onSelectionChange), so it is painted in the editor's
   * frame: from keyup and selectionchange through requestAnimationFrame it was a second full-page
   * frame for every key (speed profile, 2026-10-19; putting those listeners back costs about 20%
   * more rendering per key at 4x CPU slowdown, measured 2026-10-20). Every cursor move in the
   * editor is a transaction, so that hook sees them all; a text replaced from outside (a pull, an
   * import, a program's file) calls it too (EditorManager.replaceContent); a file switch comes
   * through schedulePosition.
   */
  function showPosition(state: EditorState | null) {
    L.status.pos.hidden = !state;
    if (!state) return;
    const { line, col } = toLineCol(state.doc, state.selection.main.head);
    L.status.pos.textContent = `Ln ${line}, Col ${col}`;
  }
  let positionFrame = 0;
  function schedulePosition() {
    positionFrame ||= requestAnimationFrame(() => {
      positionFrame = 0;
      const id = editors.activeId;
      showPosition(id ? editors.state(id) : null);
    });
  }

  let syncCountTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSyncCount() {
    clearTimeout(syncCountTimer);
    syncCountTimer = setTimeout(() => void refreshSyncCount(), 800);
  }
  /**
   * The unsynced count on the top bar's sync status (data-unsynced), the one place sync and save
   * state are shown: "0" while not connected (everything is saved on this computer, which its name
   * and tooltip say). The sync screens set the same attribute from the same counts once they load.
   */
  let unsynced = "0";
  async function refreshSyncCount() {
    try {
      const rec = await store.getWorkspace(ws);
      if (!rec?.remote) unsynced = "0";
      else {
        const stats = await store.workspaceStats(ws);
        // New files count too: storage reports them as "added", apart from "changed".
        unsynced = String(stats.changed + stats.added + stats.deleted);
      }
    } catch (e) {
      // Another tab cleared the storage: this tab already says so and offers Reload, and every
      // caller starts this without waiting, so a closed connection ends here instead of unhandled.
      if (isClosedError(e)) return;
      throw e;
    }
    const status = L.syncSlot.querySelector<HTMLElement>("#sync-status");
    if (status) status.dataset.unsynced = unsynced;
  }

  // ---------------------------------------------------------------- read-only tabs
  const REASON_TEXT: Record<ReadOnlyReason, string> = {
    "other-tab": "This workspace is open for editing in another tab. You can read and run code here.",
    "handed-over": "Editing moved to another tab. You can read and run code here.",
    stolen: "Another tab took over editing. You can read and run code here.",
    paused: "This tab was paused by the browser.",
    closed: "This tab stopped editing.",
    "no-locks": "This browser can't keep tabs in step, so this tab is read-only.",
  };
  let wasWriter = false;
  /** Set once start-up has restored the tabs (a role change before that needs no reload). */
  let started = false;
  function applyRole() {
    const writer = tab?.role === "writer";
    editors.setReadOnly(!writer);
    tree.readOnly = !writer;
    root.dataset.role = tab?.role ?? "starting";
    L.banner.hidden = writer || tab?.role === "starting";
    L.bannerText.textContent = tab?.reason ? REASON_TEXT[tab.reason] : "";
    L.bannerButton.hidden = tab?.reason === "no-locks";
    // Becoming the writer: another tab may have changed files meanwhile.
    if (started && writer && !wasWriter) void reloadFromStorage("tab").then(() => recoverTyping());
    wasWriter = writer;
  }
  L.bannerButton.addEventListener("click", async () => {
    L.bannerButton.disabled = true;
    try {
      await tab?.requestEdit();
    } finally {
      L.bannerButton.disabled = false;
    }
    if (tab?.role === "writer") {
      announcer.say("You can edit in this tab now.");
      focusEditor();
    }
  });

  /**
   * Re-reads the tree and every open file (another tab or a sync changed them). Clean files take the
   * stored text. A file with unsaved typing whose stored text changed underneath keeps both versions
   * (keepBoth); one whose stored text is unchanged is left alone (`kept`: it saves as usual).
   */
  async function reloadFromStorage(cause: "tab" | "sync"): Promise<{ kept: WsPath[]; copies: { path: WsPath; copy: WsPath }[] }> {
    const before = new Set(entries.map((e) => e.path));
    await refreshTree();
    // Any stored file may have changed: the names index reads again what it needs.
    manager?.indexChanged();
    const kept: WsPath[] = [];
    const copies: { path: WsPath; copy: WsPath }[] = [];
    const files = entries.filter((e) => e.kind === "file" && !e.opaque);
    const known = new Set(files.map((e) => e.path));
    // Files that appeared since the last read: where an open file went if another tab renamed it.
    // (A sync reports its own deletions: its report names the tabs it closed.)
    const arrived = cause === "tab" ? files.filter((e) => !before.has(e.path) && !open.some((f) => f.path === e.path)) : [];
    for (const file of [...open]) {
      if (!known.has(file.path)) {
        if (editors.isDirty(file.id)) {
          kept.push(file.path);
          continue;
        }
        const old = file.path;
        const moved = await renamedTo(file.id, arrived);
        if (moved) {
          file.path = moved;
          if (editors.has(file.id)) editors.rename(file.id, moved);
          arrived.splice(arrived.findIndex((e) => e.path === moved), 1);
          followError(old, moved);
          notice.show(`${nameOf(old)} was renamed to ${nameOf(moved)} in another tab.`, { tone: "info" });
          continue;
        }
        editors.close(file.id, { force: true, next: null });
        based.delete(file.id);
        open.splice(open.indexOf(file), 1);
        followError(old, null);
        if (cause === "tab") notice.show(`${nameOf(old)} is no longer in the workspace (renamed or deleted in another tab), so its tab closed.`, { tone: "info" });
        continue;
      }
      if (!editors.has(file.id)) continue;
      const text = await store.readFile(ws, file.path).catch(() => null);
      if (text === null) continue;
      if (editors.isDirty(file.id)) {
        if (based.has(file.id) && text !== based.get(file.id)) {
          // The save finds the changed text and keeps both versions.
          copiesMade.delete(file.id);
          await saves.save(file.id);
          const made = copiesMade.get(file.id);
          copiesMade.delete(file.id);
          if (made) copies.push(made);
          else kept.push(file.path);
        } else kept.push(file.path);
        continue;
      }
      if (text !== editors.text(file.id)) replaceText(file.id, text);
      else based.set(file.id, text);
    }
    if (editors.activeId === null && open.length) await activate(open[0].id);
    renderTabs();
    afterActiveChange();
    persistUi();
    const rev = (await store.getWorkspace(ws))?.rev;
    if (rev !== undefined) tab?.seen(rev);
    scheduleSyncCount();
    return { kept, copies };
  }

  /**
   * Saves typing stashed when the page last went away (stashTyping), if its file still holds the
   * text it was based on; otherwise keeps it as a conflict copy, so a newer version is never lost.
   */
  async function recoverTyping() {
    if (!canWrite()) return;
    const stash = readStash(ws);
    if (!stash.length) return;
    let restored = 0;
    const copies: WsPath[] = [];
    for (const f of stash) {
      const entry = entries.find((e) => e.path === f.path && e.kind === "file" && !e.opaque);
      const stored = entry ? await store.readFile(ws, f.path).catch(() => null) : null;
      if (stored === f.text) continue; // the last save made it after all
      try {
        if (stored !== null && textHash(stored) === f.base) {
          await store.saveFile(ws, f.path, f.text, { expect: stored });
          restored++;
        } else {
          const taken = new Set((await store.loadTree(ws)).map((e) => foldKey(e.path)));
          const copy = conflictName(f.path, new Date(), (p) => taken.has(foldKey(p)));
          await store.createFile(ws, copy, f.text);
          copies.push(copy);
        }
      } catch {
        // Refused (a limit, or the text changed again meanwhile): what is stored stays.
      }
    }
    dropStash(ws);
    if (!restored && !copies.length) return;
    if (started) await reloadFromStorage("tab");
    else await refreshTree();
    if (copies.length) {
      notice.show(`Typing from your last visit is saved as ${listNames(copies.map(nameOf))}: its file changed since, so it wasn't put back into it.`, {
        tone: "warning",
        action: copies.length === 1 ? { label: `Open ${nameOf(copies[0])}`, run: () => void openFile(copies[0], { focus: true }) } : undefined,
      });
    }
  }

  /** The new path of an open, clean file another tab renamed: the one arrived file with its text. */
  async function renamedTo(id: FileId, arrived: readonly EntryMeta[]): Promise<WsPath | null> {
    const text = editors.has(id) ? editors.text(id) : (based.get(id) ?? null);
    if (text === null) return null;
    const matches: WsPath[] = [];
    for (const e of arrived.slice(0, 50)) {
      if ((await store.readFile(ws, e.path).catch(() => null)) === text) matches.push(e.path);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  // ---------------------------------------------------------------- settings, shortcuts, sync
  let sync: SyncHooks = {
    connect() {},
    disconnect() {},
    async syncNow() {},
    syncWithMessage() {},
    onLocalChange() {},
    connected: () => false,
    describe: () => "",
    async signOut() {},
    share() {},
  };
  // Settings (with the theme picker) is its own chunk, fetched the first time it opens.
  let settingsDialog: Promise<{ open(opener?: HTMLElement): void }> | null = null;
  function openSettings(opener: HTMLElement = L.settingsButton) {
    settingsDialog ??= import("./settings-dialog").then(({ createSettingsDialog }) =>
      createSettingsDialog({ settings, db, sync: () => sync, exportWorkspace, signOut: signOutAndClear }),
    );
    settingsDialog.then(
      (dialog) => dialog.open(opener),
      (e: unknown) => {
        settingsDialog = null;
        notice.show(`Settings couldn't open: ${errorText(e)}`);
      },
    );
  }
  // The Shortcuts list is a chunk of its own, built on its first opening (a first visit doesn't need
  // its table; the budget in design.spec), and fetched early on a sign of intent, as the palette is.
  let shortcutsDialog: Promise<{ open(opener?: HTMLElement): void }> | null = null;
  const loadShortcuts = () => (shortcutsDialog ??= import("./shortcuts").then((m) => m.createShortcutsDialog()).catch((e: unknown) => {
    shortcutsDialog = null;
    throw e;
  }));
  const shortcuts = {
    open(opener?: HTMLElement) {
      loadShortcuts().then(
        (dialog) => dialog.open(opener),
        (e: unknown) => notice.show(`The shortcuts list couldn't open: ${errorText(e)}`),
      );
    },
  };
  for (const type of ["pointerover", "focusin"]) {
    L.status.shortcuts.addEventListener(type, () => {
      if (navigator.onLine) void loadShortcuts().catch(() => {});
    }, { once: true });
  }
  L.settingsButton.addEventListener("click", () => openSettings());
  L.status.shortcuts.addEventListener("click", () => shortcuts.open(L.status.shortcuts));

  /** Ctrl+`: the output (a collapsed panel opens), or the Output tab with nothing printed yet. */
  function goToOutput() {
    if (L.narrow()) L.showView("output");
    L.showPanelTab("output");
    if (!output.focus()) (L.narrow() ? L.viewTabs.output : L.panelTabs.output).focus();
  }
  const focused = () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);

  // ---------------------------------------------------------------- examples and the command palette
  // Both are lazy chunks (.claude/design/batch3/p.md): the shell keeps their entry points only.
  let examplesChunk: Promise<typeof import("./examples-dialog")> | null = null;
  function openExamples(opener: HTMLElement | null = focused()) {
    examplesChunk ??= import("./examples-dialog");
    examplesChunk.then(
      (m) => m.openExamples({ taken: (p) => entries.some((e) => foldKey(e.path) === foldKey(p)), create: (p, text) => void addFile(p, text).then((r) => r && notice.show(r.message, { tone: r.readOnly ? "info" : "error" })), returnTo: opener }),
      (e: unknown) => {
        examplesChunk = null;
        notice.show(`The examples couldn't open: ${errorText(e)}`);
      },
    );
  }
  // Save as PDF (.claude/design/pdf.md): a lazy chunk too. The open file starts checked (else the
  // file chosen in the list); an open file is read from its editor, unsaved typing included.
  let printChunk: Promise<typeof import("./print-dialog")> | null = null;
  function openPrint(opener: HTMLElement | null = focused()) {
    printChunk ??= import("./print-dialog");
    printChunk.then(
      (m) => {
        const active = fileOf(editors.activeId)?.path;
        const chosen = tree.selectedNode();
        let storage: Storage | null = null;
        try {
          storage = localStorage;
        } catch {
          // storage blocked: the defaults, and changes last for the opening
        }
        m.openPrintDialog({
          files: entries.filter((e) => e.kind === "file" && !e.opaque).map((e) => e.path),
          checked: active ? [active] : chosen?.kind === "file" && !chosen.opaque ? [chosen.path] : [],
          read: async (path) => {
            const id = editors.idForPath(path);
            const state = id ? editors.state(id) : null;
            return { path, state, text: state ? state.doc.toString() : await store.readFile(ws, path) };
          },
          app: root, notice, storage, returnTo: opener,
        });
      },
      (e: unknown) => {
        printChunk = null;
        notice.show(`Save as PDF couldn't open: ${errorText(e)}`);
      },
    );
  }
  /**
   * Adds a file at `path` with `text` and opens it (an example, a code link): null once it is added,
   * else why not. It shows no notice itself: the caller says why where the student is looking.
   */
  async function addFile(path: WsPath, text: string): Promise<AddRefusal | null> {
    if (!canWrite()) return { message: readOnlyText(), readOnly: true };
    try {
      await store.createFile(ws, path, text);
    } catch (e) {
      return { message: storageMessage(e) };
    }
    await refreshTree();
    await openFile(path, { focus: true });
    announcer.say(`Added ${path}. Press ${isMac() ? "Command" : "Control"} Enter to run it.`);
    return null;
  }

  /**
   * A folder from a code link (format 2), added as a new folder at the top: every name and byte goes
   * through importFiles, as a folder import does. Files it refuses are named in a notice; none added
   * is a refusal the dialog shows.
   */
  async function addFolder(folder: WsPath, files: readonly { name: string; text: string }[]): Promise<AddRefusal | null> {
    if (!canWrite()) return { message: readOnlyText(), readOnly: true };
    const enc = new TextEncoder();
    let result: Awaited<ReturnType<typeof store.importFiles>>;
    try {
      result = await store.importFiles(ws, "", files.map((f) => ({ name: joinPath(folder, f.name), bytes: enc.encode(f.text) })));
    } catch (e) {
      return { message: storageMessage(e) };
    }
    if (!result.added.length) return { message: `The folder wasn't added: ${result.refused[0]?.reason ?? "nothing in it could be stored"}.` };
    await refreshTree();
    tree.reveal(result.added[0]);
    const first = result.added.find((p) => detectLanguage(p)) ?? result.added[0];
    await openFile(first, { focus: true });
    if (result.refused.length) notice.show(`Added ${folder} with ${plural(result.added.length, "file")}. Left out ${listNames(result.refused.map((r) => r.name))}: ${result.refused[0].reason}.`, { tone: "info" });
    announcer.say(`Added the folder ${folder} with ${plural(result.added.length, "file")}, and opened ${nameOf(first)}.`);
    return null;
  }

  let paletteChunk: Promise<typeof import("./palette")> | null = null;
  const loadPalette = () => (paletteChunk ??= import("./palette").catch((e: unknown) => {
    paletteChunk = null;
    throw e;
  }));
  const paletteApi: PaletteApi = {
    mac: isMac(),
    fileOpen: () => manager !== null && editors.activeId !== null,
    running: () => root.dataset.run === "running" || root.dataset.run === "waiting",
    python: () => runtimes.state("python") !== "idle" || detectLanguage(fileOf(editors.activeId)?.path ?? "")?.id === "python",
    connected: () => sync.connected(),
    canWrite,
    explainReadOnly,
    files: () => entries.filter((e) => e.kind === "file").map((e) => ({ path: e.path, opaque: Boolean(e.opaque) })),
    openPaths: () => open.map((f) => f.path),
    activePath: () => fileOf(editors.activeId)?.path ?? null,
    view: () => manager?.view ?? null,
    settings,
    notice,
    widthItems,
    act: {
      run: () => void run(),
      stop: stopRun,
      save: () => void saveAndSync(),
      open: (path) => void openFile(path, { focus: true }),
      close: () => void (editors.activeId && closeFile(editors.activeId)),
      newFile: () => startCreate("file"),
      newFolder: () => startCreate("dir"),
      examples: (opener) => openExamples(opener),
      rename: () => {
        const path = fileOf(editors.activeId)?.path;
        if (!path || explainReadOnly()) return;
        if (!L.drawerOpen()) L.openDrawer();
        tree.reveal(path);
        tree.startRename(path);
      },
      remove: () => {
        const node = tree.node(fileOf(editors.activeId)?.path ?? "");
        if (node) void removeEntry(node);
      },
      importFiles: () => void importFrom(false, ""),
      importFolder: () => void importFrom(true, ""),
      exportZip: () => void exportWorkspace(),
      savePdf: (opener) => openPrint(opener),
      share: (opener) => {
        const path = fileOf(editors.activeId)?.path;
        if (path) sync.share(path, opener);
      },
      download: () => {
        const path = fileOf(editors.activeId)?.path;
        if (path) void downloadPaths([path]);
      },
      downloadFolder: () => {
        const path = fileOf(editors.activeId)?.path;
        if (path && parentOf(path) !== "") void downloadPaths([parentOf(path)]);
      },
      chooseFiles: (opener) => void chooseFiles(opener),
      capture: (opener) => snippet.open(opener, opener.closest(".cm-editor") ? "context" : "head-key"),
      fileList: () => {
        L.openDrawer();
        tree.focus();
      },
      output: goToOutput,
      problems: () => {
        if (L.narrow()) L.showView("problems");
        L.showPanelTab("problems");
        (L.narrow() ? L.viewTabs.problems : L.panelTabs.problems).focus();
      },
      settings: (opener) => openSettings(opener),
      shortcuts: (opener) => shortcuts.open(opener),
      connect: () => sync.connect(),
      syncNow: () => void saveAndSync(),
      syncWithMessage: (opener) => sync.syncWithMessage(opener),
      restartPython,
      clearOutput: () => output.clear(),
    },
  };
  /** Opens the palette on `mode`; focus goes back to what had it (or to the top bar's Search). */
  function openPalette(mode: "all" | "commands", opener: HTMLElement | null = focused() ?? L.paletteButton) {
    if (wiped) return;
    loadPalette().then(
      // Checked again once the chunk is here: the tab may have been cleared while it loaded.
      (m) => void (wiped || m.openPalette(paletteApi, mode, opener)),
      (e: unknown) => notice.show(`Search couldn't open: ${errorText(e)}`),
    );
  }
  L.paletteButton.addEventListener("click", () => openPalette("all", L.paletteButton));
  // The sidebar's quick actions: the same palette, the Flowchart tab (its view on phones, where the
  // drawer closes to show it), and a new file's name field in the tree.
  L.quick.search.addEventListener("click", () => openPalette("all", L.quick.search));
  L.quick.flowchart.addEventListener("click", () => {
    if (L.narrow()) {
      L.closeDrawer(false);
      L.showView("flowchart");
      L.viewTabs.flowchart.focus();
    } else L.showPanelTab("flowchart", true);
  });
  L.quick.newFile.addEventListener("click", () => startCreate("file"));
  for (const type of ["pointerover", "focusin"]) L.quick.search.addEventListener(type, () => prefetchPalette(), { once: true });
  // Fetched on the first sign of intent, so the chunk is usually there by the time it opens. Not while
  // offline: a prefetch is only a hint, and without the service worker's copy it can only fail (a
  // Ctrl+S offline once started a download that failed); opening the palette still loads it.
  const prefetchPalette = () => {
    if (navigator.onLine) void loadPalette().catch(() => {});
  };
  for (const type of ["pointerover", "focusin"]) L.paletteButton.addEventListener(type, prefetchPalette, { once: true });
  addEventListener("keydown", (e) => {
    if (e.key === "Control" || e.key === "Meta" || e.key === "F1") prefetchPalette();
  }, { capture: true });
  settings.onChange((now, before) => {
    if (now.codeSize !== before.codeSize) root.style.setProperty("--code-size", `${now.codeSize}px`);
    if (now.lineWrapping !== before.lineWrapping) editors.setPrefs({ lineWrapping: now.lineWrapping });
    if (now.suggestOnTyping !== before.suggestOnTyping) editors.setPrefs({ suggestOnTyping: now.suggestOnTyping });
    if (now.enterAcceptsTop !== before.enterAcceptsTop) editors.setPrefs({ enterAcceptsTop: now.enterAcceptsTop });
  });

  async function signOutAndClear() {
    const ok = await confirmDialog({
      title: "Sign out and clear this computer?",
      body: [
        "This removes every file, setting and saved GitHub token ExecFlow keeps in this browser, then reloads the page.",
        "Files already synced to GitHub stay in the repository. Anything not synced is lost: export it first if you need it.",
        "On a shared computer, also sign out of github.com: the browser's GitHub session isn't ExecFlow's and stays signed in.",
      ],
      confirm: "Clear this computer",
      danger: true,
    });
    if (!ok) return;
    root.dataset.state = "clearing";
    // Every other tab drops its files and ends its own sign-in now (clearedElsewhere), so none of
    // them keeps the database open, or a token in memory, once this tab has gone.
    tab?.notifyCleared();
    await sync.signOut().catch(() => {});
    await tab?.close().catch(() => {});
    try {
      await deleteAllLocalData({ close: [db], onBlocked: () => notice.show("Close ExecFlow's other tabs to finish clearing this computer.", { tone: "warning" }) });
      const { deleteSecretsDb } = await import("../sync/token-store");
      await deleteSecretsDb();
    } catch (e) {
      root.dataset.state = "ready";
      return notice.show(`Clearing didn't finish: ${errorText(e)}`);
    }
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith("codeeditor:")) localStorage.removeItem(key);
      sessionStorage.clear();
    } catch {
      // storage blocked: nothing kept there
    }
    location.reload();
  }

  /**
   * Another tab is clearing this computer (its "cleared" message, or the database being deleted):
   * on a shared computer this tab must keep nothing usable. Unsaved edits are dropped (the clearing
   * tab's confirm said anything not synced is lost), this tab's own GitHub sign-in ends (revoked,
   * and never refreshed or sealed again), and the page is left with only a Reload button. Reloading
   * then opens the cleared workspace: IndexedDB queues an open behind a pending delete.
   */
  function clearedElsewhere(): Promise<void> {
    wiped ??= (async () => {
      root.dataset.state = "clearing";
      // Dialogs and menus live on document.body, outside root: Settings, Share, the repository
      // picker or the palette would otherwise stay open on the last student's work (a confirm
      // left open settles as "no"). Nothing opens again: the keys, the palette and code links
      // check `wiped`, and `entries` no longer lists a file.
      closeMenus();
      for (const dialog of document.querySelectorAll("dialog")) {
        if (dialog.open) dialog.close();
        dialog.remove();
      }
      entries = [];
      saves.drop();
      editors.setReadOnly(true);
      // Closed at once, so the clearing tab's delete never waits for this one.
      db.close();
      await sync.signOut().catch(() => {});
      // signOut waited for any seal this tab was writing; that seal may have opened (so made) the
      // secrets database again after the clearing tab deleted it. Deleting it here too means
      // whichever tab finishes last leaves nothing behind.
      await import("../sync/token-store").then((m) => m.deleteSecretsDb()).catch(() => {});
      await tab?.close().catch(() => {});
      manager?.destroy();
      manager = null;
      editors = idle;
      open.length = 0;
      try {
        sessionStorage.clear();
      } catch {
        // storage blocked: nothing kept there
      }
      const reload = h("button", { type: "button", class: "btn primary" }, "Reload");
      reload.addEventListener("click", () => location.reload());
      root.replaceChildren(
        h(
          "div",
          { class: "start-failed empty-state", role: "alert", "data-empty": "cleared" },
          h("h1", { class: "empty-title" }, "ExecFlow was cleared in another tab"),
          h("p", { class: "empty-lede" }, "The files, settings and GitHub sign-in it kept in this browser are gone from this tab too. Reload to start again."),
          reload,
        ),
      );
      root.dataset.state = "cleared";
    })();
    return wiped;
  }

  // A new version was downloaded in the background: reload only when the user says so.
  document.addEventListener("codeeditor:update-ready", (e) => {
    const apply = (e as CustomEvent<() => void>).detail;
    notice.show("A new version of ExecFlow is ready.", {
      tone: "info",
      action: { label: "Reload now", run: () => void saves.flushAll().then(() => apply()) },
    });
  });

  // ---------------------------------------------------------------- the Run button and keyboard
  // A disabled Run (nothing open) does nothing: its description says why.
  L.runButton.addEventListener("click", (e) => {
    if (L.runButton.getAttribute("aria-disabled") === "true") return;
    void run({ repeat: e.detail > 1 });
  });

  addEventListener("keydown", (e) => {
    // Cleared in another tab: none of the app's keys run (the palette would list old files).
    if (e.defaultPrevented || wiped) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const palette = paletteKey(e);
    // A modal dialog or an open menu owns the keyboard: nothing behind it runs, closes or moves (APG;
    // native menus do the same). Mod+S and the palette's keys still keep the browser's own Save page,
    // Print and Help away, as they do everywhere else in the app. (The palette's own dialog handles
    // its keys before this.)
    if (document.querySelector("dialog[open], .menu")) {
      if ((mod && !e.altKey && !e.shiftKey && key === "s") || palette) e.preventDefault();
      return;
    }
    if (mod && !e.altKey && key === "Enter") {
      e.preventDefault();
      void run({ repeat: e.repeat, key: true });
    } else if (mod && !e.altKey && !e.shiftKey && key === "s") {
      e.preventDefault();
      void saveAndSync();
    } else if (mod && !e.altKey && key === ".") {
      e.preventDefault();
      stopRun();
    } else if (e.altKey && !mod && (key === "w" || e.code === "KeyW")) {
      const id = editors.activeId;
      if (!id) return;
      e.preventDefault();
      void closeFile(id);
    } else if (mod && e.shiftKey && (key === "e" || e.code === "KeyE")) {
      e.preventDefault();
      L.openDrawer();
      tree.focus();
    } else if (mod && (key === "`" || e.code === "Backquote")) {
      e.preventDefault();
      goToOutput();
    } else if (palette) {
      // The command palette: F1 and Ctrl+Shift+P on the commands, Ctrl+P on files and commands
      // (vscode.dev's keys; Ctrl+P is the browser's Print, which the app takes here).
      e.preventDefault();
      openPalette(palette);
    } else if (mod && key === "/" && !isTyping(e.target)) {
      // The Shortcuts list. No lone "?" (a one-character shortcut fires while someone types or
      // dictates outside a field, with no way to turn it off: WCAG 2.1.4).
      e.preventDefault();
      shortcuts.open();
    }
  });

  // ---------------------------------------------------------------- start
  tab.onRole(applyRole);
  tab.onStale(() => void reloadFromStorage("tab"));
  tab.onCleared(() => void clearedElsewhere());
  await tab.start();
  applyRole();
  // What was open last time is read before the tree is drawn: the first layout is then the final
  // one (the editor head and the switch in place, "Opening main.py" where the code will be, never a
  // "No file open" that isn't true, and nothing moving when the code arrives: review S, 2026-10-18),
  // and the editor downloads alongside the tree and the stash instead of after them.
  const ui = await store.getUiState(ws).catch((): UiState => ({ openTabs: [], activePath: null, expanded: [] }));
  restoring = ui.openTabs.find((p) => p === ui.activePath) ?? ui.openTabs[0] ?? null;
  if (restoring !== null) prefetchEditor();
  tree.setExpanded(ui.expanded);
  await refreshTree();
  await recoverTyping();
  for (const path of ui.openTabs) {
    if (entries.some((e) => e.path === path && e.kind === "file" && !e.opaque) && !open.some((f) => f.path === path)) open.push({ id: newId(), path });
  }
  const start = open.find((f) => f.path === ui.activePath) ?? open[0];
  restoring = start?.path ?? null;
  if (start) await activate(start.id);
  restoring = null;
  renderTabs();
  afterActiveChange();
  setRunning("idle");
  void refreshSyncCount();
  const rev = (await store.getWorkspace(ws))?.rev;
  if (rev !== undefined) tab.seen(rev);
  // Cleared in another tab while this one was starting: never load a sign-in.
  if (wiped) return;

  sync = mountSync({
    db,
    store,
    ws,
    tab,
    editors: () => editors,
    settings,
    notice,
    announce: (text) => announcer.say(text),
    statusSlot: L.syncSlot,
    flushSaves: async () => void (await saves.flushAll()),
    reload: async () => reloadFromStorage("sync"),
    openFile: async (path) => void (await openFile(path, { focus: true })),
    refreshWorkspaceInfo: async () => {
      const rec = await store.getWorkspace(ws);
      if (!rec) return;
      record = rec;
      renderWorkspaceName();
      void refreshSyncCount();
    },
  });
  // The sidebar starts with the workspace, or with the repository once one is connected (one name
  // for one thing), and where it lives.
  function renderWorkspaceName() {
    L.wsName.textContent = record.name;
    L.wsName.hidden = Boolean(record.remote);
    L.repoName.hidden = !record.remote;
    L.repoName.textContent = record.remote ? `${record.remote.owner}/${record.remote.repo}` : "";
    L.wsOwner.textContent = record.remote ? "On GitHub" : "On this computer";
  }
  renderWorkspaceName();
  void refreshSyncCount();
  started = true;
  root.dataset.state = "ready";
  // Once after an update (never on a first visit): a quiet notice that stays until it is dismissed.
  let browserStore: Storage | null = null;
  try {
    browserStore = localStorage;
  } catch {
    // storage blocked: nothing to compare with
  }
  // A workspace made before this page loaded means this student has been here before.
  const updated = whatsNew(browserStore, __APP_VERSION__, record.createdAt < performance.timeOrigin);
  if (updated) {
    notice.show(`Updated to ExecFlow ${updated}.`, {
      tone: "info",
      action: { label: "What's new", run: () => void window.open("/about#changelog", "_blank", "noopener,noreferrer") },
      pin: { key: "whats-new" },
    });
  }

  // The site's move to a new address (src/ui/address-move.ts): only at the old and the new address,
  // after the What's new notice so the move's notice is the one that stays.
  if (moveRole(location.origin, __MOVE_FROM__, __MOVE_TO__)) {
    void import("./address-move").then(
      (m) =>
        !wiped &&
        m.startAddressMove({
          root,
          notice,
          canWrite,
          readOnlyText,
          flush: async () => void (await saves.flushAll()),
          buildZip: () => workspaceZip(store, ws),
          downloadZip: () => void exportWorkspace(),
          // The normal zip import: readZip checks names, sizes, entry counts and bombs; importFiles
          // checks every name and byte again, never replaces a file, and needs the writer lock.
          prepareImport: async (zip) => {
            const { readZip } = await import("../storage/zip");
            const contents = await readZip(new Uint8Array(await zip.arrayBuffer()));
            return {
              count: contents.files.length,
              apply: async () => {
                const result = await store.importFiles(ws, "", contents.files.map((f) => ({ name: f.path, bytes: f.bytes })), { dirs: contents.dirs });
                await refreshTree();
                return { added: result.added.length, skipped: contents.refused.length + result.refused.length };
              },
            };
          },
        }),
      () => {
        // The chunk didn't load (offline at the old address): the site still works as before.
      },
    );
  }

  // Code links (src/core/code-link.ts): a page opened with #code= offers that file, and so does one
  // pasted into this tab's address bar later (only the fragment changes, so the page doesn't reload).
  let codeLinkChunk: Promise<typeof import("./code-link-dialog")> | null = null;
  function takeCodeLink() {
    const hash = location.hash;
    if (!hash.startsWith("#code=") || wiped) return;
    codeLinkChunk ??= import("./code-link-dialog");
    codeLinkChunk.then(
      (m) => {
        if (wiped) return;
        // The code leaves the address bar: a reload doesn't offer it again, and a bookmark doesn't keep it.
        // A read-only tab can't add it, so there it stays, to copy into the editing tab.
        if (location.hash === hash && canWrite()) history.replaceState(history.state, "", location.pathname + location.search);
        return m.openCodeLink(hash, { taken: (p) => entries.some((e) => foldKey(e.path) === foldKey(p)), add: (p, text) => addFile(p, text), addFolder, notice });
      },
      () => {
        codeLinkChunk = null;
        notice.show("The code link couldn't open. Check the connection, then reload the page.");
      },
    );
  }
  // /move runs without cross-origin isolation (vite.config.ts "/move"), so another site that opened
  // it can keep a handle to the tab and change its fragment: there code links are never taken.
  if (location.pathname === MOVE_PATH) root.dataset.codeLinks = "off";
  else {
    takeCodeLink();
    window.addEventListener("hashchange", takeCodeLink);
  }
}
