// Short links (src/core/short-link.ts, src/ui/short-link-ui.ts, server/short-links.ts): made from
// Share link and Choose files only when "Make short link" is pressed, kept for the time picked, and
// opened at /s/<id>#<key> in another browser through the same read-only preview as a code link. The
// function is its real logic over an in-memory store (e2e/links-fake.ts). The key never leaves the
// browser: every request of both profiles is checked. A link that can't be opened (expired, wrong
// key, changed bytes, offline, hostile content) says why and opens nothing. QR codes carry the
// ExecFlow mark when they fit at level H, and are read back from the rendered pixels with jsQR.
import { deflateRawSync } from "node:zlib";
import jsQR from "jsqr";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import { MOVE_TO as ORIGIN } from "../playwright.config";
import { makeCodeLink } from "../src/core/code-link";
import { qrPlan } from "../src/core/qr-plan";
import { shortMakeRefusalText, shortReadRefusalText } from "../src/core/short-link";
import { BRAND_MARK } from "../src/editor/brand-mark";
import { forgeLink, keyOf, linksSite, type LinksSite } from "./links-fake";
import { decodePng, parseHex } from "./pixels";
import { expect, expectActive, importFiles, openApp, setCode, test, tolerating, treeItem, watchContext } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const C_PROGRAM = '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from a short link\\n");\n    return 0;\n}\n';
const dialog = (page: Page) => page.locator("dialog#share-dialog");
const DAY = 86400;

/** Text that hardly compresses (a seeded sequence of letters), `n` characters long. */
function noise(n: number, seed: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join("");
}

/** The day `ms` falls on as the dialogs say it ("29 November 2026"); the browser runs on this machine's clock and zone. */
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

async function serveLinks(page: Page): Promise<LinksSite> {
  const site = linksSite(ORIGIN);
  await site.serve(page.context());
  return site;
}

/** Imports `name` and opens Share link on it (the code link is made at once, as the dialog opens). */
async function openShare(page: Page, name: string, text: string) {
  await openApp(page);
  await importFiles(page, [{ name, text }]);
  await treeItem(page, name).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await expect(dialog(page)).toHaveAttribute("data-state", /^code/);
}

async function chooseShort(page: Page) {
  await page.locator("#share-short").check();
  await expect(dialog(page)).toHaveAttribute("data-state", "short-ready");
  await expect(page.locator("#share-primary")).toHaveText("Make short link");
}

/** Presses Make short link and returns the link it made. */
async function makeShort(page: Page): Promise<string> {
  await page.locator("#share-primary").click();
  await expect(dialog(page)).toHaveAttribute("data-state", "short");
  return page.locator("#share-link").inputValue();
}

