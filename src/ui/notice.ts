// The notice line (Pocket Run pattern): one role="status" line with at most one action, for
// anything the user should know now (a refused name, a failed save, a sync report). Run results
// are also read out through a separate polite live region, so a notice never hides them.
import { h, shown } from "./dom";
import { icon, type IconName } from "./icons";

export type Tone = "info" | "error" | "success" | "warning";

export interface NoticeOptions {
  tone?: Tone;
  action?: { label: string; run: () => void };
  /**
   * A notice that stays until it is acted on (its action, Dismiss, or unpin(key)): clear() leaves
   * it, and a later notice only covers it, so it comes back when that one goes. One at a time; a
   * new pinned notice replaces the last.
   */
  pin?: { key: string; onDismiss?: () => void };
}

const ICONS: Record<Tone, IconName> = { info: "info", error: "warning-circle", success: "check-circle", warning: "warning" };

export interface Notice {
  element: HTMLElement;
  show(text: string, options?: NoticeOptions): void;
  /** Empties the line; a pinned notice stays (or comes back, if another one covered it). */
  clear(): void;
  /** Drops the pinned notice `key` without its onDismiss (what it was about was dealt with elsewhere). */
  unpin(key: string): void;
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
  /** The notice that stays until acted on, and whether it is the one on the line now. */
  let pinned: { text: string; options: NoticeOptions } | null = null;
  let showingPinned = false;
  const refocus = () => {
    if (element.contains(document.activeElement)) options.returnFocus?.()?.focus({ preventScroll: true });
  };
  action.addEventListener("click", () => {
    const run = handler;
    refocus();
    // Acting on the pinned notice is what it waited for.
    if (showingPinned) pinned = null;
    clear();
    run?.();
  });
  dismiss.addEventListener("click", () => {
    refocus();
    const dismissed = showingPinned ? pinned : null;
    if (dismissed) pinned = null;
    clear();
    dismissed?.options.pin?.onDismiss?.();
  });

  function draw(message: string, options: NoticeOptions): void {
    const tone = options.tone ?? "error";
    // Names in a notice can come from files and repositories: no direction or invisible character
    // may reorder or hide the rest of the sentence (shown() makes them visible tags).
    const safe = shown(message);
    element.dataset.tone = tone;
    element.dataset.empty = safe ? "false" : "true";
    if (safe && options.pin) element.dataset.pinned = options.pin.key;
    else delete element.dataset.pinned;
    glyph.replaceChildren(safe ? icon(ICONS[tone]) : "");
    text.textContent = safe;
    handler = safe ? (options.action?.run ?? null) : null;
    action.hidden = !safe || !options.action;
    action.textContent = safe ? shown(options.action?.label ?? "") : "";
    dismiss.hidden = !safe;
  }

  function show(message: string, options: NoticeOptions = {}): void {
    if (options.pin && message) pinned = { text: message, options };
    // An empty message is a clear: the pinned notice (if any) is what the line shows then.
    if (!message && pinned) {
      // Already on the line: left as it is, so a screen reader doesn't hear it again.
      if (showingPinned) return;
      showingPinned = true;
      draw(pinned.text, pinned.options);
      return;
    }
    showingPinned = Boolean(options.pin && message);
    draw(message, options);
  }

  function clear(): void {
    show("");
  }

  function unpin(key: string): void {
    if (pinned?.options.pin?.key !== key) return;
    pinned = null;
    if (showingPinned) {
      showingPinned = false;
      draw("", {});
    }
  }

  return {
    element,
    show,
    clear,
    unpin,
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
