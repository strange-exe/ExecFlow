import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { captureCallback, takeCallback } from "./auth-callback";
import { createClient, GitHubError, TokenUnavailable } from "./github";
import {
  AUTH_API,
  authorizeUrl,
  base64url,
  checkCallback,
  createAppTokenSource,
  exchange,
  fetchConfig,
  PENDING_KEY,
  PENDING_MAX_AGE_MS,
  pkceChallenge,
  REFRESH_EARLY_MS,
  revokeToken,
  SignInError,
  startSignIn,
  takePending,
  type Fetch,
  type Lock,
  type PendingSignIn,
  type TokenStore,
} from "./github-app-auth";
import { listReachable } from "./installations";
import { explainError } from "./repo-check";
import { deleteSecretsDb, forgetAppTokens, loadAppTokens, loadToken, rememberAppTokens, rememberToken, SECRETS_DB, type AppTokens } from "./token-store";
import { createFakeGitHub, TEST_TOKEN } from "./test-helpers";
import { openDB } from "idb";

const CONFIG = { clientId: "Iv23liFAKEclient01", appSlug: "codeeditor-sync" };
const ORIGIN = "https://code.example.test";
const A1 = "ghu_FAKEaccessONE0123456789abcdefghij";
const A2 = "ghu_FAKEaccessTWO0123456789abcdefghij";
const A3 = "ghu_FAKEaccessTHREE0123456789abcdefgh";
const R1 = "ghr_FAKErefreshONE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
const R2 = "ghr_FAKErefreshTWO0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
const HOUR = 3_600_000;

/** A Storage stand-in (sessionStorage is per tab in a browser; here a Map). */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const pair = (access: string, refresh: string) => ({ access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600 });

/** The relay, faked: records each call; answers come from `answer`. */
function relay(answer: (route: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { route: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    const route = url.slice(AUTH_API.length + 1);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ route, body, init });
    return answer(route, body);
  };
  return { fetch, calls };
}

beforeEach(async () => {
  await deleteSecretsDb();
});

describe("PKCE and state", () => {
  it("base64url has no padding or +/ characters; a random value is 43 characters (RFC 7636 4.1)", async () => {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
    const { randomValue } = await import("./github-app-auth");
    const values = new Set(Array.from({ length: 50 }, () => randomValue()));
    expect(values.size).toBe(50);
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("S256 matches RFC 7636 Appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("the authorize URL asks for S256, offline_access and the account picker, with the fixed callback", () => {
    const url = new URL(authorizeUrl(CONFIG, ORIGIN, "S".repeat(43), "C".repeat(43)));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CONFIG.clientId,
      redirect_uri: `${ORIGIN}/auth-callback`,
      state: "S".repeat(43),
      code_challenge: "C".repeat(43),
      code_challenge_method: "S256",
      scope: "offline_access",
      prompt: "select_account",
    });
  });

  it("startSignIn keeps the verifier in this tab's storage and sends only its S256 challenge", async () => {
    const storage = memoryStorage();
    const url = new URL(await startSignIn({ config: CONFIG, origin: ORIGIN, ws: "ws1", remember: true, repoId: 42, storage, now: 1000 }));
    const pending = JSON.parse(storage.map.get(PENDING_KEY)!) as PendingSignIn;
    expect(pending).toMatchObject({ v: 1, ws: "ws1", remember: true, createdAt: 1000, repoId: 42 });
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("code_challenge")).toBe(await pkceChallenge(pending.verifier));
    expect(url.href).not.toContain(pending.verifier);
  });
});

