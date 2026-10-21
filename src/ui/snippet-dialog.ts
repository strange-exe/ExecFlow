// The Capture snippet dialog (final-v3 section 5), a lazy chunk with its stylesheet: the preview
// (the export bitmap itself, named by its text alternative), the options (Colours; Show: line
// numbers, file name), and Copy image / Download (.png) in a footer that never scrolls away. Built
// per opening and removed on close, so no listener outlives it. The preview and the exports run
// through snippet-flow.ts; results speak in the status line while open and in the page's notice
// after close. State attributes (data-preview, data-renders, data-preview-options,
// data-preview-pending, data-compact; #app data-capture, data-capture-reason, data-captures) are
// what tests wait on, never wording.
import "../styles/snippet-image.css";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nameOf } from "../core/paths";
import { cleanImageOptions, lineWords, type CaptureMessage, type ImageOptions, type LineSpan, type PaintFamily, type Tone } from "../core/snippet";
import { captureMessage, colorChoices, dialogTitle, downloadName, IMAGE_TOKENS, NO_PREVIEW, previewLabel, writeImageOptions } from "../core/snippet-dialog";
import { drawImage, freeCanvas, prepare, readbackOk, type CodeFont, type DrawnImage, type Prepared } from "../editor/snippet-canvas";
import { layoutImage } from "../editor/snippet-render";
import { allThemes } from "../theme/themes";
import { dialogShell, openModal } from "./dialogs";
import { downloadBlob, h } from "./dom";
import { icon, type IconName } from "./icons";
import type { Notice } from "./notice";
import {
  createExporter, createPreviewScheduler, frameBudget, frameContent, frameEstimate, imageColors, sameOptions,
  type BudgetMeasures, type ExportKind, type ExportResult, type Paint, type RenderFailure,
} from "./snippet-flow";

export interface SnippetDialogArgs {
  /** The file's live state, read once when the dialog opens (the editor is inert behind the modal). */
  readonly state: EditorState;
  readonly view: EditorView;
  readonly plan: LineSpan;
  readonly path: string;
  readonly options: ImageOptions;
  readonly canCopy: boolean;
  /** Evaluated at close (5.6); null when it has done the focusing itself (the code, through view.focus()). */
  readonly returnTo: () => HTMLElement | null;
  /** #app. */
  readonly root: HTMLElement;
  readonly notice: Pick<Notice, "show" | "clear">;
  readonly storage: Pick<Storage, "setItem"> | null;
}

const TONE_ICON: Record<Tone, IconName> = { info: "info", error: "warning-circle", success: "check-circle" };
/** iOS fetches a download only after its prompt: the blob URL lives a minute. */
const KEEP_MS = 60_000;
const LAYOUTS = [{ numbers: true, name: true }, { numbers: true, name: false }, { numbers: false, name: true }, { numbers: false, name: false }];

/** What the document root painted, once per opening (never #app, which carries no theme attributes). */
function readPaint(): Paint {
  const root = document.documentElement;
  const palette = root.dataset.palette;
  const family: PaintFamily = palette === undefined ? "deep-field" : palette === "slate" ? "slate" : "palette";
  const style = getComputedStyle(root);
  return {
    family,
    scheme: root.dataset.theme === "dark" ? "dark" : "light",
    themeName: allThemes().find((t) => t.id === root.dataset.themeId)?.name ?? null,
    computed: Object.fromEntries(IMAGE_TOKENS.map((t) => [t, style.getPropertyValue(`--${t}`).trim()])),
  };
}

/** The code font as the editor shows it (--code-size lives on #app, so read the editor, not the root). */
function readFont(view: EditorView): CodeFont {
  const style = getComputedStyle(view.contentDOM);
  const size = parseFloat(style.fontSize);
  return { family: style.fontFamily || "monospace", size: Number.isFinite(size) && size > 0 ? size : 15 };
}

const optionsWord = (o: ImageOptions) => `${o.colors} ${o.numbers ? "numbers" : "no-numbers"} ${o.name ? "name" : "no-name"}`;

const failureMessage = (reason: RenderFailure): CaptureMessage =>
  reason === "too-big" ? { kind: "refused", reason: "too-big" } : reason === "device" ? { kind: "failed", reason: "device" } : { kind: "preview-failed" };

