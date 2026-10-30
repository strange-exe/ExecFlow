import { describe, expect, it } from "vitest";
import { E, FILETYPE, OFLAGS, RIGHTS, ROOT_FD, WasiFs, WHENCE } from "./cpp-wasi-fs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const R = RIGHTS.ALL & ~RIGHTS.FD_WRITE; // what wasi-libc asks for with fopen("r") (0x1fbffebe-ish)
const W = RIGHTS.ALL & ~RIGHTS.FD_READ;
const RW = RIGHTS.ALL;
const make = (files: Record<string, string> = { "input.txt": "3 4\n", "data/x.txt": "x\n" }) =>
  new WasiFs(Object.entries(files).map(([path, text]) => ({ path, bytes: enc.encode(text) })));
const fd = (r: { ok: true; value: number } | { ok: false; errno: number }) => {
  if (!r.ok) throw new Error(`errno ${r.errno}`);
  return r.value;
};
const readAll = (fs: WasiFs, f: number) => {
  const r = fs.read(f, 1 << 20);
  if (!r.ok) throw new Error(`errno ${r.errno}`);
  return dec.decode(r.value);
};

describe("the program's folder as WASI sees it", () => {
  it("reads files by relative path, also through ./ and sub-folders", () => {
    const fs = make();
    expect(readAll(fs, fd(fs.open(ROOT_FD, "input.txt", 0, R, 0)))).toBe("3 4\n");
    expect(readAll(fs, fd(fs.open(ROOT_FD, "./data/../data/x.txt", 0, R, 0)))).toBe("x\n");
    expect(fs.open(ROOT_FD, "missing.txt", 0, R, 0)).toEqual({ ok: false, errno: E.NOENT });
  });

  it("never leaves the folder", () => {
    const fs = make();
    expect(fs.open(ROOT_FD, "../secret.txt", 0, R, 0)).toEqual({ ok: false, errno: E.NOTCAPABLE });
    expect(fs.open(ROOT_FD, "data/../../x", OFLAGS.CREAT, W, 0)).toEqual({ ok: false, errno: E.NOTCAPABLE });
    expect(fs.open(ROOT_FD, "/etc/passwd", 0, R, 0)).toEqual({ ok: false, errno: E.NOTCAPABLE });
    expect(fs.open(99, "input.txt", 0, R, 0)).toEqual({ ok: false, errno: E.BADF });
  });

  it("creates, truncates and appends; reports what changed", () => {
    const fs = make();
    const out = fd(fs.open(ROOT_FD, "out.txt", OFLAGS.CREAT | OFLAGS.TRUNC, W, 0));
    expect(fs.write(out, enc.encode("hello 42\n"))).toEqual({ ok: true, value: 9 });
    fs.close(out);
    const app = fd(fs.open(ROOT_FD, "out.txt", OFLAGS.CREAT, W, 1));
    fs.write(app, enc.encode("more\n"));
    expect(fs.write(fd(fs.open(ROOT_FD, "input.txt", 0, R, 0)), enc.encode("x"))).toEqual({ ok: false, errno: E.BADF });
    expect(fs.changes().map((c) => [c.path, dec.decode(c.bytes)])).toEqual([["out.txt", "hello 42\nmore\n"]]);
    // Rewriting a file with the same bytes is not a change.
    const same = fd(fs.open(ROOT_FD, "input.txt", OFLAGS.TRUNC, W, 0));
    fs.write(same, enc.encode("3 4\n"));
    expect(fs.changes().map((c) => c.path)).toEqual(["out.txt"]);
  });

  it("seeks with preview1 whence values (SET=0, CUR=1, END=2) and writes in place", () => {
    const fs = make();
    const f = fd(fs.open(ROOT_FD, "input.txt", 0, RW, 0));
    expect(fs.seek(f, 0n, WHENCE.END)).toEqual({ ok: true, value: 4 });
    expect(fs.seek(f, 2n, WHENCE.SET)).toEqual({ ok: true, value: 2 });
    fs.write(f, enc.encode("X"));
    expect(fs.tell(f)).toEqual({ ok: true, value: 3 });
    expect(fs.seek(f, -10n, WHENCE.CUR)).toEqual({ ok: false, errno: E.INVAL });
    fs.seek(f, 0n, WHENCE.SET);
    expect(readAll(fs, f)).toBe("3 X\n");
    expect(fs.read(f, 10, 1)).toEqual({ ok: true, value: enc.encode(" X\n") }); // pread
  });

  it("fills a gap left by writing past the end with zeros, never with bytes the file held before", () => {
    const fs = make({ "log.txt": "SECRET-OLD-CONTENT\n", "w.txt": "ABCDEFGH" });
    const f = fd(fs.open(ROOT_FD, "log.txt", OFLAGS.TRUNC, RW, 0)); // fopen("w") keeps the old buffer
    fs.seek(f, 6n, WHENCE.SET);
    fs.write(f, enc.encode("X"));
    expect(fs.read(f, 100, 0)).toEqual({ ok: true, value: enc.encode("\0\0\0\0\0\0X") });
    const g = fd(fs.open(ROOT_FD, "w.txt", 0, RW, 0));
    expect(fs.setSize(g, 2)).toBe(E.SUCCESS); // ftruncate down, then pwrite past the end
    fs.write(g, enc.encode("Y"), 5);
    expect(fs.read(g, 100, 0)).toEqual({ ok: true, value: new Uint8Array([0x41, 0x42, 0, 0, 0, 0x59]) });
  });

  it("makes folders, lists them, removes files and folders, renames", () => {
    const fs = make();
    expect(fs.mkdir(ROOT_FD, "results")).toBe(E.SUCCESS);
    expect(fs.mkdir(ROOT_FD, "results")).toBe(E.EXIST);
    expect(fs.mkdir(ROOT_FD, "a/b")).toBe(E.NOENT);
    const f = fd(fs.open(ROOT_FD, "results/r.txt", OFLAGS.CREAT, W, 0));
    fs.write(f, enc.encode("r"));
    const dir = fd(fs.open(ROOT_FD, ".", OFLAGS.DIRECTORY, R, 0));
    const list = fs.list(dir);
    expect(list.ok && list.value.map((e) => [e.name, e.filetype])).toEqual([
      [".", FILETYPE.DIRECTORY], ["..", FILETYPE.DIRECTORY], ["data", FILETYPE.DIRECTORY], ["input.txt", FILETYPE.REGULAR_FILE], ["results", FILETYPE.DIRECTORY],
    ]);
    expect(fs.rmdir(ROOT_FD, "results")).toBe(E.NOTEMPTY);
    expect(fs.unlink(ROOT_FD, "results")).toBe(E.ISDIR);
    expect(fs.rename(ROOT_FD, "results/r.txt", ROOT_FD, "final.txt")).toBe(E.SUCCESS);
    expect(fs.rmdir(ROOT_FD, "results")).toBe(E.SUCCESS);
    expect(fs.unlink(ROOT_FD, "input.txt")).toBe(E.SUCCESS);
    expect(fs.pathStat(ROOT_FD, "input.txt")).toEqual({ ok: false, errno: E.NOENT });
    expect(fs.pathStat(ROOT_FD, "final.txt")).toMatchObject({ ok: true, value: { filetype: FILETYPE.REGULAR_FILE, size: 1 } });
    expect(fs.changes().map((c) => c.path)).toEqual(["final.txt"]);
  });

  it("caps how much a program can write", () => {
    const fs = new WasiFs([], { growBytes: 1000, maxEntries: 3, maxOpen: 2 });
    const f = fd(fs.open(ROOT_FD, "big.txt", OFLAGS.CREAT, W, 0));
    expect(fs.write(f, new Uint8Array(900))).toMatchObject({ ok: true });
    expect(fs.write(f, new Uint8Array(200))).toEqual({ ok: false, errno: E.NOSPC });
    expect(fs.setSize(f, 5000)).toBe(E.FBIG);
    fd(fs.open(ROOT_FD, "b.txt", OFLAGS.CREAT, W, 0));
    expect(fs.open(ROOT_FD, "c.txt", OFLAGS.CREAT, W, 0)).toEqual({ ok: false, errno: 33 /* EMFILE */ });
  });

  it("lets go of a file's memory when it shrinks, so truncating can't stack up past the cap", () => {
    // Security review of 0.17.0 (2026-10-30): a truncate gave back budget but kept the buffer, so filling
    // file after file and truncating each held far more memory than the cap.
    const fs = new WasiFs([], { growBytes: 1000, maxEntries: 10, maxOpen: 4 });
    for (let i = 0; i < 6; i++) {
      const f = fd(fs.open(ROOT_FD, `f${i}.txt`, OFLAGS.CREAT | OFLAGS.TRUNC, W, 0));
      expect(fs.write(f, new Uint8Array(900))).toMatchObject({ ok: true });
      fs.close(f);
      fs.close(fd(fs.open(ROOT_FD, `f${i}.txt`, OFLAGS.TRUNC, W, 0)));
      expect(fs.heldBytes(), `after file ${i}`).toBeLessThanOrEqual(1000);
    }
    const g = fd(fs.open(ROOT_FD, "g.txt", OFLAGS.CREAT, RW, 0));
    fs.write(g, new Uint8Array(900).fill(7));
    expect(fs.setSize(g, 3)).toBe(E.SUCCESS); // ftruncate down keeps what is left
    expect(fs.heldBytes()).toBeLessThanOrEqual(1000);
    expect(fs.read(g, 10, 0)).toEqual({ ok: true, value: new Uint8Array([7, 7, 7]) });
  });

  it("refuses to write through directories and to create in missing folders", () => {
    const fs = make();
    expect(fs.open(ROOT_FD, "data", 0, W, 0)).toEqual({ ok: false, errno: E.ISDIR });
    expect(fs.open(ROOT_FD, "nope/x.txt", OFLAGS.CREAT, W, 0)).toEqual({ ok: false, errno: E.NOENT });
    expect(fs.open(ROOT_FD, "input.txt", OFLAGS.CREAT | OFLAGS.EXCL, W, 0)).toEqual({ ok: false, errno: E.EXIST });
    expect(fs.open(ROOT_FD, "input.txt", OFLAGS.DIRECTORY, R, 0)).toEqual({ ok: false, errno: E.NOTDIR });
  });
});
