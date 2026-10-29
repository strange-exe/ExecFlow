// What search engines and link previews read, on the built site: each page's title, canonical
// address and social card (fetched: a 1200 x 630 PNG), the home page's structured data, the summary
// a reader without JavaScript gets, robots.txt and sitemap.xml, and real 404s: an unknown address is
// the 404 page with a 404 (also once the service worker controls the site), while GitHub's sign-in
// return path still opens the editor. The CSP holds with the JSON-LD block (the console watch fails
// any test with a CSP error).
import AxeBuilder from "@axe-core/playwright";
import { expect, openApp, openIn, test, tolerating } from "./helpers";

const ORIGIN = "https://code-editor.abhinesh.codes";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = [
  { path: "/", title: "CodeEditor: free online Python, C and C++ compiler" },
  { path: "/about", title: "About CodeEditor: run Python, C and C++ in your browser" },
  { path: "/privacy", title: "Privacy - CodeEditor" },
  { path: "/terms", title: "Terms - CodeEditor" },
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
      expect(head.meta["og:site_name"]).toBe("CodeEditor");
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
    await expect(page.getByRole("heading", { level: 1, name: "CodeEditor" })).toHaveCount(1);
  });

  test("without JavaScript, the home page says what CodeEditor is and links to About, Privacy and Terms; with it, that text is gone", async ({ browser, page }) => {
    const off = await browser.newContext({ javaScriptEnabled: false });
    const plain = await off.newPage();
    await plain.goto("/");
    const summary = plain.locator(".noscript");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Python, C and C++");
    await expect(summary).toContainText("nothing to install");
    for (const name of ["About CodeEditor", "Privacy", "Terms"]) await expect(summary.getByRole("link", { name })).toBeVisible();
    await off.close();
    await openApp(page);
    await expect(page.getByText("nothing to install")).toHaveCount(0);
  });

  test("robots.txt names the sitemap, and sitemap.xml lists the four pages", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/xml/);
    const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PAGES.map((p) => ORIGIN + p.path));
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
        await expect(page).toHaveTitle("Page not found - CodeEditor");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
        await expect(page.getByRole("main").getByRole("link", { name: "Open the editor" })).toBeVisible();
        await expect(page.getByRole("main").getByRole("link", { name: "About CodeEditor" })).toBeVisible();
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
      // Chromium's words, then WebKit's (Firefox logs nothing here).
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/api\/auth\/config (net::ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error)$/,
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
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.waitForLoadState("networkidle");
    const res = await page.goto("/no/such/page");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await expect(page.locator("#app")).toHaveCount(0);
    await openApp(page, "/auth-callback?error=access_denied");
    expect(new URL(page.url()).pathname).toBe("/");
    await page.waitForLoadState("networkidle");
    // Offline, the navigation fallback still answers the editor's own addresses from the precache.
    // (An unknown address offline fails like any page the precache doesn't hold.)
    await context.setOffline(true);
    await openApp(page, "/auth-callback?error=access_denied");
    expect(new URL(page.url()).pathname).toBe("/");
  });
});
