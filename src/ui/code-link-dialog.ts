// Opening a code link (src/core/code-link.ts, .claude/tasks/code-links.md): the shared file is shown
// in a read-only editor first, with its flowchart and a Run of its own (code-preview.ts), and becomes
// one of the student's files only when they press Add. Nothing runs until they press Run, and a run
// there writes nothing to their files: it is someone else's code. A lazy chunk (with the link
// decoder), loaded only when the page opens with #code=. Name and code go in as text, every unshown
// character tagged (shown()), so the preview can neither run markup nor hide part of the code.
// State attribute for tests: data-state ("ready", "adding", "refused"). The file is added under a
// free name (examples.ts freeName), never over a file, chosen again when Add is pressed; when the
// same file (same name, same text) is already there, Add opens that one instead of adding a copy.
// The dialog closes only once the file is added: an add that fails (a read-only tab, storage
// refusing it) says why inside the dialog and keeps the shared file there, so Add can be pressed
// again. Closed without adding, the notice offers it again ("Open again"): the link itself left the
// address bar when it opened (link-fragment.ts), so this is the way back.
// A short link (/s/<id>#<key>, src/core/short-link.ts) is fetched and decrypted first ("Opening the
// short link..." in the notice), then offered in the same preview; a link that can't be opened
// (expired, damaged, offline) says so in the notice and opens nothing.
import { detectLanguage } from "../core/languages";
import { readCodeLink, readRefusalText, type ReadResult, type SharedFile, type SharedFolder } from "../core/code-link";
import { openShortLink, shortLinkId, shortReadRefusalText } from "../core/short-link";
import { createCodePreview, type CodePreview, type PreviewDeps } from "./code-preview";
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
  /** `path` when the workspace has a file there whose text is exactly `text` (else null). */
  same(path: string, text: string): Promise<string | null>;
  /** Opens a file already in the workspace (the copy a link would otherwise add again). */
  open(path: string): Promise<void>;
  /**
   * Adds the file at the workspace root and opens it: null once it is added, else why not (a
   * read-only tab adds nothing). It shows no notice: the dialog says why.
   */
  add(path: string, text: string): Promise<AddRefusal | null>;
  /** Adds a folder link's files as a new folder `folder` at the root, and opens one: as add. */
  addFolder(folder: string, files: readonly SharedFile[]): Promise<AddRefusal | null>;
  readonly notice: Pick<Notice, "show">;
  /** The page's runtimes and run settings, for the preview's own Run. */
  readonly preview: PreviewDeps;
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

const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/** The parts both kinds of link share: the full-screen dialog, the preview, the result line and the buttons. */
interface Frame {
  dialog: HTMLDialogElement;
  meta: HTMLElement;
  about: HTMLElement;
  preview: CodePreview;
  result: HTMLElement;
  add: HTMLButtonElement;
  /** Shows a refusal in the dialog (or, closed already, in the notice). */
  refused(refusal: AddRefusal): void;
}

/** `what` names the shared thing in the notice after a close ("hello.c", "the folder lab1"). */
function frame(title: string, what: string, lede: string, deps: CodeLinkDeps, reopen: () => void): Frame {
  const { dialog, body } = dialogShell("code-link", title);
  dialog.classList.add("code-link");
  const about = h("p", { class: "field-note", id: "code-link-about" });
  const meta = h("div", { class: "code-link-meta" }, h("p", { id: "code-link-lede" }, lede), about);
  const preview = createCodePreview(dialog, deps.preview);
  const result = h("p", { class: "result-line", id: "code-link-result", role: "status" });
  body.append(meta, preview.panes, preview.runArea, result);
  dialog.setAttribute("aria-describedby", "code-link-lede code-link-about");
  const cancel = h("button", { type: "button", class: "btn", id: "code-link-cancel" }, "Not now");
  const add = h("button", { type: "button", class: "btn primary", id: "code-link-add" }, "Add to my files");
  dialog.append(h("div", { class: "dialog-actions" }, cancel, preview.runButton, add));
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener(
    "close",
    () => {
      preview.dispose();
      dialog.remove();
      // Closed without adding: the link has left the address bar, so the notice is the way back.
      if (dialog.dataset.state !== "added") deps.notice.show(`Closed ${what} from a link. It isn't in your files.`, { tone: "info", action: { label: "Open again", run: reopen } });
    },
    { once: true },
  );
  return {
    dialog,
    meta,
    about,
    preview,
    result,
    add,
    refused(refusal) {
      // Closed while it was adding: the sentence still reaches the student.
      if (!dialog.open) return void deps.notice.show(refusal.message, { tone: refusal.readOnly ? "info" : "error" });
      // Kept open with the code: the student can press Add again, or Not now.
      dialog.dataset.state = "refused";
      result.dataset.tone = refusal.readOnly ? "warning" : "error";
      result.replaceChildren(icon(refusal.readOnly ? "warning" : "warning-circle", "result-icon"), h("span", null, shown(refusal.message)));
    },
  };
}

