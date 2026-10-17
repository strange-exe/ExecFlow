// Turns the diagnostics the worker's Python helper reports (JSON) into ToolDiagnostic, and checks
// diagnostics that arrive from the worker. Both inputs are untrusted: a program can print anything,
// forge worker messages, or make the helper misbehave, so every field is type-checked and clamped.
//
// The helper already converts every column to 0-based UTF-16 code units (CodeMirror's unit) with the
// source line in hand: parser SyntaxErrors count code points, compiler-stage SyntaxErrors and
// co_positions count UTF-8 bytes (see ce_runner research in the reuse map). So unit "utf16", base 0.

import type { DiagSeverity, ToolDiagnostic, ToolLocation, WsPath } from "../core/types";

export const MAX_DIAGNOSTICS = 100;
export const MAX_STACK = 50;
const MAX_MESSAGE = 4000;
const MAX_CODE = 100;
const SEVERITIES: readonly DiagSeverity[] = ["error", "warning", "info", "hint"];

type Loc = Omit<ToolLocation, "unit" | "base">;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : undefined;

/** A location, or null if it is unusable. `path` must be one of the run's files. */
function readLocation(o: Record<string, unknown>, known: ReadonlySet<WsPath>): Loc | null {
  const path = typeof o.path === "string" && known.has(o.path) ? o.path : null;
  const line = whole(o.line, 1);
  if (path === null || line === undefined) return null;
  const loc: Loc = { path, line };
  const col = whole(o.col, 0);
  if (col === undefined) return loc;
  loc.col = col;
  const endLine = whole(o.endLine, line) ?? line;
  const endCol = whole(o.endCol, 0);
  // An end before the start (or missing) becomes a point marker at the start.
  if (endCol === undefined || (endLine === line && endCol < col)) {
    loc.endLine = line;
    loc.endCol = col;
  } else {
    loc.endLine = endLine;
    loc.endCol = endCol;
  }
  return loc;
}

const located = (loc: Loc): ToolLocation => ({ ...loc, unit: "utf16", base: 0 });
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

function readDiagnostic(o: unknown, known: ReadonlySet<WsPath>): ToolDiagnostic | null {
  if (!isObject(o)) return null;
  const severity = SEVERITIES.find((s) => s === o.severity);
  const message = text(o.message, MAX_MESSAGE);
  if (!severity || message === undefined) return null;
  const stack = (Array.isArray(o.stack) ? o.stack.slice(-MAX_STACK) : [])
    .map((f) => (isObject(f) ? readLocation(f, known) : null))
    .filter((f): f is Loc => f !== null);
  // Where the problem is: the reported place if it is a workspace file, else the innermost
  // workspace frame, else the program as a whole.
  const where = readLocation(o, known) ?? stack[stack.length - 1] ?? null;
  const d: ToolDiagnostic = where ? { ...located(where), severity, message, source: "python" } : { path: null, line: 1, unit: "utf16", base: 0, severity, message, source: "python" };
  const code = text(o.code, MAX_CODE);
  if (code) d.code = code;
  if (stack.length) d.stack = stack.map(located);
  return d;
}

/**
 * Diagnostics from the Python helper's JSON (already parsed). Fields per entry: severity, path
 * (workspace-relative), line, col, endLine, endCol (UTF-16, 0-based, end exclusive), message, code,
 * stack (locations, outermost first). Entries that can't be read are dropped.
 */
export function fromPythonJson(raw: unknown, known: ReadonlySet<WsPath>): ToolDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DIAGNOSTICS).map((o) => readDiagnostic(o, known)).filter((d): d is ToolDiagnostic => d !== null);
}

/** Checks diagnostics a worker message claims to carry; same rules, ToolDiagnostic shape. */
export function checkDiagnostics(raw: unknown, known: ReadonlySet<WsPath>): ToolDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolDiagnostic[] = [];
  for (const o of raw.slice(0, MAX_DIAGNOSTICS)) {
    // Only what this worker produces is accepted: Python's own unit and base.
    if (!isObject(o) || o.unit !== "utf16" || o.base !== 0 || o.source !== "python") continue;
    const d = readDiagnostic(o, known);
    if (d) out.push(d);
  }
  return out;
}
