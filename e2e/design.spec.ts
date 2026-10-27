import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { afterFetch, expect, expectActive, hierarchyShots, importFiles, openApp, openFromTree, reloadApp, responseBodies, run, showPanel, showView, test, tolerating, waitReady } from "./helpers";

// Desktop and phone, light and dark. Each test loads, emulates, reloads and
// proves the theme is really active before checking anything. These reload right after the first
// load, so the service worker is left out (it is not what they test).
test.use({ serviceWorkers: "block" });
const SHOTS = process.env.SHOTS_DIR ?? "e2e/shots";
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function openThemed(page: Page, scheme: "light" | "dark", reducedMotion: "reduce" | "no-preference" = "no-preference") {
  await page.goto("/");
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  // And the colours really are that scheme's (CodeEditor Signal, the default: data-palette="signal").
  await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === "dark" ? "rgb(14, 17, 22)" : "rgb(252, 252, 253)");
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Run's painted fill (pointer moved off it first): transparent when it has stepped back to its outline style. */
async function runFill(page: Page) {
  await page.mouse.move(4, 4);
  return page.locator("#run-button").evaluate((el) => getComputedStyle(el).backgroundColor);
}
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

async function axe(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

for (const vp of viewports) {
  for (const scheme of ["light", "dark"] as const) {
    test(`workbench ${vp.name} ${scheme}: theme, overflow, accessibility, hierarchy`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      const dir = `${SHOTS}/${testInfo.project.name}`;
      await page.setViewportSize(vp);
      await openThemed(page, scheme);

      const narrow = vp.width < 900;

      // 1. Empty workspace: the starters lead (reading order 4). Nothing competes with them: no
      // Run (there is nothing to run) and no output panel (layout v2; v1 showed an inert Run).
      await expect(page.getByRole("heading", { name: "Create your first file" })).toBeInViewport();
      await expect(page.locator('.starter[data-language="python"]')).toBeInViewport();
      await expect(page.locator("#run-button")).toBeHidden();
      await expect(page.locator("#panel")).toBeHidden();
      expect(await noOverflow(page), "no horizontal scroll (empty)").toBe(true);
      await page.screenshot({ path: `${dir}/empty-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "empty");

      // 2. Editing, with a program that has an error: code first, Run, then the result.
      await importFiles(page, [
        { name: "main.py", text: 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n' },
        { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
      ]);
      await openFromTree(page, "main.py");
      await showView(page, "code");
      await expect(page.locator(".cm-content")).toBeInViewport();
      await expect(page.locator("#run-button")).toBeInViewport();
      expect(await noOverflow(page), "no horizontal scroll (editing)").toBe(true);
      const editorBox = (await page.locator("#editor-panel").boundingBox())!;
      if (narrow) {
        // No tab strip: the code starts under the top bar (48) and the view switch (44).
        expect(Math.round(editorBox.y), "chrome above the first code line on a phone").toBe(92);
      } else {
        // Before the first run the panel is its bar: collapsed, its body hidden, the code tall.
        await expect(page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator("#panel-output")).toBeHidden();
        await expect(page.locator("#panel-problems")).toBeHidden();
        expect(editorBox.height, "code height before the first run").toBeGreaterThanOrEqual(700);
      }
      await page.screenshot({ path: `${dir}/editor-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "editor");

      // 3. Waiting for input (reading order 2): the field is focused and in view; Run opened the panel.
      await page.locator("#run-button").click();
      await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
      await expect(page.locator("#live-input-field")).toBeFocused();
      await expect(page.locator("#live-input-field")).toBeInViewport();
      if (!narrow) await expect(page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#panel-output")).toBeVisible();
      await page.screenshot({ path: `${dir}/waiting-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "waiting");
      await page.locator("#live-input-field").fill("Ada");
      await page.locator("#live-input-field").press("Enter");
      await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      expect(await noOverflow(page), "no horizontal scroll (ran)").toBe(true);
      await page.screenshot({ path: `${dir}/ran-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "ran");
      await hierarchyShots(page, `${dir}/ran-${vp.name}-${scheme}`);

      // 3b. After the failed run (reading order 1): Run steps back to its outline style.
      await expect(page.locator("#app")).toHaveAttribute("data-last-run", "failed");
      expect(await runFill(page), "Run has stepped back").toMatch(TRANSPARENT);
      if (!narrow) {
        // The error is in calc.py: the editor head's jump names it, Tab reaches it from the
        // tabs, and it opens calc.py at line 2 with the focus in the code.
        const jump = page.locator(".editor-head #error-jump");
        await expect(jump).toBeVisible();
        await expect(jump).toHaveAccessibleName("Error in calc.py, line 2");
        await page.locator('.tabs [role=tab][aria-selected="true"]').focus();
        await page.keyboard.press("Tab");
        await expect(jump).toBeFocused();
        await page.screenshot({ path: `${dir}/ran-jump-${vp.name}-${scheme}.png`, animations: "disabled" });
        await page.keyboard.press("Enter");
        await expect(page.locator('.cm-content[aria-label="Code editor, calc.py"]')).toBeFocused();
        await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
        await expect(jump).toBeHidden();
      } else {
        await showView(page, "code");
        await page.locator(".cm-content").click();
      }
      // One typed character (a space at the end of the file) and Run is the filled action again.
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" ");
      await expect(page.locator("#app")).not.toHaveAttribute("data-last-run");
      expect(await runFill(page), "Run is filled again after an edit").not.toMatch(TRANSPARENT);

      // 4. Problems.
      await showPanel(page, "problems");
      await expect(page.locator(".problem").first()).toBeVisible();
      await axe(page, "problems");

      // 5. Settings dialog.
      await page.locator("#settings-button").click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await page.screenshot({ path: `${dir}/settings-${vp.name}-${scheme}.png`, animations: "disabled" });
      await hierarchyShots(page, `${dir}/settings-${vp.name}-${scheme}`);
      await axe(page, "settings");
      await page.keyboard.press("Escape");

      // 6. Narrow screens: the file drawer.
      if (vp.width < 900) {
        await page.locator(".drawer-toggle").click();
        await expect(page.locator("#sidebar")).toBeInViewport();
        await page.screenshot({ path: `${dir}/drawer-${vp.name}-${scheme}.png`, animations: "disabled" });
        await axe(page, "drawer");
        await page.keyboard.press("Escape");
        await expect(page.locator(".drawer-toggle")).toBeFocused();
      }
    });
  }
}

test("no horizontal scroll at 320 px, and the primary controls are 44 px on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  expect(await noOverflow(page)).toBe(true);
  await page.locator('.starter[data-language="cpp"]').click();
  // Run shows once a file is open (layout v2: none on the empty workspace).
  await expectActive(page, "main.cpp");
  expect(await noOverflow(page)).toBe(true);
  for (const sel of ["#run-button", "#settings-button", ".drawer-toggle", "#view-code", "#view-output", "#view-problems"]) {
    const box = await page.locator(sel).boundingBox();
    expect(box!.height, sel).toBeGreaterThanOrEqual(44);
  }
});

// Budget: initial-route JS about 200 KB gzip. The shell is measured on a first visit (empty
// workspace); CodeMirror (about 196 KB gzip on its own) must not be part of it, and must arrive
// with the first file.
test("a first visit loads only the shell, within the 200 KB gzip budget, and the editor comes with the first file", async ({ page }) => {
  // App chunks; workers live under /assets/w/. Chunks that arrive after the last check are not read
  // to the end of the test (responseBodies).
  const bodies = responseBodies(page, (path) => /^\/assets\/[^/]+\.js$/.test(path), (path, b) => ({ url: path, gzip: gzipSync(b).length }));
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  const first = await bodies.settled();
  const total = first.reduce((n, s) => n + s.gzip, 0);
  expect(first.length, "scripts loaded").toBeGreaterThan(0);
  expect(total, `first-visit JS gzip: ${first.map((s) => `${s.url} ${s.gzip}`).join(", ")}`).toBeLessThan(200 * 1024);
  test.info().annotations.push({ type: "first-visit JS gzip", description: `${total} bytes in ${first.length} chunks` });
  await expect(page.locator(".cm-editor")).toHaveCount(0);

  const before = bodies.count();
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  expect(bodies.count(), "the editor chunk loaded with the first file").toBeGreaterThan(before);
});

// The built chunks themselves (completion-chunk.test.ts models the bundler from the source): the
// suggestion code (completion-code.ts) is a chunk of its own, which a first visit doesn't load and
// the editor chunk doesn't contain, and the editor chunk stays within the same 200 KB gzip budget
// (research doc section 3, "Bundle size"). The suggestion chunk is found by its content:
// library-data.ts's error text, which only that chunk has.
test("the suggestion code is a chunk of its own, apart from the first visit and the editor chunk, which stays within 200 KB gzip", async ({ page }) => {
  const MARK = "not library data";
  const bodies = responseBodies(page, (path) => /^\/assets\/[^/]+\.js$/.test(path), (path, b) => ({ url: path, gzip: gzipSync(b).length, suggestions: b.includes(MARK) }));
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  const first = await bodies.settled();
  expect(first.filter((c) => c.suggestions).map((c) => c.url), "suggestion code on a first visit").toEqual([]);
  await page.locator('.starter[data-language="c"]').click();
  // The library data is there: the suggestion code has loaded and run.
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-library", "ready");
  const later = (await bodies.settled()).slice(first.length);
  expect(later.length, "scripts loaded with the first file").toBeGreaterThan(0);
  const editorChunk = later.reduce((a, b) => (b.gzip > a.gzip ? b : a));
  const suggestions = later.filter((c) => c.suggestions);
  test.info().annotations.push({ type: "editor chunks, gzip", description: later.map((c) => `${c.url} ${c.gzip}${c.suggestions ? " (suggestions)" : ""}`).join(", ") });
  expect(suggestions.length, "chunks with the suggestion code").toBe(1);
  expect(suggestions[0].url, "the suggestion code is not in the editor chunk").not.toBe(editorChunk.url);
  expect(editorChunk.gzip, `the editor chunk ${editorChunk.url}, gzip`).toBeLessThanOrEqual(200 * 1024);
});

test("reduced motion turns transitions off", async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await page.locator("#settings-button").evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe("0s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await page.locator("#settings-button").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("a theme chosen in Settings applies at once, and is painted on the next load before the app's code runs", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").click();
  // Dracula is a popular editor theme: folded under More themes (review D, 2026-10-18).
  await page.getByRole("dialog", { name: "Settings" }).locator(".theme-more summary").click();
  await page.getByRole("radio", { name: "Dracula" }).check();
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(40, 42, 54)"); // Dracula's editor background #282a36
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");

  // Hold every app script back: public/theme-boot.js alone must paint the saved theme.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  await page.locator("#app").waitFor({ state: "attached" });
  expect(await bg()).toBe("rgb(40, 42, 54)");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  release();
  await waitReady(page);
});

/** Reloads with every app script held back, so only public/theme-boot.js and the CSS can paint; then releases them. */
async function reloadHeld(page: Page, check: () => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  await page.locator("#app").waitFor({ state: "attached" });
  await check();
  release();
  await waitReady(page);
  await page.unroute("**/assets/*.js");
}

test("Slate stays a picker theme: chosen in Settings, painted before the app's code, and kept by a device that saved it", async ({ page }) => {
  await openApp(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-palette", "signal");
  await page.locator("#settings-button").click();
  // Slate (v1's palette) is folded under More themes (review D, 2026-10-18).
  await page.getByRole("dialog", { name: "Settings" }).locator(".theme-more summary").click();
  await page.getByRole("radio", { name: "CodeEditor Slate Dark" }).check();
  expect(await bg()).toBe("rgb(14, 18, 23)"); // Slate's dark code ground #0e1217
  await expect(html).toHaveAttribute("data-palette", "slate");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");

  await reloadHeld(page, async () => {
    await expect.poll(bg).toBe("rgb(14, 18, 23)");
    await expect(html).toHaveAttribute("data-palette", "slate");
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  // A device that saved "CodeEditor Slate (match device)" before Deep Field existed: its paint
  // payload has no palette field. It paints Slate before any script runs, and the app keeps Slate.
  await page.evaluate(() => {
    localStorage.setItem("codeeditor:theme", "system");
    localStorage.setItem("codeeditor:theme-paint", JSON.stringify({ system: true, scheme: "dark", colors: null }));
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await reloadHeld(page, async () => {
    await expect.poll(bg).toBe("rgb(14, 18, 23)");
    await expect(html).toHaveAttribute("data-palette", "slate");
    await expect(html).toHaveAttribute("data-theme", "dark");
  });
  await expect(html).toHaveAttribute("data-palette", "slate");
  await expect(html).toHaveAttribute("data-theme-id", "system");
  expect(await bg()).toBe("rgb(14, 18, 23)");
});

// The fonts (Geist and JetBrains Mono, every weight used, weights that really differ) and the
// ligature setting are checked in e2e/signal.spec.ts.

/** The load status of each face of `family` in `style` (document.fonts). */
const faceStatus = (page: Page, family: string, style: string) =>
  page.evaluate(([fam, st]) => [...document.fonts].filter((f) => f.family.replace(/"/g, "") === fam && f.style === st).map((f) => f.status), [family, style]);

// The code font's italic is first drawn by the first edit (a dirty tab's name, the breadcrumb) or
// a comment. Loading it then put one task of 111-161 ms into that keystroke at 4x CPU slowdown,
// while Chromium mapped system fallback fonts (speed profile, 2026-10-19). The app loads it when
// the page is next idle after the editor is shown (theme/fonts.ts), before anything uses it.
test("the code font's italic face loads at idle once the editor is shown, before anything is italic", async ({ page }) => {
  await openApp(page);
  expect(await faceStatus(page, "JetBrains Mono", "italic"), "nothing on the empty workspace uses it").toEqual(["unloaded"]);
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  // The starter has no comment and nothing is unsaved: no italic text is on the page.
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  expect(await page.locator(".cm-content").textContent()).not.toContain("#");
  await expect.poll(() => faceStatus(page, "JetBrains Mono", "italic"), { timeout: 10_000 }).toEqual(["loaded"]);
});

// A reload cancels a download still running (lessons.md: a lazy download right before a reload).
// The face's response is held, so the reload is sure to come while it downloads; the fixture then
// fails the test on any console error or failed request the cancel caused that no navigation explains.
test("a reload while the italic face is still downloading logs no error and no failed request", async ({ page }) => {
  await openApp(page);
  const url = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const style = rule.style;
        if (style.getPropertyValue("font-family").includes("JetBrains Mono") && style.getPropertyValue("font-style") === "italic") {
          const src = /url\("?([^")]+)"?\)/.exec(style.getPropertyValue("src"));
          if (src) return new URL(src[1], location.href).href;
        }
      }
    }
    return null;
  });
  expect(url, "the italic face's file").not.toBeNull();
  const HOLD_MS = 2000;
  let heldAt = 0;
  await page.route(url!, async (route) => {
    heldAt ||= Date.now();
    await new Promise((done) => setTimeout(done, HOLD_MS));
    await route.continue().catch(() => undefined); // the reload may have dropped it
  });
  // How engines report the cancel, for the record: Firefox NS_BINDING_ABORTED, WebKit "Load request
  // cancelled"; Chromium reports nothing for a held request (measured 2026-10-20).
  const cancelled: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url() === url) cancelled.push(r.failure()?.errorText ?? "");
  });
  const requested = page.waitForRequest(url!);
  await page.locator('.starter[data-language="python"]').click();
  await requested;
  // The face can be asked for before the new file is open: the pointer over the starters fetches
  // the editor, whose view loads it at the next idle moment, which a slow storage write can bring
  // first (a full run, 2026-10-21: the reload then found no open tab, so no editor and no face).
  await expectActive(page, "main.py");
  const reloadAt = Date.now();
  await reloadApp(page);
  // The reload came while the face's response was still held (else this test proves nothing).
  expect(heldAt, "the face's request was held").toBeGreaterThan(0);
  expect(reloadAt - heldAt, "the reload started while the download was held").toBeLessThan(HOLD_MS);
  test.info().annotations.push({ type: "cancel", description: cancelled.join("; ") || "no requestfailed event" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // The restored tab shows the editor again, and the face loads this time.
  await expect.poll(() => faceStatus(page, "JetBrains Mono", "italic"), { timeout: 10_000 }).toEqual(["loaded"]);
});

// The first suggestion list's task looked up system fallback fonts for the kind icons' glyphs and
// built the keyword icon's SVG mask (about 60 ms of an 88-165 ms task at 4x CPU slowdown, speed
// profile 2026-10-19). Once the editor is shown, the app lays one of each icon out unseen when the
// page is next idle (editor/highlight.ts warmListIcons), then removes it.
test("the suggestion icons are laid out once, unseen, at idle after the editor is shown, and nothing of it stays", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const seen = { added: 0, removed: 0, visible: [] as string[] };
    (window as unknown as { __warm: typeof seen }).__warm = seen;
    const isWarm = (n: Node) => n instanceof HTMLElement && !n.closest(".cm-tooltip") && n.querySelector(".cm-completionIcon-function") !== null;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!isWarm(n)) continue;
          seen.added++;
          const el = n as HTMLElement;
          const style = getComputedStyle(el);
          if (style.visibility !== "hidden" || el.getAttribute("aria-hidden") !== "true") seen.visible.push(el.outerHTML.slice(0, 120));
        }
        for (const n of r.removedNodes) if (n instanceof HTMLElement && n.querySelector(".cm-completionIcon-function")) seen.removed++;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  const warm = () => page.evaluate(() => (window as unknown as { __warm: { added: number; removed: number; visible: string[] } }).__warm);
  await expect.poll(async () => (await warm()).removed, { timeout: 10_000 }).toBe(1);
  expect(await warm()).toEqual({ added: 1, removed: 1, visible: [] });
  // Nothing of it is left in the editor, and no suggestion list is open.
  await expect(page.locator(".cm-editor .cm-completionIcon")).toHaveCount(0);
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-completion", "closed");
});

