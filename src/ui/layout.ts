// The workbench skeleton (layout v2): the top bar with the breadcrumb, the file sidebar, the editor
// column (an editor head holding the tabs, the error jump, the runtime state and Run; the editor;
// the bottom panel with Output and Problems) and one status bar that also hosts notices, on one
// grid with shared edges and the height tokens of tokens.css. Below 900 px the sidebar becomes a
// drawer, one Code / Output / Problems switch replaces the panel's tabs, the tab strip is hidden
// (files switch in the drawer), Run moves to the top bar and the runtime state to the status bar.
// Those elements are moved, never copied: ids stay unique and the DOM order is the visual order,
// so the Tab order follows what is seen (CSS `order` would split the two).
import type { WsPath } from "../core/types";
import { h, srOnly, svg } from "./dom";
import { icon } from "./icons";
import { clamp, createSplitter, type Splitter } from "./splitter";

export const NARROW = "(max-width: 899px)";
export const SIDEBAR = { min: 200, max: 480, initial: 248 };
export const PANEL = { min: 15, max: 80, initial: 35 };

/** What fills the screen below 900 px. */
export type View = "code" | "output" | "problems";
export type PanelTab = "output" | "problems";

/** The app's mark: the favicon's shape, drawn with the theme's brand tile and glyph colours. */
export function brandMark(): SVGSVGElement {
  return svg(
    "svg",
    { class: "brand-mark", viewBox: "0 0 32 32", "aria-hidden": "true", focusable: "false" },
    svg("rect", { x: "1", y: "1", width: "30", height: "30", rx: "7", class: "mark-tile" }),
    svg("path", { d: "M12 10 6.5 16l5.5 6M20 10l5.5 6-5.5 6", class: "mark-glyph" }),
  );
}

export interface Layout {
  root: HTMLElement;
  drawerToggle: HTMLButtonElement;
  wsName: HTMLElement;
  repoName: HTMLElement;
  syncSlot: HTMLElement;
  runButton: HTMLButtonElement;
  runLabel: HTMLElement;
  settingsButton: HTMLButtonElement;
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
  editorPanel: HTMLElement;
  editorHost: HTMLElement;
  emptyHost: HTMLElement;
  panel: HTMLElement;
  panelTabs: { output: HTMLButtonElement; problems: HTMLButtonElement; count: HTMLElement };
  /** Collapses the panel to its bar and opens it again (aria-expanded; desktop only). */
  panelToggle: HTMLButtonElement;
  panelActions: HTMLElement;
  outputPanel: HTMLElement;
  problemsPanel: HTMLElement;
  /** The notice slot in the status bar. */
  noticeHost: HTMLElement;
  status: { lang: HTMLElement; pos: HTMLElement; runtime: HTMLElement; shortcuts: HTMLButtonElement };
  viewTabs: { code: HTMLButtonElement; output: HTMLButtonElement; problems: HTMLButtonElement; count: HTMLElement };
  /** The file list's width and the panel's height (desktop): buttons resize them without dragging. */
  splitters: { sidebar: Splitter; panel: Splitter };
  narrow(): boolean;
  /** Called after the layout crossed the 900 px line (and moved Run and the runtime state). */
  onNarrowChange(listener: (narrow: boolean) => void): void;
  openDrawer(): void;
  closeDrawer(focusToggle?: boolean): void;
  drawerOpen(): boolean;
  /** Narrow screens: which of Code / Output / Problems fills the screen. */
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

  // ---------------------------------------------------------------- top bar
  const drawerToggle = h("button", { type: "button", class: "icon-btn drawer-toggle", "aria-label": "Files", "aria-expanded": "false", "aria-controls": "sidebar", title: "Files" }, icon("sidebar-simple"));
  const wsName = h("span", { class: "crumb-text ws-name", id: "ws-name" }, "Workspace");
  const repoName = h("span", { class: "crumb-text repo-name", id: "repo-name" });
  repoName.hidden = true;
  // The breadcrumb: the workspace (or the repository, once connected), then the open file's folders
  // and its name. Text, not links; the carets between the segments are decorative. Phones show the
  // file name only.
  const crumbRoot = h("li", { class: "crumb-root" }, wsName, repoName);
  const crumb = h("ol", { class: "crumb", "aria-label": "Open file" }, crumbRoot);
  const syncSlot = h("div", { class: "sync-slot", id: "sync-slot" });
  const runLabel = h("span", { class: "run-label" }, "Run");
  // The shortcut is in the tooltip and aria-keyshortcuts (workbench.ts setRunning), not in the fill.
  const runButton = h("button", { type: "button", class: "btn primary run", id: "run-button", "data-running": "false", "aria-keyshortcuts": "Control+Enter", title: "Run (Ctrl+Enter)" }, h("span", { class: "run-icon" }, icon("play-fill")), runLabel);
  const settingsButton = h("button", { type: "button", class: "icon-btn", id: "settings-button", "aria-label": "Settings", title: "Settings" }, icon("gear"));
  const topbar = h(
    "header",
    { class: "topbar" },
    drawerToggle,
    h("div", { class: "brand" }, brandMark(), h("span", { class: "brand-name" }, "CodeEditor")),
    crumb,
    h("div", { class: "topbar-spacer" }),
    syncSlot,
    settingsButton,
  );

