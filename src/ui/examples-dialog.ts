// "New from example..." (.claude/design/batch3/p.md section 3): a dialog listing the bundled
// examples by language, each a button with its file name and one line on what it shows. Choosing
// one closes the dialog, then the workbench adds it at the workspace root under a free name and
// opens it. A lazy chunk with the examples' text, so a first visit pays nothing for them.
import "../styles/palette.css";
import type { LanguageId } from "../core/languages";
import { dialogShell, openModal } from "./dialogs";
import { h, srOnly } from "./dom";
import { EXAMPLES, freeName, type Example } from "./examples";
import { icon, type IconName } from "./icons";

const GROUPS: readonly { lang: LanguageId; title: string; icon: IconName }[] = [
  { lang: "python", title: "Python", icon: "file-py" },
  { lang: "c", title: "C", icon: "file-c" },
  { lang: "cpp", title: "C++", icon: "file-cpp" },
];

export interface ExamplesDeps {
  /** A path already in the workspace (compared as storage compares names). */
  taken(path: string): boolean;
  /** Adds the file and opens it (the workbench explains a read-only tab instead). */
  create(path: string, text: string): void;
  /** Where focus goes when the dialog closes without a choice. */
  returnTo: HTMLElement | (() => HTMLElement | null) | null;
}

let open = false;

export function openExamples(deps: ExamplesDeps): void {
  if (open || document.querySelector("dialog[open], .menu")) return;
  // The wide dialog: each description fits its one line at 1440 px, so the list scans and scrolls less.
  const { dialog, body } = dialogShell("examples", "New from example", { wide: true });
  dialog.classList.add("examples");
  body.append(h("p", { class: "examples-lede" }, "Short programs to read, run and change. The one you choose is added to your files and opened."));
  let first: HTMLButtonElement | null = null;
  for (const g of GROUPS) {
    const titleId = `examples-${g.lang}`;
    const buttons = EXAMPLES.filter((e) => e.lang === g.lang).map((example) => {
      const button = h(
        "button",
        { type: "button", class: "example", "data-example": example.name },
        icon(g.icon, "example-icon"),
        h("span", { class: "example-name" }, example.name),
        srOnly(", "),
        h("span", { class: "example-about" }, example.about),
      );
      button.addEventListener("click", (e) => {
        // The second click of a double click does nothing (the Run rule).
        if (e.detail > 1) return;
        choose(example);
      });
      first ??= button;
      return button;
    });
    body.append(h("h3", { class: "section-title", id: titleId }, g.title), h("div", { class: "example-list", role: "group", "aria-labelledby": titleId }, ...buttons));
  }

  function choose(example: Example) {
    dialog.close();
    deps.create(freeName(example.name, deps.taken), example.code);
  }

  dialog.addEventListener("close", () => {
    dialog.remove();
    open = false;
  }, { once: true });
  open = true;
  openModal(dialog, first, deps.returnTo);
  dialog.dataset.state = "ready";
}
