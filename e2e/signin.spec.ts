// "Sign in with GitHub" (a GitHub App, web flow with PKCE and state) end to end. The relay
// (/api/auth/*), GitHub's authorize page and api.github.com are all page.route fakes
// (e2e/sync-fake.ts): no test ever reaches real GitHub. Waits are on data-state, data-view and
// data-sync-state, never on wording; the relay's recorded calls and the fake's files are the proof.
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, reloadApp, test, tolerating, treeItem, waitReady } from "./helpers";
import {
  APP,
  appSecrets,
  connectGitHub,
  EMPTY_REPO,
  GHR1,
  GHR2,
  GHU1,
  GHU2,
  goToGitHub,
  openConnect,
  routeGitHub,
  routeSignIn,
  saveKey,
  signInAndPick,
  syncCount,
  syncStatus,
  tokenPair,
  waitSync,
  type GitHubRoute,
  type SignInRoute,
} from "./sync-fake";

// Reloads and navigations right after the first load: the service worker is not what these test,
// and Playwright doesn't route requests a service worker handles.
test.use({ serviceWorkers: "block" });

/** Chromium reports every fetch answered 304 as a failed request (sync-fake.ts CHROMIUM_304). */
const CHROMIUM_304 = /^request failed: https:\/\/api\.github\.com\/repos\/me\/workspace\/git\/ref\/heads\/main net::ERR_ABORTED$/;
/** The console line Chromium and WebKit print for a fetch answered `status`. */
const loadFailed = (status: number) => new RegExp(`^Failed to load resource: the server responded with a status of ${status}( \\(.*\\))?$`);
test.use(tolerating(CHROMIUM_304));

const ALL_TOKENS = [GHU1, GHU2, GHR1, GHR2];

/** No token anywhere a page could leak it: DOM, attributes, field values, storage, URL, history. */
async function expectNoAppToken(page: Page) {
  const found = await page.evaluate((tokens) => {
    const where: string[] = [];
    const text = document.documentElement.outerHTML + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n");
    const stores = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const t of tokens) {
      if (text.includes(t)) where.push(`DOM ${t.slice(0, 8)}`);
      if (stores.includes(t)) where.push(`storage ${t.slice(0, 8)}`);
      if (location.href.includes(t) || JSON.stringify(history.state).includes(t)) where.push(`URL ${t.slice(0, 8)}`);
    }
    return where;
  }, ALL_TOKENS);
  expect(found).toEqual([]);
}

async function setUp(page: Page, o: Parameters<typeof routeSignIn>[1] = {}, token = GHU1) {
  const gh = await routeGitHub(page, { token });
  await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
  const si = await routeSignIn(page, o);
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  await openApp(page);
  return { gh, si, consoleText };
}

/** Signs in, picks me/workspace (the only one) and waits for the first sync. */
async function signedIn(page: Page, gh: GitHubRoute, si: SignInRoute, o: { remember?: boolean } = {}) {
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
  const n = await syncCount(page);
  await signInAndPick(page, si, o);
  await page.locator("#connect-submit").click();
  await expect(page.locator("#connect-dialog")).toHaveCount(0, { timeout: 30_000 });
  await waitSync(page, n, "synced");
  return gh;
}

