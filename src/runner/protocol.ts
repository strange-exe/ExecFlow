// Messages between the main thread and the Python worker (adapted from Pocket Run, same author, MIT).
// Everything a worker sends is untrusted. The worker removes `postMessage` from its global scope
// before user code runs (lockdown.ts), but the runner still validates what it reads
// (python-diagnostics.ts, python-files.ts) and never wires a privileged action (sync, saving a
// file) to a worker message.

import type { ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";

// ---------------------------------------------------------------- generic (any language worker)

export type Stream = "stdout" | "stderr";

/** "snapshot": restored from this device's saved memory snapshot; "fresh": a full start-up. */
export type BootSource = "snapshot" | "fresh";

/** Program output, posted as it is written (batched when a program prints in a tight loop). */
export interface OutputMessage {
  type: "out";
  stream: Stream;
  text: string;
}

/**
 * Several outputs, in order, in one message: a program that switches between stdout and stderr
 * would otherwise cost one message per switch (a flood of them was slow to deliver in WebKit).
 */
export interface OutputBatchMessage {
  type: "out-batch";
  parts: { stream: Stream; text: string }[];
}

/** The program wants more input than the Input box had; it waits on the input channel. */
export interface InputRequestMessage {
  type: "input-request";
}

// ---------------------------------------------------------------- Python

export type ToPython =
  | {
      type: "init";
      /** One byte; the page stores 2 (SIGINT) to interrupt. null without cross-origin isolation. */
      interrupt: SharedArrayBuffer | null;
      /** Live input channel (input-channel.ts). null without cross-origin isolation. */
      input: SharedArrayBuffer | null;
      /** Packages to load before the lockdown (names from PYTHON_PACKAGES' closure); [] for the standard library only. */
      packages: string[];
    }
  | {
      type: "run";
      /** Every file of the run, already checked by prepareRunFiles (the worker checks again). */
      files: WorkspaceFile[];
      /** The .py file to run as __main__. */
      entry: WsPath;
      /** Working directory, relative to the workspace root; "" is the root. */
      cwd: string;
      /** The Input box. */
      stdin: string;
      /**
       * true: if the program imports a supported package this worker hasn't loaded, reply
       * need-packages instead of running. false: run anyway (the import fails with a clear note).
       */
      packageCheck: boolean;
      /** Packages that failed to load this session: never asked for again. */
      unavailable: string[];
    }
  | {
      /** Syntax check while idle: compiles `text` without running it or touching the file system. */
      type: "check";
      id: number;
      path: WsPath;
      text: string;
    };

export type FromPython =
  | {
      type: "ready";
      /** Start-up time, packages included. */
      ms: number;
      source: BootSource;
      /** Every package this interpreter has loaded, dependencies included. */
      loaded: string[];
      /** Every package this build can load (PYTHON_PACKAGES and their dependencies). */
      available: string[];
      /** Time spent loading and importing packages (0 without packages). */
      packageMs: number;
    }
  | {
      type: "boot-failed";
      error: string;
      /** false: starting again won't help (a package didn't download), so the runner doesn't retry. */
      retry?: boolean;
    }
  | OutputMessage
  | OutputBatchMessage
  | InputRequestMessage
  | {
      /** The program imports packages this worker doesn't have: start one that does, then run again. */
      type: "need-packages";
      packages: string[];
    }
  | {
      type: "done";
      exitCode: number;
      /** The program stopped because we asked it to (KeyboardInterrupt). */
      interrupted: boolean;
      /** The runtime should be replaced (MemoryError, a shadowed standard module, closed streams...). */
      recycle: boolean;
      /** The program died of a MemoryError. */
      outOfMemory: boolean;
      /** Run time, excluding time spent waiting for typed input. */
      ms: number;
      /** 1-based lines, 0-based UTF-16 columns (unit "utf16", base 0), workspace-relative paths. */
      diagnostics: ToolDiagnostic[];
      /** Text files the program created or changed under the workspace (at most 20, 1 MiB each). */
      written: WorkspaceFile[];
      /** Files the program created or changed that aren't in `written` (binary, too big, over the cap). */
      writtenSkipped: number;
    }
  | { type: "checked"; id: number; diagnostics: ToolDiagnostic[] };
