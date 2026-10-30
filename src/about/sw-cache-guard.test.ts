/// <reference types="node" />
// The service worker's runtime caches keep a file for good (CacheFirst, hashed or versioned names),
// so they may keep only the file itself: Cloudflare Pages answers a missing file with the app's
// index.html (200 text/html), and that page must never be stored under a .webp, .js or .wasm URL.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { cacheOnlyTheFile, neverStore } from "./sw-cache-guard";

const answer = (path: string, type: string | null) => {
  const response = new Response("x", { status: 200, headers: type ? { "content-type": type } : {} });
  return cacheOnlyTheFile.cacheWillUpdate({ request: new Request(`https://code-editor.test${path}`), response });
};

describe("cacheOnlyTheFile (vite.config.ts runtimeCaching)", () => {
  it.each([
    ["/media/about-scene.5d85575b.webp", "image/webp"],
    ["/assets/a/scene-1a2b3c4d.js", "text/javascript; charset=utf-8"],
    ["/assets/a/scene-1a2b3c4d.js", "application/javascript"],
    ["/flowchart/1/tree-sitter-c.wasm", "application/wasm"],
    ["/pyodide/314.0.7-heap1024/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl", "application/octet-stream"],
    ["/pyodide/314.0.7-heap1024/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl", null],
  ])("keeps %s sent as %s", async (path, type) => {
    expect(await answer(path, type)).not.toBeNull();
  });

  it.each([
    ["/media/about-scene.00000000.webp", "text/html; charset=utf-8"],
    ["/media/about-scene.00000000.webp", null],
    ["/assets/a/00000000.js", "text/html; charset=utf-8"],
    ["/assets/a/00000000.js", "text/plain"],
    ["/flowchart/1/missing.wasm", "text/html; charset=utf-8"],
    ["/pyodide/314.0.7-heap1024/missing.whl", "text/html; charset=utf-8"],
  ])("refuses %s sent as %s (the site's fallback page, not the file)", async (path, type) => {
    expect(await answer(path, type)).toBeNull();
  });

  it("works on its own, as the service worker runs it (its source is copied into sw.js)", async () => {
    const fn = runInNewContext(`(${cacheOnlyTheFile.cacheWillUpdate.toString()})`, { URL }) as typeof cacheOnlyTheFile.cacheWillUpdate;
    const response = new Response("x", { headers: { "content-type": "text/html" } });
    expect(await fn({ request: new Request("https://code-editor.test/media/a.12345678.webp"), response })).toBeNull();
    const good = new Response("x", { headers: { "content-type": "image/webp" } });
    expect(await fn({ request: new Request("https://code-editor.test/media/a.12345678.webp"), response: good })).toBe(good);
  });
});

describe("neverStore (the Python runtime's route: only the worker that checks sha256 keeps a file)", () => {
  it("stores nothing, even the right file, and works on its own as sw.js runs it", async () => {
    expect(await neverStore.cacheWillUpdate()).toBeNull();
    const fn = runInNewContext(`(${neverStore.cacheWillUpdate.toString()})`, {}) as typeof neverStore.cacheWillUpdate;
    expect(await fn()).toBeNull();
  });
});
