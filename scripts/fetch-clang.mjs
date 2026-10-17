// Fetches the C/C++ toolchain (clang + lld compiled to WebAssembly, from binji/wasm-clang)
// at a pinned commit, verifies every file's SHA-256, and writes the "C/C++ pack" that the
// app downloads on demand into public/clang/<commit>/.
//
// The big binaries are stored gzipped: clang is 29.8 MiB raw, over Cloudflare Pages'
// 25 MiB per-file limit, and gzip cuts the student's one-time download from ~60 MB to ~19 MB.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const COMMIT = "648c4a89997a351eef75cdaec3ef5b89d4937dec";
const SOURCE = `https://raw.githubusercontent.com/binji/wasm-clang/${COMMIT}`;
const FILES = {
  clang: { sha256: "2a466f0e990329d3230b869d04fc20803eae96a7feb3a3f6c93e25a77b8aed1d", out: "clang.wasm.gz", gzip: true },
  lld: { sha256: "36419ed202011765222098d7701218378b67f634d50f0a4625059ae2c9860f48", out: "lld.wasm.gz", gzip: true },
  "sysroot.tar": { sha256: "2435a7b549af30c2be7ec249c405bc2e911ab0c6003012f0909ec3c131bff867", out: "sysroot.tar.gz", gzip: true },
  memfs: { sha256: "2c72ee42bd9430029dda8c6bafc9f37143f6fe88d5f1ea950a70259ab748bcfe", out: "memfs.wasm", gzip: false },
  "LICENSE.llvm": { sha256: "ebcd9bbf783a73d05c53ba4d586b8d5813dcdf3bbec50265860ccc885e606f47", out: "LICENSE.llvm.txt", gzip: false },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "node_modules", ".cache", "wasm-clang", COMMIT);
const version = COMMIT.slice(0, 8);
const base = join(root, "public", "clang");
const outDir = join(base, version);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(name, expected) {
  const cached = join(cacheDir, name);
  try {
    const buf = await readFile(cached);
    if (sha256(buf) === expected) return buf;
  } catch {}
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${SOURCE}/${name}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== expected) throw new Error(`sha256 mismatch: got ${got}`);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cached, buf);
      return buf;
    } catch (e) {
      console.warn(`  ${name}: attempt ${attempt} failed (${e.message})`);
      if (attempt === 4) throw new Error(`could not download ${name} from ${SOURCE}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

await rm(base, { recursive: true, force: true }); // drop packs from older commits
await mkdir(outDir, { recursive: true });
const manifest = { version, source: `binji/wasm-clang@${COMMIT}`, files: {} };
for (const [name, spec] of Object.entries(FILES)) {
  const raw = await download(name, spec.sha256);
  const body = spec.gzip ? gzipSync(raw, { level: 9 }) : raw;
  await writeFile(join(outDir, spec.out), body);
  manifest.files[name] = { path: spec.out, gzip: spec.gzip, bytes: body.length, rawBytes: raw.length, sha256: spec.sha256 };
}
manifest.totalBytes = ["clang", "lld", "sysroot.tar", "memfs"].reduce((n, k) => n + manifest.files[k].bytes, 0);
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`C/C++ pack ${version}: ${(manifest.totalBytes / 1e6).toFixed(1)} MB in public/clang/${version}`);
