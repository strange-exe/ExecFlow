// GitHub for the sync specs: src/sync/test-helpers.ts createFakeGitHub (the in-memory fake the sync
// engine's unit tests use: 409 on an empty repository, base_tree trees with sha:null deletes,
// force:false fast-forwards, ETag/304 on refs, raw blobs) served to the real page with page.route,
// so the app's own fetch calls, headers and CORS handling are what get tested.
import type { Page } from "@playwright/test";
import { createFakeGitHub, TEST_TOKEN, type FakeGitHubOptions } from "../src/sync/test-helpers";
import { expect, test, tolerating } from "./helpers";

// api.github.com's CORS answers, measured with curl on 2026-10-17 (an OPTIONS preflight and a GET).
const EXPOSE =
  "ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset";
const PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE",
  "access-control-allow-headers":
    "Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, GraphQL-Features, X-Github-Next-Global-ID, X-GitHub-Api-Version",
  "access-control-max-age": "86400",
  "access-control-expose-headers": EXPOSE,
};

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Playwright's WebKit refuses route.fulfill with status 304 ("Cannot fulfill with redirect status",
 * and the request then never settles), although WebKit itself passes a real 304 to fetch (measured
 * 2026-10-17 against a local server, with and without routing). There the fake answers a conditional read in full
 * (200 with the same ETag), which HTTP allows; the engine then reads the tree once more.
 */
export const CAN_ROUTE_304 = (engine: string) => engine !== "webkit";

export async function routeGitHub(page: Page, options: FakeGitHubOptions = {}) {
  const fake = createFakeGitHub(options);
  const seen: SeenRequest[] = [];
  const preflights: string[] = [];
  const full304 = !CAN_ROUTE_304(test.info().project.name);
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      preflights.push(req.url());
      return route.fulfill({ status: 204, headers: PREFLIGHT });
    }
    // HTTP/2 pseudo-headers (":authority") aren't header names fetch's Headers accepts.
    const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([name]) => !name.startsWith(":")));
    seen.push({ method: req.method(), url: req.url(), headers });
    const ask = (h: Record<string, string>) => fake.fetch(req.url(), { method: req.method(), headers: h, body: req.postData() ?? undefined });
    let res = await ask(headers);
    if (res.status === 304 && full304) {
      const { "if-none-match": _etag, ...rest } = headers;
      res = await ask(rest);
    }
    const out: Record<string, string> = { "access-control-allow-origin": "*", "access-control-expose-headers": EXPOSE };
    res.headers.forEach((value, name) => (out[name] = value));
    if (res.status === 304) return route.fulfill({ status: 304, headers: out });
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
  });
  return { fake, seen, preflights, token: TEST_TOKEN, owner: fake.owner, repo: fake.repo };
}

/**
 * Chromium reports every fetch answered 304 as a failed request (net::ERR_ABORTED), even from a
 * real server with no routing; fetch itself gets the 304 (same measurement). Only the branch read is
 * ever conditional, so only it is excused, and only with that error.
 */
const CHROMIUM_304 = /^request failed: https:\/\/api\.github\.com\/repos\/me\/workspace\/git\/ref\/heads\/main net::ERR_ABORTED$/;

/** test.use() options for a sync spec: the 304 note above plus any GitHub errors the test expects. */
export const syncNoise = (...expected: RegExp[]) => tolerating(CHROMIUM_304, ...expected);

export type GitHubRoute = Awaited<ReturnType<typeof routeGitHub>>;

/** A JSON answer for fake.interceptors (a revoked token, a rate limit, a server error). */
export function answer(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/**
 * The fixture fails a test on any HTTP status >= 400 and any console error. These are the exact
 * ones a test that expects GitHub to answer `status` at `path` may see: the response itself, and
 * the console line Chromium and WebKit print for it ("Failed to load resource: ... 409 ()").
 */
export function githubNoise(status: number, path = ""): RegExp[] {
  const url = `https://api\\.github\\.com/repos/me/workspace${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`;
  return [new RegExp(`^HTTP ${status}: ${url}$`), new RegExp(`^Failed to load resource: the server responded with a status of ${status}( \\(.*\\))?$`)];
}
/** An empty repository answers "Git Repository is empty" (409) to reading its branch. */
export const EMPTY_REPO = githubNoise(409, "/git/ref/heads/main");

export const syncStatus = (page: Page) => page.locator("#sync-status");
export const syncCount = async (page: Page) => Number((await syncStatus(page).getAttribute("data-syncs")) ?? 0);

/** Waits until sync number `after + 1` has finished, then for its state. */
export async function waitSync(page: Page, after: number, state: string, timeout = 30_000) {
  await expect.poll(() => syncCount(page), { timeout }).toBeGreaterThan(after);
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", state, { timeout });
}

export interface ConnectOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  remember?: boolean;
  /** Leave the dialog open after pressing Connect (to check an error or a warning). */
  expectError?: boolean;
}

