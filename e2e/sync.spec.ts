// GitHub sync against a fake api.github.com (e2e/sync-fake.ts serves src/sync/test-helpers.ts's
// fake through page.route). Every test waits on data-syncs (one more finished sync) and
// data-sync-state, never on wording; the fake's own files and commits are the proof.
import { gzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, reloadApp, responseBodies, setCode, test, treeItem } from "./helpers";
import {
  answer,
  connectGitHub,
  EMPTY_REPO,
  expectNoToken,
  fillConnect,
  githubNoise,
  openConnect,
  routeGitHub,
  CAN_ROUTE_304,
  saveKey,
  secrets,
  syncCount,
  syncNoise,
  syncStatus,
  waitSync,
  type GitHubRoute,
} from "./sync-fake";

// These reload or go offline right after the first load: the service worker is not what they test.
test.use({ serviceWorkers: "block" });
test.use(syncNoise());

const editorText = (page: Page) => page.locator(".cm-content");
const activeTab = (page: Page, path: string) => page.locator(`.tabs [role=tab][aria-selected="true"][title="${path}"]`);

/** A repository that already holds main.py exactly as this computer has it: the first sync asks nothing. */
async function connectedWorkspace(page: Page, opts: { remember?: boolean } = {}): Promise<{ gh: GitHubRoute; n: number }> {
  const gh = await routeGitHub(page);
  await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
  await expect(activeTab(page, "main.py")).toBeVisible();
  const n = await syncCount(page);
  await connectGitHub(page, { remember: opts.remember });
  await waitSync(page, n, "synced");
  return { gh, n: await syncCount(page) };
}

test.describe("an empty repository", () => {
  test.use(syncNoise(...EMPTY_REPO));

  test("connecting starts it: the first sync uploads every file, and the token stays out of the page", async ({ page }) => {
    const gh = await routeGitHub(page);
    await openApp(page);
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
    await importFiles(page, [
      { name: "main.py", text: "from util import X\nprint(X)\n" },
      { name: "util.py", text: "X = 1\n" },
    ]);
    const n = await syncCount(page);
    await connectGitHub(page);
    await waitSync(page, n, "synced");
    expect(gh.fake.files()).toEqual({ "main.py": "from util import X\nprint(X)\n", "util.py": "X = 1\n" });
    // The first file starts the repository (Contents API), the rest arrive as one commit.
    expect(gh.fake.writes().filter((w) => w.startsWith("PUT /contents/"))).toEqual(["PUT /contents/main.py"]);
    expect(gh.fake.writes().filter((w) => w.startsWith("PATCH /git/refs/heads/main"))).toHaveLength(1);
    // The breadcrumb names the repository instead of the workspace: one name for one thing.
    await expect(page.locator("#repo-name")).toHaveText("me/workspace");
    await expect(page.locator("#ws-name")).toBeHidden();
    // Sync state is shown once, in the top bar (layout v2: the status bar's copy, #status-sync, is
    // gone); the workbench and the sync screens both keep its count there.
    await expect(syncStatus(page)).toHaveAttribute("data-unsynced", "0");
    await expect(page.locator("#status-sync")).toHaveCount(0);
    await expectNoToken(page, gh);
  });

  test("a public repository gets a clear warning, and connects only when asked again", async ({ page }) => {
    const gh = await routeGitHub(page, { private: false });
    await openApp(page);
    const dialog = await connectGitHub(page, { expectError: true });
    await expect(dialog).toHaveAttribute("data-state", "public");
    await expect(page.locator("#connect-result")).toHaveAttribute("data-tone", "warning");
    await expect(page.locator("#connect-result")).toContainText("public");
    await expect(page.locator("#connect-submit")).toHaveText("Connect anyway");
    const n = await syncCount(page);
    await page.locator("#connect-submit").click();
    await expect(dialog).toHaveCount(0);
    await waitSync(page, n, "synced");
    expect(gh.fake.head()).toBeNull(); // nothing to upload yet: still empty
  });
});

test("Ctrl+S saves and uploads the edit as one commit named after this device", async ({ page }) => {
  const { gh, n } = await connectedWorkspace(page);
  const commits = gh.fake.commits.size;
  await setCode(page, "print('changed')\n");
  await saveKey(page);
  await waitSync(page, n, "synced");
  expect(gh.fake.files()["main.py"]).toBe("print('changed')\n");
  expect(gh.fake.commits.size).toBe(commits + 1);
  expect([...gh.fake.commits.values()].at(-1)!.message).toMatch(/^CodeEditor sync from (Chrome|Firefox|Safari|Edge|a browser)( on \w+)?: \+0 ~1 -0$/);
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "success");
});

