// Types for the parts of binji/wasm-clang's shared.js that CodeEditor uses (from Pocket Run, same author, MIT).

// memfs (binji/llvm-project binji/memfs.c) never frees memory, refuses path_remove_directory
// (ENOTCAPABLE), and reuses an unlinked file's inode slot without clearing its contents, so a
// node created later inherits stale data (seen corrupting a directory and then an object file).
// CodeEditor therefore never removes or overwrites anything: every write goes to a fresh path.
export interface MemFS {
  ready: Promise<void>;
  /** Paths have no leading "/". Strings are written as UTF-8. The parent must exist; the path must not. */
  addFile(path: string, contents: string | Uint8Array | ArrayBuffer): void;
  /** Adding a directory that already exists adds a duplicate entry: track what was added. */
  addDirectory(path: string): void;
  /** A live view into memfs memory (copy it with .slice()). Traps if the path doesn't exist. */
  getFileContents(path: string): Uint8Array;
  exports: { memory: WebAssembly.Memory };
}

export interface ApiOptions {
  readBuffer(name: string): Promise<ArrayBuffer>;
  compileStreaming(name: string): Promise<WebAssembly.Module>;
  hostWrite(text: string): void;
  clang?: string;
  lld?: string;
  memfs?: string;
  sysroot?: string;
}

export default class API {
  constructor(options: ApiOptions);
  ready: Promise<void>;
  memfs: MemFS;
  clangFilename: string;
  lldFilename: string;
  clangCommonArgs: string[];
  hostLog(message: string): void;
  hostLogAsync<T>(message: string, promise: Promise<T>): Promise<T>;
  getModule(name: string): Promise<WebAssembly.Module>;
  /** Runs a WASI tool against the shared memfs; rejects when it exits non-zero. */
  run(module: WebAssembly.Module, ...args: string[]): Promise<unknown>;
}
