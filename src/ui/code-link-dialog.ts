// Opening a code link (src/core/code-link.ts, .claude/tasks/code-links.md): the shared file is shown
// read-only first, and becomes one of the student's files only when they press Add. Nothing runs:
// it is someone else's code. A lazy chunk (with the link decoder), loaded only when the page opens
// with #code=. Name and code go in as text, every unshown character tagged (shown()), so the
// preview can neither run markup nor hide part of the code. State attribute for tests: data-state
// ("ready", "adding", "refused"). The file is added under a free name (examples.ts freeName), never
// over a file, chosen again when Add is pressed. The dialog closes only once the file is added: an
// add that fails (a read-only tab, storage refusing it) says why inside the dialog and keeps the
// shared file there, so Add can be pressed again.
// A short link (/s/<id>#<key>, src/core/short-link.ts) is fetched and decrypted first ("Opening the
// short link..." in the notice), then offered in the same preview; a link that can't be opened
// (expired, damaged, offline) says so in the notice and opens nothing.
import { detectLanguage } from "../core/languages";
import { readCodeLink, readRefusalText, type ReadResult, type SharedFile, type SharedFolder } from "../core/code-link";
import { openShortLink, shortLinkId, shortReadRefusalText } from "../core/short-link";
import { dialogShell, openModal } from "./dialogs";
import { h, plural, shown } from "./dom";
import { freeName } from "./examples";
import { icon } from "./icons";
import type { Notice } from "./notice";

/** Why a file wasn't added: one sentence, and whether it is the tab (read-only) or a failure. */
export interface AddRefusal {
  message: string;
  readOnly?: boolean;
}

export interface CodeLinkDeps {
  /** A path already in the workspace (compared as storage compares names). */
  taken(path: string): boolean;
  /**
   * Adds the file at the workspace root and opens it: null once it is added, else why not (a
   * read-only tab adds nothing). It shows no notice: the dialog says why.
   */
  add(path: string, text: string): Promise<AddRefusal | null>;
  /** Adds a folder link's files as a new folder `folder` at the root, and opens one: as add. */
  addFolder(folder: string, files: readonly SharedFile[]): Promise<AddRefusal | null>;
  readonly notice: Pick<Notice, "show">;
}

/** Reads `hash` (a #code= fragment) and offers its file or folder; a link that can't be opened says why. */
export async function openCodeLink(hash: string, deps: CodeLinkDeps): Promise<void> {
  const read = await readCodeLink(hash);
  if (!read.ok) return void deps.notice.show(readRefusalText(read.refusal), { tone: "error" });
  offer(read, "code link", deps);
}

/**
 * A short link opened at `pathname` (/s/<id>) with `hash` (#<key>): fetched, decrypted and checked,
 * then offered as a code link is. `fetch` and `online` are the page's (swappable in tests).
 */
export async function openShortCodeLink(pathname: string, hash: string, deps: CodeLinkDeps, net = { fetch: (input: string, init: RequestInit) => fetch(input, init), online: () => navigator.onLine }): Promise<void> {
  const id = shortLinkId(pathname);
  if (id === null) return void deps.notice.show(shortReadRefusalText({ kind: "damaged" }), { tone: "error" });
  deps.notice.show("Opening the short link...", { tone: "info" });
  let read: Awaited<ReturnType<typeof openShortLink>>;
  try {
    read = await openShortLink(id, hash, net);
  } catch {
    read = { ok: false, refusal: { kind: "unavailable" } };
  }
  if (!read.ok) return void deps.notice.show(shortReadRefusalText(read.refusal), { tone: "error" });
  deps.notice.show("");
  offer(read, "short link", deps);
}

