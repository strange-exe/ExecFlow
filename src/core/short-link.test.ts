// Short links (src/core/short-link.ts) against the real function's logic (server/short-links.ts) with
// an in-memory store: what is sent never holds the key or the code in readable form, a link opens
// only with its own key, and whatever comes back is checked as a code link is (a hostile payload
// meets the same refusals).
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { IV_BYTES, LINK_TTLS, MAX_BODY_BYTES, STORED_VERSION } from "../../server/short-link-shape";
import { createLink, readLink, type LinkStore } from "../../server/short-links";
import { MAX_LINK_FILES, packFile, packFolder } from "./code-link";
import { makeShortLink, openShortLink, shortLinkId, shortMakeRefusalText, shortReadRefusalText, type ShortDeps } from "./short-link";

const ORIGIN = "https://execflow.example.test";
const C_PROGRAM = '#include <stdio.h>\nint main(void) {\n    printf("secret homework\\n");\n    return 0;\n}\n';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The site: the function's real logic over a Map, reached through a fetch that records every request. */
function site() {
  const data = new Map<string, Uint8Array>();
  const kv: LinkStore = {
    get: async (key) => (data.has(key) ? (data.get(key)!.slice().buffer as ArrayBuffer) : null),
    put: async (key, value) => void data.set(key, new Uint8Array(value)),
  };
  const env = { ALLOWED_ORIGIN: ORIGIN, LINKS: kv };
  const sent: Sent[] = [];
  let online = true;
  let down = false;
  const deps: ShortDeps = {
    online: () => online,
    fetch: async (input, init) => {
      if (!online) throw new TypeError("Failed to fetch");
      const url = new URL(input, ORIGIN);
      const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array(0);
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      sent.push({ url: url.href, method: init.method ?? "GET", headers, body });
      if (down) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      // The browser adds these to a same-origin request.
      const request = new Request(url, { ...init, headers: { ...headers, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }, body: init.body ? body : undefined });
      if (url.pathname === "/api/links") return createLink(request, env, { random: (b) => void crypto.getRandomValues(b), now: () => Date.UTC(2026, 9, 30), counter: null });
      if (url.pathname.startsWith("/api/links/")) return readLink(request, env, decodeURIComponent(url.pathname.slice("/api/links/".length)));
      return new Response("not here", { status: 404 });
    },
  };
  return {
    deps,
    data,
    sent,
    goOffline: () => void (online = false),
    goDown: () => void (down = true),
  };
}

const parts = (url: string) => {
  const u = new URL(url);
  return { id: u.pathname.slice(3), hash: u.hash };
};

async function packedFile(name = "hello.c", text = C_PROGRAM) {
  const p = await packFile(name, text);
  if (!p.ok) throw new Error(p.refusal.kind);
  return p.packed;
}

async function made(s: ReturnType<typeof site>, ttl: (typeof LINK_TTLS)[number] = 2592000, packed?: Awaited<ReturnType<typeof packedFile>>) {
  const m = await makeShortLink(ORIGIN, packed ?? (await packedFile()), ttl, s.deps);
  if (!m.ok) throw new Error(`not made: ${m.refusal.kind}`);
  return m;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const contains = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).includes(Buffer.from(needle));

/** Encrypts any plaintext as a short link would, and stores it: for payloads the app would never make. */
async function forge(s: ReturnType<typeof site>, plaintext: Uint8Array, id = "F0rgedL1nk") {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("ExecFlow short link v1") }, key, plaintext as BufferSource));
  s.data.set(`link:${id}`, new Uint8Array([STORED_VERSION, ...iv, ...ct]));
  return { id, hash: `#${b64url(raw)}` };
}
const plain = (format: number, json: unknown) => new Uint8Array([format, ...deflateRawSync(typeof json === "string" ? json : JSON.stringify(json))]);

