// Renaming and deleting files that are open, and typing just before a reload or a closed tab, as a
// student does it (from the functional review, 2026-10-17).
import type { Page } from "@playwright/test";
import { expect, openApp, openFromTree, reloadApp, run, setCode, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const tabTitles = (page: Page) => page.locator(".tabs [role=tab]").evaluateAll((els) => els.map((e) => e.getAttribute("title")));

async function newFile(page: Page, path: string, text: string) {
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: /Name of the new file/ });
  await field.fill(path);
  await field.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
  await setCode(page, text);
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
}

test("renaming a folder moves its open tabs with it, and the run uses the new paths", async ({ page }) => {
  await openApp(page);
  await newFile(page, "src/helper.py", "def name():\n    return 'helper'\n");
  await newFile(page, "src/main.py", "from helper import name\nprint(name())\n");
  await treeItem(page, "src").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for src" });
  await field.fill("app");
  await field.press("Enter");
  await expect(treeItem(page, "app")).toBeVisible();
  expect((await tabTitles(page)).sort()).toEqual(["app/helper.py", "app/main.py"]);
  await page.locator('.tabs [role=tab][title="app/main.py"]').click();
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "app/main.py");
  const r = await run(page, { timeout: 60_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("helper");
  await reloadApp(page);
  expect((await tabTitles(page)).sort()).toEqual(["app/helper.py", "app/main.py"]);
});

test("renaming an expanded folder keeps it expanded", async ({ page }) => {
  await openApp(page);
  await newFile(page, "src/a.py", "A = 1\n");
  await expect(treeItem(page, "src")).toHaveAttribute("aria-expanded", "true");
  await treeItem(page, "src").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for src" });
  await field.fill("lib");
  await field.press("Enter");
  await expect(treeItem(page, "lib")).toBeVisible();
  // The file that is open in a tab (and was visible a moment ago) is still shown in the tree.
  await expect(treeItem(page, "lib"), "the renamed folder collapsed").toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "lib/a.py")).toBeVisible();
});

test("typing and renaming at once: the rename keeps what was just typed", async ({ page }) => {
  await openApp(page);
  await newFile(page, "notes.py", "a = 1\n");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("b = 2\n");
  // Straight to F2 on the file, before the 400 ms autosave.
  await treeItem(page, "notes.py").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for notes.py" });
  await field.fill("renamed.py");
  await field.press("Enter");
  await expect(treeItem(page, "renamed.py")).toBeVisible();
  await reloadApp(page);
  await openFromTree(page, "renamed.py");
  await expect(page.locator(".cm-content")).toContainText("b = 2");
});

test("renaming main.py to main.c switches the file to C (language, run target)", async ({ page }) => {
  await openApp(page);
  await newFile(page, "main.py", "print(1)\n");
  await expect(page.locator("#status-lang")).toHaveText("Python");
  await treeItem(page, "main.py").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for main.py" });
  await field.fill("main.c");
  await field.press("Enter");
  await expect(treeItem(page, "main.c")).toBeVisible();
  await expect(page.locator("#status-lang")).toHaveText("C");
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-runtime", "cpp");
});

test("deleting a folder with an open, just-edited file closes the tab without asking about unsaved text", async ({ page }) => {
  await openApp(page);
  await newFile(page, "tmp/scratch.py", "x = 1\n");
  await page.locator(".cm-content").click();
  await page.keyboard.type("# more\n");
  await treeItem(page, "tmp").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "tmp")).toHaveCount(0);
  await expect(page.locator(".tabs [role=tab]")).toHaveCount(0);
  await page.waitForTimeout(800); // a late autosave must not bring the file back
  await reloadApp(page);
  await expect(treeItem(page, "tmp")).toHaveCount(0);
  await expect(treeItem(page, "tmp/scratch.py")).toHaveCount(0);
});

test("reloading right after typing (before the 400 ms autosave) keeps the typing", async ({ page }) => {
  await openApp(page);
  await newFile(page, "quick.py", "a = 1\n");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("b = 2");
  await reloadApp(page);
  await expect(page.locator(".cm-content")).toContainText("b = 2");
});

test("closing the tab right after typing keeps the typing for the next visit", async ({ page, context }) => {
  await openApp(page);
  await newFile(page, "quick.py", "a = 1\n");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("c = 3");
  await page.close({ runBeforeUnload: true });
  const next = await context.newPage();
  await openApp(next);
  await expect(next.locator(".cm-content")).toContainText("c = 3");
});

test("text given up front in Input is read first, then the program asks for the rest live", async ({ page }) => {
  await openApp(page);
  await newFile(page, "two.py", "a = input('a? ')\nb = input('b? ')\nprint('sum', int(a) + int(b))\n");
  await page.locator("#stdin").evaluate((el) => ((el.closest("details") as HTMLDetailsElement).open = true));
  await page.locator("#stdin").fill("40\n");
  const r = await run(page, { input: ["2"], timeout: 60_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("sum 42");
});