test("'match device' follows the system light and dark setting live", async ({ page }) => {
  await openApp(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");
});

test("ligatures stay off unless chosen, and choosing them keeps the code font (JetBrains Mono)", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  const lig = () => page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontVariantLigatures);
  const codeFont = () => page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await lig()).toBe("none");
  expect(await codeFont()).toMatch(/^"?JetBrains Mono"?,/);
  await page.locator("#settings-button").click();
  await page.getByLabel("Joined symbols in code").check();
  expect(await lig()).not.toBe("none");
  expect(await codeFont()).toMatch(/^"?JetBrains Mono"?,/);
  await page.getByLabel("Joined symbols in code").uncheck();
  expect(await lig()).toBe("none");
  expect(await codeFont()).toMatch(/^"?JetBrains Mono"?,/);
});

// Icons are fetched out of band, so no console error or axe rule catches a
// missing favicon. Fetch the declared icons and check their bytes. (Proved to fail with the file removed.)
test("favicon, apple-touch-icon and manifest icons exist and match their declared format", async ({ page, request }) => {
  await page.goto("/");
  const icons = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (els) =>
    els.map((e) => ({ rel: e.getAttribute("rel"), href: (e as HTMLLinkElement).href, type: e.getAttribute("type") })),
  );
  expect(icons.some((i) => i.rel?.split(" ").includes("icon")), "no <link rel=icon>").toBe(true);
  expect(icons.some((i) => i.rel === "apple-touch-icon"), "no apple-touch-icon").toBe(true);
  const isPng = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  for (const icon of icons) {
    const res = await request.get(icon.href);
    expect(res.status(), icon.href).toBe(200);
    const b = await res.body();
    const declared = icon.type ?? (icon.href.endsWith(".svg") ? "image/svg+xml" : "image/png");
    expect(declared.includes("svg") ? b.subarray(0, 512).toString("utf8").includes("<svg") : isPng(b), `${icon.href} is ${declared}`).toBe(true);
    if (icon.rel === "apple-touch-icon") {
      expect(isPng(b)).toBe(true);
      expect(b.readUInt32BE(16), "square").toBe(b.readUInt32BE(20));
    }
  }
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  for (const entry of manifest.icons as { src: string; sizes: string }[]) {
    const res = await request.get(entry.src);
    expect(res.status(), entry.src).toBe(200);
    const b = await res.body();
    expect(isPng(b), entry.src).toBe(true);
    expect(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`, entry.src).toBe(entry.sizes);
  }
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
});

test("the keyboard shortcuts dialog opens with Ctrl+/ (never with a lone ?) and says how to leave the editor", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").focus();
  // A single printable key is no shortcut (WCAG 2.1.4: no way to turn it off or remap it). The key
  // value "?" (Playwright's "Shift+/" sends key "/" with Shift, which no real layout does).
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#settings-button")).toBeFocused();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+/`);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Leave the editor");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#settings-button")).toBeFocused();
  // From the status bar button too (nothing is keyboard-only either).
  await page.locator("#shortcuts-button").click();
  await expect(dialog).toBeVisible();
});

