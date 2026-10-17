// The file system a C/C++ program sees: its program folder, held in memory, readable and writable.
// The WASI host (cpp-wasi.ts) preopens it as "." on fd 3, which is how this sysroot's wasi-libc
// (2019, wasi_unstable) resolves relative paths: fopen("input.txt") arrives here as path_open(3,
// "input.txt"), "./x" as "x"; absolute paths fail inside libc (no "/" preopen). Paths can't leave
// the folder ("../x" is refused), there are no symlinks, and the total size of what the program
// writes is capped. After the run, changes() lists the files it created or changed. Pure.

export const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, BUSY: 10, EXIST: 20, FBIG: 22, INVAL: 28, ISDIR: 31, MFILE: 33,
  NAMETOOLONG: 37, NOENT: 44, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, SPIPE: 70,
  NOTCAPABLE: 76,
} as const;

export const FILETYPE = { CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 } as const;
/** wasi_unstable (snapshot 0) order: CUR, END, SET. (preview1 later changed it to SET, CUR, END.) */
export const WHENCE = { CUR: 0, END: 1, SET: 2 } as const;
export const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
export const FDFLAGS = { APPEND: 1 } as const;
export const RIGHTS = { FD_READ: 0x2n, FD_WRITE: 0x40n, ALL: 0x1fffffffn } as const;

/** The preopened directory: fd 3, named "." so relative paths resolve against it. */
export const ROOT_FD = 3;

export interface FsLimits {
  /** Bytes the program may add on top of the files it started with. */
  growBytes: number;
  maxEntries: number;
  maxOpen: number;
}
export const DEFAULT_FS_LIMITS: FsLimits = { growBytes: 32 * 1024 * 1024, maxEntries: 2000, maxOpen: 64 };

interface FileNode { data: Uint8Array; size: number; mtime: bigint; ino: bigint }
type Fd =
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string; pos: number; read: boolean; write: boolean; append: boolean };

export interface Stat { filetype: number; size: number; ino: bigint; mtime: bigint }
export interface DirEntry { name: string; filetype: number; ino: bigint }

type Result<T> = { ok: true; value: T } | { ok: false; errno: number };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (errno: number): Result<never> => ({ ok: false, errno });

export class WasiFs {
  private readonly files = new Map<string, FileNode>();
  private readonly dirs = new Map<string, bigint>([["", 1n]]);
  private readonly original = new Map<string, Uint8Array>();
  private readonly fds = new Map<number, Fd>([[ROOT_FD, { kind: "dir", path: "" }]]);
  private nextIno = 2n;
  private used = 0;
  private readonly budget: number;