test.describe("signing in", () => {
  test("the round trip: S256 PKCE and state, the code leaves the URL at once, a ghu_ token syncs, nothing leaks", async ({ page, baseURL }) => {
    const { gh, si, consoleText } = await setUp(page);
    await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
    const n = await syncCount(page);

    const dialog = await openConnect(page);
    await expect(dialog).toHaveAttribute("data-view", "start");
    await expect(page.locator("#connect-signin")).toBeFocused();
    await expect(page.locator("#connect-token-panel")).toBeHidden();
    await expect(page.locator("#connect-use-token")).toHaveAttribute("aria-expanded", "false");
    // The owner's choice (2026-10-24): Remember on this device starts off, as on the token path (lab PCs).
    await expect(page.locator("#connect-signin-remember")).not.toBeChecked();
    await expect(page.locator("label[for=connect-signin-remember]")).toHaveText("Remember on this device");
    await expect(page.locator("label[for=connect-remember]")).toHaveText("Remember on this device");

    const { url, state, challenge } = await goToGitHub(page, si, { remember: true });
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/auth-callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(si.calls).toEqual([]);

    await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
    await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "pick", { timeout: 30_000 });
    // The code is gone from the address bar and from this history entry.
    expect(await page.evaluate(() => ({ path: location.pathname, href: location.href, state: history.state }))).toEqual({ path: "/", href: `${baseURL}/`, state: null });
    // Exactly one exchange, with the PKCE verifier whose S256 is the challenge GitHub saw.
    expect(si.calls.map((c) => c.route)).toEqual(["token"]);
    const verifier = String(si.calls[0].body.code_verifier);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(si.calls[0].body).toEqual({ code: "fakecode0123456789", code_verifier: verifier });
    expect(si.calls[0].headers.origin).toBe(baseURL);
    expect(si.calls[0].headers["content-type"]).toBe("application/json");
    // The one-time record is gone once read.
    expect(await page.evaluate(() => sessionStorage.getItem("codeeditor:sign-in"))).toBeNull();

    await expect(page.locator("#connect-signin-who")).toHaveText("Signed in as @me.");
    await expect(page.locator("#connect-pick-0")).toBeChecked();
    await expect(page.locator("#connect-pick-0")).toBeFocused();
    await expect(page.locator("#connect-pick-many")).toHaveCount(0);
    await page.locator("#connect-submit").click();
    await expect(page.locator("#connect-dialog")).toHaveCount(0, { timeout: 30_000 });
    await waitSync(page, n, "synced");
    // Sync went straight to api.github.com with the ghu_ token, only in the Authorization header.
    const repoCalls = gh.seen.filter((r) => r.url.includes("/repos/me/workspace"));
    expect(repoCalls.length).toBeGreaterThan(1);
    for (const r of repoCalls) expect(r.headers.authorization).toBe(`Bearer ${GHU1}`);
    for (const r of gh.seen) expect(r.url).not.toContain("ghu_");

    // Remember on: sealed, never in clear.
    expect(await appSecrets(page, ALL_TOKENS)).toEqual({ hasKey: true, extractable: false, hasTokens: true, clear: false });
    await expectNoAppToken(page);
    expect(consoleText.filter((t) => ALL_TOKENS.some((x) => t.includes(x)) || t.includes("fakecode0123456789"))).toEqual([]);

    // A reload syncs by itself with the remembered sign-in.
    await reloadApp(page);
    await waitSync(page, 0, "synced");
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "synced");
  });

  test("Remember off: nothing is stored, and a reload asks to sign in again", async ({ page }) => {
    const { gh, si } = await setUp(page);
    // Off by default: the sign-in is kept for this tab only.
    await signedIn(page, gh, si);
    expect((await appSecrets(page, ALL_TOKENS)).hasTokens).toBe(false);
    await reloadApp(page);
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "needs-token");
    await expect(syncStatus(page)).toHaveAttribute("aria-label", /^Sign in again\. Sign in with GitHub to sync$/);
  });

  test("a callback whose state doesn't match is ignored: nothing is sent", async ({ page }) => {
    const { si } = await setUp(page);
    await goToGitHub(page, si);
    await page.goto(`/auth-callback?code=fakecode0123456789&state=${"x".repeat(43)}`);
    const dialog = page.locator("#connect-dialog");
    await expect(dialog).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
    await expect(page.locator("#connect-signin-result")).toContainText("wasn't started in this tab");
    await expect(page.locator("#connect-signin-result")).toHaveAttribute("data-tone", "error");
    expect(si.calls).toEqual([]);
    expect(await page.evaluate(() => location.pathname + location.search)).toBe("/");
    // The record was used up: the right state now finds nothing either.
    const { state } = si.lastAuthorize();
    await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
    await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
    expect(si.calls).toEqual([]);
  });

  test("a callback with no sign-in started in this tab (a planted link) is ignored: nothing is sent", async ({ page }) => {
    const { si } = await setUp(page);
    await page.goto(`/auth-callback?code=fakecode0123456789&state=${"s".repeat(43)}`);
    await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
    await expect(page.locator("#connect-signin-result")).toContainText("wasn't started in this tab");
    expect(si.calls).toEqual([]);
  });

  test("cancelled on GitHub (error=access_denied): says so, and Sign in is there again", async ({ page }) => {
    const { si } = await setUp(page);
    const { state } = await goToGitHub(page, si);
    await page.goto(`/auth-callback?error=access_denied&error_description=The+user+has+denied&state=${state}`);
    await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
    await expect(page.locator("#connect-signin-result")).toContainText("cancelled on GitHub");
    await expect(page.locator("#connect-signin")).toBeFocused();
    expect(si.calls).toEqual([]);
  });

  test.describe("the relay refuses the code", () => {
    test.use(tolerating(CHROMIUM_304, /^HTTP 400: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/token$/, loadFailed(400)));
    test("an expired code says sign in again", async ({ page }) => {
      const { si } = await setUp(page, { answer: { token: () => ({ status: 400, body: { error: "bad_verification_code" } }) } });
      const { state } = await goToGitHub(page, si);
      await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
      await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
      await expect(page.locator("#connect-signin-result")).toContainText("expired or was already used");
      await expect(page.locator("#connect-token-panel")).toBeHidden();
    });
  });

  test.describe("the relay is misconfigured", () => {
    test.use(tolerating(CHROMIUM_304, /^HTTP 502: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/token$/, loadFailed(502)));
    test("sign-in unavailable opens the token form beside the message", async ({ page }) => {
      const { si } = await setUp(page, { answer: { token: () => ({ status: 502, body: { error: "incorrect_client_credentials" } }) } });
      const { state } = await goToGitHub(page, si);
      await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
      await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
      await expect(page.locator("#connect-signin-result")).toContainText("use a token instead");
      await expect(page.locator("#connect-token-panel")).toBeVisible();
      await expect(page.locator("#connect-use-token")).toHaveAttribute("aria-expanded", "true");
    });
  });
});

