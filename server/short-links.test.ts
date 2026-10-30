import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IV_BYTES, LINK_TTLS, MAX_BODY_BYTES, MIN_BODY_BYTES, STORED_VERSION, TAG_BYTES } from "./short-link-shape";
import { CREATES_PER_HOUR, createLink, DAILY_CREATES, networkOf, readLink, READS_PER_HOUR, type Counter, type LinksDeps, type LinksEnv, type LinkStore } from "./short-links";

const ORIGIN = "https://code.example.test";
const NOW = Date.UTC(2026, 9, 30, 12, 30, 0);
const IP = "203.0.113.7";
/** The counts' own host: one count for every listed origin, never a real page's address. */
const COUNTS = "https://short-links.invalid";

/** A fake KV namespace: every call is recorded; `fail` makes put() throw (the daily write limit). */
function store(initial: Record<string, Uint8Array> = {}, fail = false) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, v]));
  const calls: { op: "get" | "put"; key: string; ttl?: number }[] = [];
  const kv: LinkStore = {
    async get(key) {
      calls.push({ op: "get", key });
      const v = data.get(key);
      return v ? (v.slice().buffer as ArrayBuffer) : null;
    },
    async put(key, value, options) {
      calls.push({ op: "put", key, ttl: options.expirationTtl });
      if (fail) throw new Error("KV put() limit exceeded for the day.");
      data.set(key, new Uint8Array(value));
    },
  };
  return { kv, data, calls };
}

/** A fake Cache API (caches.default): keyed by URL; an entry lasts its Cache-Control max-age on `clock`. */
function counter(fail = false, clock = { now: NOW }) {
  const entries = new Map<string, { value: string; until: number }>();
  const c: Counter = {
    async match(request) {
      if (fail) throw new Error("cache down");
      const v = entries.get(request.url);
      return v === undefined || v.until <= clock.now ? undefined : new Response(v.value);
    },
    async put(request, response) {
      if (fail) throw new Error("cache down");
      const age = /max-age=([0-9]+)/.exec(response.headers.get("cache-control") ?? "");
      entries.set(request.url, { value: await response.text(), until: clock.now + (age ? Number(age[1]) * 1000 : 0) });
    },
  };
  return { c, entries };
}

/** Random bytes from a fixed list of ids' worth of bytes, then a counter: repeatable ids. */
function randomFrom(seed = 1): LinksDeps["random"] {
  let s = seed;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (s = (s * 48271) % 2147483647) & 0xff;
  };
}

const body = (size = 200, version = STORED_VERSION) => {
  const b = new Uint8Array(size);
  b[0] = version;
  for (let i = 1; i < size; i++) b[i] = (i * 31) & 0xff;
  return b;
};

const post = (data: BodyInit | null, { ttl = "2592000", query, headers = {} }: { ttl?: string; query?: string; headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}/api/links${query ?? `?ttl=${ttl}`}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": IP, ...headers },
    body: data,
    duplex: "half",
  } as RequestInit);

