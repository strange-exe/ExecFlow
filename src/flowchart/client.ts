// The page side of the flowchart worker. The worker is created the first time a chart is asked
// for (nothing loads on the first visit). Each request has two clocks: the download of the parser
// files (LOAD_TIMEOUT_MS, a slow network is not a hang) and then the parse and layout
// (PARSE_TIMEOUT_MS from the worker's "parsing" message). When either runs out the worker is
// terminated and the next request starts a fresh one. A newer request supersedes the one in flight.
// The worker works on one request at a time and can't be interrupted, so a newer request waits for
// it to finish (or for its clock to run out) and only the newest one waits: a burst of typing never
// queues up parses, and every request's 2 s clock starts with its own parse.
import type { LoadFailure } from "./engine";
import type { Layout } from "./layout";
import type { FlowFile } from "./model";
import type { FlowLanguage } from "./pack";
import type { Pick } from "./picked";
import type { FromFlowchart, ToFlowchart } from "./protocol";

export const PARSE_TIMEOUT_MS = 2000;
export const LOAD_TIMEOUT_MS = 60_000;

export type FlowchartResult =
  | { type: "charts"; file: FlowFile; picked: number; layout: Layout | null }
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

/** The request whose answer the page is waiting for. */
interface Waiting {
  msg: ToFlowchart;
  resolve: (r: FlowchartResult) => void;
}

/** The request the worker is on (possibly superseded since), and its clock. */
interface Busy {
  id: number;
  timer: ReturnType<typeof setTimeout>;
}

export class FlowchartClient {
  private worker: WorkerLike | null = null;
  private current: Waiting | null = null;
  private busy: Busy | null = null;
  private nextId = 1;

  constructor(private readonly makeWorker: () => WorkerLike) {}

  chart(language: FlowLanguage, source: string, pick: Pick | null = null): Promise<FlowchartResult> {
    this.settle({ type: "superseded" });
    const msg: ToFlowchart = { type: "chart", id: this.nextId++, language, source, pick };
    return new Promise((resolve) => {
      this.current = { msg, resolve };
      if (!this.busy) this.send();
    });
  }

  /** Stops the worker; a request in flight settles as superseded. */
  dispose(): void {
    this.settle({ type: "superseded" });
    this.stopWorker();
  }

  /** Gives the waiting request to the worker (a fresh one if needed) and starts its load clock. */
  private send(): void {
    const cur = this.current;
    if (!cur) return;
    const worker = this.ensureWorker();
    const id = cur.msg.id;
    this.busy = { id, timer: setTimeout(() => this.timeOut(id, "load"), LOAD_TIMEOUT_MS) };
    worker.postMessage(cur.msg);
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
    if (this.busy) clearTimeout(this.busy.timer);
    this.busy = null;
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  /** The request the worker is on ran out of time: replace the worker, then serve whoever waits. */
  private timeOut(id: number, phase: "load" | "parse"): void {
    this.stopWorker();
    if (this.current?.msg.id === id) this.settle({ type: "timeout", phase });
    else this.send();
  }

  /** Ends the waiting request with `result` and replaces the worker. */
  private fail(result: FlowchartResult): void {
    this.settle(result);
    this.stopWorker();
  }

  private settle(result: FlowchartResult): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.resolve(result);
  }

  /** The worker answered the request it was on: it is free for the one waiting, if any. */
  private finished(result: FlowchartResult | null): void {
    const busy = this.busy!;
    clearTimeout(busy.timer);
    this.busy = null;
    if (this.current?.msg.id === busy.id) {
      if (result) this.settle(result);
    } else {
      this.send();
    }
  }

  private onMessage(msg: unknown): void {
    const busy = this.busy;
    if (!busy || typeof msg !== "object" || msg === null) return;
    const m = msg as Partial<FromFlowchart>;
    if (typeof m.id !== "number" || m.id !== busy.id) return;
    const mine = this.current?.msg.id === busy.id;
    switch (m.type) {
      case "parsing":
        clearTimeout(busy.timer);
        busy.timer = setTimeout(() => this.timeOut(busy.id, "parse"), PARSE_TIMEOUT_MS);
        return;
      case "charts":
        if (isCharts(m)) this.finished({ type: "charts", file: m.file, picked: m.picked, layout: m.layout });
        else if (!mine) this.finished(null);
        return;
      case "too-big":
        if (typeof m.detail === "string") this.finished({ type: "too-big", detail: m.detail });
        else if (!mine) this.finished(null);
        return;
      case "load-failed":
        if (typeof m.failure === "object" && m.failure !== null) this.finished({ type: "load-failed", failure: m.failure });
        else if (!mine) this.finished(null);
        return;
      case "failed":
        if (mine) this.fail({ type: "failed", message: typeof m.message === "string" ? m.message : "the flowchart tools failed" });
        else this.finished(null);
        return;
      default:
        return;
    }
  }
}

/** A charts answer whose picked chart is one of its charts (0 when there are none) and whose layout has a shape. */
function isCharts(m: Partial<FromFlowchart>): m is Extract<FromFlowchart, { type: "charts" }> {
  const c = m as Partial<Extract<FromFlowchart, { type: "charts" }>>;
  if (typeof c.file !== "object" || c.file === null || !Array.isArray(c.file.charts)) return false;
  const n = c.file.charts.length;
  if (!Number.isSafeInteger(c.picked) || c.picked! < 0 || c.picked! >= Math.max(1, n)) return false;
  const l = c.layout;
  if (l === null) return true;
  return typeof l === "object" && l !== undefined && Number.isFinite(l.width) && Number.isFinite(l.height) && Array.isArray(l.boxes) && Array.isArray(l.edges);
}

/** The real worker (Vite bundles it under assets/w/, where the worker-only CSP applies). */
export function createFlowchartClient(): FlowchartClient {
  return new FlowchartClient(() => new Worker(new URL("../workers/flowchart.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
}
