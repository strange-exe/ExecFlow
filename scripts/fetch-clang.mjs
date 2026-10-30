// Fetches the C/C++ toolchain and writes the "C/C++ pack" that the app downloads on demand into
// public/clang/<version>/ (0.17.0: LLVM 22, so C++ exceptions work; trial in the owner's notes).
//
// Two pinned sources, each checked against its published hash before anything is read from it:
//   - @yowasp/clang (npm, ISC): clang + lld for WebAssembly as four wasm modules, and a resource
//     tar. From the resource tar only clang's own builtin headers and libclang_rt.builtins are kept;
//     its C and C++ libraries are the no-exceptions build, so they are dropped.
//   - wasi-sdk-33's sysroot (GitHub release): the wasm32-wasip1 slice only, with the C++ library,
//     libc++abi and libunwind built with exceptions (lib/wasm32-wasip1/eh, include/.../eh/c++/v1).
// The big files are stored gzipped (Cloudflare Pages takes at most 25 MiB per file); the worker
// checks each file's SHA-256 after unzipping it. The tars are written deterministically (sorted,
// time 0), so the same sources always give the same pack and the same hashes.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const YOWASP = {
  version: "22.0.0-git20542-10",
  url: "https://registry.npmjs.org/@yowasp/clang/-/clang-22.0.0-git20542-10.tgz",
  sha512: "V31/z9GrJECKeACTDUyvg2llbEUiFi3bxtL5HSg7H/6sydSxdI/AoVAD9F5ozrfLjotWl0B9rghR87m+DUM/zg==",
};
const WASI_SDK = {
  version: "33",
  url: "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sysroot-33.0%2Bm.tar.gz",
  sha256: "063bc1b56582b9923e08ac9b89e58789618d851763f01530b3ff20b9e5df0ca3",
  root: "wasi-sysroot-33.0+m/",
};
const TARGET = "wasm32-wasip1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "node_modules", ".cache", "clang-pack");
const version = `llvm22-${YOWASP.sha512.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase()}-w${WASI_SDK.version}`;
const base = join(root, "public", "clang");
const outDir = join(base, version);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha512b64 = (buf) => createHash("sha512").update(buf).digest("base64");

