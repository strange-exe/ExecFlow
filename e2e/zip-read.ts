// A small, independent .zip reader for tests (stored and deflated entries), checking every CRC: what
// the app downloads is read by code that shares nothing with the app's own zip writer.
import { crc32, inflateRawSync } from "node:zlib";

export function readZip(zip: Buffer): { files: Map<string, Buffer>; dirs: string[] } {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("no end of central directory");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20); // compressed size
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) {
      dirs.push(name.slice(0, -1));
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, data);
  }
  return { files, dirs };
}
