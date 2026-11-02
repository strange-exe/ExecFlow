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