/** Wires Add: one press, one file; busy while it adds; `act` returns null once done, else why not. */
function wireAdd(f: Frame, act: () => Promise<AddRefusal | null>, failed: string): void {
  let adding = false;
  f.add.addEventListener("click", async (e) => {
    // The second click of a double click, or a press while one is adding, does nothing (the Run
    // rule): one press, one file.
    if (e.detail > 1 || adding) return;
    adding = true;
    // Busy for assistive technology; the button stays enabled and focusable (a press now does nothing).
    f.dialog.setAttribute("aria-busy", "true");
    f.dialog.dataset.state = "adding";
    f.result.replaceChildren();
    delete f.result.dataset.tone;
    let refusal: AddRefusal | null;
    try {
      refusal = await act();
    } catch (error) {
      refusal = { message: `${failed}: ${error instanceof Error ? error.message : String(error)}` };
    }
    adding = false;
    f.dialog.removeAttribute("aria-busy");
    if (!refusal) {
      f.dialog.dataset.state = "added";
      return void f.dialog.close();
    }
    f.refused(refusal);
  });
}

/** Focus back on the code the student had open (else wherever the browser puts it). */
const backToCode = () => document.querySelector<HTMLElement>("#editor-area .cm-content");

function offer(read: Extract<ReadResult, { ok: true }>, noun: string, deps: CodeLinkDeps): void {
  if (document.querySelector("dialog[open], .menu")) {
    return void deps.notice.show(`A ${noun} arrived while a dialog was open, so it wasn't opened. Close the dialog, then open the link again.`, { tone: "info" });
  }
  const reopen = () => offer(read, noun, deps);
  if ("folder" in read) return openFolder(read.folder, deps, reopen);
  const file = read.file;
  const { name, text } = file;
  const language = detectLanguage(name)?.label;
  const f = frame(shown(name), shown(name), "Shared with you in a link. It isn't in your files, and nothing runs until you press Run.", deps, reopen);
  /** The same file (name and text) already in the files: Add opens it rather than adding a copy. */
  let same: string | null = null;
  /** The free name now (the files can change while the dialog is open), said in the note. */
  const target = (): string => {
    const free = freeName(name, deps.taken);
    const where = same
      ? ` You already have this file, as ${shown(same)}.`
      : free === name ? "" : ` You already have a file named ${shown(name)}, so this one is added as ${shown(free)}.`;
    f.about.textContent = `${language ? `${language}, ` : ""}${plural(lineCount(text), "line")}.${where}`;
    f.add.textContent = same ? `Open ${shown(same)}` : "Add to my files";
    return free;
  };
  target();
  void deps.same(name, text).then(
    (path) => {
      same = path;
      target();
    },
    () => {},
  );
  wireAdd(
    f,
    async () => {
      same = await deps.same(name, text).catch(() => null);
      if (!same) return deps.add(target(), text);
      await deps.open(same);
      return null;
    },
    "The file wasn't added",
  );
  f.preview.show(file, [file]);
  openModal(f.dialog, f.preview.code, backToCode);
  f.dialog.dataset.state = "ready";
}

/**
 * A folder link (format 2, 0.18.0): the files are listed and each can be read (and run, with the
 * folder's other files beside it) before anything is added; Add makes a new folder at the top (lab1,
 * or lab1-2 when that name is taken; owner's pick 2026-10-30), never mixing with files already there.
 * Same states and Add rules as one file.
 */
function openFolder(folder: SharedFolder, deps: CodeLinkDeps, reopen: () => void): void {
  const f = frame(`Folder ${shown(folder.name)}`, `the folder ${shown(folder.name)}`, "Shared with you in a link. It isn't in your files, and nothing in it runs until you press Run.", deps, reopen);
  const target = (): string => {
    const free = freeName(folder.name, deps.taken);
    f.about.textContent = `${plural(folder.files.length, "file")}, added as a new folder at the top of your files.${free === folder.name ? "" : ` You already have something named ${shown(folder.name)}, so this one is added as ${shown(free)}.`}`;
    return free;
  };
  target();
  // Which file the preview shows: a native select, the same on a phone as with a keyboard. The first
  // one that runs is shown first (a program, not its header).
  const first = Math.max(0, folder.files.findIndex((file) => detectLanguage(file.name)));
  const picker = h("select", { id: "code-link-file" }, ...folder.files.map((file, i) => h("option", { value: String(i) }, shown(file.name))));
  picker.value = String(first);
  const show = () => f.preview.show(folder.files[Number(picker.value)], folder.files);
  picker.addEventListener("change", show);
  f.meta.append(h("div", { class: "code-link-file" }, h("label", { for: "code-link-file" }, "File"), picker));
  wireAdd(f, () => deps.addFolder(target(), folder.files), "The folder wasn't added");
  show();
  openModal(f.dialog, f.preview.code, backToCode);
  f.dialog.dataset.state = "ready";
}