describe("making and opening a short link", () => {
  it("round-trips a file and a folder, for each expiry, as /s/<id>#<key>", async () => {
    for (const ttl of LINK_TTLS) {
      const s = site();
      const link = await made(s, ttl);
      expect(link.url).toMatch(/^https:[/][/]execflow[.]example[.]test[/]s[/][0-9A-Za-z]{10}#[0-9A-Za-z_-]{43}$/);
      expect(link.expires).toBe(Date.UTC(2026, 9, 30) + ttl * 1000);
      const { id, hash } = parts(link.url);
      expect(await openShortLink(id, hash, s.deps)).toEqual({ ok: true, file: { name: "hello.c", text: C_PROGRAM } });
    }
    const s = site();
    const folder = await packFolder("lab1", [{ name: "main.c", text: C_PROGRAM }, { name: "src/util.h", text: "int add(int, int);\n" }]);
    if (!folder.ok) throw new Error(folder.refusal.kind);
    const link = await made(s, 86400, folder.packed);
    const { id, hash } = parts(link.url);
    expect(await openShortLink(id, hash, s.deps)).toEqual({ ok: true, folder: { name: "lab1", files: [{ name: "main.c", text: C_PROGRAM }, { name: "src/util.h", text: "int add(int, int);\n" }] } });
  });

  it("never sends the key, nor the code in readable form: not in a URL, a header or a body", async () => {
    const s = site();
    const link = await made(s);
    const { id, hash } = parts(link.url);
    await openShortLink(id, hash, s.deps);
    const key = hash.slice(1);
    const raw = Buffer.from(key, "base64url");
    expect(raw).toHaveLength(32);
    expect(s.sent.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([`POST /api/links?ttl=2592000`, `GET /api/links/${id}`]);
    for (const r of s.sent) {
      expect(r.url).not.toContain(key);
      expect(r.url).not.toContain("#");
      expect(JSON.stringify(r.headers)).not.toContain(key);
      expect(contains(r.body, raw)).toBe(false);
      expect(contains(r.body, new TextEncoder().encode(key))).toBe(false);
      expect(contains(r.body, new TextEncoder().encode("secret homework"))).toBe(false);
      expect(contains(r.body, new TextEncoder().encode("hello.c"))).toBe(false);
    }
    const post = s.sent[0];
    expect(post.headers["content-type"]).toBe("application/octet-stream");
    expect(post.body[0]).toBe(STORED_VERSION);
    expect([...s.data.values()][0]).toEqual(post.body);
  });

  it("gives every link its own key and IV, even for the same code", async () => {
    const s = site();
    const a = await made(s);
    const b = await made(s);
    expect(parts(a.url).hash).not.toBe(parts(b.url).hash);
    const [x, y] = [...s.data.values()];
    expect(b64url(x.subarray(1, 1 + IV_BYTES))).not.toBe(b64url(y.subarray(1, 1 + IV_BYTES)));
    expect(b64url(x)).not.toBe(b64url(y));
  });
});

describe("opening refuses what isn't a whole, untouched link", () => {
  it("a wrong key, a garbled or cut ciphertext, or another link's bytes: damaged, nothing opened", async () => {
    const s = site();
    const a = await made(s);
    const b = await made(s);
    const pa = parts(a.url);
    const pb = parts(b.url);
    // b's key on a's bytes.
    expect(await openShortLink(pa.id, pb.hash, s.deps)).toEqual({ ok: false, refusal: { kind: "damaged" } });
    // a's bytes replayed under b's id: only a's key opens them (the same code as a; nothing new).
    s.data.set(`link:${pb.id}`, s.data.get(`link:${pa.id}`)!);
    expect(await openShortLink(pb.id, pb.hash, s.deps)).toEqual({ ok: false, refusal: { kind: "damaged" } });
    const stored = s.data.get(`link:${pa.id}`)!;
    for (const at of [1, IV_BYTES + 2, stored.length - 1]) {
      const garbled = stored.slice();
      garbled[at] ^= 1;
      s.data.set(`link:${pa.id}`, garbled);
      expect(await openShortLink(pa.id, pa.hash, s.deps), String(at)).toEqual({ ok: false, refusal: { kind: "damaged" } });
    }
    s.data.set(`link:${pa.id}`, stored.slice(0, stored.length - 5));
    expect(await openShortLink(pa.id, pa.hash, s.deps)).toEqual({ ok: false, refusal: { kind: "damaged" } });
  });

  it("a missing, cut or malformed key is damaged before anything is fetched", async () => {
    const s = site();
    const a = await made(s);
    const { id, hash } = parts(a.url);
    const before = s.sent.length;
    for (const bad of ["", "#", hash.slice(0, -1), `${hash}A`, `${hash.slice(0, -1)}+`, `${hash.slice(0, -1)}=`, `#${"A".repeat(42)}B`, `#code=1.${hash.slice(1)}`]) {
      expect(await openShortLink(id, bad, s.deps), bad).toEqual({ ok: false, refusal: { kind: "damaged" } });
    }
    for (const badId of ["", "abc", "../../etc/", "Ab3dEf9hI_", "Ab3dEf9hIjk"]) expect(await openShortLink(badId, hash, s.deps), badId).toEqual({ ok: false, refusal: { kind: "damaged" } });
    expect(s.sent.length).toBe(before);
  });

  it("an unknown or expired link is gone; offline and a failing site say so", async () => {
    const s = site();
    const a = await made(s);
    const { id, hash } = parts(a.url);
    expect(await openShortLink("Zz9Zz9Zz9Z", hash, s.deps)).toEqual({ ok: false, refusal: { kind: "gone" } });
    s.goDown();
    expect(await openShortLink(id, hash, s.deps)).toEqual({ ok: false, refusal: { kind: "unavailable" } });
    const t = site();
    t.goOffline();
    expect(await openShortLink(id, hash, t.deps)).toEqual({ ok: false, refusal: { kind: "offline" } });
    // A fetch that fails while the browser says it is online: the site couldn't be reached.
    const flaky: ShortDeps = { online: () => true, fetch: async () => Promise.reject(new TypeError("Failed to fetch")) };
    expect(await openShortLink(id, hash, flaky)).toEqual({ ok: false, refusal: { kind: "unavailable" } });
  });

  it("an answer bigger than any link is cut off unread (damaged)", async () => {
    let pulled = 0;
    const deps: ShortDeps = {
      online: () => true,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              const chunk = new Uint8Array(64 * 1024);
              chunk[0] = STORED_VERSION;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "Content-Type": "application/octet-stream" } },
        ),
    };
    expect(await openShortLink("Ab3dEf9hIj", `#${"A".repeat(43)}`, deps)).toEqual({ ok: false, refusal: { kind: "damaged" } });
    expect(pulled * 64 * 1024).toBeLessThanOrEqual(MAX_BODY_BYTES + 3 * 64 * 1024);
  });
});

