/// <reference lib="webworker" />
// Runs one compiled C/C++ program (a WASI module) and exits (adapted from Pocket Run, same author,
// MIT). The page terminate()s this worker on a timeout or Stop; replacing it costs only this
// small file. The program sees console I/O and its own folder's files, nothing else: it can only
// call the WASI functions bound here (no JS, network or storage).
import type { FromProgram, ToProgram } from "../runner/clang-protocol";
import { TailWriter } from "../runner/cpp-output-tail";
import { createWasi, describeCrash, Exit, importObject, OutputLimit } from "../runner/cpp-wasi";
import { WasiFs } from "../runner/cpp-wasi-fs";

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: FromProgram, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// Output is posted as it is written, up to POSTS_PER_WINDOW messages per WINDOW_MS; beyond
// that (a print loop) it is batched. Batching purely by time would lose the last lines of a
// program that prints and then hangs: a busy loop never writes again to trigger the flush.
const FLUSH_BYTES = 8 * 1024;
const WINDOW_MS = 50;
const POSTS_PER_WINDOW = 20;
/** RunResult.written: at most 20 files of at most 1 MiB (one more is sent so the page knows). */
const MAX_WRITTEN = 21;
const MAX_WRITTEN_BYTES = 1024 * 1024;

self.onmessage = async ({ data }: MessageEvent<ToProgram>) => {
  post({ type: "started" });
  const t0 = performance.now();
  const enc = new TextEncoder();
  let written = 0;
  let truncated = false;
  /** The end of what the program wrote to stderr: an uncaught C++ exception names itself there (describeCrash). */
  let stderrTail = "";
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  let chunks: { stream: "stdout" | "stderr"; text: string }[] = [];
  let pendingBytes = 0;
  let windowStart = -Infinity;
  let postsInWindow = 0;
  // A batch only goes out on a later write, so a program that loops forever after a burst would
  // keep it here: mirror it where the page can read it before terminating this worker.
  const tail = data.tail ? new TailWriter(data.tail) : null;
  const flush = () => {
    tail?.clear(); // before posting, so the page never shows a batch twice
    for (const c of chunks) if (c.text) post({ type: "out", stream: c.stream, text: c.text });
    chunks = [];
    pendingBytes = 0;
  };
  const maybeFlush = () => {
    const now = performance.now();
    if (now - windowStart >= WINDOW_MS) { windowStart = now; postsInWindow = 0; }
    if (pendingBytes >= FLUSH_BYTES || postsInWindow < POSTS_PER_WINDOW) { flush(); postsInWindow++; }
  };

  const fs = new WasiFs(data.files.map((f) => ({ path: f.path, bytes: enc.encode(f.text) })), undefined,
    () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)));
  // The Input box first (a last line typed without Enter is still a whole line); after that,
  // ask the user live, until they end input.
  const host = createWasi({
    args: data.args,
    stdin: enc.encode(data.stdin && !data.stdin.endsWith("\n") ? data.stdin + "\n" : data.stdin),
    input: data.input,
    askForInput: () => post({ type: "input-request" }),
    flush,
    fs,
    write(stream, bytes) {
      const take = Math.min(bytes.length, data.outputCap - written);
      const text = decoders[stream].decode(bytes.subarray(0, take), { stream: true });
      if (stream === "stderr") stderrTail = (stderrTail + text).slice(-1024);
      const last = chunks[chunks.length - 1];
      if (last?.stream === stream) last.text += text;
      else chunks.push({ stream, text });
      tail?.append(stream, text);
      written += take;
      pendingBytes += take;
      if (take < bytes.length) {
        truncated = true;
        throw new OutputLimit();
      }
      maybeFlush();
    },
  });

  let exitCode = 0;
  let crash: string | undefined;
  try {
    const module = await WebAssembly.compile(data.wasm as Uint8Array<ArrayBuffer>);
    const instance = await WebAssembly.instantiate(module, importObject(module, host));
    host.bind(instance.exports.memory as WebAssembly.Memory);
    (instance.exports._start as () => void)();
  } catch (e) {
    if (e instanceof Exit) exitCode = e.code;
    else if (e instanceof OutputLimit) exitCode = -1;
    else { exitCode = -1; crash = describeCrash(e, stderrTail); }
  }
  flush();
  const changed = fs.changes().filter((f) => f.bytes.length <= MAX_WRITTEN_BYTES).slice(0, MAX_WRITTEN);
  post({
    type: "done", exitCode, crash, truncated, ms: performance.now() - t0 - host.inputWaitMs, written: changed,
  }, changed.map((f) => f.bytes.buffer));
};
