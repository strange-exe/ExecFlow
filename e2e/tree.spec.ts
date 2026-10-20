import { expect, expectActive, importFiles, openApp, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });

const selected = (page: import("@playwright/test").Page) => page.locator('.tree [role=treeitem][aria-selected="true"]');

async function setUp(page: import("@playwright/test").Page) {
  await openApp(page);
  await importFiles(page, [
    { name: "alpha.py", text: "print('alpha')\n" },
    { name: "beta.py", text: "print('beta')\n" },
    { name: "gamma.py", text: "print('gamma')\n" },
  ]);
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const name = page.getByRole("textbox", { name: /Name of the new file/ });
  await name.fill("lib/util.py");
  await name.press("Enter");
  await expect(treeItem(page, "lib/util.py")).toBeVisible();
  // The new file opens a moment later and takes the focus (workbench createEntry). Wait for that
  // before a test moves the focus in the tree: in a full run (2026-10-21) Shift+F10 on beta.py
  // opened no menu, most likely because the editor had just taken the focus.
  await expectActive(page, "lib/util.py");
  await expect(page.locator(".cm-content")).toBeFocused();
  // Collapse lib again and start from the list itself.
  await treeItem(page, "lib").locator(":scope > .tree-row").click();
  await expect(treeItem(page, "lib")).toHaveAttribute("aria-expanded", "false");
}

test("the file tree follows the APG treeview keyboard pattern", async ({ page }) => {
  await setUp(page);
  // Ctrl+Shift+E moves focus into the tree, onto the chosen item (lib).
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Shift+E");
  await expect(treeItem(page, "lib")).toBeFocused();
  await expect(page.locator(".tree [role=treeitem][tabindex='0']")).toHaveCount(1); // one tab stop

  await page.keyboard.press("ArrowDown");
  await expect(treeItem(page, "alpha.py")).toBeFocused();
  await expect(selected(page)).toHaveAttribute("data-path", "alpha.py");
  await page.keyboard.press("End");
  await expect(treeItem(page, "gamma.py")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(treeItem(page, "lib")).toBeFocused();

  // Right opens a closed folder, then moves to its first child; Left goes back up, then closes it.
  await page.keyboard.press("ArrowRight");
  await expect(treeItem(page, "lib")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(treeItem(page, "lib/util.py")).toBeFocused();
  await expect(treeItem(page, "lib/util.py")).toHaveAttribute("aria-level", "2");
  await page.keyboard.press("ArrowLeft");
  await expect(treeItem(page, "lib")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(treeItem(page, "lib")).toHaveAttribute("aria-expanded", "false");

  // Type-ahead.
  await page.keyboard.press("g");
  await expect(treeItem(page, "gamma.py")).toBeFocused();
  await page.waitForTimeout(700);
  await page.keyboard.type("be");
  await expect(treeItem(page, "beta.py")).toBeFocused();

  // Space opens and stays in the tree; Enter opens and moves into the editor.
  await page.keyboard.press(" ");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "beta.py");
  await expect(treeItem(page, "beta.py")).toBeFocused();
  await expect(treeItem(page, "beta.py")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "gamma.py");
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("F2, Delete and the context menu work from the keyboard, and focus comes back", async ({ page }) => {
  await setUp(page);
  await treeItem(page, "beta.py").focus();

  // F2 then Escape: nothing changes, focus is back on the item.
  await page.keyboard.press("F2");
  await expect(page.getByRole("textbox", { name: "New name for beta.py" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(treeItem(page, "beta.py")).toBeFocused();

  // Delete asks; Escape on the question cancels and returns focus.
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(treeItem(page, "beta.py")).toBeFocused();

  // Shift+F10 opens the item's menu (APG menu): focus on the first item, arrows move, Escape closes.
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(treeItem(page, "beta.py")).toBeFocused();

  // The menu's Rename starts the same name field.
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const field = page.getByRole("textbox", { name: "New name for beta.py" });
  await field.fill("second.py");
  await field.press("Enter");
  await expect(treeItem(page, "second.py")).toBeFocused();

  // The More file actions button is a menu button too.
  const more = page.locator("#file-actions");
  await more.focus();
  await page.keyboard.press("ArrowDown");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
});

test("a read-only file from GitHub is marked and explained, and conflict copies are flagged", async ({ page }) => {
  await openApp(page);
  // Seed the workspace the way a sync would: an opaque entry and a conflict copy, written to IndexedDB.
  await page.evaluate(async () => {
    const open = indexedDB.open("codeeditor");
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const ws = await new Promise<{ id: string }>((resolve) => {
      const req = db.transaction("workspaces").objectStore("workspaces").getAll();
      req.onsuccess = () => resolve(req.result[0]);
    });
    const tx = db.transaction(["entries", "contents", "workspaces"], "readwrite");
    const meta = { size: 4, mtime: Date.now(), ctime: Date.now(), eol: "\n", bom: false, localSha: null, baseSha: null, ws: ws.id, parent: "" };
    tx.objectStore("entries").put({ ...meta, path: "logo.png", name: "logo.png", kind: "file", opaque: { sha: "a".repeat(40), mode: "100644" } });
    tx.objectStore("entries").put({ ...meta, path: "main.conflict-20261017-101500.py", name: "main.conflict-20261017-101500.py", kind: "file" });
    tx.objectStore("contents").put({ ws: ws.id, path: "main.conflict-20261017-101500.py", text: "x\n" });
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  });
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  const logo = treeItem(page, "logo.png");
  await expect(logo).toHaveAttribute("data-opaque", "true");
  await expect(logo).toHaveAccessibleDescription(/read-only \(binary or special file\)/);
  await expect(logo.locator(".tree-badge")).toHaveAttribute("title", /Read-only/);
  const copy = treeItem(page, "main.conflict-20261017-101500.py");
  await expect(copy).toHaveAccessibleDescription(/conflict copy/);
  // Opening the read-only file explains instead of showing bytes.
  await logo.locator(":scope > .tree-row").click();
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "info");
  await expect(page.locator('.tabs [role=tab][title="logo.png"]')).toHaveCount(0);
});
