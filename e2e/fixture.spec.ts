import { expect, test } from "./helpers";

// The console fixture (helpers.ts) excuses downloads that a navigation cancels. This proves it still
// reports a cancellation that no navigation explains: the test must fail, from the fixture's own check.
test("the fixture still reports a cancelled request when no navigation explains it", async ({ page }) => {
  test.fail(); // proved 2026-10-17: without this line it fails in all three engines with the fixture's message
  await page.route("**/never-answered.txt", () => {}); // held: the request stays in flight
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  await page.evaluate(async () => {
    const control = new AbortController();
    const pending = fetch("/never-answered.txt", { signal: control.signal }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 300));
    control.abort();
    await pending;
  });
  await page.waitForTimeout(500); // let the failure event arrive
});
