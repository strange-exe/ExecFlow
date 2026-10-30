/// <reference lib="webworker" />
// C/C++ compiler worker (adapted from Pocket Run, same author, MIT): downloads the toolchain pack
// once, keeps the compiler warm, and builds multi-file programs: one clang -cc1 run per translation
// unit (with an object cache across builds), then one wasm-ld link.
//
// 0.17.0: LLVM 22 (YoWASP's clang + lld for WebAssembly) with wasi-sdk-33's C++ library built with
// exceptions, so try / throw / catch work. Every tool run gets its own file tree and returns it:
//   /sysroot                 the C and C++ libraries (wasi-sdk-33, wasm32-wasip1, eh/ build)
//   /usr                     clang's resource directory (its builtin headers, libclang_rt.builtins)
//   /ce/include/bits/stdc++.h   ExecFlow's stand-in for GCC's header
//   /w/<workspace path>      the program's sources and headers (UTF-8)
//   /o/<id>.o /d/<id>.d      the unit's object and depfile
//   /pch/<key>.pch           precompiled <bits/stdc++.h>
//   /rt/init.o               start-up object: unbuffered stdout, so prompts show before scanf
//   /out/main.wasm
// The compile and link flags are the driver's own (clang-jobs.ts): at boot the worker asks the driver
// what it would run for a probe file and keeps that, minus the per-file parts.
import { Exit, runLLVM, setResourceProvider, unpackTarFilesystem, type Tree } from "../vendor/yowasp-clang/bundle.js";
import type { BuildOptions, ToolDiagnostic, WsPath } from "../core/types";
import type { FromCompiler, ToCompiler } from "../runner/clang-protocol";
import { cleanToolOutput, dedupeDiagnostics, parseClangOutput, parseLldOutput, workspaceMap } from "../runner/clang-diagnostics";
import { cc1Template, CE_INCLUDE, linkArgs, linkTemplate, parseDriverJobs, PROBE, PROBES } from "../runner/clang-jobs";
import { checkBuildOptions, includeClosure, semanticArgs, unitArgs, wantsPch } from "../runner/cpp-build";
import { normalizeMemfsPath, parseDepfile } from "../runner/cpp-depfile";
import { MOUNT, memfsPath } from "../runner/program";
import { definesMain } from "../runner/wasm-object";

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: FromCompiler, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

const PACK = __CLANG_PACK__;
const CACHE = `codeeditor-cpp-${PACK.version}`;
const key = (name: string) => `/cpp-pack/${PACK.version}/${name}`;
const COMPLETE = key("complete");
const PCH_LRU = key("pch-lru");
/** What the user downloads: every file the pack lists. */
const TOOLCHAIN = Object.keys(PACK.files);
const PCH_VARIANTS = 3;

// bits/stdc++.h is GCC-only, but students include it constantly; ship an equivalent.
const STDCXX_SHIM = [
  "algorithm", "array", "bitset", "cassert", "cctype", "cerrno", "cfloat", "chrono", "climits", "cmath",
  "complex", "cstdint", "cstdio", "cstdlib", "cstring", "ctime", "deque", "exception", "fstream", "functional",
  "iomanip", "iostream", "iterator", "limits", "list", "map", "memory", "numeric", "optional",
  "queue", "random", "set", "sstream", "stack", "stdexcept", "string", "string_view", "tuple",
  "unordered_map", "unordered_set", "utility", "variant", "vector",
].map((h) => `#include <${h}>`).join("\n") + "\n";
// "#pragma once" lets a precompiled copy stand in for the user's own #include of it.
const STDCXX_HEADER = "#pragma once\n" + STDCXX_SHIM;

const INIT_SOURCE = `#include <stdio.h>
__attribute__((constructor)) static void codeeditor_unbuffered_stdout(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
}
`;

/** Every program: the stack below the data, so an overflow traps; at most 256 MB of memory. */
const LINK_FLAGS = [
  "--no-color-diagnostics", "-z", "stack-size=1048576",
  // Stack below the data: an overflow (a big local array, deep recursion) runs past address 0 and
  // traps, rather than silently overwriting the program's globals and libc's own state.
  "--stack-first",
  // Programs may use at most 256 MB, so a memory bomb can't take the browser down.
  "--max-memory=268435456",
];

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
      // application/wasm: the compiler's modules are compiled straight from the cached response.
      const type = name.endsWith(".wasm") ? "application/wasm" : "application/x-tar";
      await cache.put(key(name), new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": type } }));
    }
  }
  await cache.put(COMPLETE, new Response("ok"));
  post({ type: "progress", loaded: total, total });
  // Packs from older toolchain versions are dead weight.
  for (const name of await caches.keys()) if (name.startsWith("codeeditor-cpp-") && name !== CACHE) await caches.delete(name);
}

