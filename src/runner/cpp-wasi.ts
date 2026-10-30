// The WASI ("wasi_snapshot_preview1") imports a compiled C/C++ program runs against, adapted from
// Pocket Run's runner shim (same author, MIT). Console I/O goes to the page; files go to the
// in-memory program folder (cpp-wasi-fs.ts); nothing else exists. Layouts follow wasi-sdk-33's
// include/wasm32-wasip1/wasi/wasip1.h (filestat is 64 bytes with a 64-bit nlink, subscriptions are
// 48 bytes, whence is SET=0, CUR=1, END=2). Any import not listed here returns ENOSYS.
// (Until 0.17.0 this was "wasi_unstable", snapshot 0, for clang 8's wasi-libc: other layouts.)

import { waitForInput } from "./input-channel";
import { E, FILETYPE, ROOT_FD, WasiFs } from "./cpp-wasi-fs";

export class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Thrown out of the program when its output passes the cap. */
export class OutputLimit extends Error {}

export interface WasiOptions {
  /** argv, argv[0] first. */
  args: string[];
  /** Input given up front (the Input box). */
  stdin: Uint8Array;
  /** Live input channel (input-channel.ts); null without cross-origin isolation. */
  input: SharedArrayBuffer | null;
  /** Posts the page's "input-request"; called once the channel is marked waiting. */
  askForInput(): void;
  /** Program output; may throw OutputLimit. */
  write(stream: "stdout" | "stderr", bytes: Uint8Array): void;
  /** Sends buffered output before the program blocks (input, sleep). */
  flush(): void;
  fs: WasiFs;
}

const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME: 2, THREAD_CPUTIME: 3 } as const;
const EVENTTYPE_CLOCK = 0;
const SUBSCRIPTION_CLOCK_ABSTIME = 1;
/** crypto.getRandomValues fills at most 65,536 bytes per call. */
const RANDOM_CHUNK = 65536;
const MAX_SLEEP_MS = 60_000;

export type WasiImports = Record<string, (...args: never[]) => number>;

export interface WasiHost {
  imports: WasiImports;
  bind(memory: WebAssembly.Memory): void;
  /** Time spent blocked on input or asleep (excluded from the program's CPU clock). */
  readonly blockedMs: number;
  readonly inputWaitMs: number;
}

