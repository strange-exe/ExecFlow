// Messages between the page and the flowchart worker (src/workers/flowchart.worker.ts).
import type { LanguageId } from "../core/languages";
import type { LoadFailure } from "./engine";
import type { Layout } from "./layout";
import type { FlowFile } from "./model";
import type { FlowLanguage } from "./pack";
import type { Pick } from "./picked";

/** `pick`: the chart to lay out (null: the entry point). */
export type ToFlowchart = { type: "chart"; id: number; language: FlowLanguage; source: string; pick: Pick | null };

export type FromFlowchart =
  /** The language's parser is loaded and the parse starts: the page's 2 s clock starts now. */
  | { type: "parsing"; id: number }
  /** Every chart of the file, and the layout of the picked one (null when it is too big). */
  | { type: "charts"; id: number; file: FlowFile; picked: number; layout: Layout | null }
  /** Past a limit (file size, steps, nesting, parse time): a message for the student. */
  | { type: "too-big"; id: number; detail: string }
  | { type: "load-failed"; id: number; failure: LoadFailure }
  /** Anything unexpected; the page shows a generic error. */
  | { type: "failed"; id: number; message: string };

export const LANGUAGES: readonly FlowLanguage[] = ["c", "cpp", "python"];

/** Type check: the flowchart covers exactly the editor's languages (pack.ts can't import them: Vite's config loads it). */
export const SAME_LANGUAGES: [FlowLanguage] extends [LanguageId] ? ([LanguageId] extends [FlowLanguage] ? true : false) : false = true;

/** The worker answers only well-formed requests. */
export function isRequest(msg: unknown): msg is ToFlowchart {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<ToFlowchart>;
  return m.type === "chart" && Number.isSafeInteger(m.id) && typeof m.source === "string" && LANGUAGES.includes(m.language as FlowLanguage) && isPick(m.pick);
}

function isPick(p: unknown): p is Pick | null {
  if (p === null) return true;
  if (typeof p !== "object") return false;
  const { name, nth } = p as Partial<Pick>;
  return typeof name === "string" && Number.isSafeInteger(nth) && nth! >= 0;
}