test("a change made on GitHub reaches the open, clean file and the tree; an idle sync costs one conditional read", async ({ page }, testInfo) => {
  const { gh, n } = await connectedWorkspace(page);
  await gh.fake.remoteCommit({ "main.py": "print('from github')\n", "lib/extra.py": "Y = 2\n" });
  await syncStatus(page).click();
  await waitSync(page, n, "synced");
  await expect(editorText(page)).toContainText("print('from github')");
  await expect(activeTab(page, "main.py")).not.toHaveAttribute("aria-label", /unsaved/);
  await expect(treeItem(page, "lib")).toBeVisible();
  await expect(page.locator(".notice")).toContainText("2 files downloaded");

  // A sync that changes nothing keeps the branch's ETag; from then on an idle sync is one GET answered 304.
  await syncStatus(page).click();
  await waitSync(page, n + 1, "synced");
  const before = gh.seen.length;
  await syncStatus(page).click();
  await waitSync(page, n + 2, "synced");
  const idle = gh.seen.slice(before);
  expect(idle[0].headers["if-none-match"]).toBeTruthy();
  // WebKit's routing can't answer 304 (sync-fake.ts), so there the fake answers in full.
  if (CAN_ROUTE_304(testInfo.project.name)) {
    expect(idle.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /repos/me/workspace/git/ref/heads/main"]);
  }
});

test("both sides changed main.py: GitHub's version keeps the name, this computer's is a conflict copy the notice opens", async ({ page }) => {
  const { gh, n } = await connectedWorkspace(page);
  await gh.fake.remoteCommit({ "main.py": "print('github')\n" });
  await setCode(page, "print('mine')\n");
  await saveKey(page);
  await waitSync(page, n, "synced");
  await expect(editorText(page)).toContainText("print('github')");
  const files = gh.fake.files();
  const copies = Object.keys(files).filter((p) => /^main\.conflict-\d{8}-\d{6}\.py$/.test(p));
  expect(copies).toHaveLength(1);
  expect(files["main.py"]).toBe("print('github')\n");
  expect(files[copies[0]]).toBe("print('mine')\n");
  await expect(treeItem(page, copies[0])).toBeVisible();
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "warning");
  await page.locator(".notice-action").click();
  await expect(activeTab(page, copies[0])).toBeVisible();
  await expect(editorText(page)).toContainText("print('mine')");
});

test.describe("first connect with different files on both sides", () => {
  async function setup(page: Page) {
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": "print('repo')\n", "only-remote.py": "R = 1\n" });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: "print('here')\n" }]);
    await expect(activeTab(page, "main.py")).toBeVisible();
    return gh;
  }

  test("asks first; Escape cancels with nothing written; Merge (the default) keeps both versions", async ({ page }) => {
    const gh = await setup(page);
    const writes = gh.fake.writes().length;
    let n = await syncCount(page);
    await connectGitHub(page);
    const ask = page.locator("#first-connect");
    await expect(ask).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Merge/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Merge/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await waitSync(page, n++, "needs-choice");
    await expect(ask).toHaveCount(0);
    expect(gh.fake.writes()).toHaveLength(writes);
    await expect(treeItem(page, "only-remote.py")).toHaveCount(0);
    await expect(editorText(page)).toContainText("print('here')");

    await syncStatus(page).click();
    await expect(ask).toBeVisible();
    await page.locator("#first-connect-sync").click();
    await waitSync(page, n++, "synced");
    const files = gh.fake.files();
    const copy = Object.keys(files).find((p) => /^main\.conflict-\d{8}-\d{6}\.py$/.test(p));
    expect(files["main.py"]).toBe("print('repo')\n");
    expect(copy && files[copy]).toBe("print('here')\n");
    expect(files["only-remote.py"]).toBe("R = 1\n");
    await expect(treeItem(page, "only-remote.py")).toBeVisible();
    await expect(editorText(page)).toContainText("print('repo')");
  });

  test("'Use the repository's versions' replaces this computer's copy, without a conflict copy", async ({ page }) => {
    const gh = await setup(page);
    const n = await syncCount(page);
    await connectGitHub(page);
    await page.getByRole("radio", { name: "Use the repository's versions" }).check();
    await page.locator("#first-connect-sync").click();
    await waitSync(page, n, "synced");
    expect(Object.keys(gh.fake.files()).sort()).toEqual(["main.py", "only-remote.py"]);
    await expect(editorText(page)).toContainText("print('repo')");
  });
});

