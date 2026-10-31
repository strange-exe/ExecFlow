// A Workbox plugin for the service worker's runtime caches (vite.config.ts runtimeCaching). Those
// caches keep a file for good (CacheFirst, hashed or versioned names), but Cloudflare Pages answers
// a missing file with the app's index.html, 200 text/html: stored under a .webp, .avif or .js URL, that page
// would be served for it until the cache dropped it. So a response is kept only when its type fits
// its URL. workbox-build copies the function's source into sw.js, so it must use nothing from
// outside itself (sw-cache-guard.test.ts runs it on its own to check).

interface Exchange {
  request: Request;
  response: Response;
}

export const cacheOnlyTheFile = {
  cacheWillUpdate: async ({ request, response }: Exchange): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const ext = path.slice(path.lastIndexOf(".") + 1);
    const want = ext === "webp" ? /^image\/webp\b/ : ext === "avif" ? /^image\/avif\b/ : ext === "js" ? /^(text|application)\/javascript\b/ : ext === "wasm" ? /^application\/wasm\b/ : null;
    // Python wheels have no one agreed type: for them, only the fallback page is refused.
    const fits = want ? want.test(type) : !type.startsWith("text/html");
    return fits ? response : null;
  },
};

/**
 * For a cache that only its own writer may fill: the service worker reads from it but never stores
 * what the network sent. Python's runtime is kept by the Python worker, and only once each file's
 * sha256 matched the build's (src/runner/python-download.ts); a copy the service worker stored on
 * its own would skip that check. Self-contained, like cacheOnlyTheFile (its source goes into sw.js).
 */
export const neverStore = {
  cacheWillUpdate: async (): Promise<Response | null> => null,
};