  // ---------------------------------------------------------------- sidebar
  const sidebarActions = h("div", { class: "sidebar-actions" });
  const treeHost = h("div", { class: "tree-host" });
  const sidebar = h(
    "nav",
    { class: "sidebar", id: "sidebar", "aria-labelledby": "files-title" },
    // Below 900 px the top bar has no mark (it looked like a second button): the drawer shows it.
    // The page title already names the app, so this copy is hidden from assistive technology.
    h("div", { class: "drawer-brand", "aria-hidden": "true" }, brandMark(), h("span", { class: "brand-name" }, "CodeEditor")),
    h("div", { class: "sidebar-head" }, h("h2", { class: "region-title", id: "files-title" }, "Files"), sidebarActions),
    treeHost,
  );

  // ---------------------------------------------------------------- editor
  const bannerText = h("p", { class: "banner-text" });
  const bannerButton = h("button", { type: "button", class: "btn small", id: "edit-here" }, "Edit here");
  const banner = h("div", { class: "banner", id: "read-only-banner", role: "status" }, icon("lock", "banner-icon"), bannerText, bannerButton);
  banner.hidden = true;
  const tabHost = h("div", { class: "tab-host" });
  const errorJumpWords = h("span", { class: "jump-words" });
  const errorJump = h("button", { type: "button", class: "error-jump", id: "error-jump" }, icon("x-circle"), errorJumpWords);
  errorJump.hidden = true;
  // The editor head: the tabs on the left; the error jump, the runtime state and Run on the right
  // (desktop: place() moves the last two in).
  const headTools = h("div", { class: "head-tools" }, errorJump);
  const editorHead = h("div", { class: "editor-head" }, tabHost, headTools);
  const editorHost = h("div", { class: "editor-host", id: "editor-host" });
  const emptyHost = h("div", { class: "editor-empty", id: "editor-empty" });
  // Empty until a file is active (workbench renderEmpty): the editor may load before then (start-up
  // fetches it at once for a returning user), and its blank view stays out of sight.
  const editorPanel = h("div", { class: "editor-panel", id: "editor-panel", "data-empty": "true" }, editorHost, emptyHost);
  const editorArea = h("div", { class: "editor-area", id: "editor-area" }, banner, editorHead, editorPanel);

  // Phones: one switch for the three views; Problems carries its count.
  const viewCount = h("span", { class: "count", "data-count": "0" });
  const viewCode = h("button", { type: "button", role: "tab", id: "view-code", "aria-controls": "editor-area", "aria-selected": "true" }, "Code");
  const viewOutput = h("button", { type: "button", role: "tab", id: "view-output", "aria-controls": "panel", "aria-selected": "false", tabindex: "-1" }, "Output");
  const viewProblems = h("button", { type: "button", role: "tab", id: "view-problems", "aria-controls": "panel", "aria-selected": "false", tabindex: "-1" }, "Problems", viewCount);
  const viewSwitch = h("div", { class: "view-switch", role: "tablist", "aria-label": "View" }, viewCode, viewOutput, viewProblems);

  // ---------------------------------------------------------------- bottom panel
  const count = h("span", { class: "count", "data-count": "0" });
  const ptabOutput = h("button", { type: "button", role: "tab", id: "ptab-output", "aria-controls": "panel-output", "aria-selected": "true" }, "Output");
  const ptabProblems = h("button", { type: "button", role: "tab", id: "ptab-problems", "aria-controls": "panel-problems", "aria-selected": "false", tabindex: "-1" }, "Problems", count);
  const panelTabsEl = h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel" }, ptabOutput, ptabProblems);
  const panelToggle = h("button", { type: "button", class: "icon-btn panel-toggle", id: "panel-toggle", "aria-label": "Output and problems", "aria-expanded": "false", "aria-controls": "panel-output panel-problems" });
  const panelActions = h("div", { class: "panel-actions" });
  const outputPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-output", "aria-labelledby": "ptab-output" });
  const problemsPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-problems", "aria-labelledby": "ptab-problems", tabindex: "0" });
  problemsPanel.hidden = true;
  const panel = h(
    "section",
    { class: "panel", id: "panel", "aria-label": "Output and problems", "data-tab": "output" },
    h("div", { class: "panel-bar" }, panelTabsEl, panelToggle, panelActions),
    outputPanel,
    problemsPanel,
  );

