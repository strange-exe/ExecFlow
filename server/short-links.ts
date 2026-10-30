// Short links (server/short-link-shape.ts): the one place a link's encrypted bytes are kept. The
// browser encrypts the code with a key that stays in the link's fragment; this function only ever
// sees ciphertext, stores it in Workers KV under a random id with an expiry, and hands it back.
// Cloudflare Pages runs it as two routes (functions/api/links/index.ts and [id].ts); this file is the
// whole logic, a pure (request, env, deps) => Response so the unit tests can drive it.
//
// Rules, each applied before the store is touched:
// - POST /api/links?ttl=<seconds> makes a link: only POST (405), only from this site (Origin listed in
//   ALLOWED_ORIGIN exactly and Sec-Fetch-Site same-origin when sent, as the sign-in relay checks:
//   server/github-auth.ts), only application/octet-stream (415), exactly one ttl of the three
//   (400), then the per-client limit (429), then at most MAX_BODY_BYTES read (413: a larger declared
//   Content-Length is refused unread, and a stream is cut at the cap), then the shape: a version
//   byte and room for an IV and a GCM tag (400). The id is drawn here from crypto.getRandomValues
//   (unbiased: bytes of 248 and over are dropped), and a taken id is drawn again, never overwritten.
// - GET /api/links/<id> answers the stored bytes: the id must be exactly 10 of [0-9A-Za-z] (400,
//   the store is never asked otherwise, so no path or key trick reaches it); unknown or expired is 404.
// - No store bound (LINKS) or no valid ALLOWED_ORIGIN: 404 not_configured, so a preview deployment
//   without a namespace says so plainly.
// - Answers are never cached (no-store), never sniffed, same-origin only (CORP), with no CORS
//   headers; errors are a fixed set of words, and the store's own error text is never passed on.
//   Nothing is logged.
//
// Limits (checked 2026-10-30):
// - Workers KV, Free plan: 1,000 writes a day for the whole account, reset at 00:00 UTC; past it
//   "further operations of that type will fail with an error", which is answered as 503 unavailable
//   (https://developers.cloudflare.com/kv/platform/pricing/, https://developers.cloudflare.com/kv/platform/limits/).
//   expirationTtl is at least 60 s (https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
// - The per-client limit: CREATES_PER_HOUR links an hour from one address (CF-Connecting-IP, kept
//   only as a SHA-256 hash), counted in the Cache API. Pages Functions have no Rate Limiting binding
//   (https://developers.cloudflare.com/pages/functions/bindings/ lists none), and a counter in KV
//   would spend the 1,000 daily writes it guards. The Cache API works in Pages Functions and is per
//   data centre (https://developers.cloudflare.com/workers/runtime-apis/cache/), so the count is
//   approximate (two requests at once can both pass) and kept per location: a basic limit, with the
//   KV daily limit as the hard cap. A WAF rate limiting rule on /api/links (Free plan: one rule, per
//   IP, 10 s period: https://developers.cloudflare.com/waf/rate-limiting-rules/) stops bursts before
//   this function runs. If the cache fails, links are still made.
import { matchOrigin, originsOf } from "./github-auth";
import { isLinkId, LINK_ID_LENGTH, LINK_TTLS, MAX_BODY_BYTES, MIN_BODY_BYTES, STORED_VERSION } from "./short-link-shape";

/** The part of a Workers KV namespace this uses. */
export interface LinkStore {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, options: { expirationTtl: number }): Promise<void>;
}

/** The part of the Cache API (caches.default) the per-client count uses. */
export interface Counter {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface LinksEnv {
  /** As for the sign-in relay: the exact origin(s), comma-separated, at most 4. */
  ALLOWED_ORIGIN?: string;
  /** The KV namespace bound as LINKS (production and preview are bound separately). */
  LINKS?: LinkStore;
}

export interface LinksDeps {
  /** crypto.getRandomValues. */
  random(bytes: Uint8Array<ArrayBuffer>): void;
  /** Date.now. */
  now(): number;
  /** caches.default, or null where there is none. */
  counter: Counter | null;
}

export type LinksErrorCode =
  | "not_configured"
  | "method_not_allowed"
  | "forbidden"
  | "unsupported_media_type"
  | "too_large"
  | "invalid_request"
  | "rate_limited"
  | "not_found"
  | "unavailable"
  | "internal";

/** Links one address may make in an hour (per Cloudflare location): a class behind one campus address still fits. */
export const CREATES_PER_HOUR = 50;
/** Ids drawn before giving up: with 62^10 ids, a second taken one in a row means something is wrong. */
const ID_TRIES = 4;
const KEY_PREFIX = "link:";
const HOUR_MS = 3_600_000;

const HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const reply = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra } });

