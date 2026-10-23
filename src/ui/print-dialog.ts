// Save as PDF (.claude/design/pdf.md): a dialog to choose the files and the look, then the
// browser's own print dialog over a print-only layout of them (print-view.ts), where "Save as PDF"
// is one of the printers. A lazy chunk with its stylesheet; CodeMirror's part (the highlighting,
// editor/print-render.ts) is fetched when the dialog opens and used on the primary action. Built per
// opening and removed on close. State attributes for tests: the dialog's data-state ("ready",
// "preparing"), #app data-print and data-prints (print-view.ts).
import "../styles/print.css";
import { nameOf, parentOf } from "../core/paths";
import {
  choiceProblem, cleanPrintOptions, MADE_WITH, NEXT_STEP, printMessage, readPrintOptions, writePrintOptions,
  type PrintMessage, type PrintOptions,
} from "../core/print";
import type { PrintedFile, PrintSource } from "../editor/print-render";
import { dialogShell, openModal } from "./dialogs";
import { h } from "./dom";
import { icon } from "./icons";
import type { Notice } from "./notice";
import { buildLayout, drawsMarginBoxes, footerDate, printLayout } from "./print-view";

export interface PrintDialogArgs {
  /** The workspace's text files, in the tree's order. */
  readonly files: readonly string[];
  /** Checked when the dialog opens (the open file). */
  readonly checked: readonly string[];
  /** A file's text, and its live state when it is open (unsaved typing included). */
  readonly read: (path: string) => Promise<PrintSource>;
  /** #app. */
  readonly app: HTMLElement;
  readonly notice: Pick<Notice, "show">;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** Where focus goes when the dialog closes (dialogs.ts openModal). */
  readonly returnTo: HTMLElement | (() => HTMLElement | null) | null;
  /** window.print, swappable (print-view.ts PrintRun). */
  readonly print?: () => void;
}

let open = false;

