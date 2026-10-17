// Typing kept across a reload or a closed tab. Files autosave 400 ms after typing, and pagehide
// starts one last save, but an IndexedDB write started while the page unloads may never finish (a
// reload within 400 ms of typing lost the typing in every engine; closing the tab did in Firefox).
// So when the page is hidden or goes away, unsaved text is also written synchronously to
// localStorage, with a hash of the text it was based on. The next start saves it if the file still
// holds that base text, or else keeps it as a conflict copy: it never overwrites a newer version.
// The key is removed once the page is back (the normal save then has the text) or once it is used.
// "Sign out and clear this computer" removes every codeeditor: key, this one included.
import { tryNormalizePath } from "../core/paths";
import type { WsPath } from "../core/types";

export const recoverKey = (ws: string) => `codeeditor:recover:${ws}`;

export interface StashedFile {
  path: WsPath;
  /** textHash() of the text the typing was based on (loaded or last saved). */
  base: string;
  text: string;
}

/** At most this many characters are stashed in all (localStorage holds about 5 M). */
export const MAX_STASH_CHARS = 2_000_000;

/** A quick hash for telling two texts apart (53-bit cyrb53, public domain); not for security. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** The stash as stored, or null when there is nothing (or too much) to keep. */
export function encodeStash(files: readonly StashedFile[]): string | null {
  if (!files.length) return null;
  let size = 0;
  const kept: StashedFile[] = [];
  for (const f of files) {
    size += f.text.length;
    if (size > MAX_STASH_CHARS) break;
    kept.push({ path: f.path, base: f.base, text: f.text });
  }
  return kept.length ? JSON.stringify({ v: 1, files: kept }) : null;
}

/** Reads a stash back, keeping only well-formed entries with clean workspace paths. */
export function decodeStash(raw: string | null): StashedFile[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== 1) return [];
  const files = (data as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const out: StashedFile[] = [];
  const seen = new Set<string>();
  for (const f of files.slice(0, 50)) {
    if (typeof f !== "object" || f === null) continue;
    const { path, base, text } = f as Record<string, unknown>;
    if (typeof path !== "string" || typeof base !== "string" || typeof text !== "string") continue;
    const clean = tryNormalizePath(path);
    if (clean === null || clean !== path || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ path: clean, base, text });
  }
  return out;
}

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage blocked or full: the last IndexedDB save is all there is
    }
  },
};

export function writeStash(ws: string, files: readonly StashedFile[]): void {
  storage.set(recoverKey(ws), encodeStash(files));
}

export function readStash(ws: string): StashedFile[] {
  return decodeStash(storage.get(recoverKey(ws)));
}

export function dropStash(ws: string): void {
  storage.set(recoverKey(ws), null);
}
