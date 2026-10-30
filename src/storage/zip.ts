// Workspace export and import as .zip, without a library: CompressionStream("deflate-raw") does
// the compression and a CRC-32 table does the rest (ported from the tested prototype in the
// storage research; the pipe() pattern is Pocket Run's share.ts, same author, MIT).
//
// Writer: method 8 (deflate), or 0 (store) when deflate doesn't shrink an entry; UTF-8 names
// (flag bit 11); sizes written up front (no data descriptors); empty folders as "dir/" entries.
//
// Reader: a zip is untrusted input, so it accepts a strict subset and stops early:
//   - central directory only; methods 0 and 8 only; no ZIP64, encryption or multi-disk archives;
//   - at most 2000 files (plus 2000 folder entries), 1 MiB per file, 50 MiB in total;
//   - declared sizes are not trusted: inflating stops as soon as output passes the declared size,
//     and every file's size and CRC-32 are checked;
//   - names go through normalizePath; "..", absolute paths and drive letters ("Zip Slip") reject
//     the whole archive, other unusable names (".git/...", "con.txt") are refused one by one.

import { normalizePath, PathError } from "../core/paths";
import { BIDI_CONTROL, HIDDEN, MAX_FILE_BYTES } from "../core/safety";
import type { WsPath } from "../core/types";

export interface ZipLimits {
  maxFiles: number;
  maxDirs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxFiles: 2000,
  maxDirs: 2000,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: 50 * 1024 * 1024,
});

export type ZipErrorCode = "not-zip" | "unsupported" | "encrypted" | "too-many" | "too-large" | "unsafe-path" | "corrupt" | "crc";

export class ZipError extends Error {
  override name = "ZipError";
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ZipInputFile {
  path: WsPath;
  bytes: Uint8Array;
  mtime?: number;
}

export interface ZipContents {
  files: { path: WsPath; bytes: Uint8Array }[];
  dirs: WsPath[];
  /** Entries left out, with a plain reason. `name` has invisible and direction characters removed. */
  refused: { name: string; reason: string }[];
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class TooLarge extends Error {}

/** Runs bytes through a (de)compression stream, aborting once output passes maxBytes (bomb guard). */
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxBytes = Infinity): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {}); // failures surface on the read side
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
  }
  return concat(chunks, length);
}

