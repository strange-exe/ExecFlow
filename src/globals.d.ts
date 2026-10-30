/** ExecFlow's version, package.json's, injected by vite.config.ts ("0.7.0"). */
declare const __APP_VERSION__: string;

/** Pyodide's folder, "<version>-heap<MB>", injected by vite.config.ts; the runtime is served from /pyodide/<folder>/. */
declare const __PYODIDE_DIR__: string;

/** Bytes Python's first start fetches (its .wasm, standard library and lock file); 0 when not known. Set by vite.config.ts. */
declare const __PYODIDE_BYTES__: number;

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
