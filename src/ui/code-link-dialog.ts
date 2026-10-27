// Opening a code link (src/core/code-link.ts, .claude/tasks/code-links.md): the shared file is shown
// read-only first, and becomes one of the student's files only when they press Add. Nothing runs:
// it is someone else's code. A lazy chunk (with the link decoder), loaded only when the page opens
// with #code=. Name and code go in as text, every unshown character tagged (shown()), so the
// preview can neither run markup nor hide part of the code. State attribute for tests: data-state
// ("ready"). The file is added under a free name (examples.ts freeName), never over a file.
import { detectLanguage } from "../core/languages";
import { readCodeLink, readRefusalText } from "../core/code-link";
import { dialogShell, openModal } from "./dialogs";
import { h, plural, shown } from "./dom";
import { freeName } from "./examples";
import type { Notice } from "./notice";

export interface CodeLinkDeps {
  /** A path already in the workspace (compared as storage compares names). */
  taken(path: string): boolean;
  /** Adds the file at the workspace root and opens it (a read-only tab explains instead). */
  add(path: string, text: string): void;
  readonly notice: Pick<Notice, "show">;
}

/** Reads `hash` (a #code= fragment) and offers its file; a link that can't be opened says why. */
export async function openCodeLink(hash: string, deps: CodeLinkDeps): Promise<void> {
  const read = await readCodeLink(hash);
  if (!read.ok) return void deps.notice.show(readRefusalText(read.refusal), { tone: "error" });
  if (document.querySelector("dialog[open], .menu")) {
    return void deps.notice.show("A code link arrived while a dialog was open, so it wasn't opened. Close the dialog, then open the link again.", { tone: "info" });
  }
  const { name, text } = read.file;
  const target = freeName(name, deps.taken);
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  const language = detectLanguage(name)?.label;

  const { dialog, body } = dialogShell("code-link", `Open ${shown(name)}?`, { wide: true });
  dialog.classList.add("code-link");
  body.append(
    h("p", { id: "code-link-lede" }, "Someone shared this code with you in a link. It isn't in your files yet, and it doesn't run until you press Run."),
    h("p", { class: "field-note", id: "code-link-about" }, `${language ? `${language}, ` : ""}${plural(lines, "line")}.${target === name ? "" : ` You already have a file named ${shown(name)}, so this one is added as ${shown(target)}.`}`),
    h("pre", { class: "code-link-preview", id: "code-link-preview", tabindex: "0", "aria-label": `The code in ${shown(name)}` }, h("code", null, shown(text))),
  );
  dialog.setAttribute("aria-describedby", "code-link-lede code-link-about");
  const cancel = h("button", { type: "button", class: "btn", id: "code-link-cancel" }, "Not now");
  const add = h("button", { type: "button", class: "btn primary", id: "code-link-add" }, "Add to my files");
  dialog.append(h("div", { class: "dialog-actions" }, cancel, add));
  cancel.addEventListener("click", () => dialog.close());
  add.addEventListener("click", (e) => {
    // The second click of a double click does nothing (the Run rule): one press, one file.
    if (e.detail > 1) return;
    dialog.close();
    deps.add(target, text);
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  openModal(dialog, add, null);
  dialog.dataset.state = "ready";
}
