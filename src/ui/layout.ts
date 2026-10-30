// The workbench skeleton (Workbench Pro, stage S2, 2026-10-29: .claude/design/redesign5/a/design.md).
// From 900 px: a 64 px activity rail (Files, Search, Flowchart, New file; Shortcuts and Settings at
// its foot), the file sidebar (the workspace, the tree, and a foot with notices, the sync status and
// About), and the work column: a breadcrumb top bar ("Workspace / main.py", "Search or run a
// command" in the middle, the runtime state, Capture and Run with its key), then the code card and
// the console card (Output, Problems, Flowchart as a segmented control, full screen and hide at the
// head's end). From 1100 px the console sits beside the code with an x-axis splitter; under that it
// docks under the code with a y-axis one, as before. Hidden (collapsed), it is its head, docked
// under the code at every width. Below 900 px the sidebar is a drawer, the top bar holds the mark,
// the file's name, Search, the sync status, Run and Settings, a status bar the facts and notices,
// and a bottom view bar Files, Code, Output, Problems and Flowchart.
// Those elements are moved, never copied: ids stay unique and the DOM order is the visual order,
// so the Tab order follows what is seen (CSS `order` would split the two).
import type { WsPath } from "../core/types";
import { brandMarkSvg } from "../editor/brand-mark";
import { ariaMod, h, isMac, srOnly } from "./dom";
import { icon } from "./icons";
import { chartPanelSize } from "./panel-size";
import { clamp, createSplitter, type Splitter } from "./splitter";

export const NARROW = "(max-width: 899px)";
/** From here the console card sits beside the code card (app.css). */
export const WIDE = "(min-width: 1100px)";
/** A short window (app.css): the page scrolls as a whole. */
export const SHORT = "(max-height: 420px)";
export const SIDEBAR = { min: 200, max: 480, initial: 248 };
export const PANEL = { min: 15, max: 80, initial: 35 };
/** The console's share of the work area's width beside the code, in percent (the mockup's 54 / 46). */
export const CONSOLE = { min: 20, max: 80, initial: 46 };
/** The rail's width, and what the work column keeps at the least beside the sidebar. */
const RAIL_W = 64;
const WORK_KEEP = 560;

