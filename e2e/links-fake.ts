// The short-link function (server/short-links.ts) for e2e: its real logic over an in-memory store,
// answering the page's /api/links requests through context.route, so the browser side, the server's
// checks (Origin, content type, ttl, sizes, ids) and the stored bytes are the real ones. Every
// request each context makes is recorded (URL, headers, body) for the "the key is never sent" check.
import type { BrowserContext, Route } from "@playwright/test";
import { IV_BYTES, STORED_VERSION } from "../server/short-link-shape";
import { createLink, readLink, type LinkStore } from "../server/short-links";

export interface Stored {
  bytes: Uint8Array;
  ttl: number;
}

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface LinksSite {
  /** "link:<id>" to the stored bytes and the expirationTtl they were put with. */
  readonly data: Map<string, Stored>;
  /** Every request of every context served (not only /api/links), once settled. */
  sent(): Promise<SentRequest[]>;
  /** Serves /api/links in `context` too (a second browser profile), and records its requests. */
  serve(context: BrowserContext): Promise<void>;
  /** Answers every request to /api/links with this status instead (null: the real logic again). */
  answer(status: number | null): void;
}

/** The headers a browser's request carries that a Request can't be built with, or that don't apply. */
const DROPPED = new Set(["host", "content-length", "connection"]);

export function linksSite(origin: string): LinksSite {
  const data = new Map<string, Stored>();
  const store: LinkStore = {
    get: async (key) => (data.has(key) ? (data.get(key)!.bytes.slice().buffer as ArrayBuffer) : null),
    put: async (key, value, options) => void data.set(key, { bytes: new Uint8Array(value), ttl: options.expirationTtl }),
  };
  const env = { ALLOWED_ORIGIN: origin, LINKS: store };
  const pending: Promise<SentRequest>[] = [];
  let forced: number | null = null;

  async function handle(route: Route) {
    const r = route.request();
    if (forced !== null) {
      return route.fulfill({ status: forced, contentType: "application/json", body: JSON.stringify({ error: "forced" }) });
    }
    const headers = Object.fromEntries(Object.entries(await r.allHeaders()).filter(([k]) => !k.startsWith(":") && !DROPPED.has(k)));
    const body = r.method() === "POST" ? new Uint8Array(r.postDataBuffer() ?? []) : undefined;
    const request = new Request(r.url(), { method: r.method(), headers, body });
    const path = new URL(r.url()).pathname;
    const res =
      path === "/api/links"
        ? await createLink(request, env, { random: (b) => void crypto.getRandomValues(b), now: () => Date.now(), counter: null })
        : await readLink(request, env, decodeURIComponent(path.slice("/api/links/".length)), { now: () => Date.now(), counter: null });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  }

  return {
    data,
    sent: () => Promise.all(pending),
    async serve(context) {
      context.on("request", (r) => {
        pending.push(r.allHeaders().then((headers) => ({ url: r.url(), headers, body: r.postDataBuffer() }), () => ({ url: r.url(), headers: {}, body: r.postDataBuffer() })));
      });
      await context.route(/[/]api[/]links([/?]|$)/, handle);
    },
    answer(status) {
      forced = status;
    },
  };
}

/**
 * Stores `plaintext` (a format byte, then the deflated JSON) encrypted as a short link would be: for
 * payloads the app would never make. The fragment is the key, as the link carries it.
 */
export async function forgeLink(site: LinksSite, plaintext: Uint8Array, id = "F0rgedL1nk"): Promise<{ id: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode("ExecFlow short link v1");
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext as BufferSource));
  site.data.set(`link:${id}`, { bytes: new Uint8Array([STORED_VERSION, ...iv, ...sealed]), ttl: 86400 });
  return { id, hash: `#${Buffer.from(raw).toString("base64url")}` };
}

/** The key (the fragment, without "#") and its 32 bytes, of a short link's address. */
export function keyOf(url: string): { text: string; bytes: Buffer } {
  const text = new URL(url).hash.slice(1);
  return { text, bytes: Buffer.from(text, "base64url") };
}
