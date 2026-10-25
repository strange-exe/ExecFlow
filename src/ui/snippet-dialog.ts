// The Capture snippet dialog (final-v3 section 5; round 2, .claude/design/batch3/s.md), a lazy chunk
// with its stylesheet: the preview (the export bitmap itself, named by its text alternative, centred
// on a stage that keeps one height for the opening), the options (Colours; Show: line numbers, file
// name, the "Made with CodeEditor" line; Background; Frame; Scale with the PNG's exact size; Highlight lines), and Copy image /
// Download (.png) in a footer that never scrolls away, the status sharing the buttons' row where it
// fits. Built per opening and removed on close, so no listener outlives it. The preview and the
// exports run through snippet-flow.ts; results speak in the status line while open and in the page's
// notice after close. State attributes (data-preview, data-renders, data-preview-options,
// data-preview-pending, data-compact; #app data-capture, data-capture-reason, data-captures) are
// what tests wait on, never wording.
import "../styles/snippet-image.css";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nameOf } from "../core/paths";
import { lineWords, type CaptureMessage, type LineSpan, type PaintFamily, type Tone } from "../core/snippet";
import {
  captureMessage, cleanImageOptions, colorChoices, CREDIT_TEXT, dialogTitle, downloadName, highlightHint, IMAGE_TOKENS, NO_PREVIEW, optionsWord, PADDING,
  parseHighlight, previewLabel, readImageOptions, sizeLine, writeImageOptions, type ImageOptions, type StoredOptions,
} from "../core/snippet-dialog";
import { drawImage, freeCanvas, layoutOf, prepare, readbackOk, type CodeFont, type DrawnImage, type Prepared } from "../editor/snippet-canvas";
import { chooseScale, layoutImage, type Metrics } from "../editor/snippet-render";
import { allThemes } from "../theme/themes";
import { dialogShell, openModal } from "./dialogs";
import { downloadBlob, h } from "./dom";
import { icon, type IconName } from "./icons";
import type { Notice } from "./notice";
import {
  createExporter, createPreviewScheduler, frameBudget, frameContent, frameEstimate, imageColors, previewFit, sameOptions,
  type BudgetMeasures, type ExportKind, type ExportResult, type Paint, type RenderFailure,
} from "./snippet-flow";

export interface SnippetDialogArgs {
  /** The file's live state, read once when the dialog opens (the editor is inert behind the modal). */
  readonly state: EditorState;
  readonly view: EditorView;
  readonly plan: LineSpan;
  readonly path: string;
  readonly canCopy: boolean;
  /** Evaluated at close (5.6); null when it has done the focusing itself (the code, through view.focus()). */
  readonly returnTo: () => HTMLElement | null;
  /** #app. */
  readonly root: HTMLElement;
  readonly notice: Pick<Notice, "show" | "clear">;
  /** Where the options are remembered (null or throwing: the defaults, and changes last for the opening). */
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
}

const TONE_ICON: Record<Tone, IconName> = { info: "info", error: "warning-circle", success: "check-circle" };
/** iOS fetches a download only after its prompt: the blob URL lives a minute. */
const KEEP_MS = 60_000;
/**
 * The default look's layouts (medium background, plain frame) with either toggle: the stage keeps
 * the tallest for the opening. A taller look shrinks to the stage (previewFit) rather than reserving
 * room that pushes the options below the fold (fix stage, 2026-10-23).
 */
const STAGE_LAYOUTS = [true, false].flatMap((numbers) => [true, false].map((name) => ({ numbers, name, frame: "plain" as const, pad: PADDING.medium, credit: true })));

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

const failureMessage = (reason: RenderFailure): CaptureMessage =>
  reason === "too-big" ? { kind: "refused", reason: "too-big" } : reason === "device" ? { kind: "failed", reason: "device" } : { kind: "preview-failed" };

