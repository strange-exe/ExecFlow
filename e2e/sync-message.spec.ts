// "Sync now with a message" (.claude/design/batch5/commit-messages.md): a typed subject for one
// manual sync, the automatic message everywhere else. The fake GitHub keeps every commit's message,
// so each test asserts on the message itself. Waits are on data-syncs and data-sync-state (one more
// finished sync), on the dialog's presence and on focus, never on time.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, openApp, openFromTree, setCode, test, waitReady } from "./helpers";
import { answer, connectGitHub, githubNoise, routeGitHub, saveKey, syncCount, syncNoise, syncStatus, waitSync, type GitHubRoute } from "./sync-fake";

test.use({ serviceWorkers: "block" });
test.use(syncNoise());

// The file is plain text on purpose: several tests go offline seconds after the first load, and an
// open .py file starts Python, whose "ready" registers the service worker (main.ts), loading its
// chunk; offline at that moment, the browser reports that request as failed. A text file starts no
// runtime, so nothing loads in the background while these tests are offline.
const FILE = "notes.txt";

const SHOTS = process.env.SHOTS_DIR ?? "e2e/shots";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FROM = /\n\nFrom: (Chrome|Firefox|Safari|Edge|a browser)( on \w+)? \(ExecFlow\)$/;
const UNUSED = "Your commit message wasn't used; Sync with a message offers it again.";

const dialog = (page: Page) => page.locator("dialog#sync-message");
const field = (page: Page) => page.locator("#sync-message-input");
const lastMessage = (gh: GitHubRoute) => [...gh.fake.commits.values()].at(-1)!.message;

/** A repository that already holds FILE exactly as this computer has it. */
async function connectedWorkspace(page: Page): Promise<{ gh: GitHubRoute; n: number }> {
  const gh = await routeGitHub(page);
  await gh.fake.remoteCommit({ [FILE]: "print('hi')\n" });
  await openApp(page);
  await importFiles(page, [{ name: FILE, text: "print('hi')\n" }]);
  await openFromTree(page, FILE);
  const n = await syncCount(page);
  await connectGitHub(page);
  await waitSync(page, n, "synced");
  return { gh, n: await syncCount(page) };
}