// ---------- the compiler ----------

async function cached(name: string): Promise<Response> {
  const hit = await (await caches.open(CACHE)).match(key(name));
  if (!hit) throw new Error(`the C/C++ pack is missing ${name}`);
  return hit;
}

interface Toolchain {
  sysroot: Tree;
  /** cc1 templates per language, from the driver (clang-jobs.ts). */
  common: { c: string[]; cpp: string[] };
  /** The wasm-ld command with {objects} and {output} (clang-jobs.ts). */
  link: string[];
  init: Uint8Array;
}
let toolchain: Toolchain | null = null;
let booting: Promise<Toolchain> | null = null;

/** A file at an absolute path ("/o/a.o") in a tree, or null. */
function fileAt(tree: Tree, path: string): Uint8Array | null {
  let node: Tree | string | Uint8Array | undefined = tree;
  for (const part of path.split("/").filter(Boolean)) {
    if (!node || typeof node === "string" || node instanceof Uint8Array) return null;
    node = node[part];
  }
  return node instanceof Uint8Array ? node : typeof node === "string" ? enc.encode(node) : null;
}

/** Puts `bytes` at an absolute path in a tree, creating its folders. */
function putFile(tree: Tree, path: string, bytes: Uint8Array | string) {
  const parts = path.split("/").filter(Boolean);
  let dir = tree;
  for (const part of parts.slice(0, -1)) {
    const next = dir[part];
    dir = (next && typeof next === "object" && !(next instanceof Uint8Array) ? next : (dir[part] = {})) as Tree;
  }
  dir[parts.at(-1)!] = bytes;
}

/** A fresh tree for one tool run: the libraries, ExecFlow's headers, and the run's own files. */
function treeFor(tc: Pick<Toolchain, "sysroot">, files: [string, Uint8Array | string][] = []): Tree {
  const tree: Tree = { sysroot: tc.sysroot };
  putFile(tree, `${CE_INCLUDE}/bits/stdc++.h`, STDCXX_HEADER);
  for (const [path, bytes] of files) putFile(tree, path, bytes);
  return tree;
}

interface ToolResult {
  ok: boolean;
  text: string;
  /** Set when the tool itself crashed (a trap or a JS error), not when it reported problems. */
  internalError: string | null;
  tree: Tree | null;
}

/** Runs clang (cc1) or wasm-ld in its own file tree; one at a time. */
async function tool(argv: string[], tree: Tree): Promise<ToolResult> {
  let out = "";
  const sink = (bytes: Uint8Array | null) => {
    if (bytes) out += dec.decode(bytes, { stream: true });
  };
  try {
    const result = (await runLLVM(argv, tree, { stdout: sink, stderr: sink, decodeASCII: false })) as Tree;
    return { ok: true, ...cleanToolOutput(out), tree: result };
  } catch (e) {
    if (e instanceof Exit) return { ok: false, ...cleanToolOutput(out), tree: e.files };
    const cleaned = cleanToolOutput(out);
    return { ok: false, text: cleaned.text, internalError: reason(e, "the compiler stopped unexpectedly"), tree: null };
  }
}

/** The driver's plan for a probe, as job lines. Every input must exist: the driver leaves a missing one out. */
async function driverJobs(sysroot: Tree, args: readonly string[]): Promise<string[][]> {
  const r = await tool([...args], treeFor({ sysroot }, [[PROBE.c, "int main(void){return 0;}\n"], [PROBE.cpp, "int main(){}\n"], [PROBE.object, new Uint8Array(0)]]));
  if (r.internalError) throw new Error(`the compiler driver failed (${r.internalError})`);
  return parseDriverJobs(r.text);
}