const get = (id: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/links/${id}`, { headers });

function setup(opts: { kv?: ReturnType<typeof store>; counter?: ReturnType<typeof counter> | null; env?: Partial<LinksEnv>; seed?: number; clock?: { now: number } } = {}) {
  const clock = opts.clock ?? { now: NOW };
  const kv = opts.kv ?? store();
  const ctr = opts.counter === undefined ? counter(false, clock) : opts.counter;
  const env: LinksEnv = { ALLOWED_ORIGIN: ORIGIN, LINKS: kv.kv, ...opts.env };
  const deps: LinksDeps = { random: randomFrom(opts.seed), now: () => clock.now, counter: ctr?.c ?? null };
  return { kv, ctr, env, deps, clock };
}

/** The i-th of many distinct IPv4 networks, for counts that span networks. */
const nth = (i: number) => `198.18.${i >> 8}.${i & 255}`;

async function json(res: Response) {
  const text = await res.clone().text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) consoleSpies.push(vi.spyOn(console, name).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy, "the function logs nothing").not.toHaveBeenCalled();
    spy.mockRestore();
  }
  consoleSpies.length = 0;
});

const noCors = (res: Response) => expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);

describe("every answer", () => {
  it("is never cached or sniffed, stays on this site, and has no CORS header", async () => {
    const s = setup();
    const made = await createLink(post(body()), s.env, s.deps);
    const { id } = (await json(made)) as { id: string };
    const answers = [made, await readLink(get(id), s.env, id, s.deps), await readLink(get("AAAAAAAAAA"), s.env, "AAAAAAAAAA", s.deps), await createLink(post(body(), { headers: { Origin: "https://evil.test" } }), s.env, s.deps)];
    for (const res of answers) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      noCors(res);
    }
  });
});

describe("POST /api/links (make a link)", () => {
  it("stores the bytes as sent under a fresh 10-character id, for the chosen time, and says when it expires", async () => {
    for (const ttl of LINK_TTLS) {
      const s = setup({ seed: ttl });
      const sent = body(500);
      const res = await createLink(post(sent, { ttl: String(ttl) }), s.env, s.deps);
      expect(res.status).toBe(201);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const answer = (await json(res)) as { id: string; expires: number };
      expect(Object.keys(answer).sort()).toEqual(["expires", "id"]);
      expect(answer.id).toMatch(/^[0-9A-Za-z]{10}$/);
      expect(answer.expires).toBe(Math.floor(NOW / 1000) + ttl);
      const put = s.kv.calls.find((c) => c.op === "put")!;
      expect(put).toEqual({ op: "put", key: `link:${answer.id}`, ttl });
      expect([...s.kv.data.get(`link:${answer.id}`)!]).toEqual([...sent]);
    }
  });

  it("makes different ids for different links, from all 62 characters", async () => {
    const s = setup({ seed: 99 });
    const ids = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const res = await createLink(post(body(), { headers: { "CF-Connecting-IP": `198.51.100.${i}` } }), s.env, s.deps);
      ids.add(((await json(res)) as { id: string }).id);
    }
    expect(ids.size).toBe(40);
    const chars = new Set([...ids].join(""));
    expect(chars.size).toBeGreaterThan(50);
  });

  it("never overwrites a stored link: a taken id is drawn again, and after 4 taken ids it gives up (503)", async () => {
    // The ids the same random bytes draw, found by making links with that seed first.
    const probe = setup({ seed: 5 });
    const drawn: string[] = [];
    for (let i = 0; i < 5; i++) drawn.push(((await json(await createLink(post(body(), { headers: { "CF-Connecting-IP": `192.0.2.${i}` } }), probe.env, probe.deps))) as { id: string }).id);
    const old = body(64);
    const one = setup({ seed: 5, kv: store({ [`link:${drawn[0]}`]: old }) });
    const res = await createLink(post(body()), one.env, one.deps);
    expect(res.status).toBe(201);
    expect(((await json(res)) as { id: string }).id).toBe(drawn[1]);
    expect([...one.kv.data.get(`link:${drawn[0]}`)!]).toEqual([...old]);
    const all = setup({ seed: 5, kv: store(Object.fromEntries(drawn.slice(0, 4).map((d) => [`link:${d}`, old]))) });
    const full = await createLink(post(body()), all.env, all.deps);
    expect(full.status).toBe(503);
    expect(await json(full)).toEqual({ error: "unavailable" });
    expect(all.kv.calls.filter((c) => c.op === "put")).toEqual([]);
  });

  it("says unavailable (503) when the store refuses a write, such as the free plan's daily limit", async () => {
    const s = setup({ kv: store({}, true) });
    const res = await createLink(post(body()), s.env, s.deps);
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "unavailable" });
    // The store's own words are never passed on.
    expect(await res.text()).not.toContain("limit");
  });

  it("only POST (405), only from this site (403), only application/octet-stream (415)", async () => {
    const s = setup();
    const wrong = await createLink(new Request(`${ORIGIN}/api/links?ttl=2592000`, { method: "GET", headers: { Origin: ORIGIN } }), s.env, s.deps);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    const variants: Record<string, string>[] = [{ Origin: "https://evil.test" }, { Origin: "null" }, { Origin: `${ORIGIN}.evil.test` }, { Origin: `${ORIGIN}/` }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "none" }];
    for (const headers of variants) {
      const res = await createLink(post(body(), { headers }), s.env, s.deps);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await json(res)).toEqual({ error: "forbidden" });
    }
    const noOrigin = post(body());
    noOrigin.headers.delete("origin");
    expect((await createLink(noOrigin, s.env, s.deps)).status).toBe(403);
    for (const type of ["text/plain", "application/json", "multipart/form-data", "application/x-www-form-urlencoded", "application/octet-streamx", ""]) {
      const res = await createLink(post(body(), { headers: { "Content-Type": type } }), s.env, s.deps);
      expect(res.status, type).toBe(415);
    }
    expect(s.kv.calls).toEqual([]);
    // Two listed origins (the site's old and new address): either may make a link.
    const two = setup({ env: { ALLOWED_ORIGIN: `https://old.example.test, ${ORIGIN}` } });
    expect((await createLink(post(body()), two.env, two.deps)).status).toBe(201);
    expect((await createLink(post(body(), { headers: { Origin: "https://old.example.test" } }), two.env, two.deps)).status).toBe(201);
  });

  it("takes exactly one ttl, one of the three times (400 otherwise), before reading anything", async () => {
    const s = setup();
    const bad = ["?ttl=0", "?ttl=60", "?ttl=86401", "?ttl=86400.0", "?ttl=+86400", "?ttl=%2086400", "?ttl=8.64e4", "?ttl=0x15180", "?ttl=", "", "?TTL=86400", "?ttl=86400&ttl=7776000", "?ttl=86400&id=AAAAAAAAAA", "?ttl=86400&key=x", "?ttl=31536000", "?ttl=-86400", "?ttl=086400"];
    for (const query of bad) {
      const res = await createLink(post(body(), { query }), s.env, s.deps);
      expect(res.status, query).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_request" });
    }
    expect(s.kv.calls).toEqual([]);
  });

  it("refuses a body over the cap (413) without reading past it, with or without Content-Length", async () => {
    const s = setup();
    expect((await createLink(post(body(MAX_BODY_BYTES + 1)), s.env, s.deps)).status).toBe(413);
    // A declared length over the cap: refused before the body is touched.
    let pulled = 0;
    const lying = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const declared = post(lying, { headers: { "Content-Length": String(MAX_BODY_BYTES + 1) } });
    expect((await createLink(declared, s.env, s.deps)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
    // No Content-Length and an endless stream: the reader stops at the cap.
    pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    expect((await createLink(post(endless), s.env, s.deps)).status).toBe(413);
    expect(pulled * 16 * 1024).toBeLessThanOrEqual(MAX_BODY_BYTES + 3 * 16 * 1024);
    for (const length of ["abc", "-1", "1e9", "99999999999"]) expect((await createLink(post(body(), { headers: { "Content-Length": length } }), s.env, s.deps)).status, length).toBe(413);
    expect(s.kv.calls).toEqual([]);
    // Exactly at the cap is fine.
    expect((await createLink(post(body(MAX_BODY_BYTES)), s.env, s.deps)).status).toBe(201);
  });

  it("refuses forged bodies (400): too short to be an encrypted link, or another version", async () => {
    const s = setup();
    for (const forged of [new Uint8Array(0), body(MIN_BODY_BYTES - 1), body(1 + IV_BYTES + TAG_BYTES), body(200, 0), body(200, 2), body(200, 0xff), new TextEncoder().encode("{\"n\":\"a.c\",\"t\":\"x\"}".padEnd(64, " "))]) {
      const res = await createLink(post(forged), s.env, s.deps);
      expect(res.status, `${forged.length} bytes, version ${forged[0]}`).toBe(400);
    }
    expect(s.kv.calls.filter((c) => c.op === "put")).toEqual([]);
    expect((await createLink(post(body(MIN_BODY_BYTES)), s.env, s.deps)).status).toBe(201);
  });

  it("isn't there (404 not_configured) without its store or a valid ALLOWED_ORIGIN", async () => {
    for (const env of [{ LINKS: undefined }, { ALLOWED_ORIGIN: undefined }, { ALLOWED_ORIGIN: `${ORIGIN}/` }, { ALLOWED_ORIGIN: "*" }, { ALLOWED_ORIGIN: "http://code.example.test" }]) {
      const s = setup({ env });
      const res = await createLink(post(body()), s.env, s.deps);
      expect(res.status, JSON.stringify(env)).toBe(404);
      expect(await json(res)).toEqual({ error: "not_configured" });
      const read = await readLink(get("AAAAAAAAAA"), s.env, "AAAAAAAAAA", s.deps);
      expect(read.status).toBe(404);
      expect(await json(read)).toEqual({ error: "not_configured" });
    }
  });
});

