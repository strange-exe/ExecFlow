// "Sync now with a message": one optional field whose text becomes the subject of this sync's
// commit; the automatic file lists and the From line stay in the body (src/sync/commit-message.ts).
// Only this dialog asks: Ctrl+S, the status button and automatic syncs never prompt.
//
// Reading order: what the message is for, how many changes wait to upload, the field (with its
// limit and what empty means), then Sync. A sync that can't start now (offline, a tab that became
// read-only) leaves the dialog open with the text kept and says why on the result line above
// the buttons, through the dialog's own live region. The dialog is built for each opening and
// removed when it closes; the text only leaves it through `start`.
import { SUBJECT_MAX, cleanSubject } from "../sync/commit-message";
import { h, plural } from "./dom";
import { openModal } from "./dialogs";
import { createAnnouncer } from "./notice";
import { syncIcon } from "./sync-icons";

export interface MessageDeps {
  /** "owner/repo" */
  repo: string;
  /** Changes on this computer not synced yet (null: unknown). */
  unsynced: number | null;
  /** Text to start from: a message the last sync couldn't use. */
  initial: string;
  /**
   * Starts the sync with this subject ("" = automatic). Returns a sentence when it can't start now
   * (the dialog stays open); null once it started (the dialog closes and the sync reports as usual).
   */
  start(subject: string): string | null;
  /** The dialog closed; `started`: through a sync that started. */
  closed(started: boolean): void;
  returnFocus?: HTMLElement | null;
}

export function openMessageDialog(deps: MessageDeps): void {
  const id = "sync-message";
  document.getElementById(id)?.remove();
  const input = h("input", {
    type: "text",
    id: `${id}-input`,
    maxlength: String(SUBJECT_MAX),
    autocomplete: "off",
    spellcheck: "true",
    enterkeyhint: "send",
    "aria-describedby": `${id}-hint`,
  });
  input.value = deps.initial;
  const waiting =
    deps.unsynced === null
      ? ""
      : deps.unsynced > 0
        ? `${plural(deps.unsynced, "change")} on this computer ${deps.unsynced === 1 ? "waits" : "wait"} to upload.`
        : "Nothing has changed here since the last sync, so there may be nothing to upload; then no commit is made.";
  const result = h("p", { class: "result-line connect-result", id: `${id}-result` });
  const announcer = createAnnouncer();
  announcer.element.id = `${id}-announce`;
  announcer.element.removeAttribute("data-announcer");
  const submit = h("button", { type: "submit", class: "btn primary", id: `${id}-submit` }, syncIcon("cloud-arrow-up"), "Sync");
  const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
  const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)" }, syncIcon("x"));
  const form = h(
    "form",
    { class: "dialog-form", novalidate: true, autocomplete: "off" },
    h(
      "div",
      { class: "dialog-body" },
      h("p", { class: "connect-lede", id: `${id}-lede` }, `Your message becomes the title of this sync's commit in ${deps.repo}. The list of changed files stays under it.`),
      waiting ? h("p", { class: "field-note", id: `${id}-waiting` }, waiting) : null,
      h(
        "div",
        { class: "field" },
        h("label", { for: input.id }, "Commit message (optional)"),
        input,
        h("p", { class: "field-note", id: `${id}-hint` }, `Up to ${SUBJECT_MAX} characters. Leave it empty for an automatic message that names the files, like "Update main.py".`),
      ),
      result,
      announcer.element,
    ),
    h("div", { class: "dialog-actions" }, cancel, submit),
  );
  const dialog = h(
    "dialog",
    { class: "dialog sync-dialog message-dialog", id, "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-lede` },
    h("div", { class: "dialog-head" }, h("h2", { class: "dialog-title", id: `${id}-title` }, "Sync with a message"), close),
    form,
  );

  const say = (message: string) => {
    result.replaceChildren(syncIcon("warning-circle", "result-icon"), h("span", null, message));
    result.dataset.tone = "error";
    announcer.say(message);
  };
  let started = false;
  form.addEventListener("input", () => {
    result.replaceChildren();
    delete result.dataset.tone;
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const subject = cleanSubject(input.value);
    const why = deps.start(subject);
    if (why) return say(why);
    started = true;
    dialog.close();
  });
  cancel.addEventListener("click", () => dialog.close());
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      deps.closed(started);
    },
    { once: true },
  );
  openModal(dialog, input, deps.returnFocus);
  input.select();
}
