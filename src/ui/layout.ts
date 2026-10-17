// The workbench skeleton: top bar, file sidebar, editor tabs and editor,
// the bottom panel (Output, Problems) and the status bar, on one grid with shared edges. Below
// 900 px the sidebar becomes a drawer and a Code / Output switch replaces the stacked panel.
import { h, svg } from "./dom";
import { icon } from "./icons";
import { clamp, createSplitter, type Splitter } from "./splitter";

export const NARROW = "(max-width: 899px)";
export const SIDEBAR = { min: 200, max: 480, initial: 248 };
export const PANEL = { min: 15, max: 80, initial: 35 };

/** The app's mark: the favicon's shape, drawn with the theme's accent. */
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
  runKey: HTMLElement;
  settingsButton: HTMLButtonElement;
  sidebar: HTMLElement;
  sidebarActions: HTMLElement;
  treeHost: HTMLElement;
  center: HTMLElement;
  banner: HTMLElement;
  bannerText: HTMLElement;
  bannerButton: HTMLButtonElement;
  tabHost: HTMLElement;
  editorPanel: HTMLElement;
  editorHost: HTMLElement;
  emptyHost: HTMLElement;
  panel: HTMLElement;
  panelTabs: { output: HTMLButtonElement; problems: HTMLButtonElement; count: HTMLElement };
  panelStatus: HTMLElement;
  panelActions: HTMLElement;
  outputPanel: HTMLElement;
  problemsPanel: HTMLElement;
  noticeHost: HTMLElement;
  status: { lang: HTMLElement; pos: HTMLElement; runtime: HTMLElement; sync: HTMLElement; shortcuts: HTMLButtonElement };
  viewTabs: { code: HTMLButtonElement; output: HTMLButtonElement };
  /** The file list's width and the panel's height (desktop): buttons resize them without dragging. */
  splitters: { sidebar: Splitter; panel: Splitter };
  narrow(): boolean;
  openDrawer(): void;
  closeDrawer(focusToggle?: boolean): void;
  drawerOpen(): boolean;
  /** Narrow screens: which of Code / Output fills the screen. */
  showView(view: "code" | "output"): void;
  view(): "code" | "output";
  showPanelTab(tab: "output" | "problems", focus?: boolean): void;
  panelTab(): "output" | "problems";
}