/** A short link's address: this site, /s/ and 10 letters or digits, then a 43-character key. */
function expectShortUrl(url: string) {
  const u = new URL(url);
  expect(u.origin).toBe(ORIGIN);
  expect(u.pathname).toMatch(/^[/]s[/][0-9A-Za-z]{10}$/);
  expect(u.hash).toMatch(/^#[0-9A-Za-z_-]{43}$/);
  expect(u.search).toBe("");
}

/** Opens `url` in a fresh browser profile served by the same site, and runs `check` there. */
async function openElsewhere(browser: Browser, site: LinksSite, url: string, info: TestInfo, tolerate: RegExp[], check: (them: Page) => Promise<void>) {
  const other = await browser.newContext({ serviceWorkers: "block" });
  const watch = watchContext(other, info.project.name, tolerate);
  try {
    await site.serve(other);
    const them = await other.newPage();
    await them.goto(url);
    await expect(them.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await check(them);
    expect(watch.settle(), "console errors and failed requests in the second profile").toEqual([]);
  } finally {
    await other.close();
  }
}

/** No request (its address, any header, its body as text or bytes) carries the link's key. */
async function expectKeyNeverSent(site: LinksSite, url: string) {
  const key = keyOf(url);
  expect(key.bytes.length).toBe(32);
  const sent = await site.sent();
  // The check isn't empty: the link was stored and fetched through the recorded requests.
  expect(sent.some((r) => new URL(r.url).pathname === "/api/links" && r.body !== null)).toBe(true);
  expect(sent.some((r) => /^[/]api[/]links[/][0-9A-Za-z]{10}$/.test(new URL(r.url).pathname))).toBe(true);
  const carrying = sent
    .filter((r) => r.url.includes(key.text) || Object.values(r.headers).some((v) => v.includes(key.text)) || (r.body !== null && (r.body.includes(key.text) || r.body.includes(key.bytes))))
    .map((r) => r.url);
  expect(carrying, "requests carrying the key").toEqual([]);
}

// ---------------------------------------------------------------- Share link

test("Share: a short link is made only on the press, kept 30 days, opened in another browser; no request carries the key", async ({ page, browser, tolerate }, info) => {
  const site = await serveLinks(page);
  await openShare(page, "hello.c", C_PROGRAM);
  await chooseShort(page);
  await expect(page.locator("#share-ttl")).toHaveValue(String(30 * DAY));
  await expect(page.locator("#share-ttl-note")).toContainText("Nothing is sent before you press Make short link.");
  // Choosing it sent nothing.
  expect((await site.sent()).filter((r) => r.url.includes("/api/links"))).toEqual([]);
  const url = await makeShort(page);
  expectShortUrl(url);
  await expect(page.locator("#share-result")).toContainText(`Made a short link, kept until ${dayOf(Date.now() + 30 * DAY * 1000)}.`);
  await expect(page.locator("#share-primary")).toHaveText("Copy link");
  await expect(page.locator("#share-primary")).toBeFocused();
  // One stored link, kept 30 days, holding no readable code.
  expect([...site.data.values()].map((s) => s.ttl)).toEqual([30 * DAY]);
  const [stored] = [...site.data.values()];
  expect(Buffer.from(stored.bytes).includes("Hello from a short link")).toBe(false);
  expect(Buffer.from(stored.bytes).includes("hello.c")).toBe(false);

  await openElsewhere(browser, site, url, info, tolerate, async (them) => {
    const open = them.locator("dialog#code-link");
    await expect(open).toHaveAttribute("data-state", "ready");
    await expect(them.locator("#code-link-title")).toHaveText("Open hello.c?");
    await expect(them.locator("#code-link-preview")).toHaveText(C_PROGRAM.replace(/\n$/, ""));
    // The key has left the address bar, and so has the id: a reload or a bookmark keeps neither.
    expect(them.url()).toBe(`${ORIGIN}/`);
    await expect(them.locator(".notice")).not.toContainText("Opening the short link");
    await them.locator("#code-link-add").click();
    await expectActive(them, "hello.c");
    await expect(them.locator("#app")).not.toHaveAttribute("data-run", /running|waiting/);
  });
  await expectKeyNeverSent(site, url);
});

test("Share: the expiry picked is the one stored, and a double press makes one link", async ({ page }) => {
  const site = await serveLinks(page);
  await openShare(page, "hello.c", C_PROGRAM);
  await chooseShort(page);
  await page.locator("#share-ttl").selectOption(String(DAY));
  await page.locator("#share-primary").dblclick();
  await expect(dialog(page)).toHaveAttribute("data-state", "short");
  await expect(page.locator("#share-link-note")).toContainText(`until ${dayOf(Date.now() + DAY * 1000)}, when ExecFlow's server deletes the encrypted copy`);
  expect([...site.data.values()].map((s) => s.ttl)).toEqual([DAY]);
  // Back to the code link and again to the short link: the same link, not a second one.
  const url = await page.locator("#share-link").inputValue();
  await page.locator("#share-code").check();
  await page.locator("#share-short").check();
  await expect(page.locator("#share-link")).toHaveValue(url);
  expect(site.data.size).toBe(1);
});

test("Share: a file too long for a code link offers a short link instead, which holds it", async ({ page, browser, tolerate }, info) => {
  const site = await serveLinks(page);
  const text = `${noise(12000, 11)}\n`;
  await openShare(page, "data.txt", text);
  await expect(dialog(page)).toHaveAttribute("data-state", "code-refused");
  await expect(page.locator("#share-pending")).toContainText("Make a short link instead");
  // The sentence and the button: no empty band below the last of them.
  expect(await page.locator("#share-pending + .share-more").count()).toBe(1);
  await page.locator("#share-use-short").click();
  await expect(dialog(page)).toHaveAttribute("data-state", "short-ready");
  await expect(page.locator("#share-short")).toBeChecked();
  await expect(page.locator("#share-ttl")).toBeFocused();
  const url = await makeShort(page);
  expectShortUrl(url);
  await openElsewhere(browser, site, url, info, tolerate, async (them) => {
    await expect(them.locator("dialog#code-link")).toHaveAttribute("data-state", "ready");
    expect(await them.locator("#code-link-preview").textContent()).toBe(text);
  });
});

test.describe("Share: a short link that can't be made says why", () => {
  test.use(tolerating(/^HTTP (429|503): http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]api[/]links[?]ttl=/, /^Failed to load resource: the server responded with a status of (429|503)/));

  test("offline: nothing is sent; busy (429) and full (503) say so; then it is made", async ({ page, context }) => {
    const site = await serveLinks(page);
    await openShare(page, "hello.c", C_PROGRAM);
    await chooseShort(page);
    await context.setOffline(true);
    await page.locator("#share-primary").click();
    await expect(page.locator("#share-result")).toHaveText(shortMakeRefusalText({ kind: "offline" }));
    await expect(dialog(page)).toHaveAttribute("data-state", "short-ready");
    expect((await site.sent()).filter((r) => r.url.includes("/api/links"))).toEqual([]);
    await context.setOffline(false);
    for (const [status, kind] of [[429, "busy"], [503, "unavailable"]] as const) {
      site.answer(status);
      await page.locator("#share-primary").click();
      await expect(page.locator("#share-result")).toHaveText(shortMakeRefusalText({ kind }));
      await expect(page.locator("#share-result")).toHaveAttribute("data-tone", "error");
      await expect(dialog(page)).toHaveAttribute("data-state", "short-ready");
      await expect(page.locator("#share-primary")).toHaveText("Make short link");
    }
    expect(shortMakeRefusalText({ kind: "unavailable" })).toContain("1,000 new short links a day");
    site.answer(null);
    expectShortUrl(await makeShort(page));
    expect(site.data.size).toBe(1);
  });
});

// ---------------------------------------------------------------- QR codes

/** jsQR's reading of an element's screenshot (the rendered SVG), or null. */
async function readQr(code: Locator, keep?: string): Promise<string | null> {
  const png = decodePng(await code.screenshot({ animations: "disabled", path: keep }));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      [data[i], data[i + 1], data[i + 2]] = png.at(x, y);
      data[i + 3] = 255;
    }
  }
  return jsQR(data, png.width, png.height)?.data ?? null;
}

