/// <reference lib="webworker" />
// Python runtime worker (Pyodide 314.0.7, CPython 3.14.2), adapted from Pocket Run (same author, MIT).
// One worker = one warm interpreter. Order of start-up, which matters:
//   1. load Pyodide (downloaded into this device's cache the first time, python-download.ts; from
//      this device's memory snapshot when there is one),
//   2. load the packages the runner asked for (numpy, pandas...) from our own origin,
//   3. install output, input, interrupts and the run helper,
//   4. lock down: remove storage, network and cross-tab APIs, and refuse to run if any remain.
// User code only ever runs after step 4. Packages can't be fetched after it, so when a program
// imports one this worker doesn't have, it says so (need-packages) and the runner starts a new
// worker that loads it in step 2.

import type { PyodideAPI } from "pyodide";
import { waitForInput } from "../runner/input-channel";
import type { BootSource, FromPython, Stream, ToPython } from "../runner/protocol";
import { fromPythonJson } from "../runner/python-diagnostics";
import { DownloadError, downloadRuntime, failureWords, missingFiles, PYTHON_CACHE, RUNTIME_FILES, serveFromCache, type CheckedFiles, type DownloadProgress } from "../runner/python-download";
import { collectWritten, prepareRunFiles, writeWorkspace, type FsLike } from "../runner/python-files";
import { RUNNER_PY } from "../runner/python-helper";
import { canonicalName, importIndex, missingPackages, packageClosure, PYTHON_PACKAGES, type LockFile } from "../runner/python-packages";
import { lockDown } from "./lockdown";

declare const self: DedicatedWorkerGlobalScope;
// Private references, taken before lockDown() removes these from the global scope.
// User code can't reach module variables, only globals. postMessage is one of them: with it a
// program could forge a "done" and outlive Stop and the time limit (the page would think it ended).
const postToPage = self.postMessage.bind(self);
const post = (msg: FromPython) => postToPage(msg);
const cacheStorage: CacheStorage | undefined = self.caches;

// ---------------------------------------------------------------- output

// Output is posted as it is written, up to POSTS_PER_WINDOW messages per WINDOW_MS; beyond that (a
// print() loop) it is batched so the main thread isn't flooded. runPython is synchronous, so no timer
// can flush later: batching purely by time would lose the last lines of a program that prints and
// then hangs in C code (killed, never writes again).
const FLUSH_BYTES = 8 * 1024;
const WINDOW_MS = 50;
const POSTS_PER_WINDOW = 20;
let chunks: { stream: Stream; text: string }[] = [];
let pendingBytes = 0;
let windowStart = -Infinity;
let postsInWindow = 0;

function flush() {
  // One message either way: output that switches streams goes as a batch, in order.
  if (chunks.length === 1) post({ type: "out", stream: chunks[0].stream, text: chunks[0].text });
  else if (chunks.length > 1) post({ type: "out-batch", parts: chunks });
  chunks = [];
  pendingBytes = 0;
}

function maybeFlush() {
  const now = performance.now();
  if (now - windowStart >= WINDOW_MS) { windowStart = now; postsInWindow = 0; }
  if (pendingBytes >= FLUSH_BYTES || postsInWindow < POSTS_PER_WINDOW) { flush(); postsInWindow++; }
}

function writer(stream: Stream) {
  const decoder = new TextDecoder();
  return {
    isatty: false,
    write(buffer: Uint8Array): number {
      const text = decoder.decode(buffer, { stream: true });
      const last = chunks[chunks.length - 1];
      if (last?.stream === stream) last.text += text;
      else chunks.push({ stream, text });
      pendingBytes += buffer.length;
      maybeFlush();
      return buffer.length;
    },
  };
}

// ---------------------------------------------------------------- memory snapshot

// A full start-up parses and initialises the standard library; restoring a memory snapshot of an
// already-started interpreter is several times faster. The snapshot is made on this device after
// its first start (no extra download). Snapshots are a private Pyodide API, which is why the package
// is pinned to an exact version.
//
// A snapshot holds the wasm memory and Pyodide's JS-object table, nothing else: it can't restore the
// compiled code of C extensions (numpy and pandas load .so side modules), so a snapshot taken after
// loading them would point at functions that don't exist. It is therefore always taken before any
// package loads ("stdlib" in the key), and packages load on top of the restored interpreter.
const SNAPSHOT_CACHE = "codeeditor-python-snapshot";
/** Bump when loadPyodide's options change: os.environ and sys.path are frozen into a snapshot. */
const SNAPSHOT_CONFIG = 1;
const SNAPSHOT_KEY = `/python-snapshot/${__PYODIDE_DIR__}/stdlib/config-${SNAPSHOT_CONFIG}`;

