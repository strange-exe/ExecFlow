// The inside of a code link's preview (code-link-dialog.ts): the shared file in a read-only editor,
// its flowchart, and a Run of its own, so a student can see how the code works before (or without)
// adding it to their files. Owner's pick, 2026-11-15: "Read-only editor view".
//
// - The editor is CodeMirror with the app's own look (line numbers, the language's highlighting),
//   read-only (EditorState.readOnly: focus, select and copy work, keys change nothing). It shows the
//   code as shown() tags it, so an invisible character can't hide in it; Run and the flowchart get
//   the real text, as the editor does once the file is added.
// - The flowchart comes from a flowchart worker of the previews' own (one per page, kept, so the
//   board's worker is never disturbed), drawn with the app's renderer: beside the code from 900 px,
//   behind a Code / Flowchart tab pair below that.
// - Run uses the page's one runtime (Runtimes), with the student's own limits and build settings,
//   on the shared file alone. What the program writes is dropped (result.written is never saved):
//   trying a file never adds or changes the student's files (PRODUCT.md principle 4). Output goes
//   to a small console of its own, with an input line when the program asks. C and C++ need their
//   one-time download first: the preview offers it where Run was pressed.
// State attributes for tests, on the dialog: data-run ("idle", "starting", "running", "waiting",
// "done") and, on the chart pane, data-state ("loading", "ready", "none", "failed").
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import type { SharedFile } from "../core/code-link";
import { detectLanguage } from "../core/languages";
import type { BuildOptions, LanguageId, RunLimits, RunResult } from "../core/types";
import { EXTRA_SPECIALS, READ_ONLY } from "../editor/extensions";
import { editorTheme, highlightStyle } from "../editor/highlight";
import { languageForPath, languageSupport, loadLanguage } from "../editor/language-support";
import { selectionLayer } from "../editor/selection-layer";
import { createFlowchartClient, type FlowchartClient } from "../flowchart/client";
import { pickOf, type Pick } from "../flowchart/pick";
import { renderChart } from "../flowchart/render";
import { h, shown } from "./dom";
import { icon } from "./icons";
import { statusWord } from "./output";
import { runtimeOf, type Runtimes } from "./run";
import { diagnosticLine } from "./run-diagnostics";
// The chart's own rules (rings, trace): loaded with the board, which may not have opened yet.
import "../styles/flowchart.css";

export interface PreviewDeps {
  /** The page's runtimes: one run at a time, the student's Run included. */
  readonly runtimes: Runtimes;
  /** The student's run limits and build options (Settings), read when Run is pressed. */
  runSettings(): { limits: RunLimits; build: BuildOptions };
}

export interface CodePreview {
  /** The Code / Flowchart tabs (shown below 900 px), the code and the chart. */
  readonly panes: HTMLElement;
  /** The run's console, input line and download offer (hidden until the first Run). */
  readonly runArea: HTMLElement;
  /** Run, then Stop while a run is on. */
  readonly runButton: HTMLButtonElement;
  /** The code view's focusable content: the dialog's first focus. */
  readonly code: HTMLElement;
  /** Shows `file` (a folder's other file); `files` are what a Run gets (the folder, or the file). */
  show(file: SharedFile, files: readonly SharedFile[]): void;
  /** Stops a run of its own, drops a chart still on its way, and destroys the editor. */
  dispose(): void;
}

/**
 * One flowchart worker for every preview in this page, created at the first chart and kept: closing
 * a preview mid-download would otherwise abort the grammar's fetch, and the next preview (Open again,
 * another link) would download it again. A closed preview's late answer is ignored (chartToken).
 */
let sharedClient: FlowchartClient | null = null;

