// The last run's trace for each file (feature F1), kept by the workbench after a Python run and read
// by the Flowchart view, which may not have loaded yet: this module is tiny so the main chunk can
// import it. A trace belongs to the text that ran: the view shows it only while the file still has
// that text, so any edit makes it stale (and undoing back to the same text brings it back).
import type { RunTrace } from "../core/types";

export interface LastRun {
  /** The file's text when it ran. */
  text: string;
  trace: RunTrace;
  /** Counts up with every run, so the view can tell a new trace from one it has shown. */
  serial: number;
}

/** Files whose traces are kept (a trace can be about a megabyte); the oldest goes first. */
export const KEPT_RUNS = 8;

const runs = new Map<string, LastRun>();
const listeners = new Set<(fileId: string) => void>();
let serial = 0;

/** Keeps a run's trace for the file (or forgets the old one when the run has none: C, C++, a failed start). */
export function noteRun(fileId: string, text: string, trace: RunTrace | undefined): void {
  runs.delete(fileId); // re-added last: the Map's order is the order of the runs
  if (trace) runs.set(fileId, { text, trace, serial: ++serial });
  while (runs.size > KEPT_RUNS) runs.delete(runs.keys().next().value!);
  for (const f of listeners) f(fileId);
}

/** The file's last traced run, when the file's text is still what ran. */
export function lastRun(fileId: string, text: string): LastRun | null {
  const run = runs.get(fileId);
  return run && run.text === text ? run : null;
}

/** Called with the file's id after each run; returns the unsubscribe. */
export function onRun(listener: (fileId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