// The Shortcuts list's table is a chunk of its own (found by a row's text: its name is a hash), off
// the first visit's budget; if it can't load, the button says so, and the next press opens the list.
const SHORTCUTS_ROW = "Menu for the selected code: Capture snippet";
test.describe("the Shortcuts list's chunk", () => {
  // The 404 is the point of the second test; each engine reports it in its own words (as args.spec).
  test.use(
    tolerating(
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js (net::ERR_ABORTED|NS_ERROR_CORRUPTED_CONTENT|Load request cancelled)$/,
    ),
  );

  test("is not on a first visit, and arrives when the list opens", async ({ page }) => {
    const bodies = responseBodies(page, (path) => /^\/assets\/[^/]+\.js$/.test(path), (path, b) => ({ url: path, table: b.includes(SHORTCUTS_ROW) }));
    await openApp(page);
    await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
    expect((await bodies.settled()).filter((c) => c.table).map((c) => c.url), "the Shortcuts table on a first visit").toEqual([]);
    await page.locator("#shortcuts-button").click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    expect((await bodies.settled()).filter((c) => c.table)).toHaveLength(1);
  });

  test("can't load: the button says so, and once it loads the list opens", async ({ page, browserName }) => {
    await openApp(page);
    // Every request for it is refused until the route goes (a modulepreload and the import both ask).
    let refused = 0;
    await page.route(
      /\/assets\/[\w-]+\.js$/,
      afterFetch(async (route) => {
        const response = await route.fetch();
        if ((await response.text()).includes(SHORTCUTS_ROW)) {
          refused++;
          return route.fulfill({ status: 404, body: "" });
        }
        return route.fulfill({ response });
      }),
    );
    const notice = page.locator(".notice");
    await page.locator("#shortcuts-button").click();
    await expect(notice).toHaveAttribute("data-tone", "error");
    await expect(notice).toHaveAttribute("data-empty", "false");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(refused).toBeGreaterThan(0);
    await page.unrouteAll({ behavior: "wait" });
    // Playwright's WebKit keeps a failed dynamic import() failed for the whole context (lessons.md
    // 2026-10-21; args.spec records the same): the button keeps saying so there, and never hangs.
    await page.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(notice).toHaveAttribute("data-empty", "true");
    await page.locator("#shortcuts-button").click();
    if (browserName === "webkit") {
      await expect(notice).toHaveAttribute("data-empty", "false");
      await expect(notice).toHaveAttribute("data-tone", "error");
      test.info().annotations.push({ type: "webkit", description: "recovery not checked: a failed import stays failed in the context" });
      return;
    }
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#shortcuts-button")).toBeFocused();
  });
});

