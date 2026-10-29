import type { Page } from "@playwright/test";
import { CANCELLED, expect, openApp, test, waitReady, watchContext } from "./helpers";

// Proofs for the console and failed-request fixture (helpers.ts), next to fixture.spec.ts. Each
// test.fail() test must fail from the fixture's own check; it is reported as passing only then.

test("a second tab's console error fails the test", async ({ page, context }) => {
  test.fail();
  await openApp(page);
  const second = await context.newPage();
  await second.goto("/");
  await waitReady(second);
  await second.evaluate(() => console.error("an error in the second tab"));
});

test("a page of a context the test made itself is watched through watchContext", async ({ browser }, info) => {
  test.fail();
  const other = await browser.newContext({ serviceWorkers: "block" });
  const watch = watchContext(other, info.project.name);
  try {
    const them = await other.newPage();
    await openApp(them);
    await them.evaluate(() => console.error("an error in another context"));
  } finally {
    const errors = watch.settle();
    await other.close();
    expect(errors, "console errors and failed requests").toEqual([]);
  }
});

/**
 * The reasons of the failed requests to `path`, once one has arrived. The proofs below check that
 * the engine words their abort as a cancellation (CANCELLED) before marking themselves test.fail():
 * a reason outside CANCELLED fails the test through the fixture's plain path, whatever the
 * navigation rule does, so it would prove nothing.
 */
async function cancelReasons(page: Page, path: string, act: () => Promise<void>) {
  const reasons: string[] = [];
  page.on("requestfailed", (r) => { if (new URL(r.url()).pathname === path) reasons.push((r.failure()?.errorText ?? "").trim()); });
  await act();
  await expect.poll(() => reasons.length).toBeGreaterThan(0);
  return reasons;
}

// A same-document URL change (pushState, a new hash, the app's own replaceState) starts no new
// document and cancels nothing, so it must not excuse a cancelled request.
test("a same-page URL change doesn't excuse a cancelled request", async ({ page }) => {
  await page.route("**/never-answered.txt", () => {}); // held: the request stays in flight
  await openApp(page);
  const reasons = await cancelReasons(page, "/never-answered.txt", () =>
    page.evaluate(async () => {
      const control = new AbortController();
      const pending = fetch("/never-answered.txt", { signal: control.signal }).catch(() => "aborted");
      await new Promise((r) => setTimeout(r, 300));
      history.pushState(null, "", "#moved");
      control.abort();
      await pending;
    }),
  );
  expect(reasons, "the abort is reported as a cancellation").toEqual([expect.stringMatching(CANCELLED)]);
  test.fail(); // from here on, only the fixture's navigation check can fail it
  await page.waitForTimeout(500);
});

// The first document's DOMContentLoaded comes after the requests it started while parsing, so it
// is no navigation: a request of that document cancelled just after it is still a failure.
test("the first page's DOMContentLoaded doesn't excuse a request cancelled after it", async ({ page }) => {
  await page.route("**/early-held.txt", () => {}); // held: the request stays in flight
  await page.addInitScript(() => {
    const g = globalThis as { __early?: AbortController };
    g.__early = new AbortController();
    fetch("/early-held.txt", { signal: g.__early.signal }).catch(() => "aborted");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const reasons = await cancelReasons(page, "/early-held.txt", () =>
    page.evaluate(() => (globalThis as { __early?: AbortController }).__early?.abort()),
  );
  expect(reasons, "the abort is reported as a cancellation").toEqual([expect.stringMatching(CANCELLED)]);
  test.fail(); // from here on, only the fixture's navigation check can fail it
  await waitReady(page);
});

// Closing a tab cancels what it still had in flight: that is the test's doing, not a failure. A
// regression test for the close guard in watchPage; the engines measured (2026-10-28) report no
// failure for a closed tab's requests, so it also passes without the guard.
test("closing a second tab with a request in flight doesn't fail the test", async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.route("**/slow-held.txt", () => {}); // held: the request stays in flight
  await second.goto("/");
  await waitReady(second);
  const started = second.waitForRequest("**/slow-held.txt");
  await second.evaluate(() => void fetch("/slow-held.txt").catch(() => "closed"));
  await started;
  await second.close();
  await page.waitForTimeout(500); // let any failure event arrive
});

// WebKit's "due to access control checks" line is excused for worker bundles (assets/w/) only.
test("WebKit's blocked-load line for a main-thread chunk is not excused", async ({ page }, info) => {
  test.skip(info.project.name !== "webkit", "the tolerance applies in WebKit only");
  test.fail();
  await openApp(page);
  const origin = new URL(page.url()).origin;
  await page.evaluate((o) => console.error(`Cannot load ${o}/assets/Ab12-cd.js due to access control checks.`), origin);
});

// Smoke test, not a proof: setOffline records each state in an init script, and Playwright leaves
// the order of several init scripts undefined, so a reload after going offline and back must still
// start online. Playwright normally keeps registration order, so this also passes without the
// sequence numbers; it guards against the reload path breaking, not against the order changing.
test("a reload after going offline and back online starts online", async ({ page, context }) => {
  await openApp(page);
  // Nothing in flight when the network goes: WebKit fails a font still downloading then.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await context.setOffline(true);
  await context.setOffline(false);
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
});
