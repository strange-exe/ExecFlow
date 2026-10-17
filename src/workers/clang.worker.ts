/// <reference lib="webworker" />
// C/C++ compiler worker (adapted from Pocket Run, same author, MIT): downloads the toolchain pack
// once, keeps clang + lld warm, and builds multi-file programs: one clang -cc1 run per translation
// unit (with an object cache across builds), then one wasm-ld link.
//
// memfs layout. JS-side memfs paths have no leading "/"; clang and lld get "/..." paths.
//   /include /lib /share     sysroot, plus include/bits/stdc++.h
//   /ce/include/__errno.h    the patched errno header (searched before /include)
//   /w<g>/<workspace path>   the program's sources and headers (UTF-8), generation <g>
//   /o/<id>-<n>.o /d/...d    objects and depfiles, flat: clang can't create directories
//   /pch/<key>-<n>.pch       precompiled <bits/stdc++.h>
//   /rt/init.o               start-up object: unbuffered stdout, so prompts show before scanf
//   /out/main-<n>.wasm
// Nothing is ever removed or overwritten: memfs reuses a deleted file's inode slot without
// clearing it, so the next node created inherits stale contents (verified: it corrupted a new
// directory and then an object file). So every output gets a fresh name, a changed or deleted
// source starts a new mount generation, and memory is reclaimed by replacing the worker.
import API from "../vendor/wasm-clang/shared.js";
import type { BuildOptions, ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import type { FromCompiler, ToCompiler } from "../runner/clang-protocol";
import { cleanToolOutput, dedupeDiagnostics, parseClangOutput, parseLldOutput, workspaceMap } from "../runner/clang-diagnostics";
import { checkBuildOptions, cOnly, includeClosure, semanticArgs, unitArgs, wantsPch } from "../runner/cpp-build";
import { normalizeMemfsPath, parseDepfile } from "../runner/cpp-depfile";
import { MOUNT, memfsPath } from "../runner/program";

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: FromCompiler, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

const PACK = __CLANG_PACK__;
const CACHE = `codeeditor-cpp-${PACK.version}`;
const key = (name: string) => `/cpp-pack/${PACK.version}/${name}`;
const COMPLETE = key("complete");
const PCH_LRU = key("pch-lru");
/** What the user downloads: everything except the licence text. */
const TOOLCHAIN = ["clang", "lld", "sysroot.tar", "memfs"] as const;
/** Wasm memory never shrinks: past this, the page replaces the worker (it reboots from the cache). */
const RECYCLE_BYTES = 384 * 1024 * 1024;
const PCH_VARIANTS = 3;

// bits/stdc++.h is GCC-only, but students include it constantly; ship an equivalent.
const STDCXX_SHIM = [
  "algorithm", "array", "bitset", "cassert", "cctype", "cerrno", "cfloat", "chrono", "climits", "cmath",
  "complex", "cstdint", "cstdio", "cstdlib", "cstring", "ctime", "deque", "fstream", "functional",
  "iomanip", "iostream", "iterator", "limits", "list", "map", "memory", "numeric", "optional",
  "queue", "random", "set", "sstream", "stack", "string", "string_view", "tuple",
  "unordered_map", "unordered_set", "utility", "variant", "vector",
].map((h) => `#include <${h}>`).join("\n") + "\n";
// "#pragma once" lets a precompiled copy stand in for the user's own #include of it.
const STDCXX_HEADER = "#pragma once\n" + STDCXX_SHIM;

// The sysroot's wasi-libc declares errno _Thread_local, which clang 8 can't compile for wasm32
// ("Cannot select: GlobalTLSAddress"), so any program using errno failed to build. libc.a was
// built without threads, so its errno is an ordinary global: declare it as one.
const ERRNO_HEADER = `#ifndef __wasm_basics___errno_h
#define __wasm_basics___errno_h
#ifdef __cplusplus
extern "C" {
#endif
/* CodeEditor: a plain global (clang 8 can't select thread-local storage for wasm32). */
extern int errno;
#define errno errno
#ifdef __cplusplus
}
#endif
#endif
`;

const INIT_SOURCE = `#include <stdio.h>
__attribute__((constructor)) static void codeeditor_unbuffered_stdout(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
}
`;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- the pack: download once, verify, keep in Cache Storage ----------

/** The toolchain parts Cache Storage doesn't hold (any more). */
async function missingParts(cache: Cache): Promise<string[]> {
  const missing: string[] = [];
  for (const name of TOOLCHAIN) if (!(await cache.match(key(name)))) missing.push(name);
  return missing;
}

/**
 * Installed = the "complete" marker AND every part. A browser can drop entries of a cache it keeps
 * (measured in Playwright's WebKit after a reload, with no service worker); then the marker goes
 * too, so the page offers the download again instead of failing at boot with a missing part.
 */
async function isInstalled(): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    if (!(await cache.match(COMPLETE))) return false;
    if (!(await missingParts(cache)).length) return true;
    await cache.delete(COMPLETE);
    return false;
  } catch {
    return false;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hashText = (text: string) => sha256Hex(enc.encode(text));

async function fetchFile(name: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  const spec = PACK.files[name];
  const res = await fetch(`/clang/${PACK.version}/${spec.path}`, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`${spec.path}: HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  let blob = new Blob(chunks as Uint8Array<ArrayBuffer>[]);
  // Decide by content, not by name: a server may already have removed the gzip layer.
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    blob = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if ((await sha256Hex(bytes)) !== spec.sha256) throw new Error(`${spec.path} is damaged (checksum mismatch)`);
  return bytes;
}

async function download() {
  const total = TOOLCHAIN.reduce((n, f) => n + PACK.files[f].bytes, 0);
  let loaded = 0;
  let lastPost = 0;
  const onBytes = (n: number) => {
    loaded += n;
    if (performance.now() - lastPost > 100) {
      lastPost = performance.now();
      post({ type: "progress", loaded: Math.min(loaded, total), total });
    }
  };
  let cache = await caches.open(CACHE);
  // A part found at the start (a resumed download) can be gone by the end (a reload in between, or
  // the browser dropping entries): the marker is written only once every part is there, checked again.
  for (let pass = 1; ; pass++) {
    let missing = await missingParts(cache);
    if (!missing.length) break;
    if (pass > 3) throw new Error(`this browser didn't keep the C/C++ pack (${missing.join(", ")} went missing)`);
    if (pass > 1) {
      // Parts vanished after they were seen or stored: start again in a new, empty cache.
      await caches.delete(CACHE);
      cache = await caches.open(CACHE);
      missing = [...TOOLCHAIN];
    }
    loaded = total - missing.reduce((n, f) => n + PACK.files[f].bytes, 0); // what is kept counts as downloaded
    for (const name of missing) {
      let bytes: Uint8Array | null = null;
      for (let attempt = 1; !bytes; attempt++) {
        const before = loaded;
        try {
          bytes = await fetchFile(name, onBytes);
        } catch (e) {
          loaded = before;
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
      const type = name === "sysroot.tar" ? "application/x-tar" : "application/wasm";
      await cache.put(key(name), new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": type } }));
    }
  }
  await cache.put(COMPLETE, new Response("ok"));
  post({ type: "progress", loaded: total, total });
  // Packs from older toolchain versions are dead weight.
  for (const name of await caches.keys()) if (name.startsWith("codeeditor-cpp-") && name !== CACHE) await caches.delete(name);
}

// ---------- the compiler ----------

let output = "";
let api: API | null = null;
let booting: Promise<API> | null = null;

async function cached(name: string): Promise<Response> {
  const hit = await (await caches.open(CACHE)).match(key(name));
  if (!hit) throw new Error(`the C/C++ pack is missing ${name}`);
  return hit;
}

/** memfs directories created so far (AddDirectoryNode on an existing one adds a duplicate). */
const dirs = new Set<string>();
function ensureDirsFor(path: string) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!dirs.has(dir)) {
      api!.memfs.addDirectory(dir);
      dirs.add(dir);
    }
  }
}
/** Adds a file at a path that doesn't exist yet; `path` without a leading "/". */
function addFile(path: string, bytes: Uint8Array) {
  ensureDirsFor(path);
  api!.memfs.addFile(path, bytes);
}
/** A fresh output name for every tool run, so no tool ever replaces (and so frees) a file. */
let outputSeq = 0;
/** Something may have freed a memfs node that held data (see the top): replace this worker. */
let tainted = false;
const fresh = (stem: string) => `${stem}-${++outputSeq}`;

async function boot(): Promise<API> {
  // A retried boot gets a fresh memfs: forget everything recorded about the previous one.
  dirs.clear();
  mounted.clear();
  records.clear();
  pchInMemfs.clear();
  mount = "";
  tainted = false;
  const a = new API({
    readBuffer: async (name) => (await cached(name)).arrayBuffer(),
    compileStreaming: async (name) => WebAssembly.compileStreaming(cached(name)),
    hostWrite: (text) => { output += text; },
    clang: "clang", lld: "lld", memfs: "memfs", sysroot: "sysroot.tar",
  });
  // Keep only tool output: no progress chatter, no colour codes.
  a.hostLog = () => {};
  a.hostLogAsync = (_message, promise) => promise;
  // The patched errno header shadows the sysroot's: its folder is searched before /include.
  a.clangCommonArgs = a.clangCommonArgs
    .filter((arg) => arg !== "-fcolor-diagnostics")
    .flatMap((arg, i, all) => (arg === "/include" && all[i - 1] === "-internal-isystem" ? ["/ce/include", "-internal-isystem", arg] : [arg]));
  await a.ready;
  api = a;
  // The sysroot's own folders (the tar lists them, so they exist already).
  for (const dir of ["include", "include/bits", "lib", "share"]) dirs.add(dir);
  addFile("ce/include/__errno.h", enc.encode(ERRNO_HEADER));
  addFile("include/bits/stdc++.h", enc.encode(STDCXX_HEADER));
  for (const dir of ["o", "d", "pch", "rt", "out"]) ensureDirsFor(`${dir}/x`);
  const clang = await a.getModule(a.clangFilename);
  await a.getModule(a.lldFilename);
  addFile("rt/init.c", enc.encode(INIT_SOURCE));
  if (!(await tool(clang, "clang", "-cc1", "-emit-obj", ...cOnly(a.clangCommonArgs), "-O2", "-std=gnu11", "-o", "/rt/init.o", "-x", "c", "/rt/init.c")).ok) {
    throw new Error("the C/C++ start-up code failed to compile");
  }
  return a;
}

/** Runs clang or wasm-ld in the shared memfs (one at a time: memfs has one host memory). */
async function tool(module: WebAssembly.Module, ...args: string[]): Promise<{ ok: boolean; text: string; internalError: string | null }> {
  output = "";
  let ok = true;
  try {
    await api!.run(module, ...args);
  } catch {
    ok = false;
  }
  const cleaned = cleanToolOutput(output);
  output = "";
  return { ok, ...cleaned };
}

// ---------- precompiled <bits/stdc++.h> ----------
// Parsing the ~40 headers behind bits/stdc++.h dominates compile time (Pocket Run measured 1.8 s ->
// 0.7 s on desktop). The key covers the header text and every flag that changes its meaning, so a
// stale PCH is never reused; the 3 most recently used variants are kept.

const pchUnavailable = new Set<string>();
/** PCH key -> its memfs path (memfs never frees, so old variants just stop being used). */
const pchInMemfs = new Map<string, string>();

async function pchKey(options: BuildOptions): Promise<string> {
  const id = await hashText([STDCXX_HEADER, ERRNO_HEADER, ...api!.clangCommonArgs, ...semanticArgs("cpp", options)].join("\n"));
  return id.slice(0, 16);
}

async function touchPchLru(cache: Cache, k: string) {
  let list: string[] = [];
  try {
    list = JSON.parse((await (await cache.match(PCH_LRU))?.text()) ?? "[]");
  } catch {
    list = [];
  }
  list = [k, ...list.filter((x) => x !== k && /^[0-9a-f]{16}$/.test(x))];
  for (const old of list.slice(PCH_VARIANTS)) await cache.delete(key(`stdcpp-${old}.pch`));
  await cache.put(PCH_LRU, new Response(JSON.stringify(list.slice(0, PCH_VARIANTS))));
}

async function ensurePch(clang: WebAssembly.Module, k: string, options: BuildOptions, id: number): Promise<string | null> {
  if (pchUnavailable.has(k)) return null;
  const known = pchInMemfs.get(k);
  if (known) return known;
  const path = `/pch/${fresh(k)}.pch`;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key(`stdcpp-${k}.pch`));
    if (hit) {
      addFile(path.slice(1), new Uint8Array(await hit.arrayBuffer()));
    } else {
      post({ type: "step", id, step: "pch" });
      const r = await tool(clang, "clang", "-cc1", "-emit-pch", ...api!.clangCommonArgs, ...semanticArgs("cpp", options),
        "-o", path, "-x", "c++-header", "/include/bits/stdc++.h");
      if (!r.ok) {
        pchUnavailable.add(k);
        tainted = true; // clang may have deleted a half-written PCH: start a fresh worker after this build
        return null;
      }
      const bytes = api!.memfs.getFileContents(path.slice(1)).slice();
      await cache.put(key(`stdcpp-${k}.pch`), new Response(bytes as Uint8Array<ArrayBuffer>));
    }
    pchInMemfs.set(k, path);
    await touchPchLru(cache, k);
    return path;
  } catch {
    pchUnavailable.add(k); // storage full or blocked: compile the slow way
    return null;
  }
}

