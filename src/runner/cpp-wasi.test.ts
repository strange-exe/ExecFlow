import { describe, expect, it } from "vitest";
import { createWasi, describeCrash, Exit, importObject, type WasiOptions } from "./cpp-wasi";
import { E, OFLAGS, RIGHTS, ROOT_FD, WasiFs } from "./cpp-wasi-fs";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** "h" + e-acute: a 2-byte UTF-8 character in argv. */
const H_E = "h" + String.fromCodePoint(0xe9);

/** A host over a fresh 1-page memory; `call` invokes an import by name. */
function setup(extra: Partial<WasiOptions> = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const out: string[] = [];
  const fs = new WasiFs([{ path: "input.txt", bytes: enc.encode("abc\n") }]);
  const host = createWasi({
    args: ["main", H_E], stdin: enc.encode("5\n"), input: null, askForInput: () => {}, flush: () => {}, fs,
    write: (stream, bytes) => out.push(`${stream}:${dec.decode(bytes)}`), ...extra,
  });
  host.bind(memory);
  const dv = () => new DataView(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);
  const call = (name: string, ...args: (number | bigint)[]) => (host.imports[name] as unknown as (...a: (number | bigint)[]) => number)(...args);
  const putStr = (at: number, s: string) => { const b = enc.encode(s); u8().set(b, at); return b.length; };
  const iov = (at: number, ptr: number, len: number) => { dv().setUint32(at, ptr, true); dv().setUint32(at + 4, len, true); };
  return { host, fs, out, dv, u8, call, putStr, iov };
}