/** The share of the mark's tile (inside its rounded corners) painted white, near black, or in colour. */
async function markPaint(code: Locator) {
  const png = decodePng(await code.screenshot({ animations: "disabled" }));
  const geo = await code.evaluate((s) => {
    const mark = s.querySelector(".share-qr-mark")!;
    return { n: (s as SVGSVGElement).viewBox.baseVal.width, at: Number(mark.getAttribute("x")), size: Number(mark.getAttribute("width")) };
  });
  const k = png.width / geo.n;
  const { tile, view } = BRAND_MARK;
  const inset = tile.radius / 2;
  const from = (geo.at + ((tile.x + inset) / view) * geo.size) * k;
  const to = (geo.at + ((tile.x + tile.size - inset) / view) * geo.size) * k;
  let white = 0;
  let dark = 0;
  let colour = 0;
  for (let y = Math.ceil(from); y < Math.floor(to); y++) {
    for (let x = Math.ceil(from); x < Math.floor(to); x++) {
      const [r, g, b] = png.at(x, y);
      if (Math.min(r, g, b) >= 235) white++;
      else if (Math.max(r, g, b) <= 40) dark++;
      else colour++;
    }
  }
  const all = white + dark + colour;
  return { white: white / all, dark: dark / all, colour: colour / all, pixels: all };
}

