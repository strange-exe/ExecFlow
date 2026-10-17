// Downloads the Python packages CodeEditor serves itself (PYTHON_PACKAGES in
// src/runner/python-packages.ts: numpy, pandas and what they depend on) from Pyodide's official CDN
// for the pinned Pyodide version, checks each file against the sha256 in pyodide-lock.json, keeps
// a local cache in node_modules/.cache/, and copies the files into public/pyodide/<version>-heap<MB>/
// next to the runtime. The lock file names wheels relative to itself, so Pyodide's loadPackage()
// finds them there, and the folder's immutable caching applies.
//
// Base URL: https://cdn.jsdelivr.net/pyodide/v<version>/full/ (the pattern on
// https://pyodide.org/en/stable/usage/downloading-and-deploying.html, which documents 314.0.7).
//
// Runs after copy-pyodide.mjs (npm's predev/prebuild), which empties public/pyodide/. Nothing it
// downloads is ever executed: files are only hashed and copied. Usage: node scripts/fetch-pyodide-packages.mjs
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON_PACKAGES, packageClosure } from "../src/runner/python-packages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "node_modules", "pyodide", "package.json"), "utf8"));
const { mb } = JSON.parse(await readFile(join(root, "scripts", "python-heap.json"), "utf8"));
const dir = `${version}-heap${mb}`;
const target = join(root, "public", "pyodide", dir);
const cache = join(root, "node_modules", ".cache", "codeeditor-pyodide-packages", version);
const base = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

/** No wheel we ship is near this; anything bigger is not what the lock file describes. */
const MAX_BYTES = 64 * 1024 * 1024;
const ATTEMPTS = 4;
const TIMEOUT_MS = 120_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Streams `url` into memory, refusing more than MAX_BYTES. */
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} for ${url}`);
    error.permanent = res.status === 404 || res.status === 410;
    throw error;
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`${url} is ${declared} bytes, more than the ${MAX_BYTES} allowed`);
  const parts = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`${url} is larger than the ${MAX_BYTES} bytes allowed`);
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

/** The verified bytes of one wheel: from the cache if it is intact, otherwise from the CDN (retried). */
async function wheel(file, expected) {
  const cached = await readIfPresent(join(cache, file));
  if (cached && sha256(cached) === expected) return { bytes: cached, from: "cache" };
  const url = base + file;
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const bytes = await download(url);
      const got = sha256(bytes);
      if (got !== expected) throw new Error(`${file}: sha256 ${got} doesn't match pyodide-lock.json (${expected})`);
      await mkdir(cache, { recursive: true });
      const part = join(cache, `${file}.part`);
      await writeFile(part, bytes);
      await rename(part, join(cache, file));
      return { bytes, from: "CDN" };
    } catch (e) {
      lastError = e;
      if (e.permanent) break;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`couldn't download ${file} from ${base}: ${lastError?.message ?? lastError}`);
}

const lockPath = join(target, "pyodide-lock.json");
const lockText = await readIfPresent(lockPath);
if (!lockText) throw new Error(`${lockPath} is missing: run \`node scripts/copy-pyodide.mjs\` first (npm run dev/build do).`);
const lock = JSON.parse(lockText.toString("utf8"));
const names = packageClosure(lock, PYTHON_PACKAGES);

let total = 0;
for (const name of names) {
  const { file_name: file, sha256: expected } = lock.packages[name];
  // The lock file comes from the npm package; still, only plain wheel names and real hashes get through.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*\.whl$/.test(file)) throw new Error(`pyodide-lock.json: unexpected file name for ${name}: ${file}`);
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`pyodide-lock.json: no sha256 for ${name}`);
  const { bytes, from } = await wheel(file, expected);
  const dest = join(target, file);
  const existing = await readIfPresent(dest);
  if (!existing || sha256(existing) !== expected) {
    await rm(dest, { force: true });
    await copyFile(join(cache, file), dest);
  }
  total += bytes.length;
  console.log(`  ${file} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${from}, sha256 ok)`);
}
console.log(`${names.length} Python packages for Pyodide ${version} in public/pyodide/${dir} (${(total / 1024 / 1024).toFixed(1)} MB): ${names.join(", ")}`);
