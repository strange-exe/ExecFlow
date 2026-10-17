// Native <dialog> helpers: showModal (focus moves in, the page behind is inert), Escape closes, and
// focus returns to whatever opened the dialog. A confirmation always settles: closing it any way
// other than the confirm button counts as "no".
import { h } from "./dom";
import { icon } from "./icons";

/**
 * Opens a modal dialog and puts focus back once it closes: on `returnTo` (the button that opened
 * it; WebKit doesn't focus a button on click, so the active element can be just the body), else on
 * whatever had focus.
 */
export function openModal(dialog: HTMLDialogElement, initialFocus?: HTMLElement | null, returnTo?: HTMLElement | null): void {
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const opener = returnTo ?? active;
  if (!dialog.isConnected) document.body.append(dialog);
  dialog.addEventListener(
    "close",
    () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
    { once: true },
  );
  dialog.showModal();
  (initialFocus ?? dialog.querySelector<HTMLElement>("[autofocus]"))?.focus();
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
  // A click on the backdrop (outside the dialog box) closes it, like Escape.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
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
