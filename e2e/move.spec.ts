// The move to the new address (src/ui/address-move.ts, src/core/move-protocol.ts), across two real
// origins: the build under test treats http://localhost:<port> as the OLD address and the suite's
// own http://127.0.0.1:<port> as the NEW one (playwright.config.ts MOVE_FROM / MOVE_TO). The
// files go from one origin's storage to the other's in the browser, as a zip Blob in a
// postMessage; each side takes messages only from the other's exact origin AND window.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { writeZip } from "../src/storage/zip";
import type { WsPath } from "../src/core/types";
import { expect, openApp, test, tolerating, treeItem, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });

const NOTICE = '.notice[data-pinned="address-move"]';
let OLD = "";
let NEW = "";
test.beforeEach(({ baseURL }) => {
  NEW = new URL(baseURL!).origin;
  OLD = `http://localhost:${new URL(baseURL!).port}`;
});

/** A real zip (the app's own writer), as numbers a page can turn back into a Blob. */
async function zipOf(files: Record<string, string>): Promise<number[]> {
  const bytes = await writeZip(Object.entries(files).map(([path, text]) => ({ path: path as WsPath, bytes: new TextEncoder().encode(text) })), []);
  return [...bytes];
}

/** Three files, two of them in nested folders, picked as one folder through "Import a folder". */
async function seedOldAddress(page: Page, dir: string) {
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import a folder" }).click();
  await (await chooser).setFiles(join(dir, "proj"));
  await expect(page.locator(".notice")).toContainText("Imported 3 files.");
  await expectFiles(page);
  // The import's notice covers the move notice; dismissing it brings the move notice back.
  await page.locator(".notice").getByRole("button", { name: "Dismiss notice" }).click();
  await expect(page.locator(NOTICE)).toBeVisible();
}

/** Every file of FILES is in the tree (closed folders are opened first). */
async function expectFiles(page: Page) {
  const closed = page.locator('.tree [role=treeitem][aria-expanded="false"]');
  await expect(treeItem(page, "proj")).toHaveCount(1);
  while ((await closed.count()) > 0) await closed.first().click();
  for (const path of Object.keys(FILES)) await expect(treeItem(page, path)).toHaveCount(1);
}
const FILES = { "proj/main2.py": 'print("moved")\n', "proj/lib/util.py": "def f():\n    return 1\n", "proj/lib/data/notes.txt": "three\n" };

/** Opens the new address's /move from `opener` (a page at the old address), as the button would. */
async function openReceiver(opener: Page): Promise<Page> {
  const [popup] = await Promise.all([opener.context().waitForEvent("page"), opener.evaluate((url) => void ((window as unknown as { __w: Window | null }).__w = window.open(url, "_blank")), `${NEW}/move#move-from`)]);
  await waitReady(popup);
  await expect(popup.locator("#app")).toHaveAttribute("data-move", "waiting");
  return popup;
}