async function boot(): Promise<Toolchain> {
  setResourceProvider((name) => cached(name));
  // Compiles the compiler's modules and unpacks its resource directory (once per worker).
  await runLLVM(null);
  const sysroot = unpackTarFilesystem(await (await cached("sysroot.tar")).arrayBuffer());
  const common = {
    c: cc1Template(await driverJobs(sysroot, PROBES.c), PROBE.c),
    cpp: cc1Template(await driverJobs(sysroot, PROBES.cpp), PROBE.cpp),
  };
  const link = linkTemplate(await driverJobs(sysroot, PROBES.link));
  const r = await tool(["clang", "-cc1", "-emit-obj", ...common.c, "-O2", "-std=gnu11", "-o", "/rt/init.o", "-x", "c", "/rt/init.c"],
    treeFor({ sysroot }, [["/rt/init.c", INIT_SOURCE]]));
  const init = r.ok && r.tree ? fileAt(r.tree, "/rt/init.o") : null;
  if (!init) throw new Error(`the C/C++ start-up code failed to compile${r.internalError ? ` (${r.internalError})` : ""}`);
  return { sysroot, common, link, init };
}

// ---------- precompiled <bits/stdc++.h> ----------
// Parsing the ~40 headers behind bits/stdc++.h dominates compile time. The key covers the header
// text and every flag that changes its meaning, so a stale PCH is never reused; the 3 most recently
// used variants are kept.

const pchUnavailable = new Set<string>();
const pchBytes = new Map<string, Uint8Array>();

async function pchKey(tc: Toolchain, options: BuildOptions): Promise<string> {
  const id = await hashText([PACK.version, STDCXX_HEADER, ...tc.common.cpp, ...semanticArgs("cpp", options)].join("\n"));
  return id.slice(0, 16);
}
const pchPath = (k: string) => `/pch/${k}.pch`;

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

/** The PCH's bytes for key `k`: from memory, Cache Storage, or built now; null if it can't be had. */
async function ensurePch(tc: Toolchain, k: string, options: BuildOptions, id: number): Promise<Uint8Array | null> {
  if (pchUnavailable.has(k)) return null;
  const known = pchBytes.get(k);
  if (known) return known;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key(`stdcpp-${k}.pch`));
    let bytes: Uint8Array | null;
    if (hit) {
      bytes = new Uint8Array(await hit.arrayBuffer());
    } else {
      post({ type: "step", id, step: "pch" });
      const r = await tool(["clang", "-cc1", "-emit-pch", ...tc.common.cpp, ...semanticArgs("cpp", options),
        "-o", pchPath(k), "-x", "c++-header", `${CE_INCLUDE}/bits/stdc++.h`], treeFor(tc));
      bytes = r.ok && r.tree ? fileAt(r.tree, pchPath(k)) : null;
      if (!bytes) {
        pchUnavailable.add(k);
        return null;
      }
      await cache.put(key(`stdcpp-${k}.pch`), new Response(bytes as Uint8Array<ArrayBuffer>));
    }
    pchBytes.set(k, bytes);
    await touchPchLru(cache, k);
    return bytes;
  } catch {
    pchUnavailable.add(k); // storage full or blocked: compile the slow way
    return null;
  }
}

async function forgetPch(k: string) {
  pchUnavailable.add(k);
  pchBytes.delete(k);
  try { await (await caches.open(CACHE)).delete(key(`stdcpp-${k}.pch`)); } catch { /* best effort */ }
}

// ---------- the object cache ----------

