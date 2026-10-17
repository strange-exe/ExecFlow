// The GitHub screens in the design matrix (DESIGN-REFERENCE 6T): 1440x900 and 390x844, light and
// dark. Each test loads, emulates, reloads and proves the theme is active, then walks the Connect
// dialog, the first-connect choice, the conflict-copies list and every sync state of the top bar:
// no horizontal scroll, axe WCAG 2.2 AA with no violations, screenshots for review (and gray and
// blur shots of the Connect dialog, reading order 3).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, setCode, test, waitReady } from "./helpers";
import { answer, fillConnect, githubNoise, openConnect, routeGitHub, saveKey, syncCount, syncNoise, syncStatus, waitSync } from "./sync-fake";

test.use({ serviceWorkers: "block" });
// A server error (retried), a missing permission (stops) and a revoked token are shown on purpose.
test.use(syncNoise(...githubNoise(500, "/git/ref/heads/main"), ...githubNoise(403, "/git/ref/heads/main"), ...githubNoise(401, "/git/ref/heads/main")));

const SHOTS = process.env.SHOTS_DIR ?? "e2e/shots";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

async function openThemed(page: Page, scheme: "light" | "dark") {
  await page.goto("/");
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === "dark" ? "rgb(14, 18, 23)" : "rgb(253, 253, 255)");
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function axe(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

for (const vp of viewports) {
  for (const scheme of ["light", "dark"] as const) {
    test(`GitHub screens ${vp.name} ${scheme}: dialogs, sync states, overflow, accessibility`, async ({ page, context }, testInfo) => {
      test.setTimeout(150_000);
      const dir = `${SHOTS}/${testInfo.project.name}`;
      const shot = (name: string) => page.screenshot({ path: `${dir}/sync-${name}-${vp.name}-${scheme}.png`, animations: "disabled" });
      const bar = (state: string) => page.screenshot({ path: `${dir}/sync-bar-${state}-${vp.name}-${scheme}.png`, animations: "disabled", clip: { x: 0, y: 0, width: vp.width, height: vp.width < 900 ? 48 : 40 } });
      const state = async (name: string) => {
        await expect(syncStatus(page)).toHaveAttribute("data-sync-state", name);
        const wide = await page.evaluate(() => {
          const w = document.documentElement.clientWidth;
          return [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > w + 0.5).slice(0, 8).map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`);
        });
        expect(await noOverflow(page), `no horizontal scroll (${name}): ${wide.join(" | ")}`).toBe(true);
        await bar(name);
      };

      const gh = await routeGitHub(page);
      await gh.fake.remoteCommit({ "main.py": "print('repo')\n", "util.py": "X = 'repo'\n" });
      await page.setViewportSize(vp);
      await openThemed(page, scheme);
      await importFiles(page, [
        { name: "main.py", text: "print('here')\n" },
        { name: "util.py", text: "X = 'here'\n" },
      ]);
      // Phones: importing went through the file drawer; close it to see the workbench again.
      if (vp.width < 900) {
        await page.locator(".drawer-toggle").click();
        await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
      }
      await state("not-connected");

      // 1. Connect (reading order 3): what connecting does, the fields, Connect.
      const dialog = await openConnect(page);
      expect(await noOverflow(page)).toBe(true);
      await shot("connect");
      // The dialog is filtered too (it is in the top layer, out of reach of a filter on <html>).
      await hierarchyShots(page, `${dir}/sync-connect-${vp.name}-${scheme}`);
      await axe(page, "connect");
      await page.locator("#connect-dialog .dialog-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await shot("connect-end");

      // Mistakes are shown at the field, which keeps focus.
      await fillConnect(page, { owner: "me", token: "not a token" });
      await page.locator("#connect-submit").click();
      await expect(dialog).toHaveAttribute("data-state", "invalid");
      await shot("connect-error");
      await axe(page, "connect error");

      // 2. First connect: both sides have different files.
      const n = await syncCount(page);
      await fillConnect(page, {});
      await page.locator("#connect-submit").click();
      await expect(page.locator("#first-connect")).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      await shot("first-connect");
      await axe(page, "first connect");
      await page.keyboard.press("Escape");
      await waitSync(page, n, "needs-choice");
      await state("needs-choice");
      await shot("needs-choice");

      // 3. Merge: two conflict copies, listed by the notice's action.
      await syncStatus(page).click();
      await page.locator("#first-connect-sync").click();
      await waitSync(page, n + 1, "synced");
      await state("synced");
      await shot("synced-conflicts");
      await axe(page, "after merge");
      await page.locator(".notice-action").click();
      await expect(page.locator("#conflict-copies")).toBeVisible();
      await expect(page.locator("#conflict-copies .link-btn")).toHaveCount(2);
      await shot("conflict-copies");
      await axe(page, "conflict copies");
      await page.locator("#conflict-copies .link-btn").first().click();
      await expect(page.locator("#conflict-copies")).toHaveCount(0);

      // 4. Unsynced, syncing.
      await setCode(page, "print('edited')\n");
      await state("unsynced");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let holding = true;
      gh.fake.interceptors.push(async () => {
        if (holding) await held;
        return undefined;
      });
      const m = await syncCount(page);
      await saveKey(page);
      await state("syncing");
      holding = false;
      release();
      await waitSync(page, m, "synced");

      // 5. A server error: waiting with a countdown (the retry would come in 30 s).
      gh.fake.interceptors.push((req) => (req.method === "GET" && req.path.startsWith("/git/ref/") ? answer(500, "Server Error") : undefined));
      await setCode(page, "print('edited again')\n");
      await saveKey(page);
      await waitSync(page, m + 1, "waiting");
      await state("waiting");
      await shot("waiting");
      await axe(page, "waiting");

      // 6. A missing permission: failed (no retry), recorded until a sync succeeds.
      gh.fake.interceptors.length = 0;
      gh.fake.interceptors.push((req) => (req.method === "GET" && req.path.startsWith("/git/ref/") ? answer(403, "Resource not accessible by personal access token") : undefined));
      await syncStatus(page).click();
      await waitSync(page, m + 2, "failed");
      await state("failed");

      // 7. Offline.
      gh.fake.interceptors.length = 0;
      await context.setOffline(true);
      await saveKey(page);
      await state("offline");
      await context.setOffline(false);
      await waitSync(page, m + 3, "synced");

      // 8. A token revoked: enter a new one.
      gh.fake.interceptors.push(() => answer(401, "Bad credentials"));
      await syncStatus(page).click();
      await waitSync(page, m + 4, "needs-token");
      await state("needs-token");
      await shot("needs-token");
      await axe(page, "needs token");
    });
  }
}
