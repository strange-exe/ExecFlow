/// <reference types="node" />
// Code links (code-link.ts): a link made here opens to the same file, and a hostile link (cut off,
// a deflate bomb, the wrong shape, a bad name, Trojan Source text) is refused with its reason.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { MAX_INFLATED_BYTES, MAX_LINK_CHARS, MAX_LINK_FILES, isCodeLink, makeCodeLink, makeFolderLink, readCodeLink, readPacked, readRefusalText } from "./code-link";

const ORIGIN = "https://execflow.abhinesh.codes";
const hashOf = (url: string) => url.slice(url.indexOf("#"));
/** A version-1 fragment around any bytes (deflated here), bypassing makeCodeLink's checks. */
const forge = (raw: Buffer | string) => `#code=1.${deflateRawSync(raw).toString("base64url")}`;
const forgeJson = (value: unknown) => forge(JSON.stringify(value));

async function roundTrip(name: string, text: string) {
  const made = await makeCodeLink(ORIGIN, name, text);
  if (!made.ok) throw new Error(`not made: ${made.refusal.kind}`);
  expect(made.url.startsWith(`${ORIGIN}/#code=1.`)).toBe(true);
  expect(made.url.length).toBeLessThanOrEqual(MAX_LINK_CHARS);
  return readCodeLink(hashOf(made.url));
}

describe("making and reading a code link", () => {
  it.each([
    ["hello.cpp", '#include <iostream>\nint main() {\n  std::cout << "Hello\\n";\n}\n'],
    ["empty.py", ""],
    ["नमस्ते.py", `print("नमस्ते, दुनिया")  # Hindi\nprint("${String.fromCodePoint(0x1f600)}")\n`],
    ["tabs.c", "int main(void) {\n\treturn 0;\n}\n"],
  ])("%s comes back exactly as it went in", async (name, text) => {
    expect(await roundTrip(name, text)).toEqual({ ok: true, file: { name, text } });
  });

  it("a typical student program makes a short link", async () => {
    const program = Array.from({ length: 60 }, (_, i) => `    printf("line ${i}: %d\\n", values[${i}]);`).join("\n");
    const made = await makeCodeLink(ORIGIN, "lines.c", `#include <stdio.h>\nint main(void) {\n${program}\n}\n`);
    expect(made.ok && made.url.length).toBeLessThan(1500);
  });

  it("a file that can't fit is refused with the link's length, never cut", async () => {
    // Text that doesn't compress (a random-looking sequence) overflows 8000 characters.
    let seed = 7;
    const noise = Array.from({ length: 9000 }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 90))).join("");
    const made = await makeCodeLink(ORIGIN, "noise.txt", noise);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.refusal).toMatchObject({ kind: "too-long", chars: expect.any(Number) });
    if (!made.ok && made.refusal.kind === "too-long") expect(made.refusal.chars).toBeGreaterThan(MAX_LINK_CHARS);
  });

  it("a file bigger than any link can open is refused before compressing", async () => {
    const made = await makeCodeLink(ORIGIN, "big.txt", "a".repeat(MAX_INFLATED_BYTES + 1));
    expect(made).toEqual({ ok: false, refusal: { kind: "too-long", chars: null } });
  });

  it("text a file import would refuse isn't made into a link either", async () => {
    const bidi = `int x; /* ${String.fromCodePoint(0x202e)} */`;
    expect((await makeCodeLink(ORIGIN, "a.c", bidi)).ok).toBe(false);
    expect((await makeCodeLink(ORIGIN, "a.c", `a${String.fromCharCode(1)}b`)).ok).toBe(false);
  });
});