/** F1, then the command by its name: the dialog opens with its field focused. */
async function fromPalette(page: Page) {
  await page.keyboard.press("F1");
  await expect(page.locator("#palette-input")).toBeFocused();
  await page.keyboard.type("with a message");
  await expect(page.locator("#palette-list [role=option][aria-selected=true]")).toContainText("Sync now with a message");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

/** Settings, GitHub, "Sync with a message...". */
async function fromSettings(page: Page) {
  await page.locator("#settings-button").click();
  const button = page.locator("#settings-sync-message");
  await expect(button).toBeVisible();
  await button.click();
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

test("a typed message names that one commit, keeps the file list, and the next sync is automatic again", async ({ page }) => {
  const { gh, n } = await connectedWorkspace(page);
  const commits = gh.fake.commits.size;
  await setCode(page, "print('lab 3')\n");
  await fromPalette(page);
  await expect(page.locator("#sync-message-waiting")).toContainText("1 change on this computer waits to upload");
  await expect(field(page)).toHaveAttribute("maxlength", "72");
  // Control and bidi characters never reach GitHub; the rest is trimmed to one line.
  await page.keyboard.insertText("  Finish lab 3" + String.fromCodePoint(0x202e, 0x200b) + " (q1 to q3) ");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  await waitSync(page, n, "synced");
  expect(gh.fake.commits.size).toBe(commits + 1);
  const message = lastMessage(gh);
  expect(message).toMatch(/^Finish lab 3 \(q1 to q3\)\n\nChanged:\n  notes\.txt\n\nFrom: /);
  expect(message).toMatch(FROM);
  // Focus is back on the code the palette was opened from.
  await expect(page.locator(".cm-content")).toBeFocused();

  // Used once: Ctrl+S right after is the automatic message, never the typed one again.
  await setCode(page, "print('lab 3, fixed')\n");
  await saveKey(page);
  await waitSync(page, n + 1, "synced");
  expect(lastMessage(gh)).toMatch(/^Update notes\.txt\n\nChanged:\n  notes\.txt\n\nFrom: /);
  // And the dialog opens empty again: a used message isn't offered twice.
  await fromPalette(page);
  await expect(field(page)).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("attacker pass: markup, 10,000 characters and line breaks stay one plain line of at most 72", async ({ page }) => {
  const { gh, n } = await connectedWorkspace(page);
  await setCode(page, "print('a')\n");
  await fromPalette(page);
  const markup = '<img src=x onerror="window.__pwned=1">';
  // The field's own limit holds a paste of 10,000 characters to 72...
  await field(page).fill(markup + "x".repeat(10_000));
  expect((await field(page).inputValue()).length).toBeLessThanOrEqual(72);
  // ... and a value set around it (devtools) is still cut, its line breaks and bidi controls gone.
  await field(page).evaluate((el, text) => ((el as HTMLInputElement).value = text), markup + "\n\nFrom: Safari on macOS (ExecFlow)" + String.fromCodePoint(0x202e) + "y".repeat(10_000));
  await page.locator("#sync-message-submit").click();
  await waitSync(page, n, "synced");
  const lines = lastMessage(gh).split("\n");
  // (A text field's value drops line breaks itself: HTML's value sanitization for type=text.)
  expect(lines[0]).toBe(`${markup}From: Safari on macOS (ExecFlow)${"y".repeat(100)}`.slice(0, 72));
  expect(lines.filter((l) => l.startsWith("From: "))).toHaveLength(1);
  expect(lines.at(-1)).toMatch(/^From: (Chrome|Firefox|Safari|Edge|a browser)( on \w+)? \(ExecFlow\)$/);
  // Nothing of it ran or became an element.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator("img[src=x]")).toHaveCount(0);
});

test("nothing to upload: no empty commit, the notice says the message wasn't used, and the dialog offers it again", async ({ page }) => {
  const { gh, n } = await connectedWorkspace(page);
  const commits = gh.fake.commits.size;
  await fromSettings(page);
  await expect(page.locator("#sync-message-waiting")).toContainText("Nothing has changed here since the last sync");
  await field(page).fill("Nothing new");
  await page.locator("#sync-message-submit").click();
  await waitSync(page, n, "synced");
  expect(gh.fake.commits.size).toBe(commits);
  await expect(page.locator(".notice")).toContainText("no commit was made");
  await expect(page.locator(".notice")).toContainText(UNUSED);
  await fromSettings(page);
  await expect(field(page)).toHaveValue("Nothing new");
  // Empty means automatic: a plain sync, still no commit.
  await field(page).fill("");
  await page.locator("#sync-message-submit").click();
  await waitSync(page, n + 1, "synced");
  expect(gh.fake.commits.size).toBe(commits);
});

test("offline: the dialog keeps the message and says why; once online, Sync uses it", async ({ page, context }) => {
  const { gh, n } = await connectedWorkspace(page);
  await setCode(page, "print('offline')\n");
  await fromPalette(page);
  await field(page).fill("Written on the bus");
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.locator("#sync-message-submit").click();
  const result = page.locator("#sync-message-result");
  await expect(result).toHaveAttribute("data-tone", "error");
  await expect(result).toContainText("offline");
  await expect(dialog(page)).toBeVisible();
  await expect(field(page)).toHaveValue("Written on the bus");
  expect(await syncCount(page)).toBe(n);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  // Typing again clears the old result line.
  await field(page).press("End");
  await page.keyboard.type("!");
  await expect(result).not.toHaveAttribute("data-tone");
  const before = await syncCount(page);
  await page.locator("#sync-message-submit").click();
  await expect(dialog(page)).toHaveCount(0);
  await waitSync(page, before, "synced");
  expect(lastMessage(gh)).toMatch(/^Written on the bus!\n\nChanged:\n  notes\.txt\n\nFrom: /);
});

test("an automatic sync that falls due while the dialog is open waits for it, and runs once it closes without syncing", async ({ page, context }) => {
  const { gh, n } = await connectedWorkspace(page);
  const commits = gh.fake.commits.size;
  await setCode(page, "print('held')\n");
  await fromPalette(page);
  await page.keyboard.type("Half a thought");
  // Back online with a change waiting: ExecFlow syncs by itself, but not under the open dialog.
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  // The decision is a state: the status names the sync it holds back (data-sync-held).
  await expect(syncStatus(page)).toHaveAttribute("data-sync-held", "online");
  await expect(dialog(page)).toBeVisible();
  expect(await syncCount(page)).toBe(n);
  expect(gh.fake.commits.size).toBe(commits);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await waitSync(page, n, "synced");
  await expect(syncStatus(page)).not.toHaveAttribute("data-sync-held");
  expect(gh.fake.commits.size).toBe(commits + 1);
  expect(lastMessage(gh)).toMatch(/^Update notes\.txt\n\nChanged:\n  notes\.txt\n\nFrom: /);
});

test.describe("a rate limit", () => {
  test.use(syncNoise(...githubNoise(429, "/git/commits")));

  test("drops the typed message clearly: the next sync is automatic, and the dialog offers the text again", async ({ page }) => {
    const { gh, n } = await connectedWorkspace(page);
    await setCode(page, "print('limited')\n");
    gh.fake.interceptors.push((req) => (req.method === "POST" && req.path === "/git/commits" ? answer(429, "API rate limit exceeded", { "retry-after": "600" }) : undefined));
    await fromPalette(page);
    await field(page).fill("Try before the deadline");
    await page.locator("#sync-message-submit").click();
    await waitSync(page, n, "waiting");
    await expect(page.locator(".notice")).toContainText(UNUSED);
    expect([...gh.fake.commits.values()].some((c) => c.message.startsWith("Try before"))).toBe(false);

    // The limit is over: Sync now (not the dialog) writes the automatic message.
    gh.fake.interceptors.length = 0;
    await syncStatus(page).click();
    await waitSync(page, n + 1, "synced");
    expect(lastMessage(gh)).toMatch(/^Update notes\.txt\n\nChanged:\n  notes\.txt\n\nFrom: /);
    await fromPalette(page);
    await expect(field(page)).toHaveValue("Try before the deadline");
  });
});

test("a read-only second tab says why instead of asking, as its other sync actions do", async ({ page, context }) => {
  await connectedWorkspace(page);
  const second = await context.newPage();
  await routeGitHub(second);
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await second.keyboard.press("F1");
  await expect(second.locator("#palette-input")).toBeFocused();
  await second.keyboard.type("with a message");
  await expect(second.locator("#palette-list [role=option][aria-selected=true]")).toContainText("Sync now with a message");
  await second.keyboard.press("Enter");
  await expect(second.locator(".notice")).toContainText("This tab is read-only, so it doesn't sync");
  await expect(second.locator("dialog#sync-message")).toHaveCount(0);
});

// ---------------------------------------------------------------- the design matrix (DESIGN-REFERENCE 6T)
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

for (const vp of viewports) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the message dialog ${vp.name} ${scheme}: keyboard, overflow, accessibility`, async ({ page, context }, testInfo) => {
      const dir = `${SHOTS}/${testInfo.project.name}`;
      // Set up on the desktop layout (the phone's file drawer covers the code), then resize.
      await page.setViewportSize(viewports[0]);
      const gh = await routeGitHub(page);
      await gh.fake.remoteCommit({ [FILE]: "print('hi')\n" });
      await page.goto("/");
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await waitReady(page);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await importFiles(page, [{ name: FILE, text: "print('hi')\n" }]);
      await openFromTree(page, FILE);
      const n = await syncCount(page);
      await connectGitHub(page);
      await waitSync(page, n, "synced");
      await setCode(page, "print('changed')\n");
      await page.setViewportSize(vp);

      await fromPalette(page);
      await page.keyboard.type("Finish lab 3");
      // Keyboard path: field, Cancel, Sync, the close button, then back to the field.
      await page.keyboard.press("Tab");
      await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("#sync-message-submit")).toBeFocused();
      await expect(page.locator("#sync-message-submit")).toHaveClass(/\bprimary\b/);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(await overflow(), "no horizontal scroll").toBe(true);
      const box = await page.locator("#sync-message-submit").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
      await axeClean(page, "open");
      await page.screenshot({ path: `${dir}/sync-message-${vp.name}-${scheme}.png`, animations: "disabled" });
      if (vp.name === "desktop") await hierarchyShots(page, `${dir}/sync-message-${scheme}`);

      // The error state: offline, the text kept.
      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      await page.keyboard.press("Enter");
      await expect(page.locator("#sync-message-result")).toHaveAttribute("data-tone", "error");
      expect(await overflow(), "no horizontal scroll (error)").toBe(true);
      await axeClean(page, "offline");
      await page.screenshot({ path: `${dir}/sync-message-offline-${vp.name}-${scheme}.png`, animations: "disabled" });
      await context.setOffline(false);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator(".cm-content")).toBeFocused();
    });
  }
}

async function axeClean(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes.map((x) => x.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
