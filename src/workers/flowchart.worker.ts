/// <reference lib="webworker" />
// Flowchart worker: parses source with tree-sitter and returns flow models (src/flowchart/). The
// runtime and the language's grammar are fetched from /flowchart/<dir>/ the first time a chart for
// that language is asked for, and checked (sha256, ABI) by the engine. It runs no user code: the
// source is only parsed. A failed load is not remembered, so the next request fetches again, with
// the HTTP cache bypassed so a cached error can't come back.
import { FlowEngine, LoadError } from "../flowchart/engine";
import { FLOWCHART_DIR } from "../flowchart/pack";
import { isRequest, type FromFlowchart } from "../flowchart/protocol";

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: FromFlowchart) => self.postMessage(msg);

let failedBefore = false;
const engine = new FlowEngine(async (file) => {
  const res = await fetch(`/flowchart/${FLOWCHART_DIR}/${file}`, { cache: failedBefore ? "reload" : "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
});

self.onmessage = async (e: MessageEvent<unknown>) => {
  if (!isRequest(e.data)) return;
  const { id, language, source } = e.data;
  try {
    await engine.prepare(language);
  } catch (err) {
    failedBefore = true;
    if (err instanceof LoadError) post({ type: "load-failed", id, failure: err.failure });
    else post({ type: "failed", id, message: "the flowchart tools couldn't start" });
    return;
  }
  post({ type: "parsing", id });
  try {
    const outcome = engine.chart(language, source);
    post(outcome.type === "charts" ? { type: "charts", id, file: outcome.file } : { type: "too-big", id, detail: outcome.detail });
  } catch {
    post({ type: "failed", id, message: "the flowchart couldn't be drawn" });
  }
};
