// Code links (.claude/tasks/code-links.md): one file carried in the link itself, so it opens in
// CodeEditor with no account and nothing stored anywhere.
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
import { normalizePath, PathError } from "./paths";
import { checkText } from "./safety";

export const CODE_LINK_MARK = "#code=";
const VERSION = "1.";
/** The longest link made or read (RFC 9110's recommended minimum URI support). */
export const MAX_LINK_CHARS = 8000;
/** The most a link's content may inflate to (far above what MAX_LINK_CHARS can hold of real code). */
export const MAX_INFLATED_BYTES = 256 * 1024;
const FORMAT = "deflate-raw";

export interface SharedFile {
  name: string;
  text: string;
}

export type MakeRefusal =
  | { kind: "unsupported" }
  | { kind: "not-text"; reason: string }
  /** `chars`: the link's length, null when the file is too big to try. */
  | { kind: "too-long"; chars: number | null };

export type ReadRefusal = { kind: "unsupported" } | { kind: "damaged" } | { kind: "too-big" } | { kind: "bad-name"; reason: string } | { kind: "not-text"; reason: string };

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

/** The link for `name` holding `text`, opening at `origin` (e.g. "https://code-editor.abhinesh.codes"). */
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

/** Whether `hash` (location.hash) is a code link, of any version. */
export function isCodeLink(hash: string): boolean {
  return hash.startsWith(CODE_LINK_MARK);
}

/** The file a code link's fragment (location.hash) carries, or why it can't be opened. */
export async function readCodeLink(hash: string): Promise<{ ok: true; file: SharedFile } | { ok: false; refusal: ReadRefusal }> {
  const fail = (refusal: ReadRefusal) => ({ ok: false as const, refusal });
  if (!isCodeLink(hash) || hash.length > MAX_LINK_CHARS) return fail({ kind: hash.length > MAX_LINK_CHARS ? "too-big" : "damaged" });
  const body = hash.slice(CODE_LINK_MARK.length);
  if (!body.startsWith(VERSION)) return fail({ kind: "damaged" });
  if (!canCompress()) return fail({ kind: "unsupported" });
  const packed = fromBase64Url(body.slice(VERSION.length));
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail({ kind: "damaged" });
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "n,t" || typeof record.n !== "string" || typeof record.t !== "string") return fail({ kind: "damaged" });
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
  return { ok: true, file: { name, text: record.t } };
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
    case "bad-name":
      return `This code link's file name can't be used (${refusal.reason}), so nothing was opened.`;
    case "not-text":
      return `This code link wasn't opened: ${refusal.reason}.`;
  }
}