export function openSnippetDialog(args: SnippetDialogArgs): void {
  const { plan, path, root, notice } = args;
  const name = nameOf(path);
  const paint = readPaint();
  const font = readFont(args.view);
  const at = { coarse: false, entry: "menu" as const, open: true };
  let stored: StoredOptions = readImageOptions(args.storage);
  /** This opening's highlighted lines (never remembered: they name lines of this capture). */
  let highlight: readonly number[] = [];
  const options = (): ImageOptions => ({ ...stored, highlight });
  let partial = false;

  // ---------------------------------------------------------------- the dialog (5.1)
  const { dialog, body } = dialogShell("snippet-dialog", dialogTitle(plan), { wide: true });
  dialog.classList.add("snippet-dialog");
  dialog.dataset.preview = "rendering";
  const frame = h("div", {
    id: "snippet-frame", class: "snippet-frame", role: "img", tabindex: "0", "aria-busy": "true",
    "aria-label": previewLabel(plan, name, options(), paint, false),
  });
  const note = (id: string, m: CaptureMessage) => h("p", { id, class: "snippet-note" }, icon("info"), h("span", null, captureMessage(m, at).text));
  const describedBy = ["snippet-frame"];
  const gapsNote = plan.gaps ? note("snippet-gaps", { kind: "gaps" }) : null;
  if (gapsNote) describedBy.push("snippet-gaps");
  dialog.setAttribute("aria-describedby", describedBy.join(" "));

  // ---------------------------------------------------------------- the options (5.4; round 2)
  const choice = (input: HTMLInputElement, label: string) => h("div", { class: "snippet-choice" }, input, h("label", { for: input.id }, label));
  /** A radio group: one Tab stop, arrows change the choice at once (Settings' theme radios do the same). */
  function radios(group: string, items: readonly { value: string; label: string }[], checked: string) {
    return items.map((c) => {
      const input = h("input", { type: "radio", name: `snippet-${group}`, value: c.value, id: `snippet-${group}-${c.value}` });
      input.checked = c.value === checked;
      return { input, row: choice(input, c.label) };
    });
  }
  const box = (id: string, checked: boolean) => {
    const input = h("input", { type: "checkbox", id });
    input.checked = checked;
    return input;
  };
  const colorRadios = radios("colors", colorChoices(paint), stored.colors);
  const numbersBox = box("snippet-numbers", stored.numbers);
  const nameBox = box("snippet-name", stored.name);
  const markBox = box("snippet-mark", stored.mark);
  const backgroundRadios = radios(
    "background",
    [{ value: "none", label: "None (the card alone)" }, { value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }],
    stored.background ? stored.padding : "none",
  );
  const frameRadios = radios("frame", [{ value: "plain", label: "Plain" }, { value: "window", label: "Window" }], stored.frame);
  const scaleRadios = radios("scale", [{ value: "1", label: "1x" }, { value: "2", label: "2x" }, { value: "3", label: "3x" }], String(stored.scale));
  const size = h("p", { id: "snippet-size", class: "snippet-size" });

  const field = h("input", {
    type: "text", id: "snippet-highlight", autocomplete: "off", spellcheck: "false", maxlength: "200", "aria-describedby": "snippet-highlight-hint",
  });
  const hint = h("p", { id: "snippet-highlight-hint", class: "field-note" }, highlightHint(plan));
  // Always rendered (empty takes no room), so a message added while focus stays in the field is heard.
  const live = h("div", { class: "snippet-highlight-live", "aria-live": "polite" });
  const fieldset = (legend: string, rows: readonly HTMLElement[]) => h("fieldset", null, h("legend", null, legend), ...rows);
  const rowsOf = (list: readonly { row: HTMLElement }[]) => list.map((r) => r.row);
  const colours = fieldset("Colours", rowsOf(colorRadios));
  const show = fieldset("Show", [choice(numbersBox, "Line numbers"), choice(nameBox, "File name"), choice(markBox, `"${CREDIT_TEXT}" line`)]);
  const scaleSet = h("fieldset", { class: "snippet-scale", "aria-describedby": "snippet-size" },
    h("legend", null, "Scale"), h("div", { class: "snippet-row" }, ...rowsOf(scaleRadios)), size);
  const highlightGroup = h("div", { class: "snippet-highlight field" }, h("label", { for: "snippet-highlight" }, "Highlight lines"), field, live, hint);
  body.append(
    frame,
    ...(gapsNote ? [gapsNote] : []),
    h(
      "div",
      { class: "snippet-options" },
      colours,
      show,
      fieldset("Background", rowsOf(backgroundRadios)),
      fieldset("Frame", rowsOf(frameRadios)),
      scaleSet,
      highlightGroup,
    ),
  );

  const status = h("p", { id: "snippet-status", class: "result-line snippet-status", role: "status" });
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
  /** The code font's measures, from the first render: the size line is worked out from them at once. */
  let metrics: Metrics | null = null;
  let layouts: { width: number; height: number }[] | null = null;
  let frameCap = 420;
  /** The stage's content height when it shows the default look whole; null while capped (it scrolls) or before the first render. */
  let stage: number | null = null;
  function measures(): BudgetMeasures {
    const height = (el: Element | null) => el?.getBoundingClientRect().height ?? 0;
    const firstChoice = colours.querySelector(".snippet-choice");
    // Where the status takes no room while empty (a line of its own on narrow footers), its two
    // lines are counted anyway: a result then shortens the scrolled body, never the frame's room.
    const lines = parseFloat(getComputedStyle(status).lineHeight);
    const reserve = status.getBoundingClientRect().height < 1 ? 2 * (Number.isFinite(lines) ? lines : 20) : 0;
    return {
      innerHeight,
      head: height(dialog.querySelector(".dialog-head")),
      footer: height(actions) + reserve,
      notes: [...body.querySelectorAll(".snippet-note")].map(height),
      firstRow: firstChoice ? firstChoice.getBoundingClientRect().bottom - colours.getBoundingClientRect().top : 0,
    };
  }
  function sizeFrame() {
    const inner = frame.clientWidth - 16;
    const content = layouts
      ? frameContent(layouts, inner, frameCap)
      : Math.min(frameCap, Math.max(96, frameEstimate(plan.last - plan.first + 1, font.size * 1.5, true, PADDING.medium)));
    stage = layouts && frameContent(layouts, inner, Infinity) <= frameCap ? content : null;
    frame.style.height = `${content + 18}px`;
  }
  function fitCanvas(r: DrawnImage) {
    const fit = previewFit(r.layout, frame.clientWidth - 16, stage);
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
        // The first render landed: the frame takes its height for the whole opening (the default look's tallest layout).
        const rows = prepared.rows;
        metrics = r.metrics;
        layouts = STAGE_LAYOUTS.map((l) => layoutImage(rows, r.metrics, l));
        sizeFrame();
      }
      fitCanvas(r);
      frame.replaceChildren(r.canvas);
      keepFocusInView();
      size.textContent = sizeLine(r.canvas.width, r.canvas.height, o.scale, r.scale);
      dialog.dataset.renders = String((Number(dialog.dataset.renders) || 0) + 1);
      dialog.dataset.previewOptions = optionsWord(o);
      frame.setAttribute("aria-label", previewLabel(plan, name, o, paint, partial));
      frame.setAttribute("aria-busy", "false");
    },
    fail(reason, o) {
      const m = failureMessage(reason);
      frame.replaceChildren(h("p", { class: "snippet-frame-text" }, captureMessage(m, at).text));
      frame.setAttribute("aria-label", reason === "too-big" ? NO_PREVIEW["too-big"] : NO_PREVIEW.failed);
      size.textContent = "";
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
    readbackOk: (r) => readbackOk(r),
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
    options,
    fileName,
    previewProblem() {
      const c = scheduler.current();
      return c?.failure && sameOptions(c.options, options()) ? c.failure : null;
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
  /** A new image was asked for: the last result is stale, cleared without an announcement (an export's own pending text stays until its result). */
  function request() {
    if (statusKind !== "export-pending") setStatus(null, "empty");
    const o = options();
    if (metrics && prepared) {
      // The size line describes the Scale group, so it changes with the choice, in the same task,
      // not when the render lands: the newly checked radio is read with the size it will make.
      const layout = layoutImage(prepared.rows, metrics, layoutOf(o));
      const fit = chooseScale(layout.width, layout.height, o.scale);
      size.textContent = fit ? sizeLine(fit.width, fit.height, o.scale, fit.scale) : "";
    }
    scheduler.request(o);
  }
  const checkedValue = (list: readonly { input: HTMLInputElement }[]) => list.find((r) => r.input.checked)?.input.value;
  function changed() {
    const background = checkedValue(backgroundRadios);
    stored = cleanImageOptions({
      colors: checkedValue(colorRadios), numbers: numbersBox.checked, name: nameBox.checked, scale: Number(checkedValue(scaleRadios)),
      background: background !== "none", padding: background === "none" ? stored.padding : background, frame: checkedValue(frameRadios),
      mark: markBox.checked,
    });
    writeImageOptions(args.storage, stored);
    request();
  }
  for (const r of [...colorRadios, ...backgroundRadios, ...frameRadios, ...scaleRadios]) r.input.addEventListener("change", changed);
  numbersBox.addEventListener("change", changed);
  nameBox.addEventListener("change", changed);
  markBox.addEventListener("change", changed);

  // Highlight lines: a valid entry applies at each keystroke and clears an error at once; an invalid
  // one is reported when committed (Tab away, Enter, a click elsewhere), never mid-typing, and a
  // committed message stays until the next commit (so the live region speaks once per commit). While
  // the field is in error the image has no band, so the preview still shows exactly what exports.
  let fieldError: string | null = null;
  /**
   * A committed message lies under the field, where the body may have it under the footer's edge:
   * once focus has settled, the field's group is scrolled into the body's view when focus stayed in
   * the field (Enter) or went to the footer (Tab to Download). A click on another option keeps the
   * body where it is (scrolling under the pointer could move the control being clicked).
   */
  function revealError() {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      // In compact mode the footer scrolls with the body, so there focus on it is left where it is.
      const footer = focused !== null && actions.contains(focused) && !dialog.hasAttribute("data-compact");
      if (fieldError !== null && isOpen() && (focused === field || footer)) highlightGroup.scrollIntoView({ block: "nearest" });
    });
  }
  function showFieldError(message: string | null) {
    fieldError = message;
    if (message) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
    field.setAttribute("aria-describedby", message ? "snippet-highlight-error snippet-highlight-hint" : "snippet-highlight-hint");
    live.replaceChildren(...(message ? [h("p", { id: "snippet-highlight-error", class: "field-error" }, icon("warning-circle"), h("span", null, message))] : []));
  }
  function setHighlight(lines: readonly number[]) {
    if (lines.length === highlight.length && lines.every((n, i) => n === highlight[i])) return;
    highlight = lines;
    request();
  }
  function readField(commit: boolean) {
    const parsed = parseHighlight(field.value, plan);
    if (parsed.ok) {
      if (fieldError !== null) showFieldError(null);
      setHighlight(parsed.lines);
    } else if (commit) {
      if (parsed.message !== fieldError) showFieldError(parsed.message);
      setHighlight([]);
      revealError();
    }
    // Typing on while in error: the message (and its live region) waits for the commit; no band, as before.
  }
  field.addEventListener("input", () => readField(false));
  field.addEventListener("change", () => readField(true));
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      readField(true);
    }
  });

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
  scheduler.request(options());
}
