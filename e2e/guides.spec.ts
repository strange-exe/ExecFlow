// The guide pages (src/pages/routes.ts: /flowchart-from-code, /python, /c, /cpp), as built: the
// head and h1, no console errors or CSP violations (the fixture fails on errors; the page records
// securitypolicyviolation events), axe clean in light and dark, no sideways scroll at 320 px, the
// charts drawn in the page's own colours, and every "Open in Execflow" link opening the editor with
// exactly that code shown and nothing run. With the real service worker, a guide page is never
// answered with the editor.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { loadGuideData } from "../src/pages/load";
import { GUIDE_ROUTES, SITE } from "../src/pages/routes";
import { EXAMPLES } from "../src/pages/examples";
import { expect, openApp, openIn, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const data = loadGuideData(process.cwd());

/** Records CSP violations from the first script on. */
async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

for (const route of GUIDE_ROUTES) {
  test.describe(route.path, () => {
    for (const scheme of ["light", "dark"] as const) {
      test(`${scheme}: title, h1, canonical, no CSP violation, axe clean, charts in the page's colours`, async ({ page }) => {
        await watchCsp(page);
        await openIn(page, route.path, scheme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(page).toHaveTitle(route.title);
        await expect(page.locator("h1")).toHaveCount(1);
        await expect(page.locator("h1")).toHaveText(route.title.replace(/ \| Execflow$/, ""));
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE}${route.path}`);
        // The page is its own, not the editor's shell.
        await expect(page.locator("#app")).toHaveCount(0);
        await page.waitForLoadState("networkidle");
        expect(await cspViolations(page), "CSP violations").toEqual([]);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        // Every chart's text is painted in the theme's own text colour (not the export's fixed ink).
        for (const chart of await page.locator("svg.fc-chart").all()) {
          const [fill, text] = await chart.evaluate((svg) => [getComputedStyle(svg.querySelector("text")!).fill, getComputedStyle(document.body).color]);
          expect(fill).toBe(text);
          await expect(chart).toHaveAttribute("role", "img");
          await expect(chart).toHaveAttribute("aria-label", /^Flowchart of .+\. Its steps are listed as text under it\.$/);
        }
      });
    }

    test("no sideways scroll at 320 px, and every target is at least 24 px", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(route.path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "sideways scroll").toBeLessThanOrEqual(0);
      // Nor is any code, output or chart cut off inside its frame (the frames clip what overflows).
      const clipped = await page.locator("pre, svg.fc-chart, .ex-bar").evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > document.documentElement.clientWidth).map((el) => el.className.toString() || el.tagName),
      );
      expect(clipped, "content wider than its frame").toEqual([]);
      const small = await page.locator("main a, main summary, header a, footer a, nav a").evaluateAll((els) =>
        els
          .filter((el) => {
            // Links inside a sentence are exempt (WCAG 2.5.8's inline exception).
            if (el.closest("p, li:not(nav li)") && el.tagName === "A" && !el.className) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.height < 24 || r.width < 24);
          })
          .map((el) => `${el.tagName} ${el.textContent?.trim()}`),
      );
      expect(small).toEqual([]);
    });

    test("every Open in Execflow link opens the editor with that code shown, and nothing runs", async ({ page }) => {
      test.setTimeout(240_000);
      await page.goto(route.path);
      const links = await page.locator("a.ex-open").evaluateAll((els) =>
        els.map((a) => ({ href: a.getAttribute("href")!, id: a.closest(".ex")!.id.replace(/^ex-/, "") })),
      );
      expect(links.length).toBeGreaterThanOrEqual(4);
      for (const { href, id } of links) {
        await page.goto(route.path);
        await page.locator(`#ex-${id} a.ex-open`).click();
        await waitReady(page);
        const dialog = page.locator("dialog#code-link");
        await expect(dialog).toHaveAttribute("data-state", "ready");
        await expect(page.locator("#code-link-title")).toHaveText(`Open ${EXAMPLES[id].name}?`);
        await expect(page.locator("#code-link-preview")).toHaveText(data.sources[id].code.replace(/\n$/, ""));
        expect(new URL(page.url()).hash, "the code left the address bar").toBe("");
        expect(href.startsWith("/#code=1.")).toBe(true);
        // Nothing ran: no run started, none counted.
        await expect(page.locator("#app")).not.toHaveAttribute("data-run", /running|waiting/);
        expect(Number((await page.locator("#app").getAttribute("data-runs")) ?? 0)).toBe(0);
      }
    });
  });
}

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test.setTimeout(180_000);

  test("a guide page is answered with itself, never with the editor, after the service worker takes over", async ({ page }) => {
    // The editor registers the service worker once Python is up (as e2e/offline.spec.ts does it).
    await openApp(page);
    await page.locator('.starter[data-language="python"]').click();
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
      .toBe("activated");
    for (const route of GUIDE_ROUTES) {
      await page.goto(route.path);
      expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "page controlled by the service worker").toBe(true);
      await expect(page.locator("h1")).toHaveText(route.title.replace(/ \| Execflow$/, ""));
      await expect(page.locator("#app")).toHaveCount(0);
    }
  });
});
