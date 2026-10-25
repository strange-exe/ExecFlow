// The Arguments field beside the Input text (track R, batch 3; spec .claude/design/batch3/r.md): the
// open file's command-line arguments, kept per file. A lazy chunk: output.ts loads it when a file
// that can run is opened, or at Run, so a first visit doesn't carry it.
// Its error is decision 13's field error: the message right under the field and before its hint
// (error band, danger bar and icon, words at 600), aria-invalid, and aria-describedby naming the
// message first. It shows on leaving the field or on Run, never mid-typing; while shown, every edit
// checks again and clears it as soon as the text is fine.
import { nameOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { formatArgs, parseArgs, RunArgsMemory, type RunArgsStore } from "../runner/run-args";
import { h } from "./dom";
import { icon } from "./icons";

/** A run's arguments, or why they can't be split. `shown`: the line the run-log header shows. */
export type RunArgs = { ok: true; args: string[]; shown: string } | { ok: false; reason: string };

export class ArgsField {
  private readonly memory: RunArgsMemory;
  private readonly field: HTMLInputElement;
  private readonly file: HTMLElement;
  private readonly error: HTMLElement;
  /** The file whose arguments the field shows; null hides the row. */
  private path: WsPath | null = null;

  /** `row`: the empty #args-row output.ts keeps in the Input box. */
  constructor(private readonly row: HTMLElement, store: RunArgsStore | null) {
    this.memory = new RunArgsMemory(store);
    this.field = h("input", {
      id: "args-field",
      class: "args-field",
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      "aria-describedby": "args-note",
    });
    this.file = h("span", { class: "args-file" });
    this.error = h("p", { class: "args-error field-error", id: "args-error" });
    this.error.hidden = true;
    row.dataset.state = "empty";
    row.append(
      h("label", { class: "stdin-label", for: "args-field" }, "Arguments for ", this.file),
      this.field,
      this.error,
      h("p", { class: "args-note", id: "args-note" }, 'Split at spaces. "Two words" in quotes stay one argument.'),
    );
    this.field.addEventListener("input", () => {
      if (this.path === null) return;
      this.memory.set(this.path, this.field.value);
      if (row.dataset.state === "invalid") this.check();
      else this.setError(null);
    });
    this.field.addEventListener("change", () => this.check());
    // Texts read again from storage (at start, or after another tab wrote) may change the one shown.
    this.memory.onLoad(() => this.show(this.path, false));
  }

  /**
   * Shows the arguments of `path` (a file that can run; null hides the row). Switching files drops
   * a shown error (it was about the other file's text); the text being typed is never replaced
   * under the caret.
   */
  show(path: WsPath | null, reload = true): void {
    const same = path === this.path;
    this.path = path;
    this.row.hidden = path === null;
    // Read again with no file shown too: after a sync removed the open file (the workbench shows
    // the active file again after every reload from storage), this tab's copy drops its text, so
    // a new file with that name never shows it.
    if (reload) void this.memory.load();
    if (path === null) return;
    this.file.textContent = nameOf(path);
    if (!(same && document.activeElement === this.field)) this.field.value = this.memory.get(path);
    if (!same || this.row.dataset.state !== "invalid") this.setError(null);
  }

  /** A file or folder was renamed (`to`) or deleted (null): its arguments follow it or go. */
  moved(from: WsPath, to: WsPath | null): void {
    this.memory.moved(from, to);
    const path = this.path;
    if (path === null || !(path === from || path.startsWith(`${from}/`))) return;
    this.show(to === null ? null : to + path.slice(from.length), false);
  }

  /**
   * The arguments for a run of `path`. The saved texts are read again first: a Run can be what
   * loaded this chunk (show's read not finished yet), and another tab may have renamed the file
   * since the last read. The shown file runs the text its field shows (a read never replaces the
   * text under a caret).
   */
  async argsFor(path: WsPath): Promise<RunArgs> {
    await this.memory.load();
    const parsed = parseArgs(path === this.path ? this.field.value : this.memory.get(path));
    return parsed.ok ? { ...parsed, shown: formatArgs(parsed.args) } : parsed;
  }

  /** Whether the shown file has arguments (a run then keeps the Input box open). */
  get hasText(): boolean {
    return this.field.value !== "";
  }

  /**
   * Run was pressed with arguments that can't be split: the message goes under the field, and the
   * field takes focus (its description reads the message). Returns true when focus was already
   * there, so the caller says the message instead (nothing would be heard otherwise).
   */
  explain(reason: string): boolean {
    this.setError(reason);
    const already = document.activeElement === this.field;
    if (!already) this.field.focus();
    this.row.scrollIntoView({ block: "nearest" });
    return already;
  }

  private check(): void {
    const parsed = parseArgs(this.field.value);
    this.setError(parsed.ok ? null : parsed.reason);
  }

  private setError(reason: string | null): void {
    this.error.replaceChildren(...(reason ? [icon("warning-circle"), h("span", null, reason)] : []));
    this.error.hidden = !reason;
    if (reason) this.field.setAttribute("aria-invalid", "true");
    else this.field.removeAttribute("aria-invalid");
    // The message leads: read first, after the field's name and state (decision 13).
    this.field.setAttribute("aria-describedby", reason ? "args-error args-note" : "args-note");
    this.row.dataset.state = reason ? "invalid" : this.field.value ? "ok" : "empty";
  }
}
