// Downloading part of the workspace (0.18.0, owner's picks 2026-10-30): a file from the file list's
// menu comes out byte for byte as it was saved, a folder comes out as one .zip that unpacks to that
// folder, and the command palette does the same for the open file.
import type { Download, Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, setCode, test, treeItem } from "./helpers";
import { readZip } from "./zip-read";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const BOM = String.fromCodePoint(0xfeff);
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

async function fromMenu(page: Page, path: string, item: string): Promise<Download> {
  const download = page.waitForEvent("download");
  await treeItem(page, path).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  return download;
}

test("Download in a file's menu saves it exactly as stored: its name, its BOM and its CRLF line ends", async ({ page }) => {
  await openApp(page);
  const text = `${BOM}#include <stdio.h>\r\nint main(void) {\r\n    puts("hi");\r\n}\r\n`;
  await importFiles(page, [{ name: "windows.c", text }]);
  const d = await fromMenu(page, "windows.c", "Download");
  expect(d.suggestedFilename()).toBe("windows.c");
  expect((await bytesOf(d)).equals(Buffer.from(text))).toBe(true);
  await expect(page.locator(".notice")).toContainText("Saved windows.c.");
});

test("a folder downloads as one .zip named after it, holding only that folder", async ({ page }) => {
  await openApp(page);
  await create(page, "lab1/main.c", "int main(void) { return 0; }\n");
  await create(page, "lab1/data/in.txt", "3 4\n");
  await create(page, "lab10/other.c", "int x;\n"); // a folder whose name starts with "lab1" is not in it
  await create(page, "notes.txt", "not in the zip\n");
  const d = await fromMenu(page, "lab1", "Download as .zip");
  expect(d.suggestedFilename()).toBe("lab1.zip");
  const zip = readZip(await bytesOf(d));
  expect([...zip.files.keys()].sort()).toEqual(["lab1/data/in.txt", "lab1/main.c"]);
  expect(zip.files.get("lab1/data/in.txt")!.toString("utf8")).toBe("3 4\n");
  await expect(page.locator(".notice")).toContainText("Saved 2 files as lab1.zip.");
});

test("the command palette downloads the open file, and its folder as a .zip", async ({ page }) => {
  await openApp(page);
  await create(page, "week2/sum.py", "print(1 + 2)\n");
  await create(page, "week2/README.txt", "Week 2\n");
  await openFromTree(page, "week2/sum.py");
  const palette = async (command: string, words: string) => {
    const download = page.waitForEvent("download");
    await page.keyboard.press("F1");
    await expect(page.locator("dialog#palette")).toHaveAttribute("data-state", "ready");
    await page.keyboard.type(words);
    await expect(page.locator("#palette-list [role=option][aria-selected=true]")).toHaveAttribute("data-command", command);
    await page.keyboard.press("Enter");
    return download;
  };
  const one = await palette("download", "download the open file");
  expect(one.suggestedFilename()).toBe("sum.py");
  expect((await bytesOf(one)).toString("utf8")).toBe("print(1 + 2)\n");
  const folder = await palette("download-folder", "download the open file's folder");
  expect(folder.suggestedFilename()).toBe("week2.zip");
  expect([...readZip(await bytesOf(folder)).files.keys()].sort()).toEqual(["week2/README.txt", "week2/sum.py"]);
});
