// The workspace a Python run sees: which files are sent, how the worker writes them to its
// in-memory file system (Emscripten MEMFS, mounted at /workspace), and which files a program created
// or changed, so the UI can offer "Add to workspace". The file-system helpers take a minimal FS
// interface so they can be tested without Pyodide.

import { encodeFileBytes } from "../core/bytes";
import { isConflictCopy, tryNormalizePath } from "../core/paths";
import { checkBytes, checkText, MAX_FILE_BYTES } from "../core/safety";
import type { WorkspaceFile, WsPath } from "../core/types";

export const WORKSPACE_ROOT = "/workspace";
export const MAX_RUN_FILES = 2000;
export const MAX_RUN_BYTES = 50 * 1024 * 1024;
/** RunResult.written cap (see core/types.ts). */
export const MAX_WRITTEN_FILES = 20;
/** Entries looked at when listing what a program left behind; a program can create millions. */
export const MAX_SCAN_ENTRIES = 5000;
const MAX_DEPTH = 32;

export type PreparedRun = { ok: true; files: WorkspaceFile[] } | { ok: false; reason: string };

/**
 * The files a run gets: canonical paths only, conflict copies left out, within the caps, and the
 * entry among them. The worker calls this again on what it receives.
 */
export function prepareRunFiles(files: readonly WorkspaceFile[], entry: string): PreparedRun {
  if (tryNormalizePath(entry) !== entry || !entry.endsWith(".py")) return { ok: false, reason: `"${entry}" isn't a Python file in the workspace.` };
  if (isConflictCopy(entry)) return { ok: false, reason: "This is a conflict copy. Rename it to run it." };
  const kept: WorkspaceFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of files) {
    if (typeof f?.path !== "string" || typeof f.text !== "string") return { ok: false, reason: "A file of the run is malformed." };
    if (tryNormalizePath(f.path) !== f.path) return { ok: false, reason: `"${f.path}" isn't a valid workspace path.` };
    if (seen.has(f.path)) return { ok: false, reason: `"${f.path}" is listed twice.` };
    seen.add(f.path);
    if (isConflictCopy(f.path)) continue;
    const size = new TextEncoder().encode(f.text).length;
    if (size > MAX_FILE_BYTES) return { ok: false, reason: `"${f.path}" is larger than ${MAX_FILE_BYTES / 1024} KB.` };
    bytes += size;
    kept.push(f);
  }
  if (kept.length > MAX_RUN_FILES) return { ok: false, reason: `The workspace has more than ${MAX_RUN_FILES} files.` };
  if (bytes > MAX_RUN_BYTES) return { ok: false, reason: `The workspace is larger than ${MAX_RUN_BYTES / 1024 / 1024} MB.` };
  if (!seen.has(entry)) return { ok: false, reason: `"${entry}" isn't in the workspace.` };
  return { ok: true, files: kept };
}

/** The part of Emscripten's FS these helpers use. */
export interface FsLike {
  lstat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
}

function exists(fs: FsLike, path: string): { mode: number; size: number } | null {
  try {
    return fs.lstat(path);
  } catch {
    return null;
  }
}

/**
 * Deletes `path` and everything below it. Uses lstat and never follows links: a program may have
 * made /workspace/x a link to "/", and following it would delete the standard library.
 */
export function removeTree(fs: FsLike, path: string): void {
  const st = exists(fs, path);
  if (!st) return;
  if (!fs.isDir(st.mode)) {
    fs.unlink(path); // files, links, devices and fifos
    return;
  }
  for (const name of fs.readdir(path)) {
    if (name !== "." && name !== "..") removeTree(fs, `${path}/${name}`);
  }
  fs.rmdir(path);
}

/** Replaces the workspace folder with `files`; returns each path's bytes as written. */
export function writeWorkspace(fs: FsLike, files: readonly WorkspaceFile[], root = WORKSPACE_ROOT): Map<WsPath, Uint8Array> {
  removeTree(fs, root);
  fs.mkdirTree(root);
  const sent = new Map<WsPath, Uint8Array>();
  for (const f of files) {
    const slash = f.path.lastIndexOf("/");
    if (slash > 0) fs.mkdirTree(`${root}/${f.path.slice(0, slash)}`);
    const bytes = encodeFileBytes(f.text);
    fs.writeFile(`${root}/${f.path}`, bytes);
    sent.set(f.path, bytes);
  }
  return sent;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Text files under `root` that the program created or changed compared with `sent`, sorted by path.
 * Binary, invalid or oversized files, names that aren't valid workspace paths, and anything past
 * MAX_WRITTEN_FILES are counted in `skipped` instead. Links are never followed.
 */
export function collectWritten(fs: FsLike, sent: ReadonlyMap<WsPath, Uint8Array>, root = WORKSPACE_ROOT): { written: WorkspaceFile[]; skipped: number } {
  const candidates: { path: string; size: number }[] = [];
  let scanned = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdir(dir).filter((n) => n !== "." && n !== "..").sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++scanned > MAX_SCAN_ENTRIES) return;
      const path = rel ? `${rel}/${name}` : name;
      const st = exists(fs, `${dir}/${name}`);
      if (!st) continue;
      if (fs.isDir(st.mode)) {
        if (depth < MAX_DEPTH && name !== "__pycache__") walk(`${dir}/${name}`, path, depth + 1);
      } else if (fs.isFile(st.mode)) {
        candidates.push({ path, size: st.size });
      }
    }
  };
  walk(root, "", 1);

  const written: WorkspaceFile[] = [];
  let skipped = 0;
  for (const { path, size } of candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const before = sent.get(path);
    if (before && before.length === size && sameBytes(before, fs.readFile(`${root}/${path}`))) continue; // unchanged
    if (written.length >= MAX_WRITTEN_FILES || size > MAX_FILE_BYTES || tryNormalizePath(path) !== path) {
      skipped++;
      continue;
    }
    const checked = checkBytes(fs.readFile(`${root}/${path}`));
    if (checked.ok) written.push({ path, text: checked.text });
    else skipped++;
  }
  return { written, skipped };
}

/** Checks the written files a worker message claims to carry (untrusted, see protocol.ts). */
export function checkWritten(raw: unknown): WorkspaceFile[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceFile[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (out.length >= MAX_WRITTEN_FILES) break;
    if (typeof f !== "object" || f === null) continue;
    const { path, text } = f as Record<string, unknown>;
    if (typeof path !== "string" || typeof text !== "string" || tryNormalizePath(path) !== path || seen.has(path)) continue;
    if (text.length > MAX_FILE_BYTES || new TextEncoder().encode(text).length > MAX_FILE_BYTES || !checkText(text).ok) continue;
    seen.add(path);
    out.push({ path, text });
  }
  return out;
}
