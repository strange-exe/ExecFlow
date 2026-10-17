import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../core/safety";
import { checkWritten, collectWritten, MAX_RUN_FILES, MAX_WRITTEN_FILES, prepareRunFiles, removeTree, writeWorkspace, type FsLike } from "./python-files";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** A tiny file system with Emscripten's semantics for what FsLike uses, including symlinks. */
class FakeFs implements FsLike {
  static DIR = 0o040000;
  static FILE = 0o100000;
  static LINK = 0o120000;
  nodes = new Map<string, { mode: number; data?: Uint8Array; target?: string }>([["/", { mode: FakeFs.DIR }]]);

  private parent(path: string) {
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }
  /** Follows links in the parent folders, like a real path walk. */
  private resolveParent(path: string): string {
    const parent = this.parent(path);
    const node = this.nodes.get(parent);
    if (node?.mode === FakeFs.LINK) return `${node.target}/${path.slice(parent.length + 1)}`;
    return path;
  }
  private need(path: string) {
    const node = this.nodes.get(this.resolveParent(path));
    if (!node) throw Object.assign(new Error(`ENOENT ${path}`), { errno: 44 });
    return node;
  }
  lstat(path: string) {
    const n = this.need(path);
    return { mode: n.mode, size: n.data?.length ?? 0 };
  }
  isDir = (mode: number) => mode === FakeFs.DIR;
  isFile = (mode: number) => mode === FakeFs.FILE;
  readdir(path: string) {
    const dir = path === "/" ? "" : path;
    if (this.need(path).mode !== FakeFs.DIR) throw new Error("ENOTDIR");
    const names = [...this.nodes.keys()].filter((p) => p !== path && this.parent(p) === (dir || "/")).map((p) => p.slice(dir.length + 1));
    return [".", "..", ...names];
  }
  unlink(path: string) {
    if (this.need(path).mode === FakeFs.DIR) throw new Error("EISDIR");
    this.nodes.delete(path);
  }
  rmdir(path: string) {
    if (this.readdir(path).length > 2) throw new Error("ENOTEMPTY");
    this.nodes.delete(path);
  }
  mkdirTree(path: string) {
    let d = "";
    for (const part of path.split("/").filter(Boolean)) {
      d += `/${part}`;
      if (!this.nodes.has(d)) this.nodes.set(d, { mode: FakeFs.DIR });
    }
  }
  writeFile(path: string, data: Uint8Array) {
    this.nodes.set(path, { mode: FakeFs.FILE, data: data.slice() });
  }
  readFile(path: string) {
    const n = this.need(path);
    if (n.mode !== FakeFs.FILE) throw new Error("EISDIR");
    return n.data!.slice();
  }
  symlink(target: string, path: string) {
    this.nodes.set(path, { mode: FakeFs.LINK, target });
  }
  text(path: string) {
    return new TextDecoder().decode(this.readFile(path));
  }
}

describe("prepareRunFiles", () => {
  const files = [{ path: "main.py", text: "print(1)\n" }, { path: "data/in.txt", text: "x\n" }];
  it("passes a normal workspace through", () => {
    expect(prepareRunFiles(files, "main.py")).toEqual({ ok: true, files });
  });
  it("leaves conflict copies out", () => {
    const r = prepareRunFiles([...files, { path: "main.conflict-20261017-090503.py", text: "" }], "main.py");
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["main.py", "data/in.txt"]);
    expect(prepareRunFiles(files, "main.conflict-20261017-090503.py").ok).toBe(false);
  });
  it("refuses bad paths, duplicates, a missing or non-Python entry, and oversized input", () => {
    expect(prepareRunFiles([...files, { path: "../evil.py", text: "" }], "main.py").ok).toBe(false);
    expect(prepareRunFiles([...files, { path: "/abs.py", text: "" }], "main.py").ok).toBe(false);
    expect(prepareRunFiles([...files, { path: "a\\b.py", text: "" }], "main.py").ok).toBe(false);
    expect(prepareRunFiles([...files, files[0]], "main.py").ok).toBe(false);
    expect(prepareRunFiles(files, "other.py").ok).toBe(false);
    expect(prepareRunFiles(files, "data/in.txt").ok).toBe(false);
    expect(prepareRunFiles([{ path: "main.py", text: "x".repeat(MAX_FILE_BYTES + 1) }], "main.py").ok).toBe(false);
    const many = Array.from({ length: MAX_RUN_FILES + 1 }, (_, i) => ({ path: i ? `f${i}.txt` : "main.py", text: "" }));
    expect(prepareRunFiles(many, "main.py")).toMatchObject({ ok: false, reason: expect.stringContaining("2000") });
    expect(prepareRunFiles([{ path: "main.py", text: 1 as unknown as string }], "main.py").ok).toBe(false);
  });
});

