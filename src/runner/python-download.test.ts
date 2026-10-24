import { describe, expect, it } from "vitest";
import { hasLocalCopy, trackDownload, type DownloadProgress } from "./python-download";

/** A body that arrives in `sizes` pieces, one per read. */
const body = (sizes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of sizes) c.enqueue(new Uint8Array(n));
      c.close();
    },
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("trackDownload", () => {
  it("counts every response body read through fetch, hands the real response on, and restores fetch", async () => {
    const original = async () => new Response(body([1000, 500]), { status: 200, headers: { "content-type": "application/wasm" } });
    const scope = { fetch: original as unknown as typeof fetch };
    const posts: DownloadProgress[] = [];
    let clock = 0;
    const track = trackDownload(scope, 4000, (p) => posts.push(p), () => (clock += 200));
    expect(scope.fetch).not.toBe(original);
    const r1 = await scope.fetch("/pyodide/x/pyodide.asm.wasm");
    // The response itself is untouched (its URL, type and body stay for streaming compilation).
    expect(r1.headers.get("content-type")).toBe("application/wasm");
    expect((await r1.arrayBuffer()).byteLength).toBe(1500);
    const r2 = await scope.fetch("/pyodide/x/python_stdlib.zip");
    await r2.arrayBuffer();
    await settle();
    expect(posts.at(-1)).toEqual({ loaded: 3000, total: 4000, done: false });
    track.end();
    expect(scope.fetch).toBe(original);
    expect(posts.at(-1)).toEqual({ loaded: 3000, total: 4000, done: true });
  });

  it("reports at most one progress per interval, and always the last one", async () => {
    const scope = { fetch: (async () => new Response(body([10, 10, 10, 10]))) as unknown as typeof fetch };
    const posts: DownloadProgress[] = [];
    const track = trackDownload(scope, 40, (p) => posts.push(p), () => 0);
    await (await scope.fetch("/a")).arrayBuffer();
    await settle();
    // The clock never moves: only the first piece is reported until the end.
    expect(posts).toEqual([{ loaded: 10, total: 40, done: false }]);
    track.end();
    expect(posts.at(-1)).toEqual({ loaded: 40, total: 40, done: true });
  });

  it("keeps fetch's own this (a worker's fetch throws when called unbound)", async () => {
    const scope = {
      fetch(this: unknown) {
        if (this !== scope) throw new TypeError("Illegal invocation");
        return Promise.resolve(new Response("ok"));
      },
    };
    trackDownload(scope as unknown as { fetch: typeof fetch }, 2, () => {});
    expect(await (await scope.fetch()).text()).toBe("ok");
  });

  it("hasLocalCopy: the runtime is on this device when a cache (the service worker's precache) holds its .wasm", async () => {
    const asked: string[] = [];
    const caches = (hit: boolean) => ({ match: async (url: string) => (asked.push(url), hit ? new Response("x") : undefined) });
    expect(await hasLocalCopy(caches(true), "http://h/pyodide/x/pyodide.asm.wasm")).toBe(true);
    expect(await hasLocalCopy(caches(false), "http://h/pyodide/x/pyodide.asm.wasm")).toBe(false);
    expect(asked).toEqual(["http://h/pyodide/x/pyodide.asm.wasm", "http://h/pyodide/x/pyodide.asm.wasm"]);
    // No Cache Storage (blocked, or an insecure context), or one that fails: count as a download.
    expect(await hasLocalCopy(undefined, "http://h/a")).toBe(false);
    expect(await hasLocalCopy({ match: () => Promise.reject(new Error("SecurityError")) }, "http://h/a")).toBe(false);
  });

  it("a body that fails to read is not counted and doesn't throw", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection lost")); } });
    const scope = { fetch: (async () => new Response(broken)) as unknown as typeof fetch };
    const posts: DownloadProgress[] = [];
    const track = trackDownload(scope, 10, (p) => posts.push(p), () => 0);
    const r = await scope.fetch("/a");
    await expect(r.arrayBuffer()).rejects.toThrow();
    await settle();
    track.end();
    expect(posts).toEqual([{ loaded: 0, total: 10, done: true }]);
  });
});
