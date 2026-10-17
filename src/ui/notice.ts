// The notice line (Pocket Run pattern): one role="status" line with at most one action, for
// anything the user should know now (a refused name, a failed save, a sync report). Run results
// are also read out through a separate polite live region, so a notice never hides them.
import { h, shown } from "./dom";
import { icon, type IconName } from "./icons";

export type Tone = "info" | "error" | "success" | "warning";

export interface NoticeOptions {
  tone?: Tone;
  action?: { label: string; run: () => void };
}

const ICONS: Record<Tone, IconName> = { info: "info", error: "warning-circle", success: "check-circle", warning: "warning" };

export interface Notice {
  element: HTMLElement;
  show(text: string, options?: NoticeOptions): void;
  clear(): void;
  readonly text: string;
}

/** `returnFocus`: where keyboard focus goes when the notice's own button that had it disappears. */
export function createNotice(options: { returnFocus?: () => HTMLElement | null } = {}): Notice {
  const glyph = h("span", { class: "notice-icon" });
  const text = h("span", { class: "notice-text" });
  const action = h("button", { type: "button", class: "btn small notice-action" });
  action.hidden = true;
  const dismiss = h("button", { type: "button", class: "icon-btn small", "aria-label": "Dismiss notice", title: "Dismiss" }, icon("x"));
  // The live region stays rendered while empty (it must exist before it speaks); its buttons don't,
  // so an empty notice is never an invisible stop in the Tab order.
  dismiss.hidden = true;
  const element = h("div", { class: "notice", role: "status", "data-empty": "true" }, glyph, text, action, dismiss);
  let handler: (() => void) | null = null;
  const refocus = () => {
    if (element.contains(document.activeElement)) options.returnFocus?.()?.focus({ preventScroll: true });
  };
  action.addEventListener("click", () => {
    const run = handler;
    refocus();
    clear();
    run?.();
  });
  dismiss.addEventListener("click", () => {
    refocus();
    clear();
  });

  function show(message: string, options: NoticeOptions = {}): void {
    const tone = options.tone ?? "error";
    // Names in a notice can come from files and repositories: no direction or invisible character
    // may reorder or hide the rest of the sentence (shown() makes them visible tags).
    const safe = shown(message);
    element.dataset.tone = tone;
    element.dataset.empty = safe ? "false" : "true";
    glyph.replaceChildren(safe ? icon(ICONS[tone]) : "");
    text.textContent = safe;
    handler = safe ? (options.action?.run ?? null) : null;
    action.hidden = !safe || !options.action;
    action.textContent = safe ? shown(options.action?.label ?? "") : "";
    dismiss.hidden = !safe;
  }

  function clear(): void {
    show("");
  }

  return {
    element,
    show,
    clear,
    get text() {
      return text.textContent ?? "";
    },
  };
}

/** A visually hidden polite live region for results that must be heard ("Build failed: 2 errors in main.c"). */
export function createAnnouncer(): { element: HTMLElement; say(text: string): void } {
  const element = h("div", { class: "visually-hidden", "aria-live": "polite", "aria-atomic": "true", "data-announcer": "" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    element,
    say(text: string) {
      // Clear first, so the same sentence twice in a row is read twice.
      element.textContent = "";
      clearTimeout(timer);
      timer = setTimeout(() => (element.textContent = text), 50);
    },
  };
}