describe("removeTree and writeWorkspace", () => {
  it("never follows a link a program made (to / here), so nothing outside is deleted", () => {
    const fs = new FakeFs();
    fs.mkdirTree("/lib/python3.14");
    fs.writeFile("/lib/python3.14/os.py", new Uint8Array([1]));
    fs.mkdirTree("/workspace/pkg");
    fs.writeFile("/workspace/pkg/a.py", new Uint8Array([1]));
    fs.symlink("/", "/workspace/root-link");
    fs.symlink("/lib", "/workspace/pkg/lib-link");
    removeTree(fs, "/workspace");
    expect(fs.nodes.has("/workspace")).toBe(false);
    expect(fs.nodes.has("/lib/python3.14/os.py")).toBe(true);
  });

  it("replaces the workspace with exactly the files sent, as UTF-8", () => {
    const fs = new FakeFs();
    fs.mkdirTree("/workspace/old");
    fs.writeFile("/workspace/old/out.txt", new Uint8Array([1]));
    const sent = writeWorkspace(fs, [{ path: "main.py", text: `print("${cp(0x1f600)}")\n` }, { path: "a/b/c.txt", text: "deep" }]);
    expect(fs.nodes.has("/workspace/old/out.txt")).toBe(false);
    expect(fs.text("/workspace/main.py")).toBe(`print("${cp(0x1f600)}")\n`);
    expect(fs.text("/workspace/a/b/c.txt")).toBe("deep");
    expect([...sent.keys()]).toEqual(["main.py", "a/b/c.txt"]);
    expect(sent.get("main.py")!.length).toBe(14); // 'print("' + 4 bytes for the emoji + '")\n'
  });
});

describe("collectWritten", () => {
  const setUp = () => {
    const fs = new FakeFs();
    const sent = writeWorkspace(fs, [{ path: "main.py", text: "print(1)\n" }, { path: "data.txt", text: "abc" }, { path: "keep.txt", text: "same" }]);
    return { fs, sent, put: (path: string, text: string | Uint8Array) => {
      fs.mkdirTree(`/workspace/${path}`.slice(0, `/workspace/${path}`.lastIndexOf("/")));
      fs.writeFile(`/workspace/${path}`, typeof text === "string" ? new TextEncoder().encode(text) : text);
    } };
  };

  it("reports created and changed text files, sorted, and not unchanged ones", () => {
    const { fs, sent, put } = setUp();
    put("out/result.txt", "42\n");
    put("data.txt", "xyz"); // same size, different bytes
    put("keep.txt", "same"); // rewritten with the same bytes
    expect(collectWritten(fs, sent)).toEqual({ written: [{ path: "data.txt", text: "xyz" }, { path: "out/result.txt", text: "42\n" }], skipped: 0 });
  });

  it("restores LF text from CRLF files and skips binary, invalid, oversized and badly named files", () => {
    const { fs, sent, put } = setUp();
    put("crlf.txt", "a\r\nb\r\n");
    put("image.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    put("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    put("big.txt", "x".repeat(MAX_FILE_BYTES + 1));
    put("what?.txt", "windows can't store this name");
    put("trojan.txt", `ok ${cp(0x202e)} hidden`);
    expect(collectWritten(fs, sent)).toEqual({ written: [{ path: "crlf.txt", text: "a\nb\n" }], skipped: 5 });
  });

  it("caps the number of files and ignores links and __pycache__", () => {
    const { fs, sent, put } = setUp();
    for (let i = 0; i < MAX_WRITTEN_FILES + 5; i++) put(`many/f${String(i).padStart(2, "0")}.txt`, `${i}`);
    put("__pycache__/m.cpython-314.pyc", "x");
    fs.symlink("/etc/passwd", "/workspace/link.txt");
    const r = collectWritten(fs, sent);
    expect(r.written).toHaveLength(MAX_WRITTEN_FILES);
    expect(r.skipped).toBe(5);
    expect(r.written.some((f) => f.path.includes("__pycache__") || f.path === "link.txt")).toBe(false);
  });
});

describe("checkWritten (worker messages are untrusted)", () => {
  it("keeps valid files and drops forged ones", () => {
    const out = checkWritten([
      { path: "out.txt", text: "ok\n" },
      { path: "../escape.txt", text: "x" },
      { path: "out.txt", text: "duplicate" },
      { path: "bad.txt", text: `a${cp(0x202e)}b` },
      { path: "ctl.txt", text: `a${String.fromCharCode(0)}b` },
      { path: "huge.txt", text: "x".repeat(MAX_FILE_BYTES + 1) },
      { path: 5, text: "x" },
      null,
    ]);
    expect(out).toEqual([{ path: "out.txt", text: "ok\n" }]);
    expect(checkWritten("nope")).toEqual([]);
    expect(checkWritten(Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.txt`, text: "" })))).toHaveLength(MAX_WRITTEN_FILES);
  });
});
