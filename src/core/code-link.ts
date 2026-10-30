// Code links (.claude/tasks/code-links.md): one file carried in the link itself, so it opens in
// ExecFlow with no account and nothing stored anywhere.
//   https://<origin>/#code=1.<base64url(deflate-raw(UTF-8 JSON {"n": name, "t": text}))>
// The code is in the fragment, which the browser never sends to a server or puts in a Referer
// (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer). Compression is the
// browser's own CompressionStream "deflate-raw" (Baseline since May 2023,
// https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream/CompressionStream), detected,
// never assumed. A link is at most MAX_LINK_CHARS long: RFC 9110 section 4.1 recommends that senders
// and recipients support URIs of at least 8000 octets (https://www.rfc-editor.org/rfc/rfc9110#section-4.1),
// and chat apps keep such a link whole.
// Reading a link treats it as hostile: its length is capped before decoding, the inflated size is
// capped while it streams (a deflate bomb stops at the cap, never fully in memory), the JSON must
// have exactly the two string fields, the name must be one valid file name, and the text passes the
// checks every imported file passes (no control or text-direction characters). Pure but for the
// browser's compression streams.
//
// Format 2 (0.18.0, owner's picks 2026-10-30) carries a folder: several files under one folder name,
//   #code=2.<base64url(deflate-raw(UTF-8 JSON {"d": folder, "f": [{"n": path, "t": text}, ...]}))>
// within the same length and size caps, at most MAX_LINK_FILES files. The folder name is one name;
// each path is relative to it, at most MAX_LINK_DEPTH deep, and two files may not land on one file
// (names compared as storage compares them) or a file sit where another file's folder is.
import { foldKey, normalizePath, PathError } from "./paths";
import { checkText } from "./safety";

export const CODE_LINK_MARK = "#code=";
const VERSION = "1.";
const FOLDER_VERSION = "2.";
/** The longest link made or read (RFC 9110's recommended minimum URI support). */
export const MAX_LINK_CHARS = 8000;
/** The most a link's content may inflate to (far above what MAX_LINK_CHARS can hold of real code). */
export const MAX_INFLATED_BYTES = 256 * 1024;
/** The most files a folder link holds, and how deep its paths go (folders inside the shared one). */
export const MAX_LINK_FILES = 50;
export const MAX_LINK_DEPTH = 8;
const FORMAT = "deflate-raw";

export interface SharedFile {
  name: string;
  text: string;
}

/** A folder from a link: its name, and its files with paths relative to it. */
export interface SharedFolder {
  name: string;
  files: SharedFile[];
}

export type MakeRefusal =
  | { kind: "unsupported" }
  | { kind: "not-text"; reason: string }
  /** `chars`: the link's length, null when the file is too big to try. */
  | { kind: "too-long"; chars: number | null }
  /** Folder links: no files, or more than MAX_LINK_FILES. */
  | { kind: "empty" }
  | { kind: "too-many" };

export type ReadRefusal = { kind: "unsupported" } | { kind: "damaged" } | { kind: "too-big" } | { kind: "too-many" } | { kind: "bad-name"; reason: string } | { kind: "not-text"; reason: string };

