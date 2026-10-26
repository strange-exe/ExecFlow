import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowchartClient, LOAD_TIMEOUT_MS, PARSE_TIMEOUT_MS, type WorkerLike } from "./client";
import type { FromFlowchart, ToFlowchart } from "./protocol";

/** A worker stand-in: records what the page sends; the test answers for it. */
class FakeWorker implements WorkerLike {
  sent: ToFlowchart[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<FromFlowchart>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(msg: ToFlowchart) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  answer(msg: FromFlowchart | Record<string, unknown>) {
    this.onmessage?.({ data: msg } as MessageEvent<FromFlowchart>);
  }
  last() {
    return this.sent.at(-1)!;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = new FlowchartClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { client, workers };
}

const FILE = { charts: [] };

describe("FlowchartClient (page side of the flowchart worker)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates the worker only when a chart is asked for, and returns the charts", async () => {
    const { client, workers } = setup();
    expect(workers.length).toBe(0);
    const result = client.chart("c", "int main(void) {}");
    expect(workers.length).toBe(1);
    const req = workers[0].last();
    expect(req).toMatchObject({ type: "chart", language: "c", source: "int main(void) {}" });
    workers[0].answer({ type: "parsing", id: req.id });
    workers[0].answer({ type: "charts", id: req.id, file: FILE });
    expect(await result).toEqual({ type: "charts", file: FILE });
  });

  it(`a parse that takes longer than ${PARSE_TIMEOUT_MS} ms: the worker is terminated and the next chart gets a new one`, async () => {
    const { client, workers } = setup();
    const result = client.chart("python", "x = 1");
    // Loading the grammar may take long (a slow network); the 2 s clock starts with the parse.
    vi.advanceTimersByTime(PARSE_TIMEOUT_MS * 3);
    workers[0].answer({ type: "parsing", id: workers[0].last().id });
    vi.advanceTimersByTime(PARSE_TIMEOUT_MS - 1);
    expect(workers[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await result).toEqual({ type: "timeout", phase: "parse" });
    expect(workers[0].terminated).toBe(true);
    const again = client.chart("python", "x = 1");
    expect(workers.length).toBe(2);
    const w = workers[1];
    w.answer({ type: "parsing", id: w.last().id });
    w.answer({ type: "charts", id: w.last().id, file: FILE });
    expect(await again).toEqual({ type: "charts", file: FILE });
  });

  it("a download that never finishes times out too, never hangs", async () => {
    const { client, workers } = setup();
    const result = client.chart("cpp", "int main() {}");
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    expect(await result).toEqual({ type: "timeout", phase: "load" });
    expect(workers[0].terminated).toBe(true);
  });

  it("a loading failure comes back typed, and Retry asks the same worker again (it loads again)", async () => {
    const { client, workers } = setup();
    const first = client.chart("c", "int main(void) {}");
    const failure = { part: "grammar", reason: "missing", detail: "tree-sitter-c.wasm: HTTP 404" } as const;
    workers[0].answer({ type: "load-failed", id: workers[0].last().id, failure });
    expect(await first).toEqual({ type: "load-failed", failure });
    const retry = client.chart("c", "int main(void) {}");
    expect(workers.length).toBe(1);
    expect(workers[0].sent.length).toBe(2);
    workers[0].answer({ type: "parsing", id: workers[0].last().id });
    workers[0].answer({ type: "charts", id: workers[0].last().id, file: FILE });
    expect(await retry).toEqual({ type: "charts", file: FILE });
  });

  it("a newer request supersedes the one in flight", async () => {
    const { client, workers } = setup();
    const old = client.chart("c", "a");
    const fresh = client.chart("c", "b");
    expect(await old).toEqual({ type: "superseded" });
    const [a, b] = workers[0].sent;
    // The old answer arriving late is ignored.
    workers[0].answer({ type: "charts", id: a.id, file: { charts: [{ junk: true }] } });
    workers[0].answer({ type: "parsing", id: b.id });
    workers[0].answer({ type: "charts", id: b.id, file: FILE });
    expect(await fresh).toEqual({ type: "charts", file: FILE });
  });

  it("a worker that fails to start is reported and replaced next time", async () => {
    const { client, workers } = setup();
    const result = client.chart("c", "a");
    workers[0].onerror?.({ message: "boom" } as ErrorEvent);
    expect(await result).toEqual({ type: "failed", message: "the flowchart tools stopped" });
    expect(workers[0].terminated).toBe(true);
    client.chart("c", "a");
    expect(workers.length).toBe(2);
  });

  it("ignores messages that aren't answers to the current request", async () => {
    const { client, workers } = setup();
    const result = client.chart("c", "a");
    const id = workers[0].last().id;
    workers[0].answer({ type: "charts", id: id + 100, file: FILE });
    workers[0].answer({ type: "nonsense", id });
    workers[0].answer({ id });
    workers[0].answer({ type: "charts", id: String(id), file: FILE });
    workers[0].answer({ type: "too-big", id, detail: "it has more than 400 steps" });
    expect(await result).toEqual({ type: "too-big", detail: "it has more than 400 steps" });
  });

  it("dispose() stops the worker and settles what is in flight", async () => {
    const { client, workers } = setup();
    const result = client.chart("c", "a");
    client.dispose();
    expect(workers[0].terminated).toBe(true);
    expect(await result).toEqual({ type: "superseded" });
  });
});
