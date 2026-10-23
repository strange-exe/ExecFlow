// DESIGN.md section 6 Level 2 for the Arguments field (track R, batch 3; spec
// .claude/design/batch3/r.md): 1440 x 900 and 390 x 844, light and dark, the field set, in its error
// state and in the run-log header: axe, no horizontal scroll, the layout the spec sets (beside the
// Input text from 900 px, under it below), target sizes, a visible focus ring on the keyboard path,
// and screenshots with gray and blur copies for the reading order (DESIGN-REFERENCE 1A). The shots
// go to each test's output folder.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, isNarrow, openFromTree, openIn, run, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${vp.name} ${scheme}: the Arguments field set, in error and in the header`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openIn(page, "/", scheme);
      await waitReady(page);
      await importFiles(page, [{ name: "calc.py", text: "import sys\nprint(sys.argv[1:])\n" }]);
      await openFromTree(page, "calc.py");
      await page.locator(isNarrow(page) ? "#view-output" : "#ptab-output").click();

      // The keyboard path: the toggle opens the box with the caret in the Input text; Tab reaches the field.
      const toggle = page.locator("#input-toggle");
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#stdin")).toBeFocused();
      await page.keyboard.press("Tab");
      const field = page.locator("#args-field");
      await expect(field).toBeFocused();
      const ring = await field.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(ring.style, "a visible focus ring on the field").not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
      await page.keyboard.type('3 "two words"');

      // Layout: beside the Input text from 900 px, under it below; 44 px tall on phones (32 on desktops).
      const input = (await page.locator("#stdin").boundingBox())!;
      const box = (await field.boundingBox())!;
      if (isNarrow(page)) expect(box.y, "under the Input text").toBeGreaterThan(input.y + input.height);
      else expect(box.x, "beside the Input text").toBeGreaterThan(input.x + input.width);
      expect(box.height).toBeGreaterThanOrEqual(isNarrow(page) ? 44 : 32);
      expect(await overflow(page), "no horizontal scroll").toBe(false);
      expect(await axe(page), "axe, field set").toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`args-set-${vp.name}-${scheme}.png`), animations: "disabled" });

      // The error state: message under the field, before the hint; reading order (1) the message.
      await page.keyboard.type(' "x');
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("#args-row")).toHaveAttribute("data-state", "invalid");
      await field.focus();
      expect(await overflow(page)).toBe(false);
      expect(await axe(page), "axe, error state").toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`args-error-${vp.name}-${scheme}.png`), animations: "disabled" });
      await hierarchyShots(page, test.info().outputPath(`args-error-${vp.name}-${scheme}`));

      // Fixed, then run: the header shows the command line the run got.
      await page.keyboard.press("End");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await expect(page.locator("#args-row")).toHaveAttribute("data-state", "ok");
      const result = await run(page);
      expect(result.output).toContain("['3', 'two words']");
      await expect(page.locator("#run-args")).toHaveText('3 "two words"');
      expect(await overflow(page)).toBe(false);
      expect(await axe(page), "axe, header with arguments").toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`args-header-${vp.name}-${scheme}.png`), animations: "disabled" });
    });
  }
}
