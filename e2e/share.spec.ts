// Share link (.claude/design/batch5/share-link.md): the file menu (tree and More file actions) and
// the command palette open one dialog with two links. The repository link is pinned to the commit
// that holds the file's synced content; a file with changes not on GitHub (or never synced) gets
// Sync now first. The public link is a secret gist, created only on an explicit press, once.
// GitHub is the in-memory fake (e2e/sync-fake.ts, POST /gists included); the clipboard is a
// recorder (one Chromium test uses the real one). Waits use state attributes, never wording.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, setCode, showFiles, test, treeItem } from "./helpers";
import {
  answer, connectGitHub, expectNoToken, GHU1, githubNoise, routeGitHub, routeSignIn, saveKey, signInAndPick, syncCount, syncNoise, syncStatus, waitSync, type GitHubRoute,
} from "./sync-fake";
import type { FakeGitHubOptions, RemoteChange } from "../src/sync/test-helpers";

test.use({ serviceWorkers: "block" });
test.use(syncNoise());

const dialog = (page: Page) => page.locator("dialog#share-dialog");
const primary = (page: Page) => page.locator("#share-primary");
const link = (page: Page) => page.locator("#share-link");
const result = (page: Page) => page.locator("#share-result");
const MAIN = "print('hi')\n";

/** The HTTP error and console line an expected POST /gists failure leaves (the fixture fails on others). */
const gistNoise = (status: number) => [new RegExp(`^HTTP ${status}: https://api\\.github\\.com/gists$`), new RegExp(`^Failed to load resource: the server responded with a status of ${status}( \\(.*\\))?$`)];

/** navigator.clipboard.writeText records what it was given, or refuses when __refuseCopy is set. */
async function recordClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[]; __refuseCopy: boolean };
    w.__copied = [];
    w.__refuseCopy = false;
    const fake = {
      writeText: (text: string) => (w.__refuseCopy ? Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")) : (w.__copied.push(text), Promise.resolve())),
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => fake });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** A workspace connected to a repository holding main.py (and `extra`), synced. */
async function connected(page: Page, o: { extra?: Record<string, RemoteChange>; fake?: FakeGitHubOptions; main?: string } = {}): Promise<GitHubRoute> {
  const gh = await routeGitHub(page, o.fake);
  const main = o.main ?? MAIN;
  await gh.fake.remoteCommit({ "main.py": main, ...o.extra });
  await recordClipboard(page);
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: main }]);
  const n = await syncCount(page);
  await connectGitHub(page);
  await waitSync(page, n, "synced");
  await dismissNotice(page);
  return gh;
}

/** A workspace connected to a PUBLIC repository holding main.py ("Connect anyway"), synced. */
async function connectedPublic(page: Page): Promise<GitHubRoute> {
  const gh = await routeGitHub(page, { private: false });
  await gh.fake.remoteCommit({ "main.py": MAIN });
  await recordClipboard(page);
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  const n = await syncCount(page);
  // The Connect dialog warns about a public repository first; Connect again connects.
  await connectGitHub(page, { expectError: true });
  await expect(page.locator("#connect-dialog")).toHaveAttribute("data-state", "public");
  await page.locator("#connect-submit").click();
  await waitSync(page, n, "synced");
  await dismissNotice(page);
  return gh;
}

async function dismissNotice(page: Page) {
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
}

/**
 * Once the dialog is open: the repository link is chosen (the code link is the default, tested in
 * its own describe), unless `choice` keeps the default.
 */
async function choose(page: Page, choice: "repo" | "code") {
  await expect(dialog(page)).toHaveAttribute("data-state", /./);
  if (choice !== "repo" || !(await page.locator("#share-repo").count())) return;
  // Then focus it, as the keyboard would: WebKit's click checks a radio without focusing it (and
  // takes the focus off what had it).
  await page.locator("#share-repo").check();
  await page.locator("#share-repo").focus();
}

