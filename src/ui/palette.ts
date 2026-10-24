// The command palette and quick open (.claude/design/batch3/p.md section 1): one modal dialog with a
// WAI-ARIA APG combobox and its listbox (www.w3.org/WAI/ARIA/apg/patterns/combobox/). Ctrl+P and the
// top bar's Search open it on files and commands; F1 and Ctrl+Shift+P on commands only, which a
// leading ">" means. A lazy chunk: the shell keeps only the keys, the control and a function table.
//
// The input keeps the focus; aria-activedescendant names the active option, which is the first one
// after every change. Down and Up move it (wrapping), PageDown and PageUp by eight, Enter chooses,
// Escape closes; Home and End stay in the text, as in APG's editable combobox. Choosing closes the
// dialog first, so whatever the command focuses (a file's code, a dialog, the file list) keeps it.
import "../styles/palette.css";
import { nameOf } from "../core/paths";
import { dialogShell, openModal } from "./dialogs";
import { h, shown } from "./dom";
import { icon } from "./icons";
import { buildCommands, results, type Hit, type Option, type PaletteApi, type Results } from "./palette-model";
import { keyParts, paletteKey } from "./shortcuts";

export type PaletteMode = "all" | "commands";

const PAGE = 8;

interface Instance {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  setMode(mode: PaletteMode): void;
}

let instance: Instance | null = null;