/** Whether this browser has the compression streams code links need. */
export function canCompress(): boolean {
  try {
    new CompressionStream(FORMAT);
    new DecompressionStream(FORMAT);
    return true;
  } catch {
    return false;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream(FORMAT));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The inflated bytes, "too-big" as soon as they pass `cap`, null when the data isn't valid deflate. */
async function inflate(bytes: Uint8Array, cap: number): Promise<Uint8Array | "too-big" | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(FORMAT)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        void reader.cancel().catch(() => {});
        return "too-big";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The link for `name` holding `text`, opening at `origin` (e.g. "https://execflow.abhinesh.codes"). */
export async function makeCodeLink(origin: string, name: string, text: string): Promise<{ ok: true; url: string } | { ok: false; refusal: MakeRefusal }> {
  if (!canCompress()) return { ok: false, refusal: { kind: "unsupported" } };
  const checked = checkText(text);
  if (!checked.ok) return { ok: false, refusal: { kind: "not-text", reason: checked.reason } };
  const json = new TextEncoder().encode(JSON.stringify({ n: name, t: text }));
  // More than a link may inflate to can't be opened anyway: refused without compressing it.
  if (json.length > MAX_INFLATED_BYTES) return { ok: false, refusal: { kind: "too-long", chars: null } };
  const url = `${origin}/${CODE_LINK_MARK}${VERSION}${toBase64Url(await deflate(json))}`;
  if (url.length > MAX_LINK_CHARS) return { ok: false, refusal: { kind: "too-long", chars: url.length } };
  return { ok: true, url };
}

/**
 * The link for a folder named `folder` holding `files` (paths relative to it), opening at `origin`.
 * The caller passes workspace files, so their paths are already valid; the reader checks them anyway.
 */
export async function makeFolderLink(origin: string, folder: string, files: readonly SharedFile[]): Promise<{ ok: true; url: string } | { ok: false; refusal: MakeRefusal }> {
  if (!files.length) return { ok: false, refusal: { kind: "empty" } };
  if (files.length > MAX_LINK_FILES) return { ok: false, refusal: { kind: "too-many" } };
  if (!canCompress()) return { ok: false, refusal: { kind: "unsupported" } };
  for (const f of files) {
    const checked = checkText(f.text);
    if (!checked.ok) return { ok: false, refusal: { kind: "not-text", reason: `${f.name}: ${checked.reason}` } };
  }
  const json = new TextEncoder().encode(JSON.stringify({ d: folder, f: files.map((f) => ({ n: f.name, t: f.text })) }));
  if (json.length > MAX_INFLATED_BYTES) return { ok: false, refusal: { kind: "too-long", chars: null } };
  const url = `${origin}/${CODE_LINK_MARK}${FOLDER_VERSION}${toBase64Url(await deflate(json))}`;
  if (url.length > MAX_LINK_CHARS) return { ok: false, refusal: { kind: "too-long", chars: url.length } };
  return { ok: true, url };
}

/** Whether `hash` (location.hash) is a code link, of any version. */
export function isCodeLink(hash: string): boolean {
  return hash.startsWith(CODE_LINK_MARK);
}

type Fail = { ok: false; refusal: ReadRefusal };
const fail = (refusal: ReadRefusal): Fail => ({ ok: false, refusal });
/** An object with exactly these keys (JSON.parse makes own, plain-data keys, "__proto__" included). */
const isRecord = (value: unknown, keys: string): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;

/** The file (format 1) or folder (format 2) a code link's fragment (location.hash) carries, or why it can't be opened. */
export async function readCodeLink(hash: string): Promise<{ ok: true; file: SharedFile } | { ok: true; folder: SharedFolder } | Fail> {
  if (!isCodeLink(hash) || hash.length > MAX_LINK_CHARS) return fail({ kind: hash.length > MAX_LINK_CHARS ? "too-big" : "damaged" });
  const body = hash.slice(CODE_LINK_MARK.length);
  const version = body.startsWith(VERSION) ? VERSION : body.startsWith(FOLDER_VERSION) ? FOLDER_VERSION : null;
  if (!version) return fail({ kind: "damaged" });
  if (!canCompress()) return fail({ kind: "unsupported" });
  const packed = fromBase64Url(body.slice(version.length));
  if (!packed) return fail({ kind: "damaged" });
  const inflated = await inflate(packed, MAX_INFLATED_BYTES);
  if (inflated === "too-big") return fail({ kind: "too-big" });
  if (!inflated) return fail({ kind: "damaged" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflated));
  } catch {
    return fail({ kind: "damaged" });
  }
  if (version === FOLDER_VERSION) return readFolder(parsed);
  const record = parsed as Record<string, unknown>;
  if (!isRecord(parsed, "n,t") || typeof record.n !== "string" || typeof record.t !== "string") return fail({ kind: "damaged" });
  let name: string;
  try {
    name = normalizePath(record.n);
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return fail({ kind: "bad-name", reason: e.message });
  }
  if (name.includes("/")) return fail({ kind: "bad-name", reason: "it names a folder, and a code link holds one file" });
  const checked = checkText(record.t);
  if (!checked.ok) return fail({ kind: "not-text", reason: checked.reason });
  const lf = toLf(record.t);
  if (!lf.ok) return fail({ kind: "not-text", reason: lf.reason });
  return { ok: true, file: { name, text: lf.text } };
}