async function forgetPch(k: string) {
  pchUnavailable.add(k);
  pchInMemfs.delete(k);
  try { await (await caches.open(CACHE)).delete(key(`stdcpp-${k}.pch`)); } catch { /* best effort */ }
}

// ---------- the workspace mount and the object cache ----------

let mount = "";
let generation = 0;
/** Workspace path -> hash of its text, for the files in the current mount generation. */
const mounted = new Map<WsPath, string>();

interface UnitRecord {
  argsKey: string;
  srcHash: string;
  /** User files the unit read, with their hashes (from its depfile). */
  deps: [WsPath, string][];
  headerSetKey: string;
  object: string;
  diagnostics: ToolDiagnostic[];
}
const records = new Map<WsPath, UnitRecord>();
const unitIds = new Map<WsPath, string>();

async function unitId(path: WsPath): Promise<string> {
  let id = unitIds.get(path);
  if (!id) {
    id = (await hashText(path)).slice(0, 12);
    unitIds.set(path, id);
  }
  return id;
}

/**
 * Makes memfs hold exactly `files`. New files join the current mount; if any mounted file changed
 * or is gone, the whole program is mounted afresh under a new /w<g> folder (memfs can't safely
 * remove or replace a file, and a stale header would keep #include "old.h" working).
 */
