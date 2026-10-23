// Save as PDF's CodeMirror part (.claude/design/pdf.md): each chosen file's lines as styled runs,
// from the same highlight style the editor paints with (snippet-render.ts styledLines reads
// highlight.ts), with the editor's special-character placeholders and trailing spaces trimmed, as
// the snippet image has them. An open file is read from its live state (unsaved typing included);
// any other file gets a state of its own with just its grammar. Wrapping is the print layout's
// (CSS), so nothing is ever cut at the page edge. Lazy: the print chunk.
import { cppLanguage } from "@codemirror/lang-cpp";
import { pythonLanguage } from "@codemirror/lang-python";
import { EditorState } from "@codemirror/state";
import { editorLanguage } from "../core/languages";
import { nameOf } from "../core/paths";
import { markSpecials, styledLines, treeFor, trimRuns, type StyledLine } from "./snippet-render";

/** One task later (a posted message, as snippet-canvas.ts nextTask: timers are throttled in hidden pages). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export interface PrintSource {
  readonly path: string;
  readonly text: string;
  /** The open file's live state, when it is open (its parse is likely done already). */
  readonly state: EditorState | null;
}

export interface PrintedFile {
  readonly path: string;
  readonly lines: readonly StyledLine[];
  readonly tabSize: number;
  /** The parse didn't reach the end within the budget: some colours are missing. */
  readonly partial: boolean;
}

/** The parse budget per file (the snippet image's), in 50 ms slices with a task between them. */
const PARSE_MS = 1000;

/** A state with the file's grammar only (no completion sources, nothing that loads more code). */
export function stateFor(path: string, text: string): EditorState {
  const lang = editorLanguage(nameOf(path));
  const grammar = lang === "python" ? pythonLanguage : lang ? cppLanguage : [];
  return EditorState.create({ doc: text, extensions: [grammar, EditorState.tabSize.of(4)] });
}

/** One file's lines, styled. A trailing newline makes no empty last line (the editor's last line is that empty line; paper doesn't need it). */
export async function printFile(source: PrintSource, yieldTask: () => Promise<void> = nextTask): Promise<PrintedFile> {
  const state = source.state ?? stateFor(source.path, source.text);
  const { tree, partial } = await treeFor(state, state.doc.length, PARSE_MS, yieldTask);
  let last = state.doc.lines;
  if (last > 1 && state.doc.line(last).length === 0) last--;
  const lines = styledLines(state, tree, 1, last).map((line) => ({ number: line.number, runs: trimRuns(markSpecials(line.runs)) }));
  return { path: source.path, lines, tabSize: state.tabSize, partial };
}