describe("a hostile link, correctly encrypted, meets the code link's refusals", () => {
  it.each([
    ["Trojan Source text", plain(1, { n: "a.c", t: `int ok = 1; /* ${String.fromCodePoint(0x202e)} } */` }), "not-text"],
    ["a control character", plain(1, { n: "a.c", t: `a${String.fromCharCode(1)}b` }), "not-text"],
    ["a ../ name", plain(1, { n: "../../.bashrc", t: "x" }), "bad-name"],
    ["a folder name for one file", plain(1, { n: "src/a.c", t: "x" }), "bad-name"],
    ["a ../ path in a folder", plain(2, { d: "lab", f: [{ n: "../escape.c", t: "x" }] }), "bad-name"],
    ["a path too deep", plain(2, { d: "lab", f: [{ n: `${"d/".repeat(8)}a.c`, t: "x" }] }), "bad-name"],
    ["two files on one name", plain(2, { d: "lab", f: [{ n: "A.c", t: "x" }, { n: "a.c", t: "y" }] }), "bad-name"],
    ["too many files", plain(2, { d: "lab", f: Array.from({ length: MAX_LINK_FILES + 1 }, (_, i) => ({ n: `f${i}.c`, t: "x" })) }), "too-many"],
    ["a deflate bomb", new Uint8Array([1, ...deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x20))]), "too-big"],
    ["an extra field", plain(1, { n: "a.c", t: "x", run: true }), "damaged"],
    ["not deflate", new Uint8Array([1, 0xff, 0xfe, 0xfd]), "damaged"],
    ["an unknown format", plain(3, { n: "a.c", t: "x" }), "damaged"],
    ["format 0", plain(0, { n: "a.c", t: "x" }), "damaged"],
    ["nothing after the format", new Uint8Array([1]), "damaged"],
  ])("%s", async (_, payload, kind) => {
    const s = site();
    const { id, hash } = await forge(s, payload);
    const read = await openShortLink(id, hash, s.deps);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.kind).toBe(kind);
  });
});

