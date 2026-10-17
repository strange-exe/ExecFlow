// Tool diagnostics (core/types.ts ToolDiagnostic) to CodeMirror lint diagnostics.
//
// Every diagnostic set goes through mergeSource: @codemirror/lint's setDiagnostics replaces a
// state's whole set, so a second producer (a later lint source or language server) would silently
// wipe the compiler's errors unless one function merges them. Nothing else calls setDiagnostics.
//
// Messages come from compilers, Python and the user's own programs: they are shown as text
// (renderMessage builds DOM nodes with textContent, never HTML), with terminal colour codes,
// control and text-direction characters removed.

import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorState, Text, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { BIDI_CONTROL } from "../core/safety";
import type { DiagSeverity, ToolDiagnostic, ToolLocation, WsPath } from "../core/types";
import { clampLine, toOffset } from "./positions";

export type Severity = Diagnostic["severity"];

/** Shown before every message, so severity is never conveyed by colour alone (WCAG 1.4.1). */
export const SEVERITY_WORD: Readonly<Record<Severity, string>> = { error: "Error", warning: "Warning", info: "Info", hint: "Hint" };

/** A lint diagnostic as this module makes it: plain lint fields plus where it came from. */
export interface EditorDiagnostic extends Diagnostic {
  /** The producer that set it ("build", "run", ...); mergeSource replaces one channel at a time. */
  channel?: string;
  /** The tool's own report, kept so a closed file's diagnostics can be stored and applied again. */
  raw?: ToolDiagnostic;
}

/** core severities are CodeMirror's; anything unexpected (worker data) is shown as an error. */
export function cmSeverity(severity: DiagSeverity): Severity {
  return severity === "warning" || severity === "info" || severity === "hint" ? severity : "error";
}

const MAX_MESSAGE = 4000;
const MAX_NOTES = 20;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const BIDI = new RegExp(BIDI_CONTROL.source, "g");

/** Text safe to show: no colour codes, control characters (tab and line feed stay) or bidi controls. */
export function cleanText(text: string, max = MAX_MESSAGE): string {
  const stripped = String(text).replace(ANSI, "").replace(BIDI, "");
  let out = "";
  for (const ch of stripped.length > max ? stripped.slice(0, max) : stripped) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || (c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f))) out += ch;
  }
  return stripped.length > max ? out + "..." : out;
}

function noteWhere(note: ToolLocation, own: WsPath | null): string {
  if (note.path == null) return "";
  return note.path === own ? ` (line ${note.line})` : ` (${cleanText(note.path, 300)}:${note.line})`;
}

/** The message with the tool's notes appended, one per line ("note: ... (util.h:3)"). */
export function diagnosticMessage(d: ToolDiagnostic): string {
  let text = cleanText(d.message);
  const notes = d.notes ?? [];
  for (const note of notes.slice(0, MAX_NOTES)) text += `\nnote: ${cleanText(note.message)}${noteWhere(note, d.path)}`;
  if (notes.length > MAX_NOTES) text += `\n(${notes.length - MAX_NOTES} more notes)`;
  return text;
}

/** "clang -Wunused-variable", "python ZeroDivisionError", "wasm-ld, location estimated". */
export function sourceLabel(d: ToolDiagnostic): string {
  const label = cleanText([d.source, d.code].filter(Boolean).join(" "), 200);
  return d.heuristic ? `${label}, location estimated` : label;
}

function markClassOf(d: ToolDiagnostic): string {
  const source = String(d.source).toLowerCase().replace(/[^a-z0-9-]/g, "");
  return source ? `ce-diag ce-diag-${source}` : "ce-diag";
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/** End of the identifier or number that starts at `pos`, or null when none starts there. */
function wordEnd(doc: Text, pos: number): number | null {
  const line = doc.lineAt(pos);
  let i = pos - line.from;
  const start = i;
  while (i < line.length) {
    const ch = String.fromCodePoint(line.text.codePointAt(i)!);
    if (!WORD_CHAR.test(ch)) break;
    i += ch.length;
  }
  return i > start ? line.from + i : null;
}

function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}

function renderWithSeverity(view: EditorView, severity: Severity, message: string): Node {
  const doc = view.dom.ownerDocument;
  const root = doc.createElement("span");
  const word = doc.createElement("strong");
  word.className = "ce-diag-severity";
  word.textContent = SEVERITY_WORD[severity];
  root.append(word, doc.createTextNode(`: ${message}`));
  return root;
}

/**
 * The lint diagnostic for `d`, positioned on `doc` (the text the tool saw). Positions clamp to
 * the document. Without a column the whole line is marked (from its first non-space character);
 * with a column but no end, the word starting there, or else the rest of the line. `to >= from`.
 */
export function toCm(doc: Text, d: ToolDiagnostic): EditorDiagnostic {
  let from: number;
  let to: number;
  if (d.col == null) {
    const line = doc.line(clampLine(doc, d.line));
    from = line.from + leadingSpace(line.text);
    to = doc.line(clampLine(doc, d.endLine ?? d.line)).to;
  } else {
    from = toOffset(doc, d.line, d.col, d.unit, d.base);
    if (d.endCol != null) to = toOffset(doc, d.endLine ?? d.line, d.endCol, d.unit, d.base);
    else if (d.endLine != null) to = doc.line(clampLine(doc, d.endLine)).to;
    else to = wordEnd(doc, from) ?? doc.lineAt(from).to;
  }
  if (to < from) to = from;
  const severity = cmSeverity(d.severity);
  const message = diagnosticMessage(d);
  return {
    from,
    to,
    severity,
    message,
    source: sourceLabel(d),
    markClass: markClassOf(d),
    renderMessage: (view) => renderWithSeverity(view, severity, message),
    raw: d,
  };
}

/** Every diagnostic in `state` with its current (mapped) position. */
export function currentDiagnostics(state: EditorState): { diagnostic: EditorDiagnostic; from: number; to: number }[] {
  const out: { diagnostic: EditorDiagnostic; from: number; to: number }[] = [];
  forEachDiagnostic(state, (diagnostic, from, to) => out.push({ diagnostic, from, to }));
  return out;
}

/**
 * Replaces the diagnostics of one channel (`source`, e.g. "build") with `list` and keeps every
 * other channel's diagnostics at their current positions. `list` positions are clamped to the
 * document. The ONLY caller of setDiagnostics in the app: apply the returned spec to `state`.
 */
export function mergeSource(state: EditorState, source: string, list: readonly Diagnostic[]): TransactionSpec {
  const length = state.doc.length;
  const clamp = (pos: number) => (pos > 0 ? Math.min(Math.trunc(pos), length) : 0);
  const kept: Diagnostic[] = [];
  forEachDiagnostic(state, (d, from, to) => {
    if ((d as EditorDiagnostic).channel !== source) kept.push({ ...d, from, to });
  });
  const added = list.map((d): EditorDiagnostic => {
    const from = clamp(d.from);
    return { ...d, from, to: Math.max(from, clamp(d.to)), channel: source };
  });
  return setDiagnostics(state, [...kept, ...added]);
}
