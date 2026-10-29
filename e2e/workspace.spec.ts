import { expect, openApp, openFromTree, reloadApp, setCode, test, treeItem } from "./helpers";

// These tests reload; a reload while the app registers its service worker cancels sw.js (WebKit logs
// it). Offline behaviour isn't what is tested here, so the service worker is left out.
test.use({ serviceWorkers: "block" });

const activeTab = (page: import("@playwright/test").Page) => page.locator('.tabs [role=tab][aria-selected="true"]');

test("a first visit offers starters, and one becomes a saved, open file", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Write your first program" })).toBeVisible();
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toHaveAttribute("aria-current", "true");
  await expect(activeTab(page)).toHaveAttribute("title", "main.py");
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  await expect(page.locator("#app")).toHaveAttribute("data-runnable", "true");

  await reloadApp(page);
  await expect(treeItem(page, "main.py")).toBeVisible();
  await expect(activeTab(page)).toHaveAttribute("title", "main.py");
  await expect(page.locator('[data-empty="workspace"]')).toHaveCount(0);
});

test("files and folders are created, edited, renamed and deleted, and all of it survives a reload", async ({ page }) => {
  await openApp(page);

  // New folder at the top level.
  await page.locator("#new-folder").click();
  const folderName = page.getByRole("textbox", { name: "Name of the new folder at the top level" });
  await expect(folderName).toBeFocused();
  await folderName.fill("src");
  await folderName.press("Enter");
  await expect(treeItem(page, "src")).toHaveAttribute("aria-expanded", /true|false/);

  // A new file inside it (the folder is selected), opened and focused.
  await treeItem(page, "src").locator(":scope > .tree-row").click();
  await page.locator("#new-file").click();
  const fileName = page.getByRole("textbox", { name: "Name of the new file in src" });
  await fileName.fill("util.py");
  await fileName.press("Enter");
  await expect(activeTab(page)).toHaveAttribute("title", "src/util.py");
  await expect(page.locator(".cm-content")).toBeFocused(); // ready to type into
  await setCode(page, "def twice(x):\n    return 2 * x\n");
  // Autosave: the tab is clean again within a moment.
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");

  // A path typed with a slash creates the folders on the way, at the top level after clicking empty space.
  await page.locator(".tree-host").click({ position: { x: 20, y: 300 } });
  await page.locator("#new-file").click();
  const topName = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await topName.fill("lib/deep/notes.txt");
  await topName.press("Enter");
  await expect(treeItem(page, "lib/deep/notes.txt")).toBeVisible();

  // Rename with F2: a bad name is explained next to the field, which keeps focus.
  await treeItem(page, "src/util.py").focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("textbox", { name: "New name for util.py" });
  await expect(rename).toBeFocused();
  await rename.fill("con.py");
  await rename.press("Enter");
  await expect(rename).toHaveAttribute("aria-invalid", "true");
  await expect(rename).toBeFocused();
  const errorId = await rename.getAttribute("aria-describedby");
  await expect(page.locator(`#${errorId}`)).toBeVisible();
  await rename.fill("helpers.py");
  await rename.press("Enter");
  await expect(treeItem(page, "src/helpers.py")).toBeVisible();
  await expect(treeItem(page, "src/util.py")).toHaveCount(0);
  // Its open tab follows the new name (notes.txt, opened last, is still the active one).
  await expect(page.locator('.tabs [role=tab][title="src/helpers.py"]')).toHaveCount(1);
  await expect(page.locator('.tabs [role=tab][title="src/util.py"]')).toHaveCount(0);

  // Delete asks first; Cancel keeps it, Delete removes it and closes its tab.
  await treeItem(page, "lib/deep/notes.txt").focus();
  await page.keyboard.press("Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(treeItem(page, "lib/deep/notes.txt")).toBeVisible();
  await treeItem(page, "lib").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "lib")).toHaveCount(0);

  await reloadApp(page);
  await expect(treeItem(page, "src")).toBeVisible();
  await expect(treeItem(page, "lib")).toHaveCount(0);
  await expect(activeTab(page)).toHaveAttribute("title", "src/helpers.py");
  await expect(page.locator(".cm-content")).toContainText("return 2 * x");
});