describe("the callback", () => {
  const pending = (over: Partial<PendingSignIn> = {}): PendingSignIn => ({ v: 1, state: "s".repeat(43), verifier: "v".repeat(43), ws: "ws1", remember: false, createdAt: 0, ...over });

  it("takePending reads the record once and ignores it after 10 minutes", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_KEY, JSON.stringify(pending({ createdAt: 1000 })));
    expect(takePending(storage, 1000 + PENDING_MAX_AGE_MS)).not.toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(takePending(storage, 2000)).toBeNull();
    storage.setItem(PENDING_KEY, JSON.stringify(pending({ createdAt: 1000 })));
    expect(takePending(storage, 1001 + PENDING_MAX_AGE_MS)).toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    for (const bad of ["{", JSON.stringify({ ...pending(), v: 2 }), JSON.stringify({ ...pending(), state: "short" })]) {
      storage.setItem(PENDING_KEY, bad);
      expect(takePending(storage, 0)).toBeNull();
    }
  });

  it("a missing record, another state, another workspace: refused as 'state' (nothing is sent)", () => {
    const cb = { code: "abc", state: "s".repeat(43), error: null };
    expect(checkCallback(cb, null, "ws1")).toEqual({ ok: false, reason: "state" });
    expect(checkCallback({ ...cb, state: "t".repeat(43) }, pending(), "ws1")).toEqual({ ok: false, reason: "state" });
    expect(checkCallback({ ...cb, state: null }, pending(), "ws1")).toEqual({ ok: false, reason: "state" });
    expect(checkCallback(cb, pending(), "ws2")).toEqual({ ok: false, reason: "state" });
    // An error with a wrong state is still a state mismatch (login CSRF can't choose the message).
    expect(checkCallback({ code: null, state: "x", error: "access_denied" }, pending(), "ws1")).toEqual({ ok: false, reason: "state" });
    expect(checkCallback({ code: null, state: "s".repeat(43), error: "access_denied" }, pending(), "ws1")).toEqual({ ok: false, reason: "denied" });
    expect(checkCallback({ code: "a b", state: "s".repeat(43), error: null }, pending(), "ws1")).toEqual({ ok: false, reason: "github" });
    expect(checkCallback(cb, pending(), "ws1")).toMatchObject({ ok: true, code: "abc" });
  });

  it("a state record can't be used twice: the second callback finds nothing", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_KEY, JSON.stringify(pending()));
    const cb = { code: "abc", state: "s".repeat(43), error: null };
    expect(checkCallback(cb, takePending(storage, 0), "ws1").ok).toBe(true);
    expect(checkCallback(cb, takePending(storage, 0), "ws1")).toEqual({ ok: false, reason: "state" });
  });

  it("captureCallback takes the values and replaces the URL with / at once", () => {
    const calls: unknown[][] = [];
    captureCallback({ pathname: "/auth-callback", search: "?code=abc&state=xyz" }, { replaceState: (...args: unknown[]) => void calls.push(args) });
    expect(calls).toEqual([[null, "", "/"]]);
    expect(takeCallback()).toEqual({ code: "abc", state: "xyz", error: null });
    expect(takeCallback()).toBeNull();
    captureCallback({ pathname: "/", search: "?code=abc" }, { replaceState: () => calls.push(["no"]) });
    expect(calls).toHaveLength(1);
    expect(takeCallback()).toBeNull();
  });
});