test.describe("no sign-in relay on this site", () => {
  test.use(tolerating(CHROMIUM_304, ...EMPTY_REPO));
  test("the app's own page answers /api/auth/config (vite preview, a fork): today's token dialog, and it connects", async ({ page }) => {
    const gh = await routeGitHub(page);
    await routeSignIn(page, { config: "none" });
    await openApp(page);
    const n = await syncCount(page);
    const dialog = await connectGitHub(page);
    await expect(dialog).toHaveCount(0);
    await waitSync(page, n, "synced");
    expect(gh.fake.files()).toEqual({});
  });

  test.describe("the relay answers 404 (not set up)", () => {
    test.use(tolerating(CHROMIUM_304, /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/config$/, loadFailed(404)));
    test("no Sign in button; the token form shows and works", async ({ page }) => {
      await routeGitHub(page);
      await routeSignIn(page, { config: "404" });
      await openApp(page);
      const dialog = await openConnect(page);
      await expect(page.locator("#connect-signin")).toHaveCount(0);
      await expect(page.locator("#connect-use-token")).toHaveCount(0);
      await expect(page.locator("#connect-owner")).toBeVisible();
      await expect(page.locator("#connect-owner")).toBeFocused();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  });
});

test.describe("the repository list", () => {
  test("several repositories: none chosen for you, a warning with a link to change it on GitHub", async ({ page }) => {
    const { si } = await setUp(page, { repos: [{ id: 1, owner: "me", name: "notes", private: false }, { id: 4242, owner: "me", name: "workspace" }] });
    await signInAndPick(page, si);
    await expect(page.locator("#connect-pick-many")).toContainText("CodeEditor can reach 2 repositories");
    const link = page.locator("#connect-pick-many a");
    await expect(link).toHaveAttribute("href", "https://github.com/settings/installations/77");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator("#connect-pick-list input:checked")).toHaveCount(0);
    await page.locator("#connect-submit").click();
    await expect(page.locator("#connect-signin-result")).toContainText("Choose the repository");
    await expect(page.locator("#connect-pick-0")).toBeFocused();
    // A public repository asks first, as the token form does.
    await page.locator("label[for=connect-pick-0]").click();
    await expect(page.locator("#connect-pick-0-note")).toHaveText("Public: anyone can read the code in it");
  });

  test("no repository yet: choose one on GitHub, then Check again lists it", async ({ page }) => {
    const { si } = await setUp(page, { repos: [] });
    await signInAndPick(page, si, { view: "pick-empty" });
    const install = page.locator("#connect-install");
    await expect(install).toBeFocused();
    await expect(install).toHaveAttribute("href", `https://github.com/apps/${APP.appSlug}/installations/new`);
    await expect(install).toHaveAttribute("rel", "noopener noreferrer");
    // A student with no repository at all is shown where to make one first (a fixed link, private chosen).
    const create = page.locator("#connect-signin-new-repo").getByRole("link", { name: /Create a private one on GitHub/ });
    await expect(page.locator("#connect-signin-new-repo")).toContainText("No repository yet?");
    await expect(create).toHaveAttribute("href", "https://github.com/new?visibility=private");
    await expect(create).toHaveAttribute("target", "_blank");
    await expect(create).toHaveAttribute("rel", "noopener noreferrer");
    si.setRepos([{ id: 4242, owner: "me", name: "workspace" }]);
    await page.locator("#connect-recheck").click();
    await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "pick");
    await expect(page.locator("#connect-pick-0")).toBeChecked();
  });

  test("closing the dialog after signing in, without connecting, revokes the unused token", async ({ page }) => {
    const { si } = await setUp(page);
    await signInAndPick(page, si);
    await page.keyboard.press("Escape");
    await expect(page.locator("#connect-dialog")).toHaveCount(0);
    await expect.poll(() => si.calls.filter((c) => c.route === "revoke").map((c) => c.body)).toEqual([{ access_token: GHU1 }]);
  });
});

