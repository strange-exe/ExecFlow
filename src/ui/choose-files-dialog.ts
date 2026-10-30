// "Choose files to download or share..." (0.18.0, owner's pick 2026-10-30: a checklist dialog, the
// file list itself keeps one selection). Native checkboxes in nested lists: a folder's box ticks or
// clears everything in it and shows "mixed" when only some is ticked (WAI-ARIA APG checkbox pattern,
// https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/). Download saves the ticked files (one file as
// itself, more as a .zip that the button names); Share link puts them in a code link (one file:
// format 1; more: a folder link, format 2) within the 8,000-character limit, and says when they
// don't fit. Read-only GitHub files are listed but can't be ticked: their text isn't stored here.
// A lazy chunk. State attribute for tests: data-state ("ready", "downloading", "sharing", "shared").
import { makeCodeLink, makeFolderLink, MAX_LINK_CHARS, MAX_LINK_FILES, type MakeRefusal } from "../core/code-link";
import { isInside, joinPath, nameOf, parentOf } from "../core/paths";
import { coverPicks, linkFolder, zipName } from "../storage/export-pick";
import { dialogShell, openModal } from "./dialogs";
import { h, plural, shown } from "./dom";
import { icon } from "./icons";

export interface ChooseFilesDeps {
  /** Every text file of the workspace, with its text (LF line ends, as stored). */
  files(): Promise<{ path: string; text: string }[]>;
  /** Read-only files from GitHub: shown, never ticked. */
  readonly readOnly: readonly string[];
  /** What the file list has selected: a file or folder ticked at the start. */
  readonly initial: string | null;
  /** The workspace's name, for a .zip of picks from several folders. */
  readonly workspace: string;
  /** Downloads the picks, limited to the files the list `shown` (workbench downloadPaths: it says what it saved). */
  download(picks: readonly string[], shown: ReadonlySet<string>): Promise<void>;
  readonly origin: string;
  /** navigator.clipboard.writeText, swappable in tests. */
  readonly writeText?: (text: string) => Promise<void>;
}

const sizeText = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : `${(bytes / 1024).toFixed(1)} KB`);

