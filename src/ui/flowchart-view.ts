// The Flowchart view (a lazy chunk: the workbench imports it the first time the Flowchart tab or
// phone view opens; the worker and the grammars load when it first draws). It follows the open file:
// a chart per function (entry point first, a picker for the rest), redrawn 300 ms after typing stops
// while it is on screen. Reading order: 1. the chart, 2. the picker and zoom, 3. Full screen.
//
// The chart is one Tab stop: a list of boxes in reading order (arrows, Home, End). Enter or Space,
// or a click, goes to the box's lines in the code; arrows only show the lines (the focus stays in the
// chart). Moving the caret in the code outlines its box. "Steps as text" shows the same chart as a
// text outline (stepList), so the drawing is never the only way to read it. Full screen is a modal
// <dialog> holding this same view (not the Fullscreen API, which iPhone Safari lacks for elements).
import "../styles/flowchart.css";
import arrowsInPath from "@phosphor-icons/core/assets/regular/arrows-in.svg?raw";
import arrowsOutPath from "@phosphor-icons/core/assets/regular/arrows-out.svg?raw";
import framePath from "@phosphor-icons/core/assets/regular/frame-corners.svg?raw";
import listPath from "@phosphor-icons/core/assets/regular/list-numbers.svg?raw";
import minusPath from "@phosphor-icons/core/assets/regular/magnifying-glass-minus.svg?raw";
import plusPath from "@phosphor-icons/core/assets/regular/magnifying-glass-plus.svg?raw";
import { editorLanguage, languageById } from "../core/languages";
import { createFlowchartClient, type FlowchartClient, type FlowchartResult } from "../flowchart/client";
import { layoutChart, type Layout } from "../flowchart/layout";
import type { ChartResult, FlowChart, FlowFile } from "../flowchart/model";
import type { FlowLanguage } from "../flowchart/pack";
import { canCopyImages } from "../core/snippet";
import { BRAND_MARK } from "../editor/brand-mark";
import {
  chooseExportScale, drawExport, exportFileName, exportSize, exportSvg, footerWhat, markSpot, printColors, type ExportColors, type ExportInput, type ExportLook,
} from "../flowchart/export";
import { renderChart, stepList } from "../flowchart/render";
import { openModal } from "./dialogs";
import { downloadBlob, h, svg } from "./dom";
import { icon, pathData } from "./icons";
import { menuButton, type MenuItem } from "./menu";

/** The export's colours, one choice remembered for the session (this page's life). */
let exportChoice: "print" | "match" = "print";

/** The open file, as the view needs it. */
export interface ChartFile {
  id: string;
  path: string;
  text: string;
}

/** What the view asks of the workbench. */
export interface ChartHost {
  file(): ChartFile | null;
  /** Selects lines `from` to `to` (1-based) of the file in the editor; moves the focus there when asked. */
  select(id: string, from: number, to: number, focus: boolean): void;
  /** The caret's 1-based line in the open file, or null. */
  caretLine(): number | null;
  /** Phones: the code is another view; going to the code shows it first. */
  showCode(): void;
}

export interface FlowchartView {
  setVisible(on: boolean): void;
  /** Another file became the open one (or none). */
  fileChanged(): void;
  /** The open file was edited. */
  docChanged(): void;
  /** The caret moved in the open file. */
  caretMoved(): void;
}

type State = "none" | "other" | "empty" | "loading" | "ready" | "too-big" | "no-functions" | "failed" | "timeout";

export const REDRAW_MS = 300;
/** The loading words wait this long (the Doherty threshold), so a quick draw shows no flash of text. */
export const LOADING_WORDS_MS = 400;
const ZOOM = { min: 0.25, max: 2, step: 1.25 };