function concat(parts: Uint8Array[], length = parts.reduce((n, p) => n + p.length, 0)): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (Math.min(d.getFullYear() - 1980, 127) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Builds a .zip of `files` (bytes exactly as saved) and empty folders `dirs`. */
export async function writeZip(files: ZipInputFile[], dirs: WsPath[] = [], now = Date.now()): Promise<Uint8Array> {
  if (files.length + dirs.length > 0xfffe) throw new ZipError("too-many", "Too many files for one zip.");
  const enc = new TextEncoder();
  const seen = new Set<string>();
  const entries: { name: string; data: Uint8Array; mtime: number; dir: boolean }[] = [];
  for (const f of files) entries.push({ name: checkedName(f.path, seen), data: f.bytes, mtime: f.mtime ?? now, dir: false });
  for (const d of dirs) entries.push({ name: checkedName(d, seen) + "/", data: new Uint8Array(), mtime: now, dir: true });

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const deflated = e.data.length === 0 ? e.data : await pipe(e.data, new CompressionStream("deflate-raw"));
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : deflated;
    const method = store ? 0 : 8;
    const { time, date } = dosDateTime(e.mtime);
    if (offset + 30 + name.length + body.length > 0xfffffffe) throw new ZipError("too-large", "The files are too large for one zip.");

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, SIG_LOCAL, true);
    head.setUint16(4, 20, true); // version needed: 2.0
    head.setUint16(6, FLAG_UTF8, true);
    head.setUint16(8, method, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, body.length, true);
    head.setUint32(22, e.data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    locals.push(new Uint8Array(head.buffer), name, body);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, SIG_CENTRAL, true);
    cen.setUint16(4, 20, true); // made by: MS-DOS attributes, version 2.0
    cen.setUint16(6, 20, true);
    cen.setUint16(8, FLAG_UTF8, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, e.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(38, e.dir ? 0x10 : 0, true); // MS-DOS directory attribute
    cen.setUint32(42, offset, true); // extra, comment, disk and internal attributes stay 0
    centrals.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

function checkedName(path: string, seen: Set<string>): string {
  let clean: string;
  try {
    clean = normalizePath(path);
  } catch (error) {
    if (error instanceof PathError) throw new ZipError("unsafe-path", `"${path}" can't go in a zip: ${error.message}.`);
    throw error;
  }
  if (clean !== path) throw new ZipError("unsafe-path", `"${path}" isn't a canonical workspace path.`);
  if (seen.has(clean)) throw new ZipError("corrupt", `"${clean}" appears twice.`);
  seen.add(clean);
  return clean;
}

/** An entry name meant to escape the folder it is unpacked into: the archive is hostile. */
function escapes(name: string): boolean {
  if (/^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === "..");
}

const BIDI_ALL = new RegExp(BIDI_CONTROL.source, "g");
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** A name safe to show in a refusal list (it may be hostile). */
function shown(name: string): string {
  return name.replace(BIDI_ALL, "").replace(HIDDEN, "").replace(CONTROL_ALL, "?").slice(0, 300);
}

/** Reads a .zip within `limits`. Throws ZipError for archives that are hostile, broken or unsupported. */
export async function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Promise<ZipContents> {
  const lim: ZipLimits = { ...ZIP_LIMITS, ...limits };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_END) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not-zip", "This isn't a zip file.");
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) throw new ZipError("unsupported", "ZIP64 archives aren't supported.");
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported", "ZIP64 archives aren't supported.");
  if (disk !== 0 || cdDisk !== 0 || diskCount !== count) throw new ZipError("unsupported", "Split (multi-part) zips aren't supported.");
  if (count > lim.maxFiles + lim.maxDirs) throw new ZipError("too-many", `The zip has ${count} entries; at most ${lim.maxFiles} files can be imported.`);
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt", "The zip's directory is damaged.");

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const lossy = new TextDecoder("utf-8");
  const out: ZipContents = { files: [], dirs: [], refused: [] };
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdEnd || view.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError("corrupt", "The zip's directory is damaged.");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nlen = view.getUint16(p + 28, true);
    const xlen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    if (p + 46 + nlen + xlen + clen > cdEnd) throw new ZipError("corrupt", "The zip's directory is damaged.");
    const rawBytes = bytes.subarray(p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) throw new ZipError("encrypted", "Password-protected zips aren't supported.");
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ZipError("unsupported", "ZIP64 archives aren't supported.");

    let raw: string;
    try {
      raw = utf8.decode(rawBytes);
    } catch {
      out.refused.push({ name: shown(lossy.decode(rawBytes)), reason: "its name isn't UTF-8 text" });
      continue;
    }
    if (escapes(raw)) throw new ZipError("unsafe-path", `The zip contains "${shown(raw)}", which points outside the folder it would be unpacked into.`);
    const isDir = raw.endsWith("/");
    const name = isDir ? raw.replace(/\/+$/, "") : raw;
    let path: WsPath;
    try {
      path = normalizePath(name);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      out.refused.push({ name: shown(raw), reason: error.message });
      continue;
    }
    if (seen.has(path)) {
      out.refused.push({ name: shown(raw), reason: "it appears twice in the zip" });
      continue;
    }
    seen.add(path);
    if (isDir) {
      if (out.dirs.length >= lim.maxDirs) throw new ZipError("too-many", `The zip has more than ${lim.maxDirs} folders.`);
      out.dirs.push(path);
      continue;
    }
    if (out.files.length >= lim.maxFiles) throw new ZipError("too-many", `The zip has more than ${lim.maxFiles} files.`);
    if (method !== 0 && method !== 8) {
      out.refused.push({ name: shown(raw), reason: "it is compressed in a way ExecFlow can't unpack" });
      continue;
    }
    if (usize > lim.maxFileBytes) {
      out.refused.push({ name: shown(raw), reason: `it is ${Math.ceil(usize / 1024)} KB; the limit is ${lim.maxFileBytes / 1024} KB` });
      continue;
    }
    if (total + usize > lim.maxTotalBytes) throw new ZipError("too-large", `The files in the zip add up to more than ${lim.maxTotalBytes / (1024 * 1024)} MB.`);

    if (local + 30 > bytes.length || view.getUint32(local, true) !== SIG_LOCAL) throw new ZipError("corrupt", `The zip entry for "${path}" is damaged.`);
    if (view.getUint16(local + 8, true) !== method) throw new ZipError("corrupt", `The zip entry for "${path}" is damaged.`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + csize > cdOffset) throw new ZipError("corrupt", `The zip entry for "${path}" is damaged.`);
    const body = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) {
      if (csize !== usize) throw new ZipError("corrupt", `The zip entry for "${path}" is damaged.`);
      data = body.slice();
    } else {
      try {
        // The declared size is untrusted: stop the moment the output passes it.
        data = await pipe(body, new DecompressionStream("deflate-raw"), usize);
      } catch (error) {
        if (error instanceof TooLarge) throw new ZipError("too-large", `"${path}" unpacks to more than the zip says (a "zip bomb").`);
        throw new ZipError("corrupt", `The zip entry for "${path}" is damaged.`);
      }
    }
    if (data.length !== usize) throw new ZipError("corrupt", `"${path}" doesn't have the size the zip says.`);
    if (crc32(data) !== crc) throw new ZipError("crc", `"${path}" failed its CRC check, so the zip is damaged.`);
    total += data.length;
    out.files.push({ path, bytes: data });
  }
  return out;
}
