// The run trace's wire form. The Python helper (python-helper.ts, _trace_start) records the lines the
// run file's own code executes; the worker turns what __ce_trace returns into a RunTrace
// (traceFromPython), and the runner checks the worker's message before the page uses it
// (checkTrace): a program can't reach the worker's postMessage, but it can rewrite the helper's
// buffers while it runs, so every size and type is checked here, and the chart's mapping
// (flowchart/trace.ts) accepts any numbers. The variable values (RunTrace.values, for stepping
// through the run) are checked the same way: sizes, indexes in range, events in order, and texts
// short and on one line. They stay plain text from the user's program: shown only via textContent.
import type { RunTrace, TraceValues } from "../core/types";

/** Line events recorded per run; the Python helper's TRACE_STEPS (a test keeps them equal). */
export const TRACE_STEPS = 50_000;
/** Code objects a trace may name (the top level and each function that ran). */
export const MAX_TRACE_CODES = 5_000;
/** Longest code name kept (a qualified name; longer ones match no chart anyway). */
export const MAX_NAME = 300;
/**
 * Calls and events a trace may hold: each traced call starts with a line event, so there are at
 * most TRACE_STEPS calls plus those still on the stack, and each event is two numbers.
 */
export const MAX_TRACE_CALLS = TRACE_STEPS + 10_000;
export const MAX_TRACE_INTS = 2 * (TRACE_STEPS + 2 * MAX_TRACE_CALLS);

/** The helper's VALUE_STEPS: events with variable values; later ones have none (values.cut). */
export const VALUE_STEPS = 10_000;
/** The helper's VALUE_TEXT: a value's text is cut to this many characters (code points). */
export const VALUE_TEXT = 40;
/** The helper's VALUE_BUDGET: name and text characters (+8 each) and 12 per change. */
export const VALUE_BUDGET = 2_000_000;
/** What that budget allows at most (a test keeps them in step with the helper). */
export const MAX_VALUE_DELTAS = Math.floor(VALUE_BUDGET / 12);
export const MAX_VALUE_TEXTS = Math.floor(VALUE_BUDGET / 9);
export const MAX_VALUE_NAMES = 20_000;
/** Line breaks, controls, bidi and other invisible format characters: the helper escapes them all. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function int32s(bytes: unknown): Int32Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 4 !== 0) return null;
  // A copy: its own buffer, aligned for Int32Array.
  return new Int32Array(bytes.slice().buffer);
}

function codesOf(raw: unknown): RunTrace["codes"] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TRACE_CODES) return null;
  const out: RunTrace["codes"] = [];
  for (const c of raw) {
    // The helper sends [name, line, untraced]; a checked trace carries {name, line, untraced?}.
    const o = c as { name?: unknown; line?: unknown; untraced?: unknown };
    const [name, line, untraced] = Array.isArray(c) ? c : typeof c === "object" && c !== null ? [o.name, o.line, o.untraced] : [];
    if (typeof name !== "string" || !Number.isSafeInteger(line)) return null;
    out.push(untraced === true ? { name: name.slice(0, MAX_NAME), line: line as number, untraced: true } : { name: name.slice(0, MAX_NAME), line: line as number });
  }
  return out;
}

const jsonOf = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * What __ce_trace returned (converted with toJs) as a RunTrace; undefined when it isn't one.
 * [meta JSON, calls, events] (no values), or those and [values JSON, deltas] (int32 bytes each).
 */
export function traceFromPython(raw: unknown): RunTrace | undefined {
  if (!Array.isArray(raw) || (raw.length !== 3 && raw.length !== 5)) return undefined;
  const meta = jsonOf(raw[0]);
  const calls = int32s(raw[1]);
  const events = int32s(raw[2]);
  if (!calls || !events || typeof meta !== "object" || meta === null) return undefined;
  const trace: Record<string, unknown> = { codes: (meta as { codes?: unknown }).codes, calls, events, partial: (meta as { partial?: unknown }).partial === true };
  if (raw.length === 5) {
    // Values that are off are dropped by checkTrace; the lines still read.
    const v = jsonOf(raw[3]);
    const deltas = int32s(raw[4]);
    trace.values = typeof v === "object" && v !== null && deltas ? { ...(v as object), deltas } : null;
  }
  return checkTrace(trace);
}

/** Display strings: a list of at most `max` non-empty strings of at most `len` UTF-16 units, nothing unshowable. */
function texts(raw: unknown, max: number, len: number, empty: boolean): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  for (const s of raw) if (typeof s !== "string" || s.length > len || (!empty && !s) || UNSHOWABLE.test(s)) return null;
  return raw as string[];
}

/** The values part of a trace with `pairs` events, or null when anything about it is off. */
function valuesOf(raw: unknown, pairs: number): TraceValues | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Partial<Record<keyof TraceValues, unknown>>;
  // A code point is at most two UTF-16 units.
  const names = texts(v.names, MAX_VALUE_NAMES, MAX_NAME, false);
  const shown = texts(v.texts, MAX_VALUE_TEXTS, 2 * VALUE_TEXT, true);
  const cut = v.cut ?? null;
  if (!names || !shown || !(v.deltas instanceof Int32Array)) return null;
  if (cut !== null && !(Number.isSafeInteger(cut) && (cut as number) >= 0 && (cut as number) <= pairs)) return null;
  const d = v.deltas;
  if (d.length % 3 !== 0 || d.length > 3 * MAX_VALUE_DELTAS) return null;
  let last = 0;
  for (let i = 0; i < d.length; i += 3) {
    const [at, name, text] = [d[i], d[i + 1], d[i + 2]];
    if (at < last || at >= pairs || (cut !== null && at >= (cut as number))) return null;
    if (name < 0 || name >= names.length || text < -1 || text >= shown.length) return null;
    last = at;
  }
  return { names: [...names], texts: [...shown], deltas: d, cut: cut as number | null };
}

/**
 * A trace from the worker, or undefined when anything about its lines is off (too big, wrong types,
 * odd length). Values that are off drop only the values: the trace reads as one without them.
 */
export function checkTrace(raw: unknown): RunTrace | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as Partial<Record<keyof RunTrace, unknown>>;
  const codes = codesOf(t.codes);
  if (!codes || !(t.calls instanceof Int32Array) || !(t.events instanceof Int32Array)) return undefined;
  if (t.calls.length > MAX_TRACE_CALLS || t.events.length > MAX_TRACE_INTS || t.events.length % 2 !== 0) return undefined;
  const trace: RunTrace = { codes, calls: t.calls, events: t.events, partial: t.partial === true };
  if (t.values !== undefined) {
    const values = valuesOf(t.values, t.events.length / 2);
    if (values) trace.values = values;
  }
  return trace;
}