for (const scheme of ["light", "dark"] as const) {
  test(`QR: a short link's code carries the ExecFlow mark at level H and reads back as the link, ${scheme}`, async ({ page }) => {
    await serveLinks(page);
    await openShare(page, "hello.c", C_PROGRAM);
    // Emulated after the page loaded (Firefox drops one set before the first navigation), then proven.
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await chooseShort(page);
    const url = await makeShort(page);
    await page.locator("#share-qr-toggle").click();
    await expect(dialog(page)).toHaveAttribute("data-qr", "shown");
    const code = page.locator("#share-qr");
    await expect(code).toHaveAttribute("data-ecc", "H");
    await expect(code).toHaveAttribute("aria-label", "QR code of the link to hello.c");
    const plan = qrPlan(url)!;
    expect(plan.ecc).toBe("H");
    expect(plan.mark).not.toBeNull();
    // The mark is the brand mark's own drawing, at the planned place, in its fixed colours.
    const mark = code.locator(".share-qr-mark");
    await expect(mark).toHaveAttribute("x", String(plan.mark!.markAt));
    await expect(mark).toHaveAttribute("width", String(plan.mark!.markSize));
    await expect(mark.locator("path")).toHaveAttribute("stroke", BRAND_MARK.glyph.stroke);
    expect(Math.min(...parseHex(BRAND_MARK.glyph.stroke).rgb), "the glyph is white").toBeGreaterThanOrEqual(250);
    // Painted: a tile in colour (neither the code's white nor its black) with the white glyph on it.
    const paint = await markPaint(code);
    expect(paint.pixels).toBeGreaterThan(100);
    expect(paint.colour, `tile ${JSON.stringify(paint)}`).toBeGreaterThan(0.5);
    expect(paint.white, `glyph ${JSON.stringify(paint)}`).toBeGreaterThan(0.05);
    expect(paint.dark, `no code modules under the mark ${JSON.stringify(paint)}`).toBeLessThan(0.02);
    // The cleared area stays within the planned share of the symbol (qr-plan.ts MARK_AREA_MAX).
    const symbol = plan.size - 8;
    expect((plan.mark!.clear * plan.mark!.clear) / (symbol * symbol)).toBeLessThanOrEqual(0.07);
    // Read back from the pixels as shown in the dialog.
    expect(await readQr(code, test.info().outputPath(`qr-short-${scheme}.png`))).toBe(url);
  });
}

