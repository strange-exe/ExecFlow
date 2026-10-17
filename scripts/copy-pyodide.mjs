// Copies the Pyodide runtime from node_modules into public/pyodide/<version>-heap<MB>/ so it is
// served (and precached by the service worker) from our own origin. The folder name carries the
// version and the memory cap, so a change to either is a new URL: the files are cached as immutable,
// and an edited file at an old URL would never reach students who already have it.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pyodide");
const { version } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
// Shared with vite.config.ts, which builds the same folder name.
const { mb } = JSON.parse(await readFile(join(root, "scripts", "python-heap.json"), "utf8"));
const dir = `${version}-heap${mb}`;
const base = join(root, "public", "pyodide");
const to = join(base, dir);
const files = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

await rm(base, { recursive: true, force: true }); // drop runtimes from older versions
await mkdir(to, { recursive: true });
await Promise.all(files.map((f) => copyFile(join(from, f), join(to, f))));

// The loader ends with a link to pyodide.mjs.map, which we don't ship (production builds carry no
// source maps): drop the link, so DevTools doesn't request a file that isn't there.
const loader = join(to, "pyodide.mjs");
const code = await readFile(loader, "utf8");
const link = code.lastIndexOf("//# sourceMappingURL=");
if (link !== -1) await writeFile(loader, code.slice(0, link).trimEnd() + "\n");

// Cap Python's memory, like C and C++'s 256 MB. Pyodide has no runtime option for this: the maximum is an
// Emscripten build setting (4 GB), compiled into the loader as getHeapMax(). Emscripten's heap growth asks
// it before growing, and refuses past it, so malloc fails and Python raises MemoryError at once instead of
// filling gigabytes (which froze WebKit for 20 s+ in testing). If a Pyodide update changes this text, the
// build stops here rather than shipping without the cap.
const asm = join(to, "pyodide.asm.mjs");
const glue = await readFile(asm, "utf8");
const original = "getHeapMax=()=>4294901760";
const found = glue.split(original).length - 1;
if (found !== 1) {
  throw new Error(`pyodide.asm.mjs: expected "${original}" once, found it ${found} times. Re-check the memory cap for Pyodide ${version}.`);
}
const bytes = mb * 1024 * 1024; // a whole number of 64 KiB WebAssembly pages
await writeFile(asm, glue.replace(original, `getHeapMax=()=>${bytes}`));
console.log(`copied ${files.length} Pyodide ${version} files to public/pyodide/${dir} (Python memory capped at ${mb} MB)`);
