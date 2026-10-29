// The Privacy and Terms pages (privacy.html, terms.html): served at /privacy and /terms with the app's
// headers, readable at 1440 and 390 px in light and dark (the scheme proved first), axe clean, no
// sideways scroll, linked from Settings and the sign-in dialog, and still the page itself (not the
// editor) once the service worker controls the site. Shots go to LEGAL_SHOTS when set.
// The Workbench Pro layout (redesign6/legal): a sidebar with the numbered sections and a scroll spy
// from 1024 px, a Privacy / Terms switch and an "On this page" disclosure below it, copy-link buttons
// that announce in a status toast, and every old #id kept. src/legal/page.ts marks html[data-legal]
// "ready" once it has wired the page; without script the lists are still there (static HTML).
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, hierarchyShots, openApp, openIn, test } from "./helpers";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = [
  { path: "/privacy", title: "Privacy", other: "Terms" },
  { path: "/terms", title: "Terms", other: "Privacy" },
] as const;

/** Every numbered section, in order: [id, number, heading text]. The ids are the pages' old ones. */
const SECTIONS = {
  "/privacy": [
    ["who", "1", "Who runs CodeEditor"],
    ["device", "2", "What stays in your browser"],
    ["running", "3", "Running and charting code"],
    ["github", "4", "If you connect GitHub"],
    ["relay", "4.1", "The sign-in step on CodeEditor's server"],
    ["sharing", "4.2", "Share links"],
    ["hosting", "5", "Hosting"],
    ["remove", "6", "Removing your data"],
    ["changes", "7", "Changes to this page"],
  ],
  "/terms": [
    ["what", "1", "What CodeEditor is"],
    ["code", "2", "Your code"],
    ["use", "3", "Using it fairly"],
    ["warranty", "4", "No guarantee"],
    ["source", "5", "Source code"],
    ["changes", "6", "Changes"],
  ],
} as const;

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function shotsDir(info: TestInfo): string {
  const dir = process.env.LEGAL_SHOTS ? join(process.env.LEGAL_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const ready = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-legal", "ready");
const sidebarToc = (page: Page) => page.getByRole("navigation", { name: "Legal documents" }).locator("ol.legal-toc");
const phoneToc = (page: Page) => page.locator("details.legal-toc-m");
/** The section links the scroll spy marks current (aria-current="true"), in one list. */
const currentIn = (list: Locator) => list.locator('a[aria-current="true"]');

test.describe("legal pages", () => {
  test.use({ serviceWorkers: "block" });

  for (const vp of [
    { name: "desktop", ...DESKTOP },
    { name: "phone", ...PHONE },
  ]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const p of PAGES) {
        test(`${p.title}, ${vp.name} ${scheme}: the page, its theme, axe and no sideways scroll`, async ({ page }, info) => {
          await page.setViewportSize(vp);
          await openIn(page, p.path, scheme);
          await ready(page);
          await expect(page).toHaveTitle(`${p.title} - CodeEditor`);
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
          await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
          const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          expect(ground, "a themed ground, not the browser's").not.toBe("rgba(0, 0, 0, 0)");
          expect(await overflow(page)).toBe(false);
          // Desktop shows the sidebar, a phone the switch and the disclosure: never both.
          await expect(page.getByRole("navigation", { name: "Legal documents" })).toHaveCount(1);
          await expect(sidebarToc(page)).toBeVisible({ visible: vp.name === "desktop" });
          await expect(phoneToc(page)).toBeVisible({ visible: vp.name === "phone" });
          const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          expect(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
          if (vp.name === "phone") {
            // The open list too: 44 px rows, axe clean.
            await phoneToc(page).locator("summary").click();
            await expect(phoneToc(page)).toHaveJSProperty("open", true);
            const rows = await phoneToc(page).locator("a").evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height));
            expect(Math.min(...rows), "phone list rows are 44 px targets").toBeGreaterThanOrEqual(44);
            const open = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
            expect(open.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`)).toEqual([]);
            await phoneToc(page).locator("summary").click();
          }
          const dir = shotsDir(info);
          await page.screenshot({ path: join(dir, `${p.title.toLowerCase()}-${vp.name}-${scheme}.png`), fullPage: true, animations: "disabled" });
          // The first viewport too, to set beside the mockup's shots (redesign6/legal/shots).
          await page.screenshot({ path: join(dir, `${p.title.toLowerCase()}-${vp.name}-${scheme}-view.png`), animations: "disabled" });
          if (vp.name === "desktop") await hierarchyShots(page, join(dir, `${p.title.toLowerCase()}-${scheme}`));
        });
      }
    }
  }

  for (const p of PAGES) {
    test(`${p.title}: every section is numbered, both lists link to it, and the old #ids still resolve`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto(p.path);
      await ready(page);
      const want = SECTIONS[p.path].map(([id, n, text]) => ({ id, label: `${n} ${text}` }));
      const heads = await page.locator("main :is(h2, h3)[id]:not(#short)").evaluateAll((hs) =>
        hs.map((h) => ({ id: h.id, label: (h.textContent ?? "").replace(/\s+/g, " ").trim() })),
      );
      expect(heads).toEqual(want);
      // The short version keeps #short, and both lists have one link per section, in order.
      await expect(page.locator("#short")).toHaveText("The short version");
      for (const list of [sidebarToc(page), phoneToc(page).locator("ol")]) {
        const links = await list.locator("a").evaluateAll((as) =>
          as.map((a) => ({ id: (a.getAttribute("href") ?? "").replace(/^#/, ""), label: (a.textContent ?? "").replace(/\s+/g, " ").trim() })),
        );
        expect(links).toEqual(want);
      }
      // Each copy button is named after its section and sits beside the heading, not inside it.
      for (const [id, n, text] of SECTIONS[p.path]) {
        await expect(page.getByRole("button", { name: `Copy link to section ${n}, ${text}`, exact: true })).toHaveCount(1);
        await expect(page.locator(`#${id} button`)).toHaveCount(0);
      }
      // An old link lands on its heading, and the lists mark it current.
      const [lastId] = SECTIONS[p.path][SECTIONS[p.path].length - 2];
      await page.goto(`${p.path}#${lastId}`);
      await ready(page);
      await expect(page.locator(`#${lastId}`)).toBeInViewport();
      await expect(currentIn(sidebarToc(page))).toHaveAttribute("href", `#${lastId}`);
      // The current document is marked, the other is a link to it.
      const docs = page.getByRole("navigation", { name: "Legal documents" });
      await expect(docs.getByRole("link", { name: p.title, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(docs.getByRole("link", { name: p.other, exact: true })).not.toHaveAttribute("aria-current", /.*/);
    });
  }

  test("desktop: the sidebar follows the reading, and choosing a section marks it", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/privacy");
    await ready(page);
    const side = sidebarToc(page);
    // At the top nothing is read yet.
    await expect(currentIn(side)).toHaveCount(0);
    await side.getByRole("link", { name: "5 Hosting" }).click();
    await expect(page).toHaveURL(/#hosting$/);
    await expect(page.locator("#hosting")).toBeInViewport();
    await expect(currentIn(side)).toHaveAttribute("href", "#hosting");
    // Scrolling on moves the mark: the heading of "Removing your data" to the top of the window.
    await page.mouse.move(800, 400);
    await page.evaluate(() => scrollTo(0, scrollY + document.getElementById("remove")!.getBoundingClientRect().top - 40));
    await expect(currentIn(side)).toHaveAttribute("href", "#remove");
    // A sub-section counts as its own place.
    await page.evaluate(() => scrollTo(0, scrollY + document.getElementById("relay")!.getBoundingClientRect().top - 40));
    await expect(currentIn(side)).toHaveAttribute("href", "#relay");
    // Back at the top, nothing is current again; only ever one mark.
    await page.evaluate(() => scrollTo(0, 0));
    await expect(currentIn(side)).toHaveCount(0);
    // The last section is short: choosing it still marks it, though it can't reach the top.
    await side.getByRole("link", { name: "7 Changes to this page" }).click();
    await expect(currentIn(side)).toHaveAttribute("href", "#changes");
    await expect(currentIn(side)).toHaveCount(1);
  });

  test("desktop: after choosing a section, scrolling back up marks the section being read", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/privacy");
    await ready(page);
    const side = sidebarToc(page);
    await side.getByRole("link", { name: "5 Hosting" }).click();
    await expect(currentIn(side)).toHaveAttribute("href", "#hosting");
    // Hosting can reach the reading line, so the choice holds no pin: scrolling up past 4.2's
    // heading reads 4.2, even with Hosting's heading still in the window.
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => page.evaluate(() => document.getElementById("sharing")!.getBoundingClientRect().top)).toBeLessThan(160);
    expect(await page.evaluate(() => document.getElementById("hosting")!.getBoundingClientRect().top)).toBeLessThan(900);
    await expect(currentIn(side)).toHaveAttribute("href", "#sharing");
  });

  for (const vp of [
    { name: "desktop", ...DESKTOP },
    { name: "phone", ...PHONE },
  ]) {
    test(`${vp.name}: an old link's #id lands its heading at the top, with motion on, after the fonts load`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const id of ["github", "remove"]) {
        // A fresh load each time (from /privacy#a to /privacy#b would only scroll the same document).
        await page.goto("about:blank");
        await page.goto(`/privacy#${id}`);
        await ready(page);
        // page.ts lands the heading again once the fonts have swapped in (they reflow the text above it).
        await expect(page.locator("html")).toHaveAttribute("data-legal-hash", "landed");
        const top = () => page.evaluate((i) => document.getElementById(i)!.getBoundingClientRect().top, id);
        const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop));
        await expect.poll(top, { message: `#${id} at the scroll padding (${pad} px)` }).toBeGreaterThanOrEqual(pad - 1);
        await expect.poll(top, { message: `#${id} at the scroll padding (${pad} px)` }).toBeLessThanOrEqual(pad + 2);
      }
    });
  }

  test("a malformed #fragment (a broken or hand-edited link) doesn't stop the page's script", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize(DESKTOP);
    await page.goto("/privacy#%E0%A4%A");
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-legal-hash", "landed");
    await expect(page.locator(".legal-anchor").first()).toBeVisible();
    // The same after loading, through hashchange.
    await page.evaluate(() => (location.hash = "%E0%A4%A"));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(errors).toEqual([]);
  });

  test("phone: the switch changes document, and the disclosure names the section and closes on a choice", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/privacy");
    await ready(page);
    const toc = phoneToc(page);
    await expect(toc).toHaveAttribute("data-current", "short");
    await toc.locator("summary").click();
    await expect(toc).toHaveJSProperty("open", true);
    await toc.getByRole("link", { name: "4.2 Share links" }).click();
    await expect(toc).toHaveJSProperty("open", false);
    await expect(page).toHaveURL(/#sharing$/);
    await expect(toc).toHaveAttribute("data-current", "sharing");
    await expect(toc.locator("summary")).toContainText("4.2 Share links");
    // The heading isn't hidden under the sticky bar.
    const bar = await toc.boundingBox();
    const head = await page.locator("#sharing").boundingBox();
    expect(head!.y, "heading below the sticky bar").toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    // The bar stays at the top while reading.
    expect(bar!.y).toBeLessThanOrEqual(1);
    // The switch: 36 px items, the current one marked; it opens Terms.
    const seg = page.getByRole("navigation", { name: "Legal documents" });
    await expect(seg.getByRole("link", { name: "Privacy", exact: true })).toHaveAttribute("aria-current", "page");
    const items = await seg.getByRole("link").evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height));
    expect(Math.min(...items)).toBeGreaterThanOrEqual(36);
    await seg.getByRole("link", { name: "Terms", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms");
    // The primary action is 44 px tall on a phone.
    const open = await page.getByRole("link", { name: "Open the editor" }).boundingBox();
    expect(open!.height).toBeGreaterThanOrEqual(44);
  });

  for (const vp of [
    { name: "desktop", ...DESKTOP },
    { name: "phone", ...PHONE },
  ]) {
    test(`${vp.name}: a section's copy button puts its link in the address bar and announces it`, async ({ page, context, browserName }) => {
      await page.setViewportSize(vp);
      if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/privacy");
      await ready(page);
      const button = page.getByRole("button", { name: "Copy link to section 5, Hosting" });
      // Keyboard: the button is reachable and shows when focused.
      await button.focus();
      await expect(button).toBeVisible();
      expect(await button.evaluate((b) => Number(getComputedStyle(b).opacity))).toBe(1);
      const box = await button.boundingBox();
      expect(Math.min(box!.width, box!.height), "a 24 px target at least").toBeGreaterThanOrEqual(24);
      // The live region is in the accessibility tree before it speaks (one that appears with its
      // first text isn't announced by every screen reader).
      const toast = page.getByRole("status");
      await expect(toast).toHaveCount(1);
      await expect(toast).toHaveAttribute("data-state", "idle");
      await page.keyboard.press("Enter");
      // The clipboard can refuse (a browser setting): the toast then says where the link is.
      await expect(toast).toHaveAttribute("data-state", /^(copied|failed)$/);
      await expect(toast).toContainText("section 5");
      await expect(page).toHaveURL(/\/privacy#hosting$/);
      const state = await toast.getAttribute("data-state");
      if (browserName === "chromium") {
        expect(state, "Chromium with the permission copies").toBe("copied");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/privacy#hosting$/);
      }
      // The toast clears itself.
      await expect(toast).toHaveAttribute("data-state", "idle", { timeout: 6000 });
      await expect(toast).toHaveText("");
    });
  }

  test("no sideways scroll at 320 px, on both pages, with the list open", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const p of PAGES) {
      await page.goto(p.path);
      await ready(page);
      expect(await overflow(page), p.path).toBe(false);
      await phoneToc(page).locator("summary").click();
      expect(await overflow(page), `${p.path} list open`).toBe(false);
    }
  });

  test("the keyboard path starts with a skip link to the text", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/terms");
    await ready(page);
    await page.keyboard.press("Tab");
    // Safari leaves links out of the Tab order unless "Press Tab to highlight each item" is on, and
    // Playwright's WebKit differs by platform (about.spec.ts): read it from the browser.
    const skip = page.getByRole("link", { name: "Skip to the text" });
    if (!(await skip.evaluate((a) => a === document.activeElement))) {
      expect(test.info().project.name, "only WebKit may skip links").toBe("webkit");
      await skip.focus();
    }
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });

  test("print leaves only the document", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/privacy");
    await ready(page);
    await page.emulateMedia({ media: "print" });
    for (const sel of ["header.legal-top", "nav.legal-side", "nav.legal-seg", "details.legal-toc-m", "footer.legal-foot", ".legal-next", ".legal-anchor"]) {
      const shown = await page.locator(sel).evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
      expect(shown, sel).toBe(0);
    }
    await expect(page.locator("#hosting")).toBeVisible();
    // A dark screen prints with the light tokens (dark text on paper), and comes back dark.
    await page.emulateMedia({ media: "screen", colorScheme: "dark" });
    await page.reload();
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => dispatchEvent(new Event("beforeprint")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.evaluate(() => dispatchEvent(new Event("afterprint")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("print gives dark text on paper with a dark palette theme too, and restores the theme after", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // A saved palette theme: theme-boot.js paints its colours inline on <html>, over the tokens.
    await page.addInitScript(() => {
      localStorage.setItem("codeeditor:theme-paint", JSON.stringify({
        system: false, scheme: "dark", palette: "palette",
        colors: { bg: "#16191d", surface: "#1b1e23", text: "#e8eaed", "text-secondary": "#c4c7cc", link: "#8ab4f8" },
      }));
    });
    await page.goto("/privacy");
    await ready(page);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-palette", "palette");
    // The title (--text) and the body text (--text-secondary), both painted by the palette.
    const colours = () => page.evaluate(() => ["main h1", "main p"].map((s) => getComputedStyle(document.querySelector(s)!).color));
    const onScreen = await colours();
    expect(onScreen).toEqual(["rgb(232, 234, 237)", "rgb(196, 199, 204)"]);
    await page.evaluate(() => dispatchEvent(new Event("beforeprint")));
    await page.emulateMedia({ media: "print" });
    for (const rgb of await colours()) {
      const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
      expect(Math.max(r, g, b), `printed text ${rgb} is dark`).toBeLessThan(100);
    }
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => dispatchEvent(new Event("afterprint")));
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveAttribute("data-palette", "palette");
    expect(await colours()).toEqual(onScreen);
  });

  test("served with the app's headers, and each page links to the other and back to the editor", async ({ page, request }) => {
    await page.setViewportSize(DESKTOP);
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
      await page.getByRole("navigation", { name: "Legal documents" }).getByRole("link", { name: p.other, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.other);
    }
    // The next-document card at the end leads on too.
    await page.locator(".legal-next").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms");
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

test.describe("legal pages without script", () => {
  test.use({ serviceWorkers: "block", javaScriptEnabled: false });

  for (const vp of [
    { name: "desktop", ...DESKTOP },
    { name: "phone", ...PHONE },
  ]) {
    test(`${vp.name}: both pages read fully, with their section lists`, async ({ page }) => {
      await page.setViewportSize(vp);
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.locator("html")).not.toHaveAttribute("data-legal", /.*/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.title);
        const list = vp.name === "desktop" ? sidebarToc(page) : phoneToc(page).locator("ol");
        if (vp.name === "phone") await phoneToc(page).locator("summary").click();
        await expect(list.locator("a")).toHaveCount(SECTIONS[p.path].length);
        await expect(list.locator("a").first()).toBeVisible();
        const [id] = SECTIONS[p.path][2];
        await list.locator(`a[href="#${id}"]`).click();
        await expect(page.locator(`#${id}`)).toBeInViewport();
        await expect(page.locator(".legal-next")).toBeVisible();
        expect(await overflow(page), p.path).toBe(false);
      }
    });
  }
});

test("with the service worker in control, /privacy, /terms and /licenses.txt are the pages, online and offline", async ({ page, context }) => {
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
      // The page's own script is precached too: offline it still wires the page.
      await ready(page);
    }
    // The licence notice is a file, not an app route: the navigate fallback once answered it with
    // the editor (About, Terms and Settings link to it). It is precached, so it opens offline too.
    const res = await page.goto("/licenses.txt");
    expect(res?.headers()["content-type"], `/licenses.txt ${offline ? "offline" : "online"}`).toMatch(/^text\/plain/);
    expect(await page.evaluate(() => document.body.innerText.split("\n")[0])).toBe("CodeEditor: licences");
    await expect(page.locator("#app")).toHaveCount(0);
    if (!offline) {
      // Any other file opened on its own (the launch video's poster here, as the video's own link
      // would be) comes from the network, not as the editor.
      const poster = /poster="(\/media\/[^"]+\.webp)"/.exec(readFileSync("about.html", "utf8"))![1];
      const shot = await page.goto(poster);
      expect(shot?.headers()["content-type"]).toBe("image/webp");
    }
  }
  await context.setOffline(false);
});
