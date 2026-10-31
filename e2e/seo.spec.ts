// What search engines and link previews read, on the built site: each page's title, canonical
// address and social card (fetched: a 1200 x 630 PNG), the home page's structured data, the summary
// a reader without JavaScript gets, robots.txt and sitemap.xml, and real 404s: an unknown address is
// the 404 page with a 404 (also once the service worker controls the site), while GitHub's sign-in
// return path still opens the editor. The CSP holds with the JSON-LD block (the console watch fails
// any test with a CSP error).
import AxeBuilder from "@axe-core/playwright";
import { GUIDE_ROUTES } from "../src/pages/routes";
import { expect, openApp, openIn, test, tolerating } from "./helpers";

const ORIGIN = "https://execflow.abhinesh.codes";
/** The address the site moved from (0.12.0): still named, so search engines tie the two together. */
const OLD_ORIGIN = "https://code-editor.abhinesh.codes";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = [
  { path: "/", title: "ExecFlow: free online Python, C and C++ compiler" },
  { path: "/about", title: "About ExecFlow: run Python, C and C++ in your browser" },
  { path: "/privacy", title: "Privacy - ExecFlow" },
  { path: "/terms", title: "Terms - ExecFlow" },
] as const;
// The 404s below are the point of these tests; each engine reports the page's own 404 in its words.
const NOT_FOUND_NOISE = tolerating(
  /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/no\/such\/page$/,
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
);

