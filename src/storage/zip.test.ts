import { describe, expect, it } from "vitest";
import { crc32, readZip, writeZip, ZIP_LIMITS, ZipError } from "./zip";

const utf8 = (s: string) => new TextEncoder().encode(s);

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface RawEntry {
  name: string | Uint8Array;
  data: Uint8Array;
  /** Bytes stored for the entry (defaults to `data`, i.e. method 0). */
  body?: Uint8Array;
  method?: number;
  flags?: number;
  /** Lies to tell. */
  usize?: number;
  crc?: number;
  /** Write sizes after the data (flag bit 3) instead of in the local header. */
  descriptor?: boolean;
}

/** A hand-built zip for hostile cases; `tweak` edits the end-of-directory record. */
function rawZip(entries: RawEntry[], tweak?: (view: DataView, eocd: number) => void): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === "string" ? utf8(e.name) : e.name;
    const body = e.body ?? e.data;
    const method = e.method ?? 0;
    const crc = e.crc ?? crc32(e.data);
    const usize = e.usize ?? e.data.length;
    const flags = (e.flags ?? 0x0800) | (e.descriptor ? 0x0008 : 0);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, flags, true);
    head.setUint16(8, method, true);
    if (!e.descriptor) {
      head.setUint32(14, crc, true);
      head.setUint32(18, body.length, true);
      head.setUint32(22, usize, true);
    }
    head.setUint16(26, name.length, true);
    locals.push(new Uint8Array(head.buffer), name, body);
    let size = 30 + name.length + body.length;
    if (e.descriptor) {
      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, body.length, true);
      dd.setUint32(12, usize, true);
      locals.push(new Uint8Array(dd.buffer));
      size += 16;
    }
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, flags, true);
    cen.setUint16(10, method, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, usize, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    centrals.push(new Uint8Array(cen.buffer), name);
    offset += size;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  tweak?.(new DataView(out.buffer), out.length - 22);
  return out;
}

/** The ZipError code readZip throws, or "ok". */
async function failure(bytes: Uint8Array, limits = {}): Promise<string> {
  try {
    await readZip(bytes, limits);
    return "ok";
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("writeZip and readZip", () => {
  it("round-trip files byte for byte, with UTF-8 names and empty folders", async () => {
    const cafe = "docs/caf" + String.fromCodePoint(0xe9) + " notes.md";
    const files = [
      { path: "main.py", bytes: utf8("print('hi')\n"), mtime: Date.UTC(2026, 9, 16, 10, 30) },
      { path: "src/util/helpers.c", bytes: utf8("int add(int a, int b) { return a + b; }\n".repeat(200)) },
      { path: cafe, bytes: utf8("na" + String.fromCodePoint(0xef) + "ve\n") },
      { path: "empty.txt", bytes: new Uint8Array() },
      { path: "win.c", bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x78, 0x0d, 0x0a]) },
    ];
    const zip = await writeZip(files, ["empty/dir"]);
    const back = await readZip(zip);
    expect(back.files).toEqual(files.map((f) => ({ path: f.path, bytes: f.bytes })));
    expect(back.dirs).toEqual(["empty/dir"]);
    expect(back.refused).toEqual([]);
    const view = new DataView(zip.buffer);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800); // UTF-8 names
    expect(view.getUint16(8, true)).toBe(0); // tiny main.py is stored
    expect(zip.length).toBeLessThan(files[1]!.bytes.length); // helpers.c was deflated
  });

  it("refuses to write unsafe or repeated paths", async () => {
    await expect(writeZip([{ path: "../x.c", bytes: new Uint8Array() }])).rejects.toMatchObject({ code: "unsafe-path" });
    await expect(writeZip([{ path: "a.c", bytes: new Uint8Array() }], ["a.c"])).rejects.toMatchObject({ code: "corrupt" });
  });

  it("reads entries that use data descriptors and deflate", async () => {
    const data = utf8("x = 1\n".repeat(100));
    const zip = rawZip([{ name: "a/b.py", data, body: await deflate(data), method: 8, descriptor: true }, { name: "a/", data: new Uint8Array() }]);
    const back = await readZip(zip);
    expect(back.files).toEqual([{ path: "a/b.py", bytes: data }]);
    expect(back.dirs).toEqual(["a"]);
  });

  it("uses the stated limits", () => {
    expect(ZIP_LIMITS).toEqual({ maxFiles: 2000, maxDirs: 2000, maxFileBytes: 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 });
  });
});

