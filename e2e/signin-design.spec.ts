// Every state of the Connect dialog's sign-in (design: .claude/design/signin.md section 4) in the
// DESIGN.md section 6 Level 2 matrix: 1440x900 and 390x844, light and dark. Each state is set up
// once, then for each size and scheme: the scheme is proven active, no horizontal scroll, axe WCAG
// 2.2 AA has no violations, and a screenshot is kept for review (plus gray and blur shots of the
// two key views). Relay, GitHub and api.github.com are page.route fakes (e2e/sync-fake.ts).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, openApp, reloadApp, test, tolerating } from "./helpers";
import { goToGitHub, openConnect, routeGitHub, routeSignIn, signInAndPick, syncCount, syncStatus, waitSync, type SignInOptions } from "./sync-fake";

test.use({ serviceWorkers: "block" });
const CHROMIUM_304 = /^request failed: https:\/\/api\.github\.com\/repos\/me\/workspace\/git\/ref\/heads\/main net::ERR_ABORTED$/;
test.use(tolerating(CHROMIUM_304));

const SHOTS = process.env.SHOTS_DIR ?? "e2e/shots";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

/** Shoots the open dialog in all four variants; `key` views also get gray and blur shots. */
async function matrix(page: Page, state: string, key = false) {
  const engine = test.info().project.name;
  const dialog = page.locator("#connect-dialog");
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${state} ${size.name} ${scheme}: no horizontal scroll`).toBe(true);
      // Nothing in the dialog is wider than the dialog.
      const wide = await dialog.evaluate((d) => {
        const box = d.getBoundingClientRect();
        return [...d.querySelectorAll<HTMLElement>("*")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > box.right + 1).map((e) => e.id || e.className);
      });
      expect(wide, `${state} ${size.name}: content wider than the dialog`).toEqual([]);
      const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(result.violations.map((v) => `${state} ${size.name} ${scheme}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
      const base = `${SHOTS}/signin/${engine}/${state}-${size.name}-${scheme}`;
      await page.screenshot({ path: `${base}.png`, animations: "disabled" });
      if (key && size.name === "desktop") await hierarchyShots(page, base);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

async function setUp(page: Page, o: SignInOptions = {}) {
  const gh = await routeGitHub(page, { token: "ghu_FAKEaccessONE0123456789abcdefghij" });
  await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
  const si = await routeSignIn(page, o);
  await openApp(page);
  return { gh, si };
}

test("A, signed out: Sign in with GitHub leads; the token form waits behind its button", async ({ page }) => {
  await setUp(page);
  await openConnect(page);
  await expect(page.locator("#connect-signin")).toBeFocused();
  // Keyboard path: Sign in, the note's Privacy link (what is sent to GitHub), Remember, Use a token
  // instead, then Cancel (Connect is hidden until the form opens). Safari leaves links out of the Tab
  // order unless "Press Tab to highlight each item" is on, and Playwright's WebKit differs by platform
  // (share-design.spec.ts): whether the link is a stop is read from the browser.
  await page.keyboard.press("Tab");
  const linksAreStops = await page.locator("#connect-signin-note a").evaluate((a) => a === document.activeElement);
  if (!linksAreStops) expect(test.info().project.name, "only WebKit may skip the link").toBe("webkit");
  if (linksAreStops) await page.keyboard.press("Tab");
  await expect(page.locator("#connect-signin-remember")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#connect-use-token")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(page.locator("#connect-submit")).toBeHidden();
  // The shots show the dialog as it opens (focus on Sign in).
  await page.locator("#connect-signin").focus();
  await matrix(page, "a-signed-out", true);
});

test("A, the token form opened: Sign in steps back to the outline style", async ({ page }) => {
  await setUp(page);
  await openConnect(page);
  await page.locator("#connect-use-token").click();
  await expect(page.locator("#connect-use-token")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#connect-owner")).toBeFocused();
  await expect(page.locator("#connect-signin")).not.toHaveClass(/\bprimary\b/);
  await expect(page.locator("#connect-submit")).toBeVisible();
  await matrix(page, "a-token-open");
});

test("a filled button's fill changes with its label, in the same frame: on a theme switch and when Sign in steps back", async ({ page }) => {
  await setUp(page);
  await openConnect(page);
  // Read in the same task as the change: a transition would still report the old fill.
  const sameFrame = (id: string, change: string) =>
    page.evaluate(
      ([id, change]) =>
        new Promise<{ now: string; later: string }>((resolve) => {
          const b = document.getElementById(id)!;
          const html = document.documentElement;
          const from = html.dataset.theme!;
          if (change === "theme") html.dataset.theme = from === "dark" ? "light" : "dark";
          else document.getElementById("connect-use-token")!.click();
          const now = getComputedStyle(b).backgroundColor;
          setTimeout(() => {
            const later = getComputedStyle(b).backgroundColor;
            if (change === "theme") html.dataset.theme = from;
            resolve({ now, later });
          }, 400);
        }),
      [id, change],
    );
  const signin = await sameFrame("connect-signin", "theme");
  expect(signin.now, "Sign in on a theme switch").toBe(signin.later);
  const back = await sameFrame("connect-signin", "token");
  expect(back.now, "Sign in stepping back to outline").toBe(back.later);
  await expect(page.locator("#connect-signin")).not.toHaveClass(/\bprimary\b/);
  const submit = await sameFrame("connect-submit", "theme");
  expect(submit.now, "Connect on a theme switch").toBe(submit.later);
});

test("redirecting: Going to GitHub", async ({ page }) => {
  // The page is held just before it leaves: the PKCE digest waits for the test. (Holding the
  // navigation itself doesn't work: measured 2026-10-23, Chromium holds every page.evaluate until a
  // pending navigation commits, and Firefox and WebKit start unloading the page.)
  await page.addInitScript(() => {
    const digest = SubtleCrypto.prototype.digest;
    const w = window as unknown as { holdDigest?: boolean; releaseDigest?: () => void };
    SubtleCrypto.prototype.digest = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto["digest"]>) {
      if (!w.holdDigest) return digest.apply(this, args);
      return new Promise<ArrayBuffer>((resolve, reject) => (w.releaseDigest = () => digest.apply(this, args).then(resolve, reject)));
    };
  });
  const { si } = await setUp(page);
  await openConnect(page);
  await page.evaluate(() => ((window as unknown as { holdDigest: boolean }).holdDigest = true));
  await page.locator("#connect-signin").click();
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "redirecting");
  await expect(page.locator("#connect-signin")).toContainText("Going to GitHub...");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseDigest?: unknown }).releaseDigest)).toBe("function");
  await matrix(page, "redirecting");
  await page.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
  await page.waitForURL(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  expect(si.calls).toEqual([]);
});