/** Opens the dialog; `opener` gets focus back when it closes. */
export async function openChooseFiles(deps: ChooseFilesDeps, opener?: HTMLElement | null): Promise<void> {
  const files = await deps.files();
  const enc = new TextEncoder();
  const size = new Map(files.map((f) => [f.path, enc.encode(f.text).length]));
  const paths = files.map((f) => f.path);
  const readOnly = deps.readOnly.filter((p) => !size.has(p));

  const { dialog, body } = dialogShell("choose-files", "Choose files to download or share", { wide: true });
  dialog.classList.add("choose-files");

  // ---- the checklist: folders hold their files and folders, in the file list's order (A to Z, folders first)
  const boxes = new Map<string, HTMLInputElement>();
  const folderBoxes = new Map<string, HTMLInputElement>();
  let next = 0;
  const row = (path: string, kind: "file" | "dir" | "read-only") => {
    const id = `choose-${next++}`;
    const box = h("input", { type: "checkbox", id, "data-path": path, "data-kind": kind }) as HTMLInputElement;
    const label = h("label", { for: id }, icon(kind === "dir" ? "folder" : "file", "choose-icon"), h("span", { class: "choose-name" }, shown(nameOf(path))));
    if (kind === "file") label.append(h("span", { class: "choose-size" }, sizeText(size.get(path)!)));
    if (kind === "read-only") {
      box.disabled = true;
      label.append(h("span", { class: "choose-size" }, "read-only, from GitHub"));
    }
    if (kind === "dir") folderBoxes.set(path, box);
    else if (kind === "file") boxes.set(path, box);
    return h("div", { class: "choose-row" }, box, label);
  };
  const all = [...paths, ...readOnly];
  /** A folder's own files, and the folders directly inside it (named by their files' paths). */
  const children = (dir: string) => {
    const below = (p: string) => (dir === "" ? p : p.slice(dir.length + 1));
    const deeper = all.filter((p) => isInside(p, dir) && below(p).includes("/"));
    const dirs = [...new Set(deeper.map((p) => joinPath(dir, below(p).split("/")[0])))];
    const here = all.filter((p) => parentOf(p) === dir);
    return { dirs: dirs.sort((a, b) => a.localeCompare(b)), files: here.sort((a, b) => a.localeCompare(b)) };
  };
  const list = (dir: string): HTMLElement => {
    const { dirs, files: here } = children(dir);
    return h(
      "ul",
      { class: "choose-list", ...(dir === "" ? { "aria-labelledby": "choose-files-lede" } : {}) },
      ...dirs.map((d) => h("li", null, row(d, "dir"), list(d))),
      ...here.map((p) => h("li", null, row(p, size.has(p) ? "file" : "read-only"))),
    );
  };
  const tree = list("");

  // ---- the summary, the result line, the link once made
  const summary = h("p", { class: "choose-summary", id: "choose-summary", role: "status" });
  const result = h("p", { class: "result-line", id: "choose-result", role: "status" });
  const linkField = h("input", { type: "text", id: "choose-link", readonly: "", "aria-label": "The link", spellcheck: "false" }) as HTMLInputElement;
  const copyButton = h("button", { type: "button", class: "btn", id: "choose-copy" }, icon("copy"), "Copy link");
  const linkPanel = h("div", { class: "choose-link", hidden: "" }, linkField, copyButton);
  const lede = h("p", { id: "choose-files-lede" }, "Tick files, or whole folders. Download saves them to this computer; Share link puts them in a link that opens in ExecFlow, with nothing stored on a server.");
  const empty = h("p", { class: "field-note", id: "choose-empty" }, "There are no files to download or share yet.");
  body.append(lede, all.length ? h("div", { class: "choose-scroll" }, tree) : empty, summary, linkPanel, result);
  dialog.setAttribute("aria-describedby", "choose-files-lede");

  const cancel = h("button", { type: "button", class: "btn", id: "choose-cancel" }, "Cancel");
  const share = h("button", { type: "button", class: "btn", id: "choose-share" }, icon("link-simple"), "Share link");
  const download = h("button", { type: "button", class: "btn primary", id: "choose-download" }, icon("download-simple"), h("span", { class: "choose-download-label" }));
  dialog.append(h("div", { class: "dialog-actions" }, cancel, share, download));

  const ticked = () => paths.filter((p) => boxes.get(p)!.checked);
  const picks = () => coverPicks(ticked(), paths);
  const say = (text: string, tone?: "warning" | "error") => {
    result.replaceChildren(...(tone ? [icon(tone === "error" ? "warning-circle" : "warning", "result-icon")] : []), h("span", null, text));
    if (tone) result.dataset.tone = tone;
    else delete result.dataset.tone;
  };
  /** Folder boxes follow their files; the summary and the Download button say what is ticked. */
  function update() {
    for (const [dir, box] of folderBoxes) {
      const mine = paths.filter((p) => isInside(p, dir));
      const on = mine.filter((p) => boxes.get(p)!.checked).length;
      box.checked = mine.length > 0 && on === mine.length;
      box.indeterminate = on > 0 && on < mine.length;
      box.disabled = mine.length === 0; // only read-only files inside
    }
    const t = ticked();
    const bytes = t.reduce((n, p) => n + size.get(p)!, 0);
    summary.textContent = t.length ? `${plural(t.length, "file")} ticked, ${sizeText(bytes)}.` : "Nothing ticked yet.";
    const p = picks();
    const one = p.length === 1 && size.has(p[0]);
    (download.querySelector(".choose-download-label") as HTMLElement).textContent = t.length ? `Download ${one ? shown(nameOf(p[0])) : zipName(p, deps.workspace)}` : "Download";
    // The link made for other ticks is out of date.
    linkPanel.hidden = true;
    if (dialog.dataset.state === "shared") dialog.dataset.state = "ready";
  }
  tree.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.dataset.kind === "dir") for (const p of paths) if (isInside(p, box.dataset.path!)) boxes.get(p)!.checked = box.checked;
    say("");
    update();
  });

  // The file list's selection starts ticked.
  if (deps.initial !== null) for (const p of paths) if (isInside(p, deps.initial)) boxes.get(p)!.checked = true;
  update();

  let busy = false;
  cancel.addEventListener("click", () => dialog.close());
  download.addEventListener("click", async (e) => {
    if (e.detail > 1 || busy) return;
    const p = picks();
    if (!p.length) return say("Tick at least one file to download.", "warning");
    busy = true;
    dialog.dataset.state = "downloading";
    try {
      await deps.download(p, new Set(paths));
    } finally {
      busy = false;
    }
    dialog.close();
  });

  const refusalText = (r: MakeRefusal): string => {
    switch (r.kind) {
      case "too-long":
        return `These files are too big for a link${r.chars === null ? "" : ` (it would be ${r.chars.toLocaleString("en")} characters)`}: a link holds at most ${MAX_LINK_CHARS.toLocaleString("en")} characters, so chat apps keep it whole. Download them as a .zip instead.`;
      case "too-many":
        return `A link holds at most ${MAX_LINK_FILES} files. Tick fewer, or download them as a .zip.`;
      case "empty":
        return "Tick at least one file to share.";
      case "not-text":
        return `These files can't go in a link: ${r.reason}.`;
      case "unsupported":
        return "This browser can't make code links. Use a current Chrome, Edge, Firefox or Safari.";
    }
  };
  share.addEventListener("click", async (e) => {
    if (e.detail > 1 || busy) return;
    const t = ticked();
    if (!t.length) return say("Tick at least one file to share.", "warning");
    busy = true;
    dialog.dataset.state = "sharing";
    say("");
    const made = t.length === 1
      ? await makeCodeLink(deps.origin, nameOf(t[0]), files.find((f) => f.path === t[0])!.text)
      : await (async () => {
          const folder = linkFolder(picks(), files);
          return makeFolderLink(deps.origin, folder.name, folder.files);
        })();
    busy = false;
    if (!made.ok) {
      dialog.dataset.state = "ready";
      return say(refusalText(made.refusal), "warning");
    }
    linkField.value = made.url;
    linkPanel.hidden = false;
    dialog.dataset.state = "shared";
    say(`The link holds ${plural(t.length, "file")}. Anyone with it can read them; it opens them in ExecFlow without running anything.`);
    copyButton.focus();
  });
  copyButton.addEventListener("click", async () => {
    try {
      await (deps.writeText ?? ((text: string) => navigator.clipboard.writeText(text)))(linkField.value);
      say("Copied the link.");
    } catch {
      linkField.focus();
      linkField.select();
      say("The browser didn't let ExecFlow copy it: the link is selected, so copy it from the field.", "warning");
    }
  });

  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  const first = [...boxes.values(), ...folderBoxes.values()].find((b) => b.checked) ?? tree.querySelector<HTMLInputElement>("input:not(:disabled)");
  openModal(dialog, first ?? download, opener ?? null);
  dialog.dataset.state = "ready";
}
