// The workbench skeleton (Workbench Pro, stage S2, 2026-10-29: .claude/design/redesign5/a/design.md).
// From 900 px: a 64 px activity rail (Files, Search, Flowchart, New file; Shortcuts and Settings at
// its foot), the file sidebar (the workspace, the tree, and a foot with notices, the sync status and
// About), and the work column: a breadcrumb top bar ("Workspace / main.py", "Search or run a
// command" in the middle, the runtime state, Capture and Run with its key), then the code card and
// the console card (Output, Problems, Flowchart as a segmented control, full screen and hide at the
// head's end), docked under the code with a y-axis splitter. Hidden (collapsed), it is its head.
// Flow Board (redesign 7, S1, 2026-11-01: .claude/design/redesign7/a/design.md): from 1100 px the
// code and its console form the code board, and the flowchart leaves the console for a chart board
// of its own beside it, shown while a file is open (the console's Flowchart tab is hidden there; the
// chart's body, #panel-flowchart, moves between the two). Under 1100 px the chart stays the
// console's third tab, as before. Below 900 px the sidebar is a drawer, and a status bar holds the
// facts and notices (the phone layout below).
// Phone layout, option A "Segment and dock" (owner's pick, 2026-11-03:
// .claude/design/redesign8/phone/options.html): below 900 px the top bar holds the mark, the file's
// name (it opens Files), the sync status, Search and Settings; a Code | Flowchart segment sits under
// it; the console is one dock at the foot: the run strip (Run in the thumb zone, the run's outcome,
// the runtime state), the last lines of the same #console, and the problems count with "All output,
// N lines", which opens the whole console over the board. With the on-screen keyboard open the dock
// is its strip alone, a 56 px accessory bar (Hide keyboard, the state, Run). The chart's body lives on
// the chart board here too (the board shows while the segment says Flowchart).
// Flow Board S2 (2026-11-02): from 1100 px the rail and the sidebar column retire. The file list
// opens as a popover from Files in the code board's head; Run, the run's outcome, the runtime state
// and the problems count form the run strip at the code board's foot (the console's first row);
// the top bar holds the mark, the breadcrumb and the sync status, Search, then Capture, Shortcuts,
// Settings and About.
// Those elements are moved, never copied: ids stay unique and the DOM order is the visual order,
// so the Tab order follows what is seen (CSS `order` would split the two).
import type { WsPath } from "../core/types";
import { brandMarkSvg } from "../editor/brand-mark";
import { ariaMod, h, isMac, srOnly } from "./dom";
import { icon } from "./icons";
import { BOARD_GAP, besideNow, chartDefault, chartMax, CHART_MIN, CONSOLE_GAP, consoleDefault, consoleMax, CONSOLE_MIN } from "./board-size";
import { chartPanelSize } from "./panel-size";
import { KeyboardWatch } from "./keyboard";
import { clamp, createSplitter, readLayoutFlag, writeLayoutFlag, type Splitter } from "./splitter";

export const NARROW = "(max-width: 899px)";
/** From here the chart has a board of its own beside the code board (Flow Board, app.css). */
export const WIDE = "(min-width: 1100px)";
/** A short window (app.css): the page scrolls as a whole. */
export const SHORT = "(max-height: 420px)";
export const SIDEBAR = { min: 200, max: 480, initial: 248 };
export const PANEL = { min: 15, max: 80, initial: 35 };
/** The rail's width, and what the work column keeps at the least beside the sidebar. */
const RAIL_W = 64;
const WORK_KEEP = 560;

/**
 * What fills the screen below 900 px: the segment's Code or Flowchart over the dock's peek, or
 * Output or Problems, the dock opened over the board (phone layout, option A).
 */
export type View = "code" | "output" | "problems" | "flowchart";
/** Phones: the dock's last lines of output under the board, or the whole console in its place. */
export type Dock = "peek" | "all";
export type PanelTab = "output" | "problems" | "flowchart";
const PANEL_TABS: readonly PanelTab[] = ["output", "problems", "flowchart"];

/** The app's mark: the logo itself (the favicon's gradient tile and white chevrons), the same in every theme. */
export function brandMark(): SVGSVGElement {
  const mark = brandMarkSvg(document, 20);
  mark.classList.add("brand-mark");
  return mark;
}

/**
 * A file name as its stem and its extension, so a name cut short keeps the extension ("finding_t...
 * .py"): the stem takes the ellipsis (app.css). A name without one, or a dot file (".gitignore"),
 * is all stem.
 */
function nameParts(name: string): HTMLElement[] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [h("span", { class: "crumb-stem" }, name)];
  return [h("span", { class: "crumb-stem" }, name.slice(0, dot)), h("span", { class: "crumb-ext" }, name.slice(dot))];
}

export interface Layout {
  root: HTMLElement;
  /** Files: shows and hides the file list (the rail from 900 px, the view bar's drawer below). */
  drawerToggle: HTMLButtonElement;
  wsName: HTMLElement;
  repoName: HTMLElement;
  /** Under the workspace's name: where it lives ("On this computer", "On GitHub"). */
  wsOwner: HTMLElement;
  /** The rail's actions (Search, Flowchart, New file): workbench.ts gives them their work. */
  quick: { search: HTMLButtonElement; flowchart: HTMLButtonElement; newFile: HTMLButtonElement };
  syncSlot: HTMLElement;
  runButton: HTMLButtonElement;
  runLabel: HTMLElement;
  settingsButton: HTMLButtonElement;
  /** "Search or run a command": opens the command palette (workbench.ts). */
  paletteButton: HTMLButtonElement;
  sidebar: HTMLElement;
  sidebarActions: HTMLElement;
  treeHost: HTMLElement;
  center: HTMLElement;
  banner: HTMLElement;
  bannerText: HTMLElement;
  bannerButton: HTMLButtonElement;
  tabHost: HTMLElement;
  /** "Error in calc.py, line 2" in the editor head: hidden until a run fails in another file. */
  errorJump: HTMLButtonElement;
  errorJumpWords: HTMLElement;
  /** Capture snippet of the selected lines: in the top bar before Run (desktop only: phones reach it from the code menu). */
  snippetButton: HTMLButtonElement;
  editorPanel: HTMLElement;
  editorHost: HTMLElement;
  emptyHost: HTMLElement;
  panel: HTMLElement;
  panelTabs: { output: HTMLButtonElement; problems: HTMLButtonElement; flowchart: HTMLButtonElement; count: HTMLElement };
  /** Hides the console to its head and shows it again (aria-expanded; desktop only). */
  panelToggle: HTMLButtonElement;
  /** The console head's tools before Hide (full screen: workbench.ts). */
  panelHeadTools: HTMLElement;
  /** The Output tab's tool row (Input, Restart Python, Clear: workbench.ts). */
  panelActions: HTMLElement;
  outputPanel: HTMLElement;
  problemsPanel: HTMLElement;
  /** The Flowchart tab's body: the view (src/ui/flowchart-view.ts, a lazy chunk) fills it on first opening. */
  flowchartPanel: HTMLElement;
  /** The chart board (1100 px and wider, while a file is open): it holds flowchartPanel there. */
  chartBoard: HTMLElement;
  /** Whether the chart has its own board at this width (1100 px and wider). */
  chartOnBoard(): boolean;
  /** The run strip's slot for the run's outcome (#receipt moves here from 1100 px: workbench.ts). */
  runOutcome: HTMLElement;
  /** "No problems" or "2 problems, line 12" beside Run (1100 px and wider): opens Problems. */
  problemsButton: HTMLButtonElement;
  problemsWords: HTMLElement;
  /** Called after the layout crossed the 1100 px line (the Flow Board shell). */
  onWideChange(listener: (wide: boolean) => void): void;
  /**
   * Whether the flowchart is on screen: its board while a file is open (1100 px and wider), its
   * panel tab open (900 to 1099 px), its view (phones).
   */
  chartVisible(): boolean;
  /** Called whenever chartVisible() may have changed. */
  onChartVisibleChange(listener: (visible: boolean) => void): void;
  /** The notice slot: in the sidebar's foot from 900 px, in the status bar below. */
  noticeHost: HTMLElement;
  status: { lang: HTMLElement; pos: HTMLElement; runtime: HTMLElement; shortcuts: HTMLButtonElement };
  /** Phones: the Code | Flowchart segment under the top bar. */
  viewTabs: { code: HTMLButtonElement; flowchart: HTMLButtonElement };
  /**
   * Phones: "All output, 8 lines" at the dock's foot, a disclosure (aria-expanded): the dock shows
   * the last lines of the output (peek), or the whole console over the code (all).
   */
  dockToggle: HTMLButtonElement;
  /** Phones, the on-screen keyboard open: the accessory bar's Hide keyboard (the code lets go of the focus). */
  hideKeyboard: HTMLButtonElement;
  /** Phones: how many lines the output has, for the dock's foot ("All output, 8 lines"). */
  setDockLines(lines: number): void;
  dock(): Dock;
  /** Phones: the dock's peek or the whole console. Peek also shows the code (or the chart) again. */
  setDock(dock: Dock): void;
  onDockChange(listener: (dock: Dock) => void): void;
  /**
   * The file list's width and the console's height (desktop): buttons resize them without dragging.
   * From 1100 px also the chart board's width and the output's width beside the code.
   */
  splitters: { sidebar: Splitter; panel: Splitter; board: Splitter; console: Splitter };
  /**
   * The Flow Board's layout choices (1100 px and wider; owner's report on 0.26.0, 2026-11-02). Each
   * is remembered on this device except focus, a mode.
   */
  board: {
    /** Whether the chart board is hidden by choice (Hide flowchart; the code board's Flowchart brings it back). */
    chartHidden(): boolean;
    /** Hides or shows the chart board. Showing it also leaves focus code. */
    setChartHidden(hide: boolean): void;
    /** Whether the output is asked to stand beside the code, and whether it does now (room for it). */
    besideWanted(): boolean;
    besideShown(): boolean;
    setBeside(on: boolean): void;
    /** Focus code: the code board alone on the canvas, its console the run strip. */
    focusMode(): boolean;
    setFocusMode(on: boolean): void;
  };
  /** Words the layout wants said in the notice (why the output can't stand beside the code). */
  onSay(listener: (words: string) => void): void;
  narrow(): boolean;
  /** Called after the layout crossed the 900 px line (and moved Run and the runtime state). */
  onNarrowChange(listener: (narrow: boolean) => void): void;
  /**
   * Shows the file list: the drawer below 900 px (focus goes into it), the sidebar if hidden from
   * 900 px, the Files popover from 1100 px (focus goes into it).
   */
  openDrawer(): void;
  closeDrawer(focusToggle?: boolean): void;
  drawerOpen(): boolean;
  /** Narrow screens: which of Code / Output / Problems / Flowchart fills the screen. */
  showView(view: View): void;
  view(): View;
  /**
   * Selects a panel tab and opens the panel if it is collapsed. The flowchart where it has a board
   * of its own: nothing to select (a hidden board shows again); `focus` takes focus to the board.
   * Either leaves focus code, unless `stay` (a run's start: the run strip reports it there).
   */
  showPanelTab(tab: PanelTab, focus?: boolean, stay?: boolean): void;
  panelTab(): PanelTab;
  /** The panel starts collapsed to its bar (desktop) until the first run or problem. */
  expandPanel(): void;
  collapsePanel(): void;
  panelCollapsed(): boolean;
  /**
   * The breadcrumb's file part: the open file's folders and name (null: none open). `dirty`: the
   * file has unsaved typing, shown as a tab shows it (phones have no tab strip).
   */
  setCrumb(path: WsPath | null, dirty?: boolean): void;
}