test.describe("an 8-hour token", () => {
  test.use(tolerating(CHROMIUM_304, /^HTTP 401: https:\/\/api\.github\.com\/repos\/me\/workspace(\/.*)?$/, loadFailed(401)));

  test("expires mid-sync: exactly one refresh, the request is retried, and the sync finishes", async ({ page }) => {
    const { gh, si } = await setUp(page);
    await signedIn(page, gh, si, { remember: true });
    gh.fake.rejectToken(GHU1);
    gh.fake.acceptToken(GHU2);
    await page.locator(".cm-content").click();
    await page.keyboard.type("# more\n");
    const n = await syncCount(page);
    await saveKey(page);
    await waitSync(page, n, "synced");
    expect(si.calls.filter((c) => c.route === "refresh").map((c) => c.body)).toEqual([{ refresh_token: GHR1 }]);
    expect(gh.fake.files()["main.py"]).toContain("# more");
    // The rotated pair was sealed again; neither pair shows in clear.
    expect(await appSecrets(page, ALL_TOKENS)).toMatchObject({ hasTokens: true, clear: false });
    await expectNoAppToken(page);
  });

  test.describe("and the refresh token is refused", () => {
    test.use(tolerating(CHROMIUM_304, /^HTTP 401: https:\/\/api\.github\.com\/repos\/me\/workspace(\/.*)?$/, loadFailed(401), /^HTTP 400: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/refresh$/, loadFailed(400)));
    test("Sign in again; the local files stay; the sealed record is gone", async ({ page }) => {
      const { gh, si } = await setUp(page, { answer: { refresh: () => ({ status: 400, body: { error: "bad_refresh_token" } }) } });
      await signedIn(page, gh, si, { remember: true });
      gh.fake.rejectToken(GHU1);
      await page.locator(".cm-content").click();
      await page.keyboard.type("# kept\n");
      const n = await syncCount(page);
      await saveKey(page);
      await waitSync(page, n, "needs-token");
      await expect(syncStatus(page)).toHaveAttribute("aria-label", /^Sign in again\./);
      await expect(page.locator(".notice")).toContainText("sign in again");
      expect(si.calls.filter((c) => c.route === "refresh")).toHaveLength(1);
      expect((await appSecrets(page, ALL_TOKENS)).hasTokens).toBe(false);
      await expect(page.locator(".cm-content")).toContainText("# kept");
      await expect(treeItem(page, "main.py")).toHaveCount(1);
      // The status opens the dialog on Sign in, saying why.
      await syncStatus(page).click();
      await expect(page.locator("#connect-dialog")).toHaveAttribute("data-view", "start");
      await expect(page.locator("#connect-signin-result")).toContainText("has ended");
    });
  });
});

