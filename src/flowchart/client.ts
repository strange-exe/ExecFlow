// The page side of the flowchart worker. The worker is created the first time a chart is asked
// for (nothing loads on the first visit). Each request has two clocks: the download of the parser
// files (LOAD_TIMEOUT_MS, a slow network is not a hang) and then the parse itself (PARSE_TIMEOUT_MS
// from the worker's "parsing" message). When either runs out the worker is terminated and the next
// request starts a fresh one. A newer request supersedes the one in flight.
import type { LoadFailure } from "./engine";
import type { FlowFile } from "./model";
import type { FlowLanguage } from "./pack";
import type { FromFlowchart, ToFlowchart } from "./protocol";

export const PARSE_TIMEOUT_MS = 2000;
export const LOAD_TIMEOUT_MS = 60_000;

export type FlowchartResult =
  | { type: "charts"; file: FlowFile }
  | { type: "too-big"; detail: string }
  | { type: "load-failed"; failure: LoadFailure }
  | { type: "timeout"; phase: "load" | "parse" }
  | { type: "failed"; message: string }
  /** A newer request (or dispose) replaced this one. */
  | { type: "superseded" };

/** What the client needs of a Worker (tests pass a fake). */
export interface WorkerLike {
  postMessage(msg: ToFlowchart): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FromFlowchart>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

interface InFlight {
  id: number;
  resolve: (r: FlowchartResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FlowchartClient {
  private worker: WorkerLike | null = null;
  private current: InFlight | null = null;
  private nextId = 1;

  constructor(private readonly makeWorker: () => WorkerLike) {}

  chart(language: FlowLanguage, source: string): Promise<FlowchartResult> {
    this.settle({ type: "superseded" });
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.current = { id, resolve, timer: setTimeout(() => this.fail({ type: "timeout", phase: "load" }), LOAD_TIMEOUT_MS) };
      worker.postMessage({ type: "chart", id, language, source });
    });
  }

  /** Stops the worker; a request in flight settles as superseded. */
  dispose(): void {
    this.settle({ type: "superseded" });
    this.stopWorker();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.makeWorker();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = () => this.fail({ type: "failed", message: "the flowchart tools stopped" });
    this.worker = w;
    return w;
  }

  private stopWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  /** Ends the request in flight with `result` and replaces the worker. */
  private fail(result: FlowchartResult): void {
    this.settle(result);
    this.stopWorker();
  }

  private settle(result: FlowchartResult): void {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    cur.resolve(result);
  }

  private onMessage(msg: unknown): void {
    const cur = this.current;
    if (!cur || typeof msg !== "object" || msg === null) return;
    const m = msg as Partial<FromFlowchart>;
    if (typeof m.id !== "number" || m.id !== cur.id) return;
    switch (m.type) {
      case "parsing":
        clearTimeout(cur.timer);
        cur.timer = setTimeout(() => this.fail({ type: "timeout", phase: "parse" }), PARSE_TIMEOUT_MS);
        return;
      case "charts":
        if (typeof m.file === "object" && m.file !== null && Array.isArray(m.file.charts)) this.settle({ type: "charts", file: m.file });
        return;
      case "too-big":
        if (typeof m.detail === "string") this.settle({ type: "too-big", detail: m.detail });
        return;
      case "load-failed":
        if (typeof m.failure === "object" && m.failure !== null) this.settle({ type: "load-failed", failure: m.failure });
        return;
      case "failed":
        this.fail({ type: "failed", message: typeof m.message === "string" ? m.message : "the flowchart tools failed" });
        return;
      default:
        return;
    }
  }
}

/** The real worker (Vite bundles it under assets/w/, where the worker-only CSP applies). */
export function createFlowchartClient(): FlowchartClient {
  return new FlowchartClient(() => new Worker(new URL("../workers/flowchart.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
}
