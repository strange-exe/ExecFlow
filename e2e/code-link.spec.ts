// Code links (src/core/code-link.ts, src/ui/code-link-dialog.ts, .claude/tasks/code-links.md): a
// file carried in the link itself. Opening one shows the code read-only first; Add puts it in the
// student's files under a free name and opens it; nothing runs. A damaged or hostile link says so
// and adds nothing. Links are made here with the app's own encoder (Node has the same compression
// streams), and one is made by the Share dialog and opened in a second, separate browser profile.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { makeCodeLink } from "../src/core/code-link";
import { expect, expectActive, importFiles, openApp, showFiles, test, treeItem, watchContext } from "./helpers";

test.use({ serviceWorkers: "block" });

const dialog = (page: Page) => page.locator("dialog#code-link");
const preview = (page: Page) => page.locator("#code-link-preview");
const C_PROGRAM = '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from a link\\n");\n    return 0;\n}\n';
const PY_PROGRAM = 'open("pwned.txt", "w").write("ran")\nprint("this must not run by itself")\n';

/** The fragment (#code=...) of a link for `name` holding `text`. */
async function fragment(name: string, text: string): Promise<string> {
  const made = await makeCodeLink("https://example.test", name, text);
  if (!made.ok) throw new Error(`no link: ${made.refusal.kind}`);
  return made.url.slice(made.url.indexOf("#"));
}

async function openLink(page: Page, hash: string) {
  await openApp(page, `/${hash}`);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
}

test("a link opens a read-only preview; Add puts it in the files and opens it; nothing runs", async ({ page }) => {
  await openLink(page, await fragment("hello.c", C_PROGRAM));
  await expect(page.locator("#code-link-title")).toHaveText("Open hello.c?");
  await expect(page.locator("#code-link-about")).toHaveText("C, 6 lines.");
  await expect(preview(page)).toHaveText(C_PROGRAM.replace(/\n$/, ""));
  await expect(page.locator("#code-link-add")).toBeFocused();
  // The code has left the address bar: a reload or a bookmark doesn't carry it.
  expect(new URL(page.url()).hash).toBe("");
  // Nothing is in the files until Add.
  await showFiles(page);
  await expect(treeItem(page, "hello.c")).toHaveCount(0);
  await page.locator("#code-link-add").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(treeItem(page, "hello.c")).toHaveCount(1);
  await expectActive(page, "hello.c");
  await expect(page.locator(".cm-content")).toContainText('printf("Hello from a link\\n");');
  await expect(page.locator("#app")).not.toHaveAttribute("data-run", /running|waiting/);
});

test("a Python link never runs by itself: added, opened, and still idle", async ({ page }) => {
  await openLink(page, await fragment("steal.py", PY_PROGRAM));
  await page.locator("#code-link-add").click();
  await expectActive(page, "steal.py");
  await page.waitForTimeout(1500);
  await expect(page.locator("#app")).not.toHaveAttribute("data-run", /running|waiting/);
  await expect(treeItem(page, "pwned.txt")).toHaveCount(0);
});

test("Not now adds nothing, and a reload doesn't offer it again", async ({ page }) => {
  await openLink(page, await fragment("hello.c", C_PROGRAM));
  await page.locator("#code-link-cancel").click();
  await expect(dialog(page)).toHaveCount(0);
  await showFiles(page);
  await expect(treeItem(page, "hello.c")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  await page.waitForTimeout(500);
  await expect(dialog(page)).toHaveCount(0);
});

test("a name already in the files is added under a free name, never over the file", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "hello.c", text: "int mine;\n" }]);
  await page.goto(`/${await fragment("hello.c", C_PROGRAM)}`);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#code-link-about")).toContainText("You already have a file named hello.c, so this one is added as hello-2.c.");
  await page.locator("#code-link-add").click();
  await expectActive(page, "hello-2.c");
  await expect(treeItem(page, "hello.c")).toHaveCount(1);
  await page.locator(`.tree [role=treeitem][data-path="hello.c"] > .tree-row`).click();
  await expect(page.locator(".cm-content")).toContainText("int mine;");
});