interface UnitRecord {
  argsKey: string;
  srcHash: string;
  /** User files the unit read, with their hashes (from its depfile). */
  deps: [WsPath, string][];
  headerSetKey: string;
  object: Uint8Array;
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

// ---------- build ----------

type BuildMsg = Extract<ToCompiler, { type: "build" }>;

async function build(msg: BuildMsg) {
  const t0 = performance.now();
  const tc = toolchain!;
  const { options, problems } = checkBuildOptions(msg.options);
  const hashes = new Map<WsPath, string>();
  for (const f of msg.files) hashes.set(f.path, await hashText(f.text));
  /** The workspace as the compiler sees it: every source and header under /w. */
  const workspace: [string, Uint8Array][] = msg.files.map((f) => [memfsPath(f.path, MOUNT), enc.encode(f.text)]);
  const byPath = new Map(msg.files.map((f) => [f.path, f]));
  const map = workspaceMap(hashes.keys(), MOUNT);
  const headerSetKey = await hashText([...hashes.keys()].filter((p) => !msg.units.some((u) => u.path === p)).sort().join("\n"));
  const all: ToolDiagnostic[] = problems.map((message) => ({ path: null, line: 1, unit: "utf8-byte", base: 1, severity: "warning", message, source: "clang" }));
  let failed = false;
  let compiled = 0;
  let reused = 0;
  let internalError: string | undefined;
  const includes = new Map<WsPath, WsPath[]>();
  /** Object path in the link tree -> [its unit, its bytes], in unit order (the link order). */
  const objects = new Map<string, [WsPath, Uint8Array]>();

  for (const unit of msg.units) {
    const u0 = performance.now();
    post({ type: "step", id: msg.id, step: "compile", path: unit.path });
    const id = await unitId(unit.path);
    const common = tc.common[unit.lang];
    let k = wantsPch(unit, byPath, msg.root) ? await pchKey(tc, options) : null;
    let pch = k ? await ensurePch(tc, k, options, msg.id) : null;
    if (!pch) k = null;
    const argsKey = await hashText(JSON.stringify([PACK.version, INIT_SOURCE,
      unitArgs({ unit, root: msg.root, common, options, id, pch: k ? pchPath(k) : null, mount: MOUNT })]));
    const record = records.get(unit.path);
    if (record && record.argsKey === argsKey && record.srcHash === hashes.get(unit.path) && record.headerSetKey === headerSetKey &&
      record.deps.every(([p, h]) => hashes.get(p) === h)) {
      reused++;
      objects.set(`/o/${id}.o`, [unit.path, record.object]);
      includes.set(unit.path, record.deps.map(([p]) => p));
      all.push(...record.diagnostics);
      post({ type: "unit", id: msg.id, path: unit.path, state: "cached", ms: performance.now() - u0, diagnostics: record.diagnostics });
      continue;
    }
    records.delete(unit.path); // never reuse an object from before a failed compile
    const compile = () => {
      const files: [string, Uint8Array][] = [...workspace];
      if (k && pch) files.push([pchPath(k), pch]);
      return tool(["clang", ...unitArgs({ unit, root: msg.root, common, options, id, pch: k ? pchPath(k) : null, mount: MOUNT })], treeFor(tc, files));
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
    const parsed = parseClangOutput(r.text, map, memfsPath(unit.path, MOUNT));
    const diagnostics = parsed.diagnostics;
    if (parsed.unparsed.length) {
      diagnostics.push({ path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: r.ok ? "warning" : "error", message: parsed.unparsed.join("\n"), source: "clang" });
    }
    const object = r.ok && r.tree ? fileAt(r.tree, `/o/${id}.o`) : null;
    if (r.internalError) {
      internalError ??= r.internalError;
      diagnostics.push({
        path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: "error", source: "clang",
        message: `The compiler itself crashed on this file (${r.internalError}). Try simplifying the code you changed last.`,
      });
    } else if (!object && !diagnostics.some((d) => d.severity === "error")) {
      diagnostics.push({ path: unit.path, line: 1, unit: "utf8-byte", base: 1, severity: "error", message: "the compiler stopped without saying why", source: "clang" });
    }
    if (object) {
      const depfile = fileAt(r.tree!, `/d/${id}.d`);
      const deps = parseDepfile(depfile ? dec.decode(depfile) : "").map((p) => map(p)).filter((p): p is WsPath => p !== null && p !== unit.path);
      objects.set(`/o/${id}.o`, [unit.path, object]);
      includes.set(unit.path, deps);
      records.set(unit.path, { argsKey, srcHash: hashes.get(unit.path)!, deps: deps.map((p) => [p, hashes.get(p)!]), headerSetKey, object, diagnostics });
    } else {
      failed = true;
      includes.set(unit.path, includeClosure(unit.path, byPath, msg.root));
    }
    all.push(...diagnostics);
    post({ type: "unit", id: msg.id, path: unit.path, state: object ? "ok" : "failed", ms: performance.now() - u0, diagnostics });
  }
  const compileMs = performance.now() - t0;
  const finish = (rest: Omit<Extract<FromCompiler, { type: "built" }>, "type" | "id" | "compileMs" | "compiled" | "reused" | "recycle" | "internalError">, transfer: Transferable[] = []) => {
    post({ type: "built", id: msg.id, compileMs, compiled, reused, recycle: !!internalError, ...(internalError ? { internalError } : {}), ...rest }, transfer);
  };
  if (failed) {
    finish({ ok: false, stage: "compile", diagnostics: dedupeDiagnostics(all), linkMs: 0 });
    return;
  }
  // No main in any file: wasi-libc's weak start-up symbols let it link, and it would trap at start
  // (wasm-object.ts). Say it the way the linker used to, so the help and the "run main.c" offer follow.
  if (!definesMain([...objects.values()].map(([, bytes]) => bytes))) {
    const noMain: ToolDiagnostic = { path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", message: "undefined symbol: main" };
    finish({ ok: false, stage: "link", diagnostics: dedupeDiagnostics([...all, noMain]), linkMs: 0 });
    return;
  }

  post({ type: "step", id: msg.id, step: "link" });
  const l0 = performance.now();
  const program = "/out/main.wasm";
  const linkFiles: [string, Uint8Array][] = [["/rt/init.o", tc.init], ...[...objects].map(([path, [, bytes]]) => [path, bytes] as [string, Uint8Array])];
  const r = await tool(linkArgs(tc.link, ["/rt/init.o", ...objects.keys()], program, LINK_FLAGS), treeFor(tc, linkFiles));
  const linkMs = performance.now() - l0;
  const linkParse = parseLldOutput(r.text, {
    unitOfObject: (obj) => objects.get(normalizeMemfsPath(obj))?.[0] ?? null,
    text: (p) => byPath.get(p)?.text,
    includesOf: (unit) => includes.get(unit) ?? [],
  });
  const linkDiagnostics = linkParse.diagnostics;
  if (linkParse.unparsed.length) {
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: r.ok ? "warning" : "error", message: linkParse.unparsed.join("\n"), source: "wasm-ld" });
  }
  const wasm = r.ok && r.tree ? fileAt(r.tree, program) : null;
  if (r.internalError) {
    internalError ??= r.internalError;
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", message: `The linker itself crashed (${r.internalError}).` });
  } else if (!wasm && !linkDiagnostics.some((d) => d.severity === "error")) {
    linkDiagnostics.push({ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", message: "the linker stopped without saying why" });
  }
  // Compile warnings stay when the link fails: "implicit declaration of gets" explains "undefined symbol: gets".
  const diagnostics = dedupeDiagnostics([...all, ...linkDiagnostics]);
  if (!wasm) {
    finish({ ok: false, stage: "link", diagnostics, linkMs });
    return;
  }
  const out = wasm.slice(); // its own buffer, to transfer
  // A call whose argument types differ from the definition (int f(int, int) declared, double
  // f(double) defined in another file) can still link, and the engine then refuses the module. Say
  // so now, as a link problem, rather than as a crash at start-up.
  if (!WebAssembly.validate(out as Uint8Array<ArrayBuffer>)) {
    let detail = "";
    try { await WebAssembly.compile(out as Uint8Array<ArrayBuffer>); } catch (e) { detail = reason(e, ""); }
    const caller = /function #\d+:?\s*"([^"]+)"/.exec(detail)?.[1]?.replace(/^__original_main$/, "main");
    diagnostics.push({
      path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "wasm-ld", code: "signature-mismatch",
      message: `function signature mismatch: ${caller ? `${caller}() calls` : "the program calls"} a function with other parameter or return types than its definition has. Check that every declaration (in a header or at the top of a file) matches the definition exactly.`,
    });
    finish({ ok: false, stage: "link", diagnostics, linkMs });
    return;
  }
  finish({ ok: true, stage: "link", wasm: out, diagnostics, linkMs }, [out.buffer]);
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
        toolchain = await booting;
        post({ type: "ready", ms: performance.now() - t0 });
      } catch (e) {
        booting = null;
        toolchain = null;
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
        // A bug in this worker, or the compiler trapped: report it and let the page start a fresh worker.
        post({
          type: "built", id: data.id, ok: false, stage: "compile", compileMs: 0, linkMs: 0, compiled: 0, reused: 0, recycle: true,
          internalError: reason(e, "unknown error"),
          diagnostics: [{ path: null, line: 1, unit: "utf16", base: 0, severity: "error", source: "clang", message: `The compiler failed (${reason(e, "unknown error")}). Press Run again.` }],
        });
      }
  }
};
