// Counts the bytes of Python's first start (B9, 2026-10-24): the Python worker wraps its own fetch
// while Pyodide loads, so the run header can say "Downloading Python (one time, about 12 MB): X of
// N MB" instead of only "Starting Python" for the ~12 s a first visit takes at 10 Mbit/s.
//
// Pyodide fetches its .wasm, its standard library zip and its lock file with the global fetch at
// call time. Each response is handed on untouched (its URL and type stay, so WebAssembly streaming
// compilation and the browser's compiled-code cache still work); a clone of it is read alongside
// to count the bytes as they arrive. The wrapper is removed as soon as Pyodide has loaded, before
// any package loads and long before the worker's lockdown and any user code.

export interface DownloadProgress {
  /** Bytes that have arrived so far (bodies as read, after any content encoding). */
  loaded: number;
  /** Bytes the build expects in all (0: not known). */
  total: number;
  /** Pyodide has loaded: nothing more is coming. */
  done: boolean;
}

/**
 * Whether the runtime is already on this device: a cache (the service worker's precache, which
 * keeps the app working offline after the first visit) holds `url`, its .wasm. Such a start reads
 * Cache Storage, which can still take over a second under load (measured in Chromium and Firefox,
 * 2026-10-24), so time alone can't tell it from a download. Without Cache Storage, or if it
 * fails, the start is treated as a download (and shown only if it takes a while).
 */
export async function hasLocalCopy(caches: { match(url: string): Promise<Response | undefined> } | undefined, url: string): Promise<boolean> {
  try {
    return Boolean(caches && (await caches.match(url)));
  } catch {
    return false;
  }
}

/** At most one progress message per this many ms (the last one is always sent). */
export const PROGRESS_MS = 100;

type FetchScope = { fetch: typeof fetch };

/**
 * Wraps `scope.fetch` until `end()`: every response body read through it is counted, and
 * `post` gets the running total (at most every PROGRESS_MS) and a final `done: true` on `end()`.
 */
export function trackDownload(scope: FetchScope, total: number, post: (p: DownloadProgress) => void, now: () => number = () => performance.now()) {
  const original = scope.fetch;
  let loaded = 0;
  let last = -Infinity;
  let ended = false;
  const report = () => {
    const t = now();
    if (ended || t - last < PROGRESS_MS) return;
    last = t;
    post({ loaded, total, done: false });
  };
  const count = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        loaded += value.byteLength;
        report();
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
      if (ended) return;
      scope.fetch = original;
      ended = true;
      post({ loaded, total, done: true });
    },
  };
}
