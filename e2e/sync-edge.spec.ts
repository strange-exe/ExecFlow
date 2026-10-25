// GitHub sync against the mocked api.github.com (sync-fake.ts) in the unhappy situations a student
// meets (from the functional review, 2026-10-17): typing during a sync, a token revoked halfway
// through an upload, a server error, a file deleted on GitHub while it is open.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, setCode, test, treeItem } from "./helpers";
import { answer, connectGitHub, fillConnect, githubNoise, routeGitHub, saveKey, syncCount, syncNoise, syncStatus, waitSync, type GitHubRoute } from "./sync-fake";

test.use({ serviceWorkers: "block" });
test.use(syncNoise());
test.setTimeout(90_000);

/** The text stored on this computer for a path (IndexedDB "contents"), or null. */
function storedText(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all: { path: string; text: string }[] = await new Promise((resolve, reject) => {
      const q = db.transaction("contents").objectStore("contents").getAll();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    db.close();
    return all.find((r) => r.path === p)?.text ?? null;
  }, path);
}

/** Like waitSync, for a test that accepts more than one end state. */
async function waitSyncState(page: Page, after: number, state: RegExp) {
  await expect.poll(() => syncCount(page), { timeout: 30_000 }).toBeGreaterThan(after);
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", state, { timeout: 30_000 });
}

const activeTab = (page: Page, path: string) => page.locator(`.tabs [role=tab][aria-selected="true"][title="${path}"]`);

async function connected(page: Page, files: { name: string; text: string }[] = [{ name: "main.py", text: "print('hi')\n" }]): Promise<{ gh: GitHubRoute; n: number }> {
  const gh = await routeGitHub(page);
  await gh.fake.remoteCommit(Object.fromEntries(files.map((f) => [f.name, f.text])));
  await openApp(page);
  await importFiles(page, files);
  await expect(activeTab(page, files[0].name)).toBeVisible();
  const n = await syncCount(page);
  await connectGitHub(page);
  await waitSync(page, n, "synced");
  return { gh, n: await syncCount(page) };
}

test("typing into a file while a sync brings GitHub's change to it loses neither version", async ({ page }) => {
  const { gh, n } = await connected(page);
  await gh.fake.remoteCommit({ "main.py": "print('github')\n" });
  // Hold the download of GitHub's new main.py until the user has typed.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = false;
  gh.fake.interceptors.push(async (req) => {
    if (req.method === "GET" && req.path.startsWith("/git/blobs/") && !holding) {
      holding = true;
      await held;
    }
    return undefined;
  });
  await syncStatus(page).click();
  await expect.poll(() => holding, { timeout: 20_000 }).toBe(true);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# typed during the sync\n");
  release();
  // "conflict": the save kept both versions at once (the top bar then warns until the copy is opened).
  await waitSyncState(page, n, /^(synced|unsynced|conflict)$/);
  // Usually the pull lands before the 400 ms autosave: the save then finds GitHub's text stored and
  // keeps both (the typing becomes a conflict copy at once). If the autosave wins, the sync skips
  // main.py and the next sync makes the copy. Either way nothing may be overwritten.
  const copyPattern = /^main\.conflict-\d{8}-\d{6}\.py$/;
  const localCopies = async () => (await page.locator(".tree [role=treeitem]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path") ?? ""))).filter((p) => copyPattern.test(p));
  await page.waitForTimeout(1500); // longer than the autosave delay: a late save of the old buffer must not win
  const copiedAtOnce = (await localCopies()).length === 1;
  test.info().annotations.push({ type: "path", description: copiedAtOnce ? "the save kept both versions (copy after the first sync)" : "the sync skipped main.py (copy after the second sync)" });
  if (copiedAtOnce) {
    expect(await storedText(page, "main.py")).toBe("print('github')\n");
    await expect(page.locator(".notice")).toHaveAttribute("data-tone", "warning");
  }
  // Sync again (Ctrl+S) so both sides settle: GitHub gets the copy, and keeps its own main.py.
  await saveKey(page);
  // Either way a conflict copy now exists that hasn't been opened: the top bar says so.
  await waitSync(page, n + 1, "conflict");
  const remote = gh.fake.files();
  expect(remote["main.py"], JSON.stringify(remote)).toBe("print('github')\n");
  const copies = Object.keys(remote).filter((p) => copyPattern.test(p));
  expect(copies, JSON.stringify(remote)).toHaveLength(1);
  expect(remote[copies[0]]).toBe("print('hi')\n# typed during the sync\n");
  expect(await storedText(page, "main.py")).toBe("print('github')\n");
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  await expect(page.locator(".cm-content")).toContainText("print('github')");
  expect(await localCopies()).toEqual(copies);
  await treeItem(page, copies[0]).locator(":scope > .tree-row").click();
  await expect(activeTab(page, copies[0])).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("# typed during the sync");
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "synced");
});