test("markup in the code is shown as text, and an invisible character is tagged", async ({ page }) => {
  const zwsp = String.fromCodePoint(0x200b);
  const code = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\nint a${zwsp}b;\n`;
  await openLink(page, await fragment("a&b'.html", code));
  await expect(page.locator("#code-link-title")).toHaveText("Open a&b'.html?");
  await expect(dialog(page).locator("img, script")).toHaveCount(0);
  await expect(preview(page)).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(preview(page)).toContainText("int a[U+200B]b;");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test.describe("a link that can't be opened says why and adds nothing", () => {
  const forge = (raw: string | Buffer) => `#code=1.${deflateRawSync(raw).toString("base64url")}`;
  const cases: [string, () => Promise<string>, RegExp][] = [
    ["cut off", async () => (await fragment("hello.c", C_PROGRAM.repeat(3))).slice(0, -20), /damaged or incomplete/],
    ["a deflate bomb", async () => forge(Buffer.alloc(5 * 1024 * 1024)), /holds more than a code link can/],
    ["a path out of the workspace", async () => forge(JSON.stringify({ n: "../evil.c", t: "x" })), /file name can't be used/],
    ["Trojan Source text", async () => forge(JSON.stringify({ n: "a.c", t: `/*${String.fromCodePoint(0x202e)}*/` })), /text-direction characters/],
    ["a lone carriage return (storage keeps LF only)", async () => forge(JSON.stringify({ n: "a.c", t: ["int a;", "int b;", ""].join(String.fromCharCode(13)) })), /carriage returns/],
    ["mixed line endings", async () => forge(JSON.stringify({ n: "a.c", t: `int a;${String.fromCharCode(13)}\nint b;\n` })), /mixes different line endings/],
  ];
  for (const [what, make, says] of cases) {
    test(what, async ({ page }) => {
      await openApp(page, `/${await make()}`);
      await expect(page.locator(".notice")).toContainText(says);
      await expect(page.locator(".notice")).toHaveAttribute("data-tone", "error");
      await expect(dialog(page)).toHaveCount(0);
      await showFiles(page);
      await expect(page.locator(".tree [role=treeitem]")).toHaveCount(0);
    });
  }
});

test("a link with Windows line endings is added with LF, as a file import adds it", async ({ page }) => {
  const forged = `#code=1.${deflateRawSync(JSON.stringify({ n: "crlf.c", t: C_PROGRAM.split("\n").join(String.fromCharCode(13) + "\n") })).toString("base64url")}`;
  await openLink(page, forged);
  await expect(preview(page)).toHaveText(C_PROGRAM.replace(/\n$/, ""));
  await page.locator("#code-link-add").click();
  await expectActive(page, "crlf.c");
  await expect(dialog(page)).toHaveCount(0);
});

test("while Add is adding, the dialog is marked busy and the button stays live; then it closes", async ({ page }) => {
  await openLink(page, await fragment("hello.c", C_PROGRAM));
  // Read in the same task as the press: the add is still pending then.
  const during = await page.evaluate(() => {
    const add = document.querySelector<HTMLButtonElement>("#code-link-add")!;
    add.click();
    const d = document.querySelector<HTMLDialogElement>("dialog#code-link")!;
    return { busy: d.getAttribute("aria-busy"), state: d.dataset.state, disabled: add.disabled, ariaDisabled: add.getAttribute("aria-disabled") };
  });
  expect(during).toEqual({ busy: "true", state: "adding", disabled: false, ariaDisabled: null });
  await expect(dialog(page)).toHaveCount(0);
  await expectActive(page, "hello.c");
});

test.describe("an add that fails keeps the shared file in the dialog", () => {
  test("storage refusing it: the dialog, the preview and the reason stay; Add again adds it", async ({ page }) => {
    await openLink(page, await fragment("hello.c", C_PROGRAM));
    // Every IndexedDB write fails until the flag is cleared (a full disk, say).
    await page.evaluate(() => {
      const w = window as unknown as { __failWrites: boolean };
      w.__failWrites = true;
      for (const method of ["put", "add"] as const) {
        const real = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: Parameters<typeof real>) {
          if (w.__failWrites) throw new DOMException("The disk is full (test).", "QuotaExceededError");
          return real.apply(this, args);
        };
      }
    });
    await page.locator("#code-link-add").click();
    await expect(dialog(page)).toHaveAttribute("data-state", "refused");
    await expect(dialog(page)).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#code-link-result")).toHaveAttribute("data-tone", "error");
    await expect(page.locator("#code-link-result")).toContainText("The disk is full (test).");
    await expect(preview(page)).toHaveText(C_PROGRAM.replace(/\n$/, ""));
    await expect(treeItem(page, "hello.c")).toHaveCount(0);
    await page.evaluate(() => ((window as unknown as { __failWrites: boolean }).__failWrites = false));
    await page.locator("#code-link-add").click();
    await expect(dialog(page)).toHaveCount(0);
    await expectActive(page, "hello.c");
    await expect(treeItem(page, "hello.c")).toHaveCount(1);
  });

  test("a read-only tab says so in the dialog and keeps the file; the editing tab adds it from the same link", async ({ page, context }) => {
    await openApp(page);
    const hash = await fragment("hello.c", C_PROGRAM);
    const second = await context.newPage();
    await openLink(second, hash);
    await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
    await second.locator("#code-link-add").click();
    await expect(dialog(second)).toHaveAttribute("data-state", "refused");
    await expect(second.locator("#code-link-result")).toHaveAttribute("data-tone", "warning");
    await expect(second.locator("#code-link-result")).toContainText("read-only");
    await expect(preview(second)).toHaveText(C_PROGRAM.replace(/\n$/, ""));
    // The link stays in this tab's address bar, to open in the editing tab.
    expect(new URL(second.url()).hash).toBe(hash);
    await page.evaluate((h) => (location.hash = h), hash);
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    await page.locator("#code-link-add").click();
    await expectActive(page, "hello.c");
    // The free name is chosen again at each press: the read-only tab learns of hello.c and would
    // now add the file as hello-2.c, never over it.
    await expect(async () => {
      await second.locator("#code-link-add").click();
      await expect(second.locator("#code-link-about")).toContainText("so this one is added as hello-2.c.", { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(dialog(second)).toHaveAttribute("data-state", "refused");
  });
});

test("a link pasted into the address bar of an open tab opens too (only the fragment changes)", async ({ page }) => {
  await openApp(page);
  const hash = await fragment("later.py", 'print("later")\n');
  await page.evaluate((h) => (location.hash = h), hash);
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#code-link-title")).toHaveText("Open later.py?");
});

test("Share link makes the link with nothing sent; a second browser profile opens it", async ({ page, browser, tolerate }, info) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => ({ writeText: (t: string) => (w.__copied.push(t), Promise.resolve()) }) });
  });
  await openApp(page);
  // From here on, nothing may go to another site (the app's own chunks load from this one).
  const origin = new URL(page.url()).origin;
  const sent: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== origin) sent.push(r.url());
  });
  await importFiles(page, [{ name: "hello.c", text: C_PROGRAM }]);
  await treeItem(page, "hello.c").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-state", "code");
  await page.locator("#share-primary").click();
  const [url] = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(url).toBe(await page.locator("#share-link").inputValue());
  expect(sent.filter((u) => !u.includes("static.cloudflareinsights.com"))).toEqual([]);

  const other = await browser.newContext({ serviceWorkers: "block" });
  // The fixture's checks (console, page errors, failed requests) for the second profile too.
  const watch = watchContext(other, info.project.name, tolerate);
  try {
    const them = await other.newPage();
    await them.goto(url!);
    await expect(them.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(dialog(them)).toHaveAttribute("data-state", "ready");
    await expect(preview(them)).toHaveText(C_PROGRAM.replace(/\n$/, ""));
    await them.locator("#code-link-add").click();
    await expectActive(them, "hello.c");
    expect(watch.settle(), "console errors and failed requests in the second profile").toEqual([]);
  } finally {
    await other.close();
  }
});