test("a file that is still opening doesn't pull focus out of a menu opened meanwhile", async ({ page }) => {
  await openApp(page);
  // Hold back the editor's code (it loads with the first file) until the menu is open.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.locator('.starter[data-language="python"]').click();
  await expect(treeItem(page, "main.py")).toBeVisible();
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  release();
  await expect(activeTab(page)).toHaveAttribute("title", "main.py");
  await expect(page.locator(".cm-content")).toContainText('input("Your name: ")');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#file-actions")).toBeFocused();
});

test("an import adds files, and replacing an existing file asks first", async ({ page }) => {
  await openApp(page);
  const pick = async (files: { name: string; text: string }[]) => {
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: "Import files" }).click();
    await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: "text/plain", buffer: Buffer.from(f.text) })));
  };
  await pick([{ name: "a.py", text: "print('a')\n" }, { name: "b.c", text: "int main(void) { return 0; }\n" }]);
  await expect(treeItem(page, "a.py")).toBeVisible();
  await expect(treeItem(page, "b.c")).toBeVisible();
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "success");

  // The same name again: "Keep mine" leaves the file alone.
  await pick([{ name: "a.py", text: "print('replaced')\n" }]);
  const ask = page.getByRole("alertdialog");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep mine" }).click();
  await openFromTree(page, "a.py");
  await expect(page.locator(".cm-content")).toContainText("print('a')");

  // And Replace takes the imported copy, also in the open tab.
  await pick([{ name: "a.py", text: "print('replaced')\n" }]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator(".cm-content")).toContainText("print('replaced')");
});

// Ln/Col is written from the editor's own update. A text replaced from outside (here an import's
// Replace; a pull and a program's file go the same way) is no edit in the editor, so the editor
// manager says so itself (before 2026-10-21 Ln/Col kept the old line).
test("replacing the open file by an import moves Ln/Col to the cursor in the new text", async ({ page }) => {
  await openApp(page);
  const pick = async (files: { name: string; text: string }[]) => {
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: "Import files" }).click();
    await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: "text/plain", buffer: Buffer.from(f.text) })));
  };
  await pick([{ name: "a.py", text: "a = 1\nb = 2\nc = 3\nd = 4\n" }]);
  await openFromTree(page, "a.py");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  const position = page.locator("#status-pos");
  await expect(position).toHaveText("Ln 5, Col 1");
  await pick([{ name: "a.py", text: "x = 1\n" }]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator(".cm-content")).toContainText("x = 1");
  // The cursor keeps its place where it can: the end of the shorter text, line 2.
  await expect(position).toHaveText("Ln 2, Col 1");
});

test("binary files and Trojan Source text are refused on import, with the reason", async ({ page }) => {
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  const rlo = String.fromCodePoint(0x202e);
  await (await chooser).setFiles([
    { name: "homework.py", mimeType: "text/x-python", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]) },
    { name: "check.py", mimeType: "text/plain", buffer: Buffer.from(`access = "user${rlo} # admin"\n`) },
    { name: "fine.py", mimeType: "text/plain", buffer: Buffer.from("print(1)\n") },
  ]);
  await expect(treeItem(page, "fine.py")).toBeVisible();
  await expect(treeItem(page, "homework.py")).toHaveCount(0);
  await expect(treeItem(page, "check.py")).toHaveCount(0);
  const notice = page.locator(".notice");
  await expect(notice).toHaveAttribute("data-tone", "warning");
  await expect(notice).toContainText("homework.py");
  await expect(notice).toContainText("check.py");
});

test("Export saves the workspace as a .zip", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  await expect(activeTab(page)).toHaveAttribute("title", "main.c");
  const download = page.waitForEvent("download");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Export workspace (.zip)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Workspace.zip");
  const bytes = Buffer.concat(await (await file.createReadStream()).toArray());
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(bytes.includes(Buffer.from("main.c"))).toBe(true);
});
