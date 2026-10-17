import { expect, openApp, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });

test("a second tab is read-only with a banner, and Edit here moves editing to it", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("data-role", "writer");

  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  const banner = second.locator("#read-only-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "status");
  // It can read the workspace, but not change it: the editor and the tree refuse edits.
  await expect(treeItem(second, "main.py")).toBeVisible();
  await expect(second.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
  await second.locator("#new-file").click();
  await expect(second.locator(".notice")).toHaveAttribute("data-tone", "info");
  await expect(second.getByRole("textbox", { name: /Name of the new file/ })).toHaveCount(0);

  // Edit here: the second tab becomes the writer, the first one read-only.
  await banner.getByRole("button", { name: "Edit here" }).click();
  await expect(second.locator("#app")).toHaveAttribute("data-role", "writer", { timeout: 10_000 });
  await expect(banner).toBeHidden();
  await expect(second.locator(".cm-content")).not.toHaveAttribute("aria-readonly", "true");
  await expect(page.locator("#app")).toHaveAttribute("data-role", "reader", { timeout: 10_000 });
  await expect(page.locator("#read-only-banner")).toBeVisible();

  // An edit in the writer reaches the reader once it is saved.
  await second.locator(".cm-content").click();
  await second.keyboard.press("Control+End");
  await second.keyboard.type("# from the second tab\n");
  await expect(second.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("# from the second tab", { timeout: 10_000 });
  await second.close();
});
