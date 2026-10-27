// The flowchart worker reads parser files with a size cap (attack pass finding 7): a server that
// sends too much is refused before it fills the worker's memory, declared or not.
import { describe, expect, it } from "vitest";
import { readCapped } from "./read-capped";

const stream = (chunks: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n).fill(7));
      c.close();
    },
  });

describe("readCapped", () => {
  it("returns every byte of a file within the cap", async () => {
    const bytes = await readCapped(new Response(stream([3, 4, 5])), 12);
    expect(bytes.length).toBe(12);
    expect(bytes.every((b) => b === 7)).toBe(true);
  });

  it("refuses a declared length past the cap without reading the body", async () => {
    let pulled = false;
    // highWaterMark 0: the stream pulls only when something reads (by default it pulls once at once).
    const body = new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 });
    const res = new Response(body, { headers: { "content-length": "13" } });
    await expect(readCapped(res, 12)).rejects.toThrow(/larger than 12 bytes/);
    expect(pulled).toBe(false);
  });

  it("stops reading a body with no length once it passes the cap", async () => {
    await expect(readCapped(new Response(stream([8, 8, 8])), 12)).rejects.toThrow(/larger than 12 bytes/);
  });
});
