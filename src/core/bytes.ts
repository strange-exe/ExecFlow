// Converting between a workspace file's bytes and the LF text that the editor and runners use.
// GitHub sync must push back exactly the bytes it pulled, so the original line ending and the
// UTF-8 byte order mark are kept beside the text and restored by encodeFileBytes.

export type Eol = "\n" | "\r\n" | "\r";

export type Decoded = { ok: true; text: string; eol: Eol; bom: boolean } | { ok: false; reason: string };

const BOM = [0xef, 0xbb, 0xbf];
const CR = 13;
const LF = 10;

/** Decodes UTF-8 bytes into LF text, recording the line ending and BOM it had. */
export function decodeFileBytes(bytes: Uint8Array): Decoded {
  const bom = bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b);
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, reason: "it isn't UTF-8 text, so it is probably not a source file" };
  }
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === CR) {
      if (body[i + 1] === LF) {
        crlf++;
        i++;
      } else cr++;
    } else if (body[i] === LF) lf++;
  }
  if (Number(crlf > 0) + Number(cr > 0) + Number(lf > 0) > 1) {
    return { ok: false, reason: "it mixes different line endings, so it couldn't be saved back unchanged" };
  }
  const eol: Eol = crlf > 0 ? "\r\n" : cr > 0 ? "\r" : "\n";
  return { ok: true, text: eol === "\n" ? text : text.split(eol).join("\n"), eol, bom };
}

/** The exact bytes of a file whose LF `text` had line ending `eol` and, optionally, a BOM. */
export function encodeFileBytes(text: string, eol: Eol = "\n", bom = false): Uint8Array {
  const body = new TextEncoder().encode(eol === "\n" ? text : text.split("\n").join(eol));
  if (!bom) return body;
  const out = new Uint8Array(body.length + BOM.length);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
}

/** Git's blob id: SHA-1 of "blob <length>", a NUL byte, then the bytes (same as `git hash-object`). */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode("blob " + bytes.length);
  const buf = new Uint8Array(head.length + 1 + bytes.length);
  buf.set(head);
  buf[head.length] = 0;
  buf.set(bytes, head.length + 1);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Blob id of a file as it would be saved: LF `text` restored to its line ending and BOM. */
export function textBlobSha(text: string, eol: Eol = "\n", bom = false): Promise<string> {
  return gitBlobSha(encodeFileBytes(text, eol, bom));
}
