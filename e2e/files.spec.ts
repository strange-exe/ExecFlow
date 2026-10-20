// Importing a real project folder, and the export round trip (from the functional review, 2026-10-17).
import { crc32, inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, expectActive, importFiles, openApp, openFromTree, setCode, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

/** Writes files under `root` (paths with "/"), creating folders. */
function writeTree(root: string, files: Record<string, Buffer | string>) {
  for (const [path, data] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
}

/** A small, independent .zip reader (stored and deflated entries), checking every CRC. */
function readZip(zip: Buffer): { files: Map<string, Buffer>; dirs: string[] } {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("no end of central directory");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20); // compressed size
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) {
      dirs.push(name.slice(0, -1));
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, data);
  }
  return { files, dirs };
}

/** Every path the workspace stores (files and folders), read from IndexedDB. */
function storedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all: { path: string }[] = await new Promise((resolve, reject) => {
      const q = db.transaction("entries").objectStore("entries").getAll();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    db.close();
    return all.map((e) => e.path).sort();
  });
}

async function exportZip(page: Page): Promise<Buffer> {
  const download = page.waitForEvent("download");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Export workspace (.zip)" }).click();
  const file = await download;
  return Buffer.concat(await (await file.createReadStream()).toArray());
}

async function importFolder(page: Page, dir: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import a folder" }).click();
  await (await chooser).setFiles(dir);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

test("importing a cloned project folder: every file that was left out is named, not hidden behind .git noise", async ({ page }, testInfo) => {
  const root = testInfo.outputPath("pick");
  const rlo = String.fromCodePoint(0x202e);
  const git: Record<string, string> = {};
  for (const name of ["HEAD", "config", "description", "index", "hooks/pre-commit.sample", "refs/heads/main", "logs/HEAD", "objects/ab/cdef"]) git[`proj/.git/${name}`] = "x\n";
  writeTree(root, {
    ...git,
    "proj/main.py": "from pkg.util import X\nprint(X)\n",
    "proj/pkg/__init__.py": "",
    "proj/pkg/util.py": "X = 5\n",
    "proj/notes/readme.md": "# notes\n",
    "proj/logo.png": PNG,
    "proj/big.txt": "a".repeat(1_200_000),
    "proj/trojan.py": `access = "user${rlo} # admin"\n`,
  });
  await openApp(page);
  await importFolder(page, join(root, "proj"));
  await expect(treeItem(page, "proj/main.py")).toBeVisible({ timeout: 20_000 });
  // Collapsed folders don't render their items, so the stored entries are checked.
  const stored = await storedPaths(page);
  for (const p of ["proj/pkg/util.py", "proj/pkg/__init__.py", "proj/notes/readme.md"]) expect(stored, p).toContain(p);
  expect(stored.filter((p) => /(^|\/)\.git(\/|$)|logo\.png|big\.txt|trojan\.py/.test(p))).toEqual([]);
  const notice = page.locator(".notice");
  await expect(notice).toHaveAttribute("data-tone", "warning");
  const text = (await notice.textContent()) ?? "";
  testInfo.annotations.push({ type: "notice", description: text });
  // The files a student would want back are named; ".git" internals may be summarised.
  const missing = ["logo.png", "big.txt", "trojan.py"].filter((n) => !text.includes(n));
  expect(missing, `notice: ${text}`).toEqual([]);

  // And the imported program runs as it did in the folder.
  await openFromTree(page, "proj/main.py");
  await expect(page.locator("#app")).toHaveAttribute("data-runnable", "true");
});

test("export, then import into a fresh browser: the same files with the same bytes (CRLF, BOM, folders)", async ({ page, browser }, testInfo) => {
  await openApp(page);
  const crlf = "print(1)\r\nprint(2)\r\n";
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x = 1\n")]);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles([
    { name: "crlf.py", mimeType: "text/plain", buffer: Buffer.from(crlf) },
    { name: "bom.py", mimeType: "text/plain", buffer: bom },
  ]);
  await expect(treeItem(page, "bom.py")).toBeVisible();
  // A folder with a file, and an empty folder.
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const name = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await name.fill("sub/inner.c");
  await name.press("Enter");
  // The new file opens a moment after Enter (it is stored first). Typing before then went into
  // crlf.py, the file still shown, and left inner.c empty (WebKit, fix stage, 2026-10-19).
  await expectActive(page, "sub/inner.c");
  await setCode(page, "int main(void) { return 0; }\n");
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-folder").click();
  const folder = page.getByRole("textbox", { name: "Name of the new folder at the top level" });
  await folder.fill("empty");
  await folder.press("Enter");
  await expect(treeItem(page, "empty")).toBeVisible();
  // Editing the CRLF file keeps CRLF for every line, including the new one.
  await openFromTree(page, "crlf.py");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("print(3)\n");
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");

  const first = readZip(await exportZip(page));
  expect([...first.files.keys()].sort()).toEqual(["bom.py", "crlf.py", "sub/inner.c"]);
  expect(first.files.get("crlf.py")!.toString("latin1")).toBe("print(1)\r\nprint(2)\r\nprint(3)\r\n");
  expect(first.files.get("bom.py")!.equals(bom)).toBe(true);
  expect(first.dirs).toContain("empty");

  // Into a fresh browser profile, through Import a folder.
  const root = testInfo.outputPath("unzipped");
  writeTree(root, Object.fromEntries([...first.files].map(([p, b]) => [`Workspace/${p}`, b])));
  const fresh = await browser.newContext({ serviceWorkers: "block" });
  const page2 = await fresh.newPage();
  await openApp(page2);
  await importFolder(page2, join(root, "Workspace"));
  await expect.poll(() => storedPaths(page2), { timeout: 20_000 }).toContain("Workspace/sub/inner.c");
  const second = readZip(await exportZip(page2));
  for (const [p, bytes] of first.files) expect(second.files.get(`Workspace/${p}`)?.equals(bytes), p).toBe(true);
  await fresh.close();
});

test("a file imported twice with different case is refused or merged, never two entries that clash", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "Main.py", text: "print('upper')\n" }]);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles([{ name: "main.py", mimeType: "text/plain", buffer: Buffer.from("print('lower')\n") }]);
  const ask = page.getByRole("alertdialog");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep mine" }).click();
  const paths = await page.locator(".tree [role=treeitem]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  expect(paths.filter((p) => p?.toLowerCase() === "main.py")).toHaveLength(1);
});