describe("the per-client limit", () => {
  it(`allows ${CREATES_PER_HOUR} links an hour from one address, then 429 with Retry-After until the hour ends`, async () => {
    const s = setup();
    for (let i = 0; i < CREATES_PER_HOUR; i++) expect((await createLink(post(body()), s.env, s.deps)).status, String(i)).toBe(201);
    const over = await createLink(post(body()), s.env, s.deps);
    expect(over.status).toBe(429);
    expect(await json(over)).toEqual({ error: "rate_limited" });
    // 12:30 UTC: 30 minutes left in the hour.
    expect(over.headers.get("retry-after")).toBe("1800");
    expect(s.kv.calls.filter((c) => c.op === "put")).toHaveLength(CREATES_PER_HOUR);
    // Another address is counted on its own; the next hour starts again.
    expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": "198.51.100.1" } }), s.env, s.deps)).status).toBe(201);
    const later: LinksDeps = { ...s.deps, now: () => NOW + 3600_000 };
    expect((await createLink(post(body()), s.env, later)).status).toBe(201);
  });

  it("counts by a hash of the network under the counts' own host, never the address itself", async () => {
    const s = setup();
    await createLink(post(body()), s.env, s.deps);
    const keys = [...s.ctr!.entries.keys()];
    // The client's hour, and the day's total.
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(new URL(key).origin).toBe(COUNTS);
      expect(key).not.toContain(IP);
      expect(key).not.toContain(IP.replaceAll(".", ""));
    }
  });

  it("one count for every listed origin: the site's old address doesn't double the limit", async () => {
    const OLD = "https://old.example.test";
    const s = setup({ env: { ALLOWED_ORIGIN: `${OLD}, ${ORIGIN}` } });
    for (let i = 0; i < CREATES_PER_HOUR; i++) expect((await createLink(post(body(), { headers: { Origin: i % 2 ? OLD : ORIGIN } }), s.env, s.deps)).status, String(i)).toBe(201);
    expect((await createLink(post(body(), { headers: { Origin: OLD } }), s.env, s.deps)).status).toBe(429);
    expect((await createLink(post(body()), s.env, s.deps)).status).toBe(429);
  });

  it("an IPv6 /64 is one network, however its addresses are spelled; the next /64 is another", async () => {
    const s = setup();
    const same = ["2001:db8:1:2::1", "2001:DB8:1:2::2", "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2:ffff:ffff:ffff:ffff"];
    for (let i = 0; i < CREATES_PER_HOUR; i++) expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": same[i % same.length] } }), s.env, s.deps)).status, String(i)).toBe(201);
    expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": "2001:db8:1:2:1234::9" } }), s.env, s.deps)).status).toBe(429);
    expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": "2001:db8:1:3::1" } }), s.env, s.deps)).status).toBe(201);
  });

  it("counts refused bodies too, but not requests refused before the body (another site, bad ttl)", async () => {
    const s = setup();
    for (let i = 0; i < CREATES_PER_HOUR; i++) await createLink(post(body(5)), s.env, s.deps);
    expect((await createLink(post(body()), s.env, s.deps)).status).toBe(429);
    const t = setup();
    for (let i = 0; i < CREATES_PER_HOUR + 5; i++) await createLink(post(body(), { ttl: "1" }), t.env, t.deps);
    expect((await createLink(post(body()), t.env, t.deps)).status).toBe(201);
  });
});

