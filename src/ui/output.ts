// The Output view (Pocket Run pattern, layout v2): the Input box for text given up front (behind
// the panel bar's Input toggle), the one-time C/C++ download offer, the run-log header (the current
// run's file, its state while it runs, then the status word, exit code and times, and after a
// failure the lifted exception as a button that opens its line), the program's output as a
// role="log" console, and the field the program reads from while it waits, on the prompt's own
// line. Every stderr line has a bar beside it, and one stderr line of a failed run, the error the
// header lifts (Python's exception, or a failed build's first error), is drawn in the danger colour
// at 600, so colour is never the only signal.
import { detectLanguage } from "../core/languages";
import { nameOf } from "../core/paths";
import type { RunPhase, RunResult, RunStatus, WsPath } from "../core/types";
import type { RunArgsStore } from "../runner/run-args";
import type { ArgsField, RunArgs } from "./args-field";
import { formatMs, h } from "./dom";
import { icon, type IconName } from "./icons";
import { showsExitCode } from "./run-words";

export const STATUS_WORD: Record<RunStatus, string> = {
  ok: "Finished",
  error: "Error",
  "build-failed": "Build failed",
  timeout: "Time limit reached",
  "output-limit": "Output limit reached",
  stopped: "Stopped",
  crashed: "Crashed",
  unavailable: "Couldn't start",
};

const STATUS_TONE: Record<RunStatus, "success" | "danger" | "warning"> = {
  ok: "success",
  error: "danger",
  "build-failed": "danger",
  timeout: "warning",
  "output-limit": "warning",
  stopped: "warning",
  crashed: "danger",
  unavailable: "danger",
};

const TONE_ICON: Record<"success" | "danger" | "warning", IconName> = { success: "check-circle", danger: "x-circle", warning: "warning" };

/** Runs that failed: the header gets the error band, and Run steps back until the next edit or run. */
export const FAILED: ReadonlySet<RunStatus> = new Set<RunStatus>(["error", "build-failed", "crashed", "unavailable"]);

export function statusWord(r: Pick<RunResult, "status" | "exitCode">): string {
  return r.status === "error" && r.exitCode !== null ? `Exited with code ${r.exitCode}` : STATUS_WORD[r.status];
}

export type PhaseState = RunPhase | "waiting" | "idle";

/**
 * A failed run's first error, lifted into the header as one button that opens its line (as its
 * Problems row does): "ZeroDivisionError: division by zero" and "calc.py, line 2".
 */
export interface LiftedError {
  /** The exception class (or "Error"), drawn at 600. */
  head: string;
  /** The rest of the message after the head. */
  rest: string;
  /** "calc.py, line 2". */
  where: string;
  open(): void;
}

/** Output blocks: a new one starts after a line ends past this size, or anywhere past the max. */
const BLOCK_CHARS = 8 * 1024;
const MAX_BLOCK_CHARS = 256 * 1024;

export class OutputView {
  readonly element: HTMLElement;
  readonly stdin: HTMLTextAreaElement;
  readonly console: HTMLPreElement;
  /** The run's phase while it runs (#run-status, data-phase), in the run-log header. */
  readonly status: HTMLElement;
  /** The panel bar's Input toggle (the workbench puts it there): shows the Input box. */
  readonly inputToggle: HTMLButtonElement;
  /** The Arguments row (#args-row) beside the Input text; args-field.ts fills it (a lazy chunk). */
  private readonly argsRow: HTMLElement;
  private argsStore: RunArgsStore | null = null;
  private argsChunk: Promise<ArgsField> | null = null;
  private argsField: ArgsField | null = null;
  /** The runnable file whose arguments the field shows (null: none, the row is hidden). */
  private argsPath: WsPath | null = null;
  private readonly stdinBox: HTMLElement;
  private readonly header: HTMLElement;
  private readonly fileName: HTMLElement;
  private readonly runArgs: HTMLElement;
  private readonly receipt: HTMLElement;
  private readonly liveForm: HTMLFormElement;
  private readonly liveField: HTMLInputElement;
  private readonly livePrompt: HTMLElement;
  private readonly endButton: HTMLButtonElement;
  /** The prompt's text in the log while the field below repeats it (see liftPrompt). */
  private promptTail: HTMLElement | null = null;
  /** The lifted exception's button in the header (after #receipt, so a phone gives it a full line). */
  private exception: HTMLElement | null = null;
  /** The error help under it (or under a crash's status), last in the header: see setHelp. */
  private help: { element: HTMLElement; describedBy: string } | null = null;
  /** "This file has no main(). Run lab1/main.c?", last in a failed build's header: see offerMain. */
  private offer: HTMLElement | null = null;
  /** The header's run: its file's name and arguments, and whether another file is open (see showRunOwner). */
  private runName = "";
  private otherFile = false;
  private readonly pack: HTMLElement;
  private readonly packText: HTMLElement;
  private readonly packProgress: HTMLProgressElement;
  private readonly packButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private pending: { stream: "stdout" | "stderr"; text: string }[] = [];
  private frame = 0;
  /** The block new output goes into (see flush), its size, and the last character written. */
  private block: HTMLElement | null = null;
  private blockChars = 0;
  private lastChar = "";
  /** Whether the view follows new output (the user hasn't scrolled up). */
  private stuck = true;
  private reply: ((line: string | null) => void) | null = null;
  private phase: PhaseState = "idle";
  private phaseLabel = "";
  private phaseStarted = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  onPackDownload: (() => void) | null = null;

