// Download-and-verify for build scripts (scripts/fetch-flowchart-grammars.mjs): one file from a
// CDN, refused unless its sha256 matches the pin, with a size cap, a timeout per attempt and
// retries with backoff. Nothing downloaded is ever executed by the build: it is hashed and copied.
// Uses only web APIs (fetch, crypto.subtle), so the unit tests run it with a fake fetch.

export interface DownloadOptions {
  /** Largest body accepted, declared or streamed. */
  maxBytes: number;
  attempts?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const SHA256 = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class PermanentError extends Error {}

/** The body of `res`, refusing more than `max` bytes whether or not a length is declared. */
async function readCapped(res: Response, max: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error(`${url} is ${declared} bytes, more than the ${max} bytes allowed`);
  if (!res.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error(`${url} is larger than the ${max} bytes allowed`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Downloads `url` and returns its bytes only if their sha256 is `expected`. */
export async function downloadVerified(url: string, expected: string, options: DownloadOptions): Promise<Uint8Array> {
  if (!SHA256.test(expected)) throw new Error(`the pin for ${url} is not a sha256: ${expected}`);
  const { maxBytes, attempts = 4, timeoutMs = 120_000, fetch: get = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await get(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (!res.ok) {
        const error = res.status === 404 || res.status === 410 ? new PermanentError(`HTTP ${res.status} for ${url}`) : new Error(`HTTP ${res.status} for ${url}`);
        throw error;
      }
      const bytes = await readCapped(res, maxBytes, url);
      const got = await sha256Hex(bytes);
      if (got !== expected) throw new Error(`${url}: sha256 ${got} doesn't match the pinned ${expected}`);
      return bytes;
    } catch (e) {
      last = e;
      if (e instanceof PermanentError) break;
      if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