/** The output panel (and its splitter) exist once the workspace has a file: an empty one shows the starters only. */
async function withAFile(page: Page) {
  await page.locator('.starter[data-language="python"]').click();
  await expectActive(page, "main.py");
}

test("splitters are separators with values, keyboard resizing, and remembered sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await withAFile(page);
  const side = page.getByRole("separator", { name: "Resize the file list" });
  await expect(side).toHaveAttribute("aria-valuenow", "248");
  await side.focus();
  await page.keyboard.press("ArrowRight");
  await expect(side).toHaveAttribute("aria-valuenow", "264");
  await page.keyboard.press("Home");
  await expect(side).toHaveAttribute("aria-valuenow", "200");
  const panel = page.getByRole("separator", { name: "Resize the output panel" });
  await panel.focus();
  // Nothing has run, so the panel is its bar: the first key only opens it, to the height the
  // splitter names (review B, 2026-10-18: one key did both); the next one resizes it.
  await expect(panel).toHaveAttribute("aria-valuetext", /^Collapsed/);
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toHaveAttribute("aria-valuenow", "35");
  await page.keyboard.press("ArrowUp");
  await expect(panel).toHaveAttribute("aria-valuenow", "40");
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole("separator", { name: "Resize the file list" })).toHaveAttribute("aria-valuenow", "200");
  await expect(page.getByRole("separator", { name: "Resize the output panel" })).toHaveAttribute("aria-valuenow", "40");
  const width = await page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(200);
});