  constructor() {
    this.stdin = h("textarea", {
      id: "stdin",
      class: "stdin-field",
      rows: "3",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      placeholder: "One value per line",
    });
    // The Arguments field (.claude/design/batch3/r.md), filled by args-field.ts once a file that can
    // run is open; hidden until then.
    this.argsRow = h("div", { class: "args-row", id: "args-row" });
    this.argsRow.hidden = true;
    this.stdinBox = h(
      "div",
      { class: "stdin-box", id: "stdin-box" },
      h("div", { class: "stdin-col" }, h("label", { class: "stdin-label", for: "stdin" }, "Input given to the program first"), this.stdin),
      this.argsRow,
    );
    this.stdinBox.hidden = true;
    // Escape closes the box from inside it (the toggle then has the focus again).
    this.stdinBox.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      this.showInputBox(false);
    });
    this.inputToggle = h(
      "button",
      { type: "button", class: "btn ghost small input-toggle", id: "input-toggle", "aria-expanded": "false", "aria-controls": "stdin-box", title: "Arguments and text the program reads first" },
      icon("caret-right", "toggle-caret"),
      "Input",
    );
    this.inputToggle.addEventListener("click", () => this.showInputBox(this.inputToggle.getAttribute("aria-expanded") !== "true"));
    this.packText = h("p", { class: "pack-text" });
    this.packProgress = h("progress", { max: "1", value: "0", "aria-label": "C/C++ download" });
    this.packButton = h("button", { type: "button", class: "btn", id: "pack-download" });
    this.packButton.addEventListener("click", () => this.onPackDownload?.());
    this.pack = h("div", { class: "pack-offer", "data-pack": "" }, icon("download-simple", "pack-icon"), h("div", null, this.packText, this.packProgress), this.packButton);
    this.pack.hidden = true;

    // Focusable for reading once it has something to read (an empty log would be an invisible stop).
    this.console = h("pre", { class: "console", id: "console", role: "log", "aria-label": "Program output" });
    this.hint = h("p", { class: "console-hint" }, "Run a file to see its output here.");

    // The run-log header: one per run, above the log. #run-status and #receipt keep their ids and
    // data attributes; End input sits right after the waiting words.
    this.fileName = h("span", { class: "rl-file" });
    // The run's arguments after the file's name, as a terminal shows the command line.
    this.runArgs = h("span", { class: "rl-args", id: "run-args" });
    this.status = h("p", { class: "run-status", id: "run-status", "data-phase": "idle" });
    this.endButton = h("button", { type: "button", class: "end-input", id: "live-input-end", title: "Send end of input (Ctrl+D)" }, "End input");
    this.endButton.hidden = true;
    this.endButton.addEventListener("click", () => this.send(null));
    this.receipt = h("div", { class: "receipt", id: "receipt" });
    this.receipt.hidden = true;
    this.header = h("div", { class: "runlog", id: "runlog" }, this.fileName, this.status, this.endButton, this.receipt);
    this.header.hidden = true;

    // The field joins the prompt's line. Its name is the prompt the program printed (the visible
    // label, so it comes first: WCAG 2.5.3) and "Input for the program".
    this.livePrompt = h("span", { class: "live-prompt", id: "live-prompt", "aria-hidden": "true" });
    this.liveField = h("input", {
      id: "live-input-field",
      class: "live-field",
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "send",
      "aria-labelledby": "live-prompt live-label",
    });
    const send = h("button", { type: "submit", class: "icon-btn small live-send", "aria-label": "Send", title: "Send (Enter)" }, icon("paper-plane-right"));
    this.liveForm = h(
      "form",
      { class: "live-input", id: "live-input" },
      h("span", { class: "visually-hidden", id: "live-label" }, "Input for the program"),
      h("div", { class: "live-row" }, this.livePrompt, this.liveField, send, h("span", { class: "live-hint" }, "Enter sends. Ctrl+D ends input.")),
    );
    this.liveForm.hidden = true;
    this.liveForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.send(this.liveField.value);
    });
    this.liveField.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault(); // Ctrl+D = end of input, like a terminal
        this.send(null);
      }
    });

    const scroller = h("div", { class: "console-scroll", id: "console-scroll" }, this.hint, this.console, this.liveForm);
    // Following the output is decided when the user scrolls, not by measuring before every append
    // (that measurement laid the whole console out again on every frame of a flood).
    scroller.addEventListener("scroll", () => {
      this.stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }, { passive: true });
    this.element = h("div", { class: "output-view" }, this.stdinBox, this.pack, this.header, scroller);
  }

  /**
   * Opens or closes the Input box (the panel bar's Input toggle). Closed with the caret inside it
   * (Escape, or a run starting with nothing typed), the focus goes back to the toggle rather than
   * to the page. The workbench moves the caret into a box the toggle opened (it opens the panel first).
   */
  showInputBox(open: boolean): void {
    const inside = this.stdinBox.contains(document.activeElement);
    this.stdinBox.hidden = !open;
    this.inputToggle.setAttribute("aria-expanded", String(open));
    if (!open && inside) this.inputToggle.focus();
  }

  // ------------------------------------------------------------------ the Arguments field

  /** Where each file's arguments are kept (set once the workspace is open). */
  useArgs(store: RunArgsStore): void {
    this.argsStore = store;
  }

  /** The Arguments field's chunk, loaded once (a failed load is tried again next time). */
  private loadArgs(): Promise<ArgsField> {
    this.argsChunk ??= import("./args-field").then(
      ({ ArgsField }) => {
        const field = new ArgsField(this.argsRow, this.argsStore);
        field.show(this.argsPath);
        return (this.argsField = field);
      },
      (e: unknown) => {
        this.argsChunk = null;
        throw e;
      },
    );
    return this.argsChunk;
  }

  /** The field shows the arguments of the open file, and only for a file that can run. */
  showArgsFor(path: WsPath | null): void {
    this.argsPath = path !== null && detectLanguage(nameOf(path)) ? path : null;
    if (this.argsField) this.argsField.show(this.argsPath);
    else if (this.argsPath !== null) void this.loadArgs().catch(() => {}); // Run tries again and says so
  }

  /** A file or folder was renamed (`to`) or deleted (null): its arguments follow it or go. */
  argsMoved(from: WsPath, to: WsPath | null): void {
    const path = this.argsPath;
    if (path !== null && (path === from || path.startsWith(`${from}/`))) this.argsPath = to === null ? null : to + path.slice(from.length);
    this.argsField?.moved(from, to);
  }

  /** The arguments for a run of `path` (loads the field's chunk if needed). */
  async argsFor(path: WsPath): Promise<RunArgs> {
    return (await this.loadArgs()).argsFor(path);
  }

  /**
   * Run was pressed with arguments that can't be split: the box opens and the field explains (see
   * ArgsField.explain). Returns true when focus was already in the field, so the caller says it.
   */
  explainArgs(reason: string): boolean {
    this.showInputBox(true);
    return this.argsField?.explain(reason) ?? false;
  }

  // ------------------------------------------------------------------ console text

  clear(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = [];
    this.console.replaceChildren();
    this.console.removeAttribute("tabindex");
    this.block = null;
    this.blockChars = 0;
    this.lastChar = "";
    this.stuck = true;
    this.promptTail = null;
    this.receipt.hidden = true;
    this.receipt.replaceChildren();
    delete this.receipt.dataset.status;
    this.exception?.remove();
    this.exception = null;
    this.setHelp(null);
    this.offerMain(null);
    // A run still going keeps its header (its state words); a finished one's goes with its output.
    if (this.phase === "idle") {
      this.header.hidden = true;
      this.header.removeAttribute("data-failed");
      this.header.removeAttribute("data-other");
      this.fileName.textContent = "";
      this.runName = "";
      this.otherFile = false;
    }
    this.hint.hidden = false;
  }

  /** Program output; batched per frame so a printing loop doesn't relayout on every line. */
  write(stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    this.pending.push({ stream, text });
    this.frame ||= requestAnimationFrame(() => this.flush());
  }

  /**
   * The element new console content goes into. Output is kept in blocks of about BLOCK_CHARS
   * (layout-contained, see .out-block in app.css), started only after a line ends, so appending
   * lays out the last block alone, however much the program printed before.
   */
  private target(): HTMLElement {
    if (!this.block || (this.blockChars >= BLOCK_CHARS && this.lastChar === "\n") || this.blockChars >= MAX_BLOCK_CHARS) {
      this.block = h("span", { class: "out-block" });
      this.blockChars = 0;
      this.console.append(this.block);
    }
    return this.block;
  }

  private appended(text: string): void {
    this.blockChars += text.length;
    this.lastChar = text.slice(-1);
    if (!this.console.hasAttribute("tabindex")) this.console.tabIndex = 0;
  }

  flush(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!this.pending.length) return;
    this.hint.hidden = true;
    for (const chunk of this.pending) {
      const block = this.target();
      const last = block.lastElementChild;
      if (last instanceof HTMLElement && last.dataset.stream === chunk.stream && last.lastChild instanceof Text) last.lastChild.appendData(chunk.text);
      else block.append(h("span", { class: chunk.stream === "stderr" ? "err" : "out", "data-stream": chunk.stream }, chunk.text));
      this.appended(chunk.text);
    }
    this.pending = [];
    if (this.stuck) {
      const scroller = this.console.parentElement!;
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  /** A plain sentence about the run (not program output): RunResult.message, skipped files. */
  note(text: string, tone: "info" | "warning" = "info"): void {
    this.flush();
    this.hint.hidden = true;
    const block = this.target();
    if (this.lastChar && this.lastChar !== "\n") {
      block.append("\n");
      this.appended("\n");
    }
    block.append(h("span", { class: `note ${tone}`, "data-stream": "note" }, icon(tone === "warning" ? "warning" : "info"), ` ${text}\n`));
    this.appended(` ${text}\n`);
  }

  private echo(text: string, end: boolean): void {
    this.flush();
    this.target().append(h("span", { class: end ? "echo end" : "echo", "data-stream": "echo" }, text));
    this.appended(text);
  }

  // ------------------------------------------------------------------ run state

  /** A run starts: an empty log, and the header with the file's name, its arguments and the run's state. */
  begin(file = "", args = ""): void {
    this.clear();
    if (!this.stdin.value && !this.argsField?.hasText) this.showInputBox(false);
    this.hint.hidden = true;
    this.runArgs.textContent = args;
    this.runName = file;
    this.otherFile = false;
    this.renderFile();
    this.header.removeAttribute("data-failed");
    this.header.hidden = false;
    clearInterval(this.tick);
    this.tick = setInterval(() => this.renderPhase(), 100);
  }

  /** The header's first item: the run's file and arguments, after "Last run:" when another file is open. */
  private renderFile(): void {
    const owner = this.otherFile ? [h("span", { class: "rl-owner" }, "Last run:"), " "] : [];
    this.fileName.replaceChildren(...owner, this.runName, ...(this.runArgs.textContent ? [" ", this.runArgs] : []));
    this.header.toggleAttribute("data-other", this.otherFile);
  }

  /**
   * After a run, the header names the file it belongs to: `name` (it follows a rename), with
   * "Last run:" before it while another file is open (B11, 2026-10-24: a never-run file showed
   * util.c's "Build failed" as if it were its own).
   */
  showRunOwner(name: string, other: boolean): void {
    if (this.phase !== "idle" || this.header.hidden || (name === this.runName && other === this.otherFile)) return;
    this.runName = name;
    this.otherFile = other;
    this.renderFile();
  }

  /**
   * The run's state. The time shown counts from the start of the phase; it goes on counting while
   * the label changes within one phase (a download's bytes) and between starting and downloading,
   * which are one wait for the student.
   */
  setPhase(phase: PhaseState, label: string): void {
    const startup = (p: PhaseState) => p === "booting" || p === "downloading";
    if (phase !== this.phase && !(startup(phase) && startup(this.phase))) this.phaseStarted = performance.now();
    this.phase = phase;
    this.phaseLabel = label;
    this.renderPhase();
  }

  private renderPhase(): void {
    this.status.dataset.phase = this.phase;
    if (this.phase === "idle") {
      this.status.replaceChildren();
      return;
    }
    // Waiting: "Waiting for input (timer paused)", the time limit doesn't count while it waits.
    const waiting = this.phase === "waiting";
    const seconds = waiting ? "" : `${((performance.now() - this.phaseStarted) / 1000).toFixed(1)} s`;
    this.status.replaceChildren(
      icon(waiting ? "keyboard" : "arrow-clockwise", "rl-icon"),
      h("span", { class: "phase-label" }, this.phaseLabel),
      waiting ? h("span", { class: "rl-muted" }, "(timer paused)") : "",
      seconds ? h("span", { class: "phase-time" }, seconds) : "",
    );
  }

  /** The program waits for a line: show the field on the prompt's line and put the cursor in it. */
  waitInput(reply: (line: string | null) => void): void {
    this.flush();
    this.reply = reply;
    const prompt = this.liftPrompt();
    this.livePrompt.textContent = prompt;
    this.livePrompt.hidden = !prompt;
    this.liveForm.hidden = false;
    this.endButton.hidden = false;
    this.liveField.value = "";
    this.liveField.focus({ preventScroll: true });
    this.liveForm.scrollIntoView({ block: "nearest" });
  }

  /**
   * The prompt the program just printed ("Name: ", the log's last line, with no newline yet) moves
   * onto the input line: it stays in the log, for screen readers and in order, but is drawn only
   * once, before the field, until the answer is echoed after it (endInput shows it again).
   */
  private liftPrompt(): string {
    const last = this.block?.lastElementChild;
    if (!(last instanceof HTMLElement) || !(last.lastChild instanceof Text)) return "";
    if (last.dataset.stream !== "stdout" && last.dataset.stream !== "stderr") return "";
    const text = last.lastChild.data;
    const cut = text.lastIndexOf("\n") + 1;
    if (cut >= text.length) return "";
    const tail = cut > 0 ? last.lastChild.splitText(cut) : last.lastChild;
    const span = h("span", { class: "prompt-tail lifted" });
    tail.replaceWith(span);
    span.append(tail);
    this.promptTail = span;
    return tail.data;
  }

  get waiting(): boolean {
    return this.reply !== null;
  }

  private send(line: string | null): void {
    const reply = this.reply;
    if (!reply) return;
    // Echo what was typed after the program's prompt, the way a terminal shows it (first, so the
    // console has content to take the focus from the field).
    this.echo(line === null ? "(end of input)\n" : `${line}\n`, line === null);
    this.endInput();
    reply(line === null ? null : `${line}\n`);
  }

  endInput(): void {
    const active = document.activeElement;
    const hadFocus = this.liveForm.contains(active) || active === this.endButton;
    this.reply = null;
    this.liveForm.hidden = true;
    this.endButton.hidden = true;
    // The prompt is drawn in the log again, now with the answer echoed after it.
    this.promptTail?.classList.remove("lifted");
    this.promptTail = null;
    if (hadFocus) this.console.focus({ preventScroll: true });
  }

  /**
   * The header after a run: status icon and word, exit code, build and run times; after a failure
   * the error band and the lifted exception. The duplicate chips of v1 ("error output above") are
   * gone: the log's bars and its one danger-coloured line show the error output. `errorLine` is the
   * lifted error's own line in the log (a failed build writes one per compiler error): that line is
   * the danger one; without it, the last stderr line is (Python's exception, under its traceback).
   */
  finish(result: RunResult, lifted: LiftedError | null = null, errorLine?: string): void {
    clearInterval(this.tick);
    this.flush();
    this.endInput();
    this.setPhase("idle", "");
    const failed = FAILED.has(result.status);
    if (failed) this.markError(errorLine);
    const tone = STATUS_TONE[result.status];
    const parts: HTMLElement[] = [h("span", { class: `rl-status ${tone}`, "data-status-chip": result.status }, icon(TONE_ICON[tone]), statusWord(result))];
    const fact = (text: string) => h("span", { class: "rl-fact" }, text);
    if (showsExitCode(result)) parts.push(fact(`exit code ${result.exitCode}`));
    if (result.ms.build !== undefined) parts.push(fact(`built in ${formatMs(result.ms.build)}`));
    if (result.ms.run !== undefined) parts.push(fact(`ran in ${formatMs(result.ms.run)}`));
    this.receipt.dataset.status = result.status;
    this.receipt.replaceChildren(...parts);
    this.receipt.hidden = false;
    this.exception?.remove();
    this.exception = failed && lifted ? this.exceptionButton(lifted) : null;
    if (this.exception) this.header.append(this.exception);
    this.setHelp(null);
    this.offerMain(null);
    this.header.toggleAttribute("data-failed", failed);
    this.header.hidden = false;
    this.hint.hidden = true;
  }

  /** The lifted exception: its own danger icon and edge; the words in --text, the place secondary. */
  private exceptionButton(l: LiftedError): HTMLButtonElement {
    const button = h(
      "button",
      { type: "button", class: "exc", id: "run-exception", title: `Go to ${l.where}` },
      icon("x-circle", "exc-icon"),
      h("span", { class: "exc-what" }, h("span", { class: "exc-class" }, l.head), l.rest),
      h("span", { class: "exc-where" }, l.where),
      icon("arrow-right", "exc-go"),
    );
    button.addEventListener("click", () => l.open());
    return button;
  }

  /**
   * The lifted exception follows its error after the run: new words when its file was renamed, or
   * gone when the file was deleted or the error is no longer in the build's results. Only a failed
   * run's header has one to change.
   */
  relift(lifted: LiftedError | null): void {
    if (!this.exception) return;
    const hadFocus = this.exception.contains(document.activeElement);
    const next = lifted ? this.exceptionButton(lifted) : null;
    if (next) this.exception.replaceWith(next);
    else this.exception.remove();
    this.exception = next;
    // The help explains that error: it goes with it, and follows it to the new button.
    if (!next) this.setHelp(null);
    else this.describeException();
    if (hadFocus) (next ?? this.console).focus();
  }

  /**
   * The plain-language help for the failed run's error (error-help-view.ts, a lazy chunk), as the
   * header's last line, under the lifted exception (or under a crash's status, which has no
   * place to open). The exception button takes its words (`describedBy`) as its description.
   * null removes it.
   */
  setHelp(help: { element: HTMLElement; describedBy: string } | null): void {
    this.help?.element.remove();
    this.help = help;
    if (help) this.header.append(help.element);
    this.describeException();
  }

  /**
   * A failed build of a file without main() whose folder has a program with one (B13): "This file
   * has no main()." and a button "Run lab1/main.c" as the header's last line. The button is a
   * tertiary underlined text button, like End input (one filled action per band). null removes it.
   */
  offerMain(offer: { path: string; run(): void } | null): void {
    const hadFocus = this.offer?.contains(document.activeElement) ?? false;
    this.offer?.remove();
    this.offer = null;
    if (offer) {
      const button = h("button", { type: "button", class: "rl-link", id: "run-offer-button" }, `Run ${offer.path}`);
      button.addEventListener("click", () => offer.run());
      this.offer = h("p", { class: "run-offer", id: "run-offer" }, icon("info", "rl-icon"), h("span", null, "This file has no main()."), button);
      this.header.append(this.offer);
    } else if (hadFocus && this.console.hasAttribute("tabindex")) {
      this.console.focus();
    }
  }

  private describeException(): void {
    if (!this.exception) return;
    if (this.help) this.exception.setAttribute("aria-describedby", this.help.describedBy);
    else this.exception.removeAttribute("aria-describedby");
  }

  /**
   * Marks one stderr line of a failed run to be drawn in the danger colour at 600, the rest of the
   * log (traceback frames, other errors) in its own colour: the first line reading exactly `line`
   * (the lifted error's), or else the last stderr line (the exception, or the compiler's last error).
   */
  private markError(line?: string): void {
    if (line) {
      for (const err of this.console.querySelectorAll(".err")) {
        for (const node of err.childNodes) {
          if (!(node instanceof Text)) continue;
          for (let at = node.data.indexOf(line); at >= 0; at = node.data.indexOf(line, at + 1)) {
            const end = at + line.length;
            if ((at === 0 || node.data[at - 1] === "\n") && (end === node.data.length || node.data[end] === "\n")) return this.markRange(node, at, end);
          }
        }
      }
    }
    let last: Element | null = null;
    for (let block = this.console.lastElementChild; block && !last; block = block.previousElementSibling) {
      const errs = block.querySelectorAll(".err");
      last = errs[errs.length - 1] ?? null;
    }
    const node = last?.lastChild;
    if (!(node instanceof Text)) return;
    const text = node.data;
    const end = text.endsWith("\n") ? text.length - 1 : text.length;
    const start = text.lastIndexOf("\n", end - 1) + 1;
    if (end > start) this.markRange(node, start, end);
  }

  /** Wraps characters `start` to `end` of a log text node in the danger line's span. */
  private markRange(node: Text, start: number, end: number): void {
    const line = start > 0 ? node.splitText(start) : node;
    if (end - start < line.data.length) line.splitText(end - start);
    const mark = h("span", { class: "err-last" });
    line.replaceWith(mark);
    mark.append(line);
  }

  /** Couldn't even start a run (a thrown error): say why in the header. */
  fail(message: string): void {
    clearInterval(this.tick);
    this.flush();
    this.endInput();
    this.setPhase("idle", "");
    this.exception?.remove();
    this.exception = null;
    this.setHelp(null);
    this.receipt.dataset.status = "unavailable";
    this.receipt.replaceChildren(h("span", { class: "rl-status danger", "data-status-chip": "unavailable" }, icon("x-circle"), "Couldn't run"), h("span", { class: "rl-fact" }, message));
    this.receipt.hidden = false;
    this.header.toggleAttribute("data-failed", true);
    this.header.hidden = false;
  }

  /**
   * Puts keyboard focus where the output is (Ctrl+`): the input field if the program waits, else
   * the console once it has text. Returns false when there is nothing to focus yet.
   */
  focus(): boolean {
    if (this.reply) this.liveField.focus();
    else if (this.console.hasAttribute("tabindex")) this.console.focus();
    else return false;
    return true;
  }

  // ------------------------------------------------------------------ the C/C++ pack

  /**
   * The C/C++ download offer. `then`: the file Run was pressed for, which runs once the download
   * finishes (B10, 2026-10-24), said while it downloads.
   */
  showPack(view: { state: "offer" | "downloading" | "failed" | "hidden"; loaded: number; total: number; error?: string; then?: string }): void {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    this.pack.hidden = view.state === "hidden";
    this.pack.dataset.state = view.state;
    if (view.state === "hidden") return;
    const downloading = view.state === "downloading";
    this.packProgress.hidden = !downloading;
    // The button goes while it downloads: a focused button hands the focus to the words, which say
    // how far it got (a hidden button would drop the focus to the page).
    if (downloading && this.packButton.contains(document.activeElement)) {
      this.packText.tabIndex = -1;
      this.packText.focus({ preventScroll: true });
    }
    this.packButton.hidden = downloading;
    if (downloading) {
      this.packProgress.value = view.total ? view.loaded / view.total : 0;
      this.packText.textContent = `Downloading the C/C++ compiler: ${mb(view.loaded)} of ${mb(view.total)} MB. Keep this page open.${view.then ? ` ${view.then} runs when it finishes.` : ""}`;
    } else if (view.state === "failed") {
      this.packText.textContent = `The download stopped (${view.error ?? "connection lost"}). Check the connection and try again; finished parts are kept.`;
      this.packButton.textContent = "Try again";
    } else {
      this.packText.textContent = `C and C++ need a one-time ${mb(view.total)} MB download. After that they run offline, like Python.`;
      this.packButton.textContent = `Download C/C++ (${mb(view.total)} MB)`;
    }
  }

  /** Whether the keyboard focus is in the download offer (it goes once the pack is in). */
  packHasFocus(): boolean {
    return this.pack.contains(document.activeElement);
  }

  /** Whether the download offer is hidden (a focused element inside it can stay activeElement for a moment). */
  get packHidden(): boolean {
    return this.pack.hidden === true;
  }

  focusPackButton(): void {
    this.packButton.focus({ preventScroll: true });
    this.pack.scrollIntoView({ block: "nearest" });
  }
}
