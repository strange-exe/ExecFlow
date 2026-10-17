import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, openApp, openFromTree, run, showView, test, waitReady } from "./helpers";

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
  // And the colours really are that scheme's (CodeEditor Slate bg).
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === "dark" ? "rgb(14, 18, 23)" : "rgb(253, 253, 255)");
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

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

      // 1. Empty workspace: the starters lead (reading order 4), Run steps back.
      await expect(page.getByRole("heading", { name: "Create your first file" })).toBeInViewport();
      await expect(page.locator('.starter[data-language="python"]')).toBeInViewport();
      await expect(page.locator("#run-button")).toBeInViewport();
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
      expect(await noOverflow(page), "no horizontal scroll (editing)").toBe(true);
      await page.screenshot({ path: `${dir}/editor-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "editor");

      // 3. Waiting for input (reading order 2): the field is focused and in view.
      await page.locator("#run-button").click();
      await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
      await expect(page.locator("#live-input-field")).toBeFocused();
      await expect(page.locator("#live-input-field")).toBeInViewport();
      await page.screenshot({ path: `${dir}/waiting-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "waiting");
      await page.locator("#live-input-field").fill("Ada");
      await page.locator("#live-input-field").press("Enter");
      await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      expect(await noOverflow(page), "no horizontal scroll (ran)").toBe(true);
      await page.screenshot({ path: `${dir}/ran-${vp.name}-${scheme}.png`, animations: "disabled" });
      await axe(page, "ran");
      await hierarchyShots(page, `${dir}/ran-${vp.name}-${scheme}`);

      // 4. Problems.
      await page.locator("#ptab-problems").click();
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
  expect(await noOverflow(page)).toBe(true);
  for (const sel of ["#run-button", "#settings-button", ".drawer-toggle", "#view-code", "#view-output"]) {
    const box = await page.locator(sel).boundingBox();
    expect(box!.height, sel).toBeGreaterThanOrEqual(44);
  }
});

// Budget: initial-route JS about 200 KB gzip. The shell is measured on a first visit (empty
// workspace); CodeMirror (about 196 KB gzip on its own) must not be part of it, and must arrive
// with the first file.
test("a first visit loads only the shell, within the 200 KB gzip budget, and the editor comes with the first file", async ({ page }) => {
  const bodies: Promise<{ url: string; gzip: number }>[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (!/^\/assets\/[^/]+\.js$/.test(path)) return; // app chunks; workers live under /assets/w/
    bodies.push(r.body().then((b) => ({ url: path, gzip: gzipSync(b).length })));
  });
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  const first = await Promise.all(bodies);
  const total = first.reduce((n, s) => n + s.gzip, 0);
  expect(first.length, "scripts loaded").toBeGreaterThan(0);
  expect(total, `first-visit JS gzip: ${first.map((s) => `${s.url} ${s.gzip}`).join(", ")}`).toBeLessThan(200 * 1024);
  await expect(page.locator(".cm-editor")).toHaveCount(0);

  const before = bodies.length;
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  expect(bodies.length, "the editor chunk loaded with the first file").toBeGreaterThan(before);
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

test("'match device' follows the system light and dark setting live", async ({ page }) => {
  await openApp(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(theme).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(theme).toBe("light");
});

test("ligatures stay off unless chosen", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  const lig = () => page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontVariantLigatures);
  expect(await lig()).toBe("none");
  await page.locator("#settings-button").click();
  await page.getByLabel("Joined symbols in code").check();
  expect(await lig()).not.toBe("none");
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

test("the keyboard shortcuts dialog opens with ? and says how to leave the editor", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").focus();
  // The key value "?" (Playwright's "Shift+/" sends key "/" with Shift, which no real layout does).
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Leave the editor");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#settings-button")).toBeFocused();
  // From the status bar button too (nothing is keyboard-only either).
  await page.locator("#shortcuts-button").click();
  await expect(dialog).toBeVisible();
});

test("splitters are separators with values, keyboard resizing, and remembered sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const side = page.getByRole("separator", { name: "Resize the file list" });
  await expect(side).toHaveAttribute("aria-valuenow", "248");
  await side.focus();
  await page.keyboard.press("ArrowRight");
  await expect(side).toHaveAttribute("aria-valuenow", "264");
  await page.keyboard.press("Home");
  await expect(side).toHaveAttribute("aria-valuenow", "200");
  const panel = page.getByRole("separator", { name: "Resize the output panel" });
  await panel.focus();
  await page.keyboard.press("ArrowUp");
  await expect(panel).toHaveAttribute("aria-valuenow", "40");
  await page.reload();
  await waitReady(page);
  await expect(page.getByRole("separator", { name: "Resize the file list" })).toHaveAttribute("aria-valuenow", "200");
  await expect(page.getByRole("separator", { name: "Resize the output panel" })).toHaveAttribute("aria-valuenow", "40");
  const width = await page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(200);
});

// WCAG 2.2 SC 2.5.7: every size the splitters set by dragging can also be set with single clicks.
test("the panel and the file list resize without dragging: Maximise the panel, and Wider or Narrower file list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const panel = page.getByRole("separator", { name: "Resize the output panel" });
  const maximise = page.getByRole("button", { name: "Maximise the panel" });
  await expect(maximise).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toHaveAttribute("aria-valuenow", "35");
  await maximise.click();
  await expect(panel).toHaveAttribute("aria-valuenow", "80");
  await expect(maximise).toHaveAttribute("aria-pressed", "true");
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

test("run results are read out, and the run state is on the status bar", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  const r = await run(page, { input: ["Lin"] });
  expect(r.status).toBe("ok");
  await expect(page.locator("[data-announcer]")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("[data-announcer]")).toHaveText(/Finished/);
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready");
});
