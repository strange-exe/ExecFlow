// DESIGN.md section 6 Level 2 for Choose files (with its short link) and the folder-link dialog: 1440 x 900 and
// 390 x 844, light and dark. Each state is scanned with axe, has no horizontal scroll, keeps every
// checkbox row a 24 px target, shows a focus ring on the keyboard path, and is captured with gray
// and blur copies for the reading order (DESIGN-REFERENCE 1A). Shots go to each test's output folder.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { MOVE_TO } from "../playwright.config";
import { expect, hierarchyShots, importFiles, openIn, test, waitReady } from "./helpers";
import { linksSite } from "./links-fake";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function palette(page: Page, command: string, words: string) {
  await page.keyboard.press("F1");
  await expect(page.locator("dialog#palette")).toHaveAttribute("data-state", "ready");
  await page.keyboard.type(words);
  await expect(page.locator("#palette-list [role=option][aria-selected=true]")).toHaveAttribute("data-command", command);
  await page.keyboard.press("Enter");
}

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${vp.name} ${scheme}: Choose files, its link, and a shared folder opened`, async ({ page }, info) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await linksSite(MOVE_TO).serve(page.context());
      await openIn(page, "/", scheme);
      await waitReady(page);
      await importFiles(page, [
        { name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("hi"); return 0; }\n' },
        { name: "a-file-with-a-rather-long-name-for-a-phone-screen.txt", text: "notes\n" },
      ]);

      await palette(page, "choose-files", "choose files");
      const dialog = page.locator("dialog#choose-files");
      await expect(dialog).toHaveAttribute("data-state", "ready");
      // The keyboard path: Space ticks the focused box, which shows a focus ring.
      const first = dialog.locator("input[type=checkbox]").first();
      await first.focus();
      await page.keyboard.press("Space");
      await expect(first).toBeChecked();
      expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle), "focus ring").not.toBe("none");
      for (const row of await dialog.locator(".choose-row").all()) expect((await row.boundingBox())!.height, "row target").toBeGreaterThanOrEqual(24);
      expect(await overflow(page), "no horizontal scroll").toBe(false);
      expect(await axe(page), "axe: Choose files").toEqual([]);
      await hierarchyShots(page, info.outputPath(`choose-${vp.name}-${scheme}`));
      await page.screenshot({ path: info.outputPath(`choose-${vp.name}-${scheme}.png`), animations: "disabled" });

      // Both files ticked, shared: the link and its Copy button, and the short link offered.
      await dialog.locator("input[type=checkbox]").nth(1).check();
      await dialog.locator("#choose-share").click();
      await expect(dialog).toHaveAttribute("data-state", "shared");
      await expect(dialog).toHaveAttribute("data-short", "ready");
      expect(await overflow(page), "no horizontal scroll with the link").toBe(false);
      expect(await axe(page), "axe: the link").toEqual([]);
      await page.screenshot({ path: info.outputPath(`choose-link-${vp.name}-${scheme}.png`), animations: "disabled" });
      const url = await dialog.locator("#choose-link").inputValue();
      // The short link made (the function's logic over a memory store, e2e/links-fake.ts).
      for (const id of ["choose-ttl", "choose-short"]) {
        const b = (await dialog.locator(`#${id}`).boundingBox())!;
        expect(b.height, `${id} target`).toBeGreaterThanOrEqual(vp.name === "phone" && id === "choose-short" ? 43.5 : 23.5);
      }
      // The keyboard path: Copy (focused once shared), then Tab to the expiry (a programmatic focus
      // doesn't show Firefox's focus-visible ring).
      await expect(dialog.locator("#choose-copy")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.locator("#choose-ttl")).toBeFocused();
      expect(await dialog.locator("#choose-ttl").evaluate((el) => getComputedStyle(el).outlineStyle), "focus ring on the expiry").not.toBe("none");
      await dialog.locator("#choose-short").click();
      await expect(dialog).toHaveAttribute("data-short", "made");
      expect(await overflow(page), "no horizontal scroll with the short link").toBe(false);
      expect(await axe(page), "axe: the short link").toEqual([]);
      await hierarchyShots(page, info.outputPath(`choose-short-${vp.name}-${scheme}`));
      await page.screenshot({ path: info.outputPath(`choose-short-${vp.name}-${scheme}.png`), animations: "disabled" });
      await dialog.locator("#choose-cancel").click();

      // The folder link, opened.
      await page.goto(url);
      const open = page.locator("dialog.code-link");
      await expect(open).toHaveAttribute("data-state", "ready");
      expect(await overflow(page), "no horizontal scroll in the folder dialog").toBe(false);
      expect(await axe(page), "axe: a shared folder").toEqual([]);
      await hierarchyShots(page, info.outputPath(`folder-${vp.name}-${scheme}`));
      await page.screenshot({ path: info.outputPath(`folder-${vp.name}-${scheme}.png`), animations: "disabled" });
    });
  }
}