describe("networkOf", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:DB8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2:3:4:1.2.3.4", "2001:db8:1:2::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:cb00:7107", "203.0.113.7"],
  ])("%s is %s", (ip, network) => expect(networkOf(ip)).toBe(network));

  it.each([null, "", "unknown", "not an address", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "1::2::3", "12345::", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:", "g::1", "::1.2.3"])(
    "%j is unknown",
    (ip) => expect(networkOf(ip)).toBe("unknown"),
  );
});

describe("the day's total", () => {
  it(`allows ${DAILY_CREATES} links a UTC day across every network (below KV's 1,000), then 503 unavailable until 00:00 UTC`, async () => {
    expect(DAILY_CREATES).toBeLessThan(1000);
    const s = setup();
    for (let i = 0; i < DAILY_CREATES; i++) expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": nth(i) } }), s.env, s.deps)).status, String(i)).toBe(201);
    const full = await createLink(post(body(), { headers: { "CF-Connecting-IP": nth(DAILY_CREATES) } }), s.env, s.deps);
    // The wording the store's own daily limit gets, so the dialogs say the same thing.
    expect(full.status).toBe(503);
    expect(await json(full)).toEqual({ error: "unavailable" });
    // 12:30 UTC: 11 h 30 min to midnight.
    expect(full.headers.get("retry-after")).toBe("41400");
    expect(s.kv.calls.filter((c) => c.op === "put")).toHaveLength(DAILY_CREATES);
    // The next UTC day starts again.
    s.clock.now = Date.UTC(2026, 9, 31, 0, 0, 1);
    expect((await createLink(post(body(), { headers: { "CF-Connecting-IP": nth(DAILY_CREATES + 1) } }), s.env, s.deps)).status).toBe(201);
  });

  it("isn't spent by requests refused before the store (bad body, too big, over the client's hour)", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await createLink(post(body(5), { headers: { "CF-Connecting-IP": nth(i) } }), s.env, s.deps);
    await createLink(post(body(MAX_BODY_BYTES + 1), { headers: { "CF-Connecting-IP": nth(9) } }), s.env, s.deps);
    for (let i = 0; i < CREATES_PER_HOUR + 3; i++) await createLink(post(body()), s.env, s.deps);
    const day = [...s.ctr!.entries].filter(([k]) => k.includes("/created/"));
    expect(day).toHaveLength(1);
    expect(day[0][1].value).toBe(String(CREATES_PER_HOUR));
  });

  it("without a cache (or with one failing) links are still made, past both counts: the store's daily limit is the hard cap", async () => {
    for (const ctr of [null, counter(true)]) {
      const s = setup({ counter: ctr });
      for (let i = 0; i < CREATES_PER_HOUR + 2; i++) expect((await createLink(post(body()), s.env, s.deps)).status).toBe(201);
    }
  });
});

