/// <reference lib="webworker" />
// Flowchart worker: parses source with tree-sitter and returns flow models (src/flowchart/), with
// the layout of the chart the page picked (layout can take most of a second; the page only draws). The
// runtime and the language's grammar are fetched from /flowchart/<dir>/ the first time a chart for
// that language is asked for, and checked (sha256, ABI) by the engine. It runs no user code: the
// source is only parsed. A failed load is not remembered, so the next request fetches again, with
// the HTTP cache bypassed so a cached error can't come back.
import { FlowEngine, LoadError } from "../flowchart/engine";
import { FLOWCHART_DIR, MAX_PACK_FILE_BYTES } from "../flowchart/pack";
import { readCapped } from "../flowchart/read-capped";
import { JOB_MS, LAYOUT_MS } from "../flowchart/layout";
import { layOutPicked } from "../flowchart/picked";
import { isRequest, type FromFlowchart } from "../flowchart/protocol";

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: FromFlowchart) => self.postMessage(msg);

let failedBefore = false;
const engine = new FlowEngine(async (file) => {
  const res = await fetch(`/flowchart/${FLOWCHART_DIR}/${file}`, { cache: failedBefore ? "reload" : "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Capped before the engine checks its sha256: a server sending too much can't fill the worker's memory.
  return readCapped(res, MAX_PACK_FILE_BYTES);
});

self.onmessage = async (e: MessageEvent<unknown>) => {
  if (!isRequest(e.data)) return;
  const { id, language, source, pick } = e.data;
  try {
    await engine.prepare(language);
  } catch (err) {
    failedBefore = true;
    if (err instanceof LoadError) post({ type: "load-failed", id, failure: err.failure });
    else post({ type: "failed", id, message: "the flowchart tools couldn't start" });
    return;
  }
  post({ type: "parsing", id });
  // One deadline for the parse and the layout, inside the page's clock (which starts now too).
  const deadline = performance.now() + JOB_MS;
  try {
    const outcome = engine.chart(language, source, pick, deadline);
    post(outcome.type === "charts" ? { type: "charts", id, ...layOutPicked(outcome.file, pick, Math.min(performance.now() + LAYOUT_MS, deadline)) } : { type: "too-big", id, detail: outcome.detail });
  } catch {
    post({ type: "failed", id, message: "the flowchart couldn't be drawn" });
  }
};