export function createLayout(root: HTMLElement): Layout {
  const narrowQuery = matchMedia(NARROW);

  // ---------------------------------------------------------------- top bar
  const drawerToggle = h("button", { type: "button", class: "icon-btn drawer-toggle", "aria-label": "Files", "aria-expanded": "false", "aria-controls": "sidebar", title: "Files" }, icon("sidebar-simple"));
  const wsName = h("span", { class: "ws-name", id: "ws-name" }, "Workspace");
  const repoName = h("span", { class: "repo-name", id: "repo-name" });
  repoName.hidden = true;
  const syncSlot = h("div", { class: "sync-slot", id: "sync-slot" });
  const runLabel = h("span", { class: "run-label" }, "Run");
  const runKey = h("kbd", { class: "keycap run-key", "aria-hidden": "true" }, "Ctrl Enter");
  const runButton = h("button", { type: "button", class: "btn primary run", id: "run-button", "data-running": "false", "aria-keyshortcuts": "Control+Enter" }, h("span", { class: "run-icon" }, icon("play-fill")), runLabel, runKey);
  const settingsButton = h("button", { type: "button", class: "icon-btn", id: "settings-button", "aria-label": "Settings", title: "Settings" }, icon("gear"));
  const topbar = h(
    "header",
    { class: "topbar" },
    drawerToggle,
    h("div", { class: "brand" }, brandMark(), h("span", { class: "brand-name" }, "CodeEditor")),
    h("div", { class: "crumb" }, wsName, repoName),
    h("div", { class: "topbar-spacer" }),
    syncSlot,
    runButton,
    settingsButton,
  );

  // ---------------------------------------------------------------- sidebar
  const sidebarActions = h("div", { class: "sidebar-actions" });
  const treeHost = h("div", { class: "tree-host" });
  const sidebar = h(
    "nav",
    { class: "sidebar", id: "sidebar", "aria-labelledby": "files-title" },
    h("div", { class: "sidebar-head" }, h("h2", { class: "region-title", id: "files-title" }, "Files"), sidebarActions),
    treeHost,
  );

  // ---------------------------------------------------------------- editor
  const bannerText = h("p", { class: "banner-text" });
  const bannerButton = h("button", { type: "button", class: "btn small", id: "edit-here" }, "Edit here");
  const banner = h("div", { class: "banner", id: "read-only-banner", role: "status" }, icon("lock", "banner-icon"), bannerText, bannerButton);
  banner.hidden = true;
  const tabHost = h("div", { class: "tab-host" });
  const editorHost = h("div", { class: "editor-host", id: "editor-host" });
  const emptyHost = h("div", { class: "editor-empty", id: "editor-empty" });
  const editorPanel = h("div", { class: "editor-panel", id: "editor-panel" }, editorHost, emptyHost);
  const editorArea = h("div", { class: "editor-area", id: "editor-area" }, banner, tabHost, editorPanel);

  const viewCode = h("button", { type: "button", role: "tab", id: "view-code", "aria-controls": "editor-area", "aria-selected": "true" }, icon("code-simple"), "Code");
  const viewOutput = h("button", { type: "button", role: "tab", id: "view-output", "aria-controls": "panel", "aria-selected": "false", tabindex: "-1" }, icon("terminal-window"), "Output");
  const viewSwitch = h("div", { class: "view-switch", role: "tablist", "aria-label": "View" }, viewCode, viewOutput);

  // ---------------------------------------------------------------- bottom panel
  const count = h("span", { class: "count", "data-count": "0" });
  const ptabOutput = h("button", { type: "button", role: "tab", id: "ptab-output", "aria-controls": "panel-output", "aria-selected": "true" }, "Output");
  const ptabProblems = h("button", { type: "button", role: "tab", id: "ptab-problems", "aria-controls": "panel-problems", "aria-selected": "false", tabindex: "-1" }, "Problems", count);
  const panelStatus = h("div", { class: "panel-status" });
  const panelActions = h("div", { class: "panel-actions" });
  const outputPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-output", "aria-labelledby": "ptab-output" });
  const problemsPanel = h("div", { class: "panel-body", role: "tabpanel", id: "panel-problems", "aria-labelledby": "ptab-problems", tabindex: "0" });
  problemsPanel.hidden = true;
  const panel = h(
    "section",
    { class: "panel", id: "panel", "aria-label": "Output and problems" },
    h("div", { class: "panel-bar" }, h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel" }, ptabOutput, ptabProblems), panelStatus, panelActions),
    outputPanel,
    problemsPanel,
  );

  const center = h("div", { class: "center", "data-view": "code" }, viewSwitch, editorArea);
  const main = h("main", { class: "main" }, sidebar);

  // ---------------------------------------------------------------- status bar
  const status = {
    lang: h("span", { class: "status-item", id: "status-lang" }),
    pos: h("span", { class: "status-item", id: "status-pos" }),
    runtime: h("span", { class: "status-item runtime", id: "status-runtime", "data-state": "idle" }),
    sync: h("span", { class: "status-item", id: "status-sync" }),
    shortcuts: h("button", { type: "button", class: "status-btn", id: "shortcuts-button", title: "Keyboard shortcuts (?)" }, icon("keyboard"), h("span", null, "Shortcuts")),
  };
  const statusbar = h("footer", { class: "statusbar" }, status.lang, status.pos, status.runtime, h("span", { class: "status-spacer" }), status.sync, status.shortcuts);
  const noticeHost = h("div", { class: "notice-host" });
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
  root.replaceChildren(topbar, main, noticeHost, statusbar, scrim);
  root.classList.add("workbench");
  sidebarSplit.refresh();
  panelSplit.refresh();
  addEventListener("resize", () => sidebarSplit.refresh());

  // ---------------------------------------------------------------- drawer (narrow screens)
  // While it is open, the code and panels behind it are inert; the top bar stays usable, so the
  // Files button that opened it also closes it. Escape or a tap on the scrim close it too.
  const behind = () => [center, statusbar, noticeHost];
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
  const syncNarrow = () => {
    root.dataset.narrow = String(narrowQuery.matches);
    if (!narrowQuery.matches) closeDrawer(false);
    sidebar.inert = narrowQuery.matches && !drawerOpen();
  };
  narrowQuery.addEventListener("change", syncNarrow);
  syncNarrow();

  // ---------------------------------------------------------------- Code / Output switch
  function showView(view: "code" | "output") {
    center.dataset.view = view;
    for (const [tab, on] of [[viewCode, view === "code"], [viewOutput, view === "output"]] as const) {
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  }
  const switchTabs = [viewCode, viewOutput];
  viewCode.addEventListener("click", () => showView("code"));
  viewOutput.addEventListener("click", () => showView("output"));
  viewSwitch.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? viewCode : e.key === "End" ? viewOutput : switchTabs.find((t) => t !== document.activeElement) ?? viewCode;
    showView(next === viewCode ? "code" : "output");
    next.focus();
  });

  // ---------------------------------------------------------------- panel tabs
  function showPanelTab(tab: "output" | "problems", focus = false) {
    const out = tab === "output";
    ptabOutput.setAttribute("aria-selected", String(out));
    ptabProblems.setAttribute("aria-selected", String(!out));
    ptabOutput.tabIndex = out ? 0 : -1;
    ptabProblems.tabIndex = out ? -1 : 0;
    outputPanel.hidden = !out;
    problemsPanel.hidden = out;
    panel.dataset.tab = tab;
    if (focus) (out ? ptabOutput : ptabProblems).focus();
  }
  ptabOutput.addEventListener("click", () => showPanelTab("output"));
  ptabProblems.addEventListener("click", () => showPanelTab("problems"));
  panel.querySelector<HTMLElement>(".panel-tabs")!.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const toProblems = e.key === "End" || (e.key !== "Home" && panel.dataset.tab !== "problems");
    showPanelTab(toProblems ? "problems" : "output", true);
  });
  showPanelTab("output");

  return {
    root,
    drawerToggle,
    wsName,
    repoName,
    syncSlot,
    runButton,
    runLabel,
    runKey,
    settingsButton,
    sidebar,
    sidebarActions,
    treeHost,
    center,
    banner,
    bannerText,
    bannerButton,
    tabHost,
    editorPanel,
    editorHost,
    emptyHost,
    panel,
    panelTabs: { output: ptabOutput, problems: ptabProblems, count },
    panelStatus,
    panelActions,
    outputPanel,
    problemsPanel,
    noticeHost,
    status,
    viewTabs: { code: viewCode, output: viewOutput },
    splitters: { sidebar: sidebarSplit, panel: panelSplit },
    narrow: () => narrowQuery.matches,
    openDrawer,
    closeDrawer,
    drawerOpen,
    showView,
    view: () => (center.dataset.view === "output" ? "output" : "code"),
    showPanelTab,
    panelTab: () => (panel.dataset.tab === "problems" ? "problems" : "output"),
  };
}