test("QR: code links are marked at level H up to 1,273 characters, plain level L past it; both read back", async ({ page }) => {
  /** A text whose code link is between `min` and `max` characters long. */
  const sized = async (name: string, min: number, max: number, seed: number) => {
    for (let n = 200; n < 6000; n += 25) {
      const text = noise(n, seed);
      const made = await makeCodeLink(ORIGIN, name, text);
      if (made.ok && made.url.length >= min && made.url.length <= max) return { text, url: made.url };
    }
    throw new Error(`no text makes a link of ${min} to ${max} characters`);
  };
  await openApp(page);
  for (const [want, min, max, seed] of [["H", 1150, 1273, 3], ["L", 2000, 2600, 5]] as const) {
    const name = `${want}.txt`;
    const { text } = await sized(name, min, max, seed);
    await importFiles(page, [{ name, text }]);
    await treeItem(page, name).locator(":scope > .tree-row").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Share link..." }).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "code");
    // Sized in Node; each engine's own compressor may differ by a few bytes, so the length is checked.
    const shown = await page.locator("#share-link").inputValue();
    expect(shown.length, want).toBeGreaterThanOrEqual(min - 40);
    expect(shown.length, want).toBeLessThanOrEqual(max);
    expect(qrPlan(shown)!.ecc, want).toBe(want);
    await page.locator("#share-qr-toggle").click();
    await expect(dialog(page)).toHaveAttribute("data-qr", "shown");
    const code = page.locator("#share-qr");
    await expect(code).toHaveAttribute("data-ecc", want);
    await expect(code.locator(".share-qr-mark")).toHaveCount(want === "H" ? 1 : 0);
    if (shown.length > 1200) await expect(page.locator("#share-qr-box")).toContainText("A long link makes a dense code");
    // The dialog fits the code to 360 px (under 3 px a module here), so for reading, the same SVG with
    // its computed colours is drawn at its own 4 px a module on a page of its own, by the same engine.
    const markup = await code.evaluate((s) => {
      const copy = s.cloneNode(true) as SVGSVGElement;
      for (const cls of ["share-qr-light", "share-qr-dark"]) copy.querySelector(`.${cls}`)!.setAttribute("fill", getComputedStyle(s.querySelector(`.${cls}`)!).fill);
      return copy.outerHTML;
    });
    const sheet = await page.context().newPage();
    await sheet.setContent(`<body style="margin:0;background:#fff">${markup}</body>`);
    expect(await readQr(sheet.locator("svg").first(), test.info().outputPath(`qr-code-link-${want}.png`)), want).toBe(shown);
    await sheet.close();
    await page.locator("#share-cancel").click();
    await expect(dialog(page)).toHaveCount(0);
  }
});

// ---------------------------------------------------------------- Choose files

async function create(page: Page, path: string, text: string) {
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await field.fill(path);
  await field.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
  await setCode(page, text);
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
}

async function openChooser(page: Page) {
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Choose files to download or share..." }).click();
  const chooser = page.locator("dialog#choose-files");
  await expect(chooser).toHaveAttribute("data-state", "ready");
  return chooser;
}

test("Choose files: a folder as a short link kept 90 days; another browser opens it as a new folder", async ({ page, browser, tolerate }, info) => {
  const site = await serveLinks(page);
  await openApp(page);
  await create(page, "lab1/main.c", '#include "util.h"\nint main(void) { return twice(0); }\n');
  await create(page, "lab1/util.h", "static inline int twice(int x) { return 2 * x; }\n");
  const chooser = await openChooser(page);
  await chooser.locator('input[data-path="lab1"]').check();
  await expect(chooser).not.toHaveAttribute("data-short", /./);
  await chooser.locator("#choose-share").click();
  await expect(chooser).toHaveAttribute("data-state", "shared");
  await expect(chooser).toHaveAttribute("data-short", "ready");
  expect((await site.sent()).filter((r) => r.url.includes("/api/links"))).toEqual([]);
  await chooser.locator("#choose-ttl").selectOption(String(90 * DAY));
  await chooser.locator("#choose-short").click();
  await expect(chooser).toHaveAttribute("data-short", "made");
  await expect(chooser.locator("#choose-short-copy")).toBeFocused();
  const url = await chooser.locator("#choose-short-link").inputValue();
  expectShortUrl(url);
  await expect(chooser.locator("#choose-result")).toContainText(`Made a short link, kept until ${dayOf(Date.now() + 90 * DAY * 1000)}.`);
  expect([...site.data.values()].map((s) => s.ttl)).toEqual([90 * DAY]);
  // Ticking something else takes the short link away: it holds what was ticked when it was made.
  await chooser.locator('input[data-path="lab1/util.h"]').uncheck();
  await expect(chooser).not.toHaveAttribute("data-short", /./);
  await expect(chooser.locator("#choose-short-link")).toBeHidden();

  await openElsewhere(browser, site, url, info, tolerate, async (them) => {
    const open = them.locator("dialog.code-link");
    await expect(open).toHaveAttribute("data-state", "ready");
    await expect(open.locator(".dialog-title")).toHaveText("Open the folder lab1?");
    await open.locator("#code-link-add").click();
    await expect(treeItem(them, "lab1/main.c")).toBeVisible();
    await expect(treeItem(them, "lab1/util.h")).toBeVisible();
  });
  await expectKeyNeverSent(site, url);
});

