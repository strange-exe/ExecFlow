// Workspace paths: "/"-separated, relative to the workspace root, NFC, no leading or trailing "/".
// The same rules guard names the user types, zip imports and paths that arrive from GitHub, so a
// hostile repo or archive can't escape the workspace or plant names that break on Windows or macOS.

import { BIDI_CONTROL, HIDDEN } from "./safety";

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_DEPTH = 32;

export class PathError extends Error {
  override name = "PathError";
}

// HIDDEN is a global regex (lastIndex makes repeated .test() calls alternate), so test a copy.
const HIDDEN_CHAR = new RegExp(HIDDEN.source);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Characters Windows can't store in a file name (backslash included).
const NOT_ON_WINDOWS = /[\\:*?"<>|]/;

function checkSegment(segment: string): void {
  if (segment === "") throw new PathError("a folder name is empty (two slashes in a row)");
  if (segment === "." || segment === "..") throw new PathError(`"${segment}" can't be used as a name`);
  if (segment.toLowerCase() === ".git") throw new PathError(".git folders can't be stored in the workspace");
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) throw new PathError("names can't contain control characters");
  }
  if (BIDI_CONTROL.test(segment)) throw new PathError("names can't contain text-direction characters");
  if (HIDDEN_CHAR.test(segment)) throw new PathError("names can't contain invisible characters");
  if (NOT_ON_WINDOWS.test(segment)) throw new PathError('names can\'t contain \\ : * ? " < > or |');
  if (/[. ]$/.test(segment)) throw new PathError("names can't end with a dot or a space");
  // Length first: the reserved-name message quotes the name, so it never quotes more than a name can hold.
  if (new TextEncoder().encode(segment).length > MAX_SEGMENT_BYTES) throw new PathError("a name is too long");
  if (RESERVED.test(segment)) throw new PathError(`"${segment}" is a reserved name on Windows`);
}

/** Returns the canonical form of `input`, or throws PathError explaining what is wrong with it. */
export function normalizePath(input: string): string {
  const path = input.normalize("NFC");
  if (path === "") throw new PathError("the name is empty");
  if (path.length > MAX_PATH_LENGTH) throw new PathError("the path is too long");
  if (path.startsWith("/") || path.endsWith("/")) throw new PathError("paths can't start or end with /");
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) throw new PathError("folders are nested too deeply");
  segments.forEach(checkSegment);
  return path;
}

/** Like normalizePath, but returns null instead of throwing. */
export function tryNormalizePath(input: string): string | null {
  try {
    return normalizePath(input);
  } catch (e) {
    if (e instanceof PathError) return null;
    throw e;
  }
}

/** "" for a top-level entry. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** True when `path` is `dir` itself or anything below it; every path is inside the root "". */
export function isInside(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(dir + "/");
}

/** Key for spotting names that differ only in case, which collide on Windows and macOS disks. */
export function foldKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** ".bashrc" has no extension; "a.tar.gz" has ".gz". */
export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

// The stamp conflictName adds, then the original extension if there was one.
const CONFLICT_COPY = /\.conflict-\d{8}-\d{6}(-\d+)?(\.[^.]*)?$/;

/** Conflict copies keep their extension but are never compiled or run as part of a program. */
export function isConflictCopy(path: string): boolean {
  return CONFLICT_COPY.test(nameOf(path));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Name for keeping this device's version of `path` beside the other one after a sync conflict:
 * "dir/marks.conflict-20261017-090503.c". `taken` reports names already in use; "-2", "-3"... are added.
 */
export function conflictName(path: string, when: Date, taken: (candidate: string) => boolean): string {
  const { stem, ext } = splitExtension(nameOf(path));
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const base = `${stem}.conflict-${stamp}`;
  for (let n = 1; ; n++) {
    const candidate = joinPath(parentOf(path), `${n === 1 ? base : `${base}-${n}`}${ext}`);
    if (!taken(candidate)) return candidate;
  }
}