/** Imports `name` and opens Share link on it (the code link, the default); the clipboard records. */
async function shareCodeLink(page: Page, name: string, text: string) {
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: { type: string; text: string }[] };
    w.__clip = [];
    const fake = {
      writeText: (t: string) => (w.__clip.push({ type: "text", text: t }), Promise.resolve()),
      write: async (items: ClipboardItem[]) => {
        for (const item of items) for (const type of item.types) w.__clip.push({ type, text: await (await item.getType(type)).text() });
      },
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => fake });
  });
  await openApp(page);
  await importFiles(page, [{ name, text }]);
  await treeItem(page, name).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-state", /^code/);
}
const clip = (page: Page) => page.evaluate(() => (window as unknown as { __clip: { type: string; text: string }[] }).__clip);

test("Copy with title puts a link named after the file on the clipboard, and its plain text", async ({ page }) => {
  await shareCodeLink(page, "a&b.c", C_PROGRAM);
  const url = await page.locator("#share-link").inputValue();
  await page.locator("#share-titled").click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-copy", "titled");
  await expect(page.locator("#share-result")).toContainText('Copied the link with the title "Open a&b.c in CodeEditor"');
  const html = `<a href="${url}">Open a&amp;b.c in CodeEditor</a>`;
  const plain = `Open a&b.c in CodeEditor: ${url}`;
  // Where the browser has ClipboardItem, both forms in one item; where it hasn't, the plain text.
  const rich = await page.evaluate(() => typeof ClipboardItem === "function");
  expect(await clip(page)).toEqual(rich ? [{ type: "text/html", text: html }, { type: "text/plain", text: plain }] : [{ type: "text", text: plain }]);
});