function offer(read: Extract<ReadResult, { ok: true }>, noun: string, deps: CodeLinkDeps): void {
  if (document.querySelector("dialog[open], .menu")) {
    return void deps.notice.show(`A ${noun} arrived while a dialog was open, so it wasn't opened. Close the dialog, then open the link again.`, { tone: "info" });
  }
  if ("folder" in read) return openFolder(read.folder, deps);
  const { name, text } = read.file;
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  const language = detectLanguage(name)?.label;

  const { dialog, body } = dialogShell("code-link", `Open ${shown(name)}?`, { wide: true });
  dialog.classList.add("code-link");
  const about = h("p", { class: "field-note", id: "code-link-about" });
  /** The free name now (the files can change while the dialog is open), said in the note. */
  const target = (): string => {
    const free = freeName(name, deps.taken);
    about.textContent = `${language ? `${language}, ` : ""}${plural(lines, "line")}.${free === name ? "" : ` You already have a file named ${shown(name)}, so this one is added as ${shown(free)}.`}`;
    return free;
  };
  target();
  const result = h("p", { class: "result-line", id: "code-link-result", role: "status" });
  body.append(
    h("p", { id: "code-link-lede" }, "Someone shared this code with you in a link. It isn't in your files yet, and it doesn't run until you press Run."),
    about,
    h("pre", { class: "code-link-preview", id: "code-link-preview", tabindex: "0", "aria-label": `The code in ${shown(name)}` }, h("code", null, shown(text))),
    result,
  );
  dialog.setAttribute("aria-describedby", "code-link-lede code-link-about");
  const cancel = h("button", { type: "button", class: "btn", id: "code-link-cancel" }, "Not now");
  const add = h("button", { type: "button", class: "btn primary", id: "code-link-add" }, "Add to my files");
  dialog.append(h("div", { class: "dialog-actions" }, cancel, add));
  cancel.addEventListener("click", () => dialog.close());
  let adding = false;
  add.addEventListener("click", async (e) => {
    // The second click of a double click, or a press while one is adding, does nothing (the Run
    // rule): one press, one file.
    if (e.detail > 1 || adding) return;
    adding = true;
    // Busy for assistive technology; the button stays enabled and focusable (a press now does nothing).
    dialog.setAttribute("aria-busy", "true");
    dialog.dataset.state = "adding";
    result.replaceChildren();
    delete result.dataset.tone;
    let refusal: AddRefusal | null;
    try {
      refusal = await deps.add(target(), text);
    } catch (error) {
      refusal = { message: `The file wasn't added: ${error instanceof Error ? error.message : String(error)}` };
    }
    adding = false;
    dialog.removeAttribute("aria-busy");
    if (!refusal) return void dialog.close();
    // Closed while it was adding: the sentence still reaches the student.
    if (!dialog.open) return void deps.notice.show(refusal.message, { tone: refusal.readOnly ? "info" : "error" });
    // Kept open with the code: the student can press Add again, or Not now.
    dialog.dataset.state = "refused";
    result.dataset.tone = refusal.readOnly ? "warning" : "error";
    result.replaceChildren(icon(refusal.readOnly ? "warning" : "warning-circle", "result-icon"), h("span", null, shown(refusal.message)));
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  openModal(dialog, add, null);
  dialog.dataset.state = "ready";
}

/**
 * A folder link (format 2, 0.18.0): the files are listed and each can be read before anything is
 * added; Add makes a new folder at the top (lab1, or lab1-2 when that name is taken; owner's pick
 * 2026-10-30), never mixing with files already there. Same states and Add rules as one file.
 */
function openFolder(folder: SharedFolder, deps: CodeLinkDeps): void {
  const { dialog, body } = dialogShell("code-link", `Open the folder ${shown(folder.name)}?`, { wide: true });
  dialog.classList.add("code-link");
  const about = h("p", { class: "field-note", id: "code-link-about" });
  const target = (): string => {
    const free = freeName(folder.name, deps.taken);
    about.textContent = `${plural(folder.files.length, "file")}, added as a new folder at the top of your files.${free === folder.name ? "" : ` You already have something named ${shown(folder.name)}, so this one is added as ${shown(free)}.`}`;
    return free;
  };
  target();
  // Which file the preview shows: a native select, the same on a phone as with a keyboard.
  const picker = h("select", { id: "code-link-file" }, ...folder.files.map((f, i) => h("option", { value: String(i) }, shown(f.name))));
  const code = h("code");
  const preview = h("pre", { class: "code-link-preview", id: "code-link-preview", tabindex: "0" }, code);
  const show = () => {
    const f = folder.files[Number(picker.value)];
    const lines = f.text === "" ? 0 : f.text.replace(/\n$/, "").split("\n").length;
    code.textContent = f.text === "" ? "" : shown(f.text);
    preview.toggleAttribute("data-empty", f.text === "");
    preview.setAttribute("aria-label", `The code in ${shown(f.name)}, ${plural(lines, "line")}`);
  };
  picker.addEventListener("change", show);
  show();
  const result = h("p", { class: "result-line", id: "code-link-result", role: "status" });
  body.append(
    h("p", { id: "code-link-lede" }, "Someone shared this folder with you in a link. It isn't in your files yet, and nothing in it runs until you press Run."),
    about,
    h("div", { class: "code-link-file" }, h("label", { for: "code-link-file" }, "Show the code in"), picker),
    preview,
    result,
  );
  dialog.setAttribute("aria-describedby", "code-link-lede code-link-about");
  const cancel = h("button", { type: "button", class: "btn", id: "code-link-cancel" }, "Not now");
  const add = h("button", { type: "button", class: "btn primary", id: "code-link-add" }, "Add to my files");
  dialog.append(h("div", { class: "dialog-actions" }, cancel, add));
  cancel.addEventListener("click", () => dialog.close());
  let adding = false;
  add.addEventListener("click", async (e) => {
    if (e.detail > 1 || adding) return;
    adding = true;
    dialog.setAttribute("aria-busy", "true");
    dialog.dataset.state = "adding";
    result.replaceChildren();
    delete result.dataset.tone;
    let refusal: AddRefusal | null;
    try {
      refusal = await deps.addFolder(target(), folder.files);
    } catch (error) {
      refusal = { message: `The folder wasn't added: ${error instanceof Error ? error.message : String(error)}` };
    }
    adding = false;
    dialog.removeAttribute("aria-busy");
    if (!refusal) return void dialog.close();
    if (!dialog.open) return void deps.notice.show(refusal.message, { tone: refusal.readOnly ? "info" : "error" });
    dialog.dataset.state = "refused";
    result.dataset.tone = refusal.readOnly ? "warning" : "error";
    result.replaceChildren(icon(refusal.readOnly ? "warning" : "warning-circle", "result-icon"), h("span", null, shown(refusal.message)));
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  openModal(dialog, add, null);
  dialog.dataset.state = "ready";
}