test.describe("signing out", () => {
  test("Disconnect revokes this token only and forgets it here", async ({ page }) => {
    const { gh, si } = await setUp(page);
    await signedIn(page, gh, si, { remember: true });
    await page.locator("#settings-button").click();
    await page.locator("#settings-disconnect").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
    expect(si.calls.filter((c) => c.route === "revoke").map((c) => c.body)).toEqual([{ access_token: GHU1 }]);
    expect((await appSecrets(page, ALL_TOKENS)).hasTokens).toBe(false);
  });

  test("Clear this computer in another tab: this tab ends its own sign-in and keeps no files and no token", async ({ page, context }) => {
    // Two workbenches, a sign-in round trip and a reload (as multitab-edge and security-sync do).
    test.setTimeout(120_000);
    const { gh, si } = await setUp(page);
    // Remember off: the pair lives only in this tab's memory, where the clearing tab can't reach it.
    await signedIn(page, gh, si, { remember: false });
    await expect(page.locator("#app")).toHaveAttribute("data-role", "writer");

    const other = await context.newPage();
    // The clearing tab has no sign-in of its own: it never needs GitHub or the relay.
    const otherSent: string[] = [];
    for (const url of [/^https:\/\/api\.github\.com\//, "**/api/auth/**"]) {
      await other.route(url, (route) => {
        otherSent.push(route.request().url());
        return route.abort();
      });
    }
    await openApp(other);
    await expect(other.locator("#app")).toHaveAttribute("data-role", "reader");
    await expect(treeItem(other, "main.py")).toBeVisible();
    // This tab deletes the secrets database too, once its own sign-in has ended (a seal it was
    // writing could otherwise make the database again after the clearing tab's delete).
    await page.evaluate(() => {
      const w = window as unknown as { deleted: string[] };
      w.deleted = [];
      // On the prototype: in WebKit a wrapper set on the indexedDB object itself saw no call.
      const del = IDBFactory.prototype.deleteDatabase;
      IDBFactory.prototype.deleteDatabase = function (this: IDBFactory, name: string) {
        w.deleted.push(name);
        return del.call(this, name);
      };
    });
    // A dialog left open in the first tab (it lives on document.body, outside #app) must go too.
    await page.locator("#settings-button").click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await other.locator("#settings-button").click();
    await other.locator("#sign-out-clear").click();
    const reloaded = other.waitForEvent("framenavigated", { timeout: 30_000 });
    await other.getByRole("alertdialog").getByRole("button", { name: "Clear this computer" }).click();
    await reloaded;
    await waitReady(other);

    // The first tab: its sign-in revoked (it was the only one holding that pair), and nothing left.
    await expect(page.locator("#app")).toHaveAttribute("data-state", "cleared", { timeout: 30_000 });
    expect(si.calls.filter((c) => c.route === "revoke").map((c) => c.body)).toEqual([{ access_token: GHU1 }]);
    await expect(page.locator(".tree [role=treeitem]")).toHaveCount(0);
    await expect(page.locator(".cm-editor")).toHaveCount(0);
    await expectNoAppToken(page);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    // The page keeps no way back in but Reload, which opens the cleared (empty) workspace.
    await expect(page.locator("#app button")).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { deleted: string[] }).deleted)).toEqual(["codeeditor-secrets"]);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    // Nor do the app's own keys: the palette (Ctrl+P, F1) would list the last student's files.
    // (F1 and Ctrl+Shift+P take the same path as Ctrl+P.) Typed into the palette if it opened.
    await page.locator("body").press("ControlOrMeta+p");
    await page.waitForTimeout(2000);
    await page.keyboard.type("main");
    await page.waitForTimeout(500);
    await expect(page.getByText("main.py")).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0);

    // The clearing tab started again from nothing, and never sent anything.
    await expect(other.locator(".tree [role=treeitem]")).toHaveCount(0);
    expect((await appSecrets(other, ALL_TOKENS)).hasTokens).toBe(false);
    expect(otherSent).toEqual([]);
    await other.close();
  });

  test("Clear this computer in another tab while this tab's sign-in is still being exchanged: the late pair is revoked, never used", async ({ page, context }) => {
    test.setTimeout(120_000);
    // GitHub's answer to the code is held until the other tab has cleared this computer.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { si } = await setUp(page, { answer: { token: async () => (await held, { status: 200, body: tokenPair(GHU1, GHR1) }) } });
    const { state } = await goToGitHub(page, si);
    await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
    await expect.poll(() => si.calls.filter((c) => c.route === "token").length, { timeout: 30_000 }).toBe(1);

    const other = await context.newPage();
    await openApp(other);
    await other.locator("#settings-button").click();
    await other.locator("#sign-out-clear").click();
    const reloaded = other.waitForEvent("framenavigated", { timeout: 30_000 });
    await other.getByRole("alertdialog").getByRole("button", { name: "Clear this computer" }).click();
    await reloaded;
    await waitReady(other);
    await expect(page.locator("#app")).toHaveAttribute("data-state", "cleared", { timeout: 30_000 });

    const userCalls = si.userCalls.length;
    release();
    // The pair that arrives after the sign-out is ended on GitHub, and never sent there to list anything.
    await expect.poll(() => si.calls.filter((c) => c.route === "revoke").map((c) => c.body), { timeout: 15_000 }).toEqual([{ access_token: GHU1 }]);
    await page.waitForTimeout(1000);
    expect(si.userCalls.slice(userCalls)).toEqual([]);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await expectNoAppToken(page);
    await other.close();
  });

  test.describe("offline", () => {
    // The aborted revoke is this test's own doing (same-origin, so no CORS line in Firefox).
    test.use(tolerating(CHROMIUM_304, /^request failed: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/revoke \S.*$/, /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/));
    test("Disconnect while the relay can't be reached still forgets it here and says how to end it on GitHub", async ({ page }) => {
      const { gh, si } = await setUp(page);
      await signedIn(page, gh, si, { remember: true });
      await page.unroute("**/api/auth/revoke");
      await page.route("**/api/auth/revoke", (route) => route.abort("internetdisconnected"));
      await page.locator("#settings-button").click();
      await page.locator("#settings-disconnect").click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
      await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
      await expect(page.locator(".notice")).toContainText("within 8 hours");
      expect((await appSecrets(page, ALL_TOKENS)).hasTokens).toBe(false);
    });
  });

  test("offline when the dialog opens: it says so, and Sign in doesn't leave the page", async ({ page, context }) => {
    const { si } = await setUp(page);
    // A file open first: the editor chunk then loads online (the empty workspace prefetches it on hover).
    await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
    await expect(page.locator(".cm-content")).toBeVisible();
    // Python ready first: main.ts then loads the service-worker helper chunk, online.
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    let dialog = await openConnect(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    dialog = await openConnect(page);
    await expect(page.locator("#connect-signin-result")).toContainText("offline");
    await page.locator("#connect-signin").click();
    await expect(dialog).toHaveAttribute("data-state", "signin-failed");
    await expect(page.locator("#connect-signin-result")).toContainText("offline");
    expect(si.authorize).toEqual([]);
    await context.setOffline(false);
  });
});