describe("hostile archives", () => {
  const bomb = new Uint8Array(20 * 1024 * 1024); // 20 MiB of zeros deflates to ~20 KB

  it("refuses an entry larger than 1 MiB without unpacking it (zip bomb)", async () => {
    const body = await deflate(bomb);
    expect(body.length).toBeLessThan(100 * 1024);
    const back = await readZip(rawZip([{ name: "big.py", data: bomb, body, method: 8 }, { name: "ok.py", data: utf8("ok\n") }]));
    expect(back.files.map((f) => f.path)).toEqual(["ok.py"]);
    expect(back.refused).toEqual([{ name: "big.py", reason: expect.stringContaining("KB") }]);
  });

  it("stops a bomb that lies about its size as soon as the output passes the stated size", async () => {
    const body = await deflate(bomb);
    const started = performance.now();
    expect(await failure(rawZip([{ name: "big.py", data: bomb, body, method: 8, usize: 100 }]))).toBe("too-large");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("rejects the whole archive for Zip Slip names", async () => {
    for (const name of ["../../evil.py", "/etc/evil.py", "C:/evil.py", "c:evil.py", "a\\..\\..\\evil.py", "ok/../../evil.py", "\\\\server\\share.py"]) {
      expect(await failure(rawZip([{ name: "fine.py", data: utf8("1") }, { name, data: utf8("x") }])), name).toBe("unsafe-path");
    }
  });

  it("refuses unusable names and methods one by one", async () => {
    const back = await readZip(
      rawZip([
        { name: "good.py", data: utf8("g\n") },
        { name: ".git/config", data: utf8("[core]\n") },
        { name: "con.txt", data: utf8("x") },
        { name: "what?.c", data: utf8("x") },
        { name: new Uint8Array([0xff, 0x2e, 0x63]), data: utf8("x"), flags: 0 },
        { name: "bzip2.c", data: utf8("x"), method: 12 },
        { name: "good.py", data: utf8("again\n") },
        { name: "name" + String.fromCodePoint(0x202e) + "yp.exe", data: utf8("x") },
      ]),
    );
    expect(back.files).toEqual([{ path: "good.py", bytes: utf8("g\n") }]);
    expect(back.refused.map((r) => r.name)).toEqual([".git/config", "con.txt", "what?.c", String.fromCodePoint(0xfffd) + ".c", "bzip2.c", "good.py", "nameyp.exe"]);
    for (const r of back.refused) expect(r.reason.length).toBeGreaterThan(5);
  });

  it("rejects a CRC mismatch, a stored entry with two sizes, and broken deflate data", async () => {
    expect(await failure(rawZip([{ name: "a.c", data: utf8("hello"), crc: 1234 }]))).toBe("crc");
    expect(await failure(rawZip([{ name: "a.c", data: utf8("hello"), usize: 4 }]))).toBe("corrupt");
    expect(await failure(rawZip([{ name: "a.c", data: utf8("hello"), body: new Uint8Array([0xff, 0xff, 0xff, 0xff]), method: 8 }]))).toBe("corrupt");
    const zip = await writeZip([{ path: "main.py", bytes: utf8("print('hi')\n") }]);
    zip[30 + "main.py".length + 2] ^= 0xff; // flip a byte of the stored body
    expect(await failure(zip)).toBe("crc");
  });

  it("rejects encryption, ZIP64, split archives and non-zips", async () => {
    expect(await failure(rawZip([{ name: "a.c", data: utf8("x"), flags: 0x0801 }]))).toBe("encrypted");
    expect(await failure(rawZip([{ name: "a.c", data: utf8("x") }], (v, e) => v.setUint16(e + 10, 0xffff, true)))).toBe("unsupported");
    expect(await failure(rawZip([{ name: "a.c", data: utf8("x") }], (v, e) => v.setUint32(e + 16, 0xffffffff, true)))).toBe("unsupported");
    expect(await failure(rawZip([{ name: "a.c", data: utf8("x") }], (v, e) => v.setUint16(e + 4, 1, true)))).toBe("unsupported");
    expect(await failure(utf8("just some text, not a zip"))).toBe("not-zip");
    expect(await failure(new Uint8Array())).toBe("not-zip");
  });

  it("rejects a damaged directory or entry offsets", async () => {
    expect(await failure(rawZip([{ name: "a.c", data: utf8("x") }], (v, e) => v.setUint32(e + 16, 5, true)))).toBe("corrupt");
    const shifted = rawZip([{ name: "a.c", data: utf8("x") }]);
    const cd = new DataView(shifted.buffer).getUint32(shifted.length - 22 + 16, true);
    new DataView(shifted.buffer).setUint32(cd + 42, 3, true); // local header offset points mid-header
    expect(await failure(shifted)).toBe("corrupt");
  });

  it("rejects an entry whose local header disagrees on the method, or whose data runs into the directory", async () => {
    const methods = rawZip([{ name: "a.c", data: utf8("hello") }]);
    new DataView(methods.buffer).setUint16(8, 8, true); // local header says deflate, the directory says stored
    expect(await failure(methods)).toBe("corrupt");
    // A "file" whose stated sizes (and CRC) cover the central directory itself.
    const data = utf8("hello");
    const overlap = rawZip([{ name: "a.c", data }]);
    const view = new DataView(overlap.buffer);
    const cd = view.getUint32(overlap.length - 22 + 16, true);
    const start = 30 + "a.c".length;
    const stolen = data.length + 16;
    view.setUint32(cd + 20, stolen, true);
    view.setUint32(cd + 24, stolen, true);
    view.setUint32(cd + 16, crc32(overlap.subarray(start, start + stolen)), true);
    expect(await failure(overlap)).toBe("corrupt");
  });

  it("enforces the folder limit", async () => {
    const dirs = rawZip(["a/", "b/", "c/"].map((name) => ({ name, data: new Uint8Array() })));
    expect(await failure(dirs, { maxDirs: 3 })).toBe("ok");
    expect(await failure(dirs, { maxDirs: 2 })).toBe("too-many");
  });

  it("enforces the entry, file and total limits", async () => {
    const three = rawZip([1, 2, 3].map((n) => ({ name: `f${n}.c`, data: utf8("x") })));
    expect(await failure(three, { maxFiles: 2, maxDirs: 0 })).toBe("too-many");
    expect(await failure(three, { maxFiles: 2, maxDirs: 5 })).toBe("too-many");
    expect(await failure(three, { maxFiles: 3 })).toBe("ok");
    const two = rawZip([{ name: "a.c", data: utf8("12345678") }, { name: "b.c", data: utf8("12345678") }]);
    expect(await failure(two, { maxTotalBytes: 10 })).toBe("too-large");
  });
});
