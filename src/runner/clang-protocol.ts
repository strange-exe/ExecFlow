// Messages for the C/C++ toolchain (adapted from Pocket Run, same author, MIT): a long-lived
// compiler worker (clang + lld, warm across runs, with an object cache) and a disposable runner
// worker that executes one compiled program.

import type { BuildOptions, ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import type { BuildUnit, CLang } from "./program";

export type { BuildUnit, CLang };

export type ToCompiler =
  | { type: "check" }
  | { type: "download" }
  | { type: "boot" }
  | {
      type: "build";
      id: number;
      /** The program's folder; its memfs mount is the -iquote directory. */
      root: WsPath;
      /** Sources and headers the compiler can see (LF text, as the editor shows them). */
      files: WorkspaceFile[];
      /** Compiled in this order (entry first). */
      units: BuildUnit[];
      options: BuildOptions;
    };

export type UnitState = "cached" | "ok" | "failed";

export type FromCompiler =
  | { type: "pack"; installed: boolean }
  | { type: "progress"; loaded: number; total: number }
  | { type: "download-failed"; error: string }
  | { type: "ready"; ms: number }
  | { type: "boot-failed"; error: string }
  /** A build step starts: each one gets its own time limit on the page. */
  | { type: "step"; id: number; step: "compile" | "pch" | "link"; path?: WsPath }
  | { type: "unit"; id: number; path: WsPath; state: UnitState; ms: number; diagnostics: ToolDiagnostic[] }
  | {
      type: "built";
      id: number;
      ok: boolean;
      stage: "compile" | "link";
      /** The linked program (transferred). */
      wasm?: Uint8Array;
      /** Compile warnings and errors of every unit, plus link errors, deduplicated. */
      diagnostics: ToolDiagnostic[];
      compileMs: number;
      linkMs: number;
      compiled: number;
      reused: number;
      /** Set when clang or wasm-ld itself crashed. */
      internalError?: string;
      /** The compiler's memory grew past its budget (or it crashed): the page replaces it. */
      recycle: boolean;
    };

export type ToProgram = {
  type: "run";
  wasm: Uint8Array;
  stdin: string;
  /** Bytes of output kept (the page also counts characters). */
  outputCap: number;
  /** Live input channel (see input-channel.ts); null when the page isn't cross-origin isolated. */
  input: SharedArrayBuffer | null;
  /** Output not posted yet, read by the page before it terminates the worker (cpp-output-tail.ts). */
  tail: SharedArrayBuffer | null;
  args: string[];
  /** The program folder's files, paths relative to that folder. */
  files: { path: string; text: string }[];
};

export type FromProgram =
  /** The worker loaded and got the program (its run time starts now). */
  | { type: "started" }
  | { type: "out"; stream: "stdout" | "stderr"; text: string }
  | { type: "input-request" }
  | {
      type: "done";
      exitCode: number;
      /** Set when the program trapped (stack overflow, bad memory access, abort...). */
      crash?: string;
      truncated: boolean;
      /** Run time, excluding time spent waiting for the user's input. */
      ms: number;
      /** Files the program created or changed (relative to its folder), at most 21 of at most 1 MiB. */
      written: { path: string; bytes: Uint8Array }[];
    };