async function syncMount(files: readonly WorkspaceFile[]): Promise<Map<WsPath, string>> {
  const hashes = new Map<WsPath, string>();
  for (const f of files) hashes.set(f.path, await hashText(f.text));
  const stale = !mount || [...mounted].some(([path, hash]) => hashes.get(path) !== hash);
  if (stale) {
    generation++;
    mount = generation === 1 ? MOUNT : `${MOUNT}${generation}`;
    mounted.clear();
  }
  for (const f of files) {
    if (mounted.has(f.path)) continue;
    addFile(memfsPath(f.path, mount).slice(1), enc.encode(f.text));
    mounted.set(f.path, hashes.get(f.path)!);
  }
  return hashes;
}

function readMemfsText(path: string): string {
  return dec.decode(api!.memfs.getFileContents(path).slice());
}

// ---------- build ----------

type BuildMsg = Extract<ToCompiler, { type: "build" }>;

async function build(msg: BuildMsg) {
  const t0 = performance.now();
  const { options, problems } = checkBuildOptions(msg.options);
  const clang = await api!.getModule(api!.clangFilename);
  const lld = await api!.getModule(api!.lldFilename);
  const hashes = await syncMount(msg.files);
  const byPath = new Map(msg.files.map((f) => [f.path, f]));
  const map = workspaceMap(hashes.keys(), mount);
  const headerSetKey = await hashText([...hashes.keys()].filter((p) => !msg.units.some((u) => u.path === p)).sort().join("\n"));
  const all: ToolDiagnostic[] = problems.map((message) => ({ path: null, line: 1, unit: "utf8-byte", base: 1, severity: "warning", message, source: "clang" }));
  let failed = false;
  let compiled = 0;
  let reused = 0;
  let internalError: string | undefined;
  const includes = new Map<WsPath, WsPath[]>();
  /** Object file -> the unit compiled into it, in unit order (the link order). */
  const objects = new Map<string, WsPath>();

  for (const unit of msg.units) {
    const u0 = performance.now();
    post({ type: "step", id: msg.id, step: "compile", path: unit.path });
    const id = await unitId(unit.path);
    let k = wantsPch(unit, byPath, msg.root) ? await pchKey(options) : null;
    let pch = k ? await ensurePch(clang, k, options, msg.id) : null;
    if (!pch) k = null;
    // The cache key names the inputs, not where this generation mounted them.
    const argsKey = await hashText(JSON.stringify([PACK.version, ERRNO_HEADER, INIT_SOURCE,
      unitArgs({ unit, root: msg.root, common: api!.clangCommonArgs, options, id, pch: k, mount: MOUNT })]));
    const record = records.get(unit.path);
    if (record && record.argsKey === argsKey && record.srcHash === hashes.get(unit.path) && record.headerSetKey === headerSetKey &&
      record.deps.every(([p, h]) => hashes.get(p) === h)) {
      reused++;
      objects.set(record.object, unit.path);
      includes.set(unit.path, record.deps.map(([p]) => p));
      all.push(...record.diagnostics);
      post({ type: "unit", id: msg.id, path: unit.path, state: "cached", ms: performance.now() - u0, diagnostics: record.diagnostics });
      continue;
    }
    records.delete(unit.path); // never reuse an object from before a failed compile
    let out = "";
    const compile = () => {
      out = fresh(id);
      return tool(clang, "clang", ...unitArgs({ unit, root: msg.root, common: api!.clangCommonArgs, options, id: out, pch, mount }));
    };
    let r = await compile();
    // Only retry for PCH problems ("PCH file was compiled...", "malformed or corrupted AST file"):
    // ordinary mistakes in the user's code must not pay for a second compile.
    if (!r.ok && k && /precompiled header|PCH file|AST file/i.test(r.text)) {
      await forgetPch(k);
      k = null;
      pch = null;
      r = await compile();
    }
    compiled++;
    const parsed = parseClangOutput(r.text, map, memfsPath(unit.path, mount));
    const diagnostics = parsed.diagnostics;
    if (parsed.unparsed.length) {
      diagnostics.push({ path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: r.ok ? "warning" : "error", message: parsed.unparsed.join("\n"), source: "clang" });
    }
    if (r.internalError) {
      internalError ??= r.internalError;
      diagnostics.push({
        path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: "error", source: "clang",
        message: `The compiler itself crashed on this file (${r.internalError}). Try simplifying the code you changed last.`,
      });
    } else if (!r.ok && !diagnostics.some((d) => d.severity === "error")) {
      diagnostics.push({ path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: "error", message: "the compiler stopped without saying why", source: "clang" });
    }
    if (r.ok) {
      const deps = parseDepfile(readMemfsText(`d/${out}.d`)).map((p) => map(p)).filter((p): p is WsPath => p !== null && p !== unit.path);
      const object = `/o/${out}.o`;
      objects.set(object, unit.path);
      includes.set(unit.path, deps);
      records.set(unit.path, { argsKey, srcHash: hashes.get(unit.path)!, deps: deps.map((p) => [p, hashes.get(p)!]), headerSetKey, object, diagnostics });
    } else {
      failed = true;
      includes.set(unit.path, includeClosure(unit.path, byPath, msg.root));
    }
    all.push(...diagnostics);
    post({ type: "unit", id: msg.id, path: unit.path, state: r.ok ? "ok" : "failed", ms: performance.now() - u0, diagnostics });
  }
  const compileMs = performance.now() - t0;
  const finish = (rest: Omit<Extract<FromCompiler, { type: "built" }>, "type" | "id" | "compileMs" | "compiled" | "reused" | "recycle" | "internalError">, transfer: Transferable[] = []) => {
    const recycle = !!internalError || tainted || api!.memfs.exports.memory.buffer.byteLength > RECYCLE_BYTES;
    post({ type: "built", id: msg.id, compileMs, compiled, reused, recycle, ...(internalError ? { internalError } : {}), ...rest }, transfer);
  };
  if (failed) {
    finish({ ok: false, stage: "compile", diagnostics: dedupeDiagnostics(all), linkMs: 0 });
    return;
  }

  post({ type: "step", id: msg.id, step: "link" });
  const l0 = performance.now();
  const program = `/out/${fresh("main")}.wasm`;
  const r = await tool(lld, "wasm-ld", "--no-threads", "--no-color-diagnostics", "-z", "stack-size=1048576",
    // Stack below the data: an overflow (a big local array, deep recursion) runs past address 0
    // and traps. lld 8's default puts the stack after the data, where it silently overwrites the
    // program's globals and libc's own state (seen: printf then printed nothing, exit code 0).
    "--stack-first",
    // Programs may use at most 256 MB, so a memory bomb can't take the browser down.
    "--max-memory=268435456", "-L/lib/wasm32-wasi", "/lib/wasm32-wasi/crt1.o", "/rt/init.o", ...objects.keys(),
    "-lc", "-lc++", "-lc++abi",
    // compiler-rt: 128-bit long double helpers (__lttf2 ...) that libc++ needs.
    "/lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a", "-o", program);
  const linkMs = performance.now() - l0;
  const linkParse = parseLldOutput(r.text, {
    unitOfObject: (obj) => objects.get(normalizeMemfsPath(obj)) ?? null,
    text: (p) => byPath.get(p)?.text,
    includesOf: (unit) => includes.get(unit) ?? [],
  });
  const linkDiagnostics = linkParse.diagnostics;
  if (linkParse.unparsed.length) {
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: r.ok ? "warning" : "error", message: linkParse.unparsed.join("\n"), source: "wasm-ld" });
  }
  if (r.internalError) {
    internalError ??= r.internalError;
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", message: `The linker itself crashed (${r.internalError}).` });
  } else if (!r.ok && !linkDiagnostics.some((d) => d.severity === "error")) {
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", message: "the linker stopped without saying why" });
  }
  // Compile warnings stay when the link fails: "implicit declaration of gets" explains "undefined symbol: gets".
  const diagnostics = dedupeDiagnostics([...all, ...linkDiagnostics]);
  if (!r.ok) {
    finish({ ok: false, stage: "link", diagnostics, linkMs });
    return;
  }
  const wasm = api!.memfs.getFileContents(program.slice(1)).slice(); // copy out of memfs memory
  // lld 8 links a call whose argument types differ from the definition (int f(int, int) declared,
  // double f(double) defined in another file) without a word, and the engine then refuses the
  // module. Say so now, as a link problem, rather than as a crash at start-up.
  if (!WebAssembly.validate(wasm as Uint8Array<ArrayBuffer>)) {
    let detail = "";
    try { await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>); } catch (e) { detail = reason(e, ""); }
    const caller = /function #\d+:?\s*"([^"]+)"/.exec(detail)?.[1]?.replace(/^__original_main$/, "main");
    diagnostics.push({
      path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", code: "signature-mismatch",
      message: `function signature mismatch: ${caller ? `${caller}() calls` : "the program calls"} a function with other parameter or return types than its definition has. Check that every declaration (in a header or at the top of a file) matches the definition exactly.`,
    });
    finish({ ok: false, stage: "link", diagnostics, linkMs });
    return;
  }
  finish({ ok: true, stage: "link", wasm, diagnostics, linkMs }, [wasm.buffer]);
}

