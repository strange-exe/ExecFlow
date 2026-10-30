// The look of batch 4 (DESIGN.md section 6, Level 2): the Save as PDF dialog (ready and with its
// error) and the Capture snippet dialog with its "Made with ExecFlow" toggle, at 1440 x 900 and
// 390 x 844, light and dark. Axe, no sideways scroll, targets, a visible focus ring on every Tab
// stop, and shots (with gray and blur ones for the reading order) in e2e/shots/print/.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, isNarrow, openFromTree, openIn, showFiles, test, waitReady } from "./helpers";
import { dialogOf, FIXTURE, previewReady, selectFixtureLines } from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FILES = [{ name: "main.py", text: FIXTURE }, { name: "util.c", text: "#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n" }];

async function setUp(page: Page, vp: { width: number; height: number }, scheme: "light" | "dark") {
  await page.setViewportSize(vp);
  await openIn(page, "/", scheme);
  await waitReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
}

async function noSidewaysScroll(page: Page, selector: string) {
  const [page_, el] = await page.evaluate((s) => {
    const d = document.querySelector(s) as HTMLElement;
    const body = d.querySelector(".dialog-body") as HTMLElement;
    return [document.documentElement.scrollWidth > document.documentElement.clientWidth, body.scrollWidth > body.clientWidth + 1];
  }, selector);
  expect(page_, "the page scrolls sideways").toBe(false);
  expect(el, "the dialog's body scrolls sideways").toBe(false);
}

async function axeClean(page: Page, selector: string) {
  const axe = await new AxeBuilder({ page }).include(selector).withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/**
 * Tab through the dialog from its first stop (the close button) to its last: every stop shows a
 * ring of 2 px or more. (Past a modal's last stop Firefox keeps the focus where it is and Chromium
 * and WebKit leave for the browser's UI, so the walk ends at the last stop.)
 */
async function ringsOnEveryStop(page: Page, selector: string, last: string) {
  await page.locator(`${selector} .dialog-head .icon-btn`).focus();
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate((s) => {
      const el = document.activeElement as HTMLElement;
      if (!el || !document.querySelector(s)!.contains(el)) return { inside: false, id: el?.id ?? "", width: 0 };
      const style = getComputedStyle(el);
      return { inside: true, id: el.id || el.textContent?.trim() || el.tagName, width: style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth) };
    }, selector);
    expect(ring.inside, `Tab ${i + 1} stays in the dialog (${seen.join(", ")})`).toBe(true);
    seen.push(ring.id);
    expect(ring.width, `focus ring on ${ring.id}`).toBeGreaterThanOrEqual(2);
    if (ring.id === last) break;
  }
  expect(seen.at(-1), "the walk reaches the last stop").toBe(last);
  test.info().annotations.push({ type: "Tab stops", description: seen.join(", ") });
}

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`Save as PDF dialog, ${vp.name} ${scheme}`, async ({ page, browserName }) => {
      await setUp(page, vp, scheme);
      await showFiles(page);
      await page.locator("#file-actions").click();
      await page.getByRole("menuitem", { name: "Save as PDF..." }).click();
      const d = page.locator("dialog#pdf-dialog");
      await expect(d).toHaveAttribute("data-state", "ready");
      await noSidewaysScroll(page, "#pdf-dialog");
      await axeClean(page, "#pdf-dialog");
      // Targets: 24 px everywhere, 44 px rows and buttons below 900 px (DESIGN.md Layout).
      const min = isNarrow(page) ? 44 : 24;
      for (const el of await d.locator(".pdf-choice, .dialog-actions .btn, .dialog-head .icon-btn").all()) {
        expect((await el.boundingBox())!.height, (await el.textContent()) ?? "").toBeGreaterThanOrEqual(min);
      }
      const dir = `e2e/shots/print/${browserName}-${vp.name}-${scheme}`;
      await page.screenshot({ path: `${dir}-pdf.png`, animations: "disabled" });
      await hierarchyShots(page, `${dir}-pdf`);
      await ringsOnEveryStop(page, "#pdf-dialog", "pdf-print");
      // The error state: nothing chosen.
      await d.getByRole("button", { name: "Clear" }).click();
      await d.getByRole("button", { name: "Open print dialog" }).click();
      await expect(d.locator("#pdf-files-error")).toBeVisible();
      await axeClean(page, "#pdf-dialog");
      await noSidewaysScroll(page, "#pdf-dialog");
      await page.screenshot({ path: `${dir}-pdf-error.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(d).toHaveCount(0);
    });

    test(`Capture snippet dialog with the "Made with ExecFlow" toggle, ${vp.name} ${scheme}`, async ({ page, browserName }) => {
      await setUp(page, vp, scheme);
      await selectFixtureLines(page);
      await showFiles(page);
      await page.locator("#file-actions").click();
      await page.getByRole("menuitem", { name: /^Capture snippet of main\.py, lines 2 to 3/ }).click();
      await previewReady(page, "match numbers name");
      const toggle = dialogOf(page).getByRole("checkbox", { name: '"Made with ExecFlow" line' });
      await expect(toggle).toBeChecked();
      await noSidewaysScroll(page, "#snippet-dialog");
      await axeClean(page, "#snippet-dialog");
      const dir = `e2e/shots/print/${browserName}-${vp.name}-${scheme}`;
      await page.screenshot({ path: `${dir}-snippet.png`, animations: "disabled" });
      await hierarchyShots(page, `${dir}-snippet`);
      await toggle.scrollIntoViewIfNeeded();
      expect((await toggle.locator("..").boundingBox())!.height).toBeGreaterThanOrEqual(isNarrow(page) ? 44 : 24);
      await page.screenshot({ path: `${dir}-snippet-toggle.png`, animations: "disabled" });
      await toggle.uncheck();
      await previewReady(page, "match numbers name 2x medium plain no-mark");
      await axeClean(page, "#snippet-dialog");
    });
  }
}