/** Opens the Connect dialog from the top bar's status and fills it in. */
export async function openConnect(page: Page) {
  await syncStatus(page).click();
  const dialog = page.locator("#connect-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function fillConnect(page: Page, o: ConnectOptions) {
  await page.locator("#connect-owner").fill(o.owner ?? "me");
  await page.locator("#connect-repo").fill(o.repo ?? "workspace");
  if (o.branch !== undefined) await page.locator("#connect-branch").fill(o.branch);
  await page.locator("#connect-token").fill(o.token ?? TEST_TOKEN);
  if (o.remember) await page.locator("#connect-remember").check();
}

export async function connectGitHub(page: Page, o: ConnectOptions = {}) {
  const dialog = await openConnect(page);
  await fillConnect(page, o);
  await page.locator("#connect-submit").click();
  if (!o.expectError) await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  return dialog;
}

const SAVE = process.platform === "darwin" ? "Meta+S" : "Control+S";
export const saveKey = (page: Page) => page.keyboard.press(SAVE);

/** The token must not be anywhere in the page, its URL or its storage once the field is cleared. */
export async function expectNoToken(page: Page, gh: GitHubRoute) {
  expect(await page.content()).not.toContain(gh.token);
  expect(page.url()).not.toContain(gh.token);
  const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n"));
  expect(values).not.toContain(gh.token);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(gh.token);
  for (const r of gh.seen) {
    expect(r.url).not.toContain(gh.token);
    // ... and it travelled only as the Authorization header.
    expect(r.headers.authorization).toBe(`Bearer ${gh.token}`);
    expect(Object.entries(r.headers).filter(([name, v]) => name !== "authorization" && v.includes(gh.token))).toEqual([]);
  }
}

// ---------------------------------------------------------------- "Sign in with GitHub"
// The sign-in relay (/api/auth/*, a Cloudflare Pages Function that `vite preview` doesn't run) and
// GitHub's authorize page, both served with page.route: the tests never reach real GitHub. The
// authorize page is a stand-in document (not a redirect: Playwright's WebKit refuses to fulfill
// one), so a test reads the state from its URL and then opens /auth-callback itself, in the same tab.

export const APP = { clientId: "Iv23liFAKEclient01", appSlug: "codeeditor-sync" };
/** Fake GitHub App tokens (ghu_ access, ghr_ refresh), never real ones. */
export const GHU1 = "ghu_FAKEaccessONE0123456789abcdefghij";
export const GHU2 = "ghu_FAKEaccessTWO0123456789abcdefghij";
export const GHR1 = "ghr_FAKErefreshONE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
export const GHR2 = "ghr_FAKErefreshTWO0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
export const tokenPair = (access: string, refresh: string) => ({ access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600 });

export interface RelayCall {
  route: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private?: boolean;
}

export interface SignInOptions {
  /** /api/auth/config: the relay's JSON (default), its 404, or nothing routed (the app's own page answers). */
  config?: "available" | "404" | "none";
  /** Answers per route (default: a token pair for token and refresh, 204 for revoke). */
  answer?: Partial<Record<"token" | "refresh" | "revoke", (call: RelayCall) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>>>;
  /** What GET /user/installations/{id}/repositories lists (default: me/workspace). */
  repos?: FakeRepo[];
  login?: string;
}

/** Routes the relay, GitHub's authorize page and the account endpoints. Call after routeGitHub. */
export async function routeSignIn(page: Page, o: SignInOptions = {}) {
  const calls: RelayCall[] = [];
  const authorize: string[] = [];
  let repos = o.repos ?? [{ id: 4242, owner: "me", name: "workspace" }];
  const userCalls: string[] = [];
  if ((o.config ?? "available") !== "none") {
    await page.route("**/api/auth/config", (route) =>
      o.config === "404" ? route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_configured"}' }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(APP) }),
    );
  }
  for (const name of ["token", "refresh", "revoke"] as const) {
    await page.route(`**/api/auth/${name}`, async (route) => {
      const req = route.request();
      const call: RelayCall = { route: name, method: req.method(), body: JSON.parse(req.postData() ?? "{}"), headers: await req.allHeaders() };
      calls.push(call);
      const fallback = name === "revoke" ? { status: 204 } : { status: 200, body: name === "token" ? tokenPair(GHU1, GHR1) : tokenPair(GHU2, GHR2) };
      const out = (await o.answer?.[name]?.(call)) ?? fallback;
      await route.fulfill({ status: out.status, contentType: "application/json", body: out.body === undefined ? "" : JSON.stringify(out.body) });
    });
  }
  await page.route("https://github.com/login/oauth/authorize**", (route) => {
    authorize.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>GitHub stand-in</title><p>Authorize CodeEditor (test stand-in)</p>" });
  });
  // The account endpoints (registered after routeGitHub's catch-all, so these win).
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" };
  await page.route(/^https:\/\/api\.github\.com\/user(\/installations.*|\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Authorization, X-GitHub-Api-Version", "access-control-allow-methods": "GET" } });
    const url = new URL(req.url());
    userCalls.push(`${url.pathname} ${req.headers().authorization ?? ""}`);
    if (url.pathname === "/user") return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ login: o.login ?? "me" }) });
    if (url.pathname === "/user/installations") {
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ total_count: 1, installations: [{ id: 77, account: { login: o.login ?? "me" }, html_url: "https://github.com/settings/installations/77", app_slug: APP.appSlug }] }) });
    }
    const list = repos.map((r) => ({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner }, private: r.private ?? true, default_branch: "main" }));
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ total_count: list.length, repositories: list }) });
  });
  return {
    calls,
    authorize,
    userCalls,
    setRepos(next: FakeRepo[]) {
      repos = next;
    },
    /** The state and PKCE challenge of the last trip to GitHub. */
    lastAuthorize() {
      const url = new URL(authorize.at(-1)!);
      return { url, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")! };
    },
  };
}