describe("reading a hostile or damaged link", () => {
  it("only #code= fragments are code links", () => {
    expect(isCodeLink("#code=1.abc")).toBe(true);
    expect(isCodeLink("#changelog")).toBe(false);
    expect(isCodeLink("")).toBe(false);
  });

  it.each([
    ["an unknown version", "#code=2.AAAA"],
    ["no payload", "#code=1."],
    ["not base64url", "#code=1.ab+/cd=="],
    ["a cut-off payload", ""],
    ["not deflate", `#code=1.${Buffer.from("plain text, not deflated").toString("base64url")}`],
    ["not JSON", forge("not json")],
    ["not UTF-8", forge(Buffer.from([0xff, 0xfe, 0xfd]))],
    ["an array", forgeJson(["a.c", "x"])],
    ["a missing field", forgeJson({ n: "a.c" })],
    ["a number for text", forgeJson({ n: "a.c", t: 1 })],
    ["an extra field", forgeJson({ n: "a.c", t: "x", run: true })],
  ])("%s: damaged, nothing opened", async (_, hash) => {
    const cut = hash || (await makeCodeLink(ORIGIN, "a.py", 'print("a long enough program to cut in half")\n'.repeat(4)).then((m) => (m.ok ? hashOf(m.url).slice(0, -12) : "")));
    expect(await readCodeLink(cut)).toEqual({ ok: false, refusal: { kind: "damaged" } });
  });

  it("a deflate bomb stops at the cap", async () => {
    // Deflate expands at most about 1000:1, so the biggest bomb that fits a link is a few MB: 20x the cap.
    const bomb = forge(Buffer.alloc(5 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(MAX_LINK_CHARS);
    expect(await readCodeLink(bomb)).toEqual({ ok: false, refusal: { kind: "too-big" } });
  });

  it("a short link's bigger bomb is fed to the decoder in small slices, and feeding stops soon after the cap", async () => {
    // A short link holds up to 264 KiB, which can inflate to over 250 MB: handed to the decoder whole,
    // one write could make all of it at once. Every write the decoder gets is recorded here.
    const writes: number[] = [];
    const Real = globalThis.DecompressionStream;
    class Spy extends Real {
      get writable() {
        const inner = super.writable.getWriter();
        return new WritableStream<BufferSource>({
          async write(chunk) {
            writes.push(chunk.byteLength);
            await inner.write(chunk);
          },
          close: () => inner.close(),
          abort: (reason) => inner.abort(reason),
        });
      }
    }
    vi.stubGlobal("DecompressionStream", Spy);
    try {
      const bytes = new Uint8Array(deflateRawSync(Buffer.alloc(32 * 1024 * 1024)));
      expect(bytes.length).toBeGreaterThan(16 * 1024);
      expect(await readPacked({ format: 1, bytes })).toEqual({ ok: false, refusal: { kind: "too-big" } });
      expect(writes.length).toBeGreaterThan(0);
      expect(Math.max(...writes)).toBeLessThanOrEqual(1024);
      // Feeding stopped long before the end. (Node's decoder takes up to 16 KiB ahead of its output;
      // a browser's, a TransformStream, takes one slice.)
      const fed = writes.reduce((a, b) => a + b, 0);
      expect(fed).toBeLessThanOrEqual(17 * 1024);
      expect(fed).toBeLessThan(bytes.length / 1.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a fragment longer than any link made is refused before decoding", async () => {
    expect(await readCodeLink(`#code=1.${"A".repeat(MAX_LINK_CHARS)}`)).toEqual({ ok: false, refusal: { kind: "too-big" } });
  });

  it.each([
    ["../escape.c"],
    ["folder/inner.c"],
    ["con.c"],
    [""],
    [`evil${String.fromCodePoint(0x202e)}c.py`],
    [`tab${String.fromCharCode(9)}name.c`],
  ])("the name %j is refused", async (name) => {
    const read = await readCodeLink(forgeJson({ n: name, t: "x" }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.kind).toBe("bad-name");
  });

  it("Trojan Source text and control characters are refused, as a file import refuses them", async () => {
    for (const t of [`/* ${String.fromCodePoint(0x2066)} */`, `a${String.fromCharCode(0)}b`]) {
      const read = await readCodeLink(forgeJson({ n: "a.c", t }));
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.refusal.kind).toBe("not-text");
    }
  });

  it("Windows line endings come back as LF (files are stored with LF), as a file import converts them", async () => {
    const CR = String.fromCharCode(13);
    const t = ["int main(void) {", "  return 0;", "}", ""].join(CR + "\n");
    expect(await readCodeLink(forgeJson({ n: "a.c", t }))).toEqual({ ok: true, file: { name: "a.c", text: "int main(void) {\n  return 0;\n}\n" } });
  });

  it.each([
    ["a lone carriage return", ["a", "b"].join(String.fromCharCode(13)), /carriage return/],
    ["mixed line endings", "a" + String.fromCharCode(13) + "\nb\n", /mix/],
  ])("%s is refused before any preview (a file import refuses a mix too, but converts CR-only files)", async (_, t, reason) => {
    const read = await readCodeLink(forgeJson({ n: "a.c", t }));
    expect(read).toMatchObject({ ok: false, refusal: { kind: "not-text", reason: expect.stringMatching(reason) } });
  });

  it("markup in the code is kept as text (the UI shows it as text); a name can't hold < or >", async () => {
    const t = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    expect(await readCodeLink(forgeJson({ n: "a&b'.html", t }))).toEqual({ ok: true, file: { name: "a&b'.html", text: t } });
    expect(await readCodeLink(forgeJson({ n: "<b>x</b>.html", t }))).toMatchObject({ ok: false, refusal: { kind: "bad-name" } });
  });

  it("every refusal has a sentence", () => {
    for (const r of [{ kind: "unsupported" }, { kind: "damaged" }, { kind: "too-big" }, { kind: "too-many" }, { kind: "bad-name", reason: "r" }, { kind: "not-text", reason: "r" }] as const) {
      expect(readRefusalText(r)).toMatch(/^This .+\.$/);
    }
  });
});

// Folder links (format 2, 0.18.0, owner's picks 2026-10-30): several files under one folder name, the
// same 8,000-character limit, every path and text checked as a file import checks them.
const forge2 = (value: unknown) => `#code=2.${deflateRawSync(JSON.stringify(value)).toString("base64url")}`;
const LAB = [
  { name: "main.c", text: '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%d\\n", twice(21)); }\n' },
  { name: "util.h", text: "#pragma once\nint twice(int x);\n" },
  { name: "src/util.c", text: '#include "../util.h"\nint twice(int x) { return 2 * x; }\n' },
  { name: "data/in.txt", text: "" },
];

describe("a folder in a code link", () => {
  it("comes back with its name and every file exactly as it went in", async () => {
    const made = await makeFolderLink(ORIGIN, "lab1", LAB);
    if (!made.ok) throw new Error(`not made: ${made.refusal.kind}`);
    expect(made.url.startsWith(`${ORIGIN}/#code=2.`)).toBe(true);
    expect(await readCodeLink(hashOf(made.url))).toEqual({ ok: true, folder: { name: "lab1", files: LAB } });
  });

  it("is refused when it can't fit, with the link's length; when it is empty; and past the most files", async () => {
    let seed = 11;
    const noise = (n: number) => Array.from({ length: n }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 90))).join("");
    const big = await makeFolderLink(ORIGIN, "big", [{ name: "a.txt", text: noise(5000) }, { name: "b.txt", text: noise(5000) }]);
    expect(big.ok).toBe(false);
    if (!big.ok && big.refusal.kind === "too-long") expect(big.refusal.chars).toBeGreaterThan(MAX_LINK_CHARS);
    else throw new Error("expected too-long");
    expect(await makeFolderLink(ORIGIN, "none", [])).toEqual({ ok: false, refusal: { kind: "empty" } });
    const many = Array.from({ length: MAX_LINK_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, text: "" }));
    expect(await makeFolderLink(ORIGIN, "many", many)).toEqual({ ok: false, refusal: { kind: "too-many" } });
    expect((await makeFolderLink(ORIGIN, "bidi", [{ name: "a.c", text: String.fromCodePoint(0x202e) }])).ok).toBe(false);
  });

  it.each([
    ["an extra field", { d: "lab", f: [{ n: "a.c", t: "" }], run: true }],
    ["files that aren't a list", { d: "lab", f: { n: "a.c", t: "" } }],
    ["no files", { d: "lab", f: [] }],
    ["a file with an extra field", { d: "lab", f: [{ n: "a.c", t: "", x: 1 }] }],
    ["a number for text", { d: "lab", f: [{ n: "a.c", t: 1 }] }],
  ])("%s: damaged, nothing opened", async (_, value) => {
    expect(await readCodeLink(forge2(value))).toEqual({ ok: false, refusal: { kind: "damaged" } });
  });

  it("more files than a link may hold are refused", async () => {
    const f = Array.from({ length: MAX_LINK_FILES + 1 }, (_, i) => ({ n: `f${i}.c`, t: "" }));
    expect(await readCodeLink(forge2({ d: "lab", f }))).toEqual({ ok: false, refusal: { kind: "too-many" } });
  });

  it.each([
    ["a folder name with a slash", "a/b", "x.c"],
    ["a folder name that climbs", "..", "x.c"],
    ["a path that climbs out", "lab", "../escape.c"],
    ["a path that climbs inside", "lab", "src/../../x.c"],
    ["an absolute path", "lab", "/etc/passwd"],
    ["a Windows device name", "lab", "con.c"],
    ["a text-direction character", "lab", `a${String.fromCodePoint(0x202e)}.c`],
    ["a path nested too deep", "lab", `${"d/".repeat(9)}x.c`],
  ])("%s is refused", async (_, d, n) => {
    const read = await readCodeLink(forge2({ d, f: [{ n, t: "" }] }));
    expect(read).toMatchObject({ ok: false, refusal: { kind: "bad-name" } });
  });

  it("two files that would land on one file, or a file where a folder is, are refused", async () => {
    for (const f of [
      [{ n: "Main.c", t: "" }, { n: "main.c", t: "" }],
      [{ n: "src", t: "" }, { n: "src/a.c", t: "" }],
    ]) expect(await readCodeLink(forge2({ d: "lab", f }))).toMatchObject({ ok: false, refusal: { kind: "bad-name" } });
  });

  it("each file's text is checked, and Windows line endings come back as LF", async () => {
    const CR = String.fromCharCode(13);
    expect(await readCodeLink(forge2({ d: "lab", f: [{ n: "a.c", t: `x${CR}\ny${CR}\n` }] }))).toEqual({ ok: true, folder: { name: "lab", files: [{ name: "a.c", text: "x\ny\n" }] } });
    const bad = await readCodeLink(forge2({ d: "lab", f: [{ n: "ok.c", t: "" }, { n: "b.c", t: `a${String.fromCharCode(0)}` }] }));
    expect(bad).toMatchObject({ ok: false, refusal: { kind: "not-text", reason: expect.stringMatching(/^b\.c: /) } });
  });

  it('"__proto__" and other object-like names are ordinary names', async () => {
    const files = [{ name: "__proto__/remove.h", text: "" }, { name: "constructor.c", text: "" }];
    const made = await makeFolderLink(ORIGIN, "__proto__", files);
    if (!made.ok) throw new Error(made.refusal.kind);
    expect(await readCodeLink(hashOf(made.url))).toEqual({ ok: true, folder: { name: "__proto__", files } });
    expect(({} as Record<string, unknown>).remove).toBeUndefined();
  });
});