async function download(name, url, check) {
  const cached = join(cacheDir, name);
  try {
    const buf = await readFile(cached);
    if (check(buf)) return buf;
  } catch {}
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!check(buf)) throw new Error("hash mismatch");
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cached, buf);
      return buf;
    } catch (e) {
      console.warn(`  ${name}: attempt ${attempt} failed (${e.message})`);
      if (attempt === 4) throw new Error(`could not download ${name} from ${url}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

/**
 * The regular files of a tar archive (ustar, with GNU long names and pax path records), as
 * name -> bytes. Rejects absolute paths and "..", and stops at an entry or size limit.
 */
function untar(buf, { maxEntries = 50_000, maxBytes = 600 * 1024 * 1024 } = {}) {
  const files = new Map();
  const text = (o, n) => buf.toString("utf8", o, o + n).replace(/\0.*$/s, "");
  let longName = null;
  let paxPath = null;
  let total = 0;
  for (let off = 0; off + 512 <= buf.length; ) {
    if (buf[off] === 0) break;
    const size = parseInt(text(off + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    const prefix = text(off + 345, 155);
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${text(off, 100)}` : text(off, 100));
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      paxPath = m ? m[1] : null;
    } else {
      longName = null;
      paxPath = null;
      if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`unsafe path in archive: ${name}`);
      if (type === "0" || type === "\0") {
        if (files.size >= maxEntries) throw new Error("too many entries in archive");
        total += size;
        if (total > maxBytes) throw new Error("archive larger than expected");
        files.set(name.replace(/^\.\//, ""), Buffer.from(body));
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * A deterministic ustar archive of `files` (name -> bytes): sorted, time 0, each folder's entry
 * before its contents. Both tars are read by the YoWASP runtime's own reader (unpackTarFilesystem),
 * which needs those folder entries and reads only the 100-byte name field (no ustar prefix), so a
 * longer name stops the build here rather than breaking the compiler in the browser.
 */
function tar(files) {
  const blocks = [];
  const header = (name, size, type, mode) => {
    if (Buffer.byteLength(name) > 100) throw new Error(`name longer than 100 bytes, which the runtime's tar reader can't read: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write(mode, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const dirs = new Set();
  for (const name of files.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  // Folder names without a trailing "/": the runtime's reader keeps the slash and would then look for a
  // folder named "" inside it (found when the fixtures were re-recorded, 2026-10-30).
  const entries = [...[...dirs].map((d) => [d, null]), ...[...files].map(([n, d]) => [n, d])];
  // Sorted by path, so "a" (the folder) comes before "a/b".
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, data] of entries) {
    if (data === null) {
      blocks.push(header(name, 0, "5", "0000755\0"));
    } else {
      blocks.push(header(name, data.length, "0", "0000644\0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ---------- 1. the compiler ----------
const tgz = await download(`yowasp-clang-${YOWASP.version}.tgz`, YOWASP.url, (b) => sha512b64(b) === YOWASP.sha512);
const pkg = untar(gunzipSync(tgz), { maxEntries: 50, maxBytes: 200 * 1024 * 1024 });
const gen = (f) => {
  const b = pkg.get(`package/gen/${f}`);
  if (!b) throw new Error(`@yowasp/clang ${YOWASP.version} has no gen/${f}`);
  return b;
};

// clang's resource directory (mounted at /usr): its builtin headers (top level of include/, minus
// other CPUs' intrinsics and the GPU/offload ones) and libclang_rt.builtins for WebAssembly.
const OTHER_TARGETS = /^include\/(avx|amx|hexagon|hvx|altivec|vecintrin|opencl|__clang_cuda|__clang_hip|__clang_spirv|arm_|lasx|lsx|riscv_|sifive_|htm|s390|velintrin|mma|ppc|cuda|openmp|llvm_libc|ptrauth|zos|xray|sanitizer|fuzzer|orc|profile)/i;
const resources = new Map();
for (const [name, data] of untar(pkg.has("package/gen/llvm-resources.tar") ? gen("llvm-resources.tar") : Buffer.alloc(0))) {
  const topLevelHeader = /^include\/[^/]+$/.test(name) && !OTHER_TARGETS.test(name);
  const builtins = name.startsWith("lib/wasm32-unknown-wasip1/");
  if (topLevelHeader || builtins) resources.set(name, data);
}
if (!resources.has("lib/wasm32-unknown-wasip1/libclang_rt.builtins.a") || !resources.has("include/stddef.h")) {
  throw new Error("the resource tar no longer has the builtin headers or libclang_rt.builtins");
}

// ---------- 2. the C and C++ libraries (wasi-sdk-33, wasm32-wasip1, with exceptions) ----------
const sysrootTgz = await download(`wasi-sysroot-${WASI_SDK.version}.tar.gz`, WASI_SDK.url, (b) => sha256(b) === WASI_SDK.sha256);
const sysroot = new Map();
for (const [name, data] of untar(gunzipSync(sysrootTgz))) {
  if (!name.startsWith(WASI_SDK.root)) continue;
  const rel = name.slice(WASI_SDK.root.length);
  // Only the exceptions build of the C++ library: its headers (include/.../eh) and archives (lib/.../eh).
  const wanted = (rel.startsWith(`include/${TARGET}/`) || rel.startsWith(`lib/${TARGET}/`)) && !rel.includes("/noeh/") && !rel.includes("/llvm-lto/");
  // Shared libraries are of no use here: programs are linked statically.
  if (wanted && !rel.endsWith(".so")) sysroot.set(rel, data);
}
for (const need of [`lib/${TARGET}/eh/libc++.a`, `lib/${TARGET}/eh/libc++abi.a`, `lib/${TARGET}/eh/libunwind.a`, `lib/${TARGET}/libc.a`, `lib/${TARGET}/crt1-command.o`, `include/${TARGET}/eh/c++/v1/iostream`, `include/${TARGET}/stdio.h`]) {
  if (!sysroot.has(need)) throw new Error(`wasi-sdk-${WASI_SDK.version} sysroot has no ${need}`);
}

// ---------- 3. the pack ----------
await rm(base, { recursive: true, force: true }); // drop packs from older toolchains
await mkdir(outDir, { recursive: true });
const parts = {
  "llvm.core.wasm": { raw: gen("llvm.core.wasm"), gzip: true },
  "llvm.core2.wasm": { raw: gen("llvm.core2.wasm"), gzip: false },
  "llvm.core3.wasm": { raw: gen("llvm.core3.wasm"), gzip: false },
  "llvm.core4.wasm": { raw: gen("llvm.core4.wasm"), gzip: false },
  "resources.tar": { raw: tar(resources), gzip: true },
  "sysroot.tar": { raw: tar(sysroot), gzip: true },
};
const manifest = {
  version,
  source: `@yowasp/clang@${YOWASP.version} + wasi-sdk-${WASI_SDK.version} (${TARGET}, exceptions)`,
  files: {},
};
for (const [name, part] of Object.entries(parts)) {
  const body = part.gzip ? gzipSync(part.raw, { level: 9 }) : part.raw;
  if (body.length > 25 * 1024 * 1024) throw new Error(`${name} is ${body.length} bytes, over Cloudflare Pages' 25 MiB per file`);
  const path = part.gzip ? `${name}.gz` : name;
  await writeFile(join(outDir, path), body);
  manifest.files[name] = { path, gzip: part.gzip, bytes: body.length, rawBytes: part.raw.length, sha256: sha256(part.raw) };
}
manifest.totalBytes = Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0);
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`C/C++ pack ${version}: ${(manifest.totalBytes / 1e6).toFixed(1)} MB in public/clang/${version}`);
