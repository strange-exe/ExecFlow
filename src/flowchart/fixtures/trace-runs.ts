// Test fixtures (unit tests only): Python programs with the line events CPython 3.14 reports when
// they run (recorded with sys.settrace, the way the runner's helper traces), as RunTraces.
import type { RunTrace } from "../../core/types";

/** A trace of one top-level call: its line events, then its return (-1), unless `exit` says otherwise. */
export function moduleTrace(lines: number[], exit: number | null = -1, partial = false): RunTrace {
  const flat = [...lines, ...(exit === null ? [] : [exit])].flatMap((l) => [0, l]);
  return { codes: [{ name: "<module>", line: 1 }], calls: Int32Array.from([0]), events: Int32Array.from(flat), partial };
}

/** The Flow Board mock's program in Python: five marks, the best of them. */
export const MARKS = [
  "marks = [72, 85, 64, 90, 58]",
  "n = len(marks)",
  "total = 0",
  "best = marks[0]",
  "i = 0",
  "while i < n:",
  "    print('marks', i, marks[i])",
  "    total += marks[i]",
  "    if marks[i] > best:",
  "        best = marks[i]",
  "    i += 1",
  "print('Best:', best)",
  "",
].join("\n");

/** Its run's line events: the loop 5 times; marks[i] > best Yes 2 times, No 3 times. */
export const MARKS_LINES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 6, 7, 8, 9, 10, 11, 6, 7, 8, 9, 11, 6, 7, 8, 9, 10, 11, 6, 7, 8, 9, 11, 6, 12];

/** The step-through mock's program: the sum of the even numbers 1 to 6. */
export const SUM_EVENS = ["total = 0", "for n in range(1, 7):", "    if n % 2 == 0:", "        total += n", "print(total)", ""].join("\n");

/** Its run's line events (CPython 3.14), then the return. */
export const SUM_EVENS_LINES = [1, 2, 3, 2, 3, 4, 2, 3, 2, 3, 4, 2, 3, 2, 3, 4, 2, 5];

/** n and total as each event fires (before its line runs), the return's last; null: not set yet. */
export const SUM_EVENS_N = [null, null, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 6, 6];
export const SUM_EVENS_TOTAL = [null, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 6, 6, 6, 6, 6, 12, 12, 12];

/**
 * The helper's value deltas (RunTrace.values) for the given full states, one per event pair of
 * `events` (a call's variables as that event fired; empty for events of no interest). States are
 * per call: each event's call (events[2 * e]) is compared with that call's last state only.
 */
export function encodeValues(events: Int32Array, states: (readonly [string, string][] | undefined)[]): NonNullable<RunTrace["values"]> {
  const names: string[] = [];
  const texts: string[] = [];
  const deltas: number[] = [];
  const last = new Map<number, Map<string, string>>();
  const seen = new Map<string, number>();
  const ix = (list: string[], s: string) => {
    const key = `${list === names ? "n" : "t"}:${s}`;
    let i = seen.get(key);
    if (i === undefined) seen.set(key, (i = list.push(s) - 1));
    return i;
  };
  states.forEach((state, e) => {
    if (!state) return;
    const call = events[2 * e];
    const before = last.get(call) ?? new Map<string, string>();
    const now = new Map(state);
    for (const [name, text] of now) if (before.get(name) !== text) deltas.push(e, ix(names, name), ix(texts, text));
    for (const name of before.keys()) if (!now.has(name)) deltas.push(e, ix(names, name), -1);
    last.set(call, now);
  });
  return { names, texts, deltas: Int32Array.from(deltas), cut: null };
}

/** SUM_EVENS's whole trace, with its values. */
export function sumEvensTrace(): RunTrace {
  const trace = moduleTrace(SUM_EVENS_LINES);
  const states = SUM_EVENS_N.map((n, e) => {
    const s: [string, string][] = [];
    if (SUM_EVENS_TOTAL[e] !== null) s.push(["total", String(SUM_EVENS_TOTAL[e])]);
    if (n !== null) s.push(["n", String(n)]);
    return s;
  });
  return { ...trace, values: encodeValues(trace.events, states) };
}
