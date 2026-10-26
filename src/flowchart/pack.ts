// The flowchart's parser files: the tree-sitter runtime and one grammar per language, all
// WebAssembly. scripts/fetch-flowchart-grammars.mjs puts them in public/flowchart/<FLOWCHART_DIR>/
// (npm's predev/prebuild run it); the flowchart worker downloads them from /flowchart/<FLOWCHART_DIR>/
// the first time a chart is asked for, and checks each file's sha256 against the pins below.
//
// The grammars come from their npm packages' published .wasm (jsDelivr). The packages themselves
// are never installed: they are Node native add-ons with install scripts, and only the .wasm is
// needed. The runtime's .wasm comes from the installed web-tree-sitter package (package-lock.json
// pins its integrity). The folder name carries every version, so a new version is a new URL: the
// files are served as immutable and runtime-cached by the service worker under that name.

/** Every language the editor runs has a flowchart (protocol.ts checks this matches LanguageId). */
export type FlowLanguage = "c" | "cpp" | "python";

export interface PackFile {
  /** File name inside the folder. */
  file: string;
  sha256: string;
  /** Where the build gets it: a CDN URL, or a path under node_modules/. */
  from: { url: string } | { nodeModules: string };
}

export const RUNTIME_VERSION = "0.27.1";

export const RUNTIME: PackFile = {
  file: "web-tree-sitter.wasm",
  sha256: "beca80e44cccbf2299ed4d1e3fa6462a9a6fe818aeebf847547a392227ce4acc",
  from: { nodeModules: "web-tree-sitter/web-tree-sitter.wasm" },
};

const cdn = (pkg: string, version: string, file: string) => `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${file}`;

export const GRAMMARS: Record<FlowLanguage, PackFile & { version: string }> = {
  c: {
    file: "tree-sitter-c.wasm",
    version: "0.24.1",
    sha256: "c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9",
    from: { url: cdn("tree-sitter-c", "0.24.1", "tree-sitter-c.wasm") },
  },
  cpp: {
    file: "tree-sitter-cpp.wasm",
    version: "0.23.4",
    sha256: "174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf",
    from: { url: cdn("tree-sitter-cpp", "0.23.4", "tree-sitter-cpp.wasm") },
  },
  python: {
    file: "tree-sitter-python.wasm",
    version: "0.25.0",
    sha256: "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47",
    from: { url: cdn("tree-sitter-python", "0.25.0", "tree-sitter-python.wasm") },
  },
};

/** The versioned folder under public/flowchart/ (and the URL path /flowchart/<dir>/). */
export const FLOWCHART_DIR = `ts${RUNTIME_VERSION}-c${GRAMMARS.c.version}-cpp${GRAMMARS.cpp.version}-py${GRAMMARS.python.version}`;

/** Every file in the folder. */
export const PACK_FILES: PackFile[] = [RUNTIME, GRAMMARS.c, GRAMMARS.cpp, GRAMMARS.python];

/** The largest file we accept (tree-sitter-cpp.wasm, the biggest, is 3.3 MB). */
export const MAX_PACK_FILE_BYTES = 8 * 1024 * 1024;