/** Text with its matched ranges drawn as <mark> (weight and underline, never colour alone). */
function marked(text: string, hits: readonly Hit[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start < at || hit.end > text.length) continue;
    if (hit.start > at) out.push(text.slice(at, hit.start));
    out.push(h("mark", { class: "palette-hit" }, text.slice(hit.start, hit.end)));
    at = hit.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * An option's name as one phrase: its visible label first (WCAG 2.5.3), then its keys or its folder,
 * after commas ("calc.py, in labs, open now"). Named from its content instead, each flex item was a
 * block of the name, so a hidden comma beside one, or inside one (a visually hidden span is
 * absolutely positioned, so a block too), was heard with a space before it ("calc.py , in labs").
 */
function spoken(...parts: (string | false | undefined)[]): string {
  return parts.filter((p): p is string => !!p).join(", ");
}

function keycaps(keys: string): (Node | string)[] {
  return keyParts(keys).flatMap((p): (Node | string)[] => (p.word ? [h("span", { class: "palette-or" }, p.word)] : p.caps!.map((c) => h("kbd", { class: "keycap" }, c))));
}

/** Opens the palette (or switches the open one to `mode`). `opener`: where focus goes back. */
export function openPalette(api: PaletteApi, mode: PaletteMode, opener: HTMLElement | null): void {
  if (instance?.dialog.open) {
    instance.setMode(mode);
    instance.input.focus();
    instance.input.setSelectionRange(instance.input.value.length, instance.input.value.length);
    return;
  }
  // Another dialog or a menu took over while the chunk loaded: it keeps the keyboard.
  if (document.querySelector("dialog[open], .menu")) return;
  // Closed but still on the page: its close event (which removes it) comes a task later, and a
  // second dialog with the same ids must never stand beside it.
  instance?.dialog.remove();
  instance = build(api, mode, opener);
}

function build(api: PaletteApi, mode: PaletteMode, opener: HTMLElement | null): Instance {
  const { dialog, body, close } = dialogShell("palette", "Search files and commands");
  dialog.classList.add("palette");
  const hintId = "palette-hint";
  const input = h("input", {
    type: "text", class: "palette-input", id: "palette-input", role: "combobox", "aria-autocomplete": "list", "aria-controls": "palette-list",
    "aria-expanded": "false", "aria-labelledby": "palette-title", "aria-describedby": hintId, autocomplete: "off", autocapitalize: "off",
    spellcheck: "false", enterkeyhint: "go",
  });
  input.placeholder = "Search files and commands";
  const field = h("div", { class: "palette-field" }, icon("magnifying-glass", "palette-glass"), input);
  const list = h("div", { class: "palette-list", id: "palette-list", role: "listbox", "aria-labelledby": "palette-title" });
  const empty = h("p", { class: "palette-empty", "aria-hidden": "true" });
  const status = h("div", { class: "visually-hidden", role: "status" });
  const hint = h("p", { class: "palette-hint", id: hintId }, "Enter chooses. Esc closes. Type > for commands only.");
  // The close button sits beside the field (the head's title is for assistive technology only).
  body.append(h("div", { class: "palette-row" }, field, close), list, empty, hint, status);

  let options: { el: HTMLElement; option: Option }[] = [];
  let active = -1;

  function setActive(i: number, scroll = true) {
    if (!options.length) {
      active = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = (i + options.length) % options.length;
    options.forEach(({ el }, n) => el.setAttribute("aria-selected", String(n === active)));
    const el = options[active].el;
    input.setAttribute("aria-activedescendant", el.id);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  function optionNode(option: Option, n: number): HTMLElement {
    const id = `palette-opt-${n}`;
    if (option.kind === "file") {
      const raw = nameOf(option.path);
      // A hidden or direction character is shown as a tag ("[U+202E]"), which moves the letters: then
      // the name is drawn without marks rather than with marks in the wrong place.
      const name = shown(raw);
      if (name !== raw) option = { ...option, hits: [] };
      const folder = option.folder ? shown(option.folder) : "";
      return h(
        "div",
        {
          class: "palette-option", role: "option", id, "aria-selected": "false", "aria-label": spoken(name, folder && `in ${folder}`, option.current && "open now"),
          "data-kind": "file", "data-path": option.path, "data-current": String(option.current),
        },
        icon("file", "palette-icon"),
        h("span", { class: "palette-label palette-name" }, ...marked(name, option.hits)),
        folder ? h("span", { class: "palette-detail" }, folder) : null,
        option.current ? h("span", { class: "palette-detail" }, "open now") : null,
      );
    }
    const c = option.command;
    return h(
      "div",
      { class: "palette-option", role: "option", id, "aria-selected": "false", "aria-label": spoken(c.label, c.keys), "data-kind": "command", "data-command": c.id },
      h("span", { class: "palette-label" }, ...marked(c.label, option.hits)),
      c.keys ? h("span", { class: "palette-keys" }, ...keycaps(c.keys)) : null,
    );
  }

  function render() {
    // The commands that apply now (a run that ended takes Stop away): about 50 small objects, built
    // again each time.
    const r: Results = results(input.value, api.files(), api.openPaths(), api.activePath(), buildCommands(api));
    dialog.dataset.mode = r.commandsOnly ? "commands" : "all";
    hint.textContent = `Enter chooses. Esc closes. ${r.commandsOnly ? "Delete the > to search the files too." : "Type > for commands only."}`;
    options = [];
    let n = 0;
    const groups = r.groups.map((g, gi) => {
      const titleId = `palette-group-${gi}`;
      const nodes = g.options.map((o) => {
        const el = optionNode(o, n++);
        options.push({ el, option: o });
        return el;
      });
      const more = g.title === "Files" && r.moreFiles
        ? h("div", { class: "palette-more", role: "presentation" }, input.value.trim() ? `${r.moreFiles} more: type more of the name.` : `Type to search all ${r.moreFiles + g.options.length} files.`)
        : null;
      return h("div", { role: "group", "aria-labelledby": titleId, class: "palette-group" }, h("div", { class: "palette-group-title", id: titleId, role: "presentation" }, g.title), ...nodes, more);
    });
    list.replaceChildren(...groups);
    list.hidden = r.count === 0;
    input.setAttribute("aria-expanded", String(r.count > 0));
    const what = r.commandsOnly ? "commands" : "files or commands";
    empty.textContent = r.count ? "" : `No ${what} match. ${r.commandsOnly ? "Delete the > to search the files too." : "Try fewer letters."}`;
    empty.hidden = r.count > 0;
    status.textContent = r.count ? `${r.count} ${r.count === 1 ? "result" : "results"}` : `No ${what} match`;
    dialog.dataset.count = String(r.count);
    setActive(0, false);
    list.scrollTop = 0;
  }

  function choose(i: number) {
    const picked = options[i]?.option;
    if (!picked) return;
    // The list was drawn when the text last changed: a command that has stopped applying since (Stop
    // after the run ended) is not run. The list is drawn again and says why.
    const command = picked.kind === "command" ? buildCommands(api).find((c) => c.id === picked.command.id) : null;
    if (picked.kind === "command" && !command) {
      render();
      const why = `"${picked.command.label}" no longer applies, so the list is up to date now.`;
      hint.textContent = why;
      status.textContent = why;
      return;
    }
    // Where the command was asked for from: what it opens returns there (a dialog, the code).
    const from = opener?.isConnected ? opener : document.getElementById("palette-button") ?? document.body;
    dialog.close();
    if (picked.kind === "file") api.act.open(picked.path);
    else command!.run(from);
  }

  function setMode(mode: PaletteMode) {
    const query = input.value.replace(/^>\s*/, "");
    input.value = mode === "commands" ? `>${query}` : query;
    caretToEnd();
    render();
  }
  /** Typing goes after the ">" (WebKit put the caret at the start of a value set before focus). */
  function caretToEnd() {
    input.setSelectionRange(input.value.length, input.value.length);
  }

  input.addEventListener("input", () => render());
  dialog.addEventListener("keydown", (e) => {
    // The palette's own keys switch its mode; Ctrl+P never reaches the browser's Print here. (The
    // window's shortcut handler runs nothing while a dialog is open.)
    const mode = paletteKey(e);
    if (mode) {
      e.preventDefault();
      setMode(mode);
      input.focus();
      return;
    }
    if (e.target !== input || e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        setActive(active + 1);
        break;
      case "ArrowUp":
        setActive(active - 1);
        break;
      case "PageDown":
        setActive(Math.min(options.length - 1, active + PAGE));
        break;
      case "PageUp":
        setActive(Math.max(0, active - PAGE));
        break;
      case "Enter":
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        choose(active);
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  // The pointer: a press never takes the focus from the field; a click chooses; a pointer that
  // really moves makes its option the active one (one row looks chosen, as in the menus).
  list.addEventListener("mousedown", (e) => e.preventDefault());
  let last = { x: Number.NaN, y: Number.NaN };
  list.addEventListener("pointermove", (e) => {
    if (e.clientX === last.x && e.clientY === last.y) return;
    last = { x: e.clientX, y: e.clientY };
    const el = (e.target as Element).closest<HTMLElement>("[role=option]");
    const i = options.findIndex((o) => o.el === el);
    if (i >= 0 && i !== active) setActive(i, false);
  });
  list.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>("[role=option]");
    const i = options.findIndex((o) => o.el === el);
    if (i >= 0) choose(i);
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (instance?.dialog === dialog) instance = null;
  }, { once: true });

  setMode(mode);
  // Focus goes back where it was: the code through view.focus() (a raw focus() scrolls in WebKit).
  openModal(dialog, input, () => {
    if (opener?.closest(".cm-editor")) {
      const view = api.view();
      if (view) {
        view.focus();
        return null;
      }
    }
    return opener?.isConnected && opener.getClientRects().length ? opener : document.getElementById("palette-button");
  });
  caretToEnd();
  // Ready for tests and for the next key: the results are drawn and the field has the focus.
  dialog.dataset.state = "ready";
  return { dialog, input, setMode };
}
