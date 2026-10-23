// Save as PDF's print layout and its print run (.claude/design/pdf.md). The layout is built from
// styled lines (editor/print-render.ts) with text nodes only (dom.ts h(): nothing parses HTML, so a
// file can never become markup), added to the page while the browser's print dialog is open and
// removed when it closes. Page rules come from core/print.ts (every piece of file text escaped).
// State attributes for tests: #app data-print ("printing" while the dialog is open, then "done" or
// "failed"), data-prints (a counter).
import { fallbackFooter, pageName, pageRules, printTitle, type PrintOptions } from "../core/print";
import type { PrintedFile } from "../editor/print-render";
import { PRINT_INK } from "../theme/print-ink";
import { h } from "./dom";

/** The browser draws CSS page margin boxes (Chromium 131 and later): an at-rule it parses into the page rule's own rules. */
export function drawsMarginBoxes(): boolean {
  const probe = h("style", null, "@page { @bottom-center { content: 'x'; } }");
  document.head.append(probe);
  try {
    const rule = probe.sheet?.cssRules[0] as (CSSRule & { cssRules?: CSSRuleList }) | undefined;
    return (rule?.cssRules?.length ?? 0) > 0;
  } catch {
    return false;
  } finally {
    probe.remove();
  }
}

/** The date in the footer, as this browser's language writes it ("23 Oct 2026"). */
export const footerDate = (now: Date): string => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(now);

export interface Layout {
  readonly root: HTMLElement;
  readonly sheet: HTMLStyleElement;
  readonly title: string;
}

/** The print layout of `files` with `options`, not yet in the page. */
export function buildLayout(files: readonly PrintedFile[], options: PrintOptions, at: { date: string; boxes: boolean; font: string }): Layout {
  const root = h("div", {
    class: "print-root", id: "print-root", "aria-hidden": "true",
    "data-colours": options.colours, "data-numbers": String(options.numbers), "data-boxes": String(at.boxes),
  });
  // The print-safe palette is token values on the layout's root: the same rules paint both choices.
  if (options.colours === "print") for (const [token, value] of Object.entries(PRINT_INK)) root.style.setProperty(`--${token}`, value);
  files.forEach((file, i) => {
    const rows = file.lines.map((line) => {
      const code = h("td", { class: "print-c" });
      for (const run of line.runs) {
        const cls = [run.token === "text" ? "" : `t-${run.token}`, run.italic ? "i" : ""].filter(Boolean).join(" ");
        code.append(cls ? h("span", { class: cls }, run.text) : document.createTextNode(run.text));
      }
      return h("tr", { class: "print-line" }, h("td", { class: "print-n" }, String(line.number)), code);
    });
    const table = h("table", { class: "print-table" });
    if (options.footer) table.append(h("tfoot", { class: "print-foot" }, h("tr", null, h("td", { colspan: "2" }, fallbackFooter(file.path, at.date)))));
    table.append(h("tbody", null, ...rows));
    const section = h("section", { class: "print-file", "data-path": file.path }, h("h1", { class: "print-path" }, file.path), table);
    section.style.setProperty("tab-size", String(file.tabSize));
    // A named page per file, so its margin boxes can say its path (pageRules).
    if (options.footer) section.style.setProperty("page", pageName(i));
    root.append(section);
  });
  // The margin boxes sit on the paper's own margin in both colour choices, so they take the print-safe ink.
  const footer = { paths: files.map((f) => f.path), date: at.date, ink: PRINT_INK["text-secondary"], font: at.font };
  const sheet = h("style", { id: "print-pages" }, pageRules(options.footer ? footer : null));
  return { root, sheet, title: printTitle(files.map((f) => f.path)) };
}

export interface PrintRun {
  /** #app, for the state attributes. */
  readonly app: HTMLElement;
  /** Called once the print dialog has closed (or failed to open), after the layout is gone. */
  readonly done: (ok: boolean) => void;
  /**
   * Where focus goes back when it was lost meanwhile: printing lays the page out for paper, where
   * the app is display: none, and an engine that fixes focus up then drops it to the body.
   */
  readonly returnFocus: () => HTMLElement | null;
  /** window.print, swappable for tests of the flow (never the real dialog's look). */
  readonly print?: () => void;
}

let current: (() => void) | null = null;

/**
 * Adds the layout, opens the browser's print dialog, and takes everything away again on
 * afterprint: the layout, the page rules, the title and html's data-printing. A second export
 * while a layout is still in the page (a browser that never said afterprint) replaces it.
 */
export async function printLayout(layout: Layout, run: PrintRun): Promise<void> {
  current?.();
  const html = document.documentElement;
  const title = document.title;
  const mark = (state: string) => {
    run.app.dataset.print = state;
    run.app.dataset.prints = String((Number(run.app.dataset.prints) || 0) + 1);
  };
  let cleaned = false;
  const cleanup = (ok: boolean) => {
    if (cleaned) return;
    cleaned = true;
    current = null;
    removeEventListener("afterprint", onAfter);
    layout.root.remove();
    layout.sheet.remove();
    delete html.dataset.printing;
    document.title = title;
    const now = document.activeElement;
    if (!now || now === document.body) {
      const target = run.returnFocus();
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
    mark(ok ? "done" : "failed");
    run.done(ok);
  };
  const onAfter = () => cleanup(true);
  current = () => cleanup(true);
  document.head.append(layout.sheet);
  document.body.append(layout.root);
  html.dataset.printing = "true";
  document.title = layout.title;
  // The code's faces (400, its italic for comments, 600 for the heading) before the browser lays out the pages.
  if (document.fonts) {
    const family = getComputedStyle(layout.root.querySelector(".print-c") ?? layout.root).fontFamily;
    await Promise.allSettled(["400 9pt", "italic 400 9pt", "600 11pt"].map((f) => document.fonts.load(`${f} ${family}`)));
    await document.fonts.ready;
  }
  addEventListener("afterprint", onAfter);
  run.app.dataset.print = "printing";
  try {
    (run.print ?? (() => window.print()))();
  } catch {
    cleanup(false);
  }
}