/** Right-click on the file in the tree, then Share link... */
async function shareFromTree(page: Page, path: string, choice: "repo" | "code" = "repo") {
  await showFiles(page);
  await treeItem(page, path).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await choose(page, choice);
}

async function shareFromMore(page: Page, choice: "repo" | "code" = "repo") {
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await choose(page, choice);
}

const gistPosts = (gh: GitHubRoute) => gh.seen.filter((r) => r.method === "POST" && r.url.split("?")[0] === "https://api.github.com/gists");

test.describe("not connected", () => {
  test("the code link is ready at once; the GitHub links offer Connect GitHub, which opens the Connect dialog", async ({ page }) => {
    const gh = await routeGitHub(page);
    await recordClipboard(page);
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: MAIN }]);
    await shareFromTree(page, "main.py", "code");
    await expect(page.locator("#share-dialog-title")).toHaveText("Share main.py");
    await expect(page.locator("#share-code")).toBeChecked();
    await expect(page.locator("#share-code")).toBeFocused();
    await expect(dialog(page)).toHaveAttribute("data-state", "code");
    const url = await link(page).inputValue();
    expect(url.startsWith(`${new URL(page.url()).origin}/#code=1.`)).toBe(true);
    await primary(page).click();
    expect(await copied(page)).toEqual([url]);
    // Nothing was sent to make it.
    expect(gh.seen).toEqual([]);
    for (const choice of ["repo", "gist"] as const) {
      await page.locator(`#share-${choice}`).check();
      await expect(dialog(page)).toHaveAttribute("data-state", "not-connected");
      await expect(page.locator("#share-pending")).toContainText("connect GitHub first");
      await expect(primary(page)).toHaveText("Connect GitHub...");
    }
    await primary(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("#connect-dialog")).toBeVisible();
  });
});

