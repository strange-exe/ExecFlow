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
/** A reply's parts besides the type and id: the file, the picked chart and its layout. */
const ANSWER = { file: FILE, picked: 0, layout: null };

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
    workers[0].answer({ type: "charts", id: req.id, ...ANSWER });
    expect(await result).toEqual({ type: "charts", ...ANSWER });
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
    w.answer({ type: "charts", id: w.last().id, ...ANSWER });
    expect(await again).toEqual({ type: "charts", ...ANSWER });
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
    workers[0].answer({ type: "charts", id: workers[0].last().id, ...ANSWER });
    expect(await retry).toEqual({ type: "charts", ...ANSWER });
  });

  it("a newer request supersedes the one in flight; only the newest waits for the worker to be free", async () => {
    const { client, workers } = setup();
    const old = client.chart("c", "a");
    const middle = client.chart("c", "b");
    const fresh = client.chart("c", "c", { name: "f", nth: 1 });
    expect(await old).toEqual({ type: "superseded" });
    expect(await middle).toEqual({ type: "superseded" });
    // The worker is still on "a": nothing more is sent until it answers, and "b" never is.
    expect(workers[0].sent.map((m) => m.source)).toEqual(["a"]);
    const a = workers[0].sent[0];
    workers[0].answer({ type: "parsing", id: a.id });
    // The old answer is not this request's: it is dropped, and the newest goes out.
    workers[0].answer({ type: "charts", id: a.id, file: { charts: [{ junk: true }] }, picked: 0, layout: null });
    expect(workers[0].sent.map((m) => m.source)).toEqual(["a", "c"]);
    const c = workers[0].last();
    expect(c.pick).toEqual({ name: "f", nth: 1 });
    workers[0].answer({ type: "parsing", id: c.id });
    workers[0].answer({ type: "charts", id: c.id, ...ANSWER });
    expect(await fresh).toEqual({ type: "charts", ...ANSWER });
  });

  it(`a replaced request whose parse runs past ${PARSE_TIMEOUT_MS} ms: a fresh worker takes the newest, which gets its own clock`, async () => {
    const { client, workers } = setup();
    client.chart("c", "slow");
    workers[0].answer({ type: "parsing", id: workers[0].last().id });
    vi.advanceTimersByTime(1500);
    const fresh = client.chart("c", "next");
    expect(workers[0].sent.length).toBe(1);
    vi.advanceTimersByTime(500);
    // The old parse ran out: its worker is stopped, and the newest request starts on a new one.
    expect(workers[0].terminated).toBe(true);
    expect(workers.length).toBe(2);
    const w = workers[1];
    expect(w.last().source).toBe("next");
    vi.advanceTimersByTime(PARSE_TIMEOUT_MS * 3);
    w.answer({ type: "parsing", id: w.last().id });
    vi.advanceTimersByTime(PARSE_TIMEOUT_MS - 1);
    w.answer({ type: "charts", id: w.last().id, ...ANSWER });
    expect(await fresh).toEqual({ type: "charts", ...ANSWER });
  });

  it("a reply whose picked chart or layout is malformed is not taken", async () => {
    const { client, workers } = setup();
    const result = client.chart("c", "a");
    const id = workers[0].last().id;
    const file = { charts: [{ ok: false, name: "main", from: 1, to: 2, tooBig: "x" }] };
    workers[0].answer({ type: "charts", id, file, picked: 1, layout: null });
    workers[0].answer({ type: "charts", id, file, picked: 0.5, layout: null });
    workers[0].answer({ type: "charts", id, file, picked: 0, layout: "nope" });
    workers[0].answer({ type: "charts", id, file, picked: 0, layout: { boxes: [], edges: [] } });
    workers[0].answer({ type: "charts", id, file, picked: 0, layout: null });
    expect(await result).toEqual({ type: "charts", file, picked: 0, layout: null });
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
    workers[0].answer({ type: "charts", id: id + 100, ...ANSWER });
    workers[0].answer({ type: "nonsense", id });
    workers[0].answer({ id });
    workers[0].answer({ type: "charts", id: String(id), ...ANSWER });
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