test("Show QR code draws the link's code, module for module, dark on light in a dark theme", async ({ page }) => {
  await shareCodeLink(page, "hello.c", C_PROGRAM);
  // Emulated after the page loaded (Firefox drops one set before the first navigation), then proven.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const url = await page.locator("#share-link").inputValue();
  const toggle = page.locator("#share-qr-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-qr", "shown");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Hide QR code");
  const qr = page.locator("#share-qr");
  await expect(qr).toHaveAttribute("role", "img");
  await expect(qr).toHaveAttribute("aria-label", "QR code of the link to hello.c");
  // The same modules as the library gives in Node for the same link.
  const { encode } = await import("uqr");
  const modules = encode(url, { ecc: "L", border: 4 }).data;
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < row.length && row[x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  expect(await qr.locator("path").getAttribute("d")).toBe(d);
  const fills = await qr.evaluate((s) => [getComputedStyle(s.querySelector("rect")!).fill, getComputedStyle(s.querySelector("path")!).fill]);
  expect(fills).toEqual(["rgb(255, 255, 255)", "rgb(0, 0, 0)"]);
  const box = (await qr.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(modules.length * 2);
  await toggle.click();
  await expect(page.locator("#share-qr-box")).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("a link too long for a QR code says so (and is still a link)", async ({ page }) => {
  let seed = 5;
  const text = Array.from({ length: 4500 }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join("");
  await shareCodeLink(page, "notes.txt", `${text}\n`);
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-state", "code");
  expect((await page.locator("#share-link").inputValue()).length).toBeGreaterThan(2953);
  await page.locator("#share-qr-toggle").click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-qr", "too-long");
  await expect(page.locator("#share-qr-box")).toContainText("This link is too long for a QR code.");
  await expect(page.locator("#share-qr")).toHaveCount(0);
});

test("a file too long for a link says why in the Share dialog, and offers no link", async ({ page }) => {
  let seed = 11;
  const noise = Array.from({ length: 12000 }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join("");
  await openApp(page);
  await importFiles(page, [{ name: "data.txt", text: `${noise}\n` }]);
  await treeItem(page, "data.txt").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  await expect(page.locator("dialog#share-dialog")).toHaveAttribute("data-state", "code-refused");
  await expect(page.locator("#share-pending")).toContainText("data.txt is too long for a code link");
  await expect(page.locator("#share-link")).toHaveCount(0);
  // Ending the panel, the sentence leaves no empty band above the buttons (WebKit on CI measured 32 px).
  expect(await page.locator("#share-pending").evaluate((p) => getComputedStyle(p).marginBottom)).toBe("0px");
  await page.locator("#share-primary").click();
  await expect(page.locator("#share-result")).toHaveAttribute("data-tone", "error");
});

for (const size of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the open dialog: ${size.name} ${scheme}, axe, no overflow, long lines scroll inside`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await openApp(page);
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const long = `${"x = 1  # a very long line that has to scroll inside the preview, ".repeat(6)}\n`.repeat(80);
      await page.evaluate((h) => (location.hash = h), await fragment("long.py", long));
      await expect(dialog(page)).toHaveAttribute("data-state", "ready");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await dialog(page).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(await preview(page).evaluate((p) => p.scrollWidth > p.clientWidth && p.scrollHeight > p.clientHeight)).toBe(true);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include("dialog#code-link").analyze();
      expect(axe.violations.map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
      for (const id of ["code-link-cancel", "code-link-add"]) {
        const b = (await page.locator(`#${id}`).boundingBox())!;
        expect(b.height, id).toBeGreaterThanOrEqual(size.name === "phone" ? 43.5 : 23.5);
      }
      await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/shots"}/code-link/${test.info().project.name}/open-${size.name}-${scheme}.png`, animations: "disabled" });
    });
  }
}
