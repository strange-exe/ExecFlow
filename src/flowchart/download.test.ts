import { describe, expect, it } from "vitest";
import { downloadVerified, sha256Hex } from "./download";

const enc = new TextEncoder();
const GOOD = enc.encode("grammar bytes");

/** A fetch that answers from a list of canned responses, one per call, and counts the calls. */
function fakeFetch(answers: (() => Response)[]) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const noSleep = async () => {};

describe("downloadVerified (the build's grammar download)", () => {
  it("returns the bytes when their sha256 matches the pin", async () => {
    const expected = await sha256Hex(GOOD);
    const { fn, calls } = fakeFetch([() => new Response(GOOD)]);
    const bytes = await downloadVerified("https://cdn.example/x.wasm", expected, { fetch: fn, maxBytes: 1024, sleep: noSleep });
    expect(new TextDecoder().decode(bytes)).toBe("grammar bytes");
    expect(calls).toEqual(["https://cdn.example/x.wasm"]);
  });

  it("refuses bytes whose sha256 differs from the pin, after retrying", async () => {
    const expected = await sha256Hex(GOOD);
    const { fn, calls } = fakeFetch([() => new Response(enc.encode("tampered"))]);
    await expect(downloadVerified("https://cdn.example/x.wasm", expected, { fetch: fn, maxBytes: 1024, attempts: 3, sleep: noSleep })).rejects.toThrow(
      /sha256 [0-9a-f]{64} doesn't match the pinned/,
    );
    expect(calls.length).toBe(3);
  });

  it("gives up at once on 404 (a wrong version or file name is not a network hiccup)", async () => {
    const { fn, calls } = fakeFetch([() => new Response("missing", { status: 404 })]);
    await expect(downloadVerified("https://cdn.example/x.wasm", "0".repeat(64), { fetch: fn, maxBytes: 1024, attempts: 4, sleep: noSleep })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(calls.length).toBe(1);
  });

  it("retries a failed attempt and keeps the good one", async () => {
    const expected = await sha256Hex(GOOD);
    const { fn, calls } = fakeFetch([() => new Response("busy", { status: 503 }), () => new Response(GOOD)]);
    const bytes = await downloadVerified("https://cdn.example/x.wasm", expected, { fetch: fn, maxBytes: 1024, sleep: noSleep });
    expect(bytes.length).toBe(GOOD.length);
    expect(calls.length).toBe(2);
  });

  it("refuses a body over the size cap, declared or streamed", async () => {
    const big = new Uint8Array(2048);
    const declared = fakeFetch([() => new Response(big, { headers: { "content-length": "2048" } })]);
    await expect(downloadVerified("https://cdn.example/x.wasm", "0".repeat(64), { fetch: declared.fn, maxBytes: 1024, attempts: 1, sleep: noSleep })).rejects.toThrow(
      /more than the 1024 bytes allowed/,
    );
    // No content-length: the stream is counted as it arrives.
    const streamed = fakeFetch([
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(512));
              c.close();
            },
          }),
        ),
    ]);
    await expect(downloadVerified("https://cdn.example/x.wasm", "0".repeat(64), { fetch: streamed.fn, maxBytes: 1024, attempts: 1, sleep: noSleep })).rejects.toThrow(
      /larger than the 1024 bytes allowed/,
    );
  });

  it("refuses a pin that is not a sha256", async () => {
    const { fn } = fakeFetch([() => new Response(GOOD)]);
    await expect(downloadVerified("https://cdn.example/x.wasm", "abc", { fetch: fn, maxBytes: 1024, sleep: noSleep })).rejects.toThrow(/not a sha256/);
  });
});