describe("making refuses plainly", () => {
  it("offline: nothing is sent", async () => {
    const s = site();
    s.goOffline();
    const m = await makeShortLink(ORIGIN, await packedFile(), 2592000, s.deps);
    expect(m).toEqual({ ok: false, refusal: { kind: "offline" } });
    expect(s.sent).toEqual([]);
  });

  it.each([
    [429, { error: "rate_limited" }, { "Retry-After": "120" }, { kind: "busy" }],
    [503, { error: "unavailable" }, {}, { kind: "unavailable" }],
    [404, { error: "not_configured" }, {}, { kind: "not-set-up" }],
    [413, { error: "too_large" }, {}, { kind: "too-long", chars: null }],
    [500, { error: "internal" }, {}, { kind: "failed" }],
    [201, { id: "../../x0000", expires: 1 }, {}, { kind: "failed" }],
    [201, { id: "Ab3dEf9hIj" }, {}, { kind: "failed" }],
    [201, { id: "Ab3dEf9hIj", expires: "soon" }, {}, { kind: "failed" }],
    [200, "<html>the site's 404 page</html>", {}, { kind: "failed" }],
  ])("%i %j", async (status, answer, headers, refusal) => {
    const deps: ShortDeps = { online: () => true, fetch: async () => new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status, headers }) };
    expect(await makeShortLink(ORIGIN, await packedFile(), 2592000, deps)).toEqual({ ok: false, refusal });
  });

  it("a fetch that fails online is 'failed', offline is 'offline'", async () => {
    let online = true;
    const deps: ShortDeps = { online: () => online, fetch: async () => Promise.reject(new TypeError("Failed to fetch")) };
    expect(await makeShortLink(ORIGIN, await packedFile(), 86400, deps)).toEqual({ ok: false, refusal: { kind: "failed" } });
    deps.fetch = async () => {
      online = false;
      throw new TypeError("Failed to fetch");
    };
    expect(await makeShortLink(ORIGIN, await packedFile(), 86400, deps)).toEqual({ ok: false, refusal: { kind: "offline" } });
  });

  it("the sentences name the problem and what to do", () => {
    expect(shortMakeRefusalText({ kind: "offline" })).toContain("offline");
    expect(shortMakeRefusalText({ kind: "unavailable" })).toContain("1,000");
    expect(shortMakeRefusalText({ kind: "busy" })).toContain("hour");
    expect(shortReadRefusalText({ kind: "gone" })).toContain("expired");
    expect(shortReadRefusalText({ kind: "offline" })).toContain("offline");
    expect(shortReadRefusalText({ kind: "damaged" })).toContain("short link is damaged");
    expect(shortReadRefusalText({ kind: "bad-name", reason: "x" })).toContain("short link");
  });
});

describe("the address", () => {
  it("is /s/ and exactly 10 of [0-9A-Za-z]", () => {
    expect(shortLinkId("/s/Ab3dEf9hIj")).toBe("Ab3dEf9hIj");
    for (const p of ["/s/", "/s/Ab3dEf9hI", "/s/Ab3dEf9hIjk", "/s/Ab3dEf9hIj/", "/s/../../etc", "/S/Ab3dEf9hIj", "/x/s/Ab3dEf9hIj", "/s/Ab3dEf9h%2F", "/", "/s/Ab3dEf9hI-"]) expect(shortLinkId(p), p).toBe(null);
  });
});