  /** `files`: paths relative to the program folder, already normalised ("data/in.txt"). */
  constructor(files: readonly { path: string; bytes: Uint8Array }[], private readonly limits: FsLimits = DEFAULT_FS_LIMITS, private readonly clock: () => bigint = () => 0n) {
    let start = 0;
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) this.ensureDir(parts.slice(0, i).join("/"));
      this.files.set(f.path, { data: f.bytes.slice(), size: f.bytes.length, mtime: 0n, ino: this.nextIno++ });
      this.original.set(f.path, f.bytes);
      start += f.bytes.length;
    }
    this.used = start;
    this.budget = start + limits.growBytes;
  }

  private ensureDir(path: string) {
    if (!this.dirs.has(path)) this.dirs.set(path, this.nextIno++);
  }

  private entryCount(): number {
    return this.files.size + this.dirs.size;
  }

  /** Resolves `rel` against directory `base`; refuses anything that would leave the root. */
  resolve(base: string, rel: string): Result<string> {
    if (rel.includes("\0")) return fail(E.INVAL);
    if (rel.startsWith("/")) return fail(E.NOTCAPABLE);
    if (rel.length > 4096) return fail(E.NAMETOOLONG);
    const parts = base === "" ? [] : base.split("/");
    for (const part of rel.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return fail(E.NOTCAPABLE);
        parts.pop();
      } else {
        if (new TextEncoder().encode(part).length > 255) return fail(E.NAMETOOLONG);
        parts.push(part);
      }
    }
    return ok(parts.join("/"));
  }

  private dirOf(fd: number): Result<string> {
    const entry = this.fds.get(fd);
    if (!entry) return fail(E.BADF);
    if (entry.kind !== "dir") return fail(E.NOTDIR);
    return ok(entry.path);
  }

  private parentExists(path: string): boolean {
    const i = path.lastIndexOf("/");
    return this.dirs.has(i < 0 ? "" : path.slice(0, i));
  }

  /** Resolves a path given to a path_* call: directory fd + relative path. */
  lookup(dirFd: number, rel: string): Result<string> {
    const base = this.dirOf(dirFd);
    if (!base.ok) return base;
    return this.resolve(base.value, rel);
  }

  open(dirFd: number, rel: string, oflags: number, rights: bigint, fdflags: number): Result<number> {
    const target = this.lookup(dirFd, rel);
    if (!target.ok) return target;
    const path = target.value;
    if ([...this.fds.keys()].length - 1 >= this.limits.maxOpen) return fail(E.MFILE);
    const read = (rights & RIGHTS.FD_READ) !== 0n;
    const write = (rights & RIGHTS.FD_WRITE) !== 0n;
    if (this.dirs.has(path)) {
      if (oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return fail(E.EXIST);
      // opendir() asks with O_DIRECTORY; writing to a folder as if it were a file is refused.
      if (!(oflags & OFLAGS.DIRECTORY) && (write || oflags & OFLAGS.TRUNC)) return fail(E.ISDIR);
      return ok(this.addFd({ kind: "dir", path }));
    }
    if (oflags & OFLAGS.DIRECTORY) return fail(this.files.has(path) ? E.NOTDIR : E.NOENT);
    let node = this.files.get(path);
    if (node) {
      if (oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return fail(E.EXIST);
    } else {
      if (!(oflags & OFLAGS.CREAT)) return fail(E.NOENT);
      if (path === "" || !this.parentExists(path)) return fail(E.NOENT);
      if (this.entryCount() >= this.limits.maxEntries) return fail(E.NOSPC);
      node = { data: new Uint8Array(0), size: 0, mtime: this.clock(), ino: this.nextIno++ };
      this.files.set(path, node);
    }
    if (oflags & OFLAGS.TRUNC) {
      if (!write) return fail(E.ACCES);
      this.used -= node.size;
      node.size = 0;
      node.mtime = this.clock();
    }
    return ok(this.addFd({ kind: "file", path, pos: 0, read, write, append: (fdflags & FDFLAGS.APPEND) !== 0 }));
  }

  private addFd(entry: Fd): number {
    let fd = ROOT_FD + 1;
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, entry);
    return fd;
  }

  has(fd: number): boolean {
    return this.fds.has(fd);
  }

  /**
   * fd_renumber (how wasi-libc's freopen works): the open file `from` takes the number `to`,
   * replacing what was there (a console fd 0-2 the host owns, or another open file); `from` is gone.
   */
  renumber(from: number, to: number): number {
    const entry = this.fds.get(from);
    if (!entry || to < 0) return E.BADF;
    if (from === ROOT_FD || to === ROOT_FD) return E.NOTSUP; // the preopen stays where libc found it
    if (from === to) return E.SUCCESS;
    this.fds.delete(from);
    this.fds.set(to, entry);
    return E.SUCCESS;
  }

  close(fd: number): number {
    if (fd === ROOT_FD) return E.SUCCESS; // the preopen stays usable
    return this.fds.delete(fd) ? E.SUCCESS : E.BADF;
  }

  private file(fd: number): Result<{ fd: Extract<Fd, { kind: "file" }>; node: FileNode }> {
    const entry = this.fds.get(fd);
    if (!entry) return fail(E.BADF);
    if (entry.kind !== "file") return fail(E.ISDIR);
    const node = this.files.get(entry.path);
    if (!node) return fail(E.BADF); // unlinked while open: treat as gone
    return ok({ fd: entry, node });
  }

  /** Reads up to `length` bytes at the file position (or at `at` for pread). */
  read(fd: number, length: number, at?: number): Result<Uint8Array> {
    const f = this.file(fd);
    if (!f.ok) return f;
    if (!f.value.fd.read) return fail(E.BADF);
    const { node } = f.value;
    const start = at ?? f.value.fd.pos;
    const end = Math.min(node.size, start + length);
    const chunk = start >= end ? new Uint8Array(0) : node.data.slice(start, end);
    if (at === undefined) f.value.fd.pos = start + chunk.length;
    return ok(chunk);
  }

  /** Writes at the file position (the end for append mode, or `at` for pwrite). */
  write(fd: number, bytes: Uint8Array, at?: number): Result<number> {
    const f = this.file(fd);
    if (!f.ok) return f;
    const { fd: entry, node } = f.value;
    if (!entry.write) return fail(E.BADF);
    const start = at ?? (entry.append ? node.size : entry.pos);
    const end = start + bytes.length;
    const grow = Math.max(0, end - node.size);
    if (this.used + grow > this.budget) return fail(E.NOSPC);
    this.reserve(node, end);
    // A hole reads as zeros: after O_TRUNC or a shrinking ftruncate the buffer still holds old bytes.
    if (start > node.size) node.data.fill(0, node.size, start);
    node.data.set(bytes, start);
    if (end > node.size) {
      this.used += end - node.size;
      node.size = end;
    }
    node.mtime = this.clock();
    if (at === undefined) entry.pos = end;
    return ok(bytes.length);
  }

  private reserve(node: FileNode, size: number) {
    if (size <= node.data.length) {
      return;
    }
    const grown = new Uint8Array(Math.max(size, Math.min(node.data.length * 2, size + 1024 * 1024), 256));
    grown.set(node.data.subarray(0, node.size));
    node.data = grown;
  }

  /** Changes the file size (ftruncate); new bytes read as zero. */
  setSize(fd: number, size: number): number {
    const f = this.file(fd);
    if (!f.ok) return f.errno;
    if (!f.value.fd.write) return E.BADF;
    const { node } = f.value;
    if (size < 0) return E.INVAL;
    if (size > node.size) {
      if (this.used + (size - node.size) > this.budget) return E.FBIG;
      this.reserve(node, size);
      node.data.fill(0, node.size, size);
    }
    this.used += size - node.size;
    node.size = size;
    node.mtime = this.clock();
    return E.SUCCESS;
  }

  seek(fd: number, offset: bigint, whence: number): Result<number> {
    const f = this.file(fd);
    if (!f.ok) return f.errno === E.ISDIR ? fail(E.SPIPE) : f;
    const { fd: entry, node } = f.value;
    const base = whence === WHENCE.SET ? 0n : whence === WHENCE.CUR ? BigInt(entry.pos) : whence === WHENCE.END ? BigInt(node.size) : -1n;
    if (base < 0n) return fail(E.INVAL);
    const next = base + offset;
    if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) return fail(E.INVAL);
    entry.pos = Number(next);
    return ok(entry.pos);
  }

  tell(fd: number): Result<number> {
    const f = this.file(fd);
    return f.ok ? ok(f.value.fd.pos) : f;
  }

  /** fdstat of an fd this file system owns. */
  fdInfo(fd: number): { filetype: number; append: boolean; rights: bigint } | null {
    const entry = this.fds.get(fd);
    if (!entry) return null;
    if (entry.kind === "dir") return { filetype: FILETYPE.DIRECTORY, append: false, rights: RIGHTS.ALL };
    const rights = (entry.read ? RIGHTS.FD_READ : 0n) | (entry.write ? RIGHTS.FD_WRITE : 0n) | (RIGHTS.ALL & ~(RIGHTS.FD_READ | RIGHTS.FD_WRITE));
    return { filetype: FILETYPE.REGULAR_FILE, append: entry.append, rights };
  }

  setAppend(fd: number, append: boolean): number {
    const entry = this.fds.get(fd);
    if (!entry) return E.BADF;
    if (entry.kind === "file") entry.append = append;
    return E.SUCCESS;
  }

  private statOf(path: string): Result<Stat> {
    const node = this.files.get(path);
    if (node) return ok({ filetype: FILETYPE.REGULAR_FILE, size: node.size, ino: node.ino, mtime: node.mtime });
    const ino = this.dirs.get(path);
    if (ino !== undefined) return ok({ filetype: FILETYPE.DIRECTORY, size: 0, ino, mtime: 0n });
    return fail(E.NOENT);
  }

  fdStat(fd: number): Result<Stat> {
    const entry = this.fds.get(fd);
    if (!entry) return fail(E.BADF);
    return this.statOf(entry.path);
  }

  pathStat(dirFd: number, rel: string): Result<Stat> {
    const target = this.lookup(dirFd, rel);
    return target.ok ? this.statOf(target.value) : target;
  }

  mkdir(dirFd: number, rel: string): number {
    const target = this.lookup(dirFd, rel);
    if (!target.ok) return target.errno;
    const path = target.value;
    if (this.dirs.has(path) || this.files.has(path)) return E.EXIST;
    if (!this.parentExists(path)) return E.NOENT;
    if (this.entryCount() >= this.limits.maxEntries) return E.NOSPC;
    this.ensureDir(path);
    return E.SUCCESS;
  }

  unlink(dirFd: number, rel: string): number {
    const target = this.lookup(dirFd, rel);
    if (!target.ok) return target.errno;
    if (this.dirs.has(target.value)) return E.ISDIR;
    const node = this.files.get(target.value);
    if (!node) return E.NOENT;
    this.used -= node.size;
    this.files.delete(target.value);
    return E.SUCCESS;
  }

  rmdir(dirFd: number, rel: string): number {
    const target = this.lookup(dirFd, rel);
    if (!target.ok) return target.errno;
    const path = target.value;
    if (path === "") return E.BUSY;
    if (this.files.has(path)) return E.NOTDIR;
    if (!this.dirs.has(path)) return E.NOENT;
    if (this.children(path).length) return E.NOTEMPTY;
    this.dirs.delete(path);
    return E.SUCCESS;
  }

  rename(fromFd: number, fromRel: string, toFd: number, toRel: string): number {
    const from = this.lookup(fromFd, fromRel);
    if (!from.ok) return from.errno;
    const to = this.lookup(toFd, toRel);
    if (!to.ok) return to.errno;
    if (this.dirs.has(from.value)) return E.NOTSUP; // folders can't be renamed (rarely needed)
    const node = this.files.get(from.value);
    if (!node) return E.NOENT;
    if (from.value === to.value) return E.SUCCESS;
    if (this.dirs.has(to.value)) return E.ISDIR;
    if (!this.parentExists(to.value)) return E.NOENT;
    const replaced = this.files.get(to.value);
    if (replaced) this.used -= replaced.size;
    this.files.delete(from.value);
    this.files.set(to.value, node);
    return E.SUCCESS;
  }

  private children(dir: string): DirEntry[] {
    const prefix = dir === "" ? "" : dir + "/";
    const direct = (p: string) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes("/");
    const out: DirEntry[] = [];
    for (const [p, ino] of this.dirs) if (direct(p)) out.push({ name: p.slice(prefix.length), filetype: FILETYPE.DIRECTORY, ino });
    for (const [p, node] of this.files) if (direct(p)) out.push({ name: p.slice(prefix.length), filetype: FILETYPE.REGULAR_FILE, ino: node.ino });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** ".", ".." and the directory's entries, for fd_readdir (the cookie is an index here). */
  list(fd: number): Result<DirEntry[]> {
    const entry = this.fds.get(fd);
    if (!entry) return fail(E.BADF);
    if (entry.kind !== "dir") return fail(E.NOTDIR);
    const self = this.dirs.get(entry.path) ?? 1n;
    return ok([{ name: ".", filetype: FILETYPE.DIRECTORY, ino: self }, { name: "..", filetype: FILETYPE.DIRECTORY, ino: 1n }, ...this.children(entry.path)]);
  }

  /** Files the program created or whose bytes changed, sorted by path. */
  changes(): { path: string; bytes: Uint8Array }[] {
    const out: { path: string; bytes: Uint8Array }[] = [];
    for (const [path, node] of this.files) {
      const before = this.original.get(path);
      const now = node.data.subarray(0, node.size);
      if (before && before.length === now.length && before.every((b, i) => b === now[i])) continue;
      out.push({ path, bytes: now.slice() });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
