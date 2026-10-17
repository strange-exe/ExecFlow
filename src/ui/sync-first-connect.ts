// Two small dialogs of the sync screens:
// - the first-connect choice, asked once when this computer and the repository both have a file at
//   the same path with different contents. It ALWAYS settles: Sync resolves with the choice; Cancel,
//   Escape or the close button reject with FirstConnectCancelled, and the engine then cancels the
//   sync with nothing written anywhere.
// - the list of conflict copies a sync made, each a button that opens the copy.
import { nameOf } from "../core/paths";
import type { WsPath } from "../core/types";
import type { FirstConnectChoice } from "../sync/engine";
import { h } from "./dom";
import { dialogShell, openModal } from "./dialogs";
import { syncIcon } from "./sync-icons";

export class FirstConnectCancelled extends Error {
  override name = "FirstConnectCancelled";
  constructor() {
    super("The first sync was cancelled: nothing was changed.");
  }
}

const CHOICES: { value: FirstConnectChoice; title: string; explain: string }[] = [
  {
    value: "merge",
    title: "Merge (keeps both versions as conflict copies)",
    explain: "The repository's version keeps the file name. This computer's version is saved next to it as a conflict copy (name.conflict-date-time.ext), here and in the repository. Nothing is lost.",
  },
  {
    value: "use-remote",
    title: "Use the repository's versions",
    explain: "This computer's versions of those files are replaced by the repository's and are lost. Files that are only on this computer are still uploaded.",
  },
  {
    value: "push-local",
    title: "Use this computer's versions",
    explain: "They are uploaded over the repository's versions, which stay in its history. Files that are only in the repository are still downloaded.",
  },
];

export function askFirstConnect(repo: string, returnFocus?: HTMLElement | null): Promise<FirstConnectChoice> {
  return new Promise((resolve, reject) => {
    const id = "first-connect";
    document.getElementById(id)?.remove();
    const radios = CHOICES.map((c, i) => {
      const input = h("input", { type: "radio", name: "first-connect-choice", id: `${id}-${c.value}`, value: c.value, "aria-describedby": `${id}-${c.value}-note` });
      input.checked = i === 0;
      return { choice: c, input };
    });
    const sync = h("button", { type: "submit", class: "btn primary", id: `${id}-sync` }, syncIcon("git-merge"), "Sync");
    const cancel = h("button", { type: "button", class: "btn" }, "Cancel");
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close (Esc)" }, syncIcon("x"));
    const form = h(
      "form",
      { class: "dialog-form", novalidate: true },
      h(
        "div",
        { class: "dialog-body" },
        h("p", { id: `${id}-lede` }, `Some files are both on this computer and in ${repo}, with different contents. Choose what happens to those files. Files that are on only one side are kept either way.`),
        h(
          "fieldset",
          { class: "choice-list" },
          h("legend", { class: "visually-hidden" }, "What happens to files that differ"),
          ...radios.map(({ choice, input }) =>
            h(
              "div",
              { class: "choice", "data-choice": choice.value },
              input,
              h("label", { for: input.id }, choice.title),
              h("p", { class: "field-note", id: `${input.id}-note` }, choice.explain),
            ),
          ),
        ),
      ),
      h("div", { class: "dialog-actions" }, cancel, sync),
    );
    const dialog = h(
      "dialog",
      { class: "dialog wide sync-dialog", id, "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-lede`, "data-state": "open" },
      h("div", { class: "dialog-head" }, h("h2", { class: "dialog-title", id: `${id}-title` }, "Combine this computer's files with the repository?"), close),
      form,
    );
    let choice: FirstConnectChoice | null = null;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      choice = radios.find((r) => r.input.checked)?.choice.value ?? "merge";
      dialog.close();
    });
    cancel.addEventListener("click", () => dialog.close());
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        if (choice) resolve(choice);
        else reject(new FirstConnectCancelled());
      },
      { once: true },
    );
    openModal(dialog, radios[0].input, returnFocus);
  });
}

/** Lists the conflict copies of the last sync; each opens its copy. */
export function showConflicts(conflicts: readonly { path: WsPath; copy: WsPath }[], open: (path: WsPath) => void, returnFocus?: HTMLElement | null): void {
  document.getElementById("conflict-copies")?.remove();
  const { dialog, body } = dialogShell("conflict-copies", "Conflict copies");
  dialog.classList.add("sync-dialog");
  body.append(
    h("p", null, "These files changed here and on GitHub. GitHub's version kept each name; yours is in the copy next to it. Compare the two, keep what you need, then delete the copy."),
    h(
      "ul",
      { class: "conflict-list" },
      ...conflicts.map((c) => {
        const button = h("button", { type: "button", class: "link-btn", "data-path": c.copy }, nameOf(c.copy));
        button.addEventListener("click", () => {
          dialog.close();
          open(c.copy);
        });
        return h("li", null, h("span", { class: "conflict-of" }, c.path), h("span", { class: "conflict-arrow" }, "yours:"), button);
      }),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  openModal(dialog, body.querySelector<HTMLElement>(".link-btn"), returnFocus);
}
