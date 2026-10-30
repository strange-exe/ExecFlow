// "Choose files to download or share..." and folder code links (0.18.0, owner's picks 2026-10-30): a
// checklist dialog (the keyboard ticks it, folders show "mixed"), a download named after what is
// ticked, a folder link that opens in someone else's browser as a new folder (lab1, then lab1-2),
// a selection too big for a link, and a hostile folder link that is refused before any preview.
import { deflateRawSync } from "node:zlib";
import type { Download, Page } from "@playwright/test";
import { expect, importFiles, openApp, setCode, test, treeItem } from "./helpers";
import { readZip } from "./zip-read";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const bytesOf = async (d: Download) => Buffer.concat(await (await d.createReadStream()).toArray());

async function create(page: Page, path: string, text: string) {
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await field.fill(path);
  await field.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
  await setCode(page, text);
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
}

async function openChooser(page: Page) {
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Choose files to download or share..." }).click();
  const dialog = page.locator("dialog#choose-files");
  await expect(dialog).toHaveAttribute("data-state", "ready");
  return dialog;
}

const box = (page: Page, path: string) => page.locator(`dialog#choose-files input[data-path="${path}"]`);

async function lab(page: Page) {
  await create(page, "lab1/main.c", '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%d\\n", twice(21)); return 0; }\n');
  await create(page, "lab1/util.h", "#pragma once\nstatic inline int twice(int x) { return 2 * x; }\n");
  await create(page, "notes.txt", "my notes\n");
}

test("the keyboard ticks files and folders; a folder shows mixed; Download names and saves what is ticked", async ({ page }) => {
  await openApp(page);
  await lab(page);
  await treeItem(page, "notes.txt").locator(":scope > .tree-row").click();
  const dialog = await openChooser(page);
  // The file list's selection starts ticked, and has the focus.
  await expect(box(page, "notes.txt")).toBeChecked();
  await expect(box(page, "notes.txt")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(box(page, "notes.txt")).not.toBeChecked();
  await expect(dialog.locator("#choose-summary")).toHaveText("Nothing ticked yet.");
  await box(page, "lab1/main.c").focus();
  await page.keyboard.press("Space");
  expect(await box(page, "lab1").evaluate((b) => (b as HTMLInputElement).indeterminate)).toBe(true);
  await expect(dialog.locator("#choose-download")).toHaveText("Download main.c");
  await box(page, "lab1").focus();
  await page.keyboard.press("Space");
  await expect(box(page, "lab1/util.h")).toBeChecked();
  expect(await box(page, "lab1").evaluate((b) => (b as HTMLInputElement).indeterminate)).toBe(false);
  await expect(dialog.locator("#choose-summary")).toContainText("2 files ticked");
  await expect(dialog.locator("#choose-download")).toHaveText("Download lab1.zip");
  const download = page.waitForEvent("download");
  await dialog.locator("#choose-download").click();
  const d = await download;
  expect(d.suggestedFilename()).toBe("lab1.zip");
  expect([...readZip(await bytesOf(d)).files.keys()].sort()).toEqual(["lab1/main.c", "lab1/util.h"]);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".notice")).toContainText("Saved 2 files as lab1.zip.");
});

test("Download and Share link with nothing ticked say so, and do nothing", async ({ page }) => {
  await openApp(page);
  await lab(page);
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } }); // nothing selected
  const dialog = await openChooser(page);
  await expect(dialog.locator("#choose-summary")).toHaveText("Nothing ticked yet.");
  await dialog.locator("#choose-download").click();
  await expect(dialog.locator("#choose-result")).toHaveText("Tick at least one file to download.");
  await dialog.locator("#choose-share").click();
  await expect(dialog.locator("#choose-result")).toHaveText("Tick at least one file to share.");
  await expect(dialog).toHaveAttribute("data-state", "ready");
});

test("a shared folder opens in another browser as a new folder, previewed first; a second add is lab1-2", async ({ page, browser }) => {
  await openApp(page);
  await lab(page);
  const dialog = await openChooser(page);
  await box(page, "notes.txt").uncheck(); // the file list's selection (the file made last) starts ticked
  await box(page, "lab1").check();
  await dialog.locator("#choose-share").click();
  await expect(dialog).toHaveAttribute("data-state", "shared");
  const url = await dialog.locator("#choose-link").inputValue();
  expect(url).toMatch(/\/#code=2\.[A-Za-z0-9_-]+$/);
  await expect(dialog.locator("#choose-copy")).toBeFocused();

  // Someone else: a fresh profile.
  const other = await browser.newContext();
  const them = await other.newPage();
  await openApp(them);
  for (const expected of ["lab1", "lab1-2"]) {
    await them.goto(url);
    const open = them.locator("dialog.code-link");
    await expect(open).toHaveAttribute("data-state", "ready");
    await expect(open.locator(".dialog-title")).toHaveText("Open the folder lab1?");
    await expect(open.locator("#code-link-preview")).toContainText("#include");
    await open.locator("#code-link-file").selectOption({ label: "util.h" });
    await expect(open.locator("#code-link-preview")).toContainText("twice");
    if (expected === "lab1-2") await expect(open.locator("#code-link-about")).toContainText("so this one is added as lab1-2");
    await open.locator("#code-link-add").click();
    await expect(open).toHaveCount(0);
    await expect(treeItem(them, `${expected}/main.c`)).toBeVisible();
    await expect(treeItem(them, `${expected}/util.h`)).toBeVisible();
    await expect(them.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", `${expected}/main.c`);
  }
  await other.close();
});

test("a selection too big for a link says how big, keeps Download, and makes no link", async ({ page }) => {
  await openApp(page);
  // Text that doesn't compress: a random-looking sequence, well past 8,000 characters as a link.
  let seed = 3;
  const line = () => Array.from({ length: 80 }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join("");
  await create(page, "big/more.txt", "x\n");
  // Imported, not typed (the editor shows only the lines in view): it lands in big/, the folder selected.
  await importFiles(page, [{ name: "data.txt", text: `${Array.from({ length: 175 }, line).join("\n")}\n` }]);
  await expect(treeItem(page, "big/data.txt")).toBeVisible();
  const dialog = await openChooser(page);
  await box(page, "big").check();
  await dialog.locator("#choose-share").click();
  await expect(dialog.locator("#choose-result")).toContainText(/These files are too big for a link \(it would be [\d,]+ characters\)/);
  await expect(dialog.locator("#choose-link")).toBeHidden();
  await expect(dialog).toHaveAttribute("data-state", "ready");
  await expect(dialog.locator("#choose-download")).toHaveText("Download big.zip");
});

test("a hostile folder link (a path that climbs out) is refused with its reason, before any preview", async ({ page }) => {
  await openApp(page);
  const hash = `#code=2.${deflateRawSync(JSON.stringify({ d: "lab", f: [{ n: "../escape.c", t: "int x;" }] })).toString("base64url")}`;
  await page.goto(`/${hash}`);
  await expect(page.locator(".notice")).toContainText("This code link's file name can't be used");
  await expect(page.locator("dialog.code-link")).toHaveCount(0);
  await expect(treeItem(page, "escape.c")).toHaveCount(0);
});