// The panel's Maximise uses the corners icons; full screen, a different thing, uses arrows.
const LOCAL_ICONS = { minus: minusPath, plus: plusPath, frame: framePath, list: listPath, out: arrowsOutPath, in: arrowsInPath };
function localIcon(name: keyof typeof LOCAL_ICONS) {
  return svg(
    "svg",
    { class: "icon", viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": "true", focusable: "false" },
    ...pathData(LOCAL_ICONS[name]).map((d) => svg("path", { d })),
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createFlowchartView(panel: HTMLElement, host: ChartHost, client: FlowchartClient = createFlowchartClient()): FlowchartView {
  // ---------------------------------------------------------------- the view's parts
  const picker = h("select", { id: "fc-picker", class: "fc-picker" });
  const pickerLabel = h("label", { class: "fc-label", for: "fc-picker" }, "Function");
  const zoomOut = h("button", { type: "button", class: "icon-btn", id: "fc-zoom-out", "aria-label": "Zoom out", title: "Zoom out (Ctrl+wheel)" }, localIcon("minus"));
  const fitButton = h("button", { type: "button", class: "icon-btn", id: "fc-fit", "aria-label": "Fit to the width", title: "Fit to the width" }, localIcon("frame"));
  const zoomIn = h("button", { type: "button", class: "icon-btn", id: "fc-zoom-in", "aria-label": "Zoom in", title: "Zoom in (Ctrl+wheel)" }, localIcon("plus"));
  const stepsToggle = h("button", { type: "button", class: "fc-tool", id: "fc-steps-toggle", "aria-expanded": "false", "aria-controls": "fc-steps" }, localIcon("list"), h("span", null, "Steps as text"));
  const fullButton = h("button", { type: "button", class: "icon-btn", id: "fc-full", "aria-label": "Full screen", title: "Full screen" }, localIcon("out"));
  const exportButton = h("button", { type: "button", class: "fc-tool", id: "fc-export", title: "Export the flowchart" }, icon("download-simple"), h("span", null, "Export"));
  const toolbar = h(
    "div",
    { class: "fc-toolbar" },
    h("div", { class: "fc-group" }, pickerLabel, picker),
    h("div", { class: "fc-group", role: "group", "aria-label": "Zoom" }, zoomOut, fitButton, zoomIn),
    h("div", { class: "fc-spacer" }),
    stepsToggle,
    exportButton,
    fullButton,
  );
  // An export's result, said politely (Capture snippet's status line).
  const status = h("p", { class: "fc-status", id: "fc-status", role: "status" });
  const bannerText = h("span", { class: "fc-banner-text" });
  const bannerGo = h("button", { type: "button", class: "text-btn fc-banner-go" });
  const banner = h("div", { class: "fc-banner" }, icon("warning", "fc-banner-icon"), bannerText, bannerGo);
  banner.hidden = true;
  const stage = h("div", { class: "fc-stage" });
  // A Tab stop of its own, so a long outline scrolls by keyboard (WCAG 2.1.1; WebKit scrolls a box
  // only once something in it has focus).
  const steps = h("ol", { class: "fc-steps", id: "fc-steps", "aria-label": "Steps as text", tabindex: "0" });
  steps.hidden = true;
  const skeleton = h("div", { class: "fc-skeleton", "aria-hidden": "true" }, h("span", null), h("span", null), h("span", null));
  const messageText = h("p", { class: "fc-message-text" });
  const retry = h("button", { type: "button", class: "btn", id: "fc-retry" }, "Retry");
  retry.hidden = true;
  // A polite live region: what the view says (loading, a mistake, too big, failed) is heard once.
  const message = h("div", { class: "fc-message", role: "status" }, messageText, skeleton, retry);
  const root = h("div", { class: "fc-view", "data-state": "none" }, toolbar, status, banner, stage, steps, message);
  panel.append(root);
  const dialog = h("dialog", { class: "fc-dialog", id: "fc-dialog", "aria-label": "Flowchart, full screen" });

  // ---------------------------------------------------------------- state
  let visible = false;
  let stale = true;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let wordsTimer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;
  /** The file whose chart is shown (its id, language and results). */
  let shown: { id: string; lang: FlowLanguage; file: FlowFile } | null = null;
  let chosen: string | null = null;
  let chart: FlowChart | null = null;
  let layout: Layout | null = null;
  let svgEl: SVGSVGElement | null = null;
  let zoom = 1;
  /** The zoom follows the width (fit) until the student zooms. */
  let fitting = true;
  let focusIndex = 0;

  function setState(state: State, words = "", canRetry = false) {
    root.dataset.state = state;
    clearTimeout(wordsTimer);
    const loading = state === "loading";
    skeleton.hidden = !loading;
    messageText.textContent = loading ? "" : words;
    if (loading) wordsTimer = setTimeout(() => (messageText.textContent = words), LOADING_WORDS_MS);
    retry.hidden = !canRetry;
    const drawn = state === "ready";
    stage.hidden = !drawn;
    steps.hidden = !drawn || stepsToggle.getAttribute("aria-expanded") !== "true";
    // The picker stays for a function that is too big (another may fit); zoom needs a drawing.
    toolbar.hidden = !(drawn || state === "too-big");
    for (const b of [zoomOut, fitButton, zoomIn, stepsToggle, exportButton]) b.hidden = !drawn;
    if (!drawn) say("", "");
    message.hidden = drawn;
    if (!drawn) banner.hidden = true;
  }

  const langName = (lang: FlowLanguage) => languageById(lang).label;

  // ---------------------------------------------------------------- drawing
  function schedule(delay: number) {
    clearTimeout(redrawTimer);
    if (!visible) {
      stale = true;
      return;
    }
    redrawTimer = setTimeout(() => void draw(), delay);
  }

  async function draw() {
    stale = false;
    clearTimeout(redrawTimer);
    const f = host.file();
    const my = ++token;
    if (!f) return void (forget(), setState("none", "Open a C, C++ or Python file to see its flowchart."));
    const lang = editorLanguage(f.path);
    if (!lang) return void (forget(), setState("other", "Flowcharts are for C, C++ and Python files."));
    if (!f.text.trim()) return void (forget(), setState("empty", "This file is empty. Write some code to see its flowchart."));
    // A redraw of the chart on screen keeps it until the new one is ready; anything else shows loading.
    if (!(shown && shown.id === f.id && root.dataset.state === "ready")) setState("loading", `Loading the ${langName(lang)} flowchart tools...`);
    const result = await client.chart(lang, f.text);
    if (my !== token) return; // a newer draw (another file, more typing) owns the view
    show(f, lang, result);
  }

  /** Nothing to chart: the worker keeps its loaded grammars for the next file. */
  function forget() {
    shown = null;
    chart = null;
  }

  function show(f: ChartFile, lang: FlowLanguage, result: FlowchartResult) {
    switch (result.type) {
      case "superseded":
        return;
      case "too-big":
        shown = null;
        return setState("too-big", `This file is too big for a flowchart: ${result.detail}.`);
      case "timeout":
        shown = null;
        return setState("timeout", "The flowchart took too long to draw.", true);
      case "load-failed":
        shown = null;
        return setState("failed", `Couldn't load the ${langName(lang)} flowchart tools. Check the connection, then try again.`, true);
      case "failed":
        shown = null;
        return setState("failed", "The flowchart couldn't be drawn.", true);
      case "charts": {
        const sameFile = shown?.id === f.id;
        shown = { id: f.id, lang, file: result.file };
        if (!result.file.charts.length) return setState("no-functions", "No functions in this file yet.");
        const names = result.file.charts.map((c) => c.name);
        if (!sameFile || chosen === null || !names.includes(chosen)) {
          chosen = names[0];
          fitting = true;
          focusIndex = 0;
        }
        fillPicker(result.file.charts);
        drawChosen();
      }
    }
  }

  function fillPicker(charts: ChartResult[]) {
    const options = charts.map((c, i) => h("option", { value: String(i) }, c.ok ? c.name : `${c.name} (too big)`));
    const same = picker.options.length === options.length && options.every((o, i) => picker.options[i].textContent === o.textContent);
    if (!same) picker.replaceChildren(...options);
    picker.value = String(Math.max(0, charts.findIndex((c) => c.name === chosen)));
  }

  function drawChosen() {
    const file = shown?.file;
    const result = file?.charts.find((c) => c.name === chosen);
    if (!file || !result) return;
    if (!result.ok) {
      chart = null;
      // "it has more than 400 steps" reads "This function has more than 400 steps; open a smaller function."
      return setState("too-big", `${result.tooBig.replace(/^it /, "This function ")}; open a smaller function.`);
    }
    chart = result;
    layout = layoutChart(result);
    svgEl = renderChart(result, layout);
    stage.replaceChildren(svgEl);
    steps.replaceChildren(...stepList(result).map((s) => h("li", null, s.text)));
    setState("ready");
    if (file.syntaxError !== undefined) {
      bannerText.textContent = `Line ${file.syntaxError} has a mistake, so this part of the chart may be incomplete.`;
      bannerGo.textContent = `Go to line ${file.syntaxError}`;
      bannerGo.dataset.line = String(file.syntaxError);
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    focusIndex = clamp(focusIndex, 0, result.nodes.length - 1);
    for (const g of nodes()) g.tabIndex = -1;
    const first = nodes()[focusIndex];
    if (first) first.tabIndex = 0;
    if (fitting) fit();
    else applyZoom();
    markCaret(false);
  }

  const nodes = () => (svgEl ? [...svgEl.querySelectorAll<SVGGElement>("g[data-node]")] : []);

  // ---------------------------------------------------------------- zoom and pan
  function applyZoom(anchor?: { x: number; y: number }) {
    if (!svgEl || !layout) return;
    const before = svgEl.getBoundingClientRect().width || layout.width;
    svgEl.setAttribute("width", String(Math.round(layout.width * zoom)));
    svgEl.setAttribute("height", String(Math.round(layout.height * zoom)));
    if (anchor) {
      // Keep the point under the pointer where it was.
      const ratio = (layout.width * zoom) / before;
      stage.scrollLeft = (stage.scrollLeft + anchor.x) * ratio - anchor.x;
      stage.scrollTop = (stage.scrollTop + anchor.y) * ratio - anchor.y;
    }
  }
  function fit() {
    if (!layout) return;
    const room = stage.clientWidth - 16;
    fitting = true;
    // Not laid out yet (hidden): drawn at full size, fitted when shown.
    zoom = room > 0 ? clamp(Math.min(1, room / layout.width), ZOOM.min, ZOOM.max) : 1;
    applyZoom();
  }
  function zoomBy(factor: number, anchor?: { x: number; y: number }) {
    fitting = false;
    zoom = clamp(zoom * factor, ZOOM.min, ZOOM.max);
    applyZoom(anchor);
  }
  zoomIn.addEventListener("click", () => zoomBy(ZOOM.step));
  zoomOut.addEventListener("click", () => zoomBy(1 / ZOOM.step));
  fitButton.addEventListener("click", fit);
  stage.addEventListener(
    "wheel",
    (e) => {
      // A plain wheel scrolls; Ctrl (or Cmd, or a trackpad pinch, which arrives as Ctrl+wheel) zooms.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY / 300), { x: e.clientX - r.left, y: e.clientY - r.top });
    },
    { passive: false },
  );
  // Drag to pan (mouse, pen or one finger); two fingers pinch to zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let dragged = false;
  let pinchFrom = 0;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  stage.addEventListener("pointermove", (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const next = { x: e.clientX, y: e.clientY };
    if (pointers.size === 2) {
      pointers.set(e.pointerId, next);
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchFrom > 0 && Math.abs(d - pinchFrom) > 2) {
        const r = stage.getBoundingClientRect();
        zoomBy(d / pinchFrom, { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top });
        pinchFrom = d;
      }
      dragged = true;
      return;
    }
    const dx = next.x - last.x;
    const dy = next.y - last.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) stage.setPointerCapture(e.pointerId);
    dragged = true;
    stage.scrollLeft -= dx;
    stage.scrollTop -= dy;
    pointers.set(e.pointerId, next);
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchFrom = 0;
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  new ResizeObserver(() => {
    if (fitting && visible) fit();
  }).observe(stage);

  // ---------------------------------------------------------------- chart and code
  function linesOf(g: Element): [number, number] {
    return [Number(g.getAttribute("data-line-from")), Number(g.getAttribute("data-line-to"))];
  }
  function goToCode(g: Element, focus: boolean) {
    const f = host.file();
    if (!f || f.id !== shown?.id) return;
    const [from, to] = linesOf(g);
    if (focus) host.showCode();
    host.select(f.id, from, to, focus);
  }
  stage.addEventListener("click", (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    const g = (e.target as Element).closest("g[data-node]");
    if (!g) return;
    moveFocus(nodes().indexOf(g as SVGGElement), false);
    goToCode(g, true);
  });
  function moveFocus(i: number, focus = true) {
    const all = nodes();
    if (i < 0 || i >= all.length) return;
    all[focusIndex]?.setAttribute("tabindex", "-1");
    focusIndex = i;
    all[i].setAttribute("tabindex", "0");
    if (focus) {
      all[i].focus({ preventScroll: true });
      reveal(all[i]);
    }
  }
  stage.addEventListener("keydown", (e) => {
    const g = (e.target as Element).closest?.("g[data-node]");
    if (!g || e.altKey || e.ctrlKey || e.metaKey) return;
    const all = nodes();
    const i = all.indexOf(g as SVGGElement);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const j = clamp(to, 0, all.length - 1);
      moveFocus(j);
      // Browsing shows the box's lines in the code; the focus stays here.
      goToCode(all[j], false);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      goToCode(g, true);
    }
  });
  /** Scrolls the stage the least that shows the box (nothing when it is already in view). */
  function reveal(g: Element) {
    const r = g.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const pad = 12;
    if (r.top < s.top) stage.scrollTop -= s.top - r.top + pad;
    else if (r.bottom > s.bottom) stage.scrollTop += r.bottom - s.bottom + pad;
    if (r.left < s.left) stage.scrollLeft -= s.left - r.left + pad;
    else if (r.right > s.right) stage.scrollLeft += r.right - s.right + pad;
  }
  /** Outlines the box whose lines hold the caret (the smallest one when boxes nest). */
  function markCaret(scroll: boolean) {
    if (!chart || !svgEl) return;
    const line = host.caretLine();
    const f = host.file();
    let best: SVGGElement | null = null;
    let span = Infinity;
    if (line !== null && f && f.id === shown?.id) {
      for (const g of nodes()) {
        const [from, to] = linesOf(g);
        if (from <= line && line <= to && to - from < span) [best, span] = [g, to - from];
      }
    }
    for (const g of nodes()) if (g !== best) g.removeAttribute("data-current");
    if (best && best.getAttribute("data-current") !== "true") {
      best.setAttribute("data-current", "true");
      if (scroll && visible) reveal(best);
    }
  }

  picker.addEventListener("change", () => {
    const c = shown?.file.charts[Number(picker.value)];
    if (!c) return;
    chosen = c.name;
    fitting = true;
    focusIndex = 0;
    drawChosen();
  });
  bannerGo.addEventListener("click", () => {
    const f = host.file();
    const line = Number(bannerGo.dataset.line);
    if (!f || !line) return;
    host.showCode();
    host.select(f.id, line, line, true);
  });
  retry.addEventListener("click", () => {
    retry.hidden = true;
    void draw();
  });
  stepsToggle.addEventListener("click", () => {
    const open = stepsToggle.getAttribute("aria-expanded") !== "true";
    stepsToggle.setAttribute("aria-expanded", String(open));
    steps.hidden = !open || root.dataset.state !== "ready";
  });

  // ---------------------------------------------------------------- full screen
  function setFullLabel(full: boolean) {
    const words = full ? "Exit full screen" : "Full screen";
    fullButton.setAttribute("aria-label", words);
    fullButton.title = `${words}${full ? " (Esc)" : ""}`;
    fullButton.replaceChildren(localIcon(full ? "in" : "out"));
  }
  // Put back before the dialog helper returns the focus to the button (listeners run in order).
  dialog.addEventListener("close", () => {
    panel.append(root);
    setFullLabel(false);
    if (fitting) fit();
  });
  fullButton.addEventListener("click", () => {
    if (dialog.open) return dialog.close();
    dialog.append(root);
    setFullLabel(true);
    openModal(dialog, fullButton, () => fullButton);
    if (fitting) fit();
  });

  // ---------------------------------------------------------------- export: PNG, SVG, copy
  function say(text: string, tone: "" | "info" | "success" | "error") {
    status.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }
  /** Where a download's link goes: the open dialog (the page behind it is inert), else the page. */
  const linkParent = () => (dialog.open ? dialog : document.body);

  let probe: CanvasRenderingContext2D | null | undefined;
  /** A CSS colour as #rrggbb (the canvas spells opaque colours so), or `fallback` when it isn't one. */
  function hex(value: string, fallback: string): string {
    probe ??= document.createElement("canvas").getContext("2d");
    const v = value.trim();
    if (!probe || !v) return fallback;
    // Set over two different colours: an invalid value leaves each as it was, a valid one wins both.
    const read = (base: string) => ((probe!.fillStyle = base), (probe!.fillStyle = v), String(probe!.fillStyle));
    const [a, b] = [read("#000000"), read("#ffffff")];
    return a === b && /^#[0-9a-f]{6}$/.test(a) ? a : fallback;
  }

  /** The look at click time: Print-safe light, or the editor's theme read from the view's own tokens. */
  function exportLook(): ExportLook {
    const print = printColors();
    const css = getComputedStyle(root);
    const fonts = { codeFont: css.getPropertyValue("--font-code").trim() || "monospace", uiFont: css.getPropertyValue("--font-ui").trim() || "sans-serif" };
    if (exportChoice === "print") return { colors: print, ...fonts };
    const colors = { ...print };
    for (const k of Object.keys(print) as (keyof ExportColors)[]) colors[k] = hex(css.getPropertyValue(`--${k}`), print[k]);
    return { colors, ...fonts };
  }

  /** The chart on screen, ready to export (null when nothing is drawn). */
  function exportInput(): ExportInput | null {
    const f = host.file();
    if (!chart || !layout || !shown || !f || f.id !== shown.id || root.dataset.state !== "ready") return null;
    return { chart, layout, file: f.path, look: exportLook() };
  }

  type Failure = "too-big" | "device" | "privacy";
  const failure = (reason: Failure) => Object.assign(new Error(reason), { reason });
  const failText = (e: unknown) => {
    switch ((e as { reason?: Failure }).reason) {
      case "too-big":
        return "This chart is too big for a PNG. Download SVG instead.";
      case "device":
        return "Couldn't make an image this big on this device. Download SVG instead.";
      case "privacy":
        return "This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.";
      default:
        return "Couldn't make the image. Try again.";
    }
  };

  /**
   * The mark's tile, read back: blank pixels mean the canvas failed (too big for this device);
   * other colours mean the browser hid the drawing (privacy settings add noise or blank it).
   */
  function readback(ctx: CanvasRenderingContext2D, spot: { x: number; y: number; size: number }, scale: number): "ok" | Failure {
    const k = spot.size / BRAND_MARK.view;
    const want = [0x2f, 0x5b, 0xea];
    let blank = true;
    // Two points of the tile clear of the chevrons: between their tops, and the middle.
    for (const [vx, vy] of [[16, 5], [16, 16]]) {
      let d: Uint8ClampedArray;
      try {
        d = ctx.getImageData(Math.floor((spot.x + vx * k) * scale), Math.floor((spot.y + vy * k) * scale), 1, 1).data;
      } catch {
        return "privacy";
      }
      if (d[3] !== 0) blank = false;
      if (d[3] !== 255 || want.some((c, i) => Math.abs(d[i] - c) > 2)) return blank ? "device" : "privacy";
    }
    return "ok";
  }

  /** The PNG: drawn on a canvas at 2x (less past the browsers' safe size) once the fonts are in. */
  function makePng(input: ExportInput) {
    const size = exportSize(input.layout, footerWhat(input.file, input.chart));
    const fit = chooseExportScale(size.width, size.height);
    const png = new Promise<Blob>((resolve, reject) => {
      if (!fit) return reject(failure("too-big"));
      void document.fonts.ready.then(() => {
        const canvas = document.createElement("canvas");
        canvas.width = fit.width;
        canvas.height = fit.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(failure("device"));
        try {
          drawExport(ctx, input, fit.scale);
        } catch {
          return reject(failure("device"));
        }
        const read = readback(ctx, markSpot(input.layout), fit.scale);
        if (read !== "ok") return reject(failure(read));
        canvas.toBlob((b) => (b ? resolve(b) : reject(failure("device"))), "image/png");
      }, reject);
    });
    png.catch(() => {}); // each caller handles the failure; this keeps it from reading as unhandled
    return { png, fit };
  }
  const withScale = (text: string, fit: ReturnType<typeof chooseExportScale>) =>
    fit?.reduced ? `${text} The chart is too big for a 2x image, so this one is ${fit.scale}x.` : text;

  let busy = false;
  let makingTimer: ReturnType<typeof setTimeout> | undefined;
  /** One export at a time; "Making the PNG..." shows only when it takes a while. */
  function run(work: () => Promise<{ text: string; tone: "success" | "error" }>) {
    if (busy) return;
    busy = true;
    root.dataset.export = "busy";
    say("", "");
    makingTimer = setTimeout(() => say("Making the PNG...", "info"), LOADING_WORDS_MS);
    void work()
      .catch((e: unknown) => ({ text: failText(e), tone: "error" as const }))
      .then(({ text, tone }) => {
        busy = false;
        clearTimeout(makingTimer);
        root.dataset.export = "done";
        say(text, tone);
      });
  }

  function downloadPng() {
    const input = exportInput();
    if (!input) return;
    const name = exportFileName(input.file, input.chart.name, "png");
    const { png, fit } = makePng(input);
    run(() =>
      png.then((blob) => {
        downloadBlob(name, blob, { parent: linkParent() });
        return { text: withScale(`Downloading ${name}.`, fit), tone: "success" as const };
      }),
    );
  }

  function downloadSvg() {
    const input = exportInput();
    if (!input || busy) return;
    const name = exportFileName(input.file, input.chart.name, "svg");
    const xml = new XMLSerializer().serializeToString(exportSvg(input));
    downloadBlob(name, new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`], { type: "image/svg+xml" }), { parent: linkParent() });
    root.dataset.export = "done";
    say(`Downloading ${name}.`, "success");
  }

  function copyImage() {
    const input = exportInput();
    if (!input || busy) return;
    const { png, fit } = makePng(input);
    // The write starts in this click (the user's activation), holding the PNG still being made.
    let written: Promise<void>;
    try {
      written = navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } catch (e) {
      written = Promise.reject(e);
    }
    run(() =>
      written.then(
        () => ({ text: withScale("Copied the image.", fit), tone: "success" as const }),
        // A refused write with a good PNG is the clipboard's refusal; a failed PNG says why.
        () => png.then(() => ({ text: "Couldn't copy the image. Use Download PNG instead.", tone: "error" as const })),
      ),
    );
  }

  menuButton(exportButton, "Export", () => {
    const items: MenuItem[] = [
      { label: "Download PNG", icon: "image", run: downloadPng },
      { label: "Download SVG", icon: "download-simple", run: downloadSvg },
    ];
    if (canCopyImages(globalThis)) items.push({ label: "Copy image", icon: "copy", run: copyImage });
    items.push(
      { label: "Print-safe light", checked: exportChoice === "print", separatorBefore: true, run: () => (exportChoice = "print") },
      { label: "Match the editor", checked: exportChoice === "match", run: () => (exportChoice = "match") },
    );
    return items;
  });

  // ---------------------------------------------------------------- what the workbench calls
  setState("none", "Open a C, C++ or Python file to see its flowchart.");
  return {
    setVisible(on) {
      visible = on;
      if (!on) return clearTimeout(redrawTimer);
      if (stale || !shown) void draw();
      else if (fitting) fit();
    },
    fileChanged() {
      schedule(0);
    },
    docChanged() {
      schedule(REDRAW_MS);
    },
    caretMoved() {
      markCaret(true);
    },
  };
}