export function createWasi(opts: WasiOptions): WasiHost {
  let memory: WebAssembly.Memory | null = null;
  const view = () => new DataView(memory!.buffer);
  const bytes = () => new Uint8Array(memory!.buffer);
  const enc = new TextEncoder();
  const t0 = performance.now();
  let inputWaitMs = 0;
  let sleptMs = 0;
  let stdin = opts.stdin;
  let stdinPos = 0;
  let inputEnded = !opts.input;
  const fs = opts.fs;
  // A private cell to Atomics.wait on for sleep(): nobody ever notifies it. Without
  // cross-origin isolation there is no SharedArrayBuffer, and sleep() returns at once.
  let sleeper: Int32Array | null = null;
  try {
    sleeper = new Int32Array(new SharedArrayBuffer(4));
  } catch {
    sleeper = null;
  }

  const str = (ptr: number, len: number) => new TextDecoder().decode(bytes().slice(ptr, ptr + len));
  const iovecs = (iovs: number, count: number) => {
    const dv = view();
    const list: { ptr: number; len: number }[] = [];
    for (let i = 0; i < count; i++) list.push({ ptr: dv.getUint32(iovs + i * 8, true), len: dv.getUint32(iovs + i * 8 + 4, true) });
    return list;
  };
  const nowNs = (id: number): bigint | null => {
    const now = performance.now();
    if (id === CLOCK.REALTIME) return BigInt(Math.round((performance.timeOrigin + now) * 1e6));
    if (id === CLOCK.MONOTONIC) return BigInt(Math.round(now * 1e6));
    if (id === CLOCK.PROCESS_CPUTIME || id === CLOCK.THREAD_CPUTIME) return BigInt(Math.round(Math.max(0, now - t0 - inputWaitMs - sleptMs) * 1e6));
    return null;
  };
  const writeArgs = (list: string[], ptrs: number, buf: number) => {
    const dv = view();
    for (const item of list) {
      const b = enc.encode(item + "\0");
      bytes().set(b, buf);
      dv.setUint32(ptrs, buf, true);
      ptrs += 4;
      buf += b.length;
    }
  };
  const sizes = (list: string[], countPtr: number, sizePtr: number) => {
    view().setUint32(countPtr, list.length, true);
    view().setUint32(sizePtr, list.reduce((n, s) => n + enc.encode(s).length + 1, 0), true);
    return E.SUCCESS;
  };
  /** A filestat (preview1: 64 bytes; dev 0, ino 8, filetype 16, nlink 24 as 64 bits, size 32, atim 40, mtim 48, ctim 56). */
  const writeStat = (buf: number, filetype: number, size: number, ino: bigint, mtime: bigint) => {
    const dv = view();
    for (let i = 0; i < 64; i++) dv.setUint8(buf + i, 0);
    dv.setBigUint64(buf + 8, ino, true);
    dv.setUint8(buf + 16, filetype);
    dv.setBigUint64(buf + 24, 1n, true);
    dv.setBigUint64(buf + 32, BigInt(size), true);
    dv.setBigUint64(buf + 40, mtime, true);
    dv.setBigUint64(buf + 48, mtime, true);
    dv.setBigUint64(buf + 56, mtime, true);
  };
  // fd 0-2 are the console until freopen (fd_renumber) puts a file of the program folder there.
  const isConsole = (fd: number) => fd >= 0 && fd <= 2 && !fs.has(fd);

  const readStdin = (iovs: number, count: number, nread: number) => {
    if (stdinPos >= stdin.length && !inputEnded) {
      opts.flush(); // the prompt must be on screen before we wait
      const t = performance.now();
      const line = waitForInput(opts.input!, opts.askForInput);
      inputWaitMs += performance.now() - t;
      if (line) {
        stdin = line;
        stdinPos = 0;
      } else inputEnded = true;
    }
    let total = 0;
    for (const { ptr, len } of iovecs(iovs, count)) {
      const chunk = stdin.subarray(stdinPos, stdinPos + len);
      bytes().set(chunk, ptr);
      stdinPos += chunk.length;
      total += chunk.length;
      if (chunk.length < len) break;
    }
    view().setUint32(nread, total, true);
    return E.SUCCESS;
  };

  const wasi: WasiImports = {
    args_sizes_get: (argc: number, size: number) => sizes(opts.args, argc, size),
    args_get(argv: number, buf: number) {
      writeArgs(opts.args, argv, buf);
      return E.SUCCESS;
    },
    environ_sizes_get: (count: number, size: number) => sizes([], count, size),
    environ_get: () => E.SUCCESS,

    clock_res_get(id: number, out: number) {
      if (nowNs(id) === null) return E.INVAL;
      view().setBigUint64(out, 1000n, true);
      return E.SUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, out: number) {
      const t = nowNs(id);
      if (t === null) return E.INVAL;
      view().setBigUint64(out, t, true);
      return E.SUCCESS;
    },

    fd_prestat_get(fd: number, buf: number) {
      if (fd !== ROOT_FD) return E.BADF;
      view().setUint8(buf, 0); // a directory
      view().setUint32(buf + 4, 1, true); // name "." is one byte
      return E.SUCCESS;
    },
    fd_prestat_dir_name(fd: number, ptr: number, len: number) {
      if (fd !== ROOT_FD) return E.BADF;
      if (len >= 1) bytes()[ptr] = 0x2e;
      return E.SUCCESS;
    },
    fd_fdstat_get(fd: number, buf: number) {
      const dv = view();
      // Consoles: a character device with every right (as in Pocket Run: not a tty, so stdio
      // buffers it; the linked start-up object makes stdout unbuffered for prompts).
      const info = isConsole(fd) ? { filetype: FILETYPE.CHARACTER_DEVICE, append: false, rights: 0xffffffffn } : fs.fdInfo(fd);
      if (!info) return E.BADF;
      dv.setUint8(buf, info.filetype);
      dv.setUint16(buf + 2, info.append ? 1 : 0, true);
      dv.setBigUint64(buf + 8, info.rights, true);
      dv.setBigUint64(buf + 16, info.filetype === FILETYPE.DIRECTORY ? info.rights : 0n, true);
      return E.SUCCESS;
    },
    fd_fdstat_set_flags(fd: number, flags: number) {
      if (isConsole(fd)) return E.SUCCESS;
      return fs.setAppend(fd, (flags & 1) !== 0);
    },
    fd_filestat_get(fd: number, buf: number) {
      if (isConsole(fd)) {
        writeStat(buf, FILETYPE.CHARACTER_DEVICE, 0, BigInt(fd + 100), 0n);
        return E.SUCCESS;
      }
      const s = fs.fdStat(fd);
      if (!s.ok) return s.errno;
      writeStat(buf, s.value.filetype, s.value.size, s.value.ino, s.value.mtime);
      return E.SUCCESS;
    },
    fd_filestat_set_size(fd: number, size: bigint) {
      return isConsole(fd) ? E.INVAL : fs.setSize(fd, Number(size));
    },
    fd_filestat_set_times: () => E.SUCCESS,

    fd_write(fd: number, iovs: number, count: number, nwritten: number) {
      let total = 0;
      for (const { ptr, len } of iovecs(iovs, count)) {
        const chunk = bytes().slice(ptr, ptr + len);
        if ((fd === 1 || fd === 2) && isConsole(fd)) opts.write(fd === 1 ? "stdout" : "stderr", chunk);
        else {
          const r = fs.write(fd, chunk);
          if (!r.ok) {
            if (total) break;
            return r.errno;
          }
        }
        total += len;
      }
      view().setUint32(nwritten, total, true);
      return E.SUCCESS;
    },
    fd_pwrite(fd: number, iovs: number, count: number, offset: bigint, nwritten: number) {
      if (isConsole(fd)) return E.SPIPE;
      let total = 0;
      let at = Number(offset);
      for (const { ptr, len } of iovecs(iovs, count)) {
        const r = fs.write(fd, bytes().slice(ptr, ptr + len), at);
        if (!r.ok) return total ? E.SUCCESS : r.errno;
        total += len;
        at += len;
      }
      view().setUint32(nwritten, total, true);
      return E.SUCCESS;
    },
    fd_read(fd: number, iovs: number, count: number, nread: number) {
      if (fd === 0 && isConsole(fd)) return readStdin(iovs, count, nread);
      if (isConsole(fd)) return E.BADF;
      let total = 0;
      for (const { ptr, len } of iovecs(iovs, count)) {
        const r = fs.read(fd, len);
        if (!r.ok) return r.errno;
        bytes().set(r.value, ptr);
        total += r.value.length;
        if (r.value.length < len) break;
      }
      view().setUint32(nread, total, true);
      return E.SUCCESS;
    },
    fd_pread(fd: number, iovs: number, count: number, offset: bigint, nread: number) {
      if (isConsole(fd)) return E.SPIPE;
      let total = 0;
      let at = Number(offset);
      for (const { ptr, len } of iovecs(iovs, count)) {
        const r = fs.read(fd, len, at);
        if (!r.ok) return r.errno;
        bytes().set(r.value, ptr);
        total += r.value.length;
        at += r.value.length;
        if (r.value.length < len) break;
      }
      view().setUint32(nread, total, true);
      return E.SUCCESS;
    },
    fd_seek(fd: number, offset: bigint, whence: number, out: number) {
      if (isConsole(fd)) return E.SPIPE;
      const r = fs.seek(fd, offset, whence);
      if (!r.ok) return r.errno;
      view().setBigUint64(out, BigInt(r.value), true);
      return E.SUCCESS;
    },
    fd_tell(fd: number, out: number) {
      if (isConsole(fd)) return E.SPIPE;
      const r = fs.tell(fd);
      if (!r.ok) return r.errno;
      view().setBigUint64(out, BigInt(r.value), true);
      return E.SUCCESS;
    },
    fd_close: (fd: number) => (isConsole(fd) ? E.SUCCESS : fs.close(fd)),
    // freopen("input.txt", "r", stdin) opens the file, then renumbers it onto fd 0.
    fd_renumber(from: number, to: number) {
      if (isConsole(from)) return from === to ? E.SUCCESS : E.NOTSUP; // a console can't change number
      if (!isConsole(to) && !fs.has(to)) return E.BADF;
      return fs.renumber(from, to);
    },
    fd_sync: (fd: number) => (isConsole(fd) || fs.has(fd) ? E.SUCCESS : E.BADF),
    fd_datasync: (fd: number) => (isConsole(fd) || fs.has(fd) ? E.SUCCESS : E.BADF),
    fd_advise: (fd: number) => (fs.has(fd) ? E.SUCCESS : E.BADF),
    fd_allocate: (fd: number) => (fs.has(fd) ? E.SUCCESS : E.BADF),
    fd_readdir(fd: number, buf: number, len: number, cookie: bigint, used: number) {
      const r = fs.list(fd);
      if (!r.ok) return r.errno;
      const dv = view();
      let at = 0;
      for (let i = Number(cookie); i < r.value.length && at < len; i++) {
        const e = r.value[i];
        const name = enc.encode(e.name);
        // dirent: d_next u64, d_ino u64, d_namlen u32, d_type u8 (24 bytes), then the name.
        const record = new Uint8Array(24 + name.length);
        const rv = new DataView(record.buffer);
        rv.setBigUint64(0, BigInt(i + 1), true);
        rv.setBigUint64(8, e.ino, true);
        rv.setUint32(16, name.length, true);
        rv.setUint8(20, e.filetype);
        record.set(name, 24);
        const take = Math.min(record.length, len - at);
        bytes().set(record.subarray(0, take), buf + at);
        at += take;
      }
      dv.setUint32(used, at, true);
      return E.SUCCESS;
    },

    path_open(dirfd: number, _dirflags: number, ptr: number, len: number, oflags: number, rightsBase: bigint, _inheriting: bigint, fdflags: number, fdOut: number) {
      const r = fs.open(dirfd, str(ptr, len), oflags, rightsBase, fdflags);
      if (!r.ok) return r.errno;
      view().setUint32(fdOut, r.value, true);
      return E.SUCCESS;
    },
    path_filestat_get(dirfd: number, _flags: number, ptr: number, len: number, buf: number) {
      const s = fs.pathStat(dirfd, str(ptr, len));
      if (!s.ok) return s.errno;
      writeStat(buf, s.value.filetype, s.value.size, s.value.ino, s.value.mtime);
      return E.SUCCESS;
    },
    path_filestat_set_times(dirfd: number, _flags: number, ptr: number, len: number) {
      const s = fs.pathStat(dirfd, str(ptr, len));
      return s.ok ? E.SUCCESS : s.errno;
    },
    path_create_directory: (dirfd: number, ptr: number, len: number) => fs.mkdir(dirfd, str(ptr, len)),
    path_remove_directory: (dirfd: number, ptr: number, len: number) => fs.rmdir(dirfd, str(ptr, len)),
    path_unlink_file: (dirfd: number, ptr: number, len: number) => fs.unlink(dirfd, str(ptr, len)),
    path_rename: (fd: number, p: number, l: number, fd2: number, p2: number, l2: number) => fs.rename(fd, str(p, l), fd2, str(p2, l2)),
    path_symlink: () => E.NOTSUP,
    path_link: () => E.NOTSUP,
    path_readlink: () => E.NOTSUP,

    poll_oneoff(inPtr: number, outPtr: number, count: number, neventsOut: number) {
      // Only clock subscriptions (sleep, nanosleep) are supported; fd readiness reports at once.
      const dv = view();
      let waitMs = Infinity;
      let events = 0;
      for (let i = 0; i < count; i++) {
        // preview1 subscription: 48 bytes; userdata 0, tag 8, then the clock at 16 (id 16, timeout 24, precision 32, flags 40).
        const sub = inPtr + i * 48;
        const type = dv.getUint8(sub + 8);
        if (type === EVENTTYPE_CLOCK) {
          const id = dv.getUint32(sub + 16, true);
          const timeout = dv.getBigUint64(sub + 24, true);
          const flags = dv.getUint16(sub + 40, true);
          const now = nowNs(id) ?? nowNs(CLOCK.MONOTONIC)!;
          const ns = flags & SUBSCRIPTION_CLOCK_ABSTIME ? timeout - now : timeout;
          waitMs = Math.min(waitMs, Math.max(0, Number(ns) / 1e6));
        } else waitMs = 0;
        const ev = outPtr + events * 32;
        for (let k = 0; k < 32; k++) dv.setUint8(ev + k, 0);
        dv.setBigUint64(ev, dv.getBigUint64(sub, true), true);
        dv.setUint8(ev + 10, type);
        events++;
      }
      if (waitMs > 0 && Number.isFinite(waitMs)) {
        opts.flush();
        const ms = Math.min(waitMs, MAX_SLEEP_MS);
        const t = performance.now();
        if (sleeper) Atomics.wait(sleeper, 0, 0, ms);
        sleptMs += performance.now() - t;
      }
      view().setUint32(neventsOut, events, true);
      return E.SUCCESS;
    },

    proc_exit(code: number) {
      throw new Exit(code);
    },
    random_get(buf: number, len: number) {
      for (let at = 0; at < len; at += RANDOM_CHUNK) crypto.getRandomValues(new Uint8Array(memory!.buffer, buf + at, Math.min(RANDOM_CHUNK, len - at)));
      return E.SUCCESS;
    },
    sched_yield: () => E.SUCCESS,
  };

  return {
    imports: wasi,
    bind(m) {
      memory = m;
    },
    get blockedMs() {
      return inputWaitMs + sleptMs;
    },
    get inputWaitMs() {
      return inputWaitMs;
    },
  };
}

