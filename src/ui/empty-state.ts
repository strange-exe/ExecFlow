// What the editor area shows without a file, in reading order: first "Create your first
// file" with a starter for each language, then importing files, then connecting GitHub.
import { LANGUAGES, type LanguageId } from "../core/languages";
import { h } from "./dom";
import { icon, type IconName } from "./icons";

const LANG_ICON: Record<LanguageId, IconName> = { python: "file-py", c: "file-c", cpp: "file-cpp" };

export interface EmptyActions {
  create(lang: LanguageId): void;
  importFiles(): void;
  importFolder(): void;
  connect(): void;
  /** "New from example...": the examples dialog (focus comes back to `opener`). */
  examples(opener: HTMLElement): void;
}

export function emptyWorkspace(actions: EmptyActions, readOnly: boolean): HTMLElement {
  const choices = LANGUAGES.map((lang) => {
    const button = h(
      "button",
      { type: "button", class: "starter", "data-language": lang.id },
      icon(LANG_ICON[lang.id], "starter-icon"),
      h("span", { class: "starter-file" }, lang.defaultFilename),
      h("span", { class: "starter-lang" }, lang.label),
    );
    button.disabled = readOnly;
    button.addEventListener("click", () => actions.create(lang.id));
    return button;
  });
  const importFiles = h("button", { type: "button", class: "btn" }, icon("upload-simple"), "Import files");
  const importFolder = h("button", { type: "button", class: "btn" }, icon("folder-plus"), "Import a folder");
  // An outline button like Import: a borderless one read as plain text beside the rule-separated rows.
  const connect = h("button", { type: "button", class: "btn" }, icon("github-logo"), "Connect GitHub");
  // The starters lead; the examples are the same step's quieter second way (a tertiary text button).
  const examples = h("button", { type: "button", class: "text-btn", id: "empty-examples" }, "New from example...");
  examples.addEventListener("click", () => actions.examples(examples));
  importFiles.disabled = readOnly;
  importFolder.disabled = readOnly;
  importFiles.addEventListener("click", actions.importFiles);
  importFolder.addEventListener("click", actions.importFolder);
  connect.addEventListener("click", actions.connect);
  return h(
    "div",
    { class: "empty-state", "data-empty": "workspace" },
    h("h2", { class: "empty-title", id: "empty-title" }, "Create your first file"),
    h("p", { class: "empty-lede" }, "Start with a short program in Python, C or C++. It is saved on this computer as you type."),
    h("div", { class: "starters", role: "group", "aria-labelledby": "empty-title" }, ...choices),
    h("p", { class: "empty-examples" }, examples),
    h(
      "div",
      { class: "empty-more" },
      h("p", { class: "empty-label" }, "Already have code?"),
      h("div", { class: "row-actions" }, importFiles, importFolder),
    ),
    h(
      "div",
      { class: "empty-more" },
      h("p", { class: "empty-label" }, "Keep your files in a private GitHub repository, to work on them from other computers."),
      h("div", { class: "row-actions" }, connect),
    ),
  );
}

/**
 * While start-up reopens the file left open last time (its editor is still loading): a quiet line,
 * in the place the code will take, instead of a "No file open" that isn't true.
 */
export function openingFile(name: string): HTMLElement {
  return h("div", { class: "empty-state compact", "data-empty": "opening" }, h("p", { class: "empty-lede" }, `Opening ${name}`));
}

export function noFileOpen(): HTMLElement {
  return h(
    "div",
    { class: "empty-state compact", "data-empty": "no-file" },
    h("h2", { class: "empty-title" }, "No file open"),
    h("p", { class: "empty-lede" }, "Choose a file in the list to open it. Ctrl+Shift+E moves to the list."),
  );
}
