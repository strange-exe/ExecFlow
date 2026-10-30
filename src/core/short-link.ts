// Short links (owner's go-ahead 2026-10-30; the shapes are in server/short-link-shape.ts): a code
// link's content, encrypted in the browser and kept by ExecFlow's own function (server/short-links.ts)
// for 1, 30 or 90 days, so the link stays short whatever the code's length.
//   https://<origin>/s/<id>#<key>
// - The plaintext is a code link's packed content (src/core/code-link.ts Packed): one format byte
//   (1: a file, 2: a folder) and the deflated JSON, within the same caps (50 files, 8 deep, 256 KB of
//   JSON). Opening hands it to readPacked, so a short link meets every check a code link does.
// - The key is a fresh AES-GCM 256-bit key per link, made here with WebCrypto, and lives only in the
//   fragment: the browser never sends a fragment to a server or puts it in a Referer
//   (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer). It is never in a
//   request's URL, header or body. Each link gets a fresh random 96-bit IV
//   (https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams). The additional data names the
//   format, so bytes made for anything else never decrypt as a link.
// - The server sees only `STORED_VERSION | IV | ciphertext+tag`, picks the id and the expiry date.
// - Opening: a wrong key or changed bytes fail GCM's tag check (damaged); an unknown or expired id is
//   gone; no connection is offline. Answers are read to at most MAX_BODY_BYTES.
// Pure but for the deps it is given (fetch, online) and the browser's crypto and compression.
import { IV_BYTES, isLinkId, MAX_BODY_BYTES, MIN_BODY_BYTES, STORED_VERSION, type LinkTtl } from "../../server/short-link-shape";
import { MAX_LINK_FILES, readPacked, readRefusalText, type MakeRefusal, type Packed, type ReadRefusal, type ReadResult } from "./code-link";

export const SHORT_PATH = "/s/";
export const LINKS_API = "/api/links";
const KEY_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const KEY_CHARS = 43;
const AAD = new TextEncoder().encode("ExecFlow short link v1");

export interface ShortDeps {
  /** window.fetch (same-origin paths only). */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** navigator.onLine. */
  online(): boolean;
}

export type ShortMakeRefusal = MakeRefusal | { kind: "offline" } | { kind: "busy" } | { kind: "unavailable" } | { kind: "not-set-up" } | { kind: "failed" };
export type ShortReadRefusal = ReadRefusal | { kind: "gone" } | { kind: "offline" } | { kind: "busy" } | { kind: "unavailable" };