test("Choose files: files too big for a code link still make a short link", async ({ page }) => {
  const site = await serveLinks(page);
  await openApp(page);
  await create(page, "big/more.txt", "x\n");
  await importFiles(page, [{ name: "data.txt", text: `${noise(14000, 3)}\n` }]);
  await expect(treeItem(page, "big/data.txt")).toBeVisible();
  const chooser = await openChooser(page);
  await chooser.locator('input[data-path="big"]').check();
  await chooser.locator("#choose-share").click();
  await expect(chooser.locator("#choose-result")).toContainText(/These files are too big for a link [(]it would be [0-9,]+ characters[)].* Make a short link below, or download them as a [.]zip[.]/);
  await expect(chooser).toHaveAttribute("data-state", "ready");
  await expect(chooser).toHaveAttribute("data-short", "ready");
  await expect(chooser.locator("#choose-short")).toBeFocused();
  await chooser.locator("#choose-short").click();
  await expect(chooser).toHaveAttribute("data-short", "made");
  expectShortUrl(await chooser.locator("#choose-short-link").inputValue());
  expect(site.data.size).toBe(1);
});

// ---------------------------------------------------------------- opening

const notice = (page: Page) => page.locator(".notice");

test("/s/<id> serves the editor with its icons and theme script from the site root", async ({ page }) => {
  await serveLinks(page);
  await openApp(page, "/s/AAAAAAAAAA");
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")].map((l) => l.href));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(new URL(href).pathname, href).not.toMatch(/^[/]s[/]/);
    expect(await page.evaluate((h) => fetch(h).then((r) => r.status), href), href).toBe(200);
  }
  // No key: damaged, before anything is fetched.
  await expect(notice(page)).toContainText(shortReadRefusalText({ kind: "damaged" }));
});

