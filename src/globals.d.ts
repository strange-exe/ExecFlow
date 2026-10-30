/** ExecFlow's version, package.json's, injected by vite.config.ts ("0.7.0"). */
declare const __APP_VERSION__: string;

/** Pyodide's folder, "<version>-heap<MB>", injected by vite.config.ts; the runtime is served from /pyodide/<folder>/. */
declare const __PYODIDE_DIR__: string;

/** Bytes Python's first start downloads (every file of its runtime); 0 when not known. Set by vite.config.ts. */
declare const __PYODIDE_BYTES__: number;

/**
 * Each runtime file's size and sha256 (lowercase hex) by name (python-download.ts RUNTIME_FILES);
 * empty only in unit tests. Set by vite.config.ts.
 */
declare const __PYODIDE_FILES__: Record<string, { bytes: number; sha256: string }>;

/** The site's old address ("https://code-editor.abhinesh.codes"), set by vite.config.ts: it shows the move banner. */
declare const __MOVE_FROM__: string;

/** The site's new address ("https://execflow.abhinesh.codes"), set by vite.config.ts: it receives moved files. */
declare const __MOVE_TO__: string;

/** The C/C++ pack manifest written by scripts/fetch-clang.mjs, injected by vite.config.ts. */
declare const __CLANG_PACK__: {
  version: string;
  source: string;
  totalBytes: number;
  files: Record<string, { path: string; gzip: boolean; bytes: number; rawBytes: number; sha256: string }>;
};
