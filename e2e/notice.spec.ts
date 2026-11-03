// The notice line's timing and motion (src/ui/notice.ts): a confirmation of what the user just did
// goes by itself after 6 s, counted only while it isn't pointed at or focused; anything else waits
// for the user. Where the notice is a card (wide screens, the file list's foot) it rises into place;
// in the phone's status bar, and under reduced motion, it just appears. Time is Playwright's clock.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, test } from "./helpers";

const notice = (page: Page) => page.locator(".notice");

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.clock.install();
  await openApp(page);
}

/** Line wrapping from the command palette: its notice is a brief one. */
async function toggleWrap(page: Page) {
  await page.keyboard.press("F1");
  const option = page.locator("#palette-list [role=option][data-command=wrap]");
  await page.keyboard.type("line wrapping");
  await option.click();
  await expect(notice(page)).toContainText(/Line wrapping is (on|off)\./);
}

/** How the notice came in: "rise" (moved into place) or "none" (it just appeared). */
const entrance = (page: Page) => notice(page).getAttribute("data-enter");

test("a confirmation rises into place on wide screens and goes by itself after 6 s", async ({ page }) => {
  await open(page, 1440, 900);
  await toggleWrap(page);
  expect(await entrance(page)).toBe("rise");
  await page.clock.fastForward(5000);
  await expect(notice(page)).toHaveAttribute("data-empty", "false");
  await page.clock.fastForward(1500);
  await expect(notice(page)).toHaveAttribute("data-empty", "true");
  // The line stays a live region, and its buttons leave the Tab order.
  await expect(notice(page)).toHaveAttribute("role", "status");
  await expect(page.getByRole("button", { name: "Dismiss notice" })).toBeHidden();
});

test("pointed at, a confirmation waits; it goes once the pointer leaves", async ({ page }) => {
  await open(page, 1440, 900);
  await toggleWrap(page);
  await notice(page).hover();
  await page.clock.fastForward(12000);
  await expect(notice(page)).toHaveAttribute("data-empty", "false");
  await page.mouse.move(20, 450);
  await page.clock.fastForward(1500);
  await expect(notice(page)).toHaveAttribute("data-empty", "false");
  await page.clock.fastForward(6000);
  await expect(notice(page)).toHaveAttribute("data-empty", "true");
});

test("focused, a confirmation waits, so the focus never falls out of a notice that went", async ({ page }) => {
  await open(page, 1440, 900);
  await toggleWrap(page);
  const dismiss = page.getByRole("button", { name: "Dismiss notice" });
  await dismiss.focus();
  await page.clock.fastForward(12000);
  await expect(notice(page)).toHaveAttribute("data-empty", "false");
  await expect(dismiss).toBeFocused();
  // Focus leaves for the page (Run is disabled with nothing open, so it can't take it).
  await dismiss.evaluate((b) => (b as HTMLElement).blur());
  await page.clock.fastForward(6500);
  await expect(notice(page)).toHaveAttribute("data-empty", "true");
});

test("a notice that explains something stays until it is dismissed", async ({ page }) => {
  await open(page, 1100, 800);
  await importFiles(page, [{ name: "main.py", text: 'print("hi")\n' }]);
  await openFromTree(page, "main.py");
  await run(page);
  await page.locator("#panel-beside").click();
  await expect(notice(page)).toContainText("There isn't room for the output beside the code");
  await page.clock.fastForward(30000);
  await expect(notice(page)).toContainText("There isn't room for the output beside the code");
  await page.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(notice(page)).toHaveAttribute("data-empty", "true");
});

test("in the phone's status bar a notice just appears, and a confirmation still goes by itself", async ({ page }) => {
  await open(page, 390, 844);
  await toggleWrap(page);
  expect(await entrance(page), "no entrance in the status bar").toBe("none");
  await page.clock.fastForward(6500);
  await expect(notice(page)).toHaveAttribute("data-empty", "true");
});

test("under reduced motion a notice just appears", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 1440, 900);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await toggleWrap(page);
  expect(await entrance(page)).toBe("none");
});