test.describe("a token GitHub rejects", () => {
  test.use(syncNoise(...githubNoise(401), ...githubNoise(401, "/git/ref/heads/main")));

  test("connecting with it shows one plain sentence, clears the field and sends nothing more", async ({ page }) => {
    const gh = await routeGitHub(page);
    await openApp(page);
    const dialog = await openConnect(page);
    await fillConnect(page, { token: `github_pat_${"Z".repeat(60)}` });
    await page.locator("#connect-submit").click();
    await expect(dialog).toHaveAttribute("data-state", "failed");
    await expect(page.locator("#connect-token")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#connect-token-error")).toContainText("GitHub didn't accept this token");
    await expect(page.locator("#connect-token")).toHaveValue("");
    await expect(page.locator("#connect-token")).toBeFocused();
    expect(gh.seen).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
  });

  test("a token revoked later stops syncing and asks for a new one", async ({ page }) => {
    const { gh, n } = await connectedWorkspace(page);
    gh.fake.interceptors.push(() => answer(401, "Bad credentials"));
    await setCode(page, "print('after revoke')\n");
    await saveKey(page);
    await waitSync(page, n, "needs-token");
    await expect(page.locator(".notice")).toHaveAttribute("data-tone", "error");
    // The rejected token is never sent again (repeated bad credentials lock an account out).
    const sent = gh.seen.length;
    await saveKey(page);
    // Ctrl+S now only saves, and offers to enter a token (an info notice instead of the error).
    await expect(page.locator(".notice")).toHaveAttribute("data-tone", "info");
    expect(gh.seen).toHaveLength(sent);
    await page.locator(".notice-action").click();
    await expect(page.locator("#connect-dialog")).toBeVisible();
    await expect(page.locator("#connect-owner")).toHaveValue("me");
    await expect(page.locator("#connect-repo")).toHaveValue("workspace");
    await expect(page.locator("#connect-token")).toBeFocused();
  });
});

test("offline: an edit waits and says so, then syncs once the connection is back", async ({ page, context }) => {
  const { gh, n } = await connectedWorkspace(page);
  // Python starts in the background for main.py, and once it has, main.ts fetches the service
  // worker helper chunk. Offline before that (and without the blocked service worker's cache) that
  // download fails, which is the network going away, not sync: let it settle first.
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", /^(ready|failed)$/, { timeout: 60_000 });
  // The same for a font face first needed after the edit: an unsaved tab's name is italic in the
  // file-name (code) font since layout v2, and with the service worker blocked that face can't
  // arrive once the network is gone.
  await page.evaluate(() => document.fonts.load("italic 400 15px 'Source Code Pro'"));
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await setCode(page, "print('offline edit')\n");
  const sent = gh.seen.length;
  await saveKey(page);
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "offline");
  await expect(syncStatus(page)).toHaveAccessibleName(/^Offline: changes are saved here and will sync later/);
  // A new file counts as unsynced too (the top bar's sync status, the one place it is shown).
  await importFiles(page, [{ name: "new.py", text: "N = 1\n" }]);
  await expect(syncStatus(page)).toHaveAttribute("data-unsynced", "2");
  await expect(syncStatus(page)).toHaveAccessibleName(/^Offline: changes are saved here and will sync later/);
  expect(gh.seen).toHaveLength(sent);
  await context.setOffline(false);
  await waitSync(page, n, "synced");
  expect(gh.fake.files()).toEqual({ "main.py": "print('offline edit')\n", "new.py": "N = 1\n" });
});

test.describe("rate limits", () => {
  test.use(syncNoise(...githubNoise(403, "/git/ref/heads/main")));

  test("back off with a countdown, then sync by themselves", async ({ page }) => {
    const { gh, n } = await connectedWorkspace(page);
    let limited = false;
    gh.fake.interceptors.push((req) => {
      if (limited || req.method !== "GET") return undefined;
      limited = true;
      return answer(403, "API rate limit exceeded for user.", { "retry-after": "2", "x-ratelimit-remaining": "0" });
    });
    await setCode(page, "print('limited')\n");
    await saveKey(page);
    await waitSync(page, n, "waiting");
    await expect(syncStatus(page)).toHaveAccessibleName(/retrying in \d+ s/);
    await waitSync(page, n + 1, "synced");
    expect(gh.fake.files()["main.py"]).toBe("print('limited')\n");
  });
});