export function openSnippetDialog(args: SnippetDialogArgs): void {
  const { plan, path, root, notice } = args;
  const name = nameOf(path);
  const paint = readPaint();
  const font = readFont(args.view);
  const at = { coarse: false, entry: "menu" as const, open: true };
  let options = cleanImageOptions(args.options);
  let partial = false;

  // ---------------------------------------------------------------- the dialog (5.1)
  const { dialog, body } = dialogShell("snippet-dialog", dialogTitle(plan), { wide: true });
  dialog.classList.add("snippet-dialog");
  dialog.dataset.preview = "rendering";
  const frame = h("div", {
    id: "snippet-frame", class: "snippet-frame", role: "img", tabindex: "0", "aria-busy": "true",
    "aria-label": previewLabel(plan, name, options, paint, false),
  });
  const note = (id: string, m: CaptureMessage) => h("p", { id, class: "snippet-note" }, icon("info"), h("span", null, captureMessage(m, at).text));
  const describedBy = ["snippet-frame"];
  const gapsNote = plan.gaps ? note("snippet-gaps", { kind: "gaps" }) : null;
  if (gapsNote) describedBy.push("snippet-gaps");
  dialog.setAttribute("aria-describedby", describedBy.join(" "));

  const choice = (input: HTMLInputElement, label: string) => h("div", { class: "snippet-choice" }, input, h("label", { for: input.id }, label));
  const radios = colorChoices(paint).map((c) => {
    const input = h("input", { type: "radio", name: "snippet-colors", value: c.value, id: `snippet-colors-${c.value}` });
    input.checked = c.value === options.colors;
    return { input, row: choice(input, c.label) };
  });
  const box = (id: string, checked: boolean) => {
    const input = h("input", { type: "checkbox", id });
    input.checked = checked;
    return input;
  };
  const numbersBox = box("snippet-numbers", options.numbers);
  const nameBox = box("snippet-name", options.name);
  const colours = h("fieldset", null, h("legend", null, "Colours"), ...radios.map((r) => r.row));
  const show = h("fieldset", null, h("legend", null, "Show"), choice(numbersBox, "Line numbers"), choice(nameBox, "File name"));
  body.append(frame, ...(gapsNote ? [gapsNote] : []), h("div", { class: "snippet-options" }, colours, show));

  const status = h("p", { id: "snippet-status", class: "snippet-status", role: "status" });
  const download = h("button", { type: "button", class: args.canCopy ? "btn" : "btn primary", autofocus: !args.canCopy }, icon("download-simple"), "Download (.png)");
  const copy = args.canCopy ? h("button", { type: "button", class: "btn primary", autofocus: true }, icon("copy"), "Copy image") : null;
  // A sibling after the body: it never scrolls away (except in compact mode, where the dialog scrolls).
  const actions = h("div", { class: "dialog-actions snippet-actions" }, status, download, copy);
  dialog.append(actions);
  const primary = copy ?? download;

  // ---------------------------------------------------------------- the status line (6.1)
  type StatusKind = "empty" | "preview-pending" | "export-pending" | "result";
  let statusKind: StatusKind = "empty";
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  function setStatus(m: CaptureMessage | null, kind: StatusKind) {
    statusKind = m ? kind : "empty";
    if (!m) {
      status.replaceChildren();
      delete status.dataset.tone;
      return;
    }
    const { text, tone } = captureMessage(m, at);
    status.dataset.tone = tone;
    status.replaceChildren(icon(TONE_ICON[tone]), h("span", null, text));
  }
  /**
   * Cleared now and set 50 ms later, so the same sentence twice is read twice; `then` sets the state
   * attributes in that same step. `closed`: what to do instead when the dialog closed in those 50 ms
   * (an export's result then goes to the page's notice, 6.1, never to a detached status line).
   */
  function say(m: CaptureMessage, then?: () => void, closed?: () => void) {
    clearTimeout(sayTimer);
    setStatus(null, "empty");
    sayTimer = setTimeout(() => {
      if (closed && !isOpen()) {
        closed();
        return;
      }
      setStatus(m, "result");
      then?.();
    }, 50);
  }
  function mark(capture: string, reason: string | null) {
    root.dataset.capture = capture;
    if (reason) root.dataset.captureReason = reason;
    else delete root.dataset.captureReason;
    root.dataset.captures = String((Number(root.dataset.captures) || 0) + 1);
  }

  // ---------------------------------------------------------------- the frame's size (5.2)
  let prepared: Prepared | null = null;
  let layouts: { width: number; height: number }[] | null = null;
  let frameCap = 420;
  function measures(): BudgetMeasures {
    const height = (el: Element | null) => el?.getBoundingClientRect().height ?? 0;
    const firstChoice = colours.querySelector(".snippet-choice");
    return {
      innerHeight,
      head: height(dialog.querySelector(".dialog-head")),
      footer: height(actions),
      notes: [...body.querySelectorAll(".snippet-note")].map(height),
      firstRow: firstChoice ? firstChoice.getBoundingClientRect().bottom - colours.getBoundingClientRect().top : 0,
    };
  }
  function sizeFrame() {
    const content = layouts
      ? frameContent(layouts, frame.clientWidth - 16, frameCap)
      : Math.min(frameCap, Math.max(96, frameEstimate(plan.last - plan.first + 1, font.size * 1.5, options.name)));
    frame.style.height = `${content + 18}px`;
  }
  function fitCanvas(r: DrawnImage) {
    const fit = Math.min(1, Math.max(1, frame.clientWidth - 16) / r.layout.width);
    r.canvas.style.width = `${r.layout.width * fit}px`;
    r.canvas.style.height = `${r.layout.height * fit}px`;
  }
  /**
   * Compact mode makes the dialog the one scroller after the primary action already took focus (and
   * the first render then changes the frame's height): the focused control is brought back into
   * view, so focus never sits out of sight (WCAG 2.4.7 and 2.4.11).
   */
  function keepFocusInView() {
    const focused = document.activeElement;
    if (!dialog.hasAttribute("data-compact") || !(focused instanceof HTMLElement) || !dialog.contains(focused)) return;
    // The frame, a tall scroller of its own, needs only its top edge in view: "nearest" would scroll
    // the dialog's title away to show the frame's bottom.
    if (focused === frame) {
      const top = frame.getBoundingClientRect().top - dialog.getBoundingClientRect().top;
      if (top >= 0 && top < dialog.clientHeight) return;
    }
    focused.scrollIntoView({ block: "nearest" });
  }
  let budgeted = false;
  function applyBudget() {
    const b = frameBudget(measures());
    dialog.toggleAttribute("data-compact", b.compact);
    frameCap = b.frameCap;
    sizeFrame();
    const shownNow = scheduler.current()?.result;
    if (shownNow) fitCanvas(shownNow);
    if (!budgeted && b.compact) {
      // Opening in compact mode: focus on the primary action would scroll the title and the preview
      // out of view, so the preview frame, the dialog's first content, takes it and the dialog shows
      // its top (the WAI-ARIA APG modal dialog's advice for content taller than the window).
      frame.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    }
    budgeted = true;
    keepFocusInView();
  }

  // ---------------------------------------------------------------- the preview (5.3, 7.3)
  let preparing: Promise<Prepared> | null = null;
  const scheduler = createPreviewScheduler<DrawnImage>({
    async render(o, signal) {
      const colors = imageColors(o.colors, paint);
      if (!colors) return { ok: false, reason: "failed" };
      const p = await preparing!;
      if (signal.stopped) return { ok: false, reason: "stopped" };
      return drawImage(p, o, colors, signal, font, name);
    },
    free: (r) => freeCanvas(r.canvas),
    swap(r, o) {
      r.canvas.setAttribute("aria-hidden", "true");
      if (!layouts && prepared) {
        // The first render landed: the frame takes its height for the whole opening (the tallest of the four layouts).
        const rows = prepared.rows;
        layouts = LAYOUTS.map((l) => layoutImage(rows, r.metrics, l));
        sizeFrame();
      }
      fitCanvas(r);
      frame.replaceChildren(r.canvas);
      keepFocusInView();
      dialog.dataset.renders = String((Number(dialog.dataset.renders) || 0) + 1);
      dialog.dataset.previewOptions = optionsWord(o);
      frame.setAttribute("aria-label", previewLabel(plan, name, o, paint, partial));
      frame.setAttribute("aria-busy", "false");
    },
    fail(reason, o) {
      const m = failureMessage(reason);
      frame.replaceChildren(h("p", { class: "snippet-frame-text" }, captureMessage(m, at).text));
      frame.setAttribute("aria-label", reason === "too-big" ? NO_PREVIEW["too-big"] : NO_PREVIEW.failed);
      dialog.dataset.renders = String((Number(dialog.dataset.renders) || 0) + 1);
      dialog.dataset.previewOptions = optionsWord(o);
      say(m);
    },
    state(s) {
      dialog.dataset.preview = s;
      frame.setAttribute("aria-busy", String(s === "rendering"));
    },
    pending(on, first) {
      if (on) {
        dialog.dataset.previewPending = "true";
        if (statusKind !== "export-pending" && statusKind !== "result") setStatus({ kind: first ? "making-preview" : "updating-preview" }, "preview-pending");
      } else {
        delete dialog.dataset.previewPending;
        if (statusKind === "preview-pending") setStatus(null, "empty");
      }
    },
  });

  // ---------------------------------------------------------------- exports (5.5, 7.5)
  const what = `${name}, ${lineWords(plan.first, plan.last)}`;
  const fileName = (o: ImageOptions) => downloadName(path, plan.first, plan.last, { name: o.name });
  const isOpen = () => dialog.open && dialog.isConnected;
  function resultOf(r: ExportResult, kind: ExportKind): { m: CaptureMessage; capture: string; reason: string | null } {
    switch (r.kind) {
      case "copied":
        return { m: { kind: "copied", what }, capture: "copied", reason: null };
      case "downloaded":
        return { m: { kind: "downloaded", file: r.file }, capture: "downloaded", reason: null };
      case "denied":
        return { m: { kind: "denied" }, capture: "denied", reason: null };
      case "refused":
        return { m: { kind: "refused", reason: "too-big" }, capture: "refused", reason: "too-big" };
      case "preview-failed":
        return { m: { kind: "preview-failed" }, capture: "failed", reason: "other" };
      case "failed":
        return {
          m: r.reason === "updating" ? { kind: "failed", reason: "updating", action: kind } : { kind: "failed", reason: r.reason },
          capture: "failed",
          reason: r.reason,
        };
    }
  }
  const exporter = createExporter<DrawnImage>({
    scheduler,
    readbackOk: (r) => readbackOk(r.canvas, r.colors, r.t),
    toBlob: (r, done) => r.canvas.toBlob(done, "image/png"),
    write(png) {
      try {
        return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    // The link goes inside the open dialog: the rest of the page is inert under it.
    download: (file, blob) => downloadBlob(file, blob, { keepMs: KEEP_MS, parent: isOpen() ? dialog : document.body }),
    options: () => options,
    fileName,
    previewProblem() {
      const c = scheduler.current();
      return c?.failure && sameOptions(c.options, options) ? c.failure : null;
    },
    started() {
      setStatus(null, "empty");
      root.dataset.capture = "exporting";
      delete root.dataset.captureReason;
    },
    pending(on) {
      if (on) setStatus({ kind: "making-png" }, "export-pending");
    },
    finish(result, kind, open) {
      const { m, capture, reason } = resultOf(result, kind);
      // After close: the page's notice (cleared first, set 50 ms later), with the PNG already made for a denied copy.
      const toNotice = () => {
        notice.clear();
        setTimeout(() => {
          const { text, tone } = captureMessage(m, { ...at, open: false });
          const action = result.kind === "denied" ? { label: "Download instead", run: () => downloadBlob(result.file, result.blob, { keepMs: KEEP_MS }) } : undefined;
          notice.show(text, { tone, action });
          mark(capture, reason);
        }, 50);
      };
      if (open) say(m, () => mark(capture, reason), toNotice);
      else toNotice();
    },
    isOpen,
  });

  // ---------------------------------------------------------------- wiring
  function changed() {
    // A new choice makes the last result stale: cleared without an announcement. An export's own pending text stays until its result.
    if (statusKind !== "export-pending") setStatus(null, "empty");
    const colors = radios.find((r) => r.input.checked)?.input.value;
    options = cleanImageOptions({ colors, numbers: numbersBox.checked, name: nameBox.checked });
    writeImageOptions(args.storage, options);
    scheduler.request(options);
  }
  for (const r of radios) r.input.addEventListener("change", changed);
  numbersBox.addEventListener("change", changed);
  nameBox.addEventListener("change", changed);
  copy?.addEventListener("click", (e) => exporter.copy(e));
  download.addEventListener("click", (e) => exporter.download(e));
  // One export per press: a held Enter or Space on Copy or Download repeats nothing.
  dialog.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat && (e.key === "Enter" || e.key === " ") && (e.target === copy || e.target === download)) e.preventDefault();
    },
    true,
  );
  const onResize = () => applyBudget();
  dialog.addEventListener(
    "close",
    () => {
      scheduler.cancel();
      removeEventListener("resize", onResize);
      dialog.remove();
    },
    { once: true },
  );

  openModal(dialog, primary, args.returnTo);
  applyBudget();
  addEventListener("resize", onResize);
  preparing = prepare(args.state, plan).then((p) => {
    prepared = p;
    if (p.partial && isOpen()) {
      partial = true;
      (gapsNote ?? frame).after(note("snippet-partial", { kind: "partial" }));
      dialog.setAttribute("aria-describedby", [...describedBy, "snippet-partial"].join(" "));
      applyBudget();
    }
    return p;
  });
  scheduler.request(options);
}