describe("the relay calls", () => {
  it("config: the relay's JSON is available; a 404 or the app's own HTML page means absent; no answer is unreachable", async () => {
    expect(await fetchConfig(async () => json(200, CONFIG))).toEqual({ state: "available", config: CONFIG });
    expect(await fetchConfig(async () => json(404, { error: "not_configured" }))).toEqual({ state: "absent" });
    expect(await fetchConfig(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }))).toEqual({ state: "absent" });
    expect(await fetchConfig(async () => json(200, { clientId: "x y", appSlug: "s" }))).toEqual({ state: "absent" });
    expect(await fetchConfig(async () => Promise.reject(new TypeError("offline")))).toEqual({ state: "unreachable" });
  });

  it("exchange posts the code and the PKCE verifier (and repository_id) as JSON to the same site", async () => {
    const r = relay(() => json(200, pair(A1, R1)));
    const tokens = await exchange("code123", "v".repeat(43), 77, r.fetch, () => 1000);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].route).toBe("token");
    expect(r.calls[0].body).toEqual({ code: "code123", code_verifier: "v".repeat(43), repository_id: 77 });
    expect(r.calls[0].init.method).toBe("POST");
    expect(new Headers(r.calls[0].init.headers).get("content-type")).toBe("application/json");
    expect(r.calls[0].init.credentials).toBe("same-origin");
    expect(r.calls[0].init.cache).toBe("no-store");
    expect(tokens).toEqual({ access: A1, accessExpiresAt: 1000 + 28800_000, refresh: R1, refreshExpiresAt: 1000 + 15897600_000 });
  });

  it("maps the relay's error words; anything unexpected is 'unavailable'", async () => {
    const kinds: [Response | Error, string][] = [
      [json(400, { error: "bad_verification_code" }), "bad_verification_code"],
      [json(400, { error: "unverified_user_email" }), "unverified_user_email"],
      [json(502, { error: "incorrect_client_credentials" }), "unavailable"],
      [json(403, { error: "forbidden" }), "unavailable"],
      [json(404, { error: "not_configured" }), "unavailable"],
      [new Response("<html>", { status: 200 }), "unavailable"],
      [json(200, { access_token: "gho_x" }), "unavailable"],
      [new TypeError("offline"), "network"],
    ];
    for (const [answer, kind] of kinds) {
      const fetch: Fetch = async () => {
        if (answer instanceof Error) throw answer;
        return answer.clone();
      };
      await expect(exchange("c", "v".repeat(43), undefined, fetch)).rejects.toMatchObject({ name: "SignInError", kind });
    }
  });

  it("revoke posts this one access token and is true only on 204", async () => {
    const r = relay(() => new Response(null, { status: 204 }));
    expect(await revokeToken(A1, r.fetch)).toBe(true);
    expect(r.calls[0]).toMatchObject({ route: "revoke", body: { access_token: A1 } });
    expect(await revokeToken(A1, relay(() => json(502, { error: "upstream" })).fetch)).toBe(false);
    expect(await revokeToken(A1, async () => Promise.reject(new TypeError("offline")))).toBe(false);
  });
});

