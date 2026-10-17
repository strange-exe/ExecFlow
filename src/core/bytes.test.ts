import { describe, expect, it } from "vitest";
import { decodeFileBytes, encodeFileBytes, gitBlobSha, textBlobSha } from "./bytes";

const utf8 = (s: string) => new TextEncoder().encode(s);
const withBom = (b: Uint8Array) => new Uint8Array([0xef, 0xbb, 0xbf, ...b]);

describe("git blob ids", () => {
  it("match git hash-object", async () => {
    expect(await gitBlobSha(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(await gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("hash the restored bytes, not the LF text", async () => {
    expect(await textBlobSha("hello\n", "\r\n")).toBe(await gitBlobSha(utf8("hello\r\n")));
    expect(await textBlobSha("hello\n", "\n", true)).toBe(await gitBlobSha(withBom(utf8("hello\n"))));
  });
});

describe("decoding and encoding round-trip byte for byte", () => {
  it.each([
    ["LF", utf8("a = 1\nb = 2\n"), "\n", false],
    ["CRLF", utf8("a = 1\r\nb = 2\r\n"), "\r\n", false],
    ["CR", utf8("a = 1\rb = 2\r"), "\r", false],
    ["CRLF with BOM", withBom(utf8("int x;\r\n")), "\r\n", true],
    ["no line break", utf8("x"), "\n", false],
    ["empty", new Uint8Array(), "\n", false],
  ] as const)("%s", (_, bytes, eol, bom) => {
    const d = decodeFileBytes(bytes);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.eol).toBe(eol);
    expect(d.bom).toBe(bom);
    expect(d.text.includes(String.fromCharCode(13))).toBe(false);
    expect(encodeFileBytes(d.text, d.eol, d.bom)).toEqual(bytes);
  });

  it("keeps non-ASCII text intact", () => {
    const text = "print('" + String.fromCodePoint(0x928, 0x92e, 0x938, 0x94d, 0x924, 0x947) + " " + String.fromCodePoint(0x1f600) + "')\n";
    const d = decodeFileBytes(utf8(text));
    expect(d).toEqual({ ok: true, text, eol: "\n", bom: false });
  });

  it("refuses invalid UTF-8 and mixed line endings", () => {
    expect(decodeFileBytes(new Uint8Array([0x61, 0xff, 0x0a])).ok).toBe(false);
    expect(decodeFileBytes(utf8("a\r\nb\n")).ok).toBe(false);
    expect(decodeFileBytes(utf8("a\rb\r\n")).ok).toBe(false);
  });

  it("keeps a second BOM character in the text instead of dropping it", () => {
    const d = decodeFileBytes(withBom(withBom(utf8("x"))));
    expect(d.ok && d.bom && d.text).toBe(String.fromCharCode(0xfeff) + "x");
  });
});