/** What fills the screen below 900 px. */
export type View = "code" | "output" | "problems" | "flowchart";
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
  /** Whether the flowchart is on screen (its panel tab open on desktop, its view on phones). */
  chartVisible(): boolean;
  /** Called whenever chartVisible() may have changed. */
  onChartVisibleChange(listener: (visible: boolean) => void): void;
  /** The notice slot: in the sidebar's foot from 900 px, in the status bar below. */
  noticeHost: HTMLElement;
  status: { lang: HTMLElement; pos: HTMLElement; runtime: HTMLElement; shortcuts: HTMLButtonElement };
  viewTabs: { code: HTMLButtonElement; output: HTMLButtonElement; problems: HTMLButtonElement; flowchart: HTMLButtonElement; count: HTMLElement };
  /**
   * The file list's width, the stacked console's height and the side console's width (desktop):
   * buttons resize them without dragging.
   */
  splitters: { sidebar: Splitter; panel: Splitter; console: Splitter };
  /** The splitter that sizes the console at this width (beside the code from 1100 px, under it below). */
  panelSplitter(): Splitter;
  narrow(): boolean;
  /** Called after the layout crossed the 900 px line (and moved Run and the runtime state). */
  onNarrowChange(listener: (narrow: boolean) => void): void;
  /** Shows the file list: the drawer below 900 px (focus goes into it), the sidebar if hidden from 900 px. */
  openDrawer(): void;
  closeDrawer(focusToggle?: boolean): void;
  drawerOpen(): boolean;
  /** Narrow screens: which of Code / Output / Problems / Flowchart fills the screen. */
  showView(view: View): void;
  view(): View;
  /** Selects a panel tab and opens the panel if it is collapsed. */
  showPanelTab(tab: PanelTab, focus?: boolean): void;
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
  // Files shows and hides the file list (from 900 px; below that it opens the drawer, from the view
  // bar). Its word is its name.
  const drawerToggle = h(
    "button",
    { type: "button", class: "rail-btn drawer-toggle", "aria-label": "Files", "aria-expanded": "true", "aria-controls": "sidebar", title: "Files" },
    icon("sidebar-simple"),
    h("span", { class: "rail-label" }, "Files"),
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
    icon("image"),
    h("span", { class: "capture-label" }, "Capture"),
  );
  // The editor head: the tabs on the left, the error jump on the right (phones have no head, and
  // keep Capture there out of sight: they reach it from the code menu).
  const headTools = h("div", { class: "head-tools" }, errorJump);
  const editorHead = h("div", { class: "editor-head" }, tabHost, headTools);
  const editorHost = h("div", { class: "editor-host", id: "editor-host" });
  const emptyHost = h("div", { class: "editor-empty", id: "editor-empty" });
  // Empty until a file is active (workbench renderEmpty): the editor may load before then (start-up
  // fetches it at once for a returning user), and its blank view stays out of sight.
  const editorPanel = h("div", { class: "editor-panel", id: "editor-panel", "data-empty": "true" }, editorHost, emptyHost);
  // The card's foot (900 px and wider): the file's language and Ln/Col (the status bar below).
  const editorFoot = h("div", { class: "editor-foot" });
  const editorArea = h("div", { class: "editor-area", id: "editor-area" }, banner, editorHead, editorPanel, editorFoot);

  // Phones: one switch for the four views, in the bottom view bar after Files; Problems carries its count.
  const viewCount = h("span", { class: "count", "data-count": "0" });
  const viewTab = (id: string, controls: string, iconName: Parameters<typeof icon>[0], label: string, selected: boolean, extra?: HTMLElement) =>
    h(
      "button",
      { type: "button", role: "tab", id, "aria-controls": controls, "aria-selected": String(selected), ...(selected ? {} : { tabindex: "-1" }) },
      icon(iconName),
      h("span", { class: "view-label" }, label),
      extra ?? null,
    );
  const viewCode = viewTab("view-code", "editor-area", "code-simple", "Code", true);
  const viewOutput = viewTab("view-output", "panel", "terminal-window", "Output", false);
  const viewProblems = viewTab("view-problems", "panel", "warning-circle", "Problems", false, viewCount);
  const viewFlowchart = viewTab("view-flowchart", "panel", "tree-structure", "Flowchart", false);
  const viewSwitch = h("div", { class: "view-switch", role: "tablist", "aria-label": "View" }, viewCode, viewOutput, viewProblems, viewFlowchart);
  const viewBar = h("nav", { class: "view-bar", "aria-label": "Views" }, viewSwitch);

  // ---------------------------------------------------------------- the console card
  const count = h("span", { class: "count", "data-count": "0" });
  const ptabOutput = h("button", { type: "button", role: "tab", id: "ptab-output", "aria-controls": "panel-output", "aria-selected": "true" }, "Output");
  const ptabProblems = h("button", { type: "button", role: "tab", id: "ptab-problems", "aria-controls": "panel-problems", "aria-selected": "false", tabindex: "-1" }, "Problems", count);
  const ptabFlowchart = h("button", { type: "button", role: "tab", id: "ptab-flowchart", "aria-controls": "panel-flowchart", "aria-selected": "false", tabindex: "-1" }, "Flowchart");
  const panelTabsEl = h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel" }, ptabOutput, ptabProblems, ptabFlowchart);
  const panelToggle = h("button", { type: "button", class: "icon-btn panel-toggle", id: "panel-toggle", "aria-label": "Output and problems", "aria-expanded": "false", "aria-controls": "panel-output panel-problems panel-flowchart" });
  const panelHeadTools = h("div", { class: "panel-head-tools" });
  const panelActions = h("div", { class: "panel-actions" });
  const outputPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-output", "aria-labelledby": "ptab-output" });
  const problemsPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-problems", "aria-labelledby": "ptab-problems", tabindex: "0" });
  problemsPanel.hidden = true;
  const flowchartPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-flowchart", "aria-labelledby": "ptab-flowchart" });
  flowchartPanel.hidden = true;
  const panel = h(
    "section",
    { class: "panel", id: "panel", "aria-label": "Output and problems", "data-tab": "output" },
    h("div", { class: "panel-bar" }, panelTabsEl, panelHeadTools, panelToggle),
    panelActions,
    outputPanel,
    problemsPanel,
    flowchartPanel,
  );
  const ptabs: Record<PanelTab, HTMLButtonElement> = { output: ptabOutput, problems: ptabProblems, flowchart: ptabFlowchart };
  const bodies: Record<PanelTab, HTMLElement> = { output: outputPanel, problems: problemsPanel, flowchart: flowchartPanel };
  const currentTab = (): PanelTab => (PANEL_TABS.includes(panel.dataset.tab as PanelTab) ? (panel.dataset.tab as PanelTab) : "output");

  const center = h("div", { class: "center", "data-view": "code" }, editorArea);
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
  // Beside the code (1100 px and wider): the console's share of the width, the bar left of it, so
  // ArrowLeft makes the console wider.
  const consoleSplit = createSplitter({
    orientation: "vertical",
    after: true,
    label: "Resize the output panel",
    controls: "panel",
    min: CONSOLE.min,
    max: () => CONSOLE.max,
    initial: CONSOLE.initial,
    step: 2,
    unit: "percent of the width",
    key: "console",
    fromPointer: (e) => {
      const r = center.getBoundingClientRect();
      return clamp(((r.right - e.clientX) / Math.max(1, r.width)) * 100, CONSOLE.min, CONSOLE.max);
    },
    apply: (v) => {
      center.style.setProperty("--code-cols", `${100 - v}fr`);
      center.style.setProperty("--console-cols", `${v}fr`);
    },
  });
  center.append(panelSplit.element, consoleSplit.element, panel);
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
  consoleSplit.refresh();
  addEventListener("resize", () => sidebarSplit.refresh());
  // Dragging a collapsed panel's splitter opens the panel and resizes it. A key on it only opens it,
  // to the size the splitter names (one key, one effect): caught on the way down, before the
  // splitter's own handler would also apply a step.
  for (const split of [panelSplit, consoleSplit]) split.element.addEventListener("pointerdown", () => expandPanel());
  center.addEventListener(
    "keydown",
    (e) => {
      const keys = e.target === panelSplit.element ? ["ArrowUp", "ArrowDown"] : e.target === consoleSplit.element ? ["ArrowLeft", "ArrowRight"] : null;
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
  // the mark, Search, the sync status, Run and Settings; the status bar the facts, the runtime state,
  // the notices, Shortcuts and About; the view bar Files before the four views.
  function place(narrow: boolean) {
    const focused = document.activeElement;
    if (narrow) {
      topStart.prepend(mark);
      topEnd.append(paletteButton, syncSlot, runButton, settingsButton);
      statusbar.append(status.lang, status.pos, status.runtime, noticeHost, status.shortcuts, aboutLink);
      headTools.append(snippetButton);
      viewBar.prepend(drawerToggle);
    } else {
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
  function syncFilesButton() {
    const open = narrowQuery.matches ? drawerOpen() : sidebarShown;
    drawerToggle.setAttribute("aria-expanded", String(open));
    if (sidebarShown) delete root.dataset.sidebar;
    else root.dataset.sidebar = "hidden";
  }
  function drawerOpen() {
    return root.dataset.drawer === "open";
  }
  function openDrawer() {
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
    if (!drawerOpen()) return;
    delete root.dataset.drawer;
    syncFilesButton();
    for (const el of behind()) el.inert = false;
    // The closed drawer is out of reach, not just off screen.
    sidebar.inert = narrowQuery.matches;
    if (focusToggle) drawerToggle.focus();
  }
  drawerToggle.addEventListener("click", () => {
    if (narrowQuery.matches) return drawerOpen() ? closeDrawer() : openDrawer();
    // The focus stays on Files (it was pressed), so hiding the list never drops it to the page.
    sidebarShown = !sidebarShown;
    syncFilesButton();
    sidebarSplit.refresh();
  });
  scrim.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen() && !e.defaultPrevented && !document.querySelector("dialog[open], .menu")) {
      e.preventDefault();
      closeDrawer();
    }
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
  // opens to the remembered size (beside the code from 1100 px, under it below). A hidden body is
  // hidden; the run's result is still read out by the workbench's announcer, never by a hidden
  // role=log. Below 900 px Output and Problems fill the screen from the view bar, so nothing is
  // hidden there.
  let collapsed = true;
  const panelCollapsed = () => collapsed && !narrowQuery.matches;
  const panelSplitter = () => (wideQuery.matches ? consoleSplit : panelSplit);
  function syncPanel() {
    const shut = panelCollapsed();
    panel.dataset.collapsed = String(shut);
    center.dataset.panel = shut ? "collapsed" : "open";
    panelToggle.setAttribute("aria-expanded", String(!shut));
    panelToggle.title = shut ? "Show the panel" : "Hide the panel";
    panelToggle.replaceChildren(icon(shut ? "caret-up" : "caret-down"));
    const tab = currentTab();
    for (const t of PANEL_TABS) bodies[t].hidden = shut || t !== tab;
    // A splitter's value is the size the console opens to; while it is its head, they say so.
    for (const [split, unit] of [[panelSplit, "height"], [consoleSplit, "width"]] as const) {
      if (shut) split.element.setAttribute("aria-valuetext", `Collapsed; opens at ${split.value} percent of the ${unit}`);
      else split.refresh();
    }
    tellChart();
  }
  // ---------------------------------------------------------------- is the flowchart on screen?
  const chartListeners: ((visible: boolean) => void)[] = [];
  let chartWasVisible = false;
  const chartVisible = () => (narrowQuery.matches ? center.dataset.view === "flowchart" : !panelCollapsed() && currentTab() === "flowchart");
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
   * at another opening. Beside the code the console runs the full height already.
   */
  function growForChart() {
    const rows = editorArea.getBoundingClientRect().height + panel.getBoundingClientRect().height;
    const next = chartPanelSize(panelSplit.value, rows, panelSplit.max());
    if (next !== null) panelSplit.set(next);
  }
  function expandPanel() {
    collapsed = false;
    syncPanel();
  }
  function collapsePanel() {
    const active = document.activeElement;
    const inBody = active instanceof Node && (outputPanel.contains(active) || problemsPanel.contains(active));
    collapsed = true;
    syncPanel();
    // Focus inside the body would go to the page: it stays on the control that collapsed it.
    if (inBody) panelToggle.focus();
  }
  panelToggle.addEventListener("click", () => (panelToggle.getAttribute("aria-expanded") === "true" ? collapsePanel() : expandPanel()));

  // ---------------------------------------------------------------- Code / Output / Problems switch
  const switchTabs: [HTMLButtonElement, View][] = [[viewCode, "code"], [viewOutput, "output"], [viewProblems, "problems"], [viewFlowchart, "flowchart"]];
  function markView(view: View) {
    center.dataset.view = view;
    for (const [tab, v] of switchTabs) {
      tab.setAttribute("aria-selected", String(v === view));
      tab.tabIndex = v === view ? 0 : -1;
    }
    tellChart();
  }
  function showView(view: View) {
    markView(view);
    if (view !== "code") selectPanelTab(view);
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
    for (const t of PANEL_TABS) {
      ptabs[t].setAttribute("aria-selected", String(t === tab));
      ptabs[t].tabIndex = t === tab ? 0 : -1;
    }
    panel.dataset.tab = tab;
    // Phones: the switch shows the same panel tab the panel does.
    if (center.dataset.view !== "code") markView(tab);
    syncPanel();
  }
  function showPanelTab(tab: PanelTab, focus = false) {
    selectPanelTab(tab);
    expandPanel();
    if (focus) ptabs[tab].focus();
  }
  for (const t of PANEL_TABS) ptabs[t].addEventListener("click", () => showPanelTab(t));
  // APG tabs: arrows move round the three (wrapping), Home and End go to the ends; selection follows focus.
  panelTabsEl.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = PANEL_TABS.indexOf(currentTab());
    const n = PANEL_TABS.length;
    const i = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    showPanelTab(PANEL_TABS[i], true);
  });
  selectPanelTab("output");

  // ---------------------------------------------------------------- crossing 900 px and 1100 px
  const narrowListeners: ((narrow: boolean) => void)[] = [];
  const syncNarrow = () => {
    const narrow = narrowQuery.matches;
    root.dataset.narrow = String(narrow);
    place(narrow);
    if (!narrow) closeDrawer(false);
    sidebar.inert = narrow && !drawerOpen();
    syncFilesButton();
    syncPanel();
    for (const listener of narrowListeners) listener(narrow);
  };
  narrowQuery.addEventListener("change", syncNarrow);
  syncNarrow();
  // The splitter that sizes the console changes at 1100 px: its value is shown again.
  wideQuery.addEventListener("change", syncPanel);

  // ---------------------------------------------------------------- breadcrumb
  // What the crumb shows now: a call that changes nothing keeps its nodes (a change of width calls it
  // through renderTabs, and a rebuild between two reads left a test, or a pointer, on a removed node).
  let shown: string | undefined;
  function setCrumb(path: WsPath | null, dirty = false) {
    const key = `${path ?? ""}\n${dirty}`;
    if (key === shown) return;
    shown = key;
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
    chartVisible,
    onChartVisibleChange: (listener) => void chartListeners.push(listener),
    noticeHost,
    status,
    viewTabs: { code: viewCode, output: viewOutput, problems: viewProblems, flowchart: viewFlowchart, count: viewCount },
    splitters: { sidebar: sidebarSplit, panel: panelSplit, console: consoleSplit },
    panelSplitter,
    narrow: () => narrowQuery.matches,
    onNarrowChange: (listener) => void narrowListeners.push(listener),
    openDrawer,
    closeDrawer,
    drawerOpen,
    showView,
    view: () => (["output", "problems", "flowchart"].includes(center.dataset.view ?? "") ? (center.dataset.view as View) : "code"),
    showPanelTab,
    panelTab: currentTab,
    expandPanel,
    collapsePanel,
    panelCollapsed,
    setCrumb,
  };
}