export function createLayout(root: HTMLElement): Layout {
  const narrowQuery = matchMedia(NARROW);
  const wideQuery = matchMedia(WIDE);
  const shortQuery = matchMedia(SHORT);

  const mod = isMac() ? "Cmd" : "Ctrl";
  const m = ariaMod();
  const mark = brandMark();
  // ---------------------------------------------------------------- top bar
  // The breadcrumb: the workspace's name, the open file's folders (the secondary tier) and its name
  // (the name font, in --text). Text, not links; the slashes between them are decorative. Phones
  // show the file name only.
  // The root carries the slash after it (hidden while it stands alone), so a file's own segment is
  // just its name, as before.
  const crumbRoot = h("li", { class: "crumb-root" }, h("span", { class: "crumb-text" }, "Workspace"), h("span", { class: "crumb-sep", "aria-hidden": "true" }, "/"));
  const crumb = h("ol", { class: "crumb", "aria-label": "Open file" }, crumbRoot);
  const syncSlot = h("div", { class: "sync-slot", id: "sync-slot" });
  const runLabel = h("span", { class: "run-label" }, "Run");
  // The key is on the fill (Workbench Pro), shown, not read: aria-keyshortcuts says it.
  const runKey = h("span", { class: "run-key", "aria-hidden": "true" }, `${mod} ${String.fromCodePoint(0x21b5)}`);
  const runButton = h(
    "button",
    { type: "button", class: "btn primary run", id: "run-button", "data-running": "false", "aria-keyshortcuts": `${m}+Enter`, title: `Run (${mod}+Enter)` },
    h("span", { class: "run-icon" }, icon("play-fill")),
    runLabel,
    runKey,
  );
  // Settings: its word under its icon in the rail, the icon alone in the phone's top bar.
  const settingsButton = h("button", { type: "button", class: "icon-btn rail-btn", id: "settings-button", "aria-label": "Settings", title: "Settings" }, icon("gear"), h("span", { class: "rail-label" }, "Settings"));
  // The command palette's visible way in (Ctrl+P, F1 and Ctrl+Shift+P are its keys): a field-like
  // button in the middle of the top bar, its words and its key on it; below 900 px it is the
  // magnifier alone (44 px). Named by its words (WCAG 2.5.3); the keycap is shown, not read
  // (aria-keyshortcuts says it).
  const paletteButton = h(
    "button",
    {
      type: "button", class: "palette-btn", id: "palette-button", "aria-label": "Search or run a command", "aria-haspopup": "dialog",
      "aria-keyshortcuts": `${m}+P ${m}+Shift+P F1`, title: `Search or run a command (${mod}+P)`,
    },
    icon("magnifying-glass"),
    h("span", { class: "palette-btn-label" }, "Search or run a command"),
    h("kbd", { class: "keycap palette-key", "aria-hidden": "true" }, `${mod} P`),
  );
  // Two ends with the field between them; place() moves what each end holds at 900 px.
  const topStart = h("div", { class: "topbar-start" }, crumb);
  const topEnd = h("div", { class: "topbar-end" });
  const topbar = h("header", { class: "topbar" }, topStart, paletteButton, topEnd);

  // ---------------------------------------------------------------- rail
  // Files shows and hides the file list (from 900 px; below that it opens the drawer). Its word is
  // its name. On phones it is the open file's name in the top bar, with a caret (app.css shows one
  // or the other): named "Files: main.py" there, so the name it shows is in the name it has.
  const filesName = h("span", { class: "files-name" });
  const drawerToggle = h(
    "button",
    { type: "button", class: "rail-btn drawer-toggle", "aria-label": "Files", "aria-expanded": "true", "aria-controls": "sidebar", title: "Files" },
    icon("sidebar-simple"),
    h("span", { class: "rail-label" }, "Files"),
    filesName,
    icon("caret-down", "files-caret"),
  );
  // The rail's actions, each its icon over its word; Search keeps its real key in aria-keyshortcuts.
  const railButton = (id: string, iconName: Parameters<typeof icon>[0], label: string, keys?: string) =>
    h("button", { type: "button", class: "rail-btn", id, ...(keys ? { "aria-keyshortcuts": keys, title: `${label} (${mod}+P)` } : { title: label }) }, icon(iconName), h("span", { class: "rail-label" }, label));
  const quick = {
    search: railButton("quick-search", "magnifying-glass", "Search", `${m}+P`),
    flowchart: railButton("quick-flowchart", "tree-structure", "Flowchart"),
    newFile: railButton("quick-new-file", "plus", "New file"),
  };
  // Shortcuts and Settings join the foot from 900 px (place()).
  const railFoot = h("div", { class: "rail-foot" });
  // The rail heads with the mark on a 32 px brand tile of its own (the glyph keeps the 20 px icon size).
  const railMark = h("div", { class: "rail-mark" }, mark);
  const rail = h("nav", { class: "rail", "aria-label": "Activity" }, railMark, drawerToggle, quick.search, quick.flowchart, quick.newFile, railFoot);

  // ---------------------------------------------------------------- sidebar
  // The workspace at the top: its name (or the repository's, once connected) and where it lives.
  // A heading, not a menu: there is one workspace.
  const wsName = h("span", { class: "ws-name", id: "ws-name" }, "Workspace");
  const repoName = h("span", { class: "ws-name repo-name", id: "repo-name" });
  repoName.hidden = true;
  const wsOwner = h("span", { class: "ws-owner" }, "On this computer");
  const wsTitle = h("strong", { class: "ws-title" }, wsName, repoName);
  const switcher = h("div", { class: "ws-switcher" }, h("p", { class: "ws-text" }, wsTitle, wsOwner));
  const sidebarActions = h("div", { class: "sidebar-actions" });
  const treeHost = h("div", { class: "tree-host" });
  // The foot (900 px and wider): notices over the sync status and About; below that they live in
  // the top bar and the status bar, and the foot is empty (place()).
  const footRow = h("div", { class: "sidebar-foot-row" });
  const sidebarFoot = h("div", { class: "sidebar-foot" }, footRow);
  const sidebar = h(
    "nav",
    { class: "sidebar", id: "sidebar", "aria-labelledby": "files-title" },
    switcher,
    h("div", { class: "sidebar-head" }, h("h2", { class: "region-title", id: "files-title" }, "Files"), sidebarActions),
    treeHost,
    sidebarFoot,
  );

  // ---------------------------------------------------------------- the code card
  const bannerText = h("p", { class: "banner-text" });
  const bannerButton = h("button", { type: "button", class: "btn small", id: "edit-here" }, "Edit here");
  const banner = h("div", { class: "banner", id: "read-only-banner", role: "status" }, icon("lock", "banner-icon"), bannerText, bannerButton);
  banner.hidden = true;
  const tabHost = h("div", { class: "tab-host" });
  const errorJumpWords = h("span", { class: "jump-words" });
  const errorJump = h("button", { type: "button", class: "error-jump", id: "error-jump" }, icon("x-circle"), errorJumpWords);
  errorJump.hidden = true;
  // Capture snippet (an image of the selected lines): a ghost button before Run in the top bar. Its
  // name is static (the selection changes on every keystroke) and starts with the word it shows
  // (WCAG 2.5.3).
  const snippetButton = h(
    "button",
    { type: "button", class: "btn ghost capture-btn", id: "snippet-button", "aria-label": "Capture snippet of the selected lines", title: "Capture snippet of the selected lines" },
    icon("camera"),
    h("span", { class: "capture-label" }, "Capture"),
  );
  // The editor head: the tabs on the left, the error jump on the right (phones have no head, and
  // keep Capture there out of sight: they reach it from the code menu).
  // From 1100 px the head ends with the board's own tools: Flowchart (while the chart board is
  // hidden, it brings it back) and Focus code (the code board alone; Shift Alt Enter, Visual
  // Studio's full-screen key). Toggles named by what they do, their state in aria-pressed.
  const chartToggle = h(
    "button",
    { type: "button", class: "board-tool chart-toggle", id: "chart-toggle", "aria-pressed": "false", "aria-controls": "chart-board", title: "Show the flowchart beside the code" },
    icon("tree-structure"),
    h("span", { class: "board-tool-label" }, "Flowchart"),
  );
  chartToggle.hidden = true;
  const focusButton = h("button", {
    type: "button", class: "board-tool focus-toggle", id: "focus-code", "aria-pressed": "false", "aria-label": "Focus code", "aria-keyshortcuts": "Shift+Alt+Enter",
  });
  const headTools = h("div", { class: "head-tools" }, errorJump, chartToggle, focusButton);
  const editorHead = h("div", { class: "editor-head" }, tabHost, headTools);
  const editorHost = h("div", { class: "editor-host", id: "editor-host" });
  const emptyHost = h("div", { class: "editor-empty", id: "editor-empty" });
  // Empty until a file is active (workbench renderEmpty): the editor may load before then (start-up
  // fetches it at once for a returning user), and its blank view stays out of sight.
  const editorPanel = h("div", { class: "editor-panel", id: "editor-panel", "data-empty": "true" }, editorHost, emptyHost);
  // The card's foot (900 px and wider): the file's language and Ln/Col (the status bar below).
  const editorFoot = h("div", { class: "editor-foot" });
  // The Files popover (1100 px and wider): the sidebar moves into it (place()). A non-modal dialog
  // named by the sidebar's own "Files" heading, right after the head that holds its button, so the
  // Tab order meets it where it is seen.
  const filesPop = h("div", { class: "files-pop", id: "files-popover", role: "dialog", "aria-labelledby": "files-title" });
  filesPop.hidden = true;
  const editorArea = h("div", { class: "editor-area", id: "editor-area" }, banner, editorHead, filesPop, editorPanel, editorFoot);

  // Phones: the Code | Flowchart segment under the top bar (the dock below shows the output).
  const viewTab = (id: string, controls: string, iconName: Parameters<typeof icon>[0], label: string, selected: boolean) =>
    h(
      "button",
      { type: "button", role: "tab", id, "aria-controls": controls, "aria-selected": String(selected), ...(selected ? {} : { tabindex: "-1" }) },
      icon(iconName),
      h("span", { class: "view-label" }, label),
    );
  const viewCode = viewTab("view-code", "editor-area", "code-simple", "Code", true);
  const viewFlowchart = viewTab("view-flowchart", "chart-board", "tree-structure", "Flowchart", false);
  const viewSwitch = h("div", { class: "view-switch", role: "tablist", "aria-label": "View" }, viewCode, viewFlowchart);
  const viewBar = h("nav", { class: "view-bar", "aria-label": "Views" }, viewSwitch);

  // ---------------------------------------------------------------- the console card
  const count = h("span", { class: "count", "data-count": "0" });
  const ptabOutput = h("button", { type: "button", role: "tab", id: "ptab-output", "aria-controls": "panel-output", "aria-selected": "true" }, "Output");
  const ptabProblems = h("button", { type: "button", role: "tab", id: "ptab-problems", "aria-controls": "panel-problems", "aria-selected": "false", tabindex: "-1" }, "Problems", count);
  const ptabFlowchart = h("button", { type: "button", role: "tab", id: "ptab-flowchart", "aria-controls": "panel-flowchart", "aria-selected": "false", tabindex: "-1" }, "Flowchart");
  const panelTabsEl = h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel" }, ptabOutput, ptabProblems, ptabFlowchart);
  // From 1100 px the tabs give way (the run strip's count is the one way to the problems: owner,
  // 2026-11-02, "Problems shows twice"): the head names what the console shows, and while it shows
  // Problems, Output goes back. Under 1100 px the tabs stay (app.css).
  const panelTitle = h("h2", { class: "panel-title", id: "panel-title" }, "Output");
  const panelBack = h("button", { type: "button", class: "btn ghost small panel-back", id: "panel-back", "aria-controls": "panel-output" }, icon("terminal-window"), "Output");
  panelBack.hidden = true;
  const panelToggle = h("button", { type: "button", class: "icon-btn panel-toggle", id: "panel-toggle", "aria-label": "Output and problems", "aria-expanded": "false", "aria-controls": "panel-output panel-problems panel-flowchart" });
  // Output below or beside the code (1100 px and wider), before Maximise (workbench.ts adds it): named
  // by the place it moves the output to (syncBoards).
  const besideToggle = h("button", { type: "button", class: "icon-btn small panel-beside", id: "panel-beside" });
  const panelHeadTools = h("div", { class: "panel-head-tools" }, besideToggle);
  const panelActions = h("div", { class: "panel-actions" });
  const outputPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-output", "aria-labelledby": "ptab-output" });
  const problemsPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-problems", "aria-labelledby": "ptab-problems", tabindex: "0" });
  problemsPanel.hidden = true;
  const flowchartPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-flowchart", "aria-labelledby": "ptab-flowchart" });
  flowchartPanel.hidden = true;
  // The run strip (1100 px and wider): the console's first row, at the code board's foot. Run (its
  // key on it), the run's outcome (#receipt, workbench.ts), the runtime state and the problems
  // count; a notice takes a line of its own under them. Empty and not shown under 1100 px (place()).
  const runOutcome = h("div", { class: "run-outcome" });
  const problemsWords = h("span", { class: "problems-words" }, "No problems");
  const problemsButton = h(
    "button",
    { type: "button", class: "problems-count", id: "problems-count", "aria-controls": "panel-problems", "data-count": "0", title: "Show the problems list" },
    icon("check-circle"),
    problemsWords,
  );
  const runStrip = h("div", { class: "run-strip" });
  // Phones: the dock's foot, the problems count and All output (a disclosure of the whole console:
  // its name keeps its words, aria-expanded says which way it is open; the caret turns).
  const dockWords = h("span", { class: "dock-words" }, "All output");
  const dockToggle = h(
    "button",
    { type: "button", class: "btn dock-toggle", id: "dock-toggle", "aria-expanded": "false", "aria-controls": "panel" },
    dockWords,
    icon("caret-up", "dock-caret"),
  );
  const dockFoot = h("div", { class: "dock-foot" });
  // Phones, the on-screen keyboard open: the accessory bar's first control. It takes no focus on a
  // press (layout.ts below), so the code keeps the caret until it lets go of it.
  const hideKeyboard = h(
    "button",
    { type: "button", class: "icon-btn hide-keyboard", id: "hide-keyboard", "aria-label": "Hide keyboard", title: "Hide keyboard" },
    icon("keyboard"),
    icon("caret-down", "hide-keyboard-caret"),
  );
  const panel = h(
    "section",
    { class: "panel", id: "panel", "aria-label": "Output and problems", "data-tab": "output", "data-dock": "peek" },
    runStrip,
    h("div", { class: "panel-bar" }, panelTabsEl, panelTitle, panelBack, panelHeadTools, panelToggle),
    panelActions,
    outputPanel,
    problemsPanel,
    flowchartPanel,
    dockFoot,
  );
  const ptabs: Record<PanelTab, HTMLButtonElement> = { output: ptabOutput, problems: ptabProblems, flowchart: ptabFlowchart };
  const bodies: Record<PanelTab, HTMLElement> = { output: outputPanel, problems: problemsPanel, flowchart: flowchartPanel };
  const currentTab = (): PanelTab => (PANEL_TABS.includes(panel.dataset.tab as PanelTab) ? (panel.dataset.tab as PanelTab) : "output");

  // ---------------------------------------------------------------- the chart board (1100 px and wider)
  // A region of its own beside the code board, named "Flowchart" (the view's bar heads it with the
  // same word); app.css shows it while a file is open. Focusable from script only (the rail's
  // Flowchart takes focus there), never a Tab stop.
  const chartBoard = h("section", { class: "chart-board", id: "chart-board", "aria-label": "Flowchart", tabindex: "-1" });
  // Hide flowchart: at the end of the chart's bar (over it: the bar is the lazy view's, and hides
  // itself while nothing is drawn, so the board keeps this one in every state). First in the
  // board's Tab order, as a region's own close is.
  const chartHide = h("button", { type: "button", class: "icon-btn chart-hide", id: "chart-hide", "aria-label": "Hide flowchart", "aria-controls": "chart-board", title: "Hide the flowchart (the code takes its room)" }, icon("caret-line-right"));
  chartBoard.append(chartHide);

  const center = h("div", { class: "center", "data-view": "code", "data-dock": "peek" }, editorArea);
  // The work column: the top bar over the two cards.
  // Why a disabled Run does nothing (its aria-describedby while no file is open: workbench.ts).
  const runWhy = h("span", { class: "visually-hidden", id: "run-why" }, "Open or create a file to run it.");
  const work = h("div", { class: "work" }, topbar, center, runWhy);
  const main = h("main", { class: "main" }, rail, sidebar);

  // ---------------------------------------------------------------- status bar (below 900 px)
  // Language, position, the runtime state, the notice slot (a live region: kept rendered while
  // empty), Shortcuts and About. From 900 px these move to the code card's foot, the top bar, the
  // sidebar's foot and the rail, and the bar is empty (place()).
  const status = {
    lang: h("span", { class: "status-item", id: "status-lang" }),
    pos: h("span", { class: "status-item", id: "status-pos" }),
    runtime: h("span", { class: "status-item runtime", id: "status-runtime", "data-state": "idle" }),
    shortcuts: h("button", { type: "button", class: "status-btn", id: "shortcuts-button", title: `Keyboard shortcuts (${mod}+/)` }, icon("keyboard"), h("span", { class: "status-btn-label" }, "Shortcuts")),
  };
  // A real link to About, always on screen: a crawler that renders the page (Googlebot) never reads
  // index.html's <noscript>, so this is how it finds About (SEO review, 2026-10-29).
  const aboutLink = h(
    "a",
    { class: "status-btn", id: "about-link", href: "/about", target: "_blank", rel: "noopener noreferrer", "aria-label": "About ExecFlow", title: "About ExecFlow (opens in a new tab)" },
    icon("info"),
    h("span", { class: "status-btn-label" }, "About"),
  );
  const noticeHost = h("div", { class: "notice-host" });
  const statusbar = h("footer", { class: "statusbar" });
  const scrim = h("div", { class: "drawer-scrim", "aria-hidden": "true" });

  // ---------------------------------------------------------------- splitters
  const sidebarSplit = createSplitter({
    orientation: "vertical",
    label: "Resize the file list",
    controls: "sidebar",
    min: SIDEBAR.min,
    max: () => Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, innerWidth - RAIL_W - WORK_KEEP)),
    initial: SIDEBAR.initial,
    step: 16,
    unit: "pixels wide",
    key: "sidebar",
    fromPointer: (e) => e.clientX - sidebar.getBoundingClientRect().left,
    apply: (v) => root.style.setProperty("--sidebar-w", `${v}px`),
  });
  const panelSplit = createSplitter({
    orientation: "horizontal",
    label: "Resize the output panel",
    controls: "panel",
    min: PANEL.min,
    max: () => PANEL.max,
    initial: PANEL.initial,
    step: 5,
    unit: "percent of the height",
    key: "panel",
    fromPointer: (e) => {
      const r = center.getBoundingClientRect();
      return clamp(((r.bottom - e.clientY) / Math.max(1, r.height)) * 100, PANEL.min, PANEL.max);
    },
    apply: (v) => {
      center.style.setProperty("--editor-rows", `${100 - v}fr`);
      center.style.setProperty("--panel-rows", `${v}fr`);
    },
  });
  // From 1100 px (owner's report on 0.26.0, 2026-11-02): the chart board's width beside the code
  // board, and the output's width while it stands beside the code. Pixels, each the region after
  // its bar (ArrowLeft grows it); the chart's default is the two equal boards, followed as the
  // window changes until a size is chosen. Both clamp to what the window allows now (sizeModel).
  // The choices they depend on (syncBoards applies them): the chart board hidden, the output asked
  // beside the code (and whether there is room for it now), and focus code.
  let chartHidden = readLayoutFlag("chartHidden") ?? false;
  let besideWanted = readLayoutFlag("consoleBeside") ?? false;
  let besideShown = false;
  let focusMode = false;
  /** The chart board takes its column: 1100 px and wider, a file open, not hidden, not focus code. */
  const chartShownNow = () => wideQuery.matches && root.dataset.open === "true" && !chartHidden && !focusMode;
  const boardsWidth = () => {
    const cs = getComputedStyle(center);
    return Math.max(0, center.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  };
  let consoleSplit: Splitter | null = null;
  const boardSplit = createSplitter({
    orientation: "vertical",
    label: "Resize the flowchart",
    controls: "chart-board",
    min: CHART_MIN,
    max: () => chartMax(boardsWidth(), besideShown),
    initial: () => chartDefault(boardsWidth()),
    after: true,
    step: 16,
    unit: "pixels wide",
    key: "chart",
    fromPointer: (e) => chartBoard.getBoundingClientRect().right - e.clientX - BOARD_GAP / 2,
    apply: (v) => {
      // The default split is two equal fractions, so the boards stay equal to the pixel.
      center.style.setProperty("--chart-w", v === chartDefault(boardsWidth()) ? "minmax(0, 1fr)" : `${v}px`);
      consoleSplit?.refresh();
    },
  });
  /** The code board's width: the boards' row less the chart board and the gap, while it shows. */
  const codeBoardWidth = () => boardsWidth() - (chartShownNow() ? BOARD_GAP + boardSplit.value : 0);
  consoleSplit = createSplitter({
    orientation: "vertical",
    label: "Resize the output panel",
    controls: "panel",
    min: CONSOLE_MIN,
    max: () => consoleMax(codeBoardWidth()),
    initial: () => consoleDefault(codeBoardWidth()),
    after: true,
    step: 16,
    unit: "pixels wide",
    key: "console",
    fromPointer: (e) => panel.getBoundingClientRect().right - e.clientX - CONSOLE_GAP / 2,
    apply: (v) => center.style.setProperty("--console-w", `${v}px`),
  });
  boardSplit.element.classList.add("board-split");
  consoleSplit.element.classList.add("console-split");
  center.append(panelSplit.element, consoleSplit.element, panel, boardSplit.element, chartBoard);
  main.append(sidebarSplit.element, work);
  root.replaceChildren(main, statusbar, viewBar, scrim);
  root.classList.add("workbench");
  // Nothing is open until the workbench says so (renderEmpty): no editor head, Capture or runtime
  // state yet, and Run disabled. Until it also knows whether there are files and which one it
  // reopens (data-files), the work column is laid out but unpainted (app.css), so nothing seen
  // there moves when the head or the console arrives (a layout shift: review S, 2026-10-18).
  root.dataset.open = "false";
  sidebarSplit.refresh();
  panelSplit.refresh();
  addEventListener("resize", () => sidebarSplit.refresh());
  // Dragging a collapsed panel's splitter opens the panel and resizes it. A key on it only opens it,
  // to the size the splitter names (one key, one effect): caught on the way down, before the
  // splitter's own handler would also apply a step.
  panelSplit.element.addEventListener("pointerdown", () => expandPanel());
  center.addEventListener(
    "keydown",
    (e) => {
      const keys = e.target === panelSplit.element ? ["ArrowUp", "ArrowDown"] : null;
      if (!keys || !panelCollapsed() || ![...keys, "Home", "End", "Enter"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      expandPanel();
    },
    true,
  );

  // ---------------------------------------------------------------- the workspace in the breadcrumb
  // The crumb starts with the name the sidebar heads with (the workspace's, or the repository's once
  // connected): copied whenever workbench.ts changes it.
  const syncCrumbRoot = () => {
    const name = (repoName.hidden ? wsName : repoName).textContent || "Workspace";
    crumbRoot.firstElementChild!.textContent = name;
  };
  new MutationObserver(syncCrumbRoot).observe(wsTitle, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });

  // ---------------------------------------------------------------- what moves at 900 px
  // Desktop: the rail's foot holds Shortcuts and Settings; the top bar's end the runtime state,
  // Capture and Run; the code card's foot the language and Ln/Col; the sidebar's foot the notices,
  // the sync status and About. Below 900 px (no editor head, the sidebar a drawer): the top bar holds
  // the mark, Files (the file's name), the sync status, Search and Settings; the segment comes under
  // it; the dock's strip holds Run, the run's outcome and the runtime state, its foot the problems
  // count and All output; the status bar the facts, the notices, Shortcuts and About.
  // From 1100 px (Flow Board S2): the top bar's start holds the mark, the breadcrumb and the sync
  // status; its end Capture, Shortcuts, Settings and About; Files heads the code board; the run strip
  // holds Run, the run's outcome, the runtime state and the problems count; notices float over the
  // code board's foot; the sidebar is the popover's.
  function place(narrow: boolean) {
    const focused = document.activeElement;
    const wide = !narrow && wideQuery.matches;
    if (!wide && filesPop.contains(sidebar)) main.insertBefore(sidebar, sidebarSplit.element);
    if (narrow) {
      // The top bar: the mark, the file's name (Files), then the sync status, Search and Settings.
      topStart.replaceChildren(mark, drawerToggle);
      topEnd.append(syncSlot, paletteButton, settingsButton);
      // The segment under the top bar; the dock: the strip, the console, then its foot.
      work.insertBefore(viewBar, center);
      runStrip.append(hideKeyboard, runOutcome, status.runtime, runButton);
      dockFoot.append(problemsButton, dockToggle);
      statusbar.append(status.lang, status.pos, noticeHost, status.shortcuts, aboutLink);
      headTools.append(snippetButton);
    } else if (wide) {
      root.insertBefore(viewBar, scrim);
      hideKeyboard.remove();
      topStart.replaceChildren(mark, crumb, syncSlot);
      topbar.insertBefore(paletteButton, topEnd);
      topEnd.append(snippetButton, status.shortcuts, settingsButton, aboutLink);
      editorHead.prepend(drawerToggle);
      runStrip.append(runButton, runOutcome, status.runtime, problemsButton);
      editorFoot.append(status.lang, status.pos);
      // Notices float over the code board's foot (app.css), so one coming or going never moves the code.
      editorArea.append(noticeHost);
      filesPop.append(sidebar);
    } else {
      // The phone's segment and Hide keyboard leave with the phone layout; the strip keeps the run's
      // outcome and the problems count, as before the dock (it is not shown here).
      root.insertBefore(viewBar, scrim);
      hideKeyboard.remove();
      runStrip.append(runOutcome, problemsButton);
      topStart.replaceChildren(crumb);
      railMark.append(mark);
      railMark.after(drawerToggle);
      topbar.insertBefore(paletteButton, topEnd);
      topEnd.append(status.runtime, snippetButton, runButton);
      editorFoot.append(status.lang, status.pos);
      sidebarFoot.insertBefore(noticeHost, footRow);
      footRow.append(syncSlot, aboutLink);
      railFoot.append(status.shortcuts, settingsButton);
    }
    // A moved element loses focus in some engines: it goes back to the control that had it.
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- the file list: drawer or sidebar
  // Below 900 px it is a drawer: while it is open, the code, the status bar and the views behind it
  // are inert; the top bar and Files stay usable, so the Files button that opened it also closes it.
  // Escape or a tap on the scrim close it too. From 900 px Files hides and shows the sidebar.
  const behind = () => [center, statusbar, viewSwitch];
  let sidebarShown = true;
  /** The Files popover's place: 1100 px and wider (the layout's side of the line, not the window's). */
  const popMode = () => filesPop.contains(sidebar);
  function syncFilesButton() {
    const pop = popMode();
    const open = narrowQuery.matches || pop ? drawerOpen() : sidebarShown;
    drawerToggle.setAttribute("aria-expanded", String(open));
    drawerToggle.setAttribute("aria-controls", pop ? "files-popover" : "sidebar");
    if (pop) drawerToggle.setAttribute("aria-haspopup", "dialog");
    else drawerToggle.removeAttribute("aria-haspopup");
    if (sidebarShown) delete root.dataset.sidebar;
    else root.dataset.sidebar = "hidden";
  }
  function drawerOpen() {
    return popMode() ? !filesPop.hidden && filesPop.dataset.state !== "closing" : root.dataset.drawer === "open";
  }
  // The popover's motion (Flow Board, design.md Motion): in, a 160 ms ease-out fade and a 4 px rise;
  // out, 120 ms ease-in. None under reduced motion. Closing, it stops taking pointers and focus at
  // once, and is hidden when its exit ends.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let popAnimation: Animation | null = null;
  function animatePop(open: boolean) {
    popAnimation?.cancel();
    popAnimation = null;
    if (reduceMotion.matches || typeof filesPop.animate !== "function") return null;
    const rest = { opacity: 1, transform: "translateY(0)" };
    const away = { opacity: 0, transform: "translateY(4px)" };
    popAnimation = filesPop.animate(open ? [away, rest] : [rest, away], open ? { duration: 160, easing: "cubic-bezier(0, 0, 0.2, 1)" } : { duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    return popAnimation;
  }
  /** Places the popover under its button (the head may sit under the read-only banner). */
  function anchorPop() {
    filesPop.style.top = `${drawerToggle.offsetTop + drawerToggle.offsetHeight + 4}px`;
    filesPop.style.left = `${Math.max(8, drawerToggle.offsetLeft)}px`;
  }
  function openPop() {
    if (drawerOpen()) return;
    delete filesPop.dataset.state;
    filesPop.inert = false;
    filesPop.hidden = false;
    anchorPop();
    syncFilesButton();
    animatePop(true);
    void getComputedStyle(filesPop).visibility;
    (sidebar.querySelector<HTMLElement>("[role=treeitem][tabindex='0']") ?? sidebar.querySelector<HTMLElement>("button"))?.focus();
  }
  /**
   * `focusToggle`: Files takes the focus (Escape, the button itself). Otherwise focus inside the
   * popover goes back to Files too, unless `pointer` (a press outside: focus goes where it pressed).
   */
  function closePop(focusToggle: boolean, pointer = false) {
    if (!drawerOpen()) return;
    const hadFocus = !pointer && filesPop.contains(document.activeElement);
    filesPop.dataset.state = "closing";
    filesPop.inert = true;
    syncFilesButton();
    const done = () => {
      if (filesPop.dataset.state !== "closing") return;
      delete filesPop.dataset.state;
      filesPop.hidden = true;
      popAnimation?.cancel();
      popAnimation = null;
    };
    const exit = animatePop(false);
    if (exit) exit.finished.then(done, () => {});
    else done();
    // Focus inside it would drop to the page: it goes back to Files.
    if (focusToggle || hadFocus) drawerToggle.focus();
  }
  function openDrawer() {
    if (popMode()) return openPop();
    if (!narrowQuery.matches) {
      sidebarShown = true;
      syncFilesButton();
      return;
    }
    // A short window scrolls the page (app.css): the drawer hangs from the top bar, so the page
    // goes to its top first (and stays there while the drawer is open).
    if (shortQuery.matches) scrollTo(0, 0);
    root.dataset.drawer = "open";
    syncFilesButton();
    sidebar.inert = false; // before moving focus in: an inert element can't take focus
    for (const el of behind()) el.inert = true;
    // WebKit can judge the row by the drawer's closed (hidden) style when nothing has made it compute
    // the open one yet, and refuse the focus (from the page body, 2 times in 6, 2026-10-25): reading
    // a computed value brings the style up to date first.
    void getComputedStyle(sidebar).visibility;
    (sidebar.querySelector<HTMLElement>("[role=treeitem][tabindex='0']") ?? sidebar.querySelector<HTMLElement>("button"))?.focus();
  }
  function closeDrawer(focusToggle = true) {
    if (popMode()) return closePop(focusToggle);
    if (!drawerOpen()) return;
    delete root.dataset.drawer;
    syncFilesButton();
    for (const el of behind()) el.inert = false;
    // The closed drawer is out of reach, not just off screen.
    sidebar.inert = narrowQuery.matches;
    if (focusToggle) drawerToggle.focus();
  }
  drawerToggle.addEventListener("click", () => {
    if (narrowQuery.matches || popMode()) return drawerOpen() ? closeDrawer() : openDrawer();
    // The focus stays on Files (it was pressed), so hiding the list never drops it to the page.
    sidebarShown = !sidebarShown;
    syncFilesButton();
    sidebarSplit.refresh();
  });
  scrim.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    // A menu's or a dialog's own Escape closes only that (the menu is gone by the time this runs,
    // but the key came from inside it).
    const from = e.target instanceof Element ? e.target : null;
    if (e.key === "Escape" && drawerOpen() && !e.defaultPrevented && !from?.closest(".menu, dialog") && !document.querySelector("dialog[open], .menu")) {
      e.preventDefault();
      closeDrawer();
    }
  });
  // The popover is light: a press anywhere else closes it (not on Files, which toggles it, nor in a
  // menu or dialog it opened), and so does focus moving on to another part of the page.
  const ownsPop = (node: EventTarget | null) =>
    node instanceof Node && (filesPop.contains(node) || drawerToggle.contains(node) || (node instanceof Element && node.closest(".menu, dialog") !== null));
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (popMode() && drawerOpen() && !ownsPop(e.target)) closePop(false, true);
    },
    true,
  );
  filesPop.addEventListener("focusout", (e) => {
    const next = e.relatedTarget;
    if (popMode() && drawerOpen() && next instanceof Element && !ownsPop(next)) closePop(false, true);
  });
  // ---------------------------------------------------------------- short windows
  // At 420 px tall or less the page scrolls as a whole (app.css). A text field that takes focus is
  // checked again once the layout has settled: the output log's blocks keep a placeholder height
  // until first drawn (content-visibility), so a waiting program's input field, scrolled to at
  // once, sat off screen a frame later (400% zoom, Chromium), or the run header above it went out
  // of sight (Firefox), 2026-10-24. A waiting program's input line goes to the window's foot, with
  // what leads to it (the prompt, the last lines, the run header) above it; any other field is
  // scrolled only when it is not wholly on screen.
  root.addEventListener("focusin", (e) => {
    const field = e.target;
    if (!shortQuery.matches || !(field instanceof HTMLElement) || !field.matches("input, textarea, select") || field.closest("dialog")) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (document.activeElement !== field || !shortQuery.matches) return;
        const line = field.closest<HTMLElement>(".live-input");
        if (line) return line.scrollIntoView({ block: "end" });
        const r = field.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight) field.scrollIntoView({ block: "nearest" });
      }),
    );
  });

  // ---------------------------------------------------------------- the console: hidden to its head
  // Desktop: the console is its head, docked under the code, until the first run or problem; then it
  // opens to the remembered size. A hidden body is hidden; the run's result is still read out by the
  // workbench's announcer, never by a hidden role=log. Below 900 px Output and Problems fill the
  // screen from the view bar, so nothing is hidden there.
  // Hidden to its head, the console docks under the code in either place: beside the code it
  // stands as a column only while open (so before the first run the code has the whole board).
  let collapsed = true;
  const panelCollapsed = () => collapsed && !narrowQuery.matches;
  /** Phones: the dock's peek, or the whole console over the board. */
  let dockNow: Dock = "peek";
  /** The open file's name and unsaved state (setCrumb), which Files shows on phones. */
  let crumbFile: { name: string; dirty: boolean } | null = null;
  /** From 1100 px the chart has a board of its own, and the console's Flowchart tab is hidden. */
  const chartOnBoard = () => wideQuery.matches;
  /** Where the chart's body lives on the chart board: 1100 px and wider, and phones (the segment's Flowchart). */
  const chartBoardHolds = () => wideQuery.matches || narrowQuery.matches;
  /** The console's tabs at this width. */
  const panelTabs = (): readonly PanelTab[] => (chartBoardHolds() ? PANEL_TABS.filter((t) => t !== "flowchart") : PANEL_TABS);
  function syncPanel() {
    const shut = panelCollapsed();
    panel.dataset.collapsed = String(shut);
    center.dataset.panel = shut ? "collapsed" : "open";
    panelToggle.setAttribute("aria-expanded", String(!shut));
    panelToggle.title = shut ? "Show the panel" : "Hide the panel";
    panelToggle.replaceChildren(icon(shut ? "caret-up" : "caret-down"));
    const tab = currentTab();
    for (const t of panelTabs()) bodies[t].hidden = shut || t !== tab;
    // On its board the chart's body always shows (the board itself shows while a file is open, or on
    // phones while the segment says Flowchart).
    if (chartBoardHolds()) flowchartPanel.hidden = false;
    // From 1100 px: the head's name, Output (back from Problems), and the count's state.
    const problemsOpen = chartOnBoard() && !shut && tab === "problems";
    panelTitle.textContent = tab === "problems" ? "Problems" : "Output";
    panelBack.hidden = !(chartOnBoard() && tab === "problems");
    // From 1100 px the count is the one way to the list, so it says whether the list is showing; on
    // phones it opens the list in the dock, and says so too.
    if (chartOnBoard()) problemsButton.setAttribute("aria-expanded", String(problemsOpen));
    else if (narrowQuery.matches) problemsButton.setAttribute("aria-expanded", String(dockNow === "all" && tab === "problems"));
    else problemsButton.removeAttribute("aria-expanded");
    // The splitter's value is the size the console opens to; while it is its head, it says so.
    if (shut) panelSplit.element.setAttribute("aria-valuetext", `Collapsed; opens at ${panelSplit.value} percent of the height`);
    else panelSplit.refresh();
    tellChart();
  }
  /**
   * Moves the chart's body to where it lives at this width: its board from 1100 px and on phones (a
   * plain part of the "Flowchart" region there), the console's third tab panel from 900 to 1099 px.
   * The element moves, so the view inside it (and its full-screen dialog's way back) keeps working;
   * focus inside it stays.
   */
  function placeChart() {
    const focused = document.activeElement;
    const onBoard = chartBoardHolds();
    if (onBoard && currentTab() === "flowchart") selectPanelTab("output");
    if (onBoard) {
      chartBoard.append(flowchartPanel);
      flowchartPanel.removeAttribute("role");
      flowchartPanel.removeAttribute("aria-labelledby");
    } else {
      panel.insertBefore(flowchartPanel, dockFoot);
      flowchartPanel.setAttribute("role", "tabpanel");
      flowchartPanel.setAttribute("aria-labelledby", "ptab-flowchart");
    }
    ptabFlowchart.hidden = onBoard;
    panelToggle.setAttribute("aria-controls", onBoard ? "panel-output panel-problems" : "panel-output panel-problems panel-flowchart");
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  }
  // ---------------------------------------------------------------- is the flowchart on screen?
  const chartListeners: ((visible: boolean) => void)[] = [];
  let chartWasVisible = false;
  // Hidden by choice or by focus code, the board's chart is off screen: it draws nothing until it
  // shows again (flowchart-view.ts setVisible), so typing never waits on it.
  const chartVisible = () =>
    narrowQuery.matches ? center.dataset.view === "flowchart" && dockNow === "peek" : chartOnBoard() ? chartShownNow() : !panelCollapsed() && currentTab() === "flowchart";
  // The board shows while a file is open (workbench.ts sets data-open): the chart is told at once,
  // and the boards are laid out again (the chart's column comes or goes).
  new MutationObserver(() => syncBoards()).observe(root, { attributes: true, attributeFilter: ["data-open"] });
  function tellChart() {
    const visible = chartVisible();
    if (visible === chartWasVisible) return;
    chartWasVisible = visible;
    if (visible && !narrowQuery.matches && !wideQuery.matches) growForChart();
    for (const listener of chartListeners) listener(visible);
  }
  /**
   * Under the code (900 to 1099 px): the Flowchart tab opening grows a small panel (panel-size.ts),
   * through the splitter, so its value and the remembered size agree. Never shrinks; leaving the
   * tab keeps the size; a size set later by dragging or keys stands until it is below the threshold
   * at another opening. From 1100 px the chart has its own board, so nothing grows.
   */
  function growForChart() {
    const rows = editorArea.getBoundingClientRect().height + panel.getBoundingClientRect().height;
    const next = chartPanelSize(panelSplit.value, rows, panelSplit.max());
    if (next !== null) panelSplit.set(next);
  }
  // Through syncBoards: opening or hiding the console also moves it beside the code or under it.
  function expandPanel() {
    collapsed = false;
    syncBoards();
  }
  function collapsePanel() {
    const active = document.activeElement;
    const inBody = active instanceof Node && (outputPanel.contains(active) || problemsPanel.contains(active));
    collapsed = true;
    syncBoards();
    // Focus inside the body would go to the page: it stays on the control that collapsed it.
    if (inBody) panelToggle.focus();
  }
  panelToggle.addEventListener("click", () => (panelToggle.getAttribute("aria-expanded") === "true" ? collapsePanel() : expandPanel()));

  // ---------------------------------------------------------------- phones: the segment and the dock
  // The segment picks the board (Code or Flowchart, center[data-view]); the dock (panel[data-dock])
  // shows the output's last lines under it, or the whole console in its place. Output and Problems
  // are the dock opened.
  type Seg = "code" | "flowchart";
  const switchTabs: [HTMLButtonElement, Seg][] = [[viewCode, "code"], [viewFlowchart, "flowchart"]];
  const segNow = (): Seg => (center.dataset.view === "flowchart" ? "flowchart" : "code");
  function markView(seg: Seg) {
    center.dataset.view = seg;
    for (const [tab, v] of switchTabs) {
      tab.setAttribute("aria-selected", String(v === seg));
      tab.tabIndex = v === seg ? 0 : -1;
    }
    tellChart();
  }
  const dockListeners: ((dock: Dock) => void)[] = [];
  function setDock(dock: Dock) {
    if (dock === dockNow) return;
    const active = document.activeElement;
    dockNow = dock;
    panel.dataset.dock = dock;
    center.dataset.dock = dock;
    dockToggle.setAttribute("aria-expanded", String(dock === "all"));
    // Back to the peek, the dock shows the output's last lines again (not the problems list).
    if (dock === "peek" && currentTab() !== "output") selectPanelTab("output");
    else syncPanel();
    // Focus in what went out of sight (the code under the whole console, the console's tools under
    // the peek) would drop to the page: it goes to All output, which stays.
    if (narrowQuery.matches && active instanceof HTMLElement && active !== document.body && active.getClientRects().length === 0) dockToggle.focus({ preventScroll: true });
    for (const listener of dockListeners) listener(dock);
  }
  function showView(view: View) {
    if (view === "code" || view === "flowchart") {
      markView(view);
      if (narrowQuery.matches) setDock("peek");
      return;
    }
    selectPanelTab(view);
    if (narrowQuery.matches) setDock("all");
  }
  dockToggle.addEventListener("click", () => setDock(dockNow === "all" ? "peek" : "all"));
  function setDockLines(lines: number) {
    dockWords.textContent = lines ? `All output, ${lines} ${lines === 1 ? "line" : "lines"}` : "All output";
  }
  for (const [tab, v] of switchTabs) tab.addEventListener("click", () => showView(v));
  viewSwitch.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = Math.max(0, switchTabs.findIndex(([t]) => t === document.activeElement));
    const n = switchTabs.length;
    const i = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    showView(switchTabs[i][1]);
    switchTabs[i][0].focus();
  });

  // ---------------------------------------------------------------- panel tabs
  function selectPanelTab(tab: PanelTab) {
    // The chart on its board is no tab of the console's.
    if (tab === "flowchart" && chartBoardHolds()) tab = "output";
    for (const t of PANEL_TABS) {
      ptabs[t].setAttribute("aria-selected", String(t === tab));
      ptabs[t].tabIndex = t === tab ? 0 : -1;
    }
    panel.dataset.tab = tab;
    syncPanel();
  }
  /** Phones: selects the tab and leaves the dock as it is (Output and Problems open it: showView). */
  function showPanelTab(tab: PanelTab, focus = false, stay = false) {
    if (tab === "flowchart" && narrowQuery.matches) {
      showView("flowchart");
      if (focus) viewFlowchart.focus();
      return;
    }
    if (tab === "flowchart" && chartOnBoard()) {
      if (chartHidden || focusMode) setChartHidden(false);
      if (focus) chartBoard.focus();
      return;
    }
    if (!stay) setFocusMode(false);
    selectPanelTab(tab);
    expandPanel();
    if (focus) ptabs[tab].focus();
  }
  for (const t of PANEL_TABS) ptabs[t].addEventListener("click", () => showPanelTab(t));
  // Output, back from Problems (1100 px and wider): it leaves the head, so focus goes to the count,
  // the control that shows the problems again.
  panelBack.addEventListener("click", () => {
    showPanelTab("output");
    problemsButton.focus();
  });
  // APG tabs: arrows move round the tabs shown (wrapping), Home and End go to the ends; selection follows focus.
  panelTabsEl.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const tabs = panelTabs();
    const at = Math.max(0, tabs.indexOf(currentTab()));
    const n = tabs.length;
    const i = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    showPanelTab(tabs[i], true);
  });
  selectPanelTab("output");
  placeChart();

  // ---------------------------------------------------------------- the boards (1100 px and wider)
  // Owner's report on 0.26.0 (2026-11-02): no full-screen editor, no output beside the code, no way
  // to size the boards or to hide the chart. app.css lays the boards out from three attributes on
  // the centre, set here and nowhere else: data-chart (the chart board's column), data-console
  // (the output below or beside the code) and data-focus (focus code: the code board alone, its
  // console the run strip, the top row kept).
  const sayListeners: ((words: string) => void)[] = [];
  const BESIDE_ROOM = "There isn't room for the output beside the code: hide the flowchart or widen the window. It moves there once there is room.";
  function syncBoards() {
    const wide = wideQuery.matches;
    if (!wide) focusMode = false;
    const shown = chartShownNow();
    const focused = document.activeElement;
    besideShown = wide && !focusMode && !collapsed && besideNow(besideWanted, boardsWidth(), shown);
    center.dataset.chart = shown ? "shown" : "hidden";
    center.dataset.console = besideShown ? "beside" : "below";
    center.dataset.focus = String(focusMode);
    // Beside the output, the run strip is the code board's foot under both (moved, never copied).
    if (besideShown && runStrip.parentElement !== center) center.insertBefore(runStrip, boardSplit.element);
    else if (!besideShown && runStrip.parentElement !== panel) panel.prepend(runStrip);
    // The head's Flowchart: shown while a file is open and its board is not on screen.
    chartToggle.hidden = !wide || shown || root.dataset.open !== "true";
    chartToggle.setAttribute("aria-pressed", String(shown));
    focusButton.setAttribute("aria-pressed", String(focusMode));
    focusButton.title = focusMode ? "Leave focus code (Esc or Shift+Alt+Enter)" : "Focus code: hide the flowchart and the output (Shift+Alt+Enter)";
    focusButton.replaceChildren(icon(focusMode ? "arrows-in-simple" : "arrows-out-simple"));
    besideToggle.setAttribute("aria-label", besideShown ? "Output below" : "Output beside");
    besideToggle.title = besideShown
      ? "Output below: put the output under the code"
      : besideWanted
        ? "Output beside: needs a wider window. Hide the flowchart or widen the window"
        : "Output beside: put the output to the right of the code";
    besideToggle.replaceChildren(icon(besideShown ? "square-split-vertical" : "square-split-horizontal"));
    boardSplit.refresh();
    consoleSplit!.refresh();
    syncPanel();
    // A moved element loses focus in some engines: it goes back to the control that had it.
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected && focused.getClientRects().length) focused.focus({ preventScroll: true });
  }

  // The chart board's motion (design.md Motion): in, a 160 ms ease-out fade and an 8 px slide from
  // the right; out, 120 ms ease-in, then its column goes. None under reduced motion.
  let boardAnimation: Animation | null = null;
  function animateBoard(show: boolean): Animation | null {
    boardAnimation?.cancel();
    boardAnimation = null;
    // Asked afresh: Playwright's WebKit left a kept MediaQueryList's matches stale after the
    // preference changed (2026-11-02), and a query per show or hide costs nothing.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof chartBoard.animate !== "function") return null;
    const rest = { opacity: 1, transform: "translateX(0)" };
    const away = { opacity: 0, transform: "translateX(8px)" };
    boardAnimation = chartBoard.animate(
      show ? [away, rest] : [rest, away],
      show ? { duration: 160, easing: "cubic-bezier(0, 0, 0.2, 1)" } : { duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    return boardAnimation;
  }
  /** The choice is remembered; the chart stops drawing at once, and its column goes after its exit. */
  function setChartHidden(hide: boolean) {
    const wasShown = chartShownNow();
    if (!hide) focusMode = false;
    chartHidden = hide;
    writeLayoutFlag("chartHidden", hide);
    // Focus inside the board would drop to the page: it goes to the Flowchart that brings it back.
    const inside = chartBoard.contains(document.activeElement);
    tellChart();
    const apply = () => {
      syncBoards();
      if (inside && !chartShownNow()) chartToggle.focus();
    };
    const exit = hide && wasShown ? animateBoard(false) : null;
    if (exit) {
      // The board takes no pointer while it leaves (app.css); a show in the meantime cancels the exit.
      chartBoard.dataset.state = "closing";
      exit.finished.then(() => {
        delete chartBoard.dataset.state;
        if (chartHidden) apply();
      }, () => delete chartBoard.dataset.state);
      if (inside) {
        chartToggle.hidden = false;
        chartToggle.focus();
      }
      return;
    }
    apply();
    if (!hide && !wasShown && chartShownNow()) animateBoard(true)?.finished.then(() => (boardAnimation = null), () => {});
  }
  function setBeside(on: boolean) {
    besideWanted = on;
    writeLayoutFlag("consoleBeside", on);
    syncBoards();
    if (on && !besideShown && wideQuery.matches) for (const listener of sayListeners) listener(BESIDE_ROOM);
  }
  /**
   * Focus code is a layer over the choices, never a change to them: leaving it restores the layout
   * exactly (the chart's choice, the output's place and size, the console open or not). Focus
   * inside what it hides goes to Focus code.
   */
  function setFocusMode(on: boolean) {
    if (on && !wideQuery.matches) return;
    if (on === focusMode) return;
    const hides = (el: Element | null) => el !== null && (chartBoard.contains(el) || (panel.contains(el) && !runStrip.contains(el)) || consoleSplit!.element === el || panelSplit.element === el);
    const inside = on && hides(document.activeElement);
    focusMode = on;
    boardAnimation?.cancel();
    boardAnimation = null;
    tellChart();
    syncBoards();
    if (inside) focusButton.focus();
    if (!on && chartShownNow()) animateBoard(true);
  }
  chartHide.addEventListener("click", () => setChartHidden(true));
  chartToggle.addEventListener("click", () => setChartHidden(false));
  focusButton.addEventListener("click", () => setFocusMode(!focusMode));
  besideToggle.addEventListener("click", () => {
    if (besideShown) return setBeside(false);
    if (besideWanted) for (const listener of sayListeners) listener(BESIDE_ROOM);
    else setBeside(true);
  });
  // Escape outside the code leaves focus code (in the code it keeps its own jobs: closing the
  // suggestions, Escape then Tab). A menu, a dialog or the Files popover takes its Escape first.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !focusMode || e.defaultPrevented) return;
    const from = e.target instanceof Element ? e.target : null;
    if (from?.closest(".cm-editor, .menu, dialog") || document.querySelector("dialog[open], .menu") || drawerOpen()) return;
    e.preventDefault();
    setFocusMode(false);
  });
  // The window, the full screen or the boards' own content changing size: both sizes are fitted
  // again (a stored size is clamped, never overwritten), and the output's place is judged again.
  // In the next frame, not in the observer's own delivery: syncBoards moves the run strip and resizes
  // the boards, and doing that inside the callback made WebKit report "ResizeObserver loop completed
  // with undelivered notifications" (CI, 0.27.0, short-links.spec QR test).
  let boardsW = -1;
  let boardsQueued = false;
  new ResizeObserver(() => {
    if (boardsQueued) return;
    boardsQueued = true;
    requestAnimationFrame(() => {
      boardsQueued = false;
      const w = boardsWidth();
      if (w === boardsW) return;
      boardsW = w;
      if (wideQuery.matches) syncBoards();
    });
  }).observe(center);

  // ---------------------------------------------------------------- phones: the on-screen keyboard
  // While the code has the focus and the window (or its visual viewport) is well short of its full
  // height (keyboard.ts), the keyboard is open: the segment and the status bar fold away and the
  // dock is its strip alone, on the keyboard's edge (app.css, data-keyboard). --vv-h is the height
  // left above the keyboard, for a browser that only shrinks the visual viewport (Safari).
  const keyboard = new KeyboardWatch();
  const vv = window.visualViewport;
  let keyboardQueued = false;
  function syncKeyboard() {
    keyboardQueued = false;
    const typing = narrowQuery.matches && editorHost.contains(document.activeElement);
    // A pinch zoom shrinks the visual viewport too: its height times its scale is what the keyboard
    // leaves (the scale stays 1 when only the keyboard opens).
    const visualHeight = vv ? vv.height * vv.scale : undefined;
    const inset = keyboard.inset({ width: innerWidth, height: innerHeight, visualHeight }, typing);
    if (inset > 0) {
      root.dataset.keyboard = "open";
      root.style.setProperty("--vv-h", `${Math.round(Math.min(innerHeight, visualHeight ?? innerHeight))}px`);
    } else if (root.dataset.keyboard) {
      delete root.dataset.keyboard;
      root.style.removeProperty("--vv-h");
    }
  }
  const queueKeyboard = () => {
    if (keyboardQueued) return;
    keyboardQueued = true;
    requestAnimationFrame(syncKeyboard);
  };
  addEventListener("resize", queueKeyboard);
  vv?.addEventListener("resize", queueKeyboard);
  document.addEventListener("focusin", queueKeyboard);
  document.addEventListener("focusout", queueKeyboard);
  /** The code lets go of the focus (so the keyboard goes); Run takes it, the control that stays. */
  function endTyping() {
    if (!editorHost.contains(document.activeElement)) return;
    runButton.focus({ preventScroll: true });
    if (editorHost.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    syncKeyboard();
  }
  // A press on the bar's controls never takes the focus from the code first (that would close the
  // keyboard under the finger and move the bar before the click lands).
  for (const el of [hideKeyboard, runButton]) el.addEventListener("pointerdown", (e) => {
    if (root.dataset.keyboard === "open" && e.button === 0) e.preventDefault();
  });
  hideKeyboard.addEventListener("click", endTyping);
  // Run with the keyboard open ends the typing too, and the result shows in the peek.
  runButton.addEventListener("click", () => {
    if (root.dataset.keyboard !== "open") return;
    endTyping();
    setDock("peek");
  });
  syncKeyboard();

  // ---------------------------------------------------------------- crossing 900 px and 1100 px
  const narrowListeners: ((narrow: boolean) => void)[] = [];
  const wideListeners: ((wide: boolean) => void)[] = [];
  /**
   * Crossing a line closes the file list's drawer and popover first (at once, no motion): the list
   * moves to its place at the new width. Focus inside it goes to Files.
   */
  function shutFiles() {
    const inside = sidebar.contains(document.activeElement);
    if (root.dataset.drawer === "open") {
      delete root.dataset.drawer;
      for (const el of behind()) el.inert = false;
    }
    popAnimation?.cancel();
    popAnimation = null;
    delete filesPop.dataset.state;
    filesPop.hidden = true;
    filesPop.inert = false;
    return inside;
  }
  /**
   * Both lines are handled here, from what the queries say now (a jump across both runs once). At
   * 1100 px the chart moves between its board and the console's third tab, and the shell between
   * the rail and sidebar and the Flow Board's top bar, popover and run strip. Printing is no change
   * of the window: Chromium lays the page out at the paper's width (the queries cross a line, and
   * cross back once printing is over), so while the print layout is in the page (data-printing,
   * print-view.ts) nothing moves, and the list is as it was, open or not, when focus goes back into
   * it. The width is read again once printing is over (after print-view's own afterprint).
   */
  let placed: { narrow: boolean; wide: boolean } | null = null;
  const syncWidth = () => {
    if (document.documentElement.dataset.printing === "true") return;
    const narrow = narrowQuery.matches;
    const wide = wideQuery.matches;
    if (placed && placed.narrow === narrow && placed.wide === wide) return;
    const narrowCrossed = !placed || placed.narrow !== narrow;
    const wideCrossed = placed !== null && placed.wide !== wide;
    placed = { narrow, wide };
    root.dataset.narrow = String(narrow);
    const refocus = narrow ? false : shutFiles();
    place(narrow);
    if (!narrow) closeDrawer(false);
    sidebar.inert = narrow && !drawerOpen();
    syncFilesButton();
    if (wideCrossed || narrowCrossed) placeChart();
    if (narrowCrossed) {
      syncFilesName();
      // The peek shows the output's last lines, never the problems list.
      if (narrow && dockNow === "peek" && currentTab() !== "output") selectPanelTab("output");
      syncKeyboard();
    }
    // The boards' choices apply from 1100 px only (under it focus code ends, and the strip and the
    // console go back to their places); syncBoards lays the console out too (syncPanel).
    syncBoards();
    if (refocus) drawerToggle.focus({ preventScroll: true });
    if (narrowCrossed) for (const listener of narrowListeners) listener(narrow);
    if (wideCrossed) for (const listener of wideListeners) listener(wide);
  };
  narrowQuery.addEventListener("change", syncWidth);
  wideQuery.addEventListener("change", syncWidth);
  addEventListener("afterprint", () => setTimeout(syncWidth));
  syncWidth();

  // ---------------------------------------------------------------- breadcrumb
  // What the crumb shows now: a call that changes nothing keeps its nodes (a change of width calls it
  // through renderTabs, and a rebuild between two reads left a test, or a pointer, on a removed node).
  let shown: string | undefined;
  /** Phones: Files is the open file's name (unsaved typing shown as the crumb shows it). */
  function syncFilesName() {
    const narrow = narrowQuery.matches;
    const file = narrow ? crumbFile : null;
    drawerToggle.dataset.file = String(file !== null);
    if (!file) {
      filesName.replaceChildren();
      delete filesName.dataset.dirty;
      drawerToggle.setAttribute("aria-label", "Files");
      drawerToggle.title = "Files";
      return;
    }
    filesName.replaceChildren(...nameParts(file.name), h("span", { class: "dirty-dot", "aria-hidden": "true" }));
    filesName.dataset.dirty = String(file.dirty);
    drawerToggle.setAttribute("aria-label", `Files: ${file.name}${file.dirty ? ", unsaved" : ""}`);
    drawerToggle.title = `Files (${file.name} is open)`;
  }
  function setCrumb(path: WsPath | null, dirty = false) {
    const key = `${path ?? ""}\n${dirty}`;
    if (key === shown) return;
    shown = key;
    crumbFile = path ? { name: path.slice(path.lastIndexOf("/") + 1), dirty } : null;
    syncFilesName();
    const parts = path ? path.split("/") : [];
    crumb.title = path ?? "";
    const last = parts.length - 1;
    // A slash before every part but the first (the workspace's name carries the one before it).
    const sep = (i: number) => (i > 0 ? h("span", { class: "crumb-sep", "aria-hidden": "true" }, "/") : null);
    crumb.replaceChildren(
      crumbRoot,
      ...parts.map((part, i) =>
        i < last
          ? h("li", { class: "crumb-dir" }, sep(i), h("span", { class: "crumb-text" }, part))
          : // The file: unsaved typing shows as on a tab (a dot and italics on phones, which have no tab
            // strip; ", unsaved" in the name everywhere), never by colour alone.
            h(
              "li",
              { class: "crumb-file", "data-dirty": String(dirty) },
              sep(i),
              h("span", { class: "crumb-text crumb-name" }, ...nameParts(part)),
              h("span", { class: "dirty-dot", "aria-hidden": "true" }),
              dirty ? srOnly(", unsaved") : null,
            ),
      ),
    );
  }

  return {
    root,
    drawerToggle,
    wsName,
    repoName,
    wsOwner,
    quick,
    syncSlot,
    runButton,
    runLabel,
    settingsButton,
    paletteButton,
    sidebar,
    sidebarActions,
    treeHost,
    center,
    banner,
    bannerText,
    bannerButton,
    tabHost,
    errorJump,
    errorJumpWords,
    snippetButton,
    editorPanel,
    editorHost,
    emptyHost,
    panel,
    panelTabs: { output: ptabOutput, problems: ptabProblems, flowchart: ptabFlowchart, count },
    panelToggle,
    panelHeadTools,
    panelActions,
    outputPanel,
    problemsPanel,
    flowchartPanel,
    chartBoard,
    chartOnBoard,
    runOutcome,
    problemsButton,
    problemsWords,
    onWideChange: (listener) => void wideListeners.push(listener),
    chartVisible,
    onChartVisibleChange: (listener) => void chartListeners.push(listener),
    noticeHost,
    status,
    viewTabs: { code: viewCode, flowchart: viewFlowchart },
    dockToggle,
    hideKeyboard,
    setDockLines,
    dock: () => dockNow,
    setDock,
    onDockChange: (listener) => void dockListeners.push(listener),
    splitters: { sidebar: sidebarSplit, panel: panelSplit, board: boardSplit, console: consoleSplit },
    board: {
      chartHidden: () => chartHidden,
      setChartHidden,
      besideWanted: () => besideWanted,
      besideShown: () => besideShown,
      setBeside,
      focusMode: () => focusMode,
      setFocusMode,
    },
    onSay: (listener) => void sayListeners.push(listener),
    narrow: () => narrowQuery.matches,
    onNarrowChange: (listener) => void narrowListeners.push(listener),
    openDrawer,
    closeDrawer,
    drawerOpen,
    showView,
    view: () => (narrowQuery.matches && dockNow === "all" ? currentTab() : segNow()),
    showPanelTab,
    panelTab: currentTab,
    expandPanel,
    collapsePanel,
    panelCollapsed,
    setCrumb,
  };
}