const isB64UrlChar = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The 32-byte key in a fragment of exactly "#" and 43 base64url characters, else null. */
function keyOf(hash: string): Uint8Array | null {
  if (hash.length !== KEY_CHARS + 1 || hash[0] !== "#") return null;
  const text = hash.slice(1);
  for (let i = 0; i < text.length; i++) if (!isB64UrlChar(text.charCodeAt(i))) return null;
  try {
    const binary = atob(`${text.replaceAll("-", "+").replaceAll("_", "/")}=`);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // The last character carries 2 spare bits: only one spelling of a key is accepted.
    return bytes.length === KEY_BYTES && toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

/** The id in a short link's path (/s/<id>), or null for any other path. */
export function shortLinkId(pathname: string): string | null {
  if (!pathname.startsWith(SHORT_PATH)) return null;
  const id = pathname.slice(SHORT_PATH.length);
  return isLinkId(id) ? id : null;
}

/** Reads at most `cap` bytes of an answer; null past it (the rest is never read). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Encrypts `packed` and stores it for `ttl` seconds: the link opening at `origin`, and when it
 * expires (ms since 1970, the server's word). Needs a connection; refusals say why.
 */
export async function makeShortLink(origin: string, packed: Packed, ttl: LinkTtl, deps: ShortDeps): Promise<{ ok: true; url: string; expires: number } | { ok: false; refusal: ShortMakeRefusal }> {
  const refuse = (refusal: ShortMakeRefusal) => ({ ok: false as const, refusal });
  if (typeof crypto === "undefined" || !crypto.subtle) return refuse({ kind: "unsupported" });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new Uint8Array(1 + packed.bytes.length);
  plaintext[0] = packed.format;
  plaintext.set(packed.bytes, 1);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plaintext));
  const body = new Uint8Array(1 + IV_BYTES + sealed.length);
  body[0] = STORED_VERSION;
  body.set(iv, 1);
  body.set(sealed, 1 + IV_BYTES);
  if (body.length > MAX_BODY_BYTES) return refuse({ kind: "too-long", chars: null });
  if (!deps.online()) return refuse({ kind: "offline" });
  let res: Response;
  try {
    // The key is not in this request: only the encrypted bytes and the expiry go.
    res = await deps.fetch(`${LINKS_API}?ttl=${ttl}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    return refuse({ kind: deps.online() ? "failed" : "offline" });
  }
  if (res.status === 429) return refuse({ kind: "busy" });
  if (res.status === 503) return refuse({ kind: "unavailable" });
  if (res.status === 404) return refuse({ kind: "not-set-up" });
  if (res.status === 413) return refuse({ kind: "too-long", chars: null });
  if (res.status !== 201) return refuse({ kind: "failed" });
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    return refuse({ kind: "failed" });
  }
  const { id, expires } = (answer ?? {}) as { id?: unknown; expires?: unknown };
  if (!isLinkId(id) || typeof expires !== "number" || !Number.isSafeInteger(expires) || expires <= 0) return refuse({ kind: "failed" });
  return { ok: true, url: `${origin}${SHORT_PATH}${id}#${toBase64Url(raw)}`, expires: expires * 1000 };
}

/**
 * The file or folder a short link holds: `id` from the path, `hash` (location.hash) the key. A key
 * or id of the wrong shape is damaged before anything is fetched.
 */
export async function openShortLink(id: string, hash: string, deps: ShortDeps): Promise<ReadResult | { ok: false; refusal: ShortReadRefusal }> {
  const refuse = (refusal: ShortReadRefusal) => ({ ok: false as const, refusal });
  const raw = keyOf(hash);
  if (!raw || !isLinkId(id)) return refuse({ kind: "damaged" });
  if (typeof crypto === "undefined" || !crypto.subtle) return refuse({ kind: "unsupported" });
  if (!deps.online()) return refuse({ kind: "offline" });
  let res: Response;
  try {
    res = await deps.fetch(`${LINKS_API}/${id}`, { method: "GET", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    return refuse({ kind: deps.online() ? "unavailable" : "offline" });
  }
  if (res.status === 404) {
    // 404 for an id the store doesn't hold; "not_configured" is the site's set-up, not the link.
    const error = await res.json().then((j: { error?: unknown }) => j?.error, () => null);
    return refuse({ kind: error === "not_configured" ? "unavailable" : "gone" });
  }
  if (res.status === 400) return refuse({ kind: "damaged" });
  if (res.status === 429) return refuse({ kind: "busy" });
  if (res.status !== 200) return refuse({ kind: "unavailable" });
  let stored: Uint8Array | null;
  try {
    stored = await readCapped(res, MAX_BODY_BYTES);
  } catch {
    return refuse({ kind: deps.online() ? "unavailable" : "offline" });
  }
  if (!stored || stored.length < MIN_BODY_BYTES || stored[0] !== STORED_VERSION) return refuse({ kind: "damaged" });
  let plaintext: Uint8Array;
  try {
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
    const iv = stored.slice(1, 1 + IV_BYTES);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, stored.slice(1 + IV_BYTES)));
  } catch {
    // The tag check failed: another key, or bytes changed on the way.
    return refuse({ kind: "damaged" });
  }
  const format = plaintext[0];
  if (plaintext.length < 2 || (format !== 1 && format !== 2)) return refuse({ kind: "damaged" });
  return readPacked({ format, bytes: plaintext.subarray(1) });
}

/** One sentence for a short link that couldn't be made (the share dialogs add what to do instead). */
export function shortMakeRefusalText(refusal: ShortMakeRefusal): string {
  switch (refusal.kind) {
    case "offline":
      return "This device is offline, and a short link is stored on ExecFlow's server, so it can't be made now. Try again once you're online.";
    case "busy":
      return "This network has made a lot of short links in the last hour, so ExecFlow is pausing new ones from it. Try again within the hour.";
    case "unavailable":
      return "ExecFlow can't store a short link right now. Its free storage takes about 1,000 new short links a day for everyone, and starts again at 00:00 UTC (5:30 in India). Try again later.";
    case "not-set-up":
      return "Short links aren't switched on for this copy of ExecFlow.";
    case "failed":
      return "ExecFlow couldn't reach its server to make the short link. Try again in a moment.";
    case "too-long":
      return "This is more than a short link can hold.";
    case "unsupported":
      return "This browser can't make short links. Use a current Chrome, Edge, Firefox or Safari.";
    case "not-text":
      return `This can't go in a link: ${refusal.reason}.`;
    case "too-many":
      return `A short link holds at most ${MAX_LINK_FILES} files.`;
    case "empty":
      return "There is nothing to put in the link.";
  }
}

/** One sentence for a short link that couldn't be opened. */
export function shortReadRefusalText(refusal: ShortReadRefusal): string {
  switch (refusal.kind) {
    case "gone":
      return "This short link has expired or doesn't exist, so nothing was opened. Short links are kept for 1, 30 or 90 days: ask for a new link.";
    case "offline":
      return "This short link needs a connection to open, and this device is offline. Connect, then open the link again.";
    case "busy":
      return "This network has opened a lot of short links in the last hour, so ExecFlow is pausing them. Try again within the hour.";
    case "unavailable":
      return "ExecFlow couldn't fetch this short link right now, so nothing was opened. Try again in a moment.";
    default:
      return readRefusalText(refusal, "short link");
  }
}
