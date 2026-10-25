// Short windows (polish audit, 2026-10-24): at 400% zoom of a 1280 x 800 window (320 x 200 CSS px)
// a waiting program's focused input field lay under the status bar and the run header under the
// tools row, in all three engines (WCAG 2.4.11, 1.4.10). At 420 px tall or less the page now
// scrolls as a whole with nothing fixed over the work; a phone held sideways (844 x 390) is in the
// same tier.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const ASKS = { name: "main.py", text: 'name = input("Name: ")\nprint("Hello,", name)\n' };

/** Dismisses a notice left by the import, so the status bar is its plain one line. */
async function quietNotice(page: Page) {
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
}

/**
 * Where the focused element and the run header are: whether each is on screen, what the browser
 * finds at their points (another element there covers them), and which of their scroll or clip
 * ancestors cuts them.
 */
function placeOf(page: Page) {
  return page.evaluate(() => {
    const at = (el: Element, x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit === el || el.contains(hit) ? "itself" : hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}.${String(hit.className).split(" ")[0]}` : "nothing";
    };
    const cutBy = (el: Element) => {
      const r = el.getBoundingClientRect();
      const out: string[] = [];
      // Up to the body, whose overflow is the window's own (CSS Overflow 3: it moves to the viewport).
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowY === "visible" && s.overflowX === "visible") continue;
        const b = a.getBoundingClientRect();
        if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) out.push(`${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}.${String(a.className).split(" ")[0]}`);
      }
      return out;
    };
    const onScreen = (r: DOMRect) => r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5;
    const field = document.activeElement as HTMLElement;
    const f = field.getBoundingClientRect();
    const head = document.getElementById("runlog")!;
    const words = document.getElementById("run-status")!;
    const h = head.getBoundingClientRect();
    const w = words.getBoundingClientRect();
    return {
      active: field.id,
      field: { onScreen: onScreen(f), atCentre: at(field, f.left + f.width / 2, f.top + f.height / 2), cutBy: cutBy(field) },
      head: {
        onScreen: onScreen(h),
        atTop: at(head, h.left + h.width / 2, h.top + 3),
        atBottom: at(head, h.left + h.width / 2, h.bottom - 3),
        words: at(words, w.left + Math.min(w.width / 2, 40), w.top + w.height / 2),
        cutBy: cutBy(head),
      },
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

for (const size of [
  { name: "400% zoom of 1280 x 800", viewport: { width: 320, height: 200 }, scale: 4 },
  { name: "a phone held sideways", viewport: { width: 844, height: 390 }, scale: 1 },
]) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, deviceScaleFactor: size.scale });

    test(`(${size.name}) waiting for input: the focused field is on screen with nothing over it, the run header is whole, and the status bar ends the page`, async ({ page }) => {
      await openApp(page);
      await importFiles(page, [ASKS]);
      await openFromTree(page, "main.py");
      await quietNotice(page);
      await page.locator("#run-button").click();
      await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
      await expect(page.locator("#live-input-field")).toBeFocused();
      // Where they come to rest (the log's blocks take their real height in the first frames).
      await expect
        .poll(async () => {
          const p = await placeOf(page);
          return { active: p.active, field: p.field, head: p.head, sideways: p.sideways };
        }, { message: "the focused field (WCAG 2.4.11), the run header and its waiting words" })
        .toEqual({
          active: "live-input-field",
          field: { onScreen: true, atCentre: "itself", cutBy: [] },
          head: { onScreen: true, atTop: "itself", atBottom: "itself", words: "itself", cutBy: [] },
          sideways: false,
        });
      // And they stay there.
      await page.waitForTimeout(500);
      const still = await placeOf(page);
      expect([still.field.atCentre, still.head.atTop, still.head.words]).toEqual(["itself", "itself", "itself"]);

      // The status bar is not fixed over the work: it ends the page, reached by scrolling it.
      const bar = page.locator("footer.statusbar");
      await bar.scrollIntoViewIfNeeded();
      await expect(bar).toBeInViewport({ ratio: 1 });
      const barHit = await bar.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
        return Boolean(hit && el.contains(hit));
      });
      expect(barHit, "nothing covers the status bar").toBe(true);

      // Nothing is fixed over the work: scrolled to its end, the top bar has moved up with the page.
      const scrolled = await page.evaluate(() => scrollY);
      expect(scrolled, "the page scrolled").toBeGreaterThan(0);
      expect((await page.locator("header.topbar").boundingBox())!.y, "the top bar scrolls with the page").toBeCloseTo(-scrolled, 0);

      // The field still takes the answer.
      await page.locator("#live-input-field").focus();
      await page.keyboard.type("Ada");
      await page.keyboard.press("Enter");
      await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
      await expect(page.locator("#console")).toContainText("Hello, Ada");
    });

    test(`(${size.name}) the file drawer opens from a scrolled page under the top bar, holds the page still, and gives the focus back to Files`, async ({ page }) => {
      await openApp(page);
      await importFiles(page, [ASKS]);
      await openFromTree(page, "main.py");
      await quietNotice(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => scrollY), { message: "the page scrolls" }).toBeGreaterThan(0);
      await page.keyboard.press("Control+Shift+E");
      await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(await page.evaluate(() => scrollY), "the page went to its top").toBe(0);
      const bar = (await page.locator("header.topbar").boundingBox())!;
      const drawer = (await page.locator("#sidebar").boundingBox())!;
      expect(bar.y, "the top bar is on screen").toBe(0);
      expect(Math.round(drawer.y), "the drawer hangs from the top bar").toBe(Math.round(bar.y + bar.height));
      await expect(page.locator(".tree [role=treeitem]").first()).toBeFocused();
      // While it is open the page behind it holds still.
      await page.mouse.move(size.viewport.width - 10, size.viewport.height - 10);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => scrollY), "the page holds still under the drawer").toBe(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(".drawer-toggle")).toBeFocused();
      await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
    });
  });
}
