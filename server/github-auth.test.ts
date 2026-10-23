import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_VERSION, CALLBACK_PATH, handleAuth, MAX_BODY_BYTES, TOKEN_URL, type AuthEnv, type AuthRoute, type Fetch } from "./github-auth";

const ORIGIN = "https://code.example.test";
const SECRET = "fake-client-secret-0123456789abcdef";
const ENV: AuthEnv = { GITHUB_CLIENT_ID: "Iv23liFAKEclient01", GITHUB_CLIENT_SECRET: SECRET, GITHUB_APP_SLUG: "codeeditor-sync", ALLOWED_ORIGIN: ORIGIN };
const CODE = "fakecode0123456789ab";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(10);
const ACCESS = "ghu_FAKEaccess0123456789abcdefghijklmn";
const REFRESH = "ghr_FAKErefresh0123456789abcdefghijklmnopqrstuvwxyz";
const PAIR = { access_token: ACCESS, expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" };

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fake upstream: records each call and answers with `answer` (or throws it). */
function upstream(answer: Response | Error | (() => Response) = Response.json(PAIR)) {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, init });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { fetch, seen };
}

const post = (route: AuthRoute, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/auth/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/auth/config`, { headers });

/** Every answer the tests saw: the secret must never be in any of them. */
const answers: { status: number; headers: [string, string][]; text: string }[] = [];
async function run(route: AuthRoute, request: Request, fake = upstream(), env = ENV) {
  const res = await handleAuth(route, request, env, fake.fetch);
  const text = await res.clone().text();
  answers.push({ status: res.status, headers: [...res.headers], text });
  return { res, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null, seen: fake.seen };
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) consoleSpies.push(vi.spyOn(console, name).mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy, "the relay logs nothing").not.toHaveBeenCalled();
    spy.mockRestore();
  }
  consoleSpies.length = 0;
});

describe("every answer", () => {
  it("carries the fixed security headers and no CORS header", async () => {
    for (const { res } of [await run("config", get()), await run("token", post("token", { code: CODE, code_verifier: VERIFIER })), await run("token", post("token", {}, { Origin: "https://evil.test" }))]) {
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("/api/auth/config", () => {
  it("gives only the public values", async () => {
    const { res, json } = await run("config", get());
    expect(res.status).toBe(200);
    expect(json).toEqual({ clientId: ENV.GITHUB_CLIENT_ID, appSlug: ENV.GITHUB_APP_SLUG });
  });

  it("answers 404 when the site isn't set up (or set up wrongly), so the app offers the token path", async () => {
    for (const env of [{}, { ...ENV, GITHUB_CLIENT_SECRET: undefined }, { ...ENV, ALLOWED_ORIGIN: `${ORIGIN}/` }, { ...ENV, ALLOWED_ORIGIN: "http://code.example.test" }, { ...ENV, GITHUB_APP_SLUG: "Bad Slug" }]) {
      const { res, json } = await run("config", get(), upstream(), env);
      expect(res.status).toBe(404);
      expect(json).toEqual({ error: "not_configured" });
    }
  });

  it("allows only GET, and refuses other sites", async () => {
    const wrong = await run("config", new Request(`${ORIGIN}/api/auth/config`, { method: "POST" }));
    expect(wrong.res.status).toBe(405);
    expect(wrong.res.headers.get("allow")).toBe("GET");
    expect((await run("config", get({ "Sec-Fetch-Site": "cross-site" }))).res.status).toBe(403);
    expect((await run("config", get({ Origin: "https://evil.test" }))).res.status).toBe(403);
    // A same-origin GET carries no Origin header: that is fine.
    expect((await run("config", get({ "Sec-Fetch-Site": "same-origin" }))).res.status).toBe(200);
  });
});

describe("POST routes refuse before anything is forwarded", () => {
  const routes: [AuthRoute, Record<string, unknown>][] = [
    ["token", { code: CODE, code_verifier: VERIFIER }],
    ["refresh", { refresh_token: REFRESH }],
    ["revoke", { access_token: ACCESS }],
  ];

  it.each(routes)("%s: another Origin, no Origin, or a cross-site fetch is refused (403)", async (route, body) => {
    const variants: Record<string, string>[] = [{ Origin: "https://evil.test" }, { Origin: "null" }, { Origin: `${ORIGIN}.evil.test` }, { Origin: "https://preview.codeeditor.pages.dev" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "none" }];
    for (const headers of variants) {
      const fake = upstream();
      const { res, json } = await run(route, post(route, body, headers), fake);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(json).toEqual({ error: "forbidden" });
      expect(fake.seen).toEqual([]);
    }
    const noOrigin = post(route, body);
    noOrigin.headers.delete("origin");
    const fake = upstream();
    expect((await run(route, noOrigin, fake)).res.status).toBe(403);
    expect(fake.seen).toEqual([]);
  });

  it.each(routes)("%s: only POST (405), only JSON (415)", async (route, body) => {
    const fake = upstream();
    const wrong = await run(route, new Request(`${ORIGIN}/api/auth/${route}`, { method: "GET", headers: { Origin: ORIGIN } }), fake);
    expect(wrong.res.status).toBe(405);
    expect(wrong.res.headers.get("allow")).toBe("POST");
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const { res } = await run(route, post(route, JSON.stringify(body), { "Content-Type": type }), fake);
      expect(res.status, type).toBe(415);
    }
    expect((await run(route, post(route, body, { "Content-Type": "application/json; charset=utf-8" }), upstream())).res.status).not.toBe(415);
    expect(fake.seen).toEqual([]);
  });

  it.each(routes)("%s: a body over 4 KB is refused (413), with or without Content-Length", async (route, body) => {
    const fake = upstream();
    const big = JSON.stringify({ ...body, pad: "x".repeat(5 * 1024) });
    expect((await run(route, post(route, big), fake)).res.status).toBe(413);
    // A streamed body sends no Content-Length: the reader stops at the cap.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        controller.close();
      },
    });
    const streamed = new Request(`${ORIGIN}/api/auth/${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: stream, duplex: "half" } as RequestInit);
    expect((await run(route, streamed, fake)).res.status).toBe(413);
    const declared = post(route, body, { "Content-Length": String(MAX_BODY_BYTES + 1) });
    expect((await run(route, declared, fake)).res.status).toBe(413);
    expect(fake.seen).toEqual([]);
  });

  it.each(routes)("%s: bad JSON or a wrong shape is refused (400)", async (route) => {
    const fake = upstream();
    for (const raw of ["{", "[]", "null", '"text"', "{}"]) expect((await run(route, post(route, raw), fake)).res.status, raw).toBe(400);
    expect(fake.seen).toEqual([]);
  });

  it("checks the code, the PKCE verifier and the repository id", async () => {
    const fake = upstream();
    const bad = [
      { code: "", code_verifier: VERIFIER },
      { code: "a b", code_verifier: VERIFIER },
      { code: "x".repeat(101), code_verifier: VERIFIER },
      { code: CODE },
      { code: CODE, code_verifier: "short" },
      { code: CODE, code_verifier: "v".repeat(129) },
      { code: CODE, code_verifier: "v".repeat(42) + "+" },
      { code: CODE, code_verifier: VERIFIER, repository_id: "123" },
      { code: CODE, code_verifier: VERIFIER, repository_id: -1 },
      { code: CODE, code_verifier: VERIFIER, repository_id: 1.5 },
      { code: CODE, code_verifier: VERIFIER, redirect_uri: "https://evil.test/auth-callback", repository_id: 0 },
    ];
    for (const body of bad) {
      const { res, json } = await run("token", post("token", body), fake);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(json).toEqual({ error: "invalid_request" });
    }
    expect(fake.seen).toEqual([]);
  });

  it("refresh takes only a ghr_ token, revoke only a ghu_ token", async () => {
    const fake = upstream();
    for (const t of [ACCESS, "ghr_", "ghr_short", `ghr_${"x".repeat(252)}`, "ghr_has space here!", 42]) expect((await run("refresh", post("refresh", { refresh_token: t }), fake)).res.status).toBe(400);
    for (const t of [REFRESH, "github_pat_0123456789abcdefghijklmnopqrstuvwxyz", "ghu_", 42]) expect((await run("revoke", post("revoke", { access_token: t }), fake)).res.status).toBe(400);
    expect(fake.seen).toEqual([]);
  });
});