test.describe("search and sharing", () => {
  test.use({ serviceWorkers: "block" });

  for (const p of PAGES) {
    test(`${p.path}: title, one canonical address, and a social card that is really a 1200 x 630 PNG`, async ({ page, request }) => {
      await page.goto(p.path);
      await expect(page).toHaveTitle(p.title);
      const head = await page.evaluate(() => ({
        canonical: [...document.querySelectorAll('link[rel="canonical"]')].map((l) => l.getAttribute("href")),
        meta: Object.fromEntries([...document.querySelectorAll("meta[property], meta[name]")].map((m) => [m.getAttribute("property") ?? m.getAttribute("name"), m.getAttribute("content")])),
      }));
      expect(head.canonical).toEqual([ORIGIN + p.path]);
      expect(head.meta["og:url"]).toBe(ORIGIN + p.path);
      expect(head.meta["og:title"]).toBe(p.title);
      expect(head.meta["og:description"]).toBe(head.meta["description"]);
      expect(head.meta["og:site_name"]).toBe("ExecFlow");
      expect(head.meta["twitter:card"]).toBe("summary_large_image");
      const image = head.meta["og:image"]!;
      expect(head.meta["twitter:image"]).toBe(image);
      expect(image.startsWith(`${ORIGIN}/media/`)).toBe(true);
      const res = await request.get(new URL(image).pathname);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
      const bytes = await res.body();
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
      expect([head.meta["og:image:width"], head.meta["og:image:height"]]).toEqual(["1200", "630"]);
    });
  }

  test("the home page's JSON-LD parses: WebSite and WebApplication, no rating or review; and a level-one heading names the product", async ({ page }) => {
    await openApp(page);
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]);
    expect(data["@graph"].map((n: { "@type": string }) => n["@type"])).toEqual(["WebSite", "WebApplication"]);
    expect(blocks[0]).not.toMatch(/aggregateRating|"review/);
    const [site, app] = data["@graph"];
    expect([site["@id"], site.url, app["@id"], app.url]).toEqual([`${ORIGIN}/#website`, `${ORIGIN}/`, `${ORIGIN}/#app`, `${ORIGIN}/`]);
    expect(site.alternateName).toContain(new URL(OLD_ORIGIN).host);
    expect(app.image.startsWith(`${ORIGIN}/media/social-card.`)).toBe(true);
    // The old address appears only as that alternate name, never as an address to follow.
    expect(blocks[0].split(OLD_ORIGIN)).toHaveLength(1);
    await expect(page.getByRole("heading", { level: 1, name: "ExecFlow" })).toHaveCount(1);
  });

  test("without JavaScript, the home page says what ExecFlow is and links to the four guides, About, Privacy and Terms; with it, that text is gone", async ({ browser, page }) => {
    const off = await browser.newContext({ javaScriptEnabled: false });
    const plain = await off.newPage();
    await plain.goto("/");
    const summary = plain.locator(".noscript");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Python, C and C++");
    await expect(summary).toContainText("nothing to install");
    for (const name of ["About ExecFlow", "Privacy", "Terms"]) await expect(summary.getByRole("link", { name })).toBeVisible();
    // Every guide, by its own title (src/pages/routes.ts), so a new guide shows up here too.
    for (const route of GUIDE_ROUTES) {
      const link = summary.getByRole("link", { name: route.title.replace(/ \| ExecFlow$/, ""), exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", route.path);
    }
    await off.close();
    await openApp(page);
    await expect(page.getByText("nothing to install")).toHaveCount(0);
  });

  // A crawler that renders the page (Googlebot does) never reads <noscript>: the editor itself links
  // to About with a real <a href>, on screen at both widths, in the sidebar's foot or the status bar.
  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`${vp.name}: the rendered editor has a link to About that a crawler can follow`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openApp(page);
      const about = page.locator('a[href="/about"]');
      await expect(about).toHaveCount(1);
      await expect(about).toBeVisible();
      await expect(about).toBeInViewport();
      await expect(about).toHaveAccessibleName("About ExecFlow");
      await expect(page.locator(vp.width < 900 ? ".statusbar" : ".sidebar-foot").locator('a[href="/about"]')).toHaveCount(1);
      // A 24 px target at least, and a visible focus ring from the keyboard.
      const r = (await about.boundingBox())!;
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(24);
      await about.focus();
      expect(await about.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    });
  }

  // A crawler that renders "/" saw an app with links only to About, Privacy and Terms (Bing, owner's
  // decision 2026-10-31): the first-visit screen links to every guide with a real, visible <a href>,
  // after its ways to start, opening in a new tab like About so nothing typed is lost.
  const GUIDE_LINKS = [
    { name: "Run Python", path: "/python" },
    { name: "Run C", path: "/c" },
    { name: "Run C++", path: "/cpp" },
    { name: "Flowchart from code", path: "/flowchart-from-code" },
  ];
  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${vp.name} ${scheme}: the first-visit screen links to the four guides, in order after the ways to start, 24 px targets, no sideways scroll, axe clean`, async ({ page }) => {
        await page.setViewportSize(vp);
        await openIn(page, "/", scheme);
        await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        const empty = page.locator('.empty-state[data-empty="workspace"]');
        await expect(empty).toBeVisible();
        const guides = empty.getByRole("navigation", { name: "Guides" });
        await expect(guides).toBeVisible();
        const links = guides.getByRole("link");
        await expect(links).toHaveCount(GUIDE_LINKS.length);
        // Every guide the site has, and nothing else.
        expect(GUIDE_LINKS.map((g) => g.path).sort()).toEqual(GUIDE_ROUTES.map((r) => r.path).sort());
        for (const [i, g] of GUIDE_LINKS.entries()) {
          const link = links.nth(i);
          await expect(link).toHaveAccessibleName(g.name);
          await expect(link).toHaveAttribute("href", g.path);
          await expect(link).toHaveAttribute("target", "_blank");
          await expect(link).toHaveAttribute("rel", "noopener noreferrer");
          await expect(link).toBeVisible();
          const r = (await link.boundingBox())!;
          expect(Math.min(r.width, r.height), `${g.name}: a 24 px target`).toBeGreaterThanOrEqual(24);
          // Real text a crawler reads: not hidden, not clipped, painted with some contrast.
          expect(await link.evaluate((el) => getComputedStyle(el).visibility === "visible" && Number(getComputedStyle(el).opacity) === 1)).toBe(true);
        }
        // Keyboard: from the last way to start, Tab walks the guides in order, each with a focus ring.
        // Safari by default (and Playwright's WebKit on Windows) leaves links out of the Tab order
        // (about.spec.ts): there, each link's ring is checked by focusing it straight after a key press.
        await empty.getByRole("button", { name: "Connect GitHub" }).focus();
        await page.keyboard.press("Tab");
        const linksAreStops = await links.first().evaluate((a) => a === document.activeElement);
        if (!linksAreStops) expect(test.info().project.name, "only WebKit may skip links").toBe("webkit");
        for (const [i, g] of GUIDE_LINKS.entries()) {
          if (!linksAreStops) {
            await page.keyboard.press("Shift");
            await links.nth(i).focus();
          } else if (i > 0) await page.keyboard.press("Tab");
          await expect(links.nth(i)).toBeFocused();
          expect(await links.nth(i).evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), `${g.name}: focus ring`).toBe(true);
        }
        // Inside its column and the page: no sideways scroll.
        const box = (await empty.boundingBox())!;
        const nav = (await guides.boundingBox())!;
        expect(nav.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(nav.x + nav.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        await page.screenshot({ path: test.info().outputPath(`guides-${vp.name}-${scheme}.png`), animations: "disabled" });
        const axe = await new AxeBuilder({ page }).include('.empty-state[data-empty="workspace"]').withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
      });
    }
  }

  test("robots.txt names the sitemap, and sitemap.xml lists the four pages and the four guides", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/xml/);
    const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([...PAGES, ...GUIDE_ROUTES].map((p) => ORIGIN + p.path));
  });

  test("GitHub's sign-in return path still opens the editor", async ({ page }) => {
    await openApp(page, "/auth-callback?error=access_denied");
    expect(new URL(page.url()).pathname).toBe("/");
  });
});

test.describe("the 404 page", () => {
  test.use({ serviceWorkers: "block" });
  test.use(NOT_FOUND_NOISE);

  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${vp.name} ${scheme}: an unknown address is the 404 page with a 404, never indexed, axe clean, no sideways scroll`, async ({ page }) => {
        await page.setViewportSize(vp);
        const res = await page.goto("/no/such/page");
        expect(res?.status()).toBe(404);
        if (scheme === "dark") await openIn(page, "/no/such/page", scheme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(page).toHaveTitle("Page not found - ExecFlow");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
        await expect(page.getByRole("main").getByRole("link", { name: "Open the editor" })).toBeVisible();
        await expect(page.getByRole("main").getByRole("link", { name: "About ExecFlow" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
      });
    }
  }
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });
  // The 404 as above; and offline, the sign-in return asks the relay for its settings, which fails
  // (no network): the point is that the page itself still opens.
  test.use(
    tolerating(
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/no\/such\/page$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      // Chromium's words, WebKit's, then Firefox's (seen in 1 run in 3: fix/repro-sw.log, 2026-10-29).
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/config (net::ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error|NS_ERROR_OFFLINE)$/,
      /^Failed to load resource: (net::ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error)$/,
    ),
  );

  test("an unknown address is still the 404 page, not the editor; the sign-in return path opens the editor, offline too", async ({ page, context }) => {
    test.setTimeout(240_000);
    await openApp(page);
    // main.ts registers the service worker once Python is up (as legal.spec.ts).
    await page.locator('.starter[data-language="python"]').click();
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
      .toBe("activated");
    // Each load reopens main.py, which starts Python again: the test leaves a page only once Python is
    // up, since leaving while the service worker still answers a Pyodide download makes Firefox log
    // "A ServiceWorker intercepted the request and encountered an unexpected error" (tests review,
    // 2026-10-29: 1 run in 3), and networkidle can come in a pause between two of its files.
    const pythonUp = () => expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await pythonUp();
    await page.waitForLoadState("networkidle");
    const res = await page.goto("/no/such/page");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await expect(page.locator("#app")).toHaveCount(0);
    await openApp(page, "/auth-callback?error=access_denied");
    expect(new URL(page.url()).pathname).toBe("/");
    await pythonUp();
    await page.waitForLoadState("networkidle");
    // Offline, the navigation fallback still answers the editor's own addresses from the precache.
    // (An unknown address offline fails like any page the precache doesn't hold.)
    await context.setOffline(true);
    await openApp(page, "/auth-callback?error=access_denied");
    expect(new URL(page.url()).pathname).toBe("/");
    await pythonUp();
  });
});
