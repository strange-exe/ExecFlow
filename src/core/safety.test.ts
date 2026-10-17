import { describe, expect, it } from "vitest";
import { binaryKind, checkBytes, checkText, cleanFilename, removeHidden } from "./safety";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const bytes = (...b: number[]) => new Uint8Array(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("binary files renamed to .py/.c/.cpp are rejected", () => {
  it.each([
    ["Windows exe", [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00], /Windows program/],
    ["ZIP with NUL bytes", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], /ZIP archive/],
    ["ELF", [0x7f, 0x45, 0x4c, 0x46, 0x02], /Linux program/],
    ["ZIP / APK", [0x50, 0x4b, 0x03, 0x04, 0x14], /ZIP archive/],
    ["PDF", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00], /PDF/],
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], /PNG/],
    ["wasm", [0x00, 0x61, 0x73, 0x6d, 0x01], /WebAssembly/],
  ])("%s", (_, sig, kind) => {
    const r = checkBytes(bytes(...sig, 0x41, 0x42));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(kind);
  });

  it("does not mistake source that starts with similar letters for a binary", () => {
    expect(binaryKind(utf8("MZ = 3\nprint(MZ)\n"))).toBeNull(); // "MZ" without NUL bytes is just text
    expect(checkBytes(utf8("MZ = 3\nprint(MZ)\n")).ok).toBe(true);
    expect(checkBytes(utf8("GIF89 = 1\n")).ok).toBe(true);
  });

  it("rejects invalid UTF-8 and control characters", () => {
    expect(checkBytes(bytes(0x70, 0x72, 0xff, 0xfe, 0x0a)).ok).toBe(false);
    expect(checkBytes(utf8("print(1)" + cp(0x1b) + "[2J")).ok).toBe(false);
  });

  it("accepts ordinary source in any script, strips a BOM and records the line endings", () => {
    const r = checkBytes(utf8(cp(0xfeff) + "print('नमस्ते ✓ 你好')\r\nx = 1\r\n"));
    expect(r).toEqual({ ok: true, text: "print('नमस्ते ✓ 你好')\nx = 1\n", hidden: 0, eol: "\r\n", bom: true });
  });

  it("refuses mixed line endings, which could not be saved back byte for byte", () => {
    expect(checkBytes(utf8("a = 1\r\nb = 2\n")).ok).toBe(false);
    expect(checkBytes(utf8("a = 1\rb = 2\n")).ok).toBe(false);
  });

  it("refuses NUL bytes in otherwise valid UTF-8", () => {
    expect(checkBytes(bytes(0x61, 0x00, 0x62)).ok).toBe(false);
  });
});

describe("text that hides what code does", () => {
  it("blocks Trojan Source direction controls", () => {
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(checkText(`access = "user${cp(c)}"`).ok, c.toString(16)).toBe(false);
    }
  });

  it("counts invisible characters, and removeHidden strips them", () => {
    const text = `is${cp(0x200b)}_admin = True${cp(0x2060)}`;
    expect(checkText(text)).toMatchObject({ ok: true, hidden: 2 });
    expect(removeHidden(text)).toBe("is_admin = True");
  });

  it("leaves the zero-width joiners that Indic scripts need", () => {
    const hindi = `print("क्${cp(0x200d)}ष")`;
    expect(checkText(hindi)).toMatchObject({ ok: true, hidden: 0 });
  });
});

describe("file names", () => {
  it("removes direction tricks so the real extension shows", () => {
    expect(cleanFilename(`main${cp(0x202e)}yp.exe`)).toBe("mainyp.exe");
  });
  it("removes path parts, control and invisible characters", () => {
    expect(cleanFilename("../../etc/passwd.py")).toBe(".._.._etc_passwd.py");
    expect(cleanFilename(`ma${cp(0x200b)}in.py`)).toBe("main.py");
  });
  it("avoids reserved Windows names and trailing dots", () => {
    expect(cleanFilename("con.py")).toBe("_con.py");
    expect(cleanFilename("main.py. . ")).toBe("main.py");
    expect(cleanFilename("   ")).toBe("untitled");
  });
  it("caps very long names", () => {
    expect(cleanFilename("a".repeat(500) + ".py").length).toBe(100);
  });
});
