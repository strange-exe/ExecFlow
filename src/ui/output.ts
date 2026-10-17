// The Output view (Pocket Run pattern): an Input box for text given up front, the program's output
// as a role="log" console, the inline field the program reads from while it waits, the receipt
// line after each run, and the one-time C/C++ download offer. stderr is drawn in the danger colour
// AND with a bar beside each line, and the receipt names it, so colour is never the only signal.
import type { RunPhase, RunResult, RunStatus } from "../core/types";
import { formatMs, h } from "./dom";
import { icon, type IconName } from "./icons";

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

export function statusWord(r: Pick<RunResult, "status" | "exitCode">): string {
  return r.status === "error" && r.exitCode !== null ? `Exited with code ${r.exitCode}` : STATUS_WORD[r.status];
}

export type PhaseState = RunPhase | "waiting" | "idle";

/** Output blocks: a new one starts after a line ends past this size, or anywhere past the max. */
const BLOCK_CHARS = 8 * 1024;
const MAX_BLOCK_CHARS = 256 * 1024;

export class OutputView {
  readonly element: HTMLElement;
  readonly stdin: HTMLTextAreaElement;
  readonly console: HTMLPreElement;
  readonly status: HTMLElement;
  private readonly stdinBox: HTMLDetailsElement;
  private readonly receipt: HTMLElement;
  private readonly liveForm: HTMLFormElement;
  private readonly liveField: HTMLInputElement;
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
  private sawStderr = false;
  onPackDownload: (() => void) | null = null;

