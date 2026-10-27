// Every state of the Share link dialog (.claude/design/batch5/share-link.md) in the DESIGN.md
// section 6 Level 2 matrix: 1440x900 and 390x844, light and dark. For each: the scheme is proven
// active, no horizontal scroll and nothing wider than the dialog, axe WCAG 2.2 AA has no violations,
// and a screenshot is kept for review (plus gray and blur shots of the two key views). The keyboard
// path is walked separately. GitHub is the fake (e2e/sync-fake.ts).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, openApp, setCode, openFromTree, showFiles, test, treeItem } from "./helpers";
import { connectGitHub, routeGitHub, syncCount, syncNoise, waitSync, type GitHubRoute } from "./sync-fake";
import type { FakeGitHubOptions } from "../src/sync/test-helpers";

test.use({ serviceWorkers: "block" });
test.use(syncNoise(/^HTTP 403: https:\/\/api\.github\.com\/gists$/, /^Failed to load resource: the server responded with a status of 403( \(.*\))?$/));

const SHOTS = process.env.SHOTS_DIR ?? "e2e/shots";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const MAIN = "def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n";
const dialog = (page: Page) => page.locator("dialog#share-dialog");
const primary = (page: Page) => page.locator("#share-primary");

async function matrix(page: Page, state: string, key = false) {
  const engine = test.info().project.name;
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(dialog(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${state} ${size.name} ${scheme}: no horizontal scroll`).toBe(true);
      const wide = await dialog(page).evaluate((d) => {
        const box = d.getBoundingClientRect();
        return [...d.querySelectorAll<HTMLElement>("*")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > box.right + 1).map((e) => e.id || String(e.className));
      });
      expect(wide, `${state} ${size.name}: content wider than the dialog`).toEqual([]);
      const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(result.violations.map((v) => `${state} ${size.name} ${scheme}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
      // Every control of the dialog is at least 24 px tall and wide (44 tall on phones for buttons).
      const small = await dialog(page).evaluate((d, phone) =>
        [...d.querySelectorAll<HTMLElement>("button, input, a")]
          .filter((e) => e.getClientRects().length)
          .map((e) => ({ id: e.id || e.tagName, r: e.getBoundingClientRect(), tag: e.tagName }))
          .filter(({ r, tag }) => r.height < (phone && tag === "BUTTON" ? 44 : 24) - 0.5 || r.width < 24 - 0.5)
          .map(({ id, r }) => `${id} ${Math.round(r.width)}x${Math.round(r.height)}`), size.name === "phone");
      // Inline text links and radios are exempt (WCAG 2.5.8: inline; spacing).
      expect(small.filter((s) => !/^(share-open|share-code|share-repo|share-gist) /.test(s)), `${state} ${size.name}: small targets`).toEqual([]);
      const base = `${SHOTS}/share/${engine}/${state}-${size.name}-${scheme}`;
      await page.screenshot({ path: `${base}.png`, animations: "disabled" });
      if (key && size.name === "desktop") await hierarchyShots(page, base);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

async function setUp(page: Page, o: { connect?: boolean; fake?: FakeGitHubOptions } = {}): Promise<GitHubRoute> {
  const gh = await routeGitHub(page, o.fake);
  await gh.fake.remoteCommit({ "labs/week 1/main.py": MAIN });
  await page.addInitScript(() => {
    const fake = { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => fake });
  });
  await openApp(page);
  if (o.connect === false) {
    await importFiles(page, [{ name: "main.py", text: MAIN }]);
    return gh;
  }
  const n = await syncCount(page);
  await connectGitHub(page);
  await waitSync(page, n, "synced");
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
  await showFiles(page);
  for (const dir of ["labs", "labs/week 1"]) {
    if ((await treeItem(page, dir).getAttribute("aria-expanded")) !== "true") await treeItem(page, dir).locator(":scope > .tree-row").click();
  }
  return gh;
}

/** Opens Share link; the repository link is chosen unless `choice` keeps the default code link. */
async function openShare(page: Page, path: string, choice: "repo" | "code" = "repo") {
  await showFiles(page);
  await treeItem(page, path).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await expect(dialog(page)).toHaveAttribute("data-state", /./);
  if (choice !== "repo") return;
  // Then focus it, as the keyboard would: WebKit's click checks a radio without focusing it (and
  // takes the focus off what had it).
  await page.locator("#share-repo").check();
  await page.locator("#share-repo").focus();
}

const PATH = "labs/week 1/main.py";

test("not connected: the code link at once; the GitHub links explain and offer Connect GitHub", async ({ page }) => {
  await setUp(page, { connect: false });
  await openShare(page, "main.py", "code");
  await expect(dialog(page)).toHaveAttribute("data-state", "code");
  await expect(page.locator("#share-code")).toBeFocused();
  await matrix(page, "code-not-connected");
  await page.locator("#share-repo").check();
  await expect(dialog(page)).toHaveAttribute("data-state", "not-connected");
  await matrix(page, "not-connected");
});

test("code link, connected: the default, and its keyboard path", async ({ page }) => {
  await setUp(page);
  await openShare(page, PATH, "code");
  await expect(dialog(page)).toHaveAttribute("data-state", "code");
  await expect(page.locator("#share-code")).toBeFocused();
  for (const id of ["share-link", "share-titled", "share-qr-toggle", "share-cancel", "share-primary"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(`#${id}`), id).toBeFocused();
  }
  await page.locator("#share-code").focus();
  await matrix(page, "code", true);
  // With the QR code shown: the same matrix (its light ground stays light in the dark scheme).
  await page.locator("#share-qr-toggle").click();
  await expect(dialog(page)).toHaveAttribute("data-qr", "shown");
  await matrix(page, "code-qr");
});

test("ready: the repository link, keyboard path and the key view's hierarchy", async ({ page }) => {
  await setUp(page);
  await openShare(page, PATH);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  // Keyboard path: the choice first, then the link, Open on GitHub, Cancel, Copy link; Shift+Tab reaches Close.
  await expect(page.locator("#share-repo")).toBeFocused();
  // Safari leaves links out of the Tab order unless "Press Tab to highlight each item" is on, and
  // Playwright's WebKit differs by platform (skipped on Windows, a Tab stop on Linux CI, 2026-10-24):
  // so whether Open on GitHub is a stop is read from the browser, the rest of the order is fixed.
  await page.locator("#share-link").focus();
  await page.keyboard.press("Tab");
  const linksAreStops = await page.locator("#share-open").evaluate((a) => a === document.activeElement);
  if (!linksAreStops) expect(test.info().project.name, "only WebKit may skip the link").toBe("webkit");
  await page.locator("#share-repo").focus();
  const order = linksAreStops ? ["share-link", "share-open", "share-cancel", "share-primary"] : ["share-link", "share-cancel", "share-primary"];
  for (const id of order) {
    await page.keyboard.press("Tab");
    await expect(page.locator(`#${id}`), id).toBeFocused();
  }
  await page.locator("#share-repo").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog(page).getByRole("button", { name: "Close" })).toBeFocused();
  await page.locator("#share-repo").focus();
  await matrix(page, "ready", true);
});

test("pending: Sync now before a link", async ({ page }) => {
  await setUp(page);
  await openFromTree(page, PATH);
  await setCode(page, "print('changed')\n");
  await openShare(page, PATH);
  await expect(dialog(page)).toHaveAttribute("data-state", "pending");
  await primary(page).click();
  await expect(page.locator("#share-sync")).toBeFocused();
  await matrix(page, "pending");
});

test("gist: the warning before anything exists; arrows choose, Tab reaches Create link", async ({ page }) => {
  await setUp(page);
  await openShare(page, PATH);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#share-gist")).toBeChecked();
  await expect(dialog(page)).toHaveAttribute("data-state", "gist");
  for (const id of ["share-cancel", "share-primary"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(`#${id}`), id).toBeFocused();
  }
  await page.locator("#share-gist").focus();
  await matrix(page, "gist", true);
});

test("created, and the copy the browser refused", async ({ page }) => {
  const gh = await setUp(page);
  await openShare(page, PATH);
  await page.locator("#share-gist").check();
  await primary(page).click();
  await expect(dialog(page)).toHaveAttribute("data-state", "created");
  expect(gh.fake.gists).toHaveLength(1);
  await matrix(page, "created");
  await primary(page).click();
  await expect(dialog(page)).toHaveAttribute("data-copy", "refused");
  await expect(page.locator("#share-link")).toBeFocused();
  await matrix(page, "copy-refused");
});

test("error: a token without the gist permission", async ({ page }) => {
  await setUp(page, { fake: { gistsRefused: 403 } });
  await openShare(page, PATH);
  await page.locator("#share-gist").check();
  await primary(page).click();
  await expect(page.locator("#share-result")).toHaveAttribute("data-tone", "error");
  await matrix(page, "error");
});