test.describe("the repository link", () => {
  test("is pinned to the synced commit, opens only for the repository's people, and Copy link copies it", async ({ page }) => {
    const gh = await connected(page);
    await openFromTree(page, "main.py");
    await shareFromMore(page);
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#share-repo")).toBeFocused();
    await expect(page.locator("#share-repo")).toBeChecked();
    await expect(page.locator("#share-repo-note")).toContainText("only for you and the collaborators of me/workspace");
    const url = `https://github.com/me/workspace/blob/${gh.fake.head()}/main.py`;
    await expect(link(page)).toHaveValue(url);
    await expect(link(page)).toHaveAttribute("readonly", "");
    const open = page.locator("#share-open");
    await expect(open).toHaveAttribute("href", url);
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(primary(page)).toHaveText("Copy link");
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-copy", "copied");
    await expect(result(page)).toHaveText("Copied the link.");
    expect(await copied(page)).toEqual([url]);
    // Nothing was created to make it.
    expect(gistPosts(gh)).toEqual([]);
    expect(gh.fake.writes().filter((w) => w.startsWith("POST"))).toEqual([]);
    await expectNoToken(page, gh);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("#file-actions")).toBeFocused();
  });

  test("encodes every path segment: a folder with a space, #, % and a non-ASCII name", async ({ page }) => {
    const name = `lab #2 100% ${String.fromCodePoint(0xe9)}t.py`;
    const path = `week 1/${name}`;
    const gh = await connected(page, { extra: { [path]: "x = 1\n" } });
    await showFiles(page);
    await treeItem(page, "week 1").locator(":scope > .tree-row").click();
    await expect(treeItem(page, path)).toBeVisible();
    await shareFromTree(page, path);
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    const url = `https://github.com/me/workspace/blob/${gh.fake.head()}/week%201/lab%20%232%20100%25%20%C3%A9t.py`;
    await expect(link(page)).toHaveValue(url);
    await expect(page.locator("#share-dialog-title")).toHaveText(`Share ${name}`);
  });

  test("a file with changes not on GitHub yet: Sync now first, then the link pins the new commit", async ({ page }) => {
    const gh = await connected(page);
    const before = gh.fake.head();
    await openFromTree(page, "main.py");
    await setCode(page, "print('changed')\n");
    await shareFromMore(page);
    await expect(dialog(page)).toHaveAttribute("data-state", "pending");
    await expect(page.locator("#share-pending")).toContainText("has changes that aren't on GitHub yet");
    await expect(link(page)).toHaveCount(0);
    // Sync now is the one filled control while it is the next step.
    await expect(page.locator("#share-sync")).toHaveClass(/\bprimary\b/);
    await expect(primary(page)).not.toHaveClass(/\bprimary\b/);
    // Copy link explains, and points at Sync now.
    await primary(page).click();
    await expect(result(page)).toHaveAttribute("data-tone", "error");
    await expect(page.locator("#share-sync")).toBeFocused();
    expect(await copied(page)).toEqual([]);
    const n = await syncCount(page);
    await page.locator("#share-sync").click();
    await waitSync(page, n, "synced");
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    expect(gh.fake.head()).not.toBe(before);
    expect(gh.fake.files()["main.py"]).toBe("print('changed')\n");
    await expect(link(page)).toHaveValue(`https://github.com/me/workspace/blob/${gh.fake.head()}/main.py`);
    await expect(result(page)).toContainText("Synced.");
    await expect(primary(page)).toBeFocused();
    await expect(primary(page)).toHaveClass(/\bprimary\b/);
  });

  test("a file never synced: Sync now adds it, then the link is ready", async ({ page }) => {
    const gh = await connected(page);
    await importFiles(page, [{ name: "new.py", text: "print('new')\n" }]);
    await dismissNotice(page);
    await shareFromTree(page, "new.py");
    await expect(dialog(page)).toHaveAttribute("data-state", "pending");
    await expect(page.locator("#share-pending")).toContainText("isn't on GitHub yet");
    const n = await syncCount(page);
    await page.locator("#share-sync").click();
    await waitSync(page, n, "synced");
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    expect(gh.fake.files()["new.py"]).toBe("print('new')\n");
    await expect(link(page)).toHaveValue(`https://github.com/me/workspace/blob/${gh.fake.head()}/new.py`);
  });

  test("a public repository says that anyone can open the link", async ({ page }) => {
    await connectedPublic(page);
    await shareFromTree(page, "main.py");
    await expect(dialog(page)).toHaveAttribute("data-public", "");
    await expect(page.locator("#share-repo-note")).toContainText("me/workspace is public, so anyone can open this link");
    await expect(dialog(page)).toHaveAttribute("data-checked", "");
    await expect(dialog(page)).toHaveAttribute("data-visibility", "public");
  });

  test.describe("when GitHub can't say whether the repository is private (security review, finding 1)", () => {
    test.use(syncNoise(...githubNoise(500)));
    const repoReadFails = (gh: GitHubRoute) => gh.fake.interceptors.push((req) => (req.method === "GET" && req.path === "" ? answer(500, "Server Error") : undefined));
    const note = (page: Page) => page.locator("#share-repo-note");

    test("a public repository still says anyone can open the link: the visibility stored when connecting", async ({ page }) => {
      const gh = await connectedPublic(page);
      repoReadFails(gh);
      await shareFromTree(page, "main.py");
      await expect(note(page)).toContainText("me/workspace is public, so anyone can open this link");
      await expect(dialog(page)).toHaveAttribute("data-public", "");
      // The live check really ran and failed, and the note didn't change to a promise of privacy.
      await expect(dialog(page)).toHaveAttribute("data-checked", "");
      await expect(dialog(page)).toHaveAttribute("data-visibility", "public");
      await expect(note(page)).not.toContainText("collaborators");
    });

    test("a connection saved before visibility was recorded promises nothing", async ({ page }) => {
      const gh = await connected(page);
      await tamper(page, { private: null });
      repoReadFails(gh);
      await shareFromTree(page, "main.py");
      await expect(dialog(page)).toHaveAttribute("data-checked", "");
      await expect(dialog(page)).toHaveAttribute("data-visibility", "unknown");
      await expect(note(page)).toHaveText("CodeEditor couldn't check whether me/workspace is private. If it is public, anyone can open this link. It shows the file as last synced.");
      await expect(dialog(page)).not.toHaveAttribute("data-public", "");
    });

    test("a repository stored as private keeps the collaborators note", async ({ page }) => {
      const gh = await connected(page);
      repoReadFails(gh);
      await shareFromTree(page, "main.py");
      await expect(dialog(page)).toHaveAttribute("data-checked", "");
      await expect(dialog(page)).toHaveAttribute("data-visibility", "private");
      await expect(note(page)).toContainText("only for you and the collaborators of me/workspace");
    });

    test("a live answer that differs from the stored one updates the note in place, and is remembered", async ({ page }) => {
      const gh = await connectedPublic(page);
      // Stored as private (it was made public on GitHub since): the live answer arrives later.
      await tamper(page, { private: true });
      let slow = true;
      gh.fake.interceptors.push(async (req) => {
        if (req.method === "GET" && req.path === "" && slow) await new Promise((r) => setTimeout(r, 1500));
        return undefined;
      });
      await shareFromTree(page, "main.py");
      await expect(dialog(page)).toHaveAttribute("data-visibility", "private");
      await expect(dialog(page)).not.toHaveAttribute("data-checked", "");
      await expect(dialog(page)).toHaveAttribute("data-checked", "", { timeout: 10_000 });
      await expect(dialog(page)).toHaveAttribute("data-visibility", "public");
      await expect(dialog(page)).toHaveAttribute("data-public", "");
      await expect(note(page)).toContainText("me/workspace is public, so anyone can open this link");
      await expect(note(page).locator(".share-who")).toHaveClass(/\bshare-warn\b/);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      // Next opening, GitHub can't answer: the remembered answer is public.
      slow = false;
      repoReadFails(gh);
      await shareFromTree(page, "main.py");
      await expect(dialog(page)).toHaveAttribute("data-checked", "");
      await expect(dialog(page)).toHaveAttribute("data-visibility", "public");
    });
  });

  test("when the browser refuses the clipboard, the link is selected in its field for Ctrl+C", async ({ page }) => {
    await connected(page);
    await page.evaluate(() => void ((window as unknown as { __refuseCopy: boolean }).__refuseCopy = true));
    await shareFromTree(page, "main.py");
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-copy", "refused");
    await expect(result(page)).toHaveAttribute("data-tone", "warning");
    await expect(link(page)).toBeFocused();
    const sel = await link(page).evaluate((el) => {
      const input = el as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length };
    });
    expect(sel.start).toBe(0);
    expect(sel.end).toBe(sel.length);
  });

  test("a read-only second tab doesn't share: it says so, as it does for its other sync actions", async ({ page, context }) => {
    await connected(page);
    const second = await context.newPage();
    await openApp(second);
    await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
    await shareFromTreeNoDialog(second, "main.py");
    await expect(second.locator(".notice")).toContainText("This tab is read-only, so it doesn't share from GitHub");
    await expect(second.locator("#share-dialog")).toHaveCount(0);
  });

  test("the command palette opens it for the open file", async ({ page }) => {
    await connected(page);
    await openFromTree(page, "main.py");
    await page.keyboard.press("F1");
    await expect(page.locator("#palette-input")).toBeFocused();
    await page.keyboard.insertText("share");
    await page.getByRole("option", { name: /Share a link to the open file/ }).click();
    await choose(page, "repo");
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#share-dialog-title")).toHaveText("Share main.py");
  });
});

