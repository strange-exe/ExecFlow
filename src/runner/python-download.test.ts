/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../flowchart/download";
import { DownloadError, downloadRuntime, failureWords, missingFiles, RUNTIME_FILES, serveFromCache, trackDownload, type DownloadProgress, type RuntimeCache } from "./python-download";

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

// ---------------------------------------------------------------- the runtime on this device

const BASE = "http://h/pyodide/314.0.7-heap512/";

/** Cache Storage's cache as the worker uses it: put reads the body, match hands out a fresh copy. */
class FakeCache implements RuntimeCache {
  entries = new Map<string, { body: ArrayBuffer; type: string | null }>();
  failPuts = false;
  matchOptions: (CacheQueryOptions | undefined)[] = [];
  async match(url: string, options?: CacheQueryOptions) {
    this.matchOptions.push(options);
    const e = this.entries.get(url);
    return e ? new Response(e.body.slice(0), { headers: e.type ? { "content-type": e.type } : {} }) : undefined;
  }
  async put(url: string, response: Response) {
    const body = await response.arrayBuffer();
    if (this.failPuts) throw new DOMException("quota", "QuotaExceededError");
    this.entries.set(url, { body, type: response.headers.get("content-type") });
  }
  async keys() {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
  deleteOptions: (CacheQueryOptions | undefined)[] = [];
  async delete(request: Request, options?: CacheQueryOptions) {
    this.deleteOptions.push(options);
    return this.entries.delete(request.url);
  }
}

const TYPES: Record<string, string> = { mjs: "text/javascript", wasm: "application/wasm", zip: "application/zip", json: "application/json" };
const typeOf = (url: string) => TYPES[url.slice(url.lastIndexOf(".") + 1)] ?? "application/octet-stream";

/** A site that serves `sizes[file]` bytes per file, in two pieces, and records what was asked. */
function site(sizes: Record<string, number>, answer?: (url: string) => Response | Promise<Response> | null) {
  const asked: string[] = [];
  const fetch = (async (input: string) => {
    asked.push(input);
    const special = answer?.(input);
    if (special) return special;
    const n = sizes[input.slice(BASE.length)] ?? 0;
    return new Response(body([Math.ceil(n / 2), Math.floor(n / 2)]), { status: 200, headers: { "content-type": typeOf(input) } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const SIZES = { "pyodide.mjs": 10, "pyodide.asm.mjs": 100, "pyodide.asm.wasm": 1000, "python_stdlib.zip": 300, "pyodide-lock.json": 20 };
const TOTAL = Object.values(SIZES).reduce((a, b) => a + b, 0);
/** Each file's sha256, as the build pins it (__PYODIDE_FILES__): the site above serves zero bytes. */
const SHAS: Record<string, string> = {};
/** Each file's size and sha256, as the build pins them (__PYODIDE_FILES__). */
const PINS: Record<string, { bytes: number; sha256: string }> = {};
beforeAll(async () => {
  for (const [file, n] of Object.entries(SIZES)) {
    SHAS[file] = await sha256Hex(new Uint8Array(n));
    PINS[file] = { bytes: n, sha256: SHAS[file] };
  }
});

describe("RUNTIME_FILES", () => {
  it("are exactly the files scripts/copy-pyodide.mjs puts in the runtime folder", () => {
    const script = readFileSync("scripts/copy-pyodide.mjs", "utf8");
    const listed = /const files = \[([^\]]*)\];/.exec(script)?.[1];
    expect(listed && JSON.parse(`[${listed}]`)).toEqual([...RUNTIME_FILES]);
  });
});

describe("missingFiles", () => {
  it("lists the runtime's files the cache doesn't hold, in order", async () => {
    const cache = new FakeCache();
    expect(await missingFiles(cache, BASE)).toEqual([...RUNTIME_FILES]);
    await cache.put(BASE + "pyodide.asm.wasm", new Response("x"));
    // Another version's copy of a file doesn't count.
    await cache.put("http://h/pyodide/313.0.0-heap512/pyodide.mjs", new Response("x"));
    expect(await missingFiles(cache, BASE)).toEqual(["pyodide.mjs", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide-lock.json"]);
    // A server's Vary never splits one file in two (vite.config.ts's route matches the same way).
    expect(cache.matchOptions.every((o) => o?.ignoreVary === true)).toBe(true);
  });

  it("with the build's pins, a held copy whose bytes don't match counts as missing and is dropped", async () => {
    const cache = new FakeCache();
    for (const [file, n] of Object.entries(SIZES)) await cache.put(BASE + file, new Response(new Uint8Array(n)));
    // Changed on this device after it was checked (a flipped bit, a copy kept by an older build).
    const changed = new Uint8Array(1000);
    changed[1] = 7;
    await cache.put(BASE + "pyodide.asm.wasm", new Response(changed));
    await cache.put(BASE + "pyodide.mjs", new Response("export const loadPyodide = 1"));
    // Without pins nothing is read: a held file is trusted.
    expect(await missingFiles(cache, BASE)).toEqual([]);
    expect(await missingFiles(cache, BASE, RUNTIME_FILES, PINS)).toEqual(["pyodide.mjs", "pyodide.asm.wasm"]);
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
    expect(cache.entries.has(BASE + "pyodide.mjs")).toBe(false);
    // Every copy under the URL goes, whatever its Vary.
    expect(cache.deleteOptions).toEqual([{ ignoreVary: true }, { ignoreVary: true }]);
    // The matching ones stay, and the next download fetches only the two.
    expect(cache.entries.has(BASE + "python_stdlib.zip")).toBe(true);
    expect(await missingFiles(cache, BASE, RUNTIME_FILES, PINS)).toEqual(["pyodide.mjs", "pyodide.asm.wasm"]);
  });

  it("with pins, a held file the build has no pin for is dropped too (fails closed)", async () => {
    const cache = new FakeCache();
    for (const [file, n] of Object.entries(SIZES)) await cache.put(BASE + file, new Response(new Uint8Array(n)));
    const { "pyodide-lock.json": _left, ...pins } = PINS;
    expect(await missingFiles(cache, BASE, RUNTIME_FILES, pins)).toEqual(["pyodide-lock.json"]);
    expect(cache.entries.has(BASE + "pyodide-lock.json")).toBe(false);
  });
});

describe("downloadRuntime", () => {
  it("keeps every file, counts the bytes as they arrive, ends with done, and drops other versions' files", async () => {
    const cache = new FakeCache();
    await cache.put("http://h/pyodide/313.0.0-heap512/pyodide.asm.wasm", new Response("old"));
    const { fetch, asked } = site(SIZES);
    const posts: DownloadProgress[] = [];
    let clock = 0;
    await downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: (p) => posts.push(p), now: () => (clock += 200) });
    expect(asked).toEqual(RUNTIME_FILES.map((f) => BASE + f));
    expect([...cache.entries.keys()].sort()).toEqual(RUNTIME_FILES.map((f) => BASE + f).sort());
    expect(cache.entries.get(BASE + "pyodide.asm.wasm")!.body.byteLength).toBe(1000);
    expect(cache.entries.get(BASE + "pyodide.asm.wasm")!.type).toBe("application/wasm");
    expect(posts.at(-1)).toEqual({ loaded: TOTAL, total: TOTAL, done: true });
    // Progress came along the way, never past the total, and only once at the end.
    expect(posts.filter((p) => !p.done).length).toBeGreaterThan(2);
    expect(posts.every((p) => p.loaded <= TOTAL)).toBe(true);
    expect(posts.filter((p) => p.done)).toHaveLength(1);
    expect(await missingFiles(cache, BASE)).toEqual([]);
  });

  it("downloads only the files it is given (the rest are already here)", async () => {
    const cache = new FakeCache();
    const { fetch, asked } = site(SIZES);
    await downloadRuntime({ fetch, cache, base: BASE, files: ["python_stdlib.zip"], expected: PINS, total: 300, post: () => {} });
    expect(asked).toEqual([BASE + "python_stdlib.zip"]);
  });

  it("no answer at all (offline) throws an offline DownloadError and keeps nothing for that file", async () => {
    const cache = new FakeCache();
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? Promise.reject(new TypeError("Failed to fetch")) : null));
    const posts: DownloadProgress[] = [];
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: (p) => posts.push(p) });
    await expect(failed).rejects.toBeInstanceOf(DownloadError);
    await expect(failed).rejects.toMatchObject({ offline: true, message: expect.stringContaining("pyodide.asm.wasm") });
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
    // The header stops showing the download: the last word is done.
    expect(posts.at(-1)?.done).toBe(true);
  });

  it.each([
    ["a 404", () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } }), /HTTP 404/],
    ["the site's fallback page under the file's URL", () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }), /a page instead of pyodide\.asm\.wasm/],
    ["a partial answer (206)", () => new Response("x", { status: 206, headers: { "content-type": "application/wasm" } }), /HTTP 206/],
  ])("%s is a failed download (not offline), and is never kept", async (_name, response, message) => {
    const cache = new FakeCache();
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? response() : null));
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: () => {} });
    await expect(failed).rejects.toMatchObject({ offline: false, message: expect.stringMatching(message) });
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
    // The other files finished first (none is cut off when the runner drops the worker), and stay
    // for the next start, which then downloads only what is missing.
    expect(await missingFiles(cache, BASE)).toEqual(["pyodide.asm.wasm"]);
  });

  it("a connection lost mid-file is a failed download, and that file isn't kept", async () => {
    const cache = new FakeCache();
    const broken = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); }, pull(c) { c.error(new Error("network error")); } }), { status: 200, headers: { "content-type": "application/wasm" } });
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? broken() : null));
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: () => {} });
    await expect(failed).rejects.toMatchObject({ offline: false, message: expect.stringContaining("stopped") });
    await settle();
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
  });

  it("a cache that refuses the files (storage full) doesn't stop the download", async () => {
    const cache = new FakeCache();
    cache.failPuts = true;
    const { fetch } = site(SIZES);
    const posts: DownloadProgress[] = [];
    await downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: (p) => posts.push(p) });
    expect(posts.at(-1)).toEqual({ loaded: TOTAL, total: TOTAL, done: true });
    expect(cache.entries.size).toBe(0);
  });

  it("a file whose bytes don't match the build's sha256 is damaged: none of it is kept, the rest is", async () => {
    const cache = new FakeCache();
    // The right size and type, one byte changed (a proxy, a bad mirror, a flipped bit).
    const bad = () => {
      const bytes = new Uint8Array(1000);
      bytes[500] = 1;
      return new Response(bytes, { status: 200, headers: { "content-type": "application/wasm" } });
    };
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? bad() : null));
    const posts: DownloadProgress[] = [];
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: (p) => posts.push(p) });
    await expect(failed).rejects.toBeInstanceOf(DownloadError);
    await expect(failed).rejects.toMatchObject({ kind: "damaged", offline: false, message: "pyodide.asm.wasm didn't match" });
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
    expect(await missingFiles(cache, BASE)).toEqual(["pyodide.asm.wasm"]);
    expect(posts.at(-1)?.done).toBe(true);
  });

  it("a file the build has no sha256 for is never kept (it fails closed)", async () => {
    const cache = new FakeCache();
    const { fetch, asked } = site(SIZES);
    const { "pyodide.asm.wasm": _left, ...pins } = PINS;
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: pins, total: TOTAL, post: () => {} });
    await expect(failed).rejects.toMatchObject({ kind: "damaged", message: "pyodide.asm.wasm didn't match" });
    expect(await missingFiles(cache, BASE)).toEqual(["pyodide.asm.wasm"]);
    // Nothing is downloaded that could never be kept.
    expect(asked).not.toContain(BASE + "pyodide.asm.wasm");
  });

  it("a body larger than the build's size is damaged, and reading stops as soon as it passes the size", async () => {
    const cache = new FakeCache();
    // A much bigger file under the name (10 pieces of 400 bytes; bounded, so the test itself can't
    // fill memory when the guard is missing: reads are microtasks, and an endless one never yields).
    let reads = 0;
    let cancelled = false;
    const oversized = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              reads++;
              c.enqueue(new Uint8Array(400));
              if (reads === 10) c.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "content-type": "application/wasm" } },
      );
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? oversized() : null));
    const posts: DownloadProgress[] = [];
    let clock = 0;
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: (p) => posts.push(p), now: () => (clock += 200) });
    await expect(failed).rejects.toMatchObject({ kind: "damaged", offline: false, message: "pyodide.asm.wasm is larger than the 1000 bytes expected" });
    // 400 + 400 + 400 passes 1000 at the third piece: no fourth is asked for, and the body is let go.
    expect(reads).toBe(3);
    expect(cancelled).toBe(true);
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
    expect(await missingFiles(cache, BASE)).toEqual(["pyodide.asm.wasm"]);
    // The piece past the size isn't counted: progress never says more than the total.
    expect(posts.every((p) => p.loaded <= TOTAL)).toBe(true);
    expect(posts.at(-1)?.done).toBe(true);
  });

  it("a declared length larger than the build's size is damaged before any of the body is read", async () => {
    const cache = new FakeCache();
    let reads = 0;
    let cancelled = false;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              reads++;
              c.enqueue(new Uint8Array(1000));
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "content-type": "application/wasm", "content-length": "5000000" } },
      );
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? big() : null));
    const failed = downloadRuntime({ fetch, cache, base: BASE, files: RUNTIME_FILES, expected: PINS, total: TOTAL, post: () => {} });
    await expect(failed).rejects.toMatchObject({ kind: "damaged", message: "pyodide.asm.wasm is 5000000 bytes, more than the 1000 bytes expected" });
    expect(reads).toBe(0);
    expect(cancelled).toBe(true);
    expect(cache.entries.has(BASE + "pyodide.asm.wasm")).toBe(false);
  });

  it("a compressed answer's declared length is the compressed size, so only the bytes read are held to the file's size", async () => {
    // RFC 9110 8.6: Content-Length counts the representation as coded (Content-Encoding is part of it).
    // A gzipped zip can be a little longer than the zip itself; fetch hands over the decoded bytes.
    const cache = new FakeCache();
    const gz = () => new Response(new Uint8Array(1000), { status: 200, headers: { "content-type": "application/wasm", "content-encoding": "gzip", "content-length": "1040" } });
    const { fetch } = site(SIZES, (url) => (url.endsWith(".wasm") ? gz() : null));
    await downloadRuntime({ fetch, cache, base: BASE, files: ["pyodide.asm.wasm"], expected: PINS, total: 1000, post: () => {} });
    expect(cache.entries.get(BASE + "pyodide.asm.wasm")!.body.byteLength).toBe(1000);
  });

  it("keeps a file only as the bytes it checked, with its type", async () => {
    const cache = new FakeCache();
    const { fetch } = site(SIZES);
    await downloadRuntime({ fetch, cache, base: BASE, files: ["pyodide.asm.wasm"], expected: PINS, total: 1000, post: () => {} });
    const kept = await cache.match(BASE + "pyodide.asm.wasm");
    expect(await sha256Hex(new Uint8Array(await kept!.arrayBuffer()))).toBe(SHAS["pyodide.asm.wasm"]);
    expect(kept!.headers.get("content-type")).toBe("application/wasm");
  });
});

