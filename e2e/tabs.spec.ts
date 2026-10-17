import { expect, importFiles, openApp, openFromTree, reloadApp, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });

const tab = (page: import("@playwright/test").Page, path: string) => page.locator(`.tabs [role=tab][title="${path}"]`);

async function threeOpen(page: import("@playwright/test").Page) {
  await openApp(page);
  await importFiles(page, [
    { name: "a.py", text: "print('a')\n" },
    { name: "b.py", text: "print('b')\n" },
    { name: "c.py", text: "print('c')\n" },
  ]);
  for (const p of ["a.py", "b.py", "c.py"]) await openFromTree(page, p);
  await expect(page.getByRole("tablist", { name: "Open files" }).getByRole("tab")).toHaveCount(3);
}

test("editor tabs follow the APG tabs pattern and close from the keyboard", async ({ page }) => {
  await threeOpen(page);
  await tab(page, "c.py").focus();
  await expect(page.locator('.tabs [role=tab][tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "b.py")).toBeFocused();
  await expect(tab(page, "b.py")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toContainText("print('b')");
  await page.keyboard.press("Home");
  await expect(tab(page, "a.py")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft"); // wraps
  await expect(tab(page, "c.py")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab(page, "c.py")).toBeFocused();
  // The editor panel is labelled by the selected tab.
  await expect(page.locator("#editor-panel")).toHaveAttribute("role", "tabpanel");
  const id = await tab(page, "c.py").getAttribute("id");
  await expect(page.locator("#editor-panel")).toHaveAttribute("aria-labelledby", id!);
  // The close buttons are outside the tab elements.
  await expect(page.locator(".tabs [role=tab] .tab-close")).toHaveCount(0);

  // Delete closes the focused tab; focus stays in the tab list.
  await page.keyboard.press("Delete");
  await expect(tab(page, "c.py")).toHaveCount(0);
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toBeFocused();

  // Enter moves into the editor; Alt+W closes the active file from there.
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toBeFocused();
  const before = await page.locator(".tabs [role=tab]").count();
  await page.keyboard.press("Alt+w");
  await expect(page.locator(".tabs [role=tab]")).toHaveCount(before - 1);

  // Middle-click closes too.
  await page.locator(".tabs [role=tab]").first().click({ button: "middle" });
  await expect(page.locator(".tabs [role=tab]")).toHaveCount(0);
  await expect(page.locator('[data-empty="no-file"]')).toBeVisible();
});

test("an unsaved file says so in its name and with a dot and italics, then autosaves", async ({ page }) => {
  await threeOpen(page);
  // Autosave runs 400 ms after typing stops, so record what the unsaved tab looked like the moment it
  // appeared instead of racing the save.
  await page.evaluate(() => {
    const seen: Record<string, string>[] = [];
    (window as unknown as { dirtySeen: typeof seen }).dirtySeen = seen;
    new MutationObserver(() => {
      const t = document.querySelector<HTMLElement>('.tab[data-dirty="true"]');
      if (!t || seen.length) return;
      const tabEl = t.querySelector<HTMLElement>("[role=tab]")!;
      seen.push({
        text: tabEl.textContent ?? "",
        label: tabEl.getAttribute("aria-label") ?? "",
        italic: getComputedStyle(t.querySelector(".tab-name")!).fontStyle,
        dot: getComputedStyle(t.querySelector(".dirty-dot")!).display === "none" ? "hidden" : "shown",
      });
    }).observe(document.querySelector(".tabs")!, { subtree: true, childList: true, attributes: true });
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type("  # edited");
  const seen = () => page.evaluate(() => (window as unknown as { dirtySeen: Record<string, string>[] }).dirtySeen[0] ?? null);
  await expect.poll(seen).not.toBeNull();
  // While unsaved: the name says so to screen readers, and shows a dot and italics (not colour alone).
  expect(await seen()).toEqual({ text: "c.py, unsaved", label: "", italic: "italic", dot: "shown" });
  // Autosave clears it within moments; the accessible name is back to the plain file name.
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "c.py", exact: true })).toBeVisible();

  // The edit was saved: a reload brings it back, with the same tabs open.
  await reloadApp(page);
  await expect(page.locator(".tabs [role=tab]")).toHaveCount(3);
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "c.py");
  await expect(page.locator(".cm-content")).toContainText("# edited");
});

test("Ctrl+S saves at once, without the browser's Save page dialog", async ({ page }) => {
  await threeOpen(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" # now");
  await page.keyboard.press("Control+s");
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0);
  await reloadApp(page);
  await expect(page.locator(".cm-content")).toContainText("# now");
});

// The tab's own close button is mouse-only (a tablist may hold only tabs): without a keyboard, a
// screen reader on a phone closes a file from its menu.
test("a file's menu closes its tab (a way to close without a keyboard)", async ({ page }) => {
  await threeOpen(page);
  await expect(tab(page, "b.py")).toBeVisible();
  await treeItem(page, "b.py").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close tab" }).click();
  await expect(tab(page, "b.py")).toHaveCount(0);
  await expect(page.locator(".tabs [role=tab]")).toHaveCount(2);
  await expect(treeItem(page, "b.py")).toBeVisible();
  // A file that isn't open has no Close tab item.
  await treeItem(page, "b.py").locator(":scope > .tree-row").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Close tab" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});