async function readSnapshot(): Promise<Uint8Array | null> {
  try {
    const hit = await (await cacheStorage!.open(SNAPSHOT_CACHE)).match(SNAPSHOT_KEY);
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function saveSnapshot(snapshot: Uint8Array) {
  try {
    const cache = await cacheStorage!.open(SNAPSHOT_CACHE);
    for (const old of await cache.keys()) if (!old.url.endsWith(SNAPSHOT_KEY)) await cache.delete(old);
    await cache.put(SNAPSHOT_KEY, new Response(snapshot as Uint8Array<ArrayBuffer>));
  } catch {
    // Storage full or unavailable: the next start is simply the slow one.
  }
}

// ---------------------------------------------------------------- file storage cap

// Files a program writes live in Emscripten's MEMFS, in JavaScript memory outside Python's capped
// heap: a loop writing to files could otherwise grow the tab by gigabytes. Each run may add this
// much; past it, writes fail with "No space left on device" (OSError) like a full disk.
const FS_BUDGET = 256 * 1024 * 1024;
/** What each file, folder or link a program creates costs (its JavaScript objects), so a loop making empty files is capped too. */
const NODE_BYTES = 1024;
/**
 * Only /workspace is wiped between runs: what a program leaves elsewhere (/tmp...) stays for the
 * interpreter's lifetime, and each run has a fresh budget. Once programs have added this much in
 * total, the interpreter is replaced after the run, which frees it all at once.
 */
const FS_KEEP = FS_BUDGET / 2;
let fsAdded = 0;
let fsTotal = 0;
let fsLimited = false;

interface Memfs {
  ops_table?: { file?: { stream?: { write: (...a: never[]) => number } } };
  resizeFileStorage: (node: { usedBytes: number }, size: number) => void;
  createNode: (...a: never[]) => unknown;
}

function limitFileStorage(py: PyodideAPI) {
  const FS = py.FS as unknown as { filesystems: { MEMFS: Memfs }; ErrnoError: new (errno: number) => Error };
  const MEMFS = FS.filesystems.MEMFS;
  const stream = MEMFS.ops_table?.file?.stream; // shared by every MEMFS file node
  if (!stream) throw new Error("couldn't cap the program's file storage (Emscripten's MEMFS changed)");
  const ENOSPC = (py as unknown as { ERRNO_CODES: Record<string, number> }).ERRNO_CODES.ENOSPC;
  const charge = (grow: number) => {
    if (!fsLimited || grow <= 0) return;
    if (fsAdded + grow > FS_BUDGET) throw new FS.ErrnoError(ENOSPC);
    fsAdded += grow;
    fsTotal += grow;
  };
  // Every MEMFS file, folder and link is made here (mknod, mkdir, open with O_CREAT, symlink).
  const createNode = MEMFS.createNode as (this: unknown, ...a: unknown[]) => unknown;
  MEMFS.createNode = function (this: unknown, ...args: unknown[]) {
    charge(NODE_BYTES);
    return createNode.apply(this, args);
  } as never;
  const write = stream.write as (this: unknown, s: { node: { usedBytes: number } }, b: Uint8Array, offset: number, length: number, position: number, canOwn?: boolean) => number;
  stream.write = function (this: unknown, s: { node: { usedBytes: number } }, b: Uint8Array, offset: number, length: number, position: number, canOwn?: boolean) {
    charge(position + length - s.node.usedBytes);
    return write.call(this, s, b, offset, length, position, canOwn);
  } as never;
  const resize = MEMFS.resizeFileStorage;
  MEMFS.resizeFileStorage = function (this: unknown, node, size) {
    charge(size - node.usedBytes);
    return resize.call(this, node, size);
  };
}

// ---------------------------------------------------------------- boot

/** A package didn't download or install: a new worker would fail the same way (offline, missing file). */
class PackageError extends Error {}

interface Runtime {
  py: PyodideAPI;
  source: BootSource;
  packageMs: number;
  /** Lock-file keys this build can load. */
  available: string[];
  /** Top-level import name -> package, for `available`. */
  index: Map<string, string>;
  run: (entry: string, cwd: string, unavailableJson: string, argsJson: string) => string;
  check: (path: string, text: string) => string;
  imports: (entry: string) => string;
}

/** Cache Storage's runtime cache, or null where there is none (blocked) or it can't open. */
async function runtimeCache(): Promise<Cache | null> {
  try {
    return cacheStorage ? await cacheStorage.open(PYTHON_CACHE) : null;
  } catch {
    return null;
  }
}

/**
 * Puts the runtime on this device the first time (python-download.ts): its bytes are counted for
 * the run header, and a runtime already here is said to be done at once. Returns what to undo once
 * Pyodide has loaded: the fetch that answers Pyodide from the checked bytes and the cache.
 */
async function fetchRuntime(base: string, verify: boolean): Promise<{ end(): void }> {
  const progress = (p: DownloadProgress) => post({ type: "progress", ...p });
  const cache = await runtimeCache();
  // Bytes this worker hashed, which Pyodide is answered from first (python-download.ts header).
  const checked: CheckedFiles = new Map();
  // The first start of a page re-hashes what this device holds (python-download.ts missingFiles
  // says why only then); a copy that changed is dropped and downloaded again below. Without Cache
  // Storage nothing is kept, so every start downloads (and checks) all of it into memory.
  const missing = cache ? await missingFiles(cache, base, undefined, verify ? __PYODIDE_FILES__ : undefined, checked) : [...RUNTIME_FILES];
  if (missing.length) {
    // No request can succeed offline: say so at once rather than after each file fails.
    if (self.navigator.onLine === false) throw new DownloadError("this device is offline", "offline");
    const total = missing.reduce((sum, f) => sum + (__PYODIDE_FILES__[f]?.bytes ?? 0), 0);
    await downloadRuntime({ fetch: self.fetch.bind(self), cache, checked, base, files: missing, expected: __PYODIDE_FILES__, total, post: progress });
  } else {
    progress({ loaded: 0, total: 0, done: true });
  }
  return serveFromCache(self, cache, base, RUNTIME_FILES, checked);
}

async function boot(interrupt: SharedArrayBuffer | null, packages: string[], verifyRuntime: boolean): Promise<Runtime> {
  // The runtime comes from our own origin, so the loader always matches the files it loads.
  const indexURL = `/pyodide/${__PYODIDE_DIR__}/`;
  const base = new URL(indexURL, self.location.origin).href;
  // Before the loader is imported: the first start downloads it with the rest (the service worker
  // answers the import from the same cache once it controls the page).
  const fetching = await fetchRuntime(base, verifyRuntime);
  let py: PyodideAPI | null = null;
  let source: BootSource = "fresh";
  try {
    const { loadPyodide } = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as typeof import("pyodide");
    const snapshot = cacheStorage ? await readSnapshot() : null;
    if (snapshot) {
      try {
        py = await loadPyodide({ indexURL, _loadSnapshot: snapshot });
        source = "snapshot";
      } catch {
        await cacheStorage?.delete(SNAPSHOT_CACHE).catch(() => {}); // corrupt or incompatible: start fresh
      }
    }
    if (!py) {
      py = await loadPyodide({ indexURL, _makeSnapshot: true });
      // Taken before any packages or per-session setup (output, interrupts), so it is a clean interpreter.
      if (cacheStorage) {
        const made = py.makeMemorySnapshot();
        setTimeout(() => void saveSnapshot(made), 0); // after "ready" is posted
      }
    }
  } finally {
    fetching.end();
  }
  return setUp(py, source, interrupt, packages);
}

async function setUp(py: PyodideAPI, source: BootSource, interrupt: SharedArrayBuffer | null, packages: string[]): Promise<Runtime> {
  // Output written while starting (package import warnings) is dropped, not shown in the first run.
  py.setStdout(writer("stdout"));
  py.setStderr(writer("stderr"));

  const lock = py.lockfile as unknown as LockFile;
  let available: string[] = [];
  try {
    available = packageClosure(lock, PYTHON_PACKAGES);
  } catch {
    // This build's lock file lacks a package: programs get the standard library only.
  }
  const index = importIndex(lock, available);

  let packageMs = 0;
  const wanted = packages.filter((p) => available.some((a) => canonicalName(a) === canonicalName(p)));
  if (wanted.length) {
    const t = performance.now();
    const errors: string[] = [];
    // Same origin, sha256-checked by the browser against pyodide-lock.json (Subresource Integrity).
    await py.loadPackage(wanted, { messageCallback: () => {}, errorCallback: (m) => errors.push(m), checkIntegrity: true });
    const loaded = new Set(Object.keys(py.loadedPackages).map(canonicalName));
    const failed = packageClosure(lock, wanted).filter((p) => !loaded.has(canonicalName(p)));
    // Pyodide reports a header line ("The following error occurred while loading pandas:") and then the cause.
    if (failed.length) throw new PackageError(errors.join(" ").replace(/\s+/g, " ").trim().slice(0, 300) || `${failed.join(", ")} didn't load`);
    // Import them now, before the time limit can count it (pandas takes seconds) and before the lockdown.
    for (const name of wanted) for (const imp of lock.packages[packageClosure(lock, [name]).at(-1)!].imports) py.pyimport(imp).destroy?.();
    packageMs = performance.now() - t;
  }
  chunks = [];
  pendingBytes = 0;

  if (interrupt) {
    interruptFlag = new Uint8Array(interrupt);
    py.setInterruptBuffer(interruptFlag);
  }
  py.runPython(RUNNER_PY);
  const fn = (name: string) => py.globals.get(name);
  fn("__ce_configure")(JSON.stringify({ imports: Object.fromEntries(index) }));
  limitFileStorage(py);
  // Fail closed: never run user code with storage or network still reachable.
  const reachable = lockDown(self);
  if (reachable.length) throw new Error(`couldn't isolate Python from: ${reachable.join(", ")}`);
  return { py, source, packageMs, available, index, run: fn("__ce_run"), check: fn("__ce_check"), imports: fn("__ce_imports") };
}

// ---------------------------------------------------------------- messages

let booting: Promise<Runtime> | undefined;
let inputChannel: SharedArrayBuffer | null = null;
let interruptFlag: Uint8Array | null = null;

function done(msg: Partial<Extract<FromPython, { type: "done" }>>) {
  flush();
  post({ type: "done", exitCode: 1, interrupted: false, recycle: false, outOfMemory: false, ms: 0, diagnostics: [], written: [], writtenSkipped: 0, ...msg });
}

function run(rt: Runtime, data: Extract<ToPython, { type: "run" }>) {
  const { py } = rt;
  const prepared = prepareRunFiles(data.files, data.entry);
  if (!prepared.ok) {
    post({ type: "out", stream: "stderr", text: `${prepared.reason}\n` });
    return done({});
  }
  const known = new Set(prepared.files.map((f) => f.path));
  const fs = py.FS as unknown as FsLike;
  fsLimited = false;
  let sent: Map<string, Uint8Array>;
  try {
    sent = writeWorkspace(fs, prepared.files);
  } catch (e) {
    post({ type: "out", stream: "stderr", text: `The workspace couldn't be prepared for the run: ${String(e)}\n` });
    return done({ recycle: true });
  }

  if (data.packageCheck) {
    // Parsing only: no user code runs. Packages must load before the lockdown, in a new worker.
    let imports: string[] = [];
    try {
      imports = JSON.parse(rt.imports(data.entry)) as string[];
    } catch (e) {
      // Stop or the time limit landed during the scan (a big workspace): don't go on to run the
      // program as if nothing happened. (Files that don't parse are skipped inside the scan.)
      if ((e as { type?: string }).type === "KeyboardInterrupt") return done({ exitCode: 130, interrupted: true });
    }
    const missing = missingPackages(imports, rt.index, Object.keys(py.loadedPackages), data.unavailable);
    if (missing.length) return post({ type: "need-packages", packages: missing });
  }

  // The Input box first; after that, ask while the program runs (if possible). A last line typed
  // without Enter is still a complete line, not a request for more.
  let pending: Uint8Array = new TextEncoder().encode(data.stdin && !data.stdin.endsWith("\n") ? data.stdin + "\n" : data.stdin);
  let ended = !inputChannel;
  let waitedMs = 0;
  // read() is called once per read, with a buffer to fill. It returns what's available (the rest of
  // the Input box, or one live line) and only waits when nothing is left, like a terminal. (The
  // stdin() callback style keeps asking for more to fill Python's buffer, so a live line never got
  // back to the program.) Returning 0 means end of input.
  py.setStdin({
    read: (buffer: Uint8Array) => {
      if (!pending.length && !ended) {
        flush(); // the prompt (e.g. input("Name: ")) must be on screen before we wait
        const t = performance.now();
        const line = waitForInput(inputChannel!, () => post({ type: "input-request" }));
        waitedMs += performance.now() - t;
        // Woken by Stop rather than by "End input": stop right here, so the program sees a
        // KeyboardInterrupt, not a fake end-of-file it might handle and carry on from.
        if (!line && interruptFlag?.[0] === 2) py.checkInterrupt();
        if (line) pending = line;
        else ended = true;
      }
      const n = Math.min(buffer.length, pending.length);
      buffer.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return n;
    },
  });

  const t0 = performance.now();
  let result = { exit: 1, interrupted: false, recycle: true, oom: false, diagnostics: [] as unknown };
  fsAdded = 0;
  fsLimited = true;
  try {
    result = JSON.parse(rt.run(data.entry, data.cwd, JSON.stringify(data.unavailable), JSON.stringify(Array.isArray(data.args) ? data.args : [])));
  } catch (e) {
    // Only an interrupt or out-of-memory landing in the helper's own steps can get here.
    const type = (e as { type?: string }).type;
    result = { exit: type === "KeyboardInterrupt" ? 130 : 1, interrupted: type === "KeyboardInterrupt", recycle: true, oom: type === "MemoryError", diagnostics: [] };
  } finally {
    fsLimited = false;
  }
  const ms = performance.now() - t0 - waitedMs;
  flush();
  let written: ReturnType<typeof collectWritten> = { written: [], skipped: 0 };
  try {
    written = collectWritten(fs, sent);
  } catch {
    // The program left the file system in a state we can't read: report nothing.
  }
  done({
    exitCode: Number.isSafeInteger(result.exit) ? result.exit : 1,
    interrupted: result.interrupted === true,
    recycle: result.recycle !== false || fsTotal > FS_KEEP,
    outOfMemory: result.oom === true,
    ms,
    diagnostics: fromPythonJson(result.diagnostics, known),
    written: written.written,
    writtenSkipped: written.skipped,
  });
}

function check(rt: Runtime, data: Extract<ToPython, { type: "check" }>) {
  let raw: unknown = [];
  try {
    raw = JSON.parse(rt.check(data.path, data.text));
  } catch {
    // Nothing to mark.
  }
  post({ type: "checked", id: data.id, diagnostics: fromPythonJson(raw, new Set([data.path])) });
}

// A listener, not self.onmessage: a program can assign js.self.onmessage (which only replaces a
// handler of its own) but can't remove this one, since it has no reference to it. With onmessage, a
// program that cleared it left the warm worker deaf, and its next run waited for the time limit.
self.addEventListener("message", async ({ data }: MessageEvent<ToPython>) => {
  if (data.type === "init") {
    const t0 = performance.now();
    inputChannel = data.input;
    // Fails safe: anything but an explicit false re-checks the runtime.
    booting = boot(data.interrupt, data.packages, data.verifyRuntime !== false);
    try {
      const rt = await booting;
      post({ type: "ready", ms: performance.now() - t0, source: rt.source, loaded: Object.keys(rt.py.loadedPackages).sort(), available: rt.available, packageMs: rt.packageMs });
    } catch (e) {
      // Offline before Python was ever downloaded: the runner says so in plain words, and starting
      // again won't help until the device is online.
      if (e instanceof DownloadError && e.offline) return post({ type: "boot-failed", error: e.message, retry: false, offline: true });
      const error = e instanceof DownloadError ? failureWords(e) : e instanceof Error ? e.message : String(e);
      post({ type: "boot-failed", error, retry: !(e instanceof PackageError) });
    }
    return;
  }
  const rt = await booting!;
  if (data.type === "run") {
    try {
      run(rt, data);
    } catch (e) {
      // A bug of ours, not the program's: say so, and replace this interpreter.
      post({ type: "out", stream: "stderr", text: `ExecFlow's Python runner failed: ${String(e)}\n` });
      done({ recycle: true });
    }
  } else if (data.type === "check") {
    check(rt, data);
  }
});