describe("the WASI host", () => {
  it("preopens the program folder as '.' on fd 3 only", () => {
    const { call, dv, u8 } = setup();
    expect(call("fd_prestat_get", 3, 100)).toBe(E.SUCCESS);
    expect([dv().getUint8(100), dv().getUint32(104, true)]).toEqual([0, 1]);
    expect(call("fd_prestat_dir_name", 3, 200, 1)).toBe(E.SUCCESS);
    expect(u8()[200]).toBe(0x2e);
    expect(call("fd_prestat_get", 4, 100)).toBe(E.BADF);
    // The preopen is a directory with every right, so wasi-libc's rights check accepts it.
    expect(call("fd_fdstat_get", 3, 300)).toBe(E.SUCCESS);
    expect([dv().getUint8(300), dv().getBigUint64(308, true), dv().getBigUint64(316, true)]).toEqual([3, RIGHTS.ALL, RIGHTS.ALL]);
  });

  it("opens, writes, seeks and reads a file through memory", () => {
    const { call, dv, u8, putStr, iov, fs } = setup();
    const len = putStr(1000, "out.txt");
    expect(call("path_open", ROOT_FD, 1, 1000, len, OFLAGS.CREAT | OFLAGS.TRUNC, RIGHTS.ALL, RIGHTS.ALL, 0, 1100)).toBe(E.SUCCESS);
    const fd = dv().getUint32(1100, true);
    expect(fd).toBe(4);
    putStr(2000, "hello");
    iov(1200, 2000, 5);
    expect(call("fd_write", fd, 1200, 1, 1300)).toBe(E.SUCCESS);
    expect(dv().getUint32(1300, true)).toBe(5);
    expect(call("fd_seek", fd, 1n, 2 /* SET */, 1400)).toBe(E.SUCCESS);
    expect(dv().getBigUint64(1400, true)).toBe(1n);
    iov(1200, 3000, 10);
    expect(call("fd_read", fd, 1200, 1, 1300)).toBe(E.SUCCESS);
    expect(dec.decode(u8().slice(3000, 3000 + dv().getUint32(1300, true)))).toBe("ello");
    expect(call("fd_seek", 1, 0n, 0, 1400)).toBe(E.SPIPE);
    expect(fs.changes().map((c) => c.path)).toEqual(["out.txt"]);
  });

  it("lets freopen put a file on stdin and stdout (fd_renumber)", () => {
    const { call, dv, u8, putStr, iov, out, fs } = setup();
    const open = (name: string, oflags: number) => {
      const len = putStr(1000, name);
      expect(call("path_open", ROOT_FD, 1, 1000, len, oflags, RIGHTS.ALL, RIGHTS.ALL, 0, 1100)).toBe(E.SUCCESS);
      return dv().getUint32(1100, true);
    };
    const input = open("input.txt", 0);
    expect(call("fd_renumber", input, 0)).toBe(E.SUCCESS);
    expect(call("fd_read", input, 1200, 1, 1300)).toBe(E.BADF); // the old number is gone
    iov(1200, 3000, 16);
    expect(call("fd_read", 0, 1200, 1, 1300)).toBe(E.SUCCESS);
    expect(dec.decode(u8().slice(3000, 3000 + dv().getUint32(1300, true)))).toBe("abc\n"); // the file, not the Input box
    expect(call("fd_fdstat_get", 0, 1400)).toBe(E.SUCCESS);
    expect(dv().getUint8(1400)).toBe(4); // a regular file now, so stdio buffers it as one
    const output = open("output.txt", OFLAGS.CREAT | OFLAGS.TRUNC);
    expect(call("fd_renumber", output, 1)).toBe(E.SUCCESS);
    putStr(2000, "to file");
    iov(1200, 2000, 7);
    expect(call("fd_write", 1, 1200, 1, 1300)).toBe(E.SUCCESS);
    expect(out).toEqual([]);
    expect(fs.changes().map((c) => [c.path, dec.decode(c.bytes)])).toEqual([["output.txt", "to file"]]);
    expect(call("fd_close", 1)).toBe(E.SUCCESS); // fclose(stdout): fd 1 is the console again
    expect(call("fd_write", 1, 1200, 1, 1300)).toBe(E.SUCCESS);
    expect(out).toEqual(["stdout:to file"]);
    expect(call("fd_renumber", 2, 5)).toBe(E.NOTSUP);
    expect(call("fd_renumber", 9, 0)).toBe(E.BADF);
    expect(call("fd_renumber", open("input.txt", 0), 12)).toBe(E.BADF);
    expect(call("fd_renumber", open("input.txt", 0), ROOT_FD)).toBe(E.NOTSUP);
  });

  it("writes filestat and dirent in the snapshot-0 layout", () => {
    const { call, dv, u8, putStr } = setup();
    const len = putStr(1000, "input.txt");
    expect(call("path_filestat_get", ROOT_FD, 0, 1000, len, 2000)).toBe(E.SUCCESS);
    expect([dv().getUint8(2016), dv().getUint32(2020, true), dv().getBigUint64(2024, true)]).toEqual([4, 1, 4n]);
    const dl = putStr(1000, ".");
    expect(call("path_open", ROOT_FD, 1, 1000, dl, OFLAGS.DIRECTORY, RIGHTS.ALL, RIGHTS.ALL, 0, 1100)).toBe(E.SUCCESS);
    const dir = dv().getUint32(1100, true);
    expect(call("fd_readdir", dir, 3000, 4096, 0n, 1200)).toBe(E.SUCCESS);
    const used = dv().getUint32(1200, true);
    const names: string[] = [];
    for (let at = 3000; at < 3000 + used;) {
      const n = dv().getUint32(at + 16, true);
      names.push(dec.decode(u8().slice(at + 24, at + 24 + n)));
      at += 24 + n;
    }
    expect(names).toEqual([".", "..", "input.txt"]);
    // A small buffer is filled to the brim, so libc asks again from the next cookie.
    expect(call("fd_readdir", dir, 3000, 30, 0n, 1200)).toBe(E.SUCCESS);
    expect(dv().getUint32(1200, true)).toBe(30);
  });

  it("passes argv as UTF-8 and reads the Input box, then end of input", () => {
    const { call, dv, u8, iov } = setup();
    call("args_sizes_get", 100, 104);
    expect([dv().getUint32(100, true), dv().getUint32(104, true)]).toEqual([2, 5 + 4]);
    call("args_get", 200, 300);
    expect(dec.decode(u8().slice(300, 309))).toBe(`main\0${H_E}\0`);
    iov(400, 500, 16);
    call("fd_read", 0, 400, 1, 450);
    expect(dv().getUint32(450, true)).toBe(2);
    call("fd_read", 0, 400, 1, 450);
    expect(dv().getUint32(450, true)).toBe(0); // no live input channel: end of input
  });

  it("sleeps for clock subscriptions (poll_oneoff), flushing output first", () => {
    let flushed = 0;
    const { call, dv } = setup({ flush: () => { flushed++; } });
    const sub = 1000;
    dv().setBigUint64(sub, 77n, true); // userdata
    dv().setUint8(sub + 8, 0); // clock
    dv().setUint32(sub + 24, 0, true); // REALTIME, as nanosleep asks
    dv().setBigUint64(sub + 32, 30_000_000n, true); // 30 ms, relative
    const t = performance.now();
    expect(call("poll_oneoff", sub, 2000, 1, 3000)).toBe(E.SUCCESS);
    expect(performance.now() - t).toBeGreaterThanOrEqual(25);
    expect(flushed).toBe(1);
    expect([dv().getUint32(3000, true), dv().getBigUint64(2000, true), dv().getUint16(2008, true)]).toEqual([1, 77n, 0]);
  });

  it("fills large random buffers (getRandomValues takes 64 KiB at a time)", () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const host = createWasi({ args: [], stdin: new Uint8Array(), input: null, askForInput: () => {}, flush: () => {}, write: () => {}, fs: new WasiFs([]) });
    host.bind(memory);
    expect((host.imports.random_get as unknown as (b: number, l: number) => number)(0, 200_000)).toBe(E.SUCCESS);
    expect(new Uint8Array(memory.buffer, 150_000, 1000).some((b) => b !== 0)).toBe(true);
  });

  it("reports clocks in nanoseconds", () => {
    const { call, dv } = setup();
    call("clock_time_get", 0, 0n, 100);
    expect(Number(dv().getBigUint64(100, true) / 1_000_000n)).toBeGreaterThan(Date.now() - 5000);
    expect(call("clock_time_get", 2, 0n, 100)).toBe(E.SUCCESS);
    expect(dv().getBigUint64(100, true)).toBeLessThan(60_000_000_000n);
    expect(call("clock_time_get", 9, 0n, 100)).toBe(E.INVAL);
  });

  it("binds only its own WASI functions: a module can't reach Object.prototype through its import names", async () => {
    // What a program gets by redeclaring a libc WASI symbol with
    // __attribute__((import_module("__proto__"), import_name("then"))): it linked, and binding it
    // set Object.prototype.then in the worker, so instantiate() never resolved (the run hung).
    const enc8 = (s: string) => [s.length, ...enc.encode(s)];
    const imports: [string, string][] = [["__proto__", "then"], ["wasi_unstable", "toString"], ["env", "sched_yield"], ["wasi_unstable", "sched_yield"]];
    const body = [imports.length, ...imports.flatMap(([m, n]) => [...enc8(m), ...enc8(n), 0, 0])];
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 2, body.length, ...body]);
    const module = new WebAssembly.Module(bytes);
    const { host } = setup();
    const bound = importObject(module, host) as Record<string, Record<string, () => number>>;
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "then")).toBe(false);
    expect(bound["__proto__"].then()).toBe(E.NOSYS);
    expect(bound.wasi_unstable.toString()).toBe(E.NOSYS); // not Object.prototype.toString
    expect(bound.env.sched_yield()).toBe(E.NOSYS); // WASI functions only under wasi_unstable
    expect(bound.wasi_unstable.sched_yield).toBe(host.imports.sched_yield);
    const instance = await Promise.race([WebAssembly.instantiate(module, bound), new Promise((r) => setTimeout(() => r("hung"), 1000))]);
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
  });

  it("exits with proc_exit and words traps for students", () => {
    const { host } = setup();
    expect(() => (host.imports.proc_exit as unknown as (c: number) => number)(3)).toThrow(Exit);
    expect(describeCrash(new RangeError("Maximum call stack size exceeded"))).toMatch(/stack overflow/);
    expect(describeCrash(new Error("too much recursion"))).toMatch(/stack overflow/);
    expect(describeCrash(new Error("memory access out of bounds"))).toMatch(/invalid memory access/);
    expect(describeCrash(new Error("Out of bounds memory access"))).toMatch(/invalid memory access/);
    expect(describeCrash(new Error("divide by zero"))).toMatch(/division by zero/);
    expect(describeCrash(new Error("remainder by zero"))).toMatch(/division by zero/);
    expect(describeCrash(new Error("unreachable"))).toMatch(/abort/);
  });
});
