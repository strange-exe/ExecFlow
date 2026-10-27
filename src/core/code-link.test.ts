/// <reference types="node" />
// Code links (code-link.ts): a link made here opens to the same file, and a hostile link (cut off,
// a deflate bomb, the wrong shape, a bad name, Trojan Source text) is refused with its reason.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_INFLATED_BYTES, MAX_LINK_CHARS, isCodeLink, makeCodeLink, readCodeLink, readRefusalText } from "./code-link";

const ORIGIN = "https://code-editor.abhinesh.codes";
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
    ["tabs.c", "int main(void) {\n\treturn 0;\n}\r\n"],
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

  it("markup in the code is kept as text (the UI shows it as text); a name can't hold < or >", async () => {
    const t = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    expect(await readCodeLink(forgeJson({ n: "a&b'.html", t }))).toEqual({ ok: true, file: { name: "a&b'.html", text: t } });
    expect(await readCodeLink(forgeJson({ n: "<b>x</b>.html", t }))).toMatchObject({ ok: false, refusal: { kind: "bad-name" } });
  });

  it("every refusal has a sentence", () => {
    for (const r of [{ kind: "unsupported" }, { kind: "damaged" }, { kind: "too-big" }, { kind: "bad-name", reason: "r" }, { kind: "not-text", reason: "r" }] as const) {
      expect(readRefusalText(r)).toMatch(/^This .+\.$/);
    }
  });
});
