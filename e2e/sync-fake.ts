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