/** A failure's reason for the user, never empty: browsers can reject with a blank message or a non-Error. */
const reason = (e: unknown, fallback: string) =>
  (e instanceof Error && e.message) || (typeof e === "string" && e) || fallback;

self.onmessage = async ({ data }: MessageEvent<ToCompiler>) => {
  switch (data.type) {
    case "check":
      post({ type: "pack", installed: await isInstalled() });
      return;
    case "download":
      try {
        await download();
        post({ type: "pack", installed: true });
      } catch (e) {
        post({ type: "download-failed", error: reason(e, "the connection was interrupted") });
      }
      return;
    case "boot": {
      const t0 = performance.now();
      booting ??= boot();
      try {
        api = await booting;
        post({ type: "ready", ms: performance.now() - t0 });
      } catch (e) {
        booting = null;
        api = null;
        post({ type: "boot-failed", error: reason(e, "the compiler could not be loaded") });
        // A part of the pack went missing: say the pack is absent, so the page offers the
        // download again (with this error as the reason) rather than a dead end.
        if (!(await isInstalled())) post({ type: "pack", installed: false });
      }
      return;
    }
    case "build":
      try {
        await build(data);
      } catch (e) {
        // A bug in this worker, or memfs trapped: report it and let the page start a fresh worker.
        post({
          type: "built", id: data.id, ok: false, stage: "compile", compileMs: 0, linkMs: 0, compiled: 0, reused: 0, recycle: true,
          internalError: reason(e, "unknown error"),
          diagnostics: [{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "clang", message: `The compiler failed (${reason(e, "unknown error")}). Press Run again.` }],
        });
      }
  }
};