async function shareFromTreeNoDialog(page: Page, path: string) {
  await showFiles(page);
  await treeItem(page, path).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
}

test.describe("the public link (a secret gist)", () => {
  test("says it isn't private before anything exists, sends nothing until Create link, then one secret gist", async ({ page }) => {
    const marker = "CONTENT_MARKER_7f3a";
    const text = `print("${marker}")\n`;
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    const gh = await connected(page, { main: text });
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await expect(dialog(page)).toHaveAttribute("data-state", "gist");
    await expect(page.locator("#share-gist-note")).toContainText("Secret gists aren't private: anyone with the link can open it, without signing in.");
    await expect(page.locator("#share-gist-note")).toContainText("only when you press Create link");
    await expect(primary(page)).toHaveText("Create link");
    // Choosing it, moving around and waiting sends nothing.
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);
    expect(gistPosts(gh)).toEqual([]);
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    expect(gistPosts(gh)).toHaveLength(1);
    expect(gh.fake.gists).toHaveLength(1);
    const g = gh.fake.gists[0];
    expect(g.public).toBe(false);
    expect(g.description).toBe("main.py, shared from CodeEditor");
    expect(g.files).toEqual({ "main.py": { content: text } });
    const url = `https://gist.github.com/me/${g.id}`;
    await expect(link(page)).toHaveValue(url);
    const open = page.locator("#share-open");
    await expect(open).toHaveAttribute("href", url);
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(page.locator("#share-link-note")).toContainText("To remove it, open the gist on GitHub and delete it there.");
    await expect(primary(page)).toHaveText("Copy link");
    await expect(primary(page)).toBeFocused();
    await expect(page.locator("#share-cancel")).toHaveText("Close");
    await primary(page).click();
    expect(await copied(page)).toEqual([url]);
    // Still one gist; switching back and forth doesn't make another.
    await page.locator("#share-repo").check();
    await page.locator("#share-gist").check();
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    expect(gistPosts(gh)).toHaveLength(1);
    // The file's content went only in the request body: never in any URL the page asked for.
    expect(urls.filter((u) => u.includes(marker) || u.includes("CONTENT_MARKER"))).toEqual([]);
    expect(gistPosts(gh)[0].headers["x-github-api-version"]).toBe("2026-03-10");
    await expectNoToken(page, gh);
  });

  test("a double press, or a press while it is being made, makes one gist", async ({ page }) => {
    const gh = await connected(page);
    gh.fake.interceptors.push(async (req) => {
      if (req.path === "/gists") await new Promise((r) => setTimeout(r, 800));
      return undefined;
    });
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await primary(page).dblclick();
    await expect(dialog(page)).toHaveAttribute("data-state", "creating");
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    // A second request would wait in the client's write queue (1 s apart, plus the 800 ms answer):
    // give it time to show before counting.
    await page.waitForTimeout(2500);
    expect(gistPosts(gh)).toHaveLength(1);
    expect(gh.fake.gists).toHaveLength(1);
  });

  test("two presses in the same moment make one gist", async ({ page }) => {
    const gh = await connected(page);
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await primary(page).focus();
    // Two presses in one task: the second arrives before the first has read the file.
    await primary(page).evaluate((b) => {
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    await page.waitForTimeout(2500);
    expect(gistPosts(gh)).toHaveLength(1);
  });

  test.describe("a token without gist permission", () => {
    for (const status of [403, 404] as const) {
      test.describe(`${status}`, () => {
        test.use(syncNoise(...gistNoise(status)));
        test(`(${status}) says what's missing, in a plain sentence`, async ({ page }) => {
          const gh = await connected(page, { fake: { gistsRefused: status } });
          await shareFromTree(page, "main.py");
          await page.locator("#share-gist").check();
          await primary(page).click();
          await expect(result(page)).toHaveAttribute("data-tone", "error");
          await expect(result(page)).toContainText('a fine-grained token needs the account permission "Gists" set to "Read and write", and a classic token the "gist" scope');
          await expect(dialog(page)).toHaveAttribute("data-state", "gist");
          expect(gh.fake.gists).toEqual([]);
          // Sync is untouched: a refused permission is not a refused token.
          await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "synced");
        });
      });
    }
  });

  test.describe("a GitHub App sign-in without Gists", () => {
    test.use(syncNoise(...gistNoise(403)));
    test("says the app needs the Gists permission and the student signs in again", async ({ page }) => {
      const gh = await routeGitHub(page, { token: GHU1, gistsRefused: 403 });
      await gh.fake.remoteCommit({ "main.py": MAIN });
      const si = await routeSignIn(page);
      await recordClipboard(page);
      await openApp(page);
      await importFiles(page, [{ name: "main.py", text: MAIN }]);
      const n = await syncCount(page);
      await signInAndPick(page, si);
      await page.locator("#connect-submit").click();
      await expect(page.locator("#connect-dialog")).toHaveCount(0, { timeout: 30_000 });
      await waitSync(page, n, "synced");
      await dismissNotice(page);
      await shareFromTree(page, "main.py");
      await page.locator("#share-gist").check();
      await primary(page).click();
      await expect(result(page)).toContainText('the site\'s owner has to give CodeEditor\'s GitHub App the account permission "Gists: Read and write", and then you sign in again to approve it');
      const posts = gistPosts(gh);
      expect(posts).toHaveLength(1);
      expect(posts[0].headers.authorization).toBe(`Bearer ${GHU1}`);
      expect(gh.fake.gists).toEqual([]);
    });
  });

  test.describe("a rate limit", () => {
    test.use(syncNoise(...gistNoise(403)));
    test("says when to try again", async ({ page }) => {
      const gh = await connected(page);
      gh.fake.interceptors.push((req) =>
        req.path === "/gists" ? answer(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }) : undefined,
      );
      await shareFromTree(page, "main.py");
      await page.locator("#share-gist").check();
      await primary(page).click();
      await expect(result(page)).toContainText("GitHub is limiting requests from this token for now, so try again in");
    });
  });

  test.describe("a server error", () => {
    test.use(syncNoise(...gistNoise(502)));
    test("says so, and where to look in case GitHub made it; the next press tries again", async ({ page }) => {
      const gh = await connected(page);
      let fail = true;
      gh.fake.interceptors.push((req) => (req.path === "/gists" && fail ? answer(502, "Server Error") : undefined));
      await shareFromTree(page, "main.py");
      await page.locator("#share-gist").check();
      await primary(page).click();
      await expect(result(page)).toContainText("GitHub had a problem answering");
      await expect(result(page)).toContainText("Your gists");
      fail = false;
      await primary(page).click();
      await expect(dialog(page)).toHaveAttribute("data-state", "created");
      expect(gh.fake.gists).toHaveLength(1);
    });
  });

  test("offline: says so and sends nothing", async ({ page, context }) => {
    const gh = await connected(page);
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await context.setOffline(true);
    await primary(page).click();
    await expect(result(page)).toContainText("This device is offline, so the gist can't be made now.");
    expect(gistPosts(gh)).toEqual([]);
    await context.setOffline(false);
  });

  test("a binary file, an empty file and one over 512 KB are refused before anything is sent", async ({ page }) => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const gh = await connected(page, { extra: { "logo.png": png, "empty.py": "", "big.py": "x".repeat(512 * 1024 + 1) } });
    for (const [path, words] of [
      ["logo.png", "isn't a text file CodeEditor can edit, so it can't go in a gist"],
      ["empty.py", "is empty, and GitHub doesn't keep empty files in a gist"],
      ["big.py", "big.py is 513 KB; a gist from CodeEditor holds at most 512 KB"],
    ] as const) {
      await shareFromTree(page, path);
      // The repository link works for every one of them.
      await expect(dialog(page)).toHaveAttribute("data-state", "ready");
      await page.locator("#share-gist").check();
      await primary(page).click();
      await expect(result(page)).toContainText(words);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    }
    expect(gistPosts(gh)).toEqual([]);
  });

  test("an answer whose address isn't a gist.github.com page is never shown as a link", async ({ page }) => {
    const gh = await connected(page);
    gh.fake.interceptors.push((req) =>
      req.path === "/gists"
        ? new Response(JSON.stringify({ id: "abc", html_url: "javascript:alert(document.domain)" }), { status: 201, headers: { "content-type": "application/json" } })
        : undefined,
    );
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    await expect(page.locator("#share-open")).toHaveCount(0);
    await expect(link(page)).toHaveCount(0);
    await expect(dialog(page).locator("a[href^='javascript']")).toHaveCount(0);
    await expect(page.locator("#share-panel")).toContainText("Find it under Your gists on GitHub");
  });
});

