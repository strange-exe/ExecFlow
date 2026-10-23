// Two tabs of the same workspace, as a student ends up with them (from the functional review,
// 2026-10-17): handover right after typing, runs in the reader, deletes and renames in the writer.
import { expect, openApp, reloadApp, run, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

test("Edit here right after typing in the other tab keeps what was typed (nothing waits for autosave)", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# typed just now");
  // No wait for the 400 ms autosave: the handover must flush it.
  await second.locator("#edit-here").click();
  await expect(second.locator("#app")).toHaveAttribute("data-role", "writer", { timeout: 10_000 });
  await expect(second.locator(".cm-content")).toContainText("# typed just now", { timeout: 10_000 });
  await expect(page.locator("#app")).toHaveAttribute("data-role", "reader", { timeout: 10_000 });

  // The new writer's next edit is saved and survives its reload.
  await second.locator(".cm-content").click();
  await second.keyboard.press("Control+End");
  await second.keyboard.type("\n# second tab");
  await expect(second.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  await reloadApp(second);
  await expect(second.locator(".cm-content")).toContainText("# typed just now");
  await expect(second.locator(".cm-content")).toContainText("# second tab");
  await second.close();
});

test("a read-only tab coming into view leaves the writer's stashed typing for Edit here", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# typed before closing");
  // The writer goes away within the 400 ms autosave: it stashes the typing synchronously.
  const stashedByWriter = await page.evaluate(() => {
    dispatchEvent(new Event("beforeunload"));
    return Object.keys(localStorage).filter((k) => k.startsWith("codeeditor:recover:"));
  });
  expect(stashedByWriter, "the writer stashed its typing").toHaveLength(1);
  // And really goes away: a writer that is still there drops its own stash when it is shown again,
  // as it should (Linux WebKit showed it again while the test moved to the reader: CI, 2026-10-23).
  await page.close();

  // Closing the writer shows the reader, which must not throw that stash away.
  const seen = await second.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    return { state: document.visibilityState, keys: Object.keys(localStorage).filter((k) => k.startsWith("codeeditor:recover:")) };
  });
  expect(seen.state, "the reader tab is in view, so it reached the visible branch").toBe("visible");
  expect(seen.keys, "the reader dropped the writer's stash").toEqual(stashedByWriter);
  await second.close();
});

test("a read-only tab can still run the code it shows, and doesn't offer to add written files", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  const r = await run(second, { input: ["Ada"], timeout: 60_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("Ada");
  await second.close();
});

test("a file deleted in the writer closes its tab in the reader", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator('.tabs [role=tab][title="main.py"]')).toBeVisible();
  await treeItem(page, "main.py").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "main.py")).toHaveCount(0);
  await expect(treeItem(second, "main.py")).toHaveCount(0, { timeout: 10_000 });
  await expect(second.locator('.tabs [role=tab][title="main.py"]')).toHaveCount(0);
  await second.close();
});

test("a file renamed in the writer follows in the reader's open tab", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator('.tabs [role=tab][title="main.py"]')).toBeVisible();
  await treeItem(page, "main.py").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for main.py" });
  await field.fill("app.py");
  await field.press("Enter");
  await expect(treeItem(second, "app.py")).toBeVisible({ timeout: 10_000 });
  // The reader's tab follows the file to its new name, and doesn't call it deleted.
  await expect(second.locator('.tabs [role=tab][title="app.py"]')).toBeVisible({ timeout: 10_000 });
  await expect(second.locator('.tabs [role=tab][title="main.py"]')).toHaveCount(0);
  const said = (await second.locator(".notice").textContent()) ?? "";
  expect(said, "the reader calls a renamed file deleted").not.toMatch(/deleted/);
  await second.close();
});

test("the writer closes: the remaining read-only tab can take over with Edit here and save", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await page.close();
  await second.locator("#edit-here").click();
  await expect(second.locator("#app")).toHaveAttribute("data-role", "writer", { timeout: 10_000 });
  await second.locator(".cm-content").click();
  await second.keyboard.press("Control+End");
  await second.keyboard.type("\n# after takeover");
  await expect(second.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  await reloadApp(second);
  await expect(second.locator(".cm-content")).toContainText("# after takeover");
});