test.describe("a short link that can't be opened says why and opens nothing", () => {
  test.use(
    tolerating(
      /^HTTP 404: http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]api[/]links[/][0-9A-Za-z]{10}$/,
      /^Failed to load resource: the server responded with a status of 404/,
      /^request failed: http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]api[/]links[/][0-9A-Za-z]{10} /,
    ),
  );

  /** A real link made in Node against the same site, for the cases that need one. */
  async function realLink(site: LinksSite) {
    return forgeLink(site, new Uint8Array([1, ...deflateRawSync(JSON.stringify({ n: "hello.c", t: C_PROGRAM }))]), "Rea1L1nk00");
  }

  async function expectRefused(page: Page, site: LinksSite, path: string, text: string, fetched: boolean) {
    await openApp(page, path);
    await expect(notice(page)).toContainText(text);
    await expect(page.locator("dialog#code-link")).toHaveCount(0);
    await expect(treeItem(page, "hello.c")).toHaveCount(0);
    const asked = (await site.sent()).filter((r) => r.url.includes("/api/links"));
    expect(asked.length, "requests to /api/links").toBe(fetched ? 1 : 0);
  }

  test("expired or unknown: says so", async ({ page }) => {
    const site = await serveLinks(page);
    const { hash } = await realLink(site);
    await expectRefused(page, site, `/s/Exp1redL1n${hash}`, shortReadRefusalText({ kind: "gone" }), true);
    expect(page.url()).toBe(`${ORIGIN}/`);
  });

  test("the right id with another key: damaged", async ({ page }) => {
    const site = await serveLinks(page);
    const { id } = await realLink(site);
    const other = `#${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    await expectRefused(page, site, `/s/${id}${other}`, shortReadRefusalText({ kind: "damaged" }), true);
  });

  test("stored bytes changed on the way: damaged", async ({ page }) => {
    const site = await serveLinks(page);
    const { id, hash } = await realLink(site);
    site.data.get(`link:${id}`)!.bytes[40] ^= 1;
    await expectRefused(page, site, `/s/${id}${hash}`, shortReadRefusalText({ kind: "damaged" }), true);
  });

  test("a key or id of the wrong shape: damaged, and nothing is fetched", async ({ page }) => {
    const site = await serveLinks(page);
    const { id, hash } = await realLink(site);
    await expectRefused(page, site, `/s/${id}${hash.slice(0, -1)}`, shortReadRefusalText({ kind: "damaged" }), false);
    await expectRefused(page, site, `/s/abc${hash}`, shortReadRefusalText({ kind: "damaged" }), false);
  });

  test("offline: says so, and nothing is fetched", async ({ page }) => {
    const site = await serveLinks(page);
    const { id, hash } = await realLink(site);
    // navigator.onLine false from the first script on (helpers.ts: the page sees only the test's network state).
    await page.addInitScript(() => void ((globalThis as { __testOffline?: boolean }).__testOffline = true));
    await expectRefused(page, site, `/s/${id}${hash}`, shortReadRefusalText({ kind: "offline" }), false);
  });

  test.describe("the server can't be reached", () => {
    // Each engine's own words for the refused connection (Chromium: the console line).
    test.use(tolerating(/^Failed to load resource: net::ERR_CONNECTION_REFUSED$/, /^request failed: http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]api[/]links[/][0-9A-Za-z]{10} /));
    test("says so", async ({ page }) => {
      const site = await serveLinks(page);
      const { id, hash } = await realLink(site);
      await page.route(/[/]api[/]links[/]/, (route) => route.abort("connectionrefused"));
      await expectRefused(page, site, `/s/${id}${hash}`, shortReadRefusalText({ kind: "unavailable" }), true);
    });
  });

  test("hostile content is refused as a code link's is: a path that climbs out, too many files", async ({ page }) => {
    const site = await serveLinks(page);
    const climb = await forgeLink(site, new Uint8Array([1, ...deflateRawSync(JSON.stringify({ n: "../evil.c", t: "int x;" }))]), "C1imbOut00");
    await expectRefused(page, site, `/s/${climb.id}${climb.hash}`, "This short link's file name can't be used", true);
    await expect(treeItem(page, "evil.c")).toHaveCount(0);
    const files = Array.from({ length: 51 }, (_, i) => ({ n: `f${i}.c`, t: "int x;" }));
    const many = await forgeLink(site, new Uint8Array([2, ...deflateRawSync(JSON.stringify({ d: "lab", f: files }))]), "TooMany000");
    await page.goto(`/s/${many.id}${many.hash}`);
    await expect(notice(page)).toContainText(shortReadRefusalText({ kind: "too-many" }));
    await expect(page.locator("dialog#code-link")).toHaveCount(0);
    await expect(treeItem(page, "lab")).toHaveCount(0);
  });
});

test.describe("the opener's code can't load", () => {
  test.use(
    tolerating(
      /^HTTP 404: http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]assets[/][^/]+[.]js$/,
      /^Failed to load resource: the server responded with a status of 404/,
      // Each engine also reports the refused module script as a failed request, in its own words.
      /^request failed: http:[/][/]127[.]0[.]0[.]1:[0-9]+[/]assets[/][^/ ]+[.]js (net::ERR_ABORTED|NS_ERROR_CORRUPTED_CONTENT|Load request cancelled)$/,
    ),
  );

  test("says so in the notice, and opens nothing", async ({ page }) => {
    const site = await serveLinks(page);
    const { id, hash } = await forgeLink(site, new Uint8Array([1, ...deflateRawSync(JSON.stringify({ n: "hello.c", t: C_PROGRAM }))]), "Chunk00000");
    // The code-link dialog's chunk (its own text says which one it is) answers 404.
    await page.route("**/assets/*.js", async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      if (body.includes("Opening the short link")) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ response: res, body });
    });
    await openApp(page, `/s/${id}${hash}`);
    await expect(notice(page)).toContainText("The short link couldn't open. Check the connection, then reload the page.");
    await expect(page.locator("dialog#code-link")).toHaveCount(0);
  });
});