/** Changes the stored workspace behind the app's back (a damaged or hostile record, a file gone). */
async function tamper(page: Page, change: { baseCommit?: string; owner?: string; removePath?: string; private?: boolean | null }) {
  await page.evaluate(async (c) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => ((t.oncomplete = () => resolve()), (t.onerror = () => reject(t.error))));
    const t = db.transaction(["workspaces", "entries", "contents"], "readwrite");
    const all: { id: string; remote: Record<string, unknown> | null }[] = await new Promise((resolve) => {
      const r = t.objectStore("workspaces").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    for (const ws of all) {
      if (!ws.remote) continue;
      if (c.baseCommit !== undefined) ws.remote.baseCommit = c.baseCommit;
      if (c.owner !== undefined) ws.remote.owner = c.owner;
      // null: a connection stored before the repository's visibility was recorded.
      if (c.private === null) delete ws.remote.private;
      else if (c.private !== undefined) ws.remote.private = c.private;
      t.objectStore("workspaces").put(ws);
      if (c.removePath) {
        t.objectStore("entries").delete([ws.id, c.removePath]);
        t.objectStore("contents").delete([ws.id, c.removePath]);
      }
    }
    await done(t);
    db.close();
  }, change);
}

test.describe("attacker pass", () => {
  test("a stored connection that can't make a safe address gives no repository link at all", async ({ page }) => {
    await connected(page);
    await tamper(page, { baseCommit: "../../../evil.example/x" });
    await shareFromTree(page, "main.py");
    await expect(dialog(page)).toHaveAttribute("data-state", "invalid");
    await expect(link(page)).toHaveCount(0);
    await expect(page.locator("#share-open")).toHaveCount(0);
    await primary(page).click();
    await expect(result(page)).toContainText("couldn't make a safe GitHub address");
    expect(await copied(page)).toEqual([]);
  });

  test("closing the dialog while the gist is being made still tells where it is", async ({ page }) => {
    const gh = await connected(page);
    gh.fake.interceptors.push(async (req) => {
      if (req.path === "/gists") await new Promise((r) => setTimeout(r, 800));
      return undefined;
    });
    await shareFromTree(page, "main.py");
    await page.locator("#share-gist").check();
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "creating");
    // The request has gone out (it waits up to 1 s behind the sync's last write first): closing
    // now can't take it back. Closing before it goes out sends nothing (the finding 2 tests).
    await expect.poll(() => gistPosts(gh).length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(".notice")).toContainText("Made a secret gist of main.py after the dialog closed", { timeout: 10_000 });
    await expect(page.locator(".notice")).toContainText("anyone with its link can open it");
    await expect(page.locator(".notice").getByRole("button", { name: "Open the gist" })).toBeVisible();
    expect(gh.fake.gists).toHaveLength(1);
  });

  for (const how of ["Cancel", "Escape"] as const) {
    test(`${how} before the gist is sent sends nothing, even while it waits behind a sync (security review, finding 2)`, async ({ page }) => {
      const gh = await connected(page, { extra: { "b.py": "b\n" } });
      gh.fake.interceptors.push(async (req) => {
        if (req.method === "POST" && req.path === "/git/trees") await new Promise((r) => setTimeout(r, 4000));
        return undefined;
      });
      const treePosts = () => gh.seen.filter((r) => r.method === "POST" && r.url.endsWith("/git/trees")).length;
      await openFromTree(page, "b.py");
      await setCode(page, "b2\n");
      const n = await syncCount(page);
      await saveKey(page);
      // The sync is now writing: its slow POST /git/trees holds the client's write queue.
      await expect.poll(treePosts, { timeout: 10_000 }).toBe(1);
      await shareFromTree(page, "main.py");
      await page.locator("#share-gist").check();
      await primary(page).click();
      if (how === "Cancel") await page.locator("#share-cancel").click();
      else await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await waitSync(page, n, "synced");
      // Past the queue's 1 s gap after the sync's last write: a queued gist would have gone by now.
      await page.waitForTimeout(2500);
      expect(gistPosts(gh)).toEqual([]);
      expect(gh.fake.gists).toEqual([]);
      await expect(page.locator(".notice", { hasText: "gist" })).toHaveCount(0);
      expect(gh.fake.files()["b.py"]).toBe("b2\n");
    });
  }

  test("a tab that became read-only while the dialog is open neither syncs nor makes a gist", async ({ page, context }) => {
    const gh = await connected(page);
    await openFromTree(page, "main.py");
    await setCode(page, "print('changed')\n");
    await shareFromTree(page, "main.py");
    await expect(dialog(page)).toHaveAttribute("data-state", "pending");
    // Another tab takes over editing.
    const second = await context.newPage();
    await openApp(second);
    await second.locator("#read-only-banner").getByRole("button", { name: "Edit here" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-role", "reader", { timeout: 10_000 });
    const writes = gh.fake.writes().length;
    await page.locator("#share-sync").click();
    await expect(result(page)).toContainText("This tab became read-only");
    await page.locator("#share-gist").check();
    await primary(page).click();
    await expect(result(page)).toContainText("This tab became read-only");
    expect(gistPosts(gh)).toEqual([]);
    expect(gh.fake.writes().length).toBe(writes);
  });

  test("a file deleted while the dialog is open: no gist, and a plain sentence", async ({ page }) => {
    const gh = await connected(page);
    await shareFromTree(page, "main.py");
    await tamper(page, { removePath: "main.py" });
    await page.locator("#share-gist").check();
    await primary(page).click();
    await expect(result(page)).toContainText("main.py isn't in this workspace any more, so no gist was made.");
    expect(gistPosts(gh)).toEqual([]);
  });

  test("markup in a file name and its content stays text, and nothing leaks to the console, storage or any URL", async ({ page }) => {
    const name = "&lt;img src=x onerror=alert(1)&gt;'.py";
    const content = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\n';
    const consoleText: string[] = [];
    page.on("console", (m) => consoleText.push(m.text()));
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    const gh = await connected(page, { extra: { [name]: content } });
    await shareFromTree(page, name);
    await expect(page.locator("#share-dialog-title")).toHaveText(`Share ${name}`);
    await page.locator("#share-gist").check();
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-state", "created");
    expect(gh.fake.gists[0].files).toEqual({ [name]: { content } });
    expect(await dialog(page).locator("img, script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? null)).toBeNull();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    for (const secret of [gh.token, "window.__xss"]) {
      expect(stored, "storage").not.toContain(secret);
      expect(consoleText.filter((t) => t.includes(secret)), "console").toEqual([]);
      expect(urls.filter((u) => u.includes(secret) || decodeURIComponent(u).includes(secret)), "URLs").toEqual([]);
    }
    expect(await page.locator("body").innerText()).not.toContain("window.__xss");
    await expectNoToken(page, gh);
  });
});

test.describe("the real clipboard", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright grants clipboard permissions in Chromium only");
  test("Copy link puts the link on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": MAIN });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: MAIN }]);
    const n = await syncCount(page);
    await connectGitHub(page);
    await waitSync(page, n, "synced");
    await dismissNotice(page);
    await shareFromTree(page, "main.py");
    await primary(page).click();
    await expect(dialog(page)).toHaveAttribute("data-copy", "copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://github.com/me/workspace/blob/${gh.fake.head()}/main.py`);
  });
});