  constructor() {
    this.stdin = h("textarea", {
      id: "stdin",
      class: "stdin-field",
      rows: "3",
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      placeholder: "Text the program reads first, one value per line",
    });
    this.stdinBox = h(
      "details",
      { class: "stdin" },
      h("summary", null, icon("caret-right", "summary-caret"), h("span", null, "Input"), h("span", { class: "hint" }, "given to the program first")),
      h("label", { class: "visually-hidden", for: "stdin" }, "Program input, given first"),
      this.stdin,
    );
    this.packText = h("p", { class: "pack-text" });
    this.packProgress = h("progress", { max: "1", value: "0", "aria-label": "C/C++ download" });
    this.packButton = h("button", { type: "button", class: "btn", id: "pack-download" });
    this.packButton.addEventListener("click", () => this.onPackDownload?.());
    this.pack = h("div", { class: "pack-offer", "data-pack": "" }, icon("download-simple", "pack-icon"), h("div", null, this.packText, this.packProgress), this.packButton);
    this.pack.hidden = true;

    // Focusable for reading once it has something to read (an empty log would be an invisible stop).
    this.console = h("pre", { class: "console", id: "console", role: "log", "aria-label": "Program output" });
    this.hint = h("p", { class: "console-hint" }, "Run a file to see its output here.");
    this.receipt = h("div", { class: "receipt", id: "receipt" });
    this.receipt.hidden = true;

    this.liveField = h("input", {
      id: "live-input-field",
      class: "live-field",
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "send",
    });
    const send = h("button", { type: "submit", class: "btn" }, icon("paper-plane-right"), "Send");
    const end = h("button", { type: "button", class: "btn", id: "live-input-end", title: "Send end of input (Ctrl+D)" }, "End input", h("kbd", { class: "keycap" }, "Ctrl D"));
    this.liveForm = h(
      "form",
      { class: "live-input", id: "live-input" },
      h("label", { class: "live-label", for: "live-input-field" }, "Input for the program"),
      h("div", { class: "live-row" }, this.liveField, send, end),
    );
    this.liveForm.hidden = true;
    this.liveForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.send(this.liveField.value);
    });
    end.addEventListener("click", () => this.send(null));
    this.liveField.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault(); // Ctrl+D = end of input, like a terminal
        this.send(null);
      }
    });

    this.status = h("p", { class: "run-status", id: "run-status", "data-phase": "idle" });
    const scroller = h("div", { class: "console-scroll", id: "console-scroll" }, this.hint, this.console, this.liveForm, this.receipt);
    // Following the output is decided when the user scrolls, not by measuring before every append
    // (that measurement laid the whole console out again on every frame of a flood).
    scroller.addEventListener("scroll", () => {
      this.stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }, { passive: true });
    this.element = h("div", { class: "output-view" }, this.stdinBox, this.pack, scroller);
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
    this.receipt.hidden = true;
    this.receipt.replaceChildren();
    delete this.receipt.dataset.status;
    this.hint.hidden = false;
    this.sawStderr = false;
  }

  /** Program output; batched per frame so a printing loop doesn't relayout on every line. */
  write(stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    if (stream === "stderr") this.sawStderr = true;
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

  begin(): void {
    this.clear();
    if (!this.stdin.value) this.stdinBox.open = false;
    this.hint.hidden = true;
    clearInterval(this.tick);
    this.tick = setInterval(() => this.renderPhase(), 100);
  }

  setPhase(phase: PhaseState, label: string): void {
    this.phase = phase;
    this.phaseLabel = label;
    this.phaseStarted = performance.now();
    this.renderPhase();
  }

  private renderPhase(): void {
    this.status.dataset.phase = this.phase;
    if (this.phase === "idle") {
      this.status.replaceChildren();
      return;
    }
    const seconds = this.phase === "waiting" ? "" : `${((performance.now() - this.phaseStarted) / 1000).toFixed(1)} s`;
    this.status.replaceChildren(h("span", { class: "phase-label" }, this.phaseLabel), seconds ? h("span", { class: "phase-time" }, seconds) : "");
  }

  /** The program waits for a line: show the field and put the cursor in it. */
  waitInput(reply: (line: string | null) => void): void {
    this.flush();
    this.reply = reply;
    this.liveForm.hidden = false;
    this.liveField.value = "";
    this.liveField.focus({ preventScroll: true });
    this.liveForm.scrollIntoView({ block: "nearest" });
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
    const hadFocus = this.liveForm.contains(document.activeElement);
    this.reply = null;
    this.liveForm.hidden = true;
    if (hadFocus) this.console.focus({ preventScroll: true });
  }

  finish(result: RunResult): void {
    clearInterval(this.tick);
    this.flush();
    this.endInput();
    this.setPhase("idle", "");
    const tone = STATUS_TONE[result.status];
    const chips: HTMLElement[] = [h("span", { class: `chip ${tone}`, "data-status-chip": result.status }, icon(TONE_ICON[tone]), statusWord(result))];
    if (result.exitCode !== null && !(result.status === "error")) chips.push(h("span", { class: "fact" }, `exit code ${result.exitCode}`));
    if (result.ms.build !== undefined) chips.push(h("span", { class: "fact" }, `built in ${formatMs(result.ms.build)}`));
    if (result.ms.run !== undefined) chips.push(h("span", { class: "fact" }, `ran in ${formatMs(result.ms.run)}`));
    if (this.sawStderr) chips.push(h("span", { class: "chip danger subtle" }, icon("warning"), "error output above"));
    this.receipt.dataset.status = result.status;
    this.receipt.replaceChildren(...chips);
    this.receipt.hidden = false;
    this.hint.hidden = true;
    this.receipt.scrollIntoView({ block: "nearest" });
  }

  /** Couldn't even start a run (a thrown error): say why in the receipt. */
  fail(message: string): void {
    clearInterval(this.tick);
    this.flush();
    this.endInput();
    this.setPhase("idle", "");
    this.receipt.dataset.status = "unavailable";
    this.receipt.replaceChildren(h("span", { class: "chip danger" }, icon("x-circle"), "Couldn't run"), h("span", { class: "fact" }, message));
    this.receipt.hidden = false;
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

  showPack(view: { state: "offer" | "downloading" | "failed" | "hidden"; loaded: number; total: number; error?: string }): void {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    this.pack.hidden = view.state === "hidden";
    this.pack.dataset.state = view.state;
    if (view.state === "hidden") return;
    const downloading = view.state === "downloading";
    this.packProgress.hidden = !downloading;
    this.packButton.hidden = downloading;
    if (downloading) {
      this.packProgress.value = view.total ? view.loaded / view.total : 0;
      this.packText.textContent = `Downloading the C/C++ compiler: ${mb(view.loaded)} of ${mb(view.total)} MB. Keep this page open.`;
    } else if (view.state === "failed") {
      this.packText.textContent = `The download stopped (${view.error ?? "connection lost"}). Check the connection and try again; finished parts are kept.`;
      this.packButton.textContent = "Try again";
    } else {
      this.packText.textContent = `C and C++ need a one-time ${mb(view.total)} MB download. After that they run offline, like Python.`;
      this.packButton.textContent = `Download C/C++ (${mb(view.total)} MB)`;
    }
  }

  focusPackButton(): void {
    this.packButton.focus({ preventScroll: true });
    this.pack.scrollIntoView({ block: "nearest" });
  }
}
