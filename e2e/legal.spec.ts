// The Privacy and Terms pages (privacy.html, terms.html): served at /privacy and /terms with the app's
// headers, readable at 1440 and 390 px in light and dark (the scheme proved first), axe clean, no
// sideways scroll, linked from Settings and the sign-in dialog, and still the page itself (not the
// editor) once the service worker controls the site. Shots go to LEGAL_SHOTS when set.
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, hierarchyShots, openApp, openIn, test } from "./helpers";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = [
  { path: "/privacy", title: "Privacy", other: "Terms" },
  { path: "/terms", title: "Terms", other: "Privacy" },
] as const;

function shotsDir(info: TestInfo): string {
  const dir = process.env.LEGAL_SHOTS ? join(process.env.LEGAL_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe("legal pages", () => {
  test.use({ serviceWorkers: "block" });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const p of PAGES) {
        test(`${p.title}, ${vp.name} ${scheme}: the page, its theme, axe and no sideways scroll`, async ({ page }, info) => {
          await page.setViewportSize(vp);
          await openIn(page, p.path, scheme);
          await expect(page).toHaveTitle(`${p.title} - CodeEditor`);
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
          // theme-boot.js painted the scheme (the page has no script of its own).
          await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
          const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          expect(ground, "a themed ground, not the browser's").not.toBe("rgba(0, 0, 0, 0)");
          expect(await overflow(page)).toBe(false);
          const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
          const dir = shotsDir(info);
          await page.screenshot({ path: join(dir, `${p.title.toLowerCase()}-${vp.name}-${scheme}.png`), fullPage: true, animations: "disabled" });
          if (vp.name === "desktop") await hierarchyShots(page, join(dir, `${p.title.toLowerCase()}-${scheme}`));
        });
      }
    }
  }

  test("served with the app's headers, and each page links to the other and back to the editor", async ({ page, request }) => {
    for (const p of PAGES) {
      // Headers from a request of its own: a page navigation can come back 304 from the browser's cache.
      const res = await request.get(p.path);
      expect(res.status()).toBe(200);
      const headers = res.headers();
      expect(headers["content-security-policy"]).toContain("script-src 'self'");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["permissions-policy"]).toContain("camera=()");
      expect(headers["strict-transport-security"]).toBe("max-age=31536000");
      await page.goto(p.path);
      await page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: p.other }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.other);
    }
    await page.getByRole("link", { name: "Open the editor" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  });

  test("/licenses.txt: CodeEditor's licence, then every third-party licence text the site ships under", async ({ request }) => {
    const res = await request.get("/licenses.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
    const text = await res.text();
    for (const part of [
      "Copyright (c) 2026 Abhinesh",
      "@codemirror/view",
      "idb ",
      "Pyodide 314.0.7",
      "Mozilla Public License Version 2.0",
      "PYTHON SOFTWARE FOUNDATION LICENSE",
      "wasm-clang",
      "tree-sitter-c 0.24.1",
      "tree-sitter-cpp 0.23.4",
      "tree-sitter-python 0.25.0",
      "web-tree-sitter",
      "SIL Open Font License",
      "Workbox",
      "LICENSE.llvm.txt",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  test("Settings links to both pages, in a new tab", async ({ page, context }) => {
    await openApp(page);
    await page.locator("#settings-button").click();
    const legal = page.locator(".settings-legal");
    await legal.scrollIntoViewIfNeeded();
    for (const [name, path] of [["Privacy", "/privacy"], ["Terms", "/terms"]] as const) {
      const link = legal.getByRole("link", { name });
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      const [tab] = await Promise.all([context.waitForEvent("page"), link.click()]);
      await tab.waitForLoadState();
      expect(new URL(tab.url()).pathname).toBe(path);
      await expect(tab.getByRole("heading", { level: 1 })).toHaveText(name);
      await tab.close();
    }
    await expect(legal.getByRole("link", { name: "Licences" })).toHaveAttribute("href", "/licenses.txt");
  });
});

test("with the service worker in control, /privacy and /terms are the pages, online and offline", async ({ page, context }) => {
  test.setTimeout(240_000);
  await openApp(page);
  // main.ts registers the service worker once Python is up.
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
    .toBe("activated");
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  // Leaving the editor while it still fetches its lazy parts cancels them, and Firefox reports a
  // cancelled fetch the service worker answers as an error (lessons.md, PWA navigations): let it settle.
  await page.waitForLoadState("networkidle");
  for (const offline of [false, true]) {
    await context.setOffline(offline);
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1 }), `${p.path} ${offline ? "offline" : "online"}`).toHaveText(p.title);
      await expect(page.locator("#app")).toHaveCount(0);
    }
  }
  await context.setOffline(false);
});
