// The run trace's wire form. The Python helper (python-helper.ts, _trace_start) records the lines the
// run file's own code executes; the worker turns what __ce_trace returns into a RunTrace
// (traceFromPython), and the runner checks the worker's message before the page uses it
// (checkTrace): a program can't reach the worker's postMessage, but it can rewrite the helper's
// buffers while it runs, so every size and type is checked here, and the chart's mapping
// (flowchart/trace.ts) accepts any numbers.
import type { RunTrace } from "../core/types";

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

/** What __ce_trace returned (converted with toJs) as a RunTrace; undefined when it isn't one. */
export function traceFromPython(raw: unknown): RunTrace | undefined {
  if (!Array.isArray(raw) || raw.length !== 3 || typeof raw[0] !== "string") return undefined;
  let meta: unknown;
  try {
    meta = JSON.parse(raw[0]);
  } catch {
    return undefined;
  }
  const calls = int32s(raw[1]);
  const events = int32s(raw[2]);
  if (!calls || !events || typeof meta !== "object" || meta === null) return undefined;
  return checkTrace({ codes: (meta as { codes?: unknown }).codes, calls, events, partial: (meta as { partial?: unknown }).partial === true });
}

/** A trace from the worker, or undefined when anything about it is off (too big, wrong types, odd length). */
export function checkTrace(raw: unknown): RunTrace | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as Partial<Record<keyof RunTrace, unknown>>;
  const codes = codesOf(t.codes);
  if (!codes || !(t.calls instanceof Int32Array) || !(t.events instanceof Int32Array)) return undefined;
  if (t.calls.length > MAX_TRACE_CALLS || t.events.length > MAX_TRACE_INTS || t.events.length % 2 !== 0) return undefined;
  return { codes, calls: t.calls, events: t.events, partial: t.partial === true };
}
