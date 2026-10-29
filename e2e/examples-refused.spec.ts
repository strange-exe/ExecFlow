// An example that can't be added still says why (src/ui/workbench.ts addFile): the examples dialog
// has closed by then, so the workbench shows the reason as a notice. A read-only tab explains
// itself (info); storage refusing the write gives its reason (error). Nothing is added either way.
import type { Page } from "@playwright/test";
import { expect, openApp, showFiles, test } from "./helpers";

test.use({ serviceWorkers: "block" });

const dialog = (page: Page) => page.locator("dialog#examples");

async function chooseFromEmpty(page: Page, name: string) {
  await page.locator("#empty-examples").click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await dialog(page).locator(`[data-example="${name}"]`).click();
  await expect(dialog(page)).toHaveCount(0);
}

test("storage refusing an example says why in a notice, and adds nothing", async ({ page }) => {
  await openApp(page);
  // Every IndexedDB write fails from here on (a full disk, say).
  await page.evaluate(() => {
    for (const method of ["put", "add"] as const) {
      IDBObjectStore.prototype[method] = function () {
        throw new DOMException("The disk is full (test).", "QuotaExceededError");
      };
    }
  });
  await chooseFromEmpty(page, "functions.py");
  await expect(page.locator(".notice")).toContainText("The disk is full (test).");
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "error");
  await showFiles(page);
  await expect(page.locator(".tree [role=treeitem]")).toHaveCount(0);
});

test("a read-only tab says so when an example is chosen, and adds nothing", async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await chooseFromEmpty(second, "functions.py");
  await expect(second.locator(".notice")).toContainText("read-only");
  await expect(second.locator(".notice")).toHaveAttribute("data-tone", "info");
  await showFiles(page);
  await expect(page.locator(".tree [role=treeitem]")).toHaveCount(0);
});
