// The About page (0.7.0, brief .claude/tasks/v07-about.md): served at /about as its own entry; the
// first viewport says what CodeEditor is, for whom, and offers "Open the editor"; the hero's poster
// (a pre-rendered still of the scene) shows at once and the real-time three.js scene replaces it only
// where WebGL works and motion is welcome; the changelog lists every release; light and dark, 320 px,
// keyboard and axe; and the editor's first visit loads nothing of it.
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG } from "../src/about/changelog";
import { expect, hierarchyShots, openIn, test } from "./helpers";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const scene = (page: Page) => page.locator("[data-scene]");

function shotsDir(info: TestInfo): string {
  const dir = process.env.ABOUT_SHOTS ? join(process.env.ABOUT_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe("the About page", () => {
  test.use({ serviceWorkers: "block" });

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${vp.name} ${scheme}: the first viewport answers what, who and what next; axe clean; no sideways scroll`, async ({ page }, info) => {
        await page.setViewportSize(vp);
        await openIn(page, "/about", scheme);
        await expect(page).toHaveTitle("About CodeEditor");
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toBeInViewport();
        await expect(page.locator(".about-lede")).toBeInViewport();
        const open = page.getByRole("link", { name: "Open the editor" }).first();
        await expect(open).toBeInViewport();
        await expect(open).toHaveAttribute("href", "/");
        // The poster is there at once, with its size reserved (no layout shift).
        const poster = page.locator(".about-poster");
        await expect(poster).toBeVisible();
        expect(Number(await poster.getAttribute("width"))).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
        const dir = shotsDir(info);
        await page.screenshot({ path: join(dir, `about-${vp.name}-${scheme}.png`), animations: "disabled" });
        await page.screenshot({ path: join(dir, `about-${vp.name}-${scheme}-full.png`), fullPage: true, animations: "disabled" });
        if (vp.name === "desktop") await hierarchyShots(page, join(dir, `about-${scheme}`));
      });
    }
  }

  test("320 px: nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/about");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test("the changelog lists every release, newest first, with its items as text", async ({ page }) => {
    await page.goto("/about#changelog");
    const releases = page.locator("#changelog .release");
    await expect(releases).toHaveCount(CHANGELOG.length);
    await expect(releases.first().locator("h3")).toContainText(CHANGELOG[0].version);
    await expect(releases.last().locator("h3")).toContainText("0.1.0");
    await expect(page.locator("#changelog")).toBeInViewport();
    // The version shown is the build's.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    await expect(page.locator("[data-app-version]")).toHaveText(pkg.version);
  });

  test("keyboard: the first Tab stop is a skip link, then Open the editor; focus is visible", async ({ page }) => {
    await page.goto("/about");
    await page.keyboard.press("Tab");
    // Safari leaves links out of the Tab order unless "Press Tab to highlight each item" is on, and
    // Playwright's WebKit differs by platform (share-design.spec.ts): read it from the browser.
    const skip = page.getByRole("link", { name: "Skip to the content" });
    const linksAreStops = await skip.evaluate((a) => a === document.activeElement);
    if (!linksAreStops) {
      expect(test.info().project.name, "only WebKit may skip links").toBe("webkit");
      await skip.focus();
    }
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    if (linksAreStops) {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
    } else {
      await page.locator(".about-head .about-btn").focus();
    }
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { text: el.textContent?.trim(), outline: getComputedStyle(el).outlineStyle };
    });
    expect(focused.text).toBe("Open the editor");
    expect(focused.outline).not.toBe("none");
  });

  test("the launch video's slot waits for its file: no player and no request yet", async ({ page }) => {
    const media: string[] = [];
    page.on("request", (r) => (/\.(mp4|webm)$/.test(new URL(r.url()).pathname) ? media.push(r.url()) : null));
    await page.goto("/about");
    await expect(page.locator("#launch-video")).toHaveCount(1);
    await page.locator("#launch-video").scrollIntoViewIfNeeded();
    expect(media).toEqual([]);
  });
});

test.describe("the hero scene", () => {
  test.use({ serviceWorkers: "block" });

  test("with WebGL and motion welcome, the real-time scene replaces the poster once it has drawn", async ({ page, browserName }) => {
    await page.goto("/about");
    await expect(scene(page)).toHaveAttribute("data-scene", /^(running|unavailable)$/, { timeout: 20_000 });
    const state = await scene(page).getAttribute("data-scene");
    // Only a browser with neither WebGL 2 nor WebGL may say unavailable (lessons.md, Pocket Run).
    if (state === "unavailable") {
      const any = await page.evaluate(() => {
        const c = document.createElement("canvas");
        return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
      });
      expect(any, `${browserName} has WebGL but the scene says unavailable`).toBe(false);
      await expect(page.locator(".about-poster")).toBeVisible();
      return;
    }
    await expect(page.locator(".about-scene canvas")).toBeVisible();
    await expect(page.locator(".about-scene canvas")).toHaveAttribute("aria-hidden", "true");
  });

  test("reduced motion: the poster stays and the scene never starts a frame", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/about");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expect(scene(page)).toHaveAttribute("data-scene", "still");
    await page.waitForTimeout(1500);
    expect(Number(await scene(page).getAttribute("data-frames"))).toBe(0);
    await expect(page.locator(".about-poster")).toBeVisible();
    await expect(page.locator(".about-scene canvas")).toHaveCount(0);
  });

  test("WebGL unavailable: the poster stays, and the page says nothing is wrong", async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof original;
    });
    await page.goto("/about");
    await expect(scene(page)).toHaveAttribute("data-scene", "unavailable", { timeout: 20_000 });
    await expect(page.locator(".about-poster")).toBeVisible();
  });
});

test("the editor's first visit loads nothing of the About page", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  expect(html).not.toContain("/assets/a/");
  const seen: string[] = [];
  page.on("request", (r) => seen.push(new URL(r.url()).pathname));
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(seen.filter((p) => p.startsWith("/assets/a/") || p.startsWith("/media/"))).toEqual([]);
});

test("with the service worker in control, /about works offline after one visit, and / is still the editor", async ({ page, context }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
    .toBe("activated");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#changelog .release")).toHaveCount(CHANGELOG.length);
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await context.setOffline(false);
});
