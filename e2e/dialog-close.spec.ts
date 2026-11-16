import { expect, importFiles, openApp, test, treeItem } from "./helpers";
import type { Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

// A dialog's Cancel and close buttons close it declaratively (command="close" pointed at the dialog,
// HTML invoker commands) where the browser has them, and by a click listener where it doesn't: the
// README still supports Firefox 131 and Safari 18.4, older than invoker commands (Firefox 144,
// Safari 26.2). Found by the legacy scan (2026-11-16).

async function openShare(page: Page) {
  await treeItem(page, "main.py").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  const share = page.locator("dialog#share-dialog");
  await expect(share).toHaveAttribute("data-state", "code");
  return share;
}

async function openDelete(page: Page) {
  await treeItem(page, "main.py").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  return confirm;
}

/** How a dialog's button is wired: "declarative" when it names the dialog as its command target. */
const wiring = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector)!;
    const dialog = button.closest("dialog");
    if (!("commandForElement" in HTMLButtonElement.prototype)) return "listener";
    return button.command === "close" && button.commandForElement === dialog ? "declarative" : "other";
  }, selector);

async function setUp(page: Page) {
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
}

test("Cancel and close buttons close their dialog by invoker command where the browser has one", async ({ page, browserName }) => {
  await setUp(page);
  const supported = await page.evaluate(() => "commandForElement" in HTMLButtonElement.prototype);
  // The engine Playwright ships for Chromium has invoker commands, so the declarative path is tested.
  if (browserName === "chromium") expect(supported).toBe(true);
  const expected = supported ? "declarative" : "listener";

  let share = await openShare(page);
  expect(await wiring(page, "#share-cancel")).toBe(expected);
  expect(await wiring(page, "#share-dialog .dialog-head .icon-btn")).toBe(expected);
  await page.locator("#share-cancel").click();
  await expect(share).toHaveCount(0);

  share = await openShare(page);
  await page.locator("#share-dialog .dialog-head .icon-btn").click();
  await expect(share).toHaveCount(0);

  const confirm = await openDelete(page);
  expect(await wiring(page, "dialog[role=alertdialog] .dialog-actions .btn:not([data-confirm])")).toBe(expected);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(treeItem(page, "main.py")).toHaveCount(1);
});

test("without invoker commands, Cancel and close still close their dialog", async ({ page }) => {
  // An older browser (Firefox before 144, Safari before 26.2): no commandForElement, no command event.
  await page.addInitScript(() => {
    const proto = HTMLButtonElement.prototype as unknown as Record<string, unknown>;
    delete proto.commandForElement;
    delete proto.command;
  });
  await setUp(page);
  expect(await page.evaluate(() => "commandForElement" in HTMLButtonElement.prototype)).toBe(false);

  let share = await openShare(page);
  expect(await wiring(page, "#share-cancel")).toBe("listener");
  await page.locator("#share-cancel").click();
  await expect(share).toHaveCount(0);

  share = await openShare(page);
  await page.locator("#share-dialog .dialog-head .icon-btn").click();
  await expect(share).toHaveCount(0);

  const confirm = await openDelete(page);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(treeItem(page, "main.py")).toHaveCount(1);
});