describe("GET /api/links/<id> (open a link)", () => {
  it("answers the stored bytes as they were sent, as octet-stream", async () => {
    const sent = body(777);
    const s = setup({ kv: store({ "link:Ab3dEf9hIj": sent }) });
    const res = await readLink(get("Ab3dEf9hIj"), s.env, "Ab3dEf9hIj", s.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(sent.length));
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...sent]);
    // A same-origin fetch may send Sec-Fetch-Site and no Origin.
    expect((await readLink(get("Ab3dEf9hIj", { "Sec-Fetch-Site": "same-origin" }), s.env, "Ab3dEf9hIj", s.deps)).status).toBe(200);
    expect((await readLink(get("Ab3dEf9hIj", { Origin: ORIGIN }), s.env, "Ab3dEf9hIj", s.deps)).status).toBe(200);
  });

  it("an unknown or expired link is 404 not_found", async () => {
    const s = setup();
    const res = await readLink(get("Zz9Zz9Zz9Z"), s.env, "Zz9Zz9Zz9Z", s.deps);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  it("remembers an unknown id's 404 for a minute: a flood of the same id asks the store once", async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      const res = await readLink(get("Zz9Zz9Zz9Z"), s.env, "Zz9Zz9Zz9Z", s.deps);
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: "not_found" });
    }
    expect(s.kv.calls).toEqual([{ op: "get", key: "link:Zz9Zz9Zz9Z" }]);
    // Under the counts' own host, with nothing but the id.
    expect([...s.ctr!.entries.keys()]).toContain(`${COUNTS}/miss/Zz9Zz9Zz9Z`);
    // A minute later the store is asked again; a stored link is never remembered as missing.
    s.clock.now += 60_000;
    await readLink(get("Zz9Zz9Zz9Z"), s.env, "Zz9Zz9Zz9Z", s.deps);
    expect(s.kv.calls).toHaveLength(2);
    const t = setup({ kv: store({ "link:Ab3dEf9hIj": body() }) });
    for (let i = 0; i < 3; i++) expect((await readLink(get("Ab3dEf9hIj"), t.env, "Ab3dEf9hIj", t.deps)).status).toBe(200);
    expect([...t.ctr!.entries.keys()].filter((k) => k.includes("/miss/"))).toEqual([]);
  });

  it(`allows ${READS_PER_HOUR} opens an hour from one network, then 429 with Retry-After; creating is counted apart`, async () => {
    const s = setup({ kv: store({ "link:Ab3dEf9hIj": body() }) });
    for (let i = 0; i < READS_PER_HOUR; i++) expect((await readLink(get("Ab3dEf9hIj", { "CF-Connecting-IP": IP }), s.env, "Ab3dEf9hIj", s.deps)).status, String(i)).toBe(200);
    const over = await readLink(get("Ab3dEf9hIj", { "CF-Connecting-IP": IP }), s.env, "Ab3dEf9hIj", s.deps);
    expect(over.status).toBe(429);
    expect(await json(over)).toEqual({ error: "rate_limited" });
    expect(over.headers.get("retry-after")).toBe("1800");
    expect(s.kv.calls.filter((c) => c.op === "get")).toHaveLength(READS_PER_HOUR);
    // Misses count too, before the store or the miss cache is asked.
    expect((await readLink(get("Zz9Zz9Zz9Z", { "CF-Connecting-IP": IP }), s.env, "Zz9Zz9Zz9Z", s.deps)).status).toBe(429);
    // Another network opens it; this network may still make links; the next hour starts again.
    expect((await readLink(get("Ab3dEf9hIj", { "CF-Connecting-IP": "198.51.100.1" }), s.env, "Ab3dEf9hIj", s.deps)).status).toBe(200);
    expect((await createLink(post(body()), s.env, s.deps)).status).toBe(201);
    s.clock.now += 3600_000;
    expect((await readLink(get("Ab3dEf9hIj", { "CF-Connecting-IP": IP }), s.env, "Ab3dEf9hIj", s.deps)).status).toBe(200);
  });

  it("without a cache (or with one failing) links still open: reads aren't counted and misses ask the store", async () => {
    for (const ctr of [null, counter(true)]) {
      const s = setup({ counter: ctr, kv: store({ "link:Ab3dEf9hIj": body() }) });
      for (let i = 0; i < READS_PER_HOUR + 2; i++) expect((await readLink(get("Ab3dEf9hIj"), s.env, "Ab3dEf9hIj", s.deps)).status).toBe(200);
      expect((await readLink(get("Zz9Zz9Zz9Z"), s.env, "Zz9Zz9Zz9Z", s.deps)).status).toBe(404);
      expect((await readLink(get("Zz9Zz9Zz9Z"), s.env, "Zz9Zz9Zz9Z", s.deps)).status).toBe(404);
      expect(s.kv.calls.filter((c) => c.key === "link:Zz9Zz9Zz9Z")).toHaveLength(2);
    }
  });

  it("a stored value that isn't a link's shape is never served (404)", async () => {
    const s = setup({ kv: store({ "link:AAAAAAAAAA": body(10), "link:BBBBBBBBBB": body(200, 9), "link:CCCCCCCCCC": body(MAX_BODY_BYTES + 1) }) });
    for (const id of ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"]) expect((await readLink(get(id), s.env, id, s.deps)).status, id).toBe(404);
  });

  it("refuses ids that aren't 10 of [0-9A-Za-z] (400) without asking the store, path tricks included", async () => {
    const s = setup();
    const bad: unknown[] = ["", "abc", "AAAAAAAAAAA", "AAAAAAAAA", "../../etc", "..%2F..%2Fx", "AAAA/AAAAA", "AAAA.AAAAA", "AAAA%2eAAAA", "AAAAAAAAA ", "AAAAAAAAA-", "AAAAAAAAA_", `AAAAAAAAA${String.fromCodePoint(0x0410)}`, `AAAAAAAAA${String.fromCodePoint(0)}`, ["AAAAAAAAAA"], undefined, null, 1234567890];
    for (const id of bad) {
      const res = await readLink(get("x"), s.env, id, s.deps);
      expect(res.status, JSON.stringify(id)).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_request" });
    }
    expect(s.kv.calls).toEqual([]);
  });

  it("only GET (405), and never for another site (403)", async () => {
    const s = setup({ kv: store({ "link:Ab3dEf9hIj": body() }) });
    const wrong = await readLink(new Request(`${ORIGIN}/api/links/Ab3dEf9hIj`, { method: "DELETE" }), s.env, "Ab3dEf9hIj", s.deps);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    const others: Record<string, string>[] = [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.test" }, { Origin: "null" }];
    for (const headers of others) {
      expect((await readLink(get("Ab3dEf9hIj", headers), s.env, "Ab3dEf9hIj", s.deps)).status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("a store that fails answers 503 unavailable, not the error", async () => {
    const kv: LinkStore = {
      get: async () => {
        throw new Error("KV get() limit exceeded for the day.");
      },
      put: async () => {},
    };
    const res = await readLink(get("Ab3dEf9hIj"), { ALLOWED_ORIGIN: ORIGIN, LINKS: kv }, "Ab3dEf9hIj", setup().deps);
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "unavailable" });
  });
});

describe("the stored layout", () => {
  it("is version, IV and ciphertext with its tag: the sizes the browser uses", () => {
    expect(STORED_VERSION).toBe(1);
    expect(IV_BYTES).toBe(12);
    expect(TAG_BYTES).toBe(16);
    expect(MIN_BODY_BYTES).toBe(30);
  });
});
