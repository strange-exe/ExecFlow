// Types for the parts of @yowasp/clang's bundle.js that ExecFlow uses (from the package's lib/api.d.ts,
// plus setResourceProvider, ExecFlow's addition).
export type Tree = {
  [name: string]: Tree | string | Uint8Array;
};

export type OutputStream = (bytes: Uint8Array | null) => void;

export type RunOptions = {
  stdin?: ((byteLength: number) => Uint8Array | null) | null;
  stdout?: OutputStream | null;
  stderr?: OutputStream | null;
  decodeASCII?: boolean;
  synchronously?: boolean;
};

/** Runs one LLVM tool by its argv[0] ("clang" for clang -cc1, "wasm-ld"); returns the files it left. */
export type Command = (args?: string[] | null, files?: Tree, options?: RunOptions) => Promise<Tree> | Tree | undefined;

export class Exit extends Error {
  code: number;
  files: Tree;
}

export const runLLVM: Command;
export const runClang: Command;
export const commands: Record<string, Command>;
export const version: string;

/** A tar archive as a Tree (the runtime's own reader; ExecFlow exports it to unpack the sysroot). */
export function unpackTarFilesystem(buffer: ArrayBuffer): Tree;

/** Where the compiler's modules and resource tar come from: "llvm.core.wasm" ... "llvm.core4.wasm", "resources.tar". */
export function setResourceProvider(provider: (name: string) => Promise<Response>): void;
