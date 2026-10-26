// Puts the flowchart's parser files in public/flowchart/<dir>/ (src/flowchart/pack.ts names the
// folder and pins every file's sha256): the three grammars from jsDelivr, where their npm packages
// publish them (https://cdn.jsdelivr.net/npm/<pkg>@<version>/<file>), and the tree-sitter runtime's
// .wasm from the installed web-tree-sitter package. Downloads are cached in node_modules/.cache/,
// size-capped, retried, timed out and refused unless the sha256 matches; nothing is executed.
//
// Runs after the other runtime steps (npm's predev/prebuild). Usage: node scripts/fetch-flowchart-grammars.mjs
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOWCHART_DIR, MAX_PACK_FILE_BYTES, PACK_FILES } from "../src/flowchart/pack.ts";
import { downloadVerified, sha256Hex } from "../src/flowchart/download.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "public", "flowchart");
const target = join(base, FLOWCHART_DIR);
const cache = join(root, "node_modules", ".cache", "codeeditor-flowchart", FLOWCHART_DIR);

async function readIfPresent(path) {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/** The verified bytes of one file, and where they came from. */
async function bytesOf(spec) {
  if ("nodeModules" in spec.from) {
    const path = join(root, "node_modules", spec.from.nodeModules);
    const bytes = await readIfPresent(path);
    if (!bytes) throw new Error(`${path} is missing: run npm ci first.`);
    const got = await sha256Hex(bytes);
    if (got !== spec.sha256) throw new Error(`${spec.file}: sha256 ${got} doesn't match the pinned ${spec.sha256} (node_modules/${spec.from.nodeModules})`);
    return { bytes, from: "node_modules" };
  }
  const cachedPath = join(cache, spec.file);
  const cached = await readIfPresent(cachedPath);
  if (cached && (await sha256Hex(cached)) === spec.sha256) return { bytes: cached, from: "cache" };
  const bytes = await downloadVerified(spec.from.url, spec.sha256, { maxBytes: MAX_PACK_FILE_BYTES });
  await mkdir(cache, { recursive: true });
  const part = `${cachedPath}.part`;
  await writeFile(part, bytes);
  await rename(part, cachedPath);
  return { bytes, from: "jsDelivr" };
}

// Older folders (other versions) go; this one keeps files that are already right.
await mkdir(base, { recursive: true });
for (const entry of await readdir(base)) {
  if (entry !== FLOWCHART_DIR) await rm(join(base, entry), { recursive: true, force: true });
}
await mkdir(target, { recursive: true });

let total = 0;
for (const spec of PACK_FILES) {
  const { bytes, from } = await bytesOf(spec);
  const dest = join(target, spec.file);
  const existing = await readIfPresent(dest);
  if (!existing || (await sha256Hex(existing)) !== spec.sha256) {
    await rm(dest, { force: true });
    await writeFile(dest, bytes);
  }
  total += bytes.length;
  console.log(`  ${spec.file} (${(bytes.length / 1024).toFixed(0)} KB, ${from}, sha256 ok)`);
}
console.log(`flowchart parser files in public/flowchart/${FLOWCHART_DIR} (${(total / 1024 / 1024).toFixed(1)} MB)`);
