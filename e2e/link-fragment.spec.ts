// A link's secret never reaches a server (src/ui/link-fragment.ts). A short link's key and a code
// link's code leave the address before any script the host adds can read location: Cloudflare
// injects its Web Analytics beacon before </body> at its edge, and the page's CSP lets it run and
// report to /cdn-cgi/rum. Here a stand-in beacon is injected the same way. It records the address
// the moment it runs and reports location.href (the whole of it, fragment included, unlike the real
// one) at load and on every hashchange. Every request of the context is recorded, and none may
// carry the key or the code: in an editing tab, in a read-only second tab, and for a link pasted
// into an open tab's address bar.
import type { BrowserContext, Page } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { MOVE_TO as ORIGIN } from "../playwright.config";
import { makeCodeLink } from "../src/core/code-link";
import { forgeLink, keyOf, linksSite, type LinksSite } from "./links-fake";
import { expect, openApp, test } from "./helpers";

test.use({ serviceWorkers: "block" });

const BEACON = "https://static.cloudflareinsights.com/beacon.min.js/2026.10.1";
const C_PROGRAM = '#include <stdio.h>\n\nint main(void) {\n    printf("never sent in the clear\\n");\n    return 0;\n}\n';

/** The stand-in beacon: what it saw when it ran, and a report of location.href at load and on hashchange. */
const STUB = `(() => {
  const seen = { atRun: location.href, reports: 0 };
  window.__beaconSeen = seen;
  const report = (when) => {
    seen.reports++;
    fetch("/cdn-cgi/rum", { method: "POST", keepalive: true, body: JSON.stringify({ when, href: location.href, referrer: document.referrer }) });
  };
  report("load");
  addEventListener("hashchange", () => report("hashchange"));
})();`;

/** Injects the stand-in beacon into every page the site serves, as Cloudflare's edge does, and answers its reports. */
async function injectBeacon(context: BrowserContext) {
  await context.route(
    (url) => url.origin === ORIGIN && (url.pathname === "/" || url.pathname.startsWith("/s/")),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      const html = await res.text();
      expect(html).toContain("</body>");
      const tag = `<script defer src="${BEACON}" data-cf-beacon='{"token":"test"}'></script>`;
      return route.fulfill({ response: res, body: html.replace("</body>", `${tag}</body>`) });
    },
  );
  await context.route(BEACON, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", headers: { "Cross-Origin-Resource-Policy": "cross-origin" }, body: STUB }),
  );
  await context.route(`${ORIGIN}/cdn-cgi/rum`, (route) => route.fulfill({ status: 204, body: "" }));
}

async function site(context: BrowserContext): Promise<LinksSite> {
  const s = linksSite(ORIGIN);
  await s.serve(context);
  await injectBeacon(context);
  return s;
}

/** What the stand-in beacon saw when it ran, once it has reported at least `reports` times. */
async function beaconSaw(page: Page, reports = 1): Promise<string> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __beaconSeen?: { reports: number } }).__beaconSeen?.reports ?? 0)).toBeGreaterThanOrEqual(reports);
  return page.evaluate(() => (window as unknown as { __beaconSeen: { atRun: string } }).__beaconSeen.atRun);
}

/** No request (address, headers, body) carries any of `secrets`, and the beacon's reports were among them. */
async function expectNeverSent(s: LinksSite, secrets: (string | Buffer)[], reports: number) {
  const sent = await s.sent();
  const rum = sent.filter((r) => new URL(r.url).pathname === "/cdn-cgi/rum");
  // The check isn't empty: the stand-in beacon ran and reported.
  expect(rum.length).toBeGreaterThanOrEqual(reports);
  for (const r of rum) expect(JSON.parse(r.body!.toString()).href, "the beacon's report").not.toContain("#");
  const carries = (r: (typeof sent)[number], x: string | Buffer) =>
    (r.body !== null && r.body.includes(x)) || (typeof x === "string" && (r.url.includes(x) || Object.values(r.headers).some((v) => v.includes(x))));
  const carrying = sent.filter((r) => secrets.some((x) => carries(r, x))).map((r) => r.url);
  expect(carrying, "requests carrying the secret").toEqual([]);
}

const dialog = (page: Page) => page.locator("dialog#code-link");

async function shortLink(s: LinksSite) {
  const { id, hash } = await forgeLink(s, new Uint8Array([1, ...deflateRawSync(JSON.stringify({ n: "hello.c", t: C_PROGRAM }))]), "Fragment00");
  const key = keyOf(`${ORIGIN}/s/${id}${hash}`);
  return { path: `/s/${id}${hash}`, secrets: [key.text, key.bytes] };
}

async function codeLink() {
  const made = await makeCodeLink(ORIGIN, "hello.c", C_PROGRAM);
  if (!made.ok) throw new Error(made.refusal.kind);
  const hash = made.url.slice(made.url.indexOf("#"));
  return { hash, secrets: [hash.slice("#code=".length), "#code="] };
}

test("a short link's key leaves the address before the beacon runs, and no request carries it", async ({ page, context }) => {
  const s = await site(context);
  const link = await shortLink(s);
  await openApp(page, link.path);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  expect(await beaconSaw(page)).toBe(`${ORIGIN}/`);
  expect(page.url()).toBe(`${ORIGIN}/`);
  await expectNeverSent(s, link.secrets, 1);
});

test("a short link opened in a read-only second tab: the key leaves that address too", async ({ page, context }) => {
  const s = await site(context);
  await openApp(page);
  const link = await shortLink(s);
  const second = await context.newPage();
  await openApp(second, link.path);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await expect(dialog(second)).toHaveAttribute("data-state", "ready");
  await expect(second.locator("#code-link-title")).toHaveText("Open hello.c?");
  expect(await beaconSaw(second)).toBe(`${ORIGIN}/`);
  expect(second.url()).toBe(`${ORIGIN}/`);
  await expectNeverSent(s, link.secrets, 2);
});

test("a code link's code leaves the address before the beacon runs, in an editing and a read-only tab", async ({ page, context }) => {
  const s = await site(context);
  const link = await codeLink();
  await openApp(page, `/${link.hash}`);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  expect(await beaconSaw(page)).toBe(`${ORIGIN}/`);
  expect(page.url()).toBe(`${ORIGIN}/`);
  const second = await context.newPage();
  await openApp(second, `/${link.hash}`);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await expect(dialog(second)).toHaveAttribute("data-state", "ready");
  expect(await beaconSaw(second)).toBe(`${ORIGIN}/`);
  expect(second.url()).toBe(`${ORIGIN}/`);
  await expectNeverSent(s, link.secrets, 2);
});

test("a code link pasted into an open tab's address bar is gone before the beacon's hashchange report", async ({ page, context }) => {
  const s = await site(context);
  await openApp(page);
  await beaconSaw(page);
  const link = await codeLink();
  await page.evaluate((h) => (location.hash = h), link.hash);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await beaconSaw(page, 2);
  expect(page.url()).toBe(`${ORIGIN}/`);
  await expectNeverSent(s, link.secrets, 2);
});
