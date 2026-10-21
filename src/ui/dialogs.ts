// Native <dialog> helpers: showModal (focus moves in, the page behind is inert), Escape closes, and
// focus returns to whatever opened the dialog. A confirmation always settles: closing it any way
// other than the confirm button counts as "no".
import { h } from "./dom";
import { icon } from "./icons";

/**
 * Opens a modal dialog and puts focus back once it closes: on `returnTo` (the button that opened
 * it; WebKit doesn't focus a button on click, so the active element can be just the body), else on
 * whatever had focus. `returnTo` can also be a function, asked at close (the opener may be hidden
 * by then); one that returns null has done its own focusing (the code, through view.focus()).
 *
 * The close event comes a task after the dialog closed (HTML: it is queued), and by then the browser
 * has already put focus back on the element focused at showModal. A key handled in between can have
 * moved focus on: Chromium handled Shift+F10 before the close event (it fires after Escape's keyup
 * there), opened the item's menu, and this focus() then took the menu's focus and closed it. So
 * focus is put back only while it still sits where the close left it.
 */
export function openModal(dialog: HTMLDialogElement, initialFocus?: HTMLElement | null, returnTo?: HTMLElement | (() => HTMLElement | null) | null): void {
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const opener = returnTo ?? active;
  if (!dialog.isConnected) document.body.append(dialog);
  watchScroll(dialog);
  dialog.addEventListener(
    "close",
    () => {
      const now = document.activeElement;
      const untouched = !now || now === document.body || now === active || dialog.contains(now);
      if (!untouched) return;
      const target = typeof opener === "function" ? opener() : opener;
      if (target?.isConnected) target.focus({ preventScroll: true });
    },
    { once: true },
  );
  dialog.showModal();
  (initialFocus ?? dialog.querySelector<HTMLElement>("[autofocus]"))?.focus();
}

/**
 * The header stays put while the body scrolls under it; once the body has scrolled, a divider
 * rule under the header shows where the two meet (data-scrolled on .dialog-head).
 */
function watchScroll(dialog: HTMLDialogElement): void {
  const head = dialog.querySelector<HTMLElement>(".dialog-head");
  const body = dialog.querySelector<HTMLElement>(".dialog-body");
  if (!head || !body || body.dataset.watched) return;
  body.dataset.watched = "true";
  const update = () => head.toggleAttribute("data-scrolled", body.scrollTop > 0);
  body.addEventListener("scroll", update, { passive: true });
  dialog.addEventListener("close", () => head.removeAttribute("data-scrolled"));
  update();
}

/** A dialog shell: title, a close button, and a body. Labelled by its title. */
export function dialogShell(id: string, title: string, options: { wide?: boolean } = {}): { dialog: HTMLDialogElement; body: HTMLElement; close: HTMLButtonElement } {
  const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)" }, icon("x"));
  const body = h("div", { class: "dialog-body" });
  const dialog = h(
    "dialog",
    { class: `dialog${options.wide ? " wide" : ""}`, id, "aria-labelledby": `${id}-title` },
    h("div", { class: "dialog-head" }, h("h2", { id: `${id}-title`, class: "dialog-title" }, title), close),
    body,
  );
  close.addEventListener("click", () => dialog.close());
  // A click on the backdrop (outside the dialog box) closes it, like Escape; but never the second
  // click of a double click (the first may have opened this dialog), and never a press that began
  // inside the box (a text selection or a scrollbar drag released outside).
  const outside = (e: MouseEvent) => {
    const r = dialog.getBoundingClientRect();
    return !(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => {
    pressedOutside = e.target === dialog && outside(e);
  });
  // A press on the backdrop never takes the focus from the dialog's control (Firefox moved it off Copy
  // when the second click of the double click that opened this dialog landed there); a click still closes.
  dialog.addEventListener("mousedown", (e) => {
    if (e.target === dialog && outside(e)) e.preventDefault();
  });
  dialog.addEventListener("click", (e) => {
    const backdrop = e.target === dialog && e.detail <= 1 && pressedOutside && outside(e);
    pressedOutside = false;
    if (backdrop) dialog.close();
  });
  return { dialog, body, close };
}

export interface ConfirmOptions {
  title: string;
  body: (string | Node)[];
  confirm: string;
  cancel?: string;
  /** Destructive: the confirm button is drawn as a danger action and Cancel gets focus first. */
  danger?: boolean;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-${Math.random().toString(36).slice(2, 8)}`;
    const cancel = h("button", { type: "button", class: "btn" }, options.cancel ?? "Cancel");
    const confirm = h("button", { type: "button", class: `btn ${options.danger ? "danger" : "primary"}`, "data-confirm": "" }, options.confirm);
    const dialog = h(
      "dialog",
      { class: "dialog confirm", id, role: "alertdialog", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-desc` },
      h("div", { class: "dialog-head" }, h("h2", { id: `${id}-title`, class: "dialog-title" }, options.title)),
      h("div", { class: "dialog-body", id: `${id}-desc` }, ...options.body.map((part) => (typeof part === "string" ? h("p", null, part) : part))),
      h("div", { class: "dialog-actions" }, cancel, confirm),
    );
    let answer = false;
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => {
      answer = true;
      dialog.close();
    });
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        resolve(answer);
      },
      { once: true },
    );
    openModal(dialog, options.danger ? cancel : confirm);
  });
}
