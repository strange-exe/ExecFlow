// Python's runtime files and the cache that keeps them on a device (python-download.ts). Shared with
// vite.config.ts (the service worker's route for them, and their sizes), so this file imports nothing.

/** The cache the runtime's files are kept in (the service worker's route for them uses it too). */
export const PYTHON_CACHE = "codeeditor-python-runtime";

/** The runtime's files in /pyodide/<__PYODIDE_DIR__>/ (scripts/copy-pyodide.mjs copies them there). */
export const RUNTIME_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"] as const;
