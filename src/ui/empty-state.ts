// What the editor area shows without a file (Workbench Pro, item 7), in reading order: the title
// and what happens to the code, one primary action (New file, which names a file in the list), the
// one-click starters in a sentence under it, then the other ways in as one ruled list: an example,
// importing files or a folder, connecting GitHub.
import { LANGUAGES, type LanguageId } from "../core/languages";
import { h, isMac } from "./dom";
import { icon, type IconName } from "./icons";

export interface EmptyActions {
  /** New file: a name typed in the file list (as the rail's New file does). */
  newFile(): void;
  /** A starter: a saved main.py, main.c or main.cpp with a short program, opened. */
  create(lang: LanguageId): void;
  importFiles(): void;
  importFolder(): void;
  connect(): void;
  /** "New from example": the examples dialog (focus comes back to `opener`). */
  examples(opener: HTMLElement): void;
}

/** One row of the ruled list: its icon, its words over what it does, and a caret. */
function option(id: string | null, iconName: IconName, label: string, note: string): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "empty-option", ...(id ? { id } : {}) },
    icon(iconName, "empty-option-icon"),
    h("span", { class: "empty-option-text" }, h("span", { class: "empty-option-label" }, label), h("span", { class: "empty-option-note" }, note)),
    icon("caret-right", "empty-option-go"),
  );
}

export function emptyWorkspace(actions: EmptyActions, readOnly: boolean): HTMLElement {
  const newFile = h("button", { type: "button", class: "btn primary empty-new", id: "empty-new-file" }, icon("plus"), "New file");
  newFile.addEventListener("click", () => actions.newFile());
  // The starters: each file's name as a text button, in one sentence ("or start with main.py, ...").
  const starters = LANGUAGES.map((lang) => {
    const button = h("button", { type: "button", class: "text-btn starter", "data-language": lang.id, title: `A short ${lang.label} program in ${lang.defaultFilename}` }, lang.defaultFilename);
    button.disabled = readOnly;
    button.addEventListener("click", () => actions.create(lang.id));
    return button;
  });
  const sentence: (Node | string)[] = ["Or start with "];
  starters.forEach((button, i) => sentence.push(button, i === starters.length - 1 ? "." : i === starters.length - 2 ? " or " : ", "));
  newFile.disabled = readOnly;
  const examples = option("empty-examples", "file-text", "New from example", "Pick a short program to run and change");
  const importFiles = option(null, "upload-simple", "Import files", "Open .py, .c or .cpp files from this computer");
  const importFolder = option(null, "folder-plus", "Import a folder", "Bring a whole project in at once");
  const connect = option(null, "github-logo", "Connect GitHub", "Keep your files in a private repository, to work on them from other computers");
  examples.addEventListener("click", () => actions.examples(examples));
  importFiles.disabled = readOnly;
  importFolder.disabled = readOnly;
  importFiles.addEventListener("click", actions.importFiles);
  importFolder.addEventListener("click", actions.importFolder);
  connect.addEventListener("click", actions.connect);
  const mod = isMac() ? "Cmd" : "Ctrl";
  return h(
    "div",
    { class: "empty-state", "data-empty": "workspace" },
    h("div", { class: "empty-mark", "aria-hidden": "true" }, icon("code-simple")),
    h("h2", { class: "empty-title", id: "empty-title" }, "Write your first program"),
    h("p", { class: "empty-lede" }, "Python, C and C++ run right here in the browser. Your files are saved on this computer as you type."),
    h(
      "div",
      { class: "empty-start" },
      newFile,
      h("span", { class: "empty-hint" }, "or press ", h("kbd", { class: "keycap" }, mod), " ", h("kbd", { class: "keycap" }, "P"), " and type a command"),
    ),
    h("p", { class: "empty-starters", role: "group", "aria-labelledby": "empty-title" }, ...sentence),
    h("ul", { class: "empty-options", "aria-label": "Other ways to start" }, ...[examples, importFiles, importFolder, connect].map((b) => h("li", null, b))),
    guideLinks(),
  );
}

/**
 * The guide pages (src/pages/routes.ts), last and quiet: a real link to each, so students and
 * crawlers that render "/" reach them (owner's decision, 2026-10-31). A new tab, like the status
 * bar's About, so nothing typed here is lost.
 */
const GUIDES = [
  { path: "/python", label: "Run Python" },
  { path: "/c", label: "Run C" },
  { path: "/cpp", label: "Run C++" },
  { path: "/flowchart-from-code", label: "Flowchart from code" },
] as const;

function guideLinks(): HTMLElement {
  const sentence: (Node | string)[] = ["New to it? Read a guide: "];
  GUIDES.forEach((g, i) => {
    const link = h("a", { class: "text-btn", href: g.path, target: "_blank", rel: "noopener noreferrer", title: `${g.label} guide (opens in a new tab)` }, g.label);
    sentence.push(link, i === GUIDES.length - 1 ? "." : i === GUIDES.length - 2 ? " or " : ", ");
  });
  return h("nav", { class: "empty-guides", "aria-label": "Guides" }, ...sentence);
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
