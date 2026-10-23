// Contracts shared by the storage, sync, runner and editor modules. Each module owns its own
// internals; these types are the only shapes that cross module boundaries.

import type { Eol } from "./bytes";
import type { LanguageId } from "./languages";

export type { Eol, LanguageId };

/** Workspace-relative path in the canonical form produced by core/paths.ts normalizePath. */
export type WsPath = string;

export type EntryKind = "file" | "dir";

/** A file whose bytes can't be edited as text (binary, symlink, submodule, mixed line endings). */
export interface OpaqueBlob {
  sha: string;
  mode: string;
}

/** One entry of the workspace tree, without its content. */
export interface EntryMeta {
  path: WsPath;
  kind: EntryKind;
  /** Bytes of the file as it would be saved (line ending and BOM restored). */
  size: number;
  mtime: number;
  eol: Eol;
  bom: boolean;
  /** Git blob id of the bytes as saved; null while it is being recomputed. */
  localSha: string | null;
  /** Git blob id at the last sync; null when the path has never been synced. */
  baseSha: string | null;
  opaque?: OpaqueBlob;
}

/** A file as handed to a runner: LF text, exactly what the editor shows. */
export interface WorkspaceFile {
  path: WsPath;
  text: string;
}

// ---------------------------------------------------------------- diagnostics

/** How a tool counts columns. Converted to CodeMirror's UTF-16 offsets by editor/positions.ts. */
export type ColumnUnit = "utf8-byte" | "code-point" | "utf16";
export type DiagSeverity = "error" | "warning" | "info" | "hint";
export type DiagSource = "clang" | "wasm-ld" | "python" | "runtime" | "hint";

export interface ToolLocation {
  /** null for a problem with the program as a whole (e.g. no main function). */
  path: WsPath | null;
  /** 1-based. */
  line: number;
  col?: number;
  endLine?: number;
  endCol?: number;
  unit: ColumnUnit;
  /** Whether `col`/`endCol` count from 0 or from 1. Ends are exclusive. */
  base: 0 | 1;
}

export interface ToolDiagnostic extends ToolLocation {
  severity: DiagSeverity;
  message: string;
  source: DiagSource;
  /** Warning flag ("-Wunused-variable") or exception type ("ZeroDivisionError"). */
  code?: string;
  notes?: (ToolLocation & { message: string })[];
  fixes?: (ToolLocation & { insert: string })[];
  /** Python call stack, outermost first, workspace frames only. */
  stack?: ToolLocation[];
  /** Located by searching the source (linker errors), not reported by the tool. */
  heuristic?: boolean;
  /**
   * "call-site": not the tool's own report but a call that led to an error in another place
   * (ui/run-diagnostics.ts). The editor draws it as a dashed outline and a gutter arrow.
   */
  role?: "call-site";
}

// ---------------------------------------------------------------- runs

export interface RunLimits {
  /** Running time; time spent waiting for typed input doesn't count. */
  timeoutMs: number;
  /** Characters of program output kept before the run is stopped. */
  outputCap: number;
}

export interface BuildOptions {
  cStd: string;
  cxxStd: string;
  opt: "0" | "1" | "2";
  /** e.g. ["-Wall"] */
  warnings: string[];
}

export interface RunRequest {
  lang: LanguageId;
  /** The file the user pressed Run on. */
  entry: WsPath;
  /** Every file the program may need: sources, headers and data files. */
  files: WorkspaceFile[];
  /** Text given up front (the Input box); the program asks for more while it runs. */
  stdin: string;
  /** Command-line arguments after the program's name (sys.argv[1:], argv[1..]); none when absent. */
  args?: string[];
  limits: RunLimits;
  build?: BuildOptions;
}

export type RunPhase = "downloading" | "booting" | "compiling" | "linking" | "running";

export type RunStatus =
  | "ok" // exited with code 0
  | "error" // exited non-zero, or an uncaught exception
  | "build-failed"
  | "timeout"
  | "output-limit"
  | "stopped"
  | "crashed" // trap, stack overflow, out of memory
  | "unavailable"; // runtime couldn't start or download

export interface RunHooks {
  onOutput(stream: "stdout" | "stderr", text: string): void;
  /** The program is blocked reading input beyond what was given up front. */
  onInputRequest(): void;
  onPhase(phase: RunPhase, detail?: string): void;
}

export interface RunResult {
  status: RunStatus;
  exitCode: number | null;
  diagnostics: ToolDiagnostic[];
  /** One plain sentence for the output panel when the status alone doesn't explain it. */
  message?: string;
  /** C/C++ only: units left out because they define their own main(). */
  skipped?: WsPath[];
  /**
   * Text files the program created or changed (paths relative to the workspace root), so the UI can
   * offer "Add to workspace". Never written back automatically. Capped at 20 files, 1 MiB each.
   */
  written?: WorkspaceFile[];
  ms: { build?: number; run?: number };
}

// ---------------------------------------------------------------- sync

export interface RemoteMeta {
  provider: "github";
  owner: string;
  repo: string;
  branch: string;
  /** Commit the local workspace was last in step with; null before the first sync. */
  baseCommit: string | null;
  baseTree: string | null;
  refEtag: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  deviceName: string;
}

export interface LocalFileState {
  path: WsPath;
  /** Git blob id of the bytes as saved (never null here: the store computes missing ones first). */
  sha: string;
  eol: Eol;
  bom: boolean;
  opaque?: OpaqueBlob;
}

export interface BaseEntry {
  path: WsPath;
  sha: string;
  mode: string;
}

export interface SyncSnapshot {
  local: Map<WsPath, LocalFileState>;
  base: Map<WsPath, BaseEntry>;
  remote: RemoteMeta | null;
}

/**
 * Everything one sync writes, applied in ONE IndexedDB transaction. Each put/remove carries the
 * local sha the plan was made from (`expect`; "absent" = no file at that path locally; an empty
 * folder there gives way, since git can't hold one). If the file changed since the snapshot, that
 * path is left alone and reported in `skipped`, so the next sync treats it as a local change.
 * Nothing a user typed is ever overwritten.
 */
export interface SyncCommit {
  put: { path: WsPath; text: string; eol: Eol; bom: boolean; sha: string; expect: string | "absent" }[];
  remove: { path: WsPath; expect: string }[];
  /**
   * Repository files kept here as read-only pointers (binary, symlink, submodule, too large, mixed
   * line endings): no text, never edited or pushed. Same `expect` rule as put. A separate field, not
   * a flag on put, so a store that doesn't know it can never save one as an empty text file.
   */
  opaque?: OpaquePut[];
  /**
   * Replaces the base table, EXCEPT that a skipped path keeps its previous base entry (or stays out
   * of the table if it had none). Otherwise the next merge would take the new remote version as the
   * base and push the local edit over it.
   */
  base: BaseEntry[];
  remote: Partial<RemoteMeta>;
}

export interface OpaquePut {
  path: WsPath;
  sha: string;
  mode: string;
  /** Bytes in the repository, when known. */
  size?: number;
  expect: string | "absent";
}

export interface SyncStore {
  /** Metadata only. Computes any missing local shas before returning. */
  snapshot(): Promise<SyncSnapshot>;
  /** LF text of a local file (for conflict copies and pushes). */
  readText(path: WsPath): Promise<string>;
  commit(change: SyncCommit): Promise<{ skipped: WsPath[] }>;
}