test.describe("a token revoked in the middle of an upload", () => {
  test.use(syncNoise(...githubNoise(401, "/git/trees"), ...githubNoise(401, "/git/blobs"), ...githubNoise(401, "/git/commits")));

  test("stops, asks for a new token, and the new token finishes the upload", async ({ page }) => {
    const { gh, n } = await connected(page);
    let revoked = true;
    gh.fake.interceptors.push((req) => (revoked && req.method === "POST" ? answer(401, "Bad credentials") : undefined));
    await setCode(page, "print('pending')\n");
    await saveKey(page);
    await waitSync(page, n, "needs-token");
    expect(gh.fake.files()["main.py"]).toBe("print('hi')\n"); // nothing half-written
    revoked = false;
    await page.locator(".notice-action").click();
    await expect(page.locator("#connect-dialog")).toBeVisible();
    await fillConnect(page, {});
    const before = await syncCount(page);
    await page.locator("#connect-submit").click();
    await expect(page.locator("#connect-dialog")).toHaveCount(0, { timeout: 30_000 });
    await waitSync(page, before, "synced");
    expect(gh.fake.files()["main.py"]).toBe("print('pending')\n");
    await expect(syncStatus(page)).toHaveAttribute("data-unsynced", "0");
  });
});

test.describe("a server error while moving the branch", () => {
  test.use(syncNoise(...githubNoise(502, "/git/refs/heads/main")));

  test("shows Sync failed, keeps the change, and Try again uploads it", async ({ page }) => {
    const { gh, n } = await connected(page);
    let failing = true;
    gh.fake.interceptors.push((req) => (failing && req.method === "PATCH" ? answer(502, "Server Error") : undefined));
    await setCode(page, "print('after 502')\n");
    await saveKey(page);
    await waitSyncState(page, n, /^(failed|waiting)$/);
    expect(gh.fake.files()["main.py"]).toBe("print('hi')\n");
    failing = false;
    const before = await syncCount(page);
    await syncStatus(page).click();
    await waitSync(page, before, "synced");
    expect(gh.fake.files()["main.py"]).toBe("print('after 502')\n");
  });
});

test("a file deleted on GitHub closes its open tab with a notice, and leaves the tree", async ({ page }) => {
  const { gh, n } = await connected(page, [
    { name: "main.py", text: "print('hi')\n" },
    { name: "util.py", text: "U = 1\n" },
  ]);
  await treeItem(page, "util.py").locator(":scope > .tree-row").click();
  await expect(activeTab(page, "util.py")).toBeVisible();
  await gh.fake.remoteCommit({ "util.py": null });
  await syncStatus(page).click();
  await waitSync(page, n, "synced");
  await expect(treeItem(page, "util.py")).toHaveCount(0);
  await expect(page.locator('.tabs [role=tab][title="util.py"]')).toHaveCount(0);
  await expect(page.locator(".notice")).toContainText("util.py");
});

test("a conflict inside a folder keeps the copy in that folder, and the notice opens it", async ({ page }) => {
  const { gh, n } = await connected(page, [{ name: "lib.py", text: "L = 1\n" }]);
  // Move the file into a folder on both sides first: create lib/x.py locally and push it.
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: /Name of the new file/ });
  await field.fill("lib/x.py");
  await field.press("Enter");
  await expect(activeTab(page, "lib/x.py")).toBeVisible();
  await setCode(page, "X = 'base'\n");
  await saveKey(page);
  await waitSync(page, n, "synced");
  expect(gh.fake.files()["lib/x.py"]).toBe("X = 'base'\n");
  await gh.fake.remoteCommit({ "lib/x.py": "X = 'github'\n" });
  await setCode(page, "X = 'mine'\n");
  await saveKey(page);
  await waitSync(page, n + 1, "conflict");
  const copies = Object.keys(gh.fake.files()).filter((p) => /^lib\/x\.conflict-\d{8}-\d{6}\.py$/.test(p));
  expect(copies, JSON.stringify(Object.keys(gh.fake.files()))).toHaveLength(1);
  await page.locator(".notice-action").click();
  await expect(activeTab(page, copies[0])).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("X = 'mine'");
});

// Found while verifying (2026-10-17): the status redraws its icon and words when the sync screens
// load, which the first hover starts. A press that began on the old words and ended on the new
// ones was no click at all in Firefox (the Connect dialog never opened, 3 runs in 8 with tracing).
test("a click on the sync status opens Connect even when the status redraws during the press", async ({ page }) => {
  await routeGitHub(page);
  await openApp(page);
  const words = syncStatus(page).locator(".sync-words");
  const box = (await words.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // What a redraw does: new icon and words in place of the old ones, under the pointer.
  await syncStatus(page).evaluate((b) => b.replaceChildren(...[...b.childNodes].map((n) => n.cloneNode(true))));
  await page.mouse.up();
  await expect(page.locator("#connect-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#connect-dialog")).toHaveCount(0);
});