describe("/api/auth/token", () => {
  it("sends the code, the PKCE verifier and the fixed redirect_uri to GitHub's constant URL, form-encoded", async () => {
    const fake = upstream();
    const { res, json, seen } = await run("token", post("token", { code: CODE, code_verifier: VERIFIER, redirect_uri: "https://evil.test/x" }), fake);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(TOKEN_URL);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.redirect).toBe("manual");
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("user-agent")).toBeTruthy();
    const form = Object.fromEntries(new URLSearchParams(String(seen[0].init.body)));
    expect(form).toEqual({ client_id: ENV.GITHUB_CLIENT_ID, client_secret: SECRET, code: CODE, code_verifier: VERIFIER, redirect_uri: `${ORIGIN}${CALLBACK_PATH}` });
    // Only the four whitelisted fields come back (not scope, token_type or anything GitHub adds).
    expect(json).toEqual({ access_token: ACCESS, expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15897600 });
  });

  it("forwards repository_id when given", async () => {
    const fake = upstream();
    await run("token", post("token", { code: CODE, code_verifier: VERIFIER, repository_id: 123456 }), fake);
    expect(new URLSearchParams(String(fake.seen[0].init.body)).get("repository_id")).toBe("123456");
  });

  it("maps GitHub's errors (also when GitHub answers 200) to fixed words, never its text", async () => {
    const cases: [unknown, number, number, string][] = [
      [{ error: "bad_verification_code", error_description: `The code ${CODE} is wrong`, error_uri: "https://docs" }, 200, 400, "bad_verification_code"],
      [{ error: "unverified_user_email", error_description: "x" }, 200, 400, "unverified_user_email"],
      [{ error: "access_denied" }, 200, 400, "access_denied"],
      [{ error: "incorrect_client_credentials", error_description: `secret ${SECRET} wrong` }, 200, 502, "incorrect_client_credentials"],
      [{ error: "redirect_uri_mismatch" }, 200, 502, "redirect_uri_mismatch"],
      [{ error: "something_new", error_description: "<b>hi</b>" }, 200, 502, "upstream"],
      [{ error: "bad_verification_code" }, 401, 400, "bad_verification_code"],
      [{ message: "Server Error" }, 500, 502, "upstream"],
      [{ ...PAIR, refresh_token: undefined }, 200, 502, "upstream"],
      [{ ...PAIR, access_token: "gho_oauthAppToken0123456789" }, 200, 502, "upstream"],
      [{ ...PAIR, expires_in: "28800" }, 200, 502, "upstream"],
      [PAIR, 201, 502, "upstream"],
    ];
    for (const [body, upstreamStatus, status, error] of cases) {
      const { res, json, text } = await run("token", post("token", { code: CODE, code_verifier: VERIFIER }), upstream(() => Response.json(body, { status: upstreamStatus })));
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(json).toEqual({ error });
      expect(text).not.toContain(CODE);
    }
  });

  it("answers 502 when GitHub can't be read, times out or redirects", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    for (const answer of [new TypeError("fetch failed"), timeout as unknown as Error, () => new Response("<html>", { status: 200 }), () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })]) {
      const { res, json } = await run("token", post("token", { code: CODE, code_verifier: VERIFIER }), upstream(answer));
      expect(res.status).toBe(502);
      expect(json).toEqual({ error: "upstream" });
    }
  });

  it("never throws: a body stream that fails is a 400", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    const req = new Request(`${ORIGIN}/api/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: stream, duplex: "half" } as RequestInit);
    const { res } = await run("token", req);
    expect(res.status).toBe(400);
  });
});

describe("/api/auth/refresh", () => {
  it("sends grant_type=refresh_token with the client credentials", async () => {
    const fake = upstream();
    const { res, json } = await run("refresh", post("refresh", { refresh_token: REFRESH }), fake);
    expect(res.status).toBe(200);
    expect(fake.seen[0].url).toBe(TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(String(fake.seen[0].init.body)))).toEqual({ client_id: ENV.GITHUB_CLIENT_ID, client_secret: SECRET, grant_type: "refresh_token", refresh_token: REFRESH });
    expect(json).toEqual({ access_token: ACCESS, expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15897600 });
  });

  it("a dead refresh token is bad_refresh_token (400)", async () => {
    const { res, json } = await run("refresh", post("refresh", { refresh_token: REFRESH }), upstream(() => Response.json({ error: "bad_refresh_token", error_description: REFRESH })));
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "bad_refresh_token" });
  });
});

describe("/api/auth/revoke", () => {
  it("deletes this one token with Basic client credentials (not the whole authorization)", async () => {
    const fake = upstream(() => new Response(null, { status: 204 }));
    const { res, text } = await run("revoke", post("revoke", { access_token: ACCESS }), fake);
    expect(res.status).toBe(204);
    expect(text).toBe("");
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].url).toBe(`https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/token`);
    expect(fake.seen[0].init.method).toBe("DELETE");
    expect(fake.seen[0].init.redirect).toBe("manual");
    const headers = new Headers(fake.seen[0].init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${ENV.GITHUB_CLIENT_ID}:${SECRET}`)}`);
    expect(headers.get("x-github-api-version")).toBe(API_VERSION);
    expect(headers.get("user-agent")).toBeTruthy();
    expect(JSON.parse(String(fake.seen[0].init.body))).toEqual({ access_token: ACCESS });
  });

  it("a token GitHub doesn't know is gone already (204); other answers are 502", async () => {
    expect((await run("revoke", post("revoke", { access_token: ACCESS }), upstream(() => new Response(null, { status: 404 })))).res.status).toBe(204);
    for (const status of [401, 422, 500]) {
      const { res, json } = await run("revoke", post("revoke", { access_token: ACCESS }), upstream(() => Response.json({ message: SECRET }, { status })));
      expect(res.status).toBe(502);
      expect(json).toEqual({ error: "upstream" });
    }
    expect((await run("revoke", post("revoke", { access_token: ACCESS }), upstream(new TypeError("offline")))).res.status).toBe(502);
  });
});

describe("the client secret", () => {
  it("is in no answer the tests saw, body or header", () => {
    expect(answers.length).toBeGreaterThan(40);
    for (const a of answers) {
      expect(a.text).not.toContain(SECRET);
      expect(JSON.stringify(a.headers)).not.toContain(SECRET);
      expect(a.text).not.toContain(btoa(`${ENV.GITHUB_CLIENT_ID}:${SECRET}`));
    }
  });
});