describe("the app token source", () => {
  const fresh = (now: number, access = A1, refresh = R1): AppTokens => ({ access, accessExpiresAt: now + 8 * HOUR, refresh, refreshExpiresAt: now + 4000 * HOUR });
  const memoryStore = (initial: AppTokens | null = null): TokenStore & { value: AppTokens | null; saves: number } => {
    const s = {
      value: initial,
      saves: 0,
      load: async () => s.value,
      save: async (t: AppTokens) => {
        s.value = { ...t };
        s.saves++;
      },
      forget: async () => {
        s.value = null;
      },
    };
    return s;
  };
  /** One lock for "every tab": runs one holder at a time, like navigator.locks. */
  function sharedLock(): Lock {
    let tail: Promise<unknown> = Promise.resolve();
    return (run) => {
      const next = tail.then(run);
      tail = next.catch(() => undefined);
      return next;
    };
  }

  it("uses the access token while it has more than 10 minutes left; refreshes before that", async () => {
    let now = 0;
    const r = relay(() => json(200, pair(A2, R2)));
    const source = createAppTokenSource({ tokens: fresh(0), remember: false, fetch: r.fetch, now: () => now, lock: sharedLock(), store: memoryStore() });
    expect(await source.current()).toBe(A1);
    now = 8 * HOUR - REFRESH_EARLY_MS + 1;
    expect(await source.current()).toBe(A2);
    expect(r.calls.map((c) => c.route)).toEqual(["refresh"]);
    expect(r.calls[0].body).toEqual({ refresh_token: R1 });
    expect(source.secrets()).toEqual(expect.arrayContaining([A1, R1, A2, R2]));
  });

  it("two requests at once spend the refresh token once", async () => {
    let now = 8 * HOUR;
    const r = relay(async () => {
      await new Promise((res) => setTimeout(res, 5));
      return json(200, pair(A2, R2));
    });
    const source = createAppTokenSource({ tokens: fresh(0), remember: false, fetch: r.fetch, now: () => now, lock: sharedLock(), store: memoryStore() });
    expect(await Promise.all([source.current(), source.current(), source.refresh!(A1)])).toEqual([A2, A2, true]);
    expect(r.calls).toHaveLength(1);
  });

  it("two tabs with the same remembered pair: the second takes the first's new pair from the sealed record (no second refresh)", async () => {
    const now = 8 * HOUR;
    const store = memoryStore(fresh(0));
    const lock = sharedLock();
    const r = relay(() => json(200, pair(A2, R2)));
    const tab1 = createAppTokenSource({ tokens: fresh(0), remember: true, fetch: r.fetch, now: () => now, lock, store });
    const tab2 = createAppTokenSource({ tokens: fresh(0), remember: true, fetch: r.fetch, now: () => now, lock, store });
    expect(await tab1.current()).toBe(A2);
    expect(store.value?.access).toBe(A2);
    expect(await tab2.current()).toBe(A2);
    expect(r.calls).toHaveLength(1);
    expect(store.saves).toBe(1);
  });

  it("a dead refresh token is 'auth' and the sealed record is deleted", async () => {
    const store = memoryStore(fresh(0));
    const r = relay(() => json(400, { error: "bad_refresh_token" }));
    const source = createAppTokenSource({ tokens: fresh(0), remember: true, fetch: r.fetch, now: () => 9 * HOUR, lock: sharedLock(), store });
    await expect(source.current()).rejects.toEqual(new TokenUnavailable("auth"));
    expect(store.value).toBeNull();
  });

  it("an expired refresh token is not even sent", async () => {
    const r = relay(() => json(200, pair(A2, R2)));
    const t = { ...fresh(0), refreshExpiresAt: 9 * HOUR };
    const source = createAppTokenSource({ tokens: t, remember: false, fetch: r.fetch, now: () => 9 * HOUR, lock: sharedLock(), store: memoryStore() });
    await expect(source.current()).rejects.toMatchObject({ kind: "auth" });
    expect(r.calls).toEqual([]);
  });

  it("offline near expiry: the remaining minutes are still used; once expired it is 'network'", async () => {
    let now = 8 * HOUR - 60_000;
    const source = createAppTokenSource({ tokens: fresh(0), remember: false, fetch: async () => Promise.reject(new TypeError("offline")), now: () => now, lock: sharedLock(), store: memoryStore() });
    expect(await source.current()).toBe(A1);
    now = 8 * HOUR + 1;
    await expect(source.current()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("the GitHub client with an app token", () => {
  const tokens = (access: string, refresh: string): AppTokens => ({ access, accessExpiresAt: Date.now() + 8 * HOUR, refresh, refreshExpiresAt: Date.now() + 4000 * HOUR });
  const store = (): TokenStore => ({ load: async () => null, save: async () => {}, forget: async () => {} });
  const passLock: Lock = (run) => run();

  it("a 401 refreshes once and retries that one request once; the sync carries on", async () => {
    const gh = createFakeGitHub({ token: A2 });
    const r = relay(() => json(200, pair(A2, R2)));
    const source = createAppTokenSource({ tokens: tokens(A1, R1), remember: false, fetch: r.fetch, lock: passLock, store: store() });
    const client = createClient({ source, owner: "me", repo: "workspace", fetch: gh.fetch, sleep: async () => {} });
    expect((await client.getRepo()).defaultBranch).toBe("main");
    expect(gh.requests.map((q) => q.headers.get("authorization"))).toEqual([`Bearer ${A1}`, `Bearer ${A2}`]);
    expect(r.calls.map((c) => c.route)).toEqual(["refresh"]);
    expect(client.tokenRejected).toBe(false);
    // The next request goes straight out with the new token.
    await client.getRepo();
    expect(gh.requests.at(-1)!.headers.get("authorization")).toBe(`Bearer ${A2}`);
  });

  it("a second 401 (after the refresh) stops the client for good: no third request", async () => {
    const gh = createFakeGitHub({ token: A3 });
    const r = relay(() => json(200, pair(A2, R2)));
    const source = createAppTokenSource({ tokens: tokens(A1, R1), remember: false, fetch: r.fetch, lock: passLock, store: store() });
    const client = createClient({ source, owner: "me", repo: "workspace", fetch: gh.fetch, sleep: async () => {} });
    const error = await client.getRepo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe("auth");
    expect(gh.requests).toHaveLength(2);
    expect(r.calls).toHaveLength(1);
    expect(client.tokenRejected).toBe(true);
    await expect(client.getRepo()).rejects.toMatchObject({ kind: "auth" });
    expect(gh.requests).toHaveLength(2);
    expect(explainError(error, "app")).toMatch(/sign in again/);
  });

  it("a refused refresh stops at once; an unreachable relay is a network error that may pass", async () => {
    const gh = createFakeGitHub({ token: A3 });
    const dead = createAppTokenSource({ tokens: tokens(A1, R1), remember: false, fetch: relay(() => json(400, { error: "bad_refresh_token" })).fetch, lock: passLock, store: store() });
    const c1 = createClient({ source: dead, owner: "me", repo: "workspace", fetch: gh.fetch, sleep: async () => {} });
    await expect(c1.getRepo()).rejects.toMatchObject({ kind: "auth" });
    expect(c1.tokenRejected).toBe(true);
    const away = createAppTokenSource({ tokens: tokens(A1, R1), remember: false, fetch: async () => Promise.reject(new TypeError("offline")), lock: passLock, store: store() });
    const c2 = createClient({ source: away, owner: "me", repo: "workspace", fetch: gh.fetch, sleep: async () => {} });
    const e = (await c2.getRepo().catch((x: unknown) => x)) as GitHubError;
    expect(e.kind).toBe("network");
    expect(e.via).toBe("sign-in");
    expect(c2.tokenRejected).toBe(false);
    expect(explainError(e, "app")).toMatch(/sign-in service/);
  });

  it("no message ever carries the access or the refresh token", async () => {
    const leak = (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      return Promise.resolve(json(422, { message: `bad ${auth} and ${R1}` }));
    };
    const source = createAppTokenSource({ tokens: tokens(A1, R1), remember: false, fetch: relay(() => json(200, pair(A2, R2))).fetch, lock: passLock, store: store() });
    const client = createClient({ source, owner: "me", repo: "workspace", fetch: leak, sleep: async () => {} });
    const e = (await client.createBlob(new Uint8Array([1])).catch((x: unknown) => x)) as GitHubError;
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.message).toContain("[token]");
    for (const secret of [A1, R1]) expect(e.message).not.toContain(secret);
  });
});

describe("sealed app tokens", () => {
  it("round-trip encrypted under their own key and AAD; a PAT record is never read as app tokens", async () => {
    const t: AppTokens = { access: A1, accessExpiresAt: 123, refresh: R1, refreshExpiresAt: 456 };
    await rememberAppTokens(t);
    expect(await loadAppTokens()).toEqual(t);
    await rememberToken(TEST_TOKEN);
    expect(await loadToken()).toBe(TEST_TOKEN);
    expect(await loadAppTokens()).toEqual(t);
    const db = await openDB(SECRETS_DB, 1);
    const sealed = (await db.get("secrets", "app-tokens")) as { ct: ArrayBuffer; iv: Uint8Array };
    const key = (await db.get("secrets", "app-key")) as CryptoKey;
    // Swapping the PAT's ciphertext in can't decrypt (other key and AAD): the record is dropped.
    await db.put("secrets", await db.get("secrets", "pat"), "app-tokens");
    db.close();
    expect(key.extractable).toBe(false);
    const text = new TextDecoder("latin1").decode(sealed.ct);
    expect(text).not.toContain(A1);
    expect(text).not.toContain(R1);
    expect(await loadAppTokens()).toBeNull();
    expect(await loadToken()).toBe(TEST_TOKEN);
    await forgetAppTokens();
    expect(await loadAppTokens()).toBeNull();
  });

  it("each save makes a new key and IV", async () => {
    const t: AppTokens = { access: A1, accessExpiresAt: 1, refresh: R1, refreshExpiresAt: 2 };
    await rememberAppTokens(t);
    const db = await openDB(SECRETS_DB, 1);
    const first = (await db.get("secrets", "app-tokens")) as { iv: Uint8Array };
    db.close();
    await rememberAppTokens({ ...t, access: A2, refresh: R2 });
    const db2 = await openDB(SECRETS_DB, 1);
    const second = (await db2.get("secrets", "app-tokens")) as { iv: Uint8Array };
    db2.close();
    expect([...second.iv]).not.toEqual([...first.iv]);
    expect((await loadAppTokens())?.access).toBe(A2);
  });
});

describe("installations", () => {
  it("lists the account, the installations and their repositories (no repository twice)", async () => {
    const seen: string[] = [];
    const fetch: Fetch = async (u, init) => {
      seen.push(u);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${A1}`);
      expect(init.credentials).toBe("omit");
      if (u.endsWith("/user")) return json(200, { login: "student" });
      if (u.includes("/user/installations?")) return json(200, { total_count: 1, installations: [{ id: 9, account: { login: "student" }, html_url: "https://github.com/settings/installations/9" }, { id: 10, account: { login: "evil" }, html_url: "javascript:alert(1)" }] });
      if (u.includes("/user/installations/9/")) return json(200, { repositories: [{ id: 1, name: "code", owner: { login: "student" }, private: true, default_branch: "main" }, { id: 2, name: "../x", owner: { login: "student" }, private: true, default_branch: "main" }] });
      if (u.includes("/user/installations/10/")) return json(200, { repositories: [{ id: 1, name: "code", owner: { login: "student" }, private: true, default_branch: "main" }, { id: 3, name: "notes", owner: { login: "evil" }, private: false, default_branch: "trunk" }] });
      return json(404, {});
    };
    const reach = await listReachable(A1, fetch);
    expect(reach.login).toBe("student");
    expect(reach.installations).toEqual([
      { id: 9, account: "student", settingsUrl: "https://github.com/settings/installations/9" },
      { id: 10, account: "evil", settingsUrl: "https://github.com/settings/installations/10" },
    ]);
    expect(reach.repos.map((r) => `${r.owner}/${r.name} ${r.private} ${r.defaultBranch}`)).toEqual(["evil/notes false trunk", "student/code true main"]);
    expect(seen[0]).toBe("https://api.github.com/user");
  });

  it("GitHub's errors are GitHubErrors by kind", async () => {
    await expect(listReachable(A1, async () => json(401, { message: `token ${A1}` }))).rejects.toMatchObject({ kind: "auth", op: "getUser" });
    const e = (await listReachable(A1, async () => json(401, { message: `token ${A1}` })).catch((x: unknown) => x)) as GitHubError;
    expect(e.message).not.toContain(A1);
    await expect(listReachable(A1, async () => Promise.reject(new TypeError("x")))).rejects.toMatchObject({ kind: "network" });
  });
});

it("SignInError and TokenUnavailable carry fixed messages", () => {
  expect(new SignInError("network").message).toBe("sign-in failed: network");
  expect(new TokenUnavailable("auth").message).toBe("the GitHub sign-in has ended");
});