export function openPrintDialog(args: PrintDialogArgs): void {
  if (open || document.querySelector("dialog[open], .menu")) return;
  // Fetched now, used on the primary action: the dialog itself never waits for CodeMirror.
  const loadRenderer = () => {
    const p = import("../editor/print-render");
    p.catch(() => {});
    return p;
  };
  let renderer: ReturnType<typeof loadRenderer> | null = loadRenderer();
  let options: PrintOptions = readPrintOptions(args.storage);
  const boxes = drawsMarginBoxes();

  const { dialog, body } = dialogShell("pdf-dialog", "Save as PDF", { wide: true });
  dialog.classList.add("pdf-dialog");
  body.append(h("p", { class: "pdf-next", id: "pdf-next" }, icon("info"), h("span", null, NEXT_STEP)));
  dialog.setAttribute("aria-describedby", "pdf-next");

  // ---------------------------------------------------------------- the files
  const boxesByPath = new Map<string, HTMLInputElement>();
  const fileRows = args.files.map((path, i) => {
    const input = h("input", { type: "checkbox", id: `pdf-file-${i}`, "data-path": path });
    input.checked = args.checked.includes(path);
    boxesByPath.set(path, input);
    const folder = parentOf(path);
    return h("div", { class: "pdf-choice pdf-file" }, input, h("label", { for: input.id }, folder ? h("span", { class: "pdf-folder" }, `${folder}/`) : null, nameOf(path)));
  });
  const all = h("button", { type: "button", class: "text-btn", id: "pdf-all" }, "Select all");
  const none = h("button", { type: "button", class: "text-btn", id: "pdf-none" }, "Clear");
  // Always rendered (empty takes no room), so an error added while focus stays put is heard.
  const live = h("div", { class: "pdf-files-live", "aria-live": "polite" });
  const files = h(
    "fieldset",
    { class: "pdf-files" },
    h("legend", null, "Files"),
    h("div", { class: "pdf-quick" }, all, none),
    live,
    h("div", { class: "pdf-files-list" }, ...(fileRows.length ? fileRows : [h("p", { class: "pdf-hint" }, "There are no text files to save.")])),
  );

  // ---------------------------------------------------------------- the look
  const radio = (value: PrintOptions["colours"], label: string, hint: string) => {
    const input = h("input", { type: "radio", name: "pdf-colours", value, id: `pdf-colours-${value}`, "aria-describedby": `pdf-colours-${value}-hint` });
    input.checked = options.colours === value;
    return { input, row: h("div", { class: "pdf-choice" }, input, h("label", { for: input.id }, label), h("p", { class: "pdf-hint", id: `pdf-colours-${value}-hint` }, hint)) };
  };
  const printRadio = radio("print", "Print-safe light", "Dark ink on white paper.");
  const themeRadio = radio("theme", "The editor's colours", "As on screen, with the code's background.");
  const box = (id: string, checked: boolean, label: string, hint?: string) => {
    const input = h("input", { type: "checkbox", id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) });
    input.checked = checked;
    return { input, row: h("div", { class: "pdf-choice" }, input, h("label", { for: id }, label), hint ? h("p", { class: "pdf-hint", id: `${id}-hint` }, hint) : null) };
  };
  const numbers = box("pdf-numbers", options.numbers, "Line numbers");
  const footer = box(
    "pdf-footer", options.footer, `"${MADE_WITH}" footer`,
    boxes ? `On every page: the file, the page number, the date and "${MADE_WITH}".` : `The file, the date and "${MADE_WITH}". This browser can't number the pages.`,
  );
  body.append(
    files,
    h(
      "div",
      { class: "pdf-options" },
      h("fieldset", null, h("legend", null, "Colours"), printRadio.row, themeRadio.row),
      h("fieldset", null, h("legend", null, "Show"), numbers.row, footer.row),
    ),
  );

  const status = h("p", { class: "pdf-status", id: "pdf-status", role: "status" });
  const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
  const primary = h("button", { type: "button", class: "btn primary", id: "pdf-print" }, icon("printer"), "Open print dialog");
  dialog.append(h("div", { class: "dialog-actions pdf-actions" }, status, cancel, primary));

  // ---------------------------------------------------------------- wiring
  const changed = () => {
    options = cleanPrintOptions({ colours: themeRadio.input.checked ? "theme" : "print", numbers: numbers.input.checked, footer: footer.input.checked });
    writePrintOptions(args.storage, options);
  };
  for (const input of [printRadio.input, themeRadio.input, numbers.input, footer.input]) input.addEventListener("change", changed);
  const chosen = () => args.files.filter((p) => boxesByPath.get(p)?.checked);
  function showError(m: PrintMessage | null) {
    live.replaceChildren(...(m ? [h("p", { class: "field-error", id: "pdf-files-error" }, icon("warning-circle"), h("span", null, printMessage(m).text))] : []));
    if (m) files.setAttribute("aria-describedby", "pdf-files-error");
    else files.removeAttribute("aria-describedby");
  }
  const setAll = (on: boolean) => {
    for (const input of boxesByPath.values()) input.checked = on;
    if (on) showError(null);
  };
  all.addEventListener("click", () => setAll(true));
  none.addEventListener("click", () => setAll(false));
  for (const input of boxesByPath.values()) input.addEventListener("change", () => input.checked && showError(null));
  cancel.addEventListener("click", () => dialog.close());

  const say = (m: PrintMessage | null) => {
    if (!m) {
      status.replaceChildren();
      delete status.dataset.tone;
      return;
    }
    const { text, tone } = printMessage(m);
    status.dataset.tone = tone;
    status.replaceChildren(icon(tone === "error" ? "warning-circle" : "info"), h("span", null, text));
  };

  let busy = false;
  async function go() {
    if (busy) return;
    const paths = chosen();
    if (!paths.length) {
      showError({ kind: "no-files" });
      (boxesByPath.values().next().value ?? primary).focus();
      return;
    }
    busy = true;
    dialog.dataset.state = "preparing";
    say({ kind: "preparing" });
    try {
      const sources: PrintSource[] = [];
      for (const path of paths) {
        try {
          sources.push(await args.read(path));
        } catch {
          return fail({ kind: "read-failed", path });
        }
      }
      const problem = choiceProblem(sources.map((s) => (s.state ? s.state.doc.lines : s.text.split("\n").length)));
      if (problem) {
        showError({ kind: "too-many", text: problem });
        return fail(null);
      }
      let printed: PrintedFile[];
      try {
        renderer ??= loadRenderer();
        const { printFile } = await renderer;
        printed = [];
        for (const s of sources) printed.push(await printFile(s));
      } catch {
        // The next press fetches the highlighting code again (a lazy chunk that failed, say offline).
        renderer = null;
        return fail({ kind: "prepare-failed" });
      }
      if (!dialog.open) return; // closed while preparing: nothing prints
      const font = getComputedStyle(document.body).fontFamily;
      const layout = buildLayout(printed, options, { date: footerDate(new Date()), boxes, font });
      const partial = printed.filter((f) => f.partial).map((f) => f.path);
      // The dialog closes first, so the app is what's left behind the print dialog and focus goes back where it was.
      dialog.close();
      await printLayout(layout, {
        app: args.app,
        print: args.print,
        returnFocus: () => (typeof args.returnTo === "function" ? args.returnTo() : args.returnTo),
        done(ok) {
          if (!ok) args.notice.show(printMessage({ kind: "print-failed" }).text, { tone: "error" });
          else if (partial.length) args.notice.show(printMessage({ kind: "partial", paths: partial }).text, { tone: "info" });
        },
      });
    } finally {
      busy = false;
    }
  }
  function fail(m: PrintMessage | null) {
    dialog.dataset.state = "ready";
    say(m);
  }
  primary.addEventListener("click", (e) => {
    // The second click of a double click does nothing (the Run rule).
    if (e.detail > 1) return;
    void go();
  });

  dialog.addEventListener("close", () => {
    dialog.remove();
    open = false;
  }, { once: true });
  open = true;
  const first = args.checked.length ? primary : (boxesByPath.values().next().value ?? primary);
  openModal(dialog, first, args.returnTo);
  dialog.dataset.state = "ready";
}
