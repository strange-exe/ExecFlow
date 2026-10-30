// The Capture snippet dialog (final-v3 section 5; round 2, .claude/design/batch3/s.md; round 3,
// .claude/tasks/snippet-dialog-v3.md; redesign 6, .claude/design/redesign6/snippet/design.md), a
// lazy chunk with its stylesheet: the preview (the export bitmap itself, named by its text
// alternative, the whole image fitted to its sunken stage, or 1:1 with "Actual size" in the stage's
// bar), the options rail (Colours as swatch chips; Show as switches: line numbers, file name, the
// "Made with ExecFlow" line; Highlight lines; then Background, Frame and Scale as segmented radio
// groups), and the PNG's size, the status, Download (.png) and Copy image in a footer that never
// scrolls away. Side by side from 900 px wide (the stage left, the options in a 360 px rail), a
// full-screen stacked sheet below that, and compact (the dialog the one scroller) in very short windows.
// Built per opening and removed on close, so no listener outlives it. The preview and the exports
// run through snippet-flow.ts; results speak in the status line while open and in the page's notice
// after close. State attributes (data-preview, data-renders: renders shown, never an adopted one
// (snippet-flow.ts adopt), data-preview-options,
// data-preview-pending, data-compact, data-layout; #app data-capture, data-capture-reason,
// data-captures) are what tests wait on, never wording.
import "../styles/snippet-image.css";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nameOf } from "../core/paths";
import { lineWords, type CaptureMessage, type ColorChoice, type LineSpan, type Tone } from "../core/snippet";
import {
  captureMessage, cleanImageOptions, colorChoices, CREDIT_TEXT, dialogTitle, downloadName, highlightHint, IMAGE_TOKENS, NO_PREVIEW, optionsWord, PADDING,
  parseHighlight, previewLabel, readImageOptions, scaleNote, sizeText, writeImageOptions, type ImageColors, type ImageOptions, type StoredOptions,
} from "../core/snippet-dialog";
import { drawImage, freeCanvas, layoutOf, prepare, readbackOk, type CodeFont, type DrawnImage, type Prepared } from "../editor/snippet-canvas";
import { chooseScale, layoutImage, type Metrics } from "../editor/snippet-render";
import { IMAGE_MIXES, over } from "../theme/contrast";
import { allThemes } from "../theme/themes";
import { dialogShell, openModal } from "./dialogs";
import { downloadBlob, h, srOnly } from "./dom";
import { icon, type IconName } from "./icons";
import type { Notice } from "./notice";
import {
  createDrawnScales, createExporter, createPreviewScheduler, frameBudget, frameContent, frameEstimate, imageColors, paintFamily, previewFit, sameImage,
  type BudgetMeasures, type ExportKind, type ExportResult, type Paint, type RenderFailure, type SnippetLayout,
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
 * Stacked: the default look's layouts (medium background, plain frame) with either toggle; the stage
 * keeps the tallest for the opening (at most 45% of the window). A taller look shrinks to the stage
 * (previewFit) rather than reserving room that pushes the options below the fold (fix stage,
 * 2026-10-23). Side by side the stage's size comes from the dialog's own (CSS).
 */
const STAGE_LAYOUTS = [true, false].flatMap((numbers) => [true, false].map((name) => ({ numbers, name, frame: "plain" as const, pad: PADDING.medium, credit: true })));

/** What the document root painted, once per opening (never #app, which carries no theme attributes). */
function readPaint(): Paint {
  const root = document.documentElement;
  const family = paintFamily(root.dataset.palette);
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
  const { dialog, body, close } = dialogShell("snippet-dialog", dialogTitle(plan), { wide: true });
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
  // Fit (the whole image in the stage) at every opening; "Actual size" shows it 1:1, and the stage scrolls.
  let actual = false;
  const actualButton = h(
    "button",
    { type: "button", id: "snippet-actual", class: "btn small", "aria-pressed": "false", "aria-controls": "snippet-frame" },
    icon("corners-out"), "Actual size",
  );
  // Redesign 6: the stage is a sunken panel; its bar (a quiet "Preview" tag, hidden from assistive
  // technology since the frame is named, and Actual size) sits above the frame side by side and
  // under the image stacked, and placeStageBar keeps the DOM (the Tab order) in that drawn order.
  const stageBar = h("div", { class: "snippet-stagebar" }, h("span", { class: "snippet-stage-tag", "aria-hidden": "true" }, "Preview"), actualButton);
  const stageColumn = h("div", { class: "snippet-stage" }, h("div", { class: "snippet-panel" }, stageBar, frame), ...(gapsNote ? [gapsNote] : []));
  // The head: an Esc keycap hint for keyboard users, hidden from assistive technology (the close
  // button's own title says "Close (Esc)"); CSS hides it on phones and touch screens.
  close.before(h("span", { class: "snippet-esc", "aria-hidden": "true" }, h("kbd", { class: "keycap" }, "Esc"), " to close"));

  // ---------------------------------------------------------------- the options (5.4; round 2; round 3)
  /**
   * A Colours chip (redesign 6): the native radio covers the whole chip (one Tab stop for the group,
   * arrows choose), over a small picture of the choice (its background, card and three syntax
   * colours, from the colours the image is drawn with; hidden from assistive technology) and its
   * name. The tick and the strong weight mark the chosen one (snippet-image.css), never colour alone.
   */
  function chip(input: HTMLInputElement, label: string, colors: ImageColors | null) {
    const lines = [h("i"), h("i"), h("i")];
    const mini = h("span", { class: "snippet-mini" }, ...lines);
    const swatch = h("span", { class: "snippet-swatch", "aria-hidden": "true" }, mini);
    if (colors) {
      // Through the CSSOM (one property at a time, never parsed as markup); the stylesheet's token
      // colours stay underneath when the choice's colours can't be read.
      swatch.style.backgroundColor = over(colors.bg, colors.action, IMAGE_MIXES.mat.pct / 100);
      mini.style.backgroundColor = colors.bg;
      mini.style.boxShadow = `inset 0 0 0 1px ${colors.border}`;
      lines.forEach((line, i) => (line.style.backgroundColor = colors[(["syn-keyword", "syn-function", "syn-string"] as const)[i]]));
    }
    return h("div", { class: "snippet-choice snippet-chip" }, input, swatch, h("label", { for: input.id }, label), h("span", { class: "snippet-tick", "aria-hidden": "true" }));
  }
  /** A Show switch: the native checkbox covers the whole row (the row is the target); the track is drawn beside the label. */
  const toggle = (input: HTMLInputElement, label: string) =>
    h("div", { class: "snippet-choice snippet-switch" }, input, h("label", { for: input.id }, label), h("span", { class: "snippet-track", "aria-hidden": "true" }));
  /** A radio group: one Tab stop, arrows change the choice at once (Settings' theme radios do the same). */
  function radios(group: string, items: readonly { value: string; label: string; hidden?: string }[], checked: string, kind: "chip" | "segment") {
    return items.map((c) => {
      const input = h("input", { type: "radio", name: `snippet-${group}`, value: c.value, id: `snippet-${group}-${c.value}` });
      input.checked = c.value === checked;
      // A segment: the native radio under its label, the label drawn as the segment (the words after
      // the visible one stay in the accessible name, round 2's). The words sit in a box as wide as
      // their bold form (snippet-image.css), so choosing one never moves a segment's width.
      const words = () => h("span", { class: "snippet-segment-words", "data-label": c.label }, c.label);
      const row = kind === "segment"
        ? h("div", { class: "snippet-segment" }, input, h("label", { for: input.id }, words(), ...(c.hidden ? [srOnly(c.hidden)] : [])))
        : chip(input, c.label, imageColors(c.value as ColorChoice, paint));
      return { input, row };
    });
  }
  const box = (id: string, checked: boolean) => {
    const input = h("input", { type: "checkbox", id });
    input.checked = checked;
    return input;
  };
  const colorRadios = radios("colors", colorChoices(paint), stored.colors, "chip");
  const numbersBox = box("snippet-numbers", stored.numbers);
  const nameBox = box("snippet-name", stored.name);
  const markBox = box("snippet-mark", stored.mark);
  const backgroundRadios = radios(
    "background",
    [{ value: "none", label: "None", hidden: " (the card alone)" }, { value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }],
    stored.background ? stored.padding : "none",
    "segment",
  );
  const frameRadios = radios("frame", [{ value: "plain", label: "Plain" }, { value: "window", label: "Window" }], stored.frame, "segment");
  const scaleRadios = radios("scale", [{ value: "1", label: "1x" }, { value: "2", label: "2x" }, { value: "3", label: "3x" }], String(stored.scale), "segment");
  // The PNG's size leads the footer (tier 3, a "PNG" tag hidden from assistive technology before
  // it); the step a too-big scale took is said under Scale. Both describe the Scale group.
  const size = h("span", { id: "snippet-size", class: "snippet-size-value" });
  const sizeLine = h("p", { class: "snippet-size" }, h("span", { class: "snippet-size-tag", "aria-hidden": "true" }, "PNG"), size);
  const stepNote = h("p", { id: "snippet-scale-note", class: "snippet-scale-note" });

  const field = h("input", {
    type: "text", id: "snippet-highlight", autocomplete: "off", spellcheck: "false", maxlength: "200", "aria-describedby": "snippet-highlight-hint",
  });
  const hint = h("p", { id: "snippet-highlight-hint", class: "field-note" }, highlightHint(plan));
  // Always rendered (empty takes no room), so a message added while focus stays in the field is heard.
  const live = h("div", { class: "snippet-highlight-live", "aria-live": "polite" });
  const fieldset = (legend: string, rows: readonly HTMLElement[]) => h("fieldset", null, h("legend", null, legend), ...rows);
  const rowsOf = (list: readonly { row: HTMLElement }[]) => list.map((r) => r.row);
  /** Background, Frame and Scale: one row of segments. */
  const segmented = (legend: string, list: readonly { row: HTMLElement }[], extra: Record<string, string> = {}, ...after: HTMLElement[]) =>
    h("fieldset", { class: "snippet-segmented", ...extra }, h("legend", null, legend), h("div", { class: "snippet-segments" }, ...rowsOf(list)), ...after);
  const colours = fieldset("Colours", [h("div", { class: "snippet-chips" }, ...rowsOf(colorRadios))]);
  const show = fieldset("Show", [toggle(numbersBox, "Line numbers"), toggle(nameBox, "File name"), toggle(markBox, `"${CREDIT_TEXT}" line`)]);
  const scaleSet = segmented("Scale", scaleRadios, { "aria-describedby": "snippet-scale-note snippet-size" }, stepNote);
  const highlightGroup = h("div", { class: "snippet-highlight field" }, h("label", { for: "snippet-highlight" }, "Highlight lines"), field, live, hint);
  // In the order a student changes them most: Colours, Show, Highlight lines; then the look.
  const optionsColumn = h(
    "div",
    { class: "snippet-options" },
    colours,
    show,
    highlightGroup,
    segmented("Background", backgroundRadios),
    segmented("Frame", frameRadios),
    scaleSet,
  );
  body.append(stageColumn, optionsColumn);

  const status = h("p", { id: "snippet-status", class: "result-line snippet-status", role: "status" });
  const download = h("button", { type: "button", class: args.canCopy ? "btn" : "btn primary", autofocus: !args.canCopy }, icon("download-simple"), "Download (.png)");
  const copy = args.canCopy ? h("button", { type: "button", class: "btn primary", autofocus: true }, icon("copy"), "Copy image") : null;
  // A sibling after the body: it never scrolls away (except in compact mode, where the dialog scrolls).
  // Redesign 6: the PNG's size, the status, then Download and Copy image (the one filled button).
  const actions = h("div", { class: "dialog-actions snippet-actions" }, h("div", { class: "snippet-footer" }, sizeLine, status, h("div", { class: "snippet-buttons" }, download, copy)));
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
  /** The code font's measures, from the latest render that measured differently: the size line is worked out from them at once. */
  let metrics: Metrics | null = null;
  let layouts: { width: number; height: number }[] | null = null;
  let frameCap = 420;
  let layout: SnippetLayout = "stack";
  function measures(): BudgetMeasures {
    const height = (el: Element | null) => el?.getBoundingClientRect().height ?? 0;
    const firstChoice = colours.querySelector(".snippet-choice");
    // Where the status takes no room while empty (a line of its own on narrow footers), its two
    // lines are counted anyway: a result then shortens the scrolled body, never the frame's room.
    const lines = parseFloat(getComputedStyle(status).lineHeight);
    const reserve = status.getBoundingClientRect().height < 1 ? 2 * (Number.isFinite(lines) ? lines : 20) : 0;
    return {
      innerHeight,
      wide: matchMedia("(min-width: 900px)").matches,
      head: height(dialog.querySelector(".dialog-head")),
      footer: height(actions) + reserve,
      // The rows under the frame: the Actual size bar, then the notes (each counts its height and 8).
      notes: [...stageColumn.querySelectorAll(".snippet-stagebar, .snippet-note")].map(height),
      firstRow: firstChoice ? firstChoice.getBoundingClientRect().bottom - colours.getBoundingClientRect().top : 0,
    };
  }
  /** Stacked and compact: the frame keeps one height for the opening. Side by side: CSS sizes it (the dialog's height). */
  function sizeFrame() {
    if (layout === "side") {
      frame.style.height = "";
      return;
    }
    const inner = frame.clientWidth - 16;
    const content = layouts
      ? frameContent(layouts, inner, frameCap)
      : Math.min(frameCap, Math.max(96, frameEstimate(plan.last - plan.first + 1, font.size * 1.5, true, PADDING.medium)));
    frame.style.height = `${content + 18}px`;
  }
  /** The image fitted whole inside the frame's padding (or 1:1 with Actual size). */
  function fitCanvas(r: DrawnImage) {
    const fit = previewFit(r.layout, frame.clientWidth - 16, frame.clientHeight - 16, actual);
    r.canvas.style.width = `${r.layout.width * fit}px`;
    r.canvas.style.height = `${r.layout.height * fit}px`;
  }
  function setActual(on: boolean) {
    actual = on;
    actualButton.setAttribute("aria-pressed", String(on));
    frame.toggleAttribute("data-actual", on);
    const shownNow = scheduler.current()?.result;
    if (shownNow) fitCanvas(shownNow);
    frame.scrollTop = 0;
    frame.scrollLeft = 0;
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
  /**
   * The stage bar where it is drawn, so the Tab order is the drawn order (WCAG 2.4.3): above the
   * frame side by side, under it stacked and compact. The one of the two that doesn't hold focus is
   * moved (a moved node loses focus), so a resize across 900 px leaves focus where it was.
   */
  function placeStageBar() {
    const under = layout !== "side";
    if ((frame.nextElementSibling === stageBar) === under) return;
    if (stageBar.contains(document.activeElement)) {
      if (under) stageBar.before(frame);
      else stageBar.after(frame);
    } else if (under) frame.after(stageBar);
    else frame.before(stageBar);
  }
  let budgeted = false;
  function applyBudget() {
    const apply = () => {
      const b = frameBudget(measures());
      dialog.toggleAttribute("data-compact", b.compact);
      dialog.dataset.layout = layout = b.layout;
      frameCap = b.frameCap;
      return b;
    };
    const before = layout;
    let b = apply();
    // A new layout changes the head's and the footer's widths (and so their heights): measured again once.
    if (b.layout !== before) b = apply();
    placeStageBar();
    sizeFrame();
    const shownNow = scheduler.current()?.result;
    if (shownNow) fitCanvas(shownNow);
    if (!budgeted) {
      // Every opening starts at the top. Firefox gave a new options column the scroll position of the
      // last opening's (measured: 250 px at insertion, 2026-10-26), so a reopened dialog hid Colours.
      optionsColumn.scrollTop = 0;
      body.scrollTop = 0;
    }
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
  /**
   * The scale the options are drawn at (snippet-flow.ts drawnScaleOf), from the latest render's
   * measures; before the first, the Scale chosen. Two Scale choices drawn at the same scale make the
   * same bitmap, so the scheduler renders it once.
   */
  const drawnScales = createDrawnScales();
  const drawnScale = (o: ImageOptions) => drawnScales.scale(o);
  const scheduler = createPreviewScheduler<DrawnImage>({
    drawnScale,
    async render(o, signal) {
      const colors = imageColors(o.colors, paint);
      if (!colors) return { ok: false, reason: "failed" };
      const p = await preparing!;
      if (signal.stopped) return { ok: false, reason: "stopped" };
      return drawImage(p, o, colors, signal, font, name);
    },
    free: (r) => freeCanvas(r.canvas),
    swap(r, o, _generation, adopted) {
      r.canvas.setAttribute("aria-hidden", "true");
      if (prepared) {
        // Every render's measures: one drawn with a fallback font measures differently from a later
        // one with the real font, and the size line and the drawn scales follow the newest.
        if (drawnScales.measure(prepared.rows, r.metrics)) metrics = r.metrics;
        if (!layouts) {
          // The first render landed: the frame takes its height for the whole opening (the default look's tallest layout).
          const rows = prepared.rows;
          layouts = STAGE_LAYOUTS.map((l) => layoutImage(rows, r.metrics, l));
          sizeFrame();
        }
      }
      fitCanvas(r);
      frame.replaceChildren(r.canvas);
      keepFocusInView();
      size.textContent = sizeText(r.canvas.width, r.canvas.height);
      stepNote.textContent = scaleNote(o.scale, r.scale);
      if (!adopted) dialog.dataset.renders = String((Number(dialog.dataset.renders) || 0) + 1);
      dialog.dataset.previewOptions = optionsWord(o);
      frame.setAttribute("aria-label", previewLabel(plan, name, o, paint, partial));
      frame.setAttribute("aria-busy", "false");
    },
    fail(reason, o, _generation, adopted) {
      const m = failureMessage(reason);
      frame.replaceChildren(h("p", { class: "snippet-frame-text" }, captureMessage(m, at).text));
      frame.setAttribute("aria-label", reason === "too-big" ? NO_PREVIEW["too-big"] : NO_PREVIEW.failed);
      size.textContent = "";
      stepNote.textContent = "";
      if (!adopted) dialog.dataset.renders = String((Number(dialog.dataset.renders) || 0) + 1);
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
      return c?.failure && sameImage(c.options, options(), drawnScale) ? c.failure : null;
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
      // The size and the step note describe the Scale group, so they change with the choice, in the
      // same task, not when the render lands: the newly checked radio is read with the size it will make.
      const look = layoutImage(prepared.rows, metrics, layoutOf(o));
      const fit = chooseScale(look.width, look.height, o.scale);
      size.textContent = fit ? sizeText(fit.width, fit.height) : "";
      stepNote.textContent = fit ? scaleNote(o.scale, fit.scale) : "";
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
  actualButton.addEventListener("click", () => setActual(!actual));
  const onResize = () => applyBudget();
  // The stage's box also changes without a resize (a note added under it, the footer's status):
  // the shown image is fitted again whenever it does.
  const stageWatch = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      const shownNow = scheduler.current()?.result;
      if (shownNow) fitCanvas(shownNow);
    })
    : null;
  stageWatch?.observe(frame);
  dialog.addEventListener(
    "close",
    () => {
      scheduler.cancel();
      removeEventListener("resize", onResize);
      stageWatch?.disconnect();
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
      stageColumn.append(note("snippet-partial", { kind: "partial" }));
      dialog.setAttribute("aria-describedby", [...describedBy, "snippet-partial"].join(" "));
      applyBudget();
    }
    return p;
  });
  scheduler.request(options());
}
