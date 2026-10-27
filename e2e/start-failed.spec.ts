// A start that fails says so (milestone 5 readiness audit): when a file the app's code needs doesn't
// arrive (a dropped connection, or a tab opened while a new version is published), the page shows
// "CodeEditor couldn't start" with Reload, instead of loading forever. Reload, once the file arrives,
// starts the app. public/theme-boot.js draws it (the app's own code may never have run).
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, tolerating } from "./helpers";

test.use({ serviceWorkers: "block" });

// The 404 below is the point of the test: the browser reports the failed module and request.
// (Firefox reports a module answered with text/plain under nosniff as NS_ERROR_CORRUPTED_CONTENT;
// WebKit cancels the preloaded module's request once it failed: "Load request cancelled".)
test.use(tolerating(/404|Failed to load|failed to fetch|Importing a module script failed|error loading dynamically imported module|Load failed|ERR_ABORTED|CORRUPTED_CONTENT|Load request cancelled/i));

test("a module the app needs is missing: the page says it couldn't start, and Reload recovers", async ({ page, request }) => {
  // One of the files the entry module imports (index.html preloads them), read from the HTML: the
  // page's first visit must be the one that misses it (WebKit's reload reused its cached copy).
  const html = await (await request.get("/")).text();
  const preload = /<link rel="modulepreload" crossorigin href="([^"]+)"/.exec(html)?.[1];
  expect(preload).toMatch(/^\/assets\/.+\.js$/);
  let missing = true;
  await page.route(`**${preload}`, (route) => (missing ? route.fulfill({ status: 404, contentType: "text/plain", body: "gone" }) : route.continue()));
  await page.goto("/");
  const box = page.locator(".start-failed");
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#app")).toHaveAttribute("data-state", "start-failed");
  await expect(box.getByRole("heading", { level: 1 })).toHaveText("CodeEditor couldn't start");
  await expect(box).toHaveAttribute("role", "alert");
  missing = false;
  const reloaded = page.waitForEvent("load");
  await box.getByRole("button", { name: "Reload" }).click();
  await reloaded;
  // Playwright's WebKit keeps a module that failed to load failed for the whole browser context
  // (lessons.md 2026-10-21; Chromium and Firefox fetch it again), so recovery is checked in those two.
  if (test.info().project.name === "webkit") return;
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.locator(".start-failed")).toHaveCount(0);
});

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the screen, ${vp.name} ${scheme}: axe clean, no sideways scroll, a 44 px Reload`, async ({ page, request }, info) => {
      const html = await (await request.get("/")).text();
      const preload = /<link rel="modulepreload" crossorigin href="([^"]+)"/.exec(html)![1];
      await page.route(`**${preload}`, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "gone" }));
      await page.setViewportSize(vp);
      // Load, then emulate, then reload: Firefox drops emulation set before the first load (lessons.md).
      await page.goto("/");
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme applied").toBe(scheme === "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const box = page.locator(".start-failed");
      await expect(box).toBeVisible({ timeout: 30_000 });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      const reload = (await box.getByRole("button", { name: "Reload" }).boundingBox())!;
      expect(Math.min(reload.width, reload.height)).toBeGreaterThanOrEqual(vp.name === "phone" ? 44 : 24);
      const dir = process.env.LEGAL_SHOTS ? join(process.env.LEGAL_SHOTS, info.project.name) : info.outputPath();
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `start-failed-${vp.name}-${scheme}.png`), animations: "disabled" });
    });
  }
}