export type SignInRoute = Awaited<ReturnType<typeof routeSignIn>>;

/** Presses Sign in with GitHub and waits for the stand-in authorize page; returns its state. */
export async function goToGitHub(page: Page, si: SignInRoute, o: { remember?: boolean } = {}) {
  const open = page.locator("#connect-dialog");
  const dialog = (await open.isVisible()) ? open : await openConnect(page);
  await expect(dialog).toHaveAttribute("data-view", "start");
  if (o.remember === false) await page.locator("#connect-signin-remember").uncheck();
  await page.locator("#connect-signin").click();
  await page.waitForURL(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  return si.lastAuthorize();
}

/** The full round trip: GitHub sends the student back with `code`, and the repository list shows. */
export async function signInAndPick(page: Page, si: SignInRoute, o: { remember?: boolean; view?: "pick" | "pick-empty" } = {}) {
  const { state } = await goToGitHub(page, si, o);
  await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
  const dialog = page.locator("#connect-dialog");
  await expect(dialog).toHaveAttribute("data-state", o.view ?? "pick", { timeout: 30_000 });
  return dialog;
}

/** What the sign-in stored: whether the sealed record exists and whether a token shows in clear. */
export async function appSecrets(page: Page, tokens: string[]) {
  return page.evaluate(async (ts) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor-secrets", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("secrets");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const get = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const r = db.transaction("secrets").objectStore("secrets").get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const [key, sealed] = (await Promise.all([get("app-key"), get("app-tokens")])) as [unknown, { ct?: ArrayBuffer } | undefined];
    db.close();
    const text = sealed?.ct ? new TextDecoder("latin1").decode(sealed.ct) : "";
    return { hasKey: key instanceof CryptoKey, extractable: key instanceof CryptoKey ? key.extractable : null, hasTokens: Boolean(sealed?.ct), clear: ts.some((t) => text.includes(t)) };
  }, tokens);
}

/** What "Remember on this computer" stored: the records' names, and whether the token shows in clear. */
export async function secrets(page: Page, token: string) {
  return page.evaluate(async (t) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor-secrets", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("secrets");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const get = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const r = db.transaction("secrets").objectStore("secrets").get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const [key, pat] = await Promise.all([get("key"), get("pat")]);
    db.close();
    const sealed = pat as { ct?: ArrayBuffer; iv?: Uint8Array } | undefined;
    const clear = sealed?.ct ? new TextDecoder("latin1").decode(sealed.ct).includes(t) || JSON.stringify(sealed).includes(t) : false;
    return {
      hasKey: key instanceof CryptoKey,
      extractable: key instanceof CryptoKey ? key.extractable : null,
      hasToken: Boolean(sealed?.ct),
      clear,
    };
  }, token);
}