describe("failureWords", () => {
  it("says what went wrong after \"Python couldn't start: \", in plain words", () => {
    expect(failureWords(new DownloadError("pyodide.asm.wasm didn't match", "damaged"))).toBe("its one-time download was damaged (pyodide.asm.wasm didn't match). Press Run to try again.");
    expect(failureWords(new DownloadError("the site answered pyodide.asm.wasm with HTTP 404", "failed"))).toBe("its one-time download didn't finish (the site answered pyodide.asm.wasm with HTTP 404). Press Run to try again.");
  });
});

describe("serveFromCache", () => {
  it("answers the runtime's files from the cache, anything else from the real fetch, until end()", async () => {
    const cache = new FakeCache();
    await cache.put(BASE + "pyodide.asm.wasm", new Response(new Uint8Array(7), { headers: { "content-type": "application/wasm" } }));
    const network: string[] = [];
    const scope = {
      fetch(this: unknown, input: string | Request) {
        if (this !== scope) throw new TypeError("Illegal invocation");
        network.push(input instanceof Request ? input.url : input);
        return Promise.resolve(new Response("net"));
      },
    } as unknown as { fetch: typeof fetch };
    const original = scope.fetch;
    const serving = serveFromCache(scope, cache, BASE);
    // Pyodide asks by absolute URL, by a path, or with a Request.
    expect((await (await scope.fetch(BASE + "pyodide.asm.wasm")).arrayBuffer()).byteLength).toBe(7);
    expect((await (await scope.fetch("/pyodide/314.0.7-heap512/pyodide.asm.wasm")).arrayBuffer()).byteLength).toBe(7);
    expect((await scope.fetch(new Request(BASE + "pyodide.asm.wasm"))).headers.get("content-type")).toBe("application/wasm");
    expect(network).toEqual([]);
    // Not in the cache (a refused put), a package, another folder: the network, with fetch's own this.
    expect(await (await scope.fetch(BASE + "python_stdlib.zip")).text()).toBe("net");
    expect(await (await scope.fetch(BASE + "numpy-2.4.6.whl", { integrity: "sha256-x" })).text()).toBe("net");
    expect(await (await scope.fetch("http://h/pyodide/313.0.0-heap512/pyodide.asm.wasm")).text()).toBe("net");
    expect(network).toEqual([BASE + "python_stdlib.zip", BASE + "numpy-2.4.6.whl", "http://h/pyodide/313.0.0-heap512/pyodide.asm.wasm"]);
    serving.end();
    expect(scope.fetch).toBe(original);
    expect(cache.matchOptions.length).toBeGreaterThan(0);
    expect(cache.matchOptions.every((o) => o?.ignoreVary === true)).toBe(true);
  });
});
