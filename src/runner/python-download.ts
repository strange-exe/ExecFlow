// Python's runtime on this device (0.19.0): downloaded the first time Python starts, not on a first
// visit (the owner's "On first use", 2026-10-30), and kept for offline use like the C/C++ pack.
//
// The Python worker downloads the runtime's files into its own cache (PYTHON_CACHE) before Pyodide
// loads, counting the bytes, so the run header can say "Downloading Python (one time, about 14 MB):
// X of N MB" (B9, 2026-10-24). The worker does this itself because on a first visit no service
// worker controls the page yet, so none would see (or keep) those requests. Pyodide's own fetches
// of the .wasm, the standard library and the lock file are then answered from that cache, and the
// service worker answers the two scripts (imported, so not fetched) from the same cache once it
// controls the page: offline after one online start, Python still starts.
//
// Without Cache Storage (blocked) nothing is kept: Pyodide fetches the runtime itself each start,
// and trackDownload counts those bytes instead. Either way, fetch is back to the real one before
// any package loads, and so long before the worker's lockdown and any user code.

import { cacheOnlyTheFile } from "../about/sw-cache-guard";
import { RUNTIME_FILES } from "./python-runtime";

export { PYTHON_CACHE, RUNTIME_FILES } from "./python-runtime";

export interface DownloadProgress {
  /** Bytes that have arrived so far (bodies as read, after any content encoding). */
  loaded: number;
  /** Bytes the build expects in all (0: not known). */
  total: number;
  /** Pyodide has loaded: nothing more is coming. */
  done: boolean;
}

/** At most one progress message per this many ms (the last one is always sent). */
export const PROGRESS_MS = 100;

type FetchScope = { fetch: typeof fetch };

/**
 * A runtime file is one file whatever the request's headers: never mind the server's Vary (the
 * service worker's route for these files matches the same way, vite.config.ts).
 */
const ANY_VARY = { ignoreVary: true };

/** The parts of a Cache this module uses (the worker's caches.open(PYTHON_CACHE)). */
export interface RuntimeCache {
  match(url: string, options?: CacheQueryOptions): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  keys(): Promise<readonly Request[]>;
  delete(request: Request): Promise<boolean>;
}

/** The runtime's files that `cache` doesn't hold yet, for the folder `base` (an absolute URL ending in "/"). */
export async function missingFiles(cache: RuntimeCache, base: string, files: readonly string[] = RUNTIME_FILES): Promise<string[]> {
  const held = await Promise.all(files.map(async (f) => Boolean(await cache.match(base + f, ANY_VARY))));
  return files.filter((_, i) => !held[i]);
}

/**
 * Why the runtime didn't download. `offline`: no answer at all (the request itself failed), which
 * is what a device without a connection sees; otherwise the site answered, but not with the file.
 */
export class DownloadError extends Error {
  constructor(message: string, readonly offline: boolean) {
    super(message);
  }
}

/** Calls `post` with the running total at most every PROGRESS_MS (`end` always sends the last). */
function reporter(total: number, post: (p: DownloadProgress) => void, now: () => number) {
  let loaded = 0;
  let last = -Infinity;
  let ended = false;
  return {
    add(bytes: number) {
      loaded += bytes;
      const t = now();
      if (ended || t - last < PROGRESS_MS) return;
      last = t;
      post({ loaded, total, done: false });
    },
    end() {
      if (ended) return;
      ended = true;
      post({ loaded, total, done: true });
    },
  };
}

/**
 * Downloads `files` from the folder `base` into `cache`, counting the bytes for `post` (at most
 * every PROGRESS_MS, then `done: true` once all are in or one failed). Entries of other runtime
 * versions go first: the folder name carries the version, so they are never used again. A file
 * is kept only as the site's own copy (status 200, never the fallback page under its URL,
 * sw-cache-guard.ts); anything else throws a DownloadError and keeps nothing for that file.
 * The cache refusing a file (storage full) doesn't stop the start: Pyodide then fetches it itself.
 */
export async function downloadRuntime(opts: {
  fetch: typeof fetch;
  cache: RuntimeCache;
  base: string;
  files: readonly string[];
  total: number;
  post: (p: DownloadProgress) => void;
  now?: () => number;
}): Promise<void> {
  const { cache, base } = opts;
  const progress = reporter(opts.total, opts.post, opts.now ?? (() => performance.now()));
  try {
    for (const old of await cache.keys()) if (!old.url.startsWith(base)) await cache.delete(old);
    // Every file is let finish before a failure is reported: the runner drops a worker that failed
    // to start, and WebKit logs each request still running then as cancelled.
    const settled = await Promise.allSettled(
      opts.files.map(async (file) => {
        const url = base + file;
        let response: Response;
        try {
          response = await opts.fetch(url);
        } catch (e) {
          throw new DownloadError(`${file} couldn't be fetched (${(e as Error).message || "no connection"})`, true);
        }
        if (response.status !== 200) throw new DownloadError(`the site answered ${file} with HTTP ${response.status}`, false);
        if (!(await cacheOnlyTheFile.cacheWillUpdate({ request: new Request(url), response }))) {
          throw new DownloadError(`the site sent a page instead of ${file}`, false);
        }
        const kept = cache.put(url, response.clone()).catch(() => {});
        const reader = response.body?.getReader();
        try {
          for (;;) {
            if (!reader) break;
            const { done, value } = await reader.read();
            if (done) break;
            progress.add(value.byteLength);
          }
        } catch (e) {
          throw new DownloadError(`the download of ${file} stopped (${(e as Error).message || "connection lost"})`, false);
        }
        await kept;
      }),
    );
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    progress.end();
  }
}

/**
 * Answers `scope.fetch` for the runtime's files from `cache` until `end()`, so Pyodide reads them
 * from this device; anything else, or a file the cache doesn't hold, goes to the real fetch.
 */
export function serveFromCache(scope: FetchScope, cache: RuntimeCache, base: string, files: readonly string[] = RUNTIME_FILES) {
  const original = scope.fetch;
  const ours = new Set(files.map((f) => base + f));
  scope.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const url = new URL(input instanceof Request ? input.url : String(input), base).href;
    const hit = ours.has(url) ? await cache.match(url, ANY_VARY).catch(() => undefined) : undefined;
    return hit ?? original.apply(scope, args);
  }) as typeof fetch;
  return {
    /** Puts the real fetch back. */
    end() {
      scope.fetch = original;
    },
  };
}

/**
 * Wraps `scope.fetch` until `end()`: every response body read through it is counted, and
 * `post` gets the running total (at most every PROGRESS_MS) and a final `done: true` on `end()`.
 * Used when there is no Cache Storage: Pyodide then fetches the runtime itself on every start.
 */
export function trackDownload(scope: FetchScope, total: number, post: (p: DownloadProgress) => void, now: () => number = () => performance.now()) {
  const original = scope.fetch;
  const progress = reporter(total, post, now);
  const count = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        progress.add(value.byteLength);
      }
    } catch {
      // The download failed: Pyodide's own read of the response reports it.
    }
  };
  scope.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await original.apply(scope, args);
    const copy = response.clone();
    if (copy.body) void count(copy.body);
    return response;
  }) as typeof fetch;
  return {
    /** Puts the real fetch back and sends the final count. */
    end() {
      scope.fetch = original;
      progress.end();
    },
  };
}