  const center = h("div", { class: "center", "data-view": "code" }, viewSwitch, editorArea);
  const main = h("main", { class: "main" }, sidebar);

  // ---------------------------------------------------------------- status bar
  // Language, position, the notice slot (a live region: kept rendered while empty) and Shortcuts.
  // Sync and save state live only in the top bar's sync status.
  const status = {
    lang: h("span", { class: "status-item", id: "status-lang" }),
    pos: h("span", { class: "status-item", id: "status-pos" }),
    runtime: h("span", { class: "status-item runtime", id: "status-runtime", "data-state": "idle" }),
    shortcuts: h("button", { type: "button", class: "status-btn", id: "shortcuts-button", title: "Keyboard shortcuts (?)" }, icon("keyboard"), h("span", null, "Shortcuts")),
  };
  const noticeHost = h("div", { class: "notice-host" });
  const statusbar = h("footer", { class: "statusbar" }, status.lang, status.pos, noticeHost, status.shortcuts);
  const scrim = h("div", { class: "drawer-scrim", "aria-hidden": "true" });

  // ---------------------------------------------------------------- splitters
  const sidebarSplit = createSplitter({
    orientation: "vertical",
    label: "Resize the file list",
    controls: "sidebar",
    min: SIDEBAR.min,
    max: () => Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, innerWidth - 360)),
    initial: SIDEBAR.initial,
    step: 16,
    unit: "pixels wide",
    key: "sidebar",
    fromPointer: (e) => e.clientX - main.getBoundingClientRect().left,
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
  center.append(panelSplit.element, panel);
  main.append(sidebarSplit.element, center);
  root.replaceChildren(topbar, main, statusbar, scrim);
  root.classList.add("workbench");
  // Nothing is open until the workbench says so (renderEmpty): no editor head or Run yet. Until it
  // also knows whether there are files and which one it reopens (data-files), the centre column is
  // laid out but unpainted (app.css), so nothing seen there moves when the head or the switch
  // arrives (a layout shift: review S, 2026-10-18).
  root.dataset.open = "false";
  sidebarSplit.refresh();
  panelSplit.refresh();
  addEventListener("resize", () => sidebarSplit.refresh());
  // Dragging a collapsed panel's splitter opens the panel and resizes it. A key on it only opens it,
  // to the height the splitter names (one key, one effect): caught on the way down, before the
  // splitter's own handler would also apply a step.
  panelSplit.element.addEventListener("pointerdown", () => expandPanel());
  center.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== panelSplit.element || !panelCollapsed() || !["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      expandPanel();
    },
    true,
  );

  // ---------------------------------------------------------------- Run and the runtime state
  // Desktop: in the editor head, beside the tabs of the file they run. Below 900 px (no editor
  // head): Run in the top bar, the runtime state in the status bar.
  function place(narrow: boolean) {
    const hadFocus = document.activeElement === runButton;
    if (narrow) {
      topbar.insertBefore(runButton, settingsButton);
      statusbar.insertBefore(status.runtime, noticeHost);
    } else {
      headTools.append(status.runtime, runButton);
    }
    if (hadFocus && document.activeElement !== runButton) runButton.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- drawer (narrow screens)
  // While it is open, the code and panels behind it are inert; the top bar stays usable, so the
  // Files button that opened it also closes it. Escape or a tap on the scrim close it too.
  const behind = () => [center, statusbar];
  function drawerOpen() {
    return root.dataset.drawer === "open";
  }
  function openDrawer() {
    root.dataset.drawer = "open";
    drawerToggle.setAttribute("aria-expanded", "true");
    sidebar.inert = false; // before moving focus in: an inert element can't take focus
    for (const el of behind()) el.inert = true;
    (sidebar.querySelector<HTMLElement>("[role=treeitem][tabindex='0']") ?? sidebar.querySelector<HTMLElement>("button"))?.focus();
  }
  function closeDrawer(focusToggle = true) {
    if (!drawerOpen()) return;
    delete root.dataset.drawer;
    drawerToggle.setAttribute("aria-expanded", "false");
    for (const el of behind()) el.inert = false;
    // The closed drawer is out of reach, not just off screen.
    sidebar.inert = narrowQuery.matches;
    if (focusToggle) drawerToggle.focus();
  }
  drawerToggle.addEventListener("click", () => (drawerOpen() ? closeDrawer() : openDrawer()));
  scrim.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen() && !e.defaultPrevented && !document.querySelector("dialog[open], .menu")) {
      e.preventDefault();
      closeDrawer();
    }
  });
  // ---------------------------------------------------------------- the panel: collapsed to its bar
  // Desktop: the panel is its bar until the first run or problem, then opens to the remembered
  // height (the splitter's value). A collapsed body is hidden; the run's result is still read out by
  // the workbench's announcer, never by a hidden role=log. Below 900 px Output and Problems fill
  // the screen from the view switch, so nothing is collapsed there.
  let collapsed = true;
  const panelCollapsed = () => collapsed && !narrowQuery.matches;
  function syncPanel() {
    const shut = panelCollapsed();
    panel.dataset.collapsed = String(shut);
    center.dataset.panel = shut ? "collapsed" : "open";
    panelToggle.setAttribute("aria-expanded", String(!shut));
    panelToggle.title = shut ? "Show the panel" : "Hide the panel";
    panelToggle.replaceChildren(icon(shut ? "caret-up" : "caret-down"));
    const out = panel.dataset.tab !== "problems";
    outputPanel.hidden = shut || !out;
    problemsPanel.hidden = shut || out;
    // The splitter's value is the height the panel opens to; while it is a bar, it says so.
    if (shut) panelSplit.element.setAttribute("aria-valuetext", `Collapsed; opens at ${panelSplit.value} percent of the height`);
    else panelSplit.refresh();
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
  const switchTabs: [HTMLButtonElement, View][] = [[viewCode, "code"], [viewOutput, "output"], [viewProblems, "problems"]];
  function markView(view: View) {
    center.dataset.view = view;
    for (const [tab, v] of switchTabs) {
      tab.setAttribute("aria-selected", String(v === view));
      tab.tabIndex = v === view ? 0 : -1;
    }
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
    const out = tab === "output";
    ptabOutput.setAttribute("aria-selected", String(out));
    ptabProblems.setAttribute("aria-selected", String(!out));
    ptabOutput.tabIndex = out ? 0 : -1;
    ptabProblems.tabIndex = out ? -1 : 0;
    panel.dataset.tab = tab;
    // Phones: the switch shows the same panel tab the panel does.
    if (center.dataset.view !== "code") markView(tab);
    syncPanel();
  }
  function showPanelTab(tab: PanelTab, focus = false) {
    selectPanelTab(tab);
    expandPanel();
    if (focus) (tab === "output" ? ptabOutput : ptabProblems).focus();
  }
  ptabOutput.addEventListener("click", () => showPanelTab("output"));
  ptabProblems.addEventListener("click", () => showPanelTab("problems"));
  panelTabsEl.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const toProblems = e.key === "End" || (e.key !== "Home" && panel.dataset.tab !== "problems");
    showPanelTab(toProblems ? "problems" : "output", true);
  });
  selectPanelTab("output");

  // ---------------------------------------------------------------- crossing 900 px
  const narrowListeners: ((narrow: boolean) => void)[] = [];
  const syncNarrow = () => {
    const narrow = narrowQuery.matches;
    root.dataset.narrow = String(narrow);
    place(narrow);
    if (!narrow) closeDrawer(false);
    sidebar.inert = narrow && !drawerOpen();
    syncPanel();
    for (const listener of narrowListeners) listener(narrow);
  };
  narrowQuery.addEventListener("change", syncNarrow);
  syncNarrow();

  // ---------------------------------------------------------------- breadcrumb
  function setCrumb(path: WsPath | null, dirty = false) {
    const parts = path ? path.split("/") : [];
    crumb.title = path ?? "";
    const last = parts.length - 1;
    crumb.replaceChildren(
      crumbRoot,
      ...parts.map((part, i) =>
        i < last
          ? h("li", { class: "crumb-dir" }, icon("caret-right", "crumb-sep"), h("span", { class: "crumb-text" }, part))
          : // The file: unsaved typing shows as on a tab (a dot and italics on phones, which have no tab
            // strip; ", unsaved" in the name everywhere), never by colour alone.
            h(
              "li",
              { class: "crumb-file", "data-dirty": String(dirty) },
              icon("caret-right", "crumb-sep"),
              h("span", { class: "crumb-text" }, part),
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
    syncSlot,
    runButton,
    runLabel,
    settingsButton,
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
    editorPanel,
    editorHost,
    emptyHost,
    panel,
    panelTabs: { output: ptabOutput, problems: ptabProblems, count },
    panelToggle,
    panelActions,
    outputPanel,
    problemsPanel,
    noticeHost,
    status,
    viewTabs: { code: viewCode, output: viewOutput, problems: viewProblems, count: viewCount },
    splitters: { sidebar: sidebarSplit, panel: panelSplit },
    narrow: () => narrowQuery.matches,
    onNarrowChange: (listener) => void narrowListeners.push(listener),
    openDrawer,
    closeDrawer,
    drawerOpen,
    showView,
    view: () => (center.dataset.view === "output" ? "output" : center.dataset.view === "problems" ? "problems" : "code"),
    showPanelTab,
    panelTab: () => (panel.dataset.tab === "problems" ? "problems" : "output"),
    expandPanel,
    collapsePanel,
    panelCollapsed,
    setCrumb,
  };
}