// A phone-wide window allows the file list 200 px at most; its refresh used to overwrite the
// width the user had with that (248 became 200 for good: polish audit, 2026-10-24).
test("the file list keeps the width it was given through a trip to a phone-wide window", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const splitter = page.getByRole("separator", { name: "Resize the file list" });
  const width = async () => Math.round((await page.locator("#sidebar").boundingBox())!.width);
  const narrowTrip = async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#app")).toHaveAttribute("data-narrow", "true");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#app")).toHaveAttribute("data-narrow", "false");
  };
  await expect(splitter).toHaveAttribute("aria-valuenow", "248");
  expect(await width()).toBe(248);

  // The default width, through a phone-wide window and back.
  await narrowTrip();
  await expect(splitter).toHaveAttribute("aria-valuenow", "248");
  expect(await width()).toBe(248);

  // A width chosen with the keyboard, through the same trip, and after a reload.
  await splitter.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "312");
  await narrowTrip();
  await expect(splitter).toHaveAttribute("aria-valuenow", "312");
  expect(await width()).toBe(312);
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole("separator", { name: "Resize the file list" })).toHaveAttribute("aria-valuenow", "312");
});

// WCAG 2.2 SC 2.5.7: every size the splitters set by dragging can also be set with single clicks.
test("the panel and the file list resize without dragging: Maximise the panel, and Wider or Narrower file list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await withAFile(page);
  const panel = page.getByRole("separator", { name: "Resize the output panel" });
  const maximise = page.getByRole("button", { name: "Maximise the panel" });
  await expect(maximise).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toHaveAttribute("aria-valuenow", "35");
  await maximise.click();
  await expect(panel).toHaveAttribute("aria-valuenow", "80");
  await expect(maximise).toHaveAttribute("aria-pressed", "true");
  // Maximising a collapsed panel opens it.
  await expect(page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "true");
  await maximise.click();
  await expect(panel).toHaveAttribute("aria-valuenow", "35");
  await expect(maximise).toHaveAttribute("aria-pressed", "false");
  const side = page.getByRole("separator", { name: "Resize the file list" });
  await expect(side).toHaveAttribute("aria-valuenow", "248");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Wider file list" }).click();
  await expect(side).toHaveAttribute("aria-valuenow", "312");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Narrower file list" }).click();
  await expect(side).toHaveAttribute("aria-valuenow", "248");
});

test("run results are read out, and the run state is beside Run", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  const r = await run(page, { input: ["Lin"] });
  expect(r.status).toBe("ok");
  await expect(page.locator("[data-announcer]")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("[data-announcer]")).toHaveText(/Finished/);
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready");
  // At the top bar's end with Run (desktop, the 0.7.0 shell): the runtime words, Capture, then Run.
  const runtime = page.locator(".topbar .topbar-end > #status-runtime");
  await expect(runtime).toBeVisible();
  await expect(page.locator(".topbar .topbar-end > #status-runtime ~ #run-button")).toBeVisible();
  const [state, runBox] = [(await runtime.boundingBox())!, (await page.locator("#run-button").boundingBox())!];
  expect(state.x + state.width, "the run state is left of Run").toBeLessThanOrEqual(runBox.x);
  expect(Math.abs(state.y + state.height / 2 - (runBox.y + runBox.height / 2)), "on Run's line").toBeLessThan(4);
});
