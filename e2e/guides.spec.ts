// The guide pages (src/pages/routes.ts: /flowchart-from-code, /python, /c, /cpp), as built: the
// head and h1, no console errors or CSP violations (the fixture fails on errors; the page records
// securitypolicyviolation events), axe clean in light and dark, no sideways scroll at 320 px, the
// charts drawn in the page's own colours, the product named ExecFlow everywhere, and every "Open in
// ExecFlow" link opening the editor's preview of exactly that code, with nothing run. With the real service worker, a guide page is never
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
        await expect(page.locator("h1")).toHaveText(route.title.replace(/ \| ExecFlow$/, ""));
        // The product is ExecFlow in everything the page shows or says (the rename to Execflow is a
        // later release): the tab title, all text (closed answers too), accessible names, link previews.
        const shownText = await page.evaluate(() =>
          [document.title, document.body.textContent, ...[...document.querySelectorAll("[aria-label], [title], [alt], meta[content]")].map((el) => `${el.getAttribute("aria-label")} ${el.getAttribute("title")} ${el.getAttribute("alt")} ${el.getAttribute("content")}`)].join("\n"),
        );
        expect(shownText).toContain("ExecFlow");
        // Since 0.12.0 the site's address (canonical, og:url, og:image) carries the new name; only it may.
        expect(shownText.replaceAll("https://execflow.abhinesh.codes/", "").match(/execflow/gi), "the name Execflow on the page").toBeNull();
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE}${route.path}`);
        // The page is its own, not the editor's shell.
        await expect(page.locator("#app")).toHaveCount(0);
        await page.waitForLoadState("networkidle");
        expect(await cspViolations(page), "CSP violations").toEqual([]);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        // Every code block shows its program as text, exactly (an unescaped "<stdio.h>" would vanish as a tag).
        for (const pre of await page.locator("pre.ex-code").all()) {
          const id = await pre.evaluate((el) => el.closest(".ex")!.id.replace(/^ex-/, ""));
          expect(await pre.evaluate((el) => el.textContent), id).toBe(data.sources[id].code.replace(/\n$/, ""));
        }
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
      // Nor is any output or chart cut off inside its frame (the frames clip what overflows). A code
      // block keeps its lines whole (a wrapped Python line reads as two) and scrolls sideways instead.
      const clipped = await page.locator("pre:not(.ex-code), svg.fc-chart, .ex-bar").evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > document.documentElement.clientWidth).map((el) => el.className.toString() || el.tagName),
      );
      expect(clipped, "content wider than its frame").toEqual([]);
      const code = await page.locator("pre.ex-code").evaluateAll((els) =>
        els.map((el) => ({ wraps: getComputedStyle(el).whiteSpace !== "pre", scrolls: getComputedStyle(el).overflowX === "auto", right: el.getBoundingClientRect().right })),
      );
      for (const c of code) expect(c).toEqual({ wraps: false, scrolls: true, right: expect.any(Number) });
      for (const c of code) expect(c.right).toBeLessThanOrEqual(320);
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

    test("at 1440 px every line of code shows whole, without scrolling the code sideways", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route.path);
      // Lines stay whole (white-space: pre), so on a desktop the code pane is as wide as its longest line.
      const cut = await page.locator("pre.ex-code").evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.getAttribute("aria-label")}: ${el.scrollWidth} > ${el.clientWidth}`),
      );
      expect(cut, "code cut off at the pane's edge").toEqual([]);
    });

    for (const scheme of ["light", "dark"] as const) {
      test(`${scheme}: the keyboard reaches every link and code block in order, each with a visible focus ring`, async ({ page, browserName }) => {
        test.setTimeout(120_000);
        await openIn(page, route.path, scheme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        // Every element the keyboard should reach, numbered in document order. WebKit on Windows, like
        // Safari by default, leaves links out of the Tab order; WebKit on Linux (CI) keeps them in. So
        // the order is checked on whatever Tab reaches, and where links are left out each link's ring is
        // checked by focusing it straight after a key press (which makes the focus keyboard focus).
        const all = await page.locator("a[href], summary, [tabindex='0']").evaluateAll((els) =>
          els.filter((el) => el.getClientRects().length > 0).map((el, i) => (el.setAttribute("data-stop", String(i)), el.tagName === "A")),
        );
        expect(all.length).toBeGreaterThan(10);        const ring = () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            if (el === document.body) return null;
            const s = getComputedStyle(el);
            return { stop: Number(el.getAttribute("data-stop") ?? -1), tag: `${el.tagName}.${el.className} ${el.getAttribute("href") ?? el.getAttribute("aria-label") ?? ""}`, visible: el.matches(":focus-visible"), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
          });
        const expectRing = (r: NonNullable<Awaited<ReturnType<typeof ring>>>) => {
          expect(r.visible, r.tag).toBe(true);
          expect(r.style, r.tag).not.toBe("none");
          expect(r.width, r.tag).toBeGreaterThanOrEqual(2);
        };
        const reached: number[] = [];
        for (let i = 0; i < all.length + 20; i++) {
          await page.keyboard.press("Tab");
          const r = await ring();
          // Past the last stop focus leaves the page (body, or the browser's own controls) or wraps.
          if (!r || reached.includes(r.stop)) break;
          expectRing(r);
          if (r.stop >= 0) reached.push(r.stop);
        }
        // Links are left out only by WebKit, and then all of them; never by Chromium or Firefox.
        const linksTabbed = reached.some((i) => all[i]);
        if (browserName !== "webkit") expect(linksTabbed, "links in the Tab order").toBe(true);
        // Every stop, once each, in document order.
        const tabbed = all.flatMap((isLink, i) => (isLink && !linksTabbed ? [] : [i]));
        expect(tabbed.length).toBeGreaterThan(3);
        expect(reached).toEqual(tabbed);
        if (!linksTabbed) {
          for (const i of all.flatMap((isLink, n) => (isLink ? [n] : []))) {
            await page.keyboard.press("Shift");
            await page.locator(`[data-stop="${i}"]`).evaluate((el) => (el as HTMLElement).focus());
            const r = await ring();
            expect(r?.stop).toBe(i);
            expectRing(r!);
          }
        }
      });
    }

    test("every Open in ExecFlow link opens the editor's preview of that code, and nothing runs", async ({ page }) => {
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
      await expect(page.locator("h1")).toHaveText(route.title.replace(/ \| ExecFlow$/, ""));
      await expect(page.locator("#app")).toHaveCount(0);
    }
    // A query the precache doesn't ignore (Workbox drops only utm_* and fbclid) misses the precache,
    // so this one reaches the navigation fallback, and only its denylist keeps the editor out. (The
    // network answers it, so Firefox leaves that one page uncontrolled; Chromium keeps the controller.)
    const res = await page.goto("/python?ref=x");
    expect(res?.fromServiceWorker(), "answered by the network").toBe(false);
    await expect(page.locator("h1")).toHaveText("Run Python online in your browser");
    await expect(page.locator("#app")).toHaveCount(0);
  });
});