test.describe("the move notice", () => {
  test("shows only at the old address, links to the new one, and stays dismissed for the session", async ({ page, context }) => {
    await openApp(page, `${NEW}/`);
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
    await expect(page.locator(NOTICE)).toHaveCount(0);
    await expect(page.getByText("has a new address")).toHaveCount(0);

    await openApp(page, `${OLD}/`);
    const notice = page.locator(NOTICE);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`ExecFlow has a new address: ${new URL(NEW).host}. Move your files there.`);
    await expect(notice.getByRole("button", { name: "Move my files" })).toBeVisible();
    await expect(notice.getByRole("link", { name: `Open ${new URL(NEW).host}` })).toHaveAttribute("href", `${NEW}/`);
    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(page.locator(NOTICE)).toHaveCount(0);
    await page.reload();
    await waitReady(page);
    await expect(page.getByText("has a new address")).toHaveCount(0);
    // A new session (another context) sees it again.
    const fresh = await context.browser()!.newContext({ serviceWorkers: "block" });
    const other = await fresh.newPage();
    await openApp(other, `${OLD}/`);
    await expect(other.locator(NOTICE)).toBeVisible();
    await fresh.close();
  });

  test("/move is the editor without cross-origin isolation; / keeps it", async ({ request }) => {
    const root = await request.get(`${NEW}/`);
    expect(root.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(root.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
    const move = await request.get(`${NEW}/move`);
    expect(move.status()).toBe(200);
    expect(move.headers()["cross-origin-opener-policy"]).toBeUndefined();
    expect(move.headers()["cross-origin-embedder-policy"]).toBeUndefined();
    expect(move.headers()["content-security-policy"]).toBe(root.headers()["content-security-policy"]);
    expect(await move.text()).toContain('<meta name="robots" content="noindex" />');
  });

  test("#move-from without an opener does nothing at the new address", async ({ page }) => {
    await openApp(page, `${NEW}/move#move-from`);
    await expect(page.locator("#app")).not.toHaveAttribute("data-move", /./);
    expect(new URL(page.url()).hash).toBe("#move-from");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
});

test.describe("moving files", () => {
  test("three files, in nested folders, go from the old address to the new one after a yes", async ({ page, context }, testInfo) => {
    await openApp(page, `${OLD}/`);
    await seedOldAddress(page, testInfo.outputPath("seed"));
    // At / (cross-origin isolated) the button first brings the student to /move.
    await page.locator(NOTICE).getByRole("button", { name: "Move my files" }).click();
    await page.waitForURL(`${OLD}/move`);
    await waitReady(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await expect(page.locator(NOTICE)).toContainText("Press Move my files");
    const [popup] = await Promise.all([context.waitForEvent("page"), page.locator(NOTICE).getByRole("button", { name: "Move my files" }).click()]);
    await waitReady(popup);
    expect(new URL(popup.url()).origin).toBe(NEW);
    const dialog = popup.getByRole("alertdialog", { name: "Add 3 files from your old ExecFlow?" });
    await expect(dialog).toBeVisible();
    // The marker left the new tab's address bar.
    expect(new URL(popup.url()).hash).toBe("");
    await dialog.getByRole("button", { name: "Add files" }).click();
    await expect(popup.locator("#app")).toHaveAttribute("data-move", "done");
    // The move is over: the new tab lets go of the old one (no reverse tabnabbing later).
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await expect(popup.locator(".notice")).toContainText(`Added 3 files from ${new URL(OLD).host}.`);
    await expectFiles(popup);
    await expect(page.locator("#app")).toHaveAttribute("data-move", "done");
    await expect(page.locator(".notice")).toContainText(`Your files are at ${new URL(NEW).host} now: 3 files added. They stay here too.`);
    // They are really stored at the new address: a fresh load there still has them.
    await popup.goto(`${NEW}/`);
    await waitReady(popup);
    await expectFiles(popup);
    // And still at the old one.
    await expectFiles(page);
  });

  test("a No in the dialog adds nothing, and the old address says so", async ({ page, context }, testInfo) => {
    await openApp(page, `${OLD}/move`);
    await seedOldAddress(page, testInfo.outputPath("seed"));
    const [popup] = await Promise.all([context.waitForEvent("page"), page.locator(NOTICE).getByRole("button", { name: "Move my files" }).click()]);
    await waitReady(popup);
    await popup.getByRole("alertdialog").getByRole("button", { name: "Not now" }).click();
    await expect(popup.locator("#app")).toHaveAttribute("data-move", "refused-declined");
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await expect(popup.locator(".tree [role=treeitem]")).toHaveCount(0);
    await expect(page.locator("#app")).toHaveAttribute("data-move", "refused-declined");
    await expect(page.locator(".notice")).toContainText("Nothing was moved");
  });

  test("a blocked popup falls back to the .zip download", async ({ page, context }, testInfo) => {
    await context.addInitScript(() => {
      window.open = () => null;
    });
    await openApp(page, `${OLD}/move`);
    await seedOldAddress(page, testInfo.outputPath("seed"));
    await page.locator(NOTICE).getByRole("button", { name: "Move my files" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-move", "blocked");
    await expect(page.locator(".notice")).toContainText("The browser blocked the new tab.");
    const download = page.waitForEvent("download");
    await page.locator(".notice").getByRole("button", { name: "Download .zip" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  });
});

test("/move runs without isolation, so it offers no code links; / still does", async ({ page }) => {
  const link = `#code=1.${deflateRawSync(JSON.stringify({ n: "hello.py", t: "print(1)\n" })).toString("base64url")}`;
  await openApp(page, `${NEW}/${link}`);
  const shown = Date.now();
  await expect(page.locator("dialog#code-link")).toHaveAttribute("data-state", "ready");
  // How long / took to offer it once the editor was ready: /move gets several times that to (not) do it.
  const offerMs = Date.now() - shown;
  await openApp(page, `${NEW}/move${link}`);
  // The editor decided (its last start-up step), and the link was left alone: still in the address
  // bar, no dialog. On / the same link left the address bar as soon as it was taken.
  await expect(page.locator("#app")).toHaveAttribute("data-code-links", "off");
  await page.waitForTimeout(Math.max(1500, offerMs * 4));
  await expect(page.locator("dialog#code-link[open]")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe(link);
});

test.describe("a third origin", () => {
  // The new tab's "ready" is posted to the old address's origin; its opener here is another site,
  // so the browser drops it and says so (Firefox's words, then WebKit's; Chromium says nothing).
  test.use(
    tolerating(
      /does not match the recipient window.s origin \S+http:\/\/evil\.test\S+\)\.?\W*\{file: "http:\/\/127\.0\.0\.1:\d+\/move" line: 0\}\]$/,
      /^Unable to post message to http:\/\/localhost:\d+\. Recipient has origin http:\/\/evil\.test\.\s*$/,
    ),
  );
  test("a message from a third origin is ignored", async ({ page, context }) => {
    const zip = await zipOf({ "evil.py": "x = 1\n" });
    await context.route("http://evil.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>other site</title><p>other site</p>" }));
    await page.goto("http://evil.test/");
    const popup = await openReceiver(page);
    await page.evaluate(
      ([bytes, target]) => {
        const w = (window as unknown as { __w: Window }).__w;
        const zip = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
        // Even aimed at the right origin, a sender that isn't the old address is ignored.
        w.postMessage({ type: "codeeditor-move", v: 1, zip, count: 1 }, target);
        w.postMessage({ type: "codeeditor-move", v: 1, zip, count: 1 }, "*");
      },
      [zip, NEW] as const,
    );
    await expect(popup.locator("#app")).toHaveAttribute("data-move-ignored", "2");
    await expect(popup.locator("#app")).toHaveAttribute("data-move", "waiting");
    await expect(popup.getByRole("alertdialog")).toHaveCount(0);
    await expect(popup.locator(".tree [role=treeitem]")).toHaveCount(0);
  });
});

test.describe("the new address takes files only from the tab that opened it", () => {
  test("a message from another window at the old address is ignored; the opener's own is taken", async ({ page, context }) => {
    const zip = await zipOf({ "a.py": "a = 1\n" });
    await openApp(page, `${OLD}/move`);
    const popup = await openReceiver(page);
    // A second window at the old address, with a reference to the new tab: not the opener.
    const [second] = await Promise.all([context.waitForEvent("page"), page.evaluate(() => void ((window as unknown as { __b: Window | null }).__b = window.open("about:blank", "_blank")))]);
    // about:blank takes its opener's origin (self.origin; location.origin reads the URL's, "null").
    expect(await second.evaluate(() => self.origin)).toBe(OLD);
    await second.evaluate(
      ([bytes, target]) => {
        const w = (opener as { __w: Window }).__w;
        w.postMessage({ type: "codeeditor-move", v: 1, zip: new Blob([new Uint8Array(bytes)]), count: 1 }, target);
      },
      [zip, NEW] as const,
    );
    await expect(popup.locator("#app")).toHaveAttribute("data-move-ignored", "1");
    await expect(popup.getByRole("alertdialog")).toHaveCount(0);
    // The guard isn't refusing everything: the opener's own message is asked about.
    await page.evaluate(
      ([bytes, target]) => {
        const w = (window as unknown as { __w: Window }).__w;
        w.postMessage({ type: "codeeditor-move", v: 1, zip: new Blob([new Uint8Array(bytes)]), count: 1 }, target);
      },
      [zip, NEW] as const,
    );
    await expect(popup.getByRole("alertdialog", { name: "Add 1 file from your old ExecFlow?" })).toBeVisible();
    await popup.getByRole("alertdialog").getByRole("button", { name: "Add files" }).click();
    await expect(treeItem(popup, "a.py")).toHaveCount(1);
  });

  test("a zip that isn't a Blob is refused, without a dialog, and the opener is told", async ({ page }) => {
    await openApp(page, `${OLD}/move`);
    const popup = await openReceiver(page);
    const answer = page.evaluate(
      (target) =>
        new Promise((resolve) => {
          addEventListener("message", (e) => {
            if (e.origin === target && (e.data as { type?: string } | null)?.type === "codeeditor-move-done") resolve(e.data);
          });
          (window as unknown as { __w: Window }).__w.postMessage({ type: "codeeditor-move", v: 1, zip: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", count: 1 }, target);
        }),
      NEW,
    );
    await expect(popup.locator("#app")).toHaveAttribute("data-move", "refused-invalid");
    expect(await answer).toEqual({ type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "invalid" });
    await expect(popup.getByRole("alertdialog")).toHaveCount(0);
    await expect(popup.locator(".tree [role=treeitem]")).toHaveCount(0);
  });
});