test("the token's shape is checked before anything is sent; a pasted repository URL fills both fields", async ({ page }) => {
  const gh = await routeGitHub(page);
  await openApp(page);
  const dialog = await openConnect(page);
  await page.locator("#connect-owner").fill("https://github.com/me/workspace.git");
  await expect(page.locator("#connect-owner")).toHaveValue("me");
  await expect(page.locator("#connect-repo")).toHaveValue("workspace");
  await page.locator("#connect-token").fill("hello there");
  await page.locator("#connect-submit").click();
  await expect(dialog).toHaveAttribute("data-state", "invalid");
  await expect(page.locator("#connect-token")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#connect-token")).toBeFocused();
  await page.locator("#connect-token").fill(`ghp_${"a".repeat(40)}`);
  await expect(page.locator("#connect-token-note")).toHaveAttribute("data-tone", "warning");
  await expect(page.locator("#connect-token-note")).toContainText("classic token");
  await page.locator("#connect-owner").fill("bad owner");
  await page.locator("#connect-submit").click();
  await expect(page.locator("#connect-owner")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#connect-owner")).toBeFocused();
  expect(gh.seen).toEqual([]);
  // The steps link to GitHub's token page, in a new tab that gets neither the opener nor a referrer.
  const link = page.getByRole("link", { name: /fine-grained token page/ });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(new URL((await link.getAttribute("href"))!).pathname).toBe("/settings/personal-access-tokens/new");
  await expect(page.locator("#connect-remember")).not.toBeChecked();
  await expect(page.locator("#connect-token")).toHaveAttribute("type", "password");
  await expect(page.locator("#connect-token")).toHaveAttribute("autocomplete", "off");
  await expect(page.locator("#connect-token")).toHaveAttribute("spellcheck", "false");
});

test.describe("remembering the token", () => {
  test("off by default: after a reload the token is asked again, and nothing was stored", async ({ page }) => {
    const { gh } = await connectedWorkspace(page);
    expect((await secrets(page, gh.token)).hasToken).toBe(false);
    await reloadApp(page);
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "needs-token");
    await expect(page.locator("#repo-name")).toHaveText("me/workspace");
  });

  test("on: it is stored encrypted, a reload syncs again by itself, and Disconnect forgets it", async ({ page }) => {
    const { gh } = await connectedWorkspace(page, { remember: true });
    const stored = await secrets(page, gh.token);
    expect(stored).toEqual({ hasKey: true, extractable: false, hasToken: true, clear: false });
    await gh.fake.remoteCommit({ "main.py": "print('while away')\n" });
    await reloadApp(page);
    // The startup sync brings in what changed meanwhile.
    await waitSync(page, 0, "synced");
    await expect(editorText(page)).toContainText("print('while away')");
    await expectNoToken(page, gh);

    await page.locator("#settings-button").click();
    await page.locator("#settings-disconnect").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
    await expect(page.locator("#repo-name")).toBeHidden();
    expect((await secrets(page, gh.token)).hasToken).toBe(false);
    const sent = gh.seen.length;
    await saveKey(page);
    await page.waitForTimeout(300); // a sync would have started at once
    expect(gh.seen).toHaveLength(sent);
  });
});

test("the sync screens load only when needed: not on a first visit, but with the Connect dialog", async ({ page }) => {
  // The click below also prefetches the editor chunk (the pointer is over the empty workspace), whose
  // body can still be arriving when the test ends: responseBodies keeps that read from failing it.
  const chunks = responseBodies(page, (path) => /^\/assets\/[^/]+\.js$/.test(path), (path, b) => ({ path, gzip: gzipSync(b).length, sync: b.includes("X-GitHub-Api-Version") }));
  await routeGitHub(page);
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  expect((await chunks.settled()).filter((c) => c.sync)).toEqual([]);
  await page.locator('[data-empty="workspace"]').getByRole("button", { name: "Connect GitHub" }).click();
  await expect(page.locator("#connect-dialog")).toBeVisible();
  const sync = (await chunks.settled()).filter((c) => c.sync);
  expect(sync).toHaveLength(1);
  test.info().annotations.push({ type: "sync chunk gzip", description: `${sync[0].path} ${sync[0].gzip} bytes` });
  expect(sync[0].gzip).toBeLessThan(40 * 1024);
});