/**
 * Binds every function a module imports: the host's own WASI functions under "wasi_unstable",
 * anything else to ENOSYS. Import names come from the program (a declaration can name any module
 * and field), so the tables have no prototype: "__proto__" / "then" would otherwise have set
 * Object.prototype.then in the worker, and instantiate() then never resolved.
 */
export function importObject(module: WebAssembly.Module, host: WasiHost): WebAssembly.Imports {
  const imports: Record<string, Record<string, (...args: never[]) => number>> = Object.create(null);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== "function") continue;
    const table = (imports[imp.module] ??= Object.create(null));
    const own = imp.module === "wasi_snapshot_preview1" && Object.prototype.hasOwnProperty.call(host.imports, imp.name);
    table[imp.name] = own ? host.imports[imp.name] : () => E.NOSYS;
  }
  return imports;
}

/** Turns a WebAssembly trap into words a student can act on (wording differs per engine). */
export function describeCrash(e: unknown, stderr = ""): string {
  // 0.17.0 (C++ exceptions): with WebAssembly's exception instructions a throw that no catch matches
  // leaves the program as a WebAssembly.Exception (std::terminate isn't reached; measured in Chromium
  // and Node with wasi-sdk-33's libc++abi). Say so rather than "aborted".
  if (typeof WebAssembly !== "undefined" && typeof WebAssembly.Exception === "function" && e instanceof WebAssembly.Exception) return "uncaught exception";
  const message = e instanceof Error ? e.message : String(e);
  // A libc++abi that does reach std::terminate names the exception on stderr first, then aborts. The
  // type ends at the first ": " (a type has "::" but never a colon and a space), then what() follows.
  const uncaught = /^libc\+\+abi: terminating due to uncaught exception of type (.+)$/m.exec(stderr.trimEnd());
  if (uncaught && /unreachable/i.test(message)) {
    const [type, ...what] = uncaught[1].split(": ");
    return `uncaught exception: ${type.trim()}${what.length ? `: ${what.join(": ").trim()}` : ""}`;
  }
  // Chrome / Firefox / Safari: "Maximum call stack size exceeded" / "too much recursion",
  // "memory access out of bounds" / "Out of bounds memory access", "divide by zero" / "Division by zero".
  if (/call stack|too much recursion|stack overflow/i.test(message)) return "stack overflow (infinite or very deep recursion?)";
  if (/out of bounds/i.test(message)) return "invalid memory access (like a segmentation fault: a bad pointer or array index)";
  if (/unreachable/i.test(message)) return "aborted (abort() was called, an assert failed, or a function is defined with other parameter types than it was declared with)";
  if (/divi(de|sion) by zero|remainder by zero/i.test(message)) return "integer division by zero";
  if (/integer overflow|unrepresentable/i.test(message)) return "integer overflow in division (INT_MIN / -1)";
  if (/signature mismatch|indirect call|null function|table index|call_indirect/i.test(message)) return "a call through a bad function pointer";
  if (/out of memory|could not allocate/i.test(message)) return `out of memory (${message})`;
  return message;
}