/** Builds the preview's parts for `dialog` (which carries data-run); show() fills them with a file. */
export function createCodePreview(dialog: HTMLDialogElement, deps: PreviewDeps): CodePreview {
  const language = new Compartment();
  const label = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars({ addSpecialChars: EXTRA_SPECIALS }),
        drawSelection(),
        selectionLayer,
        highlightActiveLine(),
        EditorState.tabSize.of(4),
        READ_ONLY,
        syntaxHighlighting(highlightStyle),
        editorTheme,
        // tabindex: the code is the scroller's keyboard stop (axe counts a contenteditable without one
        // as nothing focusable, and the scroller then as a region the keyboard can't reach).
        EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false", tabindex: "0" }),
        language.of([]),
        label.of([]),
      ],
    }),
  });

  // ---------------------------------------------------------------- panes
  const codeTab = h("button", { type: "button", role: "tab", id: "code-link-tab-code", "aria-controls": "code-link-preview", "aria-selected": "true" }, "Code");
  const chartTab = h("button", { type: "button", role: "tab", id: "code-link-tab-chart", "aria-controls": "code-link-chart", "aria-selected": "false", tabindex: "-1" }, "Flowchart");
  const tabs = h("div", { class: "code-link-views", id: "code-link-views", role: "tablist", "aria-label": "Show" }, codeTab, chartTab);
  const codePane = h("div", { class: "code-link-code", id: "code-link-preview", role: "tabpanel", "aria-labelledby": "code-link-tab-code" }, view.dom);
  const chartNote = h("p", { class: "code-link-chart-note field-note" });
  const picker = h("select", { id: "code-link-function", "aria-label": "Function" });
  const pickRow = h("div", { class: "code-link-pick", hidden: true }, h("label", { for: "code-link-function" }, "Function"), picker);
  // A chart taller or wider than its pane scrolls: a keyboard stop of its own, so arrows can scroll it.
  const stage = h("div", { class: "code-link-stage", role: "region", "aria-label": "Flowchart", tabindex: "0" });
  const chartPane = h("div", { class: "code-link-chart", id: "code-link-chart", role: "tabpanel", "aria-labelledby": "code-link-tab-chart", "data-state": "loading" }, pickRow, chartNote, stage);
  const panes = h("div", { class: "code-link-panes", "data-show": "code" }, tabs, codePane, chartPane);
  const select = (which: "code" | "chart", focus: boolean) => {
    panes.dataset.show = which;
    codeTab.setAttribute("aria-selected", String(which === "code"));
    chartTab.setAttribute("aria-selected", String(which === "chart"));
    codeTab.tabIndex = which === "code" ? 0 : -1;
    chartTab.tabIndex = which === "chart" ? 0 : -1;
    if (focus) (which === "code" ? codeTab : chartTab).focus();
  };
  codeTab.addEventListener("click", () => select("code", false));
  chartTab.addEventListener("click", () => select("chart", false));
  // The tab pair's arrow keys (APG tabs pattern): either arrow moves to the other tab and shows it.
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    select(panes.dataset.show === "code" ? "chart" : "code", true);
  });

  // ---------------------------------------------------------------- flowchart
  let charted: { lang: LanguageId; text: string } | null = null;
  let chartToken = 0;
  const chartState = (state: string, note: string) => {
    chartPane.dataset.state = state;
    chartNote.textContent = note;
    chartNote.hidden = note === "";
    if (state !== "ready") stage.replaceChildren();
  };
  async function drawChart(pick: Pick | null) {
    const my = ++chartToken;
    if (!charted) return;
    chartState("loading", "Drawing the flowchart...");
    sharedClient ??= createFlowchartClient();
    const result = await sharedClient.chart(charted.lang, charted.text, pick);
    if (my !== chartToken) return;
    if (result.type === "superseded") return;
    if (result.type === "too-big") return chartState("none", `This file is too big for a flowchart: ${result.detail}.`);
    if (result.type !== "charts") return chartState("failed", "The flowchart couldn't be drawn. Add the file to your files to try again there.");
    const charts = result.file.charts;
    if (!charts.length) return chartState("none", "No functions in this file, so there is no flowchart.");
    const same = picker.options.length === charts.length && charts.every((c, i) => picker.options[i].textContent === c.name);
    if (!same) picker.replaceChildren(...charts.map((c, i) => h("option", { value: String(i) }, shown(c.name))));
    picker.value = String(result.picked);
    pickRow.hidden = charts.length < 2;
    const chart = charts[result.picked];
    if (!chart || chart.ok === null || !result.layout) return chartState("failed", "The flowchart couldn't be drawn.");
    if (!chart.ok) return chartState("none", `${chart.tooBig.replace(/^it /, "This function ")}, too many for a flowchart.`);
    chartState("ready", "");
    stage.replaceChildren(renderChart(chart, result.layout));
  }
  picker.addEventListener("change", () => {
    const charts = [...picker.options].map((o) => ({ name: o.textContent ?? "" }));
    void drawChart(pickOf(charts, Number(picker.value)));
  });

  // ---------------------------------------------------------------- run
  const runButton = h("button", { type: "button", class: "btn", id: "code-link-run" }, "Run");
  const out = document.createTextNode("");
  const consoleEl = h("pre", { class: "code-link-console", id: "code-link-console", role: "log", "aria-label": "Output", tabindex: "0" }, out);
  const status = h("p", { class: "code-link-status", id: "code-link-status", role: "status" });
  const stdin = h("input", { type: "text", id: "code-link-stdin", autocomplete: "off", spellcheck: "false", "aria-label": "Input for the program" });
  const inputRow = h("form", { class: "code-link-input", hidden: true }, h("label", { for: "code-link-stdin" }, "Input"), stdin, h("button", { type: "submit", class: "btn small" }, "Send"));
  const packText = h("p", { class: "code-link-pack-text" });
  const packButton = h("button", { type: "button", class: "btn small", id: "code-link-pack-download" }, "Download C/C++");
  const pack = h("div", { class: "code-link-pack", id: "code-link-pack", hidden: true }, packText, packButton);
  const runArea = h("section", { class: "code-link-run", "aria-label": "Run", hidden: true }, pack, consoleEl, inputRow, status);

  let files: readonly SharedFile[] = [];
  let entry: SharedFile = { name: "", text: "" };
  /** A run this preview started is on: Stop and closing stop it. */
  let mine = false;
  let unsubscribePack: (() => void) | null = null;
  const setRun = (state: "idle" | "starting" | "running" | "waiting" | "done") => {
    dialog.dataset.run = state;
    const on = state === "starting" || state === "running" || state === "waiting";
    runButton.replaceChildren(icon(on ? "stop-fill" : "play-fill"), on ? "Stop" : "Run");
    runButton.setAttribute("aria-pressed", String(on));
  };
  setRun("idle");
  const write = (text: string) => {
    // The run's own output cap bounds this; the console keeps the newest text in view.
    out.appendData(text);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  };

  async function runShared() {
    const lang = detectLanguage(entry.name)?.id;
    runArea.hidden = false;
    if (!lang) {
      status.textContent = `${shown(entry.name)} isn't a Python, C or C++ file, so it can't run.`;
      return;
    }
    if (deps.runtimes.running) {
      status.textContent = "Another program is running. Stop it first, then press Run here.";
      return;
    }
    if (runtimeOf(lang) === "cpp") {
      setRun("starting");
      status.textContent = "Getting C/C++ ready...";
      const cpp = (await deps.runtimes.loadCpp()).runner;
      if (cpp.state === "checking") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 10_000);
          const off = cpp.subscribe((s) => s !== "checking" && done());
          function done() {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      }
      if (!dialog.open) return;
      if (cpp.state === "unsupported") {
        setRun("idle");
        status.textContent = cpp.error;
        return;
      }
      if (cpp.state === "absent" || cpp.state === "downloading") {
        setRun("idle");
        status.textContent = "";
        showPack(cpp.state === "absent");
        return;
      }
    }
    pack.hidden = true;
    mine = true;
    setRun("running");
    out.data = "";
    status.textContent = lang === "python" ? "Running..." : "Compiling...";
    const { limits, build } = deps.runSettings();
    let result: RunResult;
    try {
      ({ result } = await deps.runtimes.run(
        { lang, entry: entry.name, files: files.map((f) => ({ path: f.name, text: f.text })), stdin: "", limits, build },
        {
          onOutput: (_stream, text) => write(text),
          onPhase: (phase) => {
            if (phase === "running") status.textContent = "Running...";
          },
          onInputRequest: () => {
            setRun("waiting");
            status.textContent = "Waiting for input.";
            inputRow.hidden = false;
            if (dialog.open) stdin.focus();
          },
        },
      ));
    } catch (e) {
      mine = false;
      inputRow.hidden = true;
      setRun("done");
      status.textContent = `Couldn't run: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    mine = false;
    inputRow.hidden = true;
    if (result.status === "build-failed") for (const d of result.diagnostics.slice(0, 50)) write(`${diagnosticLine(d)}\n`);
    // result.written is left out on purpose: nothing a shared program writes reaches the files.
    status.textContent = `${statusWord(result)}.${result.message ? ` ${result.message}` : ""}`;
    setRun("done");
    if (stdin === document.activeElement) runButton.focus();
  }

  /** The C/C++ one-time download, offered where Run was pressed; Run follows when it is in. */
  function showPack(focus: boolean) {
    const runner = deps.runtimes.cppRunner;
    if (!runner) return;
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    const render = () => {
      if (runner.state === "downloading") {
        packText.textContent = `Downloading the C/C++ compiler: ${mb(runner.progress.loaded)} of ${mb(runner.progress.total)} MB. ${shown(entry.name)} runs when it finishes.`;
        if (packButton.contains(document.activeElement)) {
          packText.tabIndex = -1;
          packText.focus({ preventScroll: true });
        }
        packButton.hidden = true;
      } else if (runner.state === "absent") {
        packText.textContent = runner.error
          ? `The download stopped (${runner.error}). Check the connection and try again; finished parts are kept.`
          : `C and C++ need a one-time ${mb(runner.progress.total)} MB download first. After that they run offline, here and in your files.`;
        packButton.textContent = runner.error ? "Try again" : `Download C/C++ (${mb(runner.progress.total)} MB)`;
        packButton.hidden = false;
      } else {
        // In: the offer goes, and the run the student asked for starts.
        unsubscribePack?.();
        unsubscribePack = null;
        pack.hidden = true;
        if (dialog.open && runner.state !== "failed") void runShared();
        else if (runner.state === "failed") status.textContent = `C/C++ couldn't start: ${runner.error}`;
      }
    };
    pack.hidden = false;
    unsubscribePack ??= runner.subscribe(render);
    render();
    if (focus) packButton.focus();
  }
  packButton.addEventListener("click", () => deps.runtimes.cppRunner?.download());

  runButton.addEventListener("click", (e) => {
    // One press, one run (the main Run's rule): a double click's second press does nothing.
    if (e.detail > 1) return;
    if (mine) return deps.runtimes.stop();
    if (dialog.dataset.run === "starting") return;
    void runShared();
  });
  inputRow.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!mine) return;
    const line = stdin.value;
    stdin.value = "";
    write(`${line}\n`);
    inputRow.hidden = true;
    setRun("running");
    status.textContent = "Running...";
    deps.runtimes.provideInput(`${line}\n`);
  });

  return {
    panes,
    runArea,
    runButton,
    code: view.contentDOM,
    show(file, all) {
      entry = file;
      files = all;
      const id = languageForPath(file.name);
      const lines = file.text === "" ? 0 : file.text.replace(/\n$/, "").split("\n").length;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: shown(file.text) },
        effects: [
          language.reconfigure(languageSupport(id)),
          label.reconfigure(EditorView.contentAttributes.of({ "aria-label": `Shared code, ${shown(file.name)} (read-only)`, "aria-describedby": "code-link-about" })),
        ],
      });
      codePane.dataset.lines = String(lines);
      // The grammar is a chunk of its own: plain text until it is here.
      void loadLanguage(id).then(
        () => entry === file && view.dispatch({ effects: language.reconfigure(languageSupport(id)) }),
        () => {},
      );
      charted = id ? { lang: id, text: file.text } : null;
      picker.replaceChildren();
      pickRow.hidden = true;
      if (!charted) chartState("none", "Flowcharts are for C, C++ and Python files.");
      else if (!file.text.trim()) chartState("none", "This file is empty, so there is no flowchart.");
      else void drawChart(null);
      runButton.hidden = !detectLanguage(file.name);
    },
    dispose() {
      chartToken++;
      if (mine) deps.runtimes.stop();
      unsubscribePack?.();
      view.destroy();
    },
  };
}