/** A folder link's JSON, checked: its shape, the folder's name, every path and every text. */
function readFolder(parsed: unknown): { ok: true; folder: SharedFolder } | Fail {
  if (!isRecord(parsed, "d,f") || typeof parsed.d !== "string" || !Array.isArray(parsed.f) || !parsed.f.length) return fail({ kind: "damaged" });
  if (parsed.f.length > MAX_LINK_FILES) return fail({ kind: "too-many" });
  const entries = parsed.f as unknown[];
  if (!entries.every((e) => isRecord(e, "n,t") && typeof e.n === "string" && typeof e.t === "string")) return fail({ kind: "damaged" });
  let folder: string;
  const files: SharedFile[] = [];
  try {
    folder = normalizePath(parsed.d);
    if (folder.includes("/")) return fail({ kind: "bad-name", reason: "the folder's name is a path, not one name" });
    const taken = new Set<string>();
    for (const e of entries as { n: string; t: string }[]) {
      const name = normalizePath(e.n);
      if (name.split("/").length > MAX_LINK_DEPTH) return fail({ kind: "bad-name", reason: `${name} is in folders nested more than ${MAX_LINK_DEPTH} deep` });
      if (taken.has(foldKey(name))) return fail({ kind: "bad-name", reason: `two files would both be ${name}` });
      taken.add(foldKey(name));
      const checked = checkText(e.t);
      if (!checked.ok) return fail({ kind: "not-text", reason: `${name}: ${checked.reason}` });
      const lf = toLf(e.t);
      if (!lf.ok) return fail({ kind: "not-text", reason: `${name}: ${lf.reason}` });
      files.push({ name, text: lf.text });
    }
    // A file where another file's folder is (src, and src/a.c) can't both be stored.
    for (const f of files) {
      const parts = f.name.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (taken.has(foldKey(dir))) return fail({ kind: "bad-name", reason: `${dir} is both a file and a folder` });
      }
    }
  } catch (e) {
    if (!(e instanceof PathError)) throw e;
    return fail({ kind: "bad-name", reason: e.message });
  }
  return { ok: true, folder: { name: folder, files } };
}

/**
 * Text with LF line endings, as storage keeps every file. Windows line endings throughout become
 * LF; a lone carriage return or a mix is refused, so the preview never offers a file that Add can't
 * store. Stricter than a file import (core/bytes), which also refuses a mix but converts a file
 * whose only line ending is CR.
 */
function toLf(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (!text.includes("\r")) return { ok: true, text };
  const rest = text.replaceAll("\r\n", "");
  if (rest.includes("\r")) return { ok: false, reason: "it contains carriage returns that don't end a line, so it is probably not a text file" };
  if (rest.includes("\n")) return { ok: false, reason: "it mixes different line endings" };
  return { ok: true, text: text.replaceAll("\r\n", "\n") };
}

/** One sentence for a link that couldn't be opened. */
export function readRefusalText(refusal: ReadRefusal): string {
  switch (refusal.kind) {
    case "unsupported":
      return "This browser can't open code links. Open the link in a current Chrome, Edge, Firefox or Safari.";
    case "damaged":
      return "This code link is damaged or incomplete (it may have been cut off when it was sent), so nothing was opened. Ask for the link again.";
    case "too-big":
      return "This code link holds more than a code link can, so nothing was opened. Ask for the file another way.";
    case "too-many":
      return `This code link holds more than ${MAX_LINK_FILES} files, more than a code link may, so nothing was opened. Ask for the files as a .zip.`;
    case "bad-name":
      return `This code link's file name can't be used (${refusal.reason}), so nothing was opened.`;
    case "not-text":
      return `This code link wasn't opened: ${refusal.reason}.`;
  }
}