test("B, finishing sign-in (the picker loading)", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const { si } = await setUp(page, {
    answer: {
      token: async () => {
        await held;
        return { status: 200, body: { access_token: "ghu_FAKEaccessONE0123456789abcdefghij", expires_in: 28800, refresh_token: "ghr_FAKErefreshONE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH", refresh_token_expires_in: 15897600 } };
      },
    },
  });
  const { state } = await goToGitHub(page, si);
  await page.goto(`/auth-callback?code=fakecode0123456789&state=${state}`);
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signing-in", { timeout: 30_000 });
  await expect(page.locator("#connect-signin-busy")).toHaveText("Finishing sign-in...");
  await matrix(page, "b-signing-in");
  release();
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "pick");
});

test("callback error: cancelled on GitHub", async ({ page }) => {
  const { si } = await setUp(page);
  const { state } = await goToGitHub(page, si);
  await page.goto(`/auth-callback?error=access_denied&state=${state}`);
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
  await matrix(page, "error-cancelled");
});

test("state mismatch: the sign-in wasn't started in this tab", async ({ page }) => {
  await setUp(page);
  await page.goto(`/auth-callback?code=fakecode0123456789&state=${"x".repeat(43)}`);
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "signin-failed", { timeout: 30_000 });
  await matrix(page, "error-state-mismatch");
});

test.describe("function missing", () => {
  test.use(tolerating(CHROMIUM_304, /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/config$/, /^Failed to load resource: the server responded with a status of 404( \(.*\))?$/));
  test("the relay answers 404: only today's token form", async ({ page }) => {
    await setUp(page, { config: "404" });
    await openConnect(page);
    await expect(page.locator("#connect-signin")).toHaveCount(0);
    await matrix(page, "function-missing");
  });
});

test("C, one repository: chosen already", async ({ page }) => {
  const { si } = await setUp(page);
  await signInAndPick(page, si);
  await matrix(page, "c-pick-one", true);
});

test("C, several repositories: the warning and nothing chosen", async ({ page }) => {
  const { si } = await setUp(page, { repos: [{ id: 1, owner: "me", name: "notes", private: false }, { id: 2, owner: "me-and-a-long-organisation-name", name: "a-rather-long-repository-name-for-coursework" }, { id: 4242, owner: "me", name: "workspace" }] });
  await signInAndPick(page, si);
  await expect(page.locator("#connect-pick-many")).toBeVisible();
  await matrix(page, "c-pick-several");
});

test("C-empty: no installations yet", async ({ page }) => {
  const { si } = await setUp(page, { repos: [] });
  await signInAndPick(page, si, { view: "pick-empty" });
  await matrix(page, "c-empty");
});

test("token expired: Sign in again", async ({ page }) => {
  const { si } = await setUp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
  const n = await syncCount(page);
  await signInAndPick(page, si, { remember: false });
  await page.locator("#connect-submit").click();
  await expect(page.locator("#connect-dialog")).toHaveCount(0, { timeout: 30_000 });
  await waitSync(page, n, "synced");
  await reloadApp(page);
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "needs-token");
  await syncStatus(page).click();
  await expect(page.locator("#connect-signin-result")).toContainText("has ended");
  await matrix(page, "sign-in-again");
});

test("offline: said before anything is tried", async ({ page, context }) => {
  await setUp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
  await expect(page.locator(".cm-content")).toBeVisible();
  // Python ready first: main.ts then loads the service-worker helper chunk, online.
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  const dialog = await openConnect(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await openConnect(page);
  await expect(page.locator("#connect-signin-result")).toHaveAttribute("data-tone", "warning");
  await matrix(page, "offline");
  await context.setOffline(false);
});
