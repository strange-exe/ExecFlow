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
//   byte and room for an IV and a GCM tag (400), then the day's total (503). The id is drawn here
//   from crypto.getRandomValues (unbiased: bytes of 248 and over are dropped), and a taken id is
//   drawn again, never overwritten.
// - GET /api/links/<id> answers the stored bytes: the id must be exactly 10 of [0-9A-Za-z] (400,
//   the store is never asked otherwise, so no path or key trick reaches it), then the per-client
//   limit on opening (429); unknown or expired is 404, and that 404 is remembered for a minute.
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
// - The counts, all in the Cache API under a host of their own (COUNTS), so the site's listed origins
//   share them: CREATES_PER_HOUR links made and READS_PER_HOUR links opened an hour per network
//   (networkOf: an IPv4 address, or an IPv6 /64, of CF-Connecting-IP, kept only as a SHA-256 hash),
//   and DAILY_CREATES links made a UTC day in all, below KV's 1,000, so one network can't spend
//   every write. An unknown id's 404 is cached for MISS_SECONDS, so a flood of one id costs one read.
//   Pages Functions have no Rate Limiting binding (https://developers.cloudflare.com/pages/functions/bindings/
//   lists none), and a counter in KV would spend the 1,000 daily writes it guards. The Cache API
//   works in Pages Functions and is per data centre (https://developers.cloudflare.com/workers/runtime-apis/cache/,
//   https://developers.cloudflare.com/workers/reference/how-the-cache-works/), so every count is
//   approximate (two requests at once can both pass) and kept per location: the day's total can't
//   be made exact this way (each location allows DAILY_CREATES), so it fails open like the others,
//   with KV's own daily limit as the hard cap. An exact total would need a Durable Object or D1.
//   A WAF rate limiting rule on /api/links (Free plan: one rule, per IP, 10 s period:
//   https://developers.cloudflare.com/waf/rate-limiting-rules/) stops bursts before this function
//   runs. If the cache fails, links are still made and opened.
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

/** Links one network may make in an hour (per Cloudflare location): a class behind one campus address still fits. */
export const CREATES_PER_HOUR = 50;
/**
 * Links made in a UTC day, counted per Cloudflare location, before the store is asked: below KV's
 * 1,000 writes a day, so one network, or a few, can't spend every write the account has.
 */
export const DAILY_CREATES = 800;
/** Links one network may open in an hour (per location): generous for a class, a ceiling on KV reads for a flood. */
export const READS_PER_HOUR = 300;
/** How long an unknown id's 404 is remembered, so a flood of one id asks the store once. KV caches its own misses about as long. */
const MISS_SECONDS = 60;
/**
 * The counts' own host. Every key is under it, never a page's address: one count for every listed
 * origin (the site's old and new address), and no key that a real request could ever match.
 */