const fail = (status: number, error: LinksErrorCode, extra?: Record<string, string>) => reply(status, { error }, extra);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A fresh id: random bytes below 248 (4 x 62), so every character is equally likely. */
export function newLinkId(random: LinksDeps["random"]): string {
  let id = "";
  const bytes = new Uint8Array(16);
  while (id.length < LINK_ID_LENGTH) {
    random(bytes);
    for (const b of bytes) {
      if (b >= 248) continue;
      id += BASE62[b % 62];
      if (id.length === LINK_ID_LENGTH) break;
    }
  }
  return id;
}

/** The ttl: exactly one query parameter, `ttl`, spelled exactly as one of LINK_TTLS. */
function ttlOf(url: URL): number | null {
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0][0] !== "ttl") return null;
  const ttl = LINK_TTLS.find((t) => String(t) === entries[0][1]);
  return ttl ?? null;
}

/** Reads at most MAX_BODY_BYTES; null when the body is (or says it is) larger. */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

const isLinkBody = (bytes: Uint8Array) => bytes.length >= MIN_BODY_BYTES && bytes.length <= MAX_BODY_BYTES && bytes[0] === STORED_VERSION;

async function hashHex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Counts this request against its address's hour. Returns the seconds to wait when the hour's
 * links are used up, else null. A failing cache counts nothing (links are still made).
 */
async function overLimit(request: Request, origin: string, deps: LinksDeps): Promise<number | null> {
  if (!deps.counter) return null;
  const now = deps.now();
  const hour = Math.floor(now / HOUR_MS);
  const left = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - now) / 1000));
  try {
    const who = await hashHex(request.headers.get("cf-connecting-ip") ?? "unknown");
    const key = new Request(`${origin}/api/links/count/${who}/${hour}`);
    const hit = await deps.counter.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= CREATES_PER_HOUR) return left;
    await deps.counter.put(key, new Response(String(count + 1), { headers: { "Cache-Control": `max-age=${left}` } }));
  } catch {
    // Counting is best effort; the store's daily limit still holds.
  }
  return null;
}

interface Config {
  store: LinkStore;
  origins: readonly string[];
}

function configOf(env: LinksEnv): Config | null {
  const origins = originsOf(env.ALLOWED_ORIGIN);
  if (!origins || !env.LINKS) return null;
  return { store: env.LINKS, origins };
}

/** POST /api/links?ttl=<seconds>: stores the body, answers 201 {id, expires (Unix seconds)}. Never throws, never logs. */
export async function createLink(request: Request, env: LinksEnv, deps: LinksDeps): Promise<Response> {
  try {
    if (request.method !== "POST") return fail(405, "method_not_allowed", { Allow: "POST" });
    const config = configOf(env);
    if (!config) return fail(404, "not_configured");
    const origin = matchOrigin(request, config.origins, true);
    if (!origin) return fail(403, "forbidden");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/octet-stream") return fail(415, "unsupported_media_type");
    const ttl = ttlOf(new URL(request.url));
    if (ttl === null) return fail(400, "invalid_request");
    const wait = await overLimit(request, origin, deps);
    if (wait !== null) return fail(429, "rate_limited", { "Retry-After": String(wait) });
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(request);
    } catch {
      return fail(400, "invalid_request");
    }
    if (bytes === null) return fail(413, "too_large");
    if (!isLinkBody(bytes)) return fail(400, "invalid_request");
    for (let i = 0; i < ID_TRIES; i++) {
      const id = newLinkId(deps.random);
      let taken: ArrayBuffer | null;
      try {
        taken = await config.store.get(KEY_PREFIX + id, "arrayBuffer");
        if (taken !== null) continue;
        await config.store.put(KEY_PREFIX + id, bytes.slice().buffer as ArrayBuffer, { expirationTtl: ttl });
      } catch {
        return fail(503, "unavailable");
      }
      return reply(201, { id, expires: Math.floor(deps.now() / 1000) + ttl });
    }
    return fail(503, "unavailable");
  } catch {
    return fail(500, "internal");
  }
}

/** GET /api/links/<id>: the stored bytes, or 404. `id` is the route's parameter, checked here. Never throws, never logs. */
export async function readLink(request: Request, env: LinksEnv, id: unknown): Promise<Response> {
  try {
    if (request.method !== "GET") return fail(405, "method_not_allowed", { Allow: "GET" });
    const config = configOf(env);
    if (!config) return fail(404, "not_configured");
    if (matchOrigin(request, config.origins, false) === null) return fail(403, "forbidden");
    if (!isLinkId(id)) return fail(400, "invalid_request");
    let stored: ArrayBuffer | null;
    try {
      stored = await config.store.get(KEY_PREFIX + id, "arrayBuffer");
    } catch {
      return fail(503, "unavailable");
    }
    if (stored === null || !isLinkBody(new Uint8Array(stored))) return fail(404, "not_found");
    return new Response(stored, {
      status: 200,
      headers: { ...HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(stored.byteLength) },
    });
  } catch {
    return fail(500, "internal");
  }
}
