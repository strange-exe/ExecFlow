// Versions (0.7.0 versions unit): Settings shows "CodeEditor <version>" and a What's new link to the
// About page's changelog; after an update the app says so once, quietly; never on a first visit.
// The version is package.json's, injected by the build (no request for it).
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { expect, openApp, openIn, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });

const VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const KEY = "codeeditor:last-seen-version";
const notice = (page: import("@playwright/test").Page) => page.locator(".notice");

test("Settings shows the version and a What's new link to the About page's changelog", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").click();
  const foot = page.locator("#settings-version");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toContainText(`CodeEditor ${VERSION}`);
  const link = foot.getByRole("link", { name: "What's new" });
  await expect(link).toHaveAttribute("href", "/about#changelog");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("a first visit: no What's new, then or after a reload", async ({ page }) => {
  await openApp(page);
  await expect(notice(page)).not.toContainText("Updated to");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(VERSION);
  await page.reload();
  await waitReady(page);
  await expect(notice(page)).not.toContainText("Updated to");
});

test("after an update: told once, quietly, with What's new; Dismiss and a reload keep it away", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate((k) => localStorage.setItem(k, "0.6.2"), KEY);
  await page.reload();
  await waitReady(page);
  await expect(notice(page)).toContainText(`Updated to CodeEditor ${VERSION}.`);
  await expect(notice(page)).toHaveAttribute("data-tone", "info");
  // Quiet: the notice doesn't take the focus from the editor or the page.
  expect(await page.evaluate(() => document.activeElement?.closest(".notice") === null)).toBe(true);
  const [about] = await Promise.all([context.waitForEvent("page"), notice(page).getByRole("button", { name: "What's new" }).click()]);
  expect(new URL(about.url()).pathname + new URL(about.url()).hash).toBe("/about#changelog");
  await about.close();
  await expect(notice(page)).not.toContainText("Updated to");
  await page.reload();
  await waitReady(page);
  await expect(notice(page)).not.toContainText("Updated to");
});

for (const scheme of ["light", "dark"] as const) {
  test(`Settings' foot with the version, ${scheme}: axe clean`, async ({ page }) => {
    await openIn(page, "/", scheme);
    await waitReady(page);
    await page.locator("#settings-button").click();
    await page.locator("#settings-version").scrollIntoViewIfNeeded();
    const axe = await new AxeBuilder({ page }).include("#settings-version").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id} x${v.nodes.length}`)).toEqual([]);
  });
}
