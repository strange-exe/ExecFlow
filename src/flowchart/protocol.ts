// Messages between the page and the flowchart worker (src/workers/flowchart.worker.ts).
import type { LoadFailure } from "./engine";
import type { FlowFile } from "./model";
import type { FlowLanguage } from "./pack";

export type ToFlowchart = { type: "chart"; id: number; language: FlowLanguage; source: string };

export type FromFlowchart =
  /** The language's parser is loaded and the parse starts: the page's 2 s clock starts now. */
  | { type: "parsing"; id: number }
  | { type: "charts"; id: number; file: FlowFile }
  /** Past a limit (file size, steps, nesting, parse time): a message for the student. */
  | { type: "too-big"; id: number; detail: string }
  | { type: "load-failed"; id: number; failure: LoadFailure }
  /** Anything unexpected; the page shows a generic error. */
  | { type: "failed"; id: number; message: string };

export const LANGUAGES: readonly FlowLanguage[] = ["c", "cpp", "python"];

/** The worker answers only well-formed requests. */
export function isRequest(msg: unknown): msg is ToFlowchart {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Partial<ToFlowchart>;
  return m.type === "chart" && Number.isSafeInteger(m.id) && typeof m.source === "string" && LANGUAGES.includes(m.language as FlowLanguage);
}