const COUNTS = "https://short-links.invalid";
/** Ids drawn before giving up: with 62^10 ids, a second taken one in a row means something is wrong. */
const ID_TRIES = 4;
const KEY_PREFIX = "link:";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}([.]${OCTET}){3}$`);

/** An IPv6 address's 8 groups, or null. A zone (%eth0) is dropped; a dotted IPv4 tail is the last two groups. */
function groupsOf(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /^(.*:)([0-9.]*[.][0-9.]*)$/.exec(text);
  if (dotted) {
    if (!IPV4.test(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null;
  const all = [...head, ...new Array<string>(halves.length === 2 ? zeros : 0).fill("0"), ...tail];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all.map((g) => parseInt(g, 16)) : null;
}

/**
 * The network a client address belongs to, as the limits count it: an IPv4 address whole (/32),
 * an IPv6 address by its /64 (one home or phone gets a whole /64, so counting each address would
 * let one client count as billions), an IPv4-mapped IPv6 address as its IPv4 address. Anything
 * else, or no address, is "unknown", one network.
 */
export function networkOf(ip: string | null): string {
  if (!ip || ip.length > 64) return "unknown";
  if (IPV4.test(ip)) return ip;
  const g = groupsOf(ip);
  if (!g) return "unknown";
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

type CountDeps = Pick<LinksDeps, "now" | "counter">;

/** caches.default: Cloudflare's own cache (which the standard CacheStorage type doesn't name), or null. For the routes. */
export const edgeCache = (): Counter | null => (globalThis as { caches?: { default?: Counter } }).caches?.default ?? null;

/**
 * Spends one of `max` in the count `name` (a key under COUNTS) that lasts until `ends` (ms since
 * 1970). Returns the seconds until it ends when none are left, else null. Best effort: without a
 * cache, or with one failing, it counts nothing and refuses nothing (the store's own limits hold).
 */
async function spend(deps: CountDeps, name: string, ends: number, max: number): Promise<number | null> {
  if (!deps.counter) return null;
  const left = Math.max(1, Math.ceil((ends - deps.now()) / 1000));
  try {
    const key = new Request(`${COUNTS}/${name}`);
    const hit = await deps.counter.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= max) return left;
    await deps.counter.put(key, new Response(String(count + 1), { headers: { "Cache-Control": `max-age=${left}` } }));
  } catch {
    // Counting is best effort.
  }
  return null;
}

/** Counts this request against its network's hour of making (or opening) links: the seconds to wait, or null. */
async function overClientLimit(request: Request, kind: "made" | "opened", max: number, deps: CountDeps): Promise<number | null> {
  if (!deps.counter) return null;
  const hour = Math.floor(deps.now() / HOUR_MS);
  // Only a hash of the network is kept, never the address.
  const who = await hashHex(networkOf(request.headers.get("cf-connecting-ip")));
  return spend(deps, `${kind}/${who}/${hour}`, (hour + 1) * HOUR_MS, max);
}

/** Counts one link against the UTC day's total (KV's daily limit resets at 00:00 UTC): the seconds to wait, or null. */
function overDailyTotal(deps: CountDeps): Promise<number | null> {
  const day = Math.floor(deps.now() / DAY_MS);
  return spend(deps, `created/${day}`, (day + 1) * DAY_MS, DAILY_CREATES);
}

/** Whether `id` was looked up and missing within the last MISS_SECONDS (a failing cache: no). */
async function knownMissing(id: string, deps: CountDeps): Promise<boolean> {
  if (!deps.counter) return false;
  try {
    return (await deps.counter.match(new Request(`${COUNTS}/miss/${id}`))) !== undefined;
  } catch {
    return false;
  }
}

async function rememberMissing(id: string, deps: CountDeps): Promise<void> {
  if (!deps.counter) return;
  try {
    await deps.counter.put(new Request(`${COUNTS}/miss/${id}`), new Response("1", { headers: { "Cache-Control": `max-age=${MISS_SECONDS}` } }));
  } catch {
    // Best effort: the next lookup asks the store.
  }
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
    const wait = await overClientLimit(request, "made", CREATES_PER_HOUR, deps);
    if (wait !== null) return fail(429, "rate_limited", { "Retry-After": String(wait) });
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(request);
    } catch {
      return fail(400, "invalid_request");
    }
    if (bytes === null) return fail(413, "too_large");
    if (!isLinkBody(bytes)) return fail(400, "invalid_request");
    // The day's total is spent last, by requests that would reach the store: the wording KV's own daily limit gets.
    const full = await overDailyTotal(deps);
    if (full !== null) return fail(503, "unavailable", { "Retry-After": String(full) });
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

/**
 * GET /api/links/<id>: the stored bytes, or 404. `id` is the route's parameter, checked here. A
 * network opens at most READS_PER_HOUR links an hour (429), and an unknown id's 404 is remembered
 * for MISS_SECONDS, so a flood spends few of the account's KV reads. Never throws, never logs.
 */
export async function readLink(request: Request, env: LinksEnv, id: unknown, deps: CountDeps): Promise<Response> {
  try {
    if (request.method !== "GET") return fail(405, "method_not_allowed", { Allow: "GET" });
    const config = configOf(env);
    if (!config) return fail(404, "not_configured");
    if (matchOrigin(request, config.origins, false) === null) return fail(403, "forbidden");
    if (!isLinkId(id)) return fail(400, "invalid_request");
    const wait = await overClientLimit(request, "opened", READS_PER_HOUR, deps);
    if (wait !== null) return fail(429, "rate_limited", { "Retry-After": String(wait) });
    if (await knownMissing(id, deps)) return fail(404, "not_found");
    let stored: ArrayBuffer | null;
    try {
      stored = await config.store.get(KEY_PREFIX + id, "arrayBuffer");
    } catch {
      return fail(503, "unavailable");
    }
    if (stored === null) {
      await rememberMissing(id, deps);
      return fail(404, "not_found");
    }
    if (!isLinkBody(new Uint8Array(stored))) return fail(404, "not_found");
    return new Response(stored, {
      status: 200,
      headers: { ...HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(stored.byteLength) },
    });
  } catch {
    return fail(500, "internal");
  }
}
