// Capture snippet (.claude/design/snippet-image/final-v3.md sections 2 to 7, tests 9.2): the file
// menu item, the editor head's button, the dialog with its preview and options, Copy image and
// Download (.png). Production build; the fixture fails on any console error, page error or failed
// request. Waits use state attributes (#app data-capture, data-captures; #snippet-dialog
// data-preview, data-preview-options), never wording. The instrumentation of 9.2 (snippet-helpers.ts)
// lives in init scripts only.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { audit } from "./audit";
import { expect, hierarchyShots, importFiles, openApp, openFromTree, openIn, reloadApp, run, test, tolerating } from "./helpers";
import {
  FIXTURE, MOD, box, calls, canCopy, captures, clearCalls, decodeRgba, dialogOf, downloadPng, hexRgb, inkOf, instrument, off, openFromFileMenu,
  openWith, pngInfo, previewPng, previewReady, salience, selectAll, selectFixtureLines, tokens, writtenPng,
} from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ITEM = /^Capture snippet of main\.py, lines 2 to 3\.\.\./;
const TITLE = "Capture snippet of lines 2 to 3";
const DESCRIPTION = "Preview of main.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown.";
/** Default options: 694 x 229 at scale 2 (final-v3 4.5, the fixture row). */
const SIZES: Record<string, [number, number]> = { "numbers name": [694, 229], "numbers no-name": [694, 142], "no-numbers name": [644, 229], "no-numbers no-name": [644, 142] };
const CASE_B = Array.from({ length: 200 }, () => "x".repeat(100)).join("\n") + "\n";
/** Two lines of 40,000 characters wrap to 834 rows: 18,835 CSS px tall, over 16,384 at scale 1. */
const TOO_BIG = `${"x".repeat(40_000)}\n${"y".repeat(40_000)}\n`;

const app = (page: Page) => page.locator("#app");
const notice = (page: Page) => page.locator(".statusbar .notice-text");
const copyButton = (page: Page) => dialogOf(page).getByRole("button", { name: "Copy image" });
const downloadButton = (page: Page) => dialogOf(page).getByRole("button", { name: "Download (.png)" });

/** The fixture open with lines 2 to 3 selected, and the dialog open from the file menu, ready. */
async function openDialog(page: Page) {
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  return dialogOf(page);
}

/** Sets the dialog's options and waits for the preview to show them. */
async function setOptions(page: Page, colors: "match" | "light" | "dark", numbers: boolean, name: boolean) {
  const d = dialogOf(page);
  await d.locator(`input[name=snippet-colors][value=${colors}]`).check();
  await d.locator("#snippet-numbers").setChecked(numbers);
  await d.locator("#snippet-name").setChecked(name);
  await previewReady(page, `${colors} ${numbers ? "numbers" : "no-numbers"} ${name ? "name" : "no-name"}`);
}

/** The pixel map of 9.2 on the default image (bitmap coordinates at scale 2). */
function pixelMap(png: Buffer, t: Record<string, string>) {
  const px = decodeRgba(png);
  expect(off(px.at(10, 10), t.bg), "ground").toBeLessThanOrEqual(2);
  for (const [x, y] of [[0, 0], [0, 228], [347, 228], [693, 228], [693, 0]]) expect(off(px.at(x, y), t.divider), `edge at ${x}, ${y}`).toBeLessThanOrEqual(2);
  const nameInk = inkOf(px, { x0: 34, x1: 150, y0: 26, y1: 71 }, t.bg);
  expect(nameInk && off(hexRgb(nameInk), t["text-secondary"]), `file name ${nameInk}`).toBeLessThanOrEqual(8);
  for (const y of [87, 88]) expect(off(px.at(300, y), t.border), `rule row ${y}`).toBeLessThanOrEqual(2);
  expect(off(px.at(20, 87), t.bg), "the rule starts at the padding").toBeLessThanOrEqual(2);
  const keyword = inkOf(px, { x0: 84, x1: 138, y0: 113, y1: 158 }, t.bg);
  expect(keyword && off(hexRgb(keyword), t["syn-keyword"]), `def ${keyword}`).toBeLessThanOrEqual(8);
  const number = inkOf(px, { x0: 34, x1: 52, y0: 113, y1: 158 }, t.bg);
  expect(number && off(hexRgb(number), t["gutter-text"]), `line number ${number}`).toBeLessThanOrEqual(8);
}

/** The default image's size, derived in the page from the code font's measured 0 and its size (the 4.1 constants). */
const derivedSize = (page: Page) =>
  page.locator(".cm-content").evaluate((el) => {
    const s = getComputedStyle(el);
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `400 ${s.fontSize} ${s.fontFamily}`;
    const ch = c.measureText("0").width;
    const size = parseFloat(s.fontSize);
    const lineH = size * 1.5;
    const [E, P, V, G, HG] = [1, 16, 12, 16, 8];
    const width = E + P + ch + G + Math.max(16 * ch, 32 * ch) + P + E;
    const height = E + V + lineH + HG + 1 + V + 2 * lineH + V + E;
    return { width: Math.ceil(width * 2), height: Math.ceil(height * 2), ch, size };
  });

async function expectDownload(page: Page, name: string, size: [number, number]) {
  const d = await downloadPng(page);
  expect(d.name).toBe(name);
  const info = pngInfo(d.bytes);
  expect([info.width, info.height]).toEqual(size);
  return d.bytes;
}

// ---------------------------------------------------------------- 1 to 4: open, download, copy

for (const scheme of ["light", "dark"] as const) {
  test(`1: the file menu item opens the dialog, and Download saves the PNG, with the pixel map (${scheme})`, async ({ page }) => {
    await openIn(page, "/", scheme);
    await openWith(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await selectFixtureLines(page);
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: ITEM }).click();
    const dialog = page.getByRole("dialog", { name: TITLE });
    await expect(dialog).toBeVisible();
    await previewReady(page, "match numbers name");
    const d = await downloadPng(page);
    expect(d.name).toBe("main-py-lines-2-3.png");
    const info = pngInfo(d.bytes);
    expect([info.depth, info.interlace]).toEqual([8, 0]);
    expect([info.width, info.height]).toEqual([694, 229]);
    const derived = await derivedSize(page);
    expect([derived.width, derived.height], `derived from ch ${derived.ch} at ${derived.size} px`).toEqual([694, 229]);
    for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]) expect(info.chunks, `no ${chunk} chunk`).not.toContain(chunk);
    const t = await tokens(page);
    expect(t.bg).toBe(scheme === "light" ? "#f8fbf9" : "#13201b");
    expect(t["syn-keyword"]).toBe(scheme === "light" ? "#713882" : "#d9a9e8");
    expect(t["text-secondary"]).toBe(scheme === "light" ? "#4b524d" : "#bdbfb8");
    expect(t.border).toBe(scheme === "light" ? "#c4d7cb" : "#2e423a");
    pixelMap(d.bytes, t);
    await expect(app(page)).toHaveAttribute("data-capture", "downloaded");
    await expect(dialog.locator("#snippet-status")).toHaveText("Downloading main-py-lines-2-3.png.");
  });
}

test("2: Copy reads back, writes and encodes inside the click: synchronous and activated; the PNG is the image", async ({ page, context, browserName }) => {
  const real = browserName === "chromium";
  if (real) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await instrument(page, { realWrite: real });
  await openDialog(page);
  if (!(await canCopy(page))) {
    test.info().annotations.push({ type: "2", description: `${browserName}: the page offers no image copy; test 4's outcome holds` });
    await expect(downloadButton(page)).toHaveClass(/primary/);
    await expect(downloadButton(page)).toBeFocused();
    return;
  }
  await expect(copyButton(page)).toBeFocused();
  await clearCalls(page);
  const before = await captures(page);
  await copyButton(page).click();
  // Waited for past the 5 s user activation, so a late write shows in its record (active: false), not as a timeout.
  await expect(app(page)).toHaveAttribute("data-captures", String(before + 1), { timeout: 15_000 });
  const c = await calls(page);
  expect(c.map((x) => x.name)).toEqual(["getImageData", "write", "toBlob"]);
  for (const x of c) expect(x, JSON.stringify(c)).toMatchObject({ sync: true, type: "click", active: true });
  await expect(app(page)).toHaveAttribute("data-capture", "copied");
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("Copied the image.");
  await expect(dialogOf(page)).toBeVisible();
  if (browserName !== "webkit") await expect(copyButton(page)).toBeFocused();
  else test.info().annotations.push({ type: "2 focus", description: `webkit after a click on Copy: ${await page.evaluate(() => document.activeElement?.textContent ?? document.activeElement?.tagName)}` });
  let png: Buffer;
  if (real) {
    png = Buffer.from(await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return Array.from(new Uint8Array(await (await item.getType("image/png")).arrayBuffer()));
    }));
  } else png = await writtenPng(page);
  const info = pngInfo(png);
  expect([info.width, info.height]).toEqual([694, 229]);
  // Only the PNG goes on the clipboard (final-v3 4.7 and 8): no text type with the code or the file's name.
  const types = real
    ? await page.evaluate(async () => (await navigator.clipboard.read())[0].types)
    : await page.evaluate(() => (window as unknown as { __items: ClipboardItem[] }).__items.at(-1)!.types);
  expect(types, "the clipboard item's types").toEqual(["image/png"]);
});

test("2 (not ready): Copy during a render still writes inside the click; the PNG has the options at click time", async ({ page, browserName }) => {
  await instrument(page, { realWrite: false, slowFillText: 1 });
  const text = Array.from({ length: 300 }, (_, i) => `value_${i} = ${i}`).join("\n") + "\n";
  await openWith(page, [{ name: "main.py", text }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of main\.py, lines 1 to 300\.\.\./);
  await previewReady(page, "match numbers name");
  test.skip(!(await canCopy(page)), `${browserName} offers no image copy`);
  const withNumbers = pngInfo(await previewPng(page)).width;
  // Measured now: while the slowed render runs, Playwright's own queries wait behind it, while an
  // input event at a known point is handled between its batches.
  const at = await box(copyButton(page));
  const nameBox = await box(dialogOf(page).locator("#snippet-name"));
  await clearCalls(page);
  await dialogOf(page).locator("#snippet-numbers").uncheck();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  // A newer option after the click: the render for the click's options is pinned and still exported.
  await page.mouse.click(nameBox.x + nameBox.width / 2, nameBox.y + nameBox.height / 2);
  await expect(app(page)).toHaveAttribute("data-capture", "copied", { timeout: 60_000 });
  const c = await calls(page);
  // The not-ready path: the write first, in the click; the readback and the encode after the render, off the click.
  expect(c.map((x) => x.name), JSON.stringify(c)).toEqual(["write", "getImageData", "toBlob"]);
  expect(c[0], JSON.stringify(c)).toMatchObject({ sync: true, type: "click", active: true });
  expect(c[1].sync).toBe(false);
  // The click's options (numbers off, file name on): narrower than with numbers, and taller than the
  // preview that follows with the file name off too.
  const info = pngInfo(await writtenPng(page));
  expect(info.width).toBeLessThan(withNumbers);
  await previewReady(page, "match no-numbers no-name");
  const after = pngInfo(await previewPng(page));
  expect(info.width).toBe(after.width);
  expect(info.height, "the header the click's options asked for").toBeGreaterThan(after.height);
});

for (const when of ["now", "after-item"] as const) {
  test(`3: a refused write (${when}) says to use Download, and Download reuses the PNG already made`, async ({ page, browserName }) => {
    await instrument(page, { realWrite: false, writeReject: when });
    await openDialog(page);
    test.skip(!(await canCopy(page)), `${browserName} offers no image copy`);
    await clearCalls(page);
    await copyButton(page).click();
    await expect(app(page)).toHaveAttribute("data-capture", "denied");
    await expect(dialogOf(page).locator("#snippet-status")).toHaveText("Couldn't copy the image. Use Download instead.");
    if (browserName !== "webkit") await expect(copyButton(page)).toBeFocused();
    const png = await expectDownload(page, "main-py-lines-2-3.png", [694, 229]);
    expect(png.length).toBeGreaterThan(0);
    expect((await calls(page)).filter((x) => x.name === "toBlob")).toHaveLength(1);
  });
}

test("4: without image clipboard support there is no Copy, and Download is the primary action", async ({ page }) => {
  await page.addInitScript(() => void delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem);
  await openDialog(page);
  await expect(copyButton(page)).toHaveCount(0);
  await expect(downloadButton(page)).toHaveClass(/primary/);
  await expect(downloadButton(page)).toBeFocused();
});

// ---------------------------------------------------------------- 5 to 9: refusals, caps, options

test("5: refusals before opening: nothing selected, blank-free cursor, the head button by pointer and by key, over 300 lines", async ({ page }) => {
  await instrument(page, { realWrite: false });
  await openWith(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator(".cm-content").click();
  const refuse = async (open: () => Promise<void>, text: string, reason: string) => {
    const before = await captures(page);
    await open();
    await expect(app(page)).toHaveAttribute("data-captures", String(before + 1));
    await expect(app(page)).toHaveAttribute("data-capture", "refused");
    await expect(app(page)).toHaveAttribute("data-capture-reason", reason);
    await expect(notice(page)).toHaveText(text);
    await expect(dialogOf(page)).toHaveCount(0);
  };
  const menuItem = async () => {
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: "Capture snippet of the selected lines..." }).click();
  };
  await refuse(menuItem, "Select the lines first, then right-click them or press Shift+F10.", "empty");
  // Select, then Escape (it collapses the selection), then the item: the same.
  await selectFixtureLines(page);
  await page.keyboard.press("Escape");
  await refuse(menuItem, "Select the lines first, then right-click them or press Shift+F10.", "empty");
  await refuse(() => page.locator("#snippet-button").click(), "Select the lines first.", "empty");
  await refuse(async () => {
    await page.locator("#snippet-button").focus();
    await page.keyboard.press("Enter");
  }, "Select the lines in the code, then press Shift+F10 there.", "empty");
  const before = await captures(page);
  await page.locator("#snippet-button").dblclick();
  await page.waitForTimeout(300);
  expect(await captures(page), "a double click with nothing selected refuses once").toBe(before + 1);
  expect((await calls(page)).filter((c) => c.name === "write")).toEqual([]);
  expect(downloads).toBe(0);

  // Only the blank line 4 (from its start to line 5's start): nothing to draw.
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("#status-pos")).toHaveText("Ln 5, Col 1");
  await refuse(async () => {
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: "Capture snippet of the selected lines..." }).click();
  }, "The selected lines are blank. Select some code first.", "blank");

  await importFiles(page, [{ name: "long.py", text: "x\n".repeat(301) }]);
  await openFromTree(page, "long.py");
  await selectAll(page);
  await refuse(async () => {
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: "Capture snippet of long.py, lines 1 to 301..." }).click();
  }, "That's 301 lines. An image can show up to 300, so select fewer lines.", "cap");
});

test("6: 300 lines fit at scale 2; case B steps down to 1.5, and its last row and column are opaque edge", async ({ page }) => {
  await openWith(page, [{ name: "x.py", text: "x\n".repeat(300) }, { name: "b.py", text: CASE_B }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of x\.py, lines 1 to 300\.\.\./);
  await previewReady(page);
  await expectDownload(page, "x-py-lines-1-300.png", [730, 13639]);
  await page.keyboard.press("Escape");
  await openFromTree(page, "b.py");
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
  await previewReady(page);
  const png = await expectDownload(page, "b-py-lines-1-200.png", [1466, 6855]);
  const px = decodeRgba(png);
  const divider = (await tokens(page)).divider;
  for (let x = 0; x < px.width; x++) {
    const p = px.at(x, px.height - 1);
    if (p[3] !== 255 || off(p, divider) > 2) throw new Error(`last row at ${x}: ${p}`);
  }
  for (let y = 0; y < px.height; y++) {
    const p = px.at(px.width - 1, y);
    if (p[3] !== 255 || off(p, divider) > 2) throw new Error(`last column at ${y}: ${p}`);
  }
});

test("7: the options change the image: every combination's size, Light in a dark theme, no name in the file name", async ({ page }) => {
  await openIn(page, "/", "dark");
  await openDialog(page);
  await setOptions(page, "light", false, false);
  const png = await expectDownload(page, "code-lines-2-3.png", [644, 142]);
  expect(off(decodeRgba(png).at(10, 10), "#f8fbf9"), "Light's ground in a dark theme").toBeLessThanOrEqual(2);
  for (const colors of ["match", "light", "dark"] as const) {
    for (const numbers of [true, false]) {
      for (const name of [true, false]) {
        await setOptions(page, colors, numbers, name);
        await expectDownload(page, name ? "main-py-lines-2-3.png" : "code-lines-2-3.png", SIZES[`${numbers ? "numbers" : "no-numbers"} ${name ? "name" : "no-name"}`]);
      }
    }
  }
});

test("8: the options are remembered on this device, cleaned when read, and work for the opening when storage throws", async ({ page, context }) => {
  await openDialog(page);
  await setOptions(page, "light", false, false);
  await page.keyboard.press("Escape");
  await reloadApp(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "light no-numbers no-name");
  await expect(dialogOf(page).locator("input[value=light]")).toBeChecked();
  await expect(dialogOf(page).locator("#snippet-numbers")).not.toBeChecked();
  await expect(dialogOf(page).locator("#snippet-name")).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image"))).toBe('{"colors":"light","numbers":false,"name":false}');
  await page.keyboard.press("Escape");

  await page.evaluate(() => localStorage.setItem("codeeditor:snippet-image", '{"colors":"neon"}'));
  await reloadApp(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name");
  await page.keyboard.press("Escape");

  const blocked = await context.newPage();
  await blocked.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === "codeeditor:snippet-image") throw new DOMException("blocked (test)", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "codeeditor:snippet-image") throw new DOMException("blocked (test)", "SecurityError");
      return set.call(this, key, value);
    };
  });
  await openApp(blocked);
  await openFromTree(blocked, "main.py");
  await selectFixtureLines(blocked);
  await openFromFileMenu(blocked, ITEM);
  await previewReady(blocked, "match numbers name");
  await blocked.locator("input[name=snippet-colors][value=light]").check();
  await previewReady(blocked, "light numbers name");
  await blocked.close();
});

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`9: nothing moves: options at 1440, and Copy's and Download's results at ${vp.width} x ${vp.height}`, async ({ page }) => {
    await instrument(page, { realWrite: false });
    await page.setViewportSize(vp);
    await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "b.py", text: CASE_B }]);
    const parts = ["#snippet-frame", ".snippet-options fieldset:nth-of-type(1)", ".snippet-options fieldset:nth-of-type(2)", "#snippet-status", ".snippet-actions .btn >> nth=0", ".snippet-actions .btn >> nth=-1"];
    const boxes = () => Promise.all(parts.map(async (p) => box(dialogOf(page).locator(p))));
    const near = (a: { x: number; y: number; width: number; height: number }[], b: typeof a, what: string) =>
      a.forEach((r, i) => {
        for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(r[k] - b[i][k]), `${what}: ${parts[i]} ${k}`).toBeLessThanOrEqual(0.5);
      });
    for (const file of vp.width === 1440 ? ["main.py", "b.py"] : ["main.py"]) {
      await openFromTree(page, file);
      if (file === "main.py") await selectFixtureLines(page);
      else await selectAll(page);
      if (vp.width < 900) await page.locator(".drawer-toggle").click();
      await openFromFileMenu(page, file === "main.py" ? ITEM : /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
      await previewReady(page);
      const first = await boxes();
      if (vp.width === 1440) {
        for (const colors of ["match", "light", "dark"] as const)
          for (const numbers of [true, false])
            for (const name of [true, false]) {
              await setOptions(page, colors, numbers, name);
              near(first, await boxes(), `${file} ${colors} ${numbers} ${name}`);
            }
        await setOptions(page, "match", true, true);
      }
      const buttons = async () => [await box(downloadButton(page)), ...((await canCopy(page)) ? [await box(copyButton(page))] : [])];
      const before = await buttons();
      if (await canCopy(page)) {
        await copyButton(page).click();
        await expect(dialogOf(page).locator("#snippet-status")).toHaveText("Copied the image.");
        const after = await buttons();
        before.forEach((b, i) => expect(Math.abs(b.y - after[i].y) + Math.abs(b.x - after[i].x), "after Copy").toBeLessThanOrEqual(0.5));
      }
      await downloadPng(page);
      await expect(dialogOf(page).locator("#snippet-status")).toHaveText(/^Downloading .*\.png\.$/);
      const after = await buttons();
      before.forEach((b, i) => expect(Math.abs(b.y - after[i].y) + Math.abs(b.x - after[i].x), "after Download").toBeLessThanOrEqual(0.5));
      await page.keyboard.press("Escape");
    }
  });
}

// ---------------------------------------------------------------- 10 to 17: keyboard, head, phones, sizes, axe

for (const key of ["Enter", "Space"] as const) {
  test(`10: the file menu's keyboard path (${key}), the dialog's Tab order and arrows, Escape back to More file actions`, async ({ page }) => {
    await openWith(page);
    await selectFixtureLines(page);
    const before = await captures(page);
    await page.keyboard.press(`${MOD}+Shift+E`);
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#file-actions")).toBeFocused();
    await page.keyboard.press("Enter");
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("c");
      if (((await page.evaluate(() => document.activeElement?.querySelector(".menu-label")?.textContent)) ?? "").startsWith("Capture snippet")) break;
    }
    expect(await page.evaluate(() => document.activeElement?.querySelector(".menu-label")?.textContent)).toBe("Capture snippet of main.py, lines 2 to 3...");
    await page.keyboard.press(key);
    await previewReady(page);
    const primary = (await canCopy(page)) ? copyButton(page) : downloadButton(page);
    await expect(primary).toBeFocused();
    expect(await captures(page)).toBe(before);
    await expect(dialogOf(page).locator("#snippet-status")).toHaveText("");
    if (key === "Space") return;

    // Tab: close, frame, the Colours group, Line numbers, File name, Download, Copy; never outside the dialog.
    await dialogOf(page).getByRole("button", { name: "Close" }).focus();
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      seen.push(await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "body";
        if (!a.closest("#snippet-dialog")) return `outside:${a.tagName}#${a.id}`;
        return a.id || a.getAttribute("aria-label") || a.textContent?.trim() || a.tagName;
      }));
      await page.keyboard.press("Tab");
    }
    expect(seen.filter((s) => s.startsWith("outside")), seen.join(" | ")).toEqual([]);
    // Between cycles the focus may rest on the page (body) or, in WebKit, on the dialog element itself.
    const cycle = seen.filter((s) => s !== "body" && s !== "snippet-dialog");
    const order = ["Close", "snippet-frame", "snippet-colors-match", "snippet-numbers", "snippet-name", "Download (.png)", ...((await canCopy(page)) ? ["Copy image"] : [])];
    expect(cycle.slice(0, order.length)).toEqual(order);
    // Past the last control the focus leaves for the browser's own UI. Chromium and WebKit bring it back to the
    // first control (a second cycle); Playwright's Firefox keeps it in its toolbar, so the dialog's active element
    // stays the last control. Either way nothing outside the dialog ever had focus (checked above).
    const rest = cycle.slice(order.length);
    const wrapped = rest.every((s, i) => s === order[i % order.length]);
    const stayed = rest.every((s) => s === order.at(-1));
    expect(wrapped || stayed, seen.join(" | ")).toBe(true);
    test.info().annotations.push({ type: "10 Tab", description: `${test.info().project.name}: ${wrapped ? "second cycle" : "focus stayed in the browser's UI"}` });

    // Arrows in the Colours group change the choice and re-render.
    const renders = Number(await dialogOf(page).getAttribute("data-renders"));
    await dialogOf(page).locator("#snippet-colors-match").focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialogOf(page).locator("#snippet-colors-light")).toBeChecked();
    await previewReady(page, "light numbers name");
    expect(Number(await dialogOf(page).getAttribute("data-renders"))).toBeGreaterThan(renders);
    await page.keyboard.press("Escape");
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.locator("#file-actions")).toBeFocused();
    await expect(page.locator(".cm-selectionBackground").first()).toBeAttached();

    // The Shortcuts dialog lists the code menu's keys.
    await page.locator("#shortcuts-button").click();
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    await expect(shortcuts.locator("dd", { hasText: "Menu for the selected code: Capture snippet (an image of the lines), Cut, Copy, Select all" })).toHaveCount(1);
    await expect(shortcuts.locator("dd", { hasText: "The browser's own menu for the selected code" })).toHaveCount(mac ? 0 : 1);
    await expect(shortcuts.locator("dd", { hasText: "More actions for the chosen file (in the list)" })).toHaveCount(1);
  });
}

test("11: the head button: last in the head after Run, named, quiet, 28 px; it opens the dialog and gets focus back; none on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  const button = page.locator("#snippet-button");
  const stops = await page.locator(".editor-head").evaluate((head) =>
    [...head.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => el.id),
  );
  expect(stops.at(-1)).toBe("snippet-button");
  expect(stops.at(-2)).toBe("run-button");
  await expect(button).toHaveAccessibleName("Capture snippet of the selected lines");
  await expect(button).toHaveAttribute("title", "Capture snippet of the selected lines");
  await expect(button).not.toHaveAttribute("aria-haspopup");
  const b = await box(button);
  expect([b.width, b.height]).toEqual([28, 28]);
  await selectFixtureLines(page);
  await button.click();
  await previewReady(page);
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeHidden();
});

test.describe("12: coarse pointer at 1280 x 800 (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates pointer: coarse in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1280, height: 800 } });
  test("the head is 48 px and holds its 44 px controls; the dialog's buttons and choices are 44 px", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulated").toBe(true);
    await openWith(page);
    const head = await box(page.locator(".editor-head"));
    expect(head.height).toBe(48);
    const b = await box(page.locator("#snippet-button"));
    expect([b.width, b.height]).toEqual([44, 44]);
    for (const el of await page.locator(".editor-head button:visible").all()) {
      const r = await box(el);
      expect(r.y, await el.getAttribute("id") ?? "").toBeGreaterThanOrEqual(head.y - 0.5);
      expect(r.y + r.height).toBeLessThanOrEqual(head.y + head.height + 0.5);
    }
    await selectFixtureLines(page);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    for (const el of await dialogOf(page).locator(".snippet-actions .btn, .snippet-choice, .dialog-head .icon-btn").all()) expect((await box(el)).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    // On a touch screen the refusal names no right-click or Shift+F10.
    await page.locator(".cm-content").click();
    await page.locator("#snippet-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-capture-reason", "empty");
    await expect(page.locator(".statusbar .notice-text")).toHaveText("Select the lines to capture first.");
  });
});

test.describe("13: phones (Chromium, WebKit)", () => {
  test.skip(({ browserName }) => browserName === "firefox", "the phone rows run in Chromium and WebKit (9.2)");
  test("390 x 844 from the drawer: the drawer closes first, the dialog fits, focus goes back to Files; 320 x 640 wraps", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWith(page);
    await selectFixtureLines(page);
    await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await expect(app(page)).not.toHaveAttribute("data-drawer");
    const d = await box(dialogOf(page));
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.y).toBeGreaterThanOrEqual(0);
    expect(d.x + d.width).toBeLessThanOrEqual(390);
    expect(d.y + d.height).toBeLessThanOrEqual(844);
    await expect(dialogOf(page).locator(".snippet-actions")).toBeInViewport();
    const overflow = () => page.evaluate(() => {
      const dlg = document.querySelector("#snippet-dialog")!;
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth && dlg.scrollWidth <= dlg.clientWidth;
    });
    expect(await overflow()).toBe(true);
    for (const el of await dialogOf(page).locator(".snippet-actions .btn, .snippet-choice, .dialog-head .icon-btn").all()) expect((await box(el)).height).toBeGreaterThanOrEqual(44);
    await expect((await canCopy(page)) ? copyButton(page) : downloadButton(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();

    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    expect(await overflow()).toBe(true);
    const buttons = await dialogOf(page).locator(".snippet-actions .btn").all();
    for (const btn of buttons) await expect(btn).toBeInViewport();
    if (buttons.length === 2) {
      const [a, b] = [await box(buttons[0]), await box(buttons[1])];
      expect(a.y < b.y || (a.y === b.y && a.x < b.x), "Download, then Copy, in DOM order").toBe(true);
    }
    const title = await box(dialogOf(page).locator(".dialog-title"));
    const headBox = await box(dialogOf(page).locator(".dialog-head"));
    expect(title.height, "the title wraps").toBeGreaterThan(30);
    expect(title.x + title.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5);
  });
});

/** The frame's bottom edge and the first Colours row lie inside the body's visible box. */
async function normalMode(page: Page) {
  await expect(dialogOf(page)).not.toHaveAttribute("data-compact");
  const body = await box(dialogOf(page).locator(".dialog-body"));
  const frame = await box(dialogOf(page).locator("#snippet-frame"));
  const row = await box(dialogOf(page).locator(".snippet-choice").first());
  expect(frame.y + frame.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
  expect(row.y + row.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
  // A wheel over the body, outside the frame, scrolls the body until File name shows.
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.wheel(0, 600);
  await expect(dialogOf(page).locator("label[for=snippet-name]")).toBeInViewport();
  // The wheel's scroll can still be moving when the label first shows (Firefox, a full run: 0.75 px short), so wait for it to be whole.
  await expect
    .poll(async () => {
      const label = await box(dialogOf(page).locator("label[for=snippet-name]"));
      const after = await box(dialogOf(page).locator(".dialog-body"));
      return label.y + label.height - (after.y + after.height);
    })
    .toBeLessThanOrEqual(0.5);
}

// 1093 x 460: 1366 x 768 at 125% with more browser toolbars; the budget's frame cap is small there (about 150).
for (const vp of [{ width: 1440, height: 900 }, { width: 1093, height: 504 }, { width: 1093, height: 460 }]) {
  test(`14: normal mode at ${vp.width} x ${vp.height}: the frame and the first choice in view, the body scrolls to the rest`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "b.py", text: CASE_B }]);
    await selectFixtureLines(page);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await normalMode(page);
    await page.keyboard.press("Escape");
    await openFromTree(page, "b.py");
    await selectAll(page);
    await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
    await previewReady(page);
    await normalMode(page);
  });
}

test.describe("14 and 15: coarse pointer sizes (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates pointer: coarse in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1280, height: 800 } });
  test("1280 x 800 coarse is normal mode; 844 x 390 coarse is compact", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await openWith(page);
    await selectFixtureLines(page);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await normalMode(page);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await compactMode(page);
  });
});

/** Compact mode: the dialog scrolls as one; every control comes into view when focused; no sideways scroll. */
async function compactMode(page: Page) {
  await expect(dialogOf(page)).toHaveAttribute("data-compact", "");
  // At open the preview frame, the dialog's top, has focus (the APG dialog pattern for content that
  // would scroll the start out of view): the title and the preview are in view, not the footer.
  await expect(dialogOf(page).locator("#snippet-frame")).toBeFocused();
  // (WebKit then scrolls the dialog by a few px on its own, measured 3 at 455 x 213; the title stays whole.)
  await expect(dialogOf(page).locator(".dialog-title"), "the title is in view at open").toBeInViewport({ ratio: 1 });
  const frameTop = await dialogOf(page).locator("#snippet-frame").evaluate((f) => f.getBoundingClientRect().top - f.closest("dialog")!.getBoundingClientRect().top);
  expect(frameTop, "the focused frame's top edge is in view at open").toBeGreaterThanOrEqual(0);
  expect(frameTop).toBeLessThan(await dialogOf(page).evaluate((d) => d.clientHeight));
  const controls = ["Close", "#snippet-frame", "#snippet-colors-match", "#snippet-numbers", "#snippet-name", "Download (.png)", "Copy image"];
  for (const c of controls) {
    const el = c.startsWith("#") ? dialogOf(page).locator(c) : dialogOf(page).getByRole("button", { name: c });
    if (!(await el.count())) continue;
    await el.focus();
    await expect(el, `${c} in view when focused`).toBeInViewport();
  }
  for (const block of ["start", "end"] as const) {
    await dialogOf(page).locator("#snippet-frame").evaluate((f, b) => f.scrollIntoView({ block: b }), block);
    const f = await box(dialogOf(page).locator("#snippet-frame"));
    const vh = page.viewportSize()!.height;
    if (block === "start") expect(f.y).toBeGreaterThanOrEqual(-0.5);
    else expect(f.y + f.height).toBeLessThanOrEqual(vh + 0.5);
  }
  expect(await page.evaluate(() => {
    const dlg = document.querySelector("#snippet-dialog")!;
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth && dlg.scrollWidth <= dlg.clientWidth;
  })).toBe(true);
}

for (const vp of [{ width: 683, height: 330 }, { width: 455, height: 213 }, { width: 320, height: 256 }]) {
  test(`15: compact mode at ${vp.width} x ${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openWith(page);
    await selectFixtureLines(page);
    if (vp.width < 900) await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await compactMode(page);
  });
}

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`16: axe and the painted-pair audit with the dialog open (${vp.name}, ${scheme}): ready, after Copy, too big; the file menu`, async ({ page }) => {
      await instrument(page, { realWrite: false });
      await page.setViewportSize(vp);
      await openIn(page, "/", scheme);
      await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "big.py", text: TOO_BIG }]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const check = async (what: string) => {
        const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
        expect(axe, `axe ${what}`).toEqual([]);
        const a = await audit(page);
        expect(a.pairs.filter((p) => p.ratio < p.min).map((p) => `${p.sel} "${p.text}" ${p.fg} on ${p.bg} ${p.ratio}`), `pairs ${what}`).toEqual([]);
        // The dialog's controls (audit's scope is the open dialog), or the menu's items; separators are no targets.
        const mine = (t: { sel: string }) => (what === "file menu" ? t.sel.includes("menu-item") : !t.sel.includes("menu-sep"));
        expect(a.targets.filter((t) => mine(t) && !t.spaced).map((t) => `${t.sel} ${t.w}x${t.h}`), `targets ${what}`).toEqual([]);
      };
      await selectFixtureLines(page);
      if (vp.width < 900) await page.locator(".drawer-toggle").click();
      // The file menu open with a selection.
      await page.locator("#file-actions").click();
      await expect(page.getByRole("menuitem", { name: ITEM })).toBeVisible();
      await check("file menu");
      await page.getByRole("menuitem", { name: ITEM }).click();
      await previewReady(page);
      await check("ready");
      if (await canCopy(page)) {
        await copyButton(page).click();
        await expect(app(page)).toHaveAttribute("data-capture", "copied");
        await check("after Copy");
      }
      await page.keyboard.press("Escape");
      await openFromTree(page, "big.py");
      await selectAll(page);
      if (vp.width < 900) await page.locator(".drawer-toggle").click();
      await openFromFileMenu(page, /^Capture snippet of big\.py, lines 1 to 2\.\.\./);
      await expect(dialogOf(page)).toHaveAttribute("data-preview", "too-big", { timeout: 30_000 });
      await expect(dialogOf(page).locator(".snippet-frame-text")).toHaveText("That selection is too big for one image. Close this and select fewer or shorter lines.");
      await expect(dialogOf(page).locator("#snippet-frame")).toHaveAttribute("aria-label", "No preview: that selection is too big for one image.");
      await check("too big");
      if (vp.name === "desktop" && scheme === "light") {
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 320, height: 256 });
        await openFromTree(page, "main.py");
        await selectFixtureLines(page);
        await page.locator(".drawer-toggle").click();
        await openFromFileMenu(page, ITEM);
        await previewReady(page);
        await expect(dialogOf(page)).toHaveAttribute("data-compact", "");
        await check("compact 320 x 256");
      }
    });
  }
}

test("17: a tall preview is a named, focusable image that scrolls by keyboard, and shows ink at its end", async ({ page }) => {
  await openWith(page, [{ name: "b.py", text: CASE_B }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
  await previewReady(page);
  const frame = dialogOf(page).locator("#snippet-frame");
  await expect(frame).toHaveAttribute("role", "img");
  await expect(frame).toHaveAccessibleName("Preview of b.py, lines 1 to 200, in the editor's colours; line numbers shown; file name shown.");
  await frame.focus();
  await expect(frame).toBeFocused();
  const page0 = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => frame.evaluate((f) => f.scrollTop)).toBeGreaterThan(0);
  const afterArrow = await frame.evaluate((f) => f.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => frame.evaluate((f) => f.scrollTop)).toBeGreaterThan(afterArrow);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0), "the page doesn't scroll").toBe(page0);
  await frame.evaluate((f) => (f.scrollTop = f.scrollHeight));
  const shot = decodeRgba(await frame.screenshot());
  const t = await tokens(page);
  let ink = 0;
  for (let y = 0; y < shot.height; y += 2) for (let x = 0; x < shot.width; x += 2) if (off(shot.at(x, y), t.bg) > 40 && off(shot.at(x, y), t.surface) > 40) ink++;
  expect(ink, "the end of a tall preview is drawn").toBeGreaterThan(50);
});

test("17 (ring): the frame's focus ring shows on all four sides, inside the body that scrolls it", async ({ page }) => {
  await openDialog(page);
  // By keyboard, so the ring is the :focus-visible one: from the first Colours choice, Shift+Tab.
  await dialogOf(page).locator("#snippet-colors-match").focus();
  await page.keyboard.press("Shift+Tab");
  const frame = dialogOf(page).locator("#snippet-frame");
  await expect(frame).toBeFocused();
  const g = await frame.evaluate((f) => {
    const s = getComputedStyle(f);
    const body = f.closest(".dialog-body")!;
    const out = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
    const r = f.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    return {
      visible: f.matches(":focus-visible"), style: s.outlineStyle, clips: getComputedStyle(body).overflowY !== "visible",
      ring: { top: r.top - out, left: r.left - out, right: r.right + out, bottom: r.bottom + out },
      body: { top: b.top, left: b.left, right: b.right, bottom: b.bottom },
    };
  });
  expect(g.visible && g.style !== "none", JSON.stringify(g)).toBe(true);
  // The body clips what lies outside its box (overflow: auto): the whole ring must lie inside it.
  expect(g.clips).toBe(true);
  expect(g.ring.top, `ring top against the body's top: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(g.body.top - 0.5);
  expect(g.ring.left).toBeGreaterThanOrEqual(g.body.left - 0.5);
  expect(g.ring.right).toBeLessThanOrEqual(g.body.right + 0.5);
  expect(g.ring.bottom).toBeLessThanOrEqual(g.body.bottom + 0.5);
});

// ---------------------------------------------------------------- 18 to 24: content, network, themes, renders, head

/** CodeMirror 6.43.14's special characters plus EXTRA_SPECIALS (mirrors src/editor/snippet-render.ts), minus the line breaks LF and CR, which can't sit inside a line. */
const SPECIALS = [
  ...Array.from({ length: 9 }, (_, i) => i), ...Array.from({ length: 22 }, (_, i) => 0xa + i).filter((c) => c !== 0xa && c !== 0xd),
  ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i), 0xad, 0x61c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2069, 0xfeff, 0xfff9, 0xfffa, 0xfffb, 0xfffc,
  0x202a, 0x202b, 0x202c, 0x2068, 0x2060, 0x180e, 0x115f, 0x1160, 0x3164, 0xffa0,
];

/**
 * Replaces the file's text as the browser's own text insertion (execCommand insertText into the
 * focused editor, which CodeMirror reads like typing): Playwright's keyboard insertText drops the C0
 * control characters in Firefox (59 of 88 arrived), a synthetic paste event carries no data there,
 * and setCode compares the rendered text, which shows specials as placeholders.
 */
async function pasteCode(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+A`);
  await page.locator(".cm-content").evaluate((_, t) => document.execCommand("insertText", false, t), text);
}

test("18: special characters: a direction override is drawn in --danger; the editor marks every character the renderer does", async ({ page }) => {
  await openWith(page);
  const rlo = String.fromCodePoint(0x202e);
  await pasteCode(page, `x = "a${rlo}b"\n`);
  await expect(page.locator(".cm-line").first().locator(".cm-specialChar")).toHaveCount(1);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of main\.py, line 1\.\.\./);
  await previewReady(page);
  const t = await tokens(page);
  const px = decodeRgba(await previewPng(page));
  // codeX = E + P + 1 digit + G = 42; the placeholder is column 6; row 1 starts at codeTop 56.5 (scale 2).
  let danger = 0;
  for (let y = 113; y <= 158; y++) for (let x = Math.floor((42 + 6 * 9) * 2); x <= Math.ceil((42 + 7 * 9) * 2); x++) if (off(px.at(x, y), t.danger) <= 8) danger++;
  expect(danger, "danger pixels in the placeholder's box").toBeGreaterThan(4);
  await page.keyboard.press("Escape");

  // Every character of the list, NUL included, on one line.
  const chars = SPECIALS;
  await pasteCode(page, `s = "${chars.map((c) => String.fromCodePoint(c)).join("")}"`);
  await expect(page.locator(".cm-line").first().locator(".cm-specialChar")).toHaveCount(chars.length);
});

test("19: no request leaves the site; the first opening fetches only same-origin chunks, styles and fonts; the second fetches nothing", async ({ page }) => {
  // The app's start-up still fetches after the editor is ready: Python's runtime, then, once Python
  // is up, the service worker's registration chunk (workbox-window, main.ts). Neither is the dialog's:
  // in WebKit under load that chunk landed in the second opening (3 of 3 runs, 2026-10-22). The page
  // records the registration call (Workbox calls navigator.serviceWorker.register once its chunk ran;
  // an own property, so Playwright's blocking stub on the prototype still answers it), and the
  // counting starts after it.
  await page.addInitScript(() => {
    const w = window as unknown as { __swAsked: boolean };
    const container = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    w.__swAsked = !container;
    if (!container) return;
    Object.defineProperty(container, "register", {
      configurable: true,
      value(this: ServiceWorkerContainer, ...args: Parameters<ServiceWorkerContainer["register"]>) {
        w.__swAsked = true;
        return ServiceWorkerContainer.prototype.register.apply(this, args);
      },
    });
  });
  await openWith(page);
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __swAsked: boolean }).__swAsked)).toBe(true);
  await selectFixtureLines(page);
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  const origin = new URL(page.url()).origin;
  for (const u of urls) {
    const url = new URL(u);
    expect(url.origin, u).toBe(origin);
    expect(url.pathname, u).toMatch(/^\/assets\/[\w-]+\.(js|css|woff2)$/);
  }
  await page.keyboard.press("Escape");
  urls.length = 0;
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  expect(urls).toEqual([]);
});

test("20: the Colours choices name what they give, in Deep Field, Slate and High contrast; Match is this tab's paint", async ({ page, context }) => {
  const labels = async () => dialogOf(page).locator(".snippet-options fieldset").first().locator("label").allTextContents();
  await openIn(page, "/", "light");
  await openDialog(page);
  expect(await labels()).toEqual(["Match the editor (light)", "Light", "Dark"]);
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "slate-dark"));
  await reloadApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "slate");
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  expect(await labels()).toEqual(["Match the editor (dark)", "Light", "Dark"]);
  await setOptions(page, "light", true, true);
  expect(off(decodeRgba(await previewPng(page)).at(10, 10), "#fdfdff"), "Slate's light ground").toBeLessThanOrEqual(2);
  await setOptions(page, "match", true, true);
  await page.keyboard.press("Escape");

  // Slate Light matched: the production build serves one of its tokens in three-digit form (#rgb).
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "slate-light"));
  await reloadApp(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name");
  expect(off(decodeRgba(await previewPng(page)).at(10, 10), "#fdfdff"), "Slate Light matched").toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");

  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "high-contrast"));
  await reloadApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "palette");
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  expect(await labels()).toEqual(["Match the editor (High contrast)", "CodeEditor Deep Field Light", "CodeEditor Deep Field Dark"]);
  await setOptions(page, "match", true, true);
  expect(off(decodeRgba(await previewPng(page)).at(10, 10), (await tokens(page)).bg), "Match: this page's ground").toBeLessThanOrEqual(2);
  await setOptions(page, "light", true, true);
  expect(off(decodeRgba(await previewPng(page)).at(10, 10), "#f8fbf9"), "Deep Field Light's ground").toBeLessThanOrEqual(2);
  await setOptions(page, "match", true, true);
  await page.keyboard.press("Escape");

  // Theme from this tab: page B picks Deep Field Dark; page A's Match image keeps page A's own ground.
  const b = await context.newPage();
  await openApp(b);
  await b.locator("#settings-button").click();
  const settings = b.getByRole("dialog", { name: /Settings/ });
  await settings.locator('input[name=theme][value="deep-field-dark"]').check();
  await expect(b.locator("html")).toHaveAttribute("data-theme-id", "deep-field-dark");
  await page.bringToFront();
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name");
  const aGround = (await tokens(page)).bg;
  expect(off(decodeRgba(await previewPng(page)).at(10, 10), aGround), `page A's ground ${aGround}`).toBeLessThanOrEqual(2);
  await b.close();
});

test.describe("the dialog's chunk fails to load", () => {
  // The aborted chunk requests are this test's own doing; they are the only failures tolerated, with the
  // console line Chromium logs for each (it names no URL).
  test.use(tolerating(/^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.(js|css) /, /^Failed to load resource: net::ERR_FAILED$/));
  test("a notice says the image tool couldn't open, and the next try loads it", async ({ page, browserName }) => {
    await openWith(page);
    await selectFixtureLines(page);
    await page.route(/\/assets\/[\w-]+\.(js|css)$/, (route) => route.abort("failed"));
    await page.locator("#file-actions").click();
    await page.getByRole("menuitem", { name: ITEM }).click();
    await expect(notice(page)).toHaveText(/^The image tool couldn't open: .+\.$/);
    await expect(page.locator(".statusbar .notice")).toHaveAttribute("data-tone", "error");
    await expect(dialogOf(page)).toHaveCount(0);
    await page.unroute(/\/assets\/[\w-]+\.(js|css)$/);
    // Playwright's WebKit keeps a failed dynamic import failed for the whole context (lessons, 2026-10-21).
    test.skip(browserName === "webkit", "WebKit keeps the failed import: no second try in this context");
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
  });
});

test("reduced motion: nothing in the dialog or the code menu animates or transitions", async ({ page }) => {
  await page.goto("/");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWith(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await selectFixtureLines(page);
  const moving = (sel: string) => page.evaluate((s) => document.getAnimations().filter((a) => {
    const target = (a.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.closest(s) && a.effect?.getTiming().duration !== 0;
  }).length, sel);
  // A hover over a menu item and a button would start their colour transitions; with reduced motion they last 0 ms.
  await page.mouse.click((await box(page.locator(".cm-line").nth(1))).x + 40, (await box(page.locator(".cm-line").nth(1))).y + 10, { button: "right" });
  await expect(page.locator("#code-menu")).toBeVisible();
  await page.locator("#code-menu [role=menuitem]").nth(2).hover();
  expect(await moving("#code-menu")).toBe(0);
  await page.keyboard.press("Escape");
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  await downloadButton(page).hover();
  expect(await moving("#snippet-dialog")).toBe(0);
});

test("21: plain text renders with no 'colours missing' note", async ({ page }) => {
  await openWith(page, [{ name: "notes.txt", text: "first line\nsecond line\n" }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of notes\.txt, lines 1 to 2\.\.\./);
  await previewReady(page);
  await expect(dialogOf(page).locator("#snippet-partial")).toHaveCount(0);
});

test("22: a slow re-render keeps the last good preview, says so after 400 ms, then swaps in one step", async ({ page }) => {
  await instrument(page, { realWrite: false, slowFillText: 1 });
  const text = Array.from({ length: 300 }, (_, i) => `value_${i} = ${i}`).join("\n") + "\n";
  await openWith(page, [{ name: "main.py", text }]);
  await selectAll(page);
  // A slowed render keeps the main thread busy between its yields, and Playwright's own queries then
  // wait their turn: the page records each state as it happens instead (a mutation observer). The
  // first render too, from before the dialog opens: under load its pending words came and went
  // between two queries (seen as data-preview-pending, then an empty status: 5 of 9 runs, 2026-10-22).
  await page.evaluate(() => {
    const w = window as unknown as { __first: { preview: string | null; pending: string | null; status: string }[]; __firstObserver: MutationObserver };
    w.__first = [];
    w.__firstObserver = new MutationObserver(() => {
      const d = document.querySelector("#snippet-dialog");
      if (d) w.__first.push({ preview: d.getAttribute("data-preview"), pending: d.getAttribute("data-preview-pending"), status: d.querySelector("#snippet-status")?.textContent ?? "" });
    });
    w.__firstObserver.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
  });
  await openFromFileMenu(page, /^Capture snippet of main\.py, lines 1 to 300\.\.\./);
  const dialog = dialogOf(page);
  const status = dialog.locator("#snippet-status");
  await previewReady(page, "match numbers name");
  const first = await page.evaluate(() => {
    const w = window as unknown as { __first: { preview: string | null; pending: string | null; status: string }[]; __firstObserver: MutationObserver };
    w.__firstObserver.disconnect();
    return w.__first;
  });
  const firstReady = first.findIndex((s) => s.preview === "ready");
  expect(firstReady, JSON.stringify(first)).toBeGreaterThan(0);
  expect(first.slice(0, firstReady).some((s) => s.preview === "rendering" && s.pending === "true" && s.status === "Making the preview..."), `the first render's words after 400 ms: ${JSON.stringify(first)}`).toBe(true);
  expect(first[firstReady], "ready, the status cleared in the same step").toMatchObject({ pending: null, status: "" });
  await expect(status).toHaveText("");
  await page.evaluate(() => {
    const w = window as unknown as { __old: Element; __states: { preview: string | null; pending: string | null; busy: string | null; marked: boolean; status: string }[] };
    const d = document.querySelector("#snippet-dialog")!;
    const canvas = () => d.querySelector("#snippet-frame canvas") as (HTMLCanvasElement & { __mark?: boolean }) | null;
    w.__old = canvas()!;
    canvas()!.__mark = true;
    w.__states = [];
    new MutationObserver(() =>
      w.__states.push({
        preview: d.getAttribute("data-preview"), pending: d.getAttribute("data-preview-pending"), busy: d.querySelector("#snippet-frame")!.getAttribute("aria-busy"),
        marked: canvas()?.__mark === true, status: d.querySelector("#snippet-status")!.textContent ?? "",
      }),
    ).observe(d, { attributes: true, childList: true, subtree: true, characterData: true });
  });
  await dialog.locator("input[value=light]").check();
  await previewReady(page, "light numbers name");
  const states = await page.evaluate(() => (window as unknown as { __states: { preview: string | null; pending: string | null; busy: string | null; marked: boolean; status: string }[] }).__states);
  const last = states.findIndex((s) => s.preview === "ready");
  expect(last, JSON.stringify(states)).toBeGreaterThan(0);
  const rendering = states.slice(0, last);
  expect(rendering.length, JSON.stringify(states)).toBeGreaterThan(0);
  for (const s of rendering) expect(s, `while it renders: ${JSON.stringify(states)}`).toMatchObject({ preview: "rendering", busy: "true", marked: true });
  expect(rendering.some((s) => s.pending === "true" && s.status === "Updating the preview..."), "the pending words after 400 ms").toBe(true);
  expect(states[last], "one step: the new canvas, ready, the status cleared").toMatchObject({ preview: "ready", busy: "false", marked: false, pending: null, status: "" });
  expect(await page.evaluate(() => (window as unknown as { __old: HTMLCanvasElement }).__old.width), "the old bitmap is freed").toBe(0);
  await expect(status).toHaveText("");
});

test("23: with Tab moving focus, Shift+Tab from the code reaches the head button", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await selectFixtureLines(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(mac ? "Shift+Alt+M" : "Control+M");
  await page.keyboard.press("Shift+Tab");
  const where = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className);
  info.annotations.push({ type: "23", description: `${info.project.name}: Shift+Tab from the code landed on ${where}` });
  await expect(page.locator("#snippet-button")).toBeFocused();
  await page.keyboard.press("Enter");
  await previewReady(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#snippet-button")).toBeFocused();
  await page.locator(".cm-content").focus();
  await page.keyboard.press(mac ? "Shift+Alt+M" : "Control+M");
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-content"), "Tab indents again").toBeFocused();
});

/** The head's salience proxies (gray and blur screenshots at device pixel ratio 1). */
async function headSalience(page: Page) {
  await page.mouse.move(4, 4);
  const ids = ["#run-button", "#snippet-button", "#error-jump"];
  const out: Record<string, Record<string, number>> = {};
  for (const [kind, filter] of [["gray", "grayscale(1)"], ["blur", "blur(6px)"]] as const) {
    const tag = await page.addStyleTag({ content: `html{filter:${filter}}` });
    const png = await page.screenshot({ animations: "disabled" });
    await tag.evaluate((el) => (el as Element).remove());
    out[kind] = {};
    for (const id of ids) if (await page.locator(id).isVisible()) out[kind][id] = salience(png, await box(page.locator(id)));
  }
  return out;
}

for (const scheme of ["light", "dark"] as const) {
  test(`24: the head button stays quieter than Run before a run, and than the error jump and Run after a failure (${scheme})`, async ({ page, browserName }, info) => {
    test.skip(browserName !== "chromium", "a luminance measure of screenshots: one engine is enough, and the run needs Python");
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await openWith(page, [
      { name: "main.py", text: 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n' },
      { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
    ]);
    const before = await headSalience(page);
    info.annotations.push({ type: `24 before (${scheme})`, description: JSON.stringify(before) });
    for (const kind of ["gray", "blur"]) expect(before[kind]["#run-button"], `${kind}: Run against the head button`).toBeGreaterThanOrEqual(2 * before[kind]["#snippet-button"]);
    const r = await run(page, { input: ["Ada"] });
    expect(r.status).toBe("error");
    await expect(page.locator("#error-jump")).toBeVisible();
    const after = await headSalience(page);
    info.annotations.push({ type: `24 after (${scheme})`, description: JSON.stringify(after) });
    for (const kind of ["gray", "blur"]) {
      expect(after[kind]["#error-jump"]).toBeGreaterThan(after[kind]["#snippet-button"]);
      expect(after[kind]["#run-button"]).toBeGreaterThan(after[kind]["#snippet-button"]);
    }
    if (scheme === "light") await hierarchyShots(page, test.info().outputPath("head-after"));
  });
}

// ---------------------------------------------------------------- 25 to 34: failures, close, keys, focus

test("25: failure paths: no PNG from toBlob, a blocked readback, no canvas context, and a readback blocked off the click", async ({ page, browserName }) => {
  // (a) toBlob calls back null: Copy (with and without an early write rejection) and Download say "this device".
  for (const writeReject of [undefined, "now"] as const) {
    const p = await page.context().newPage();
    await instrument(p, { realWrite: false, toBlobNull: true, writeReject });
    await openDialog(p);
    for (const action of ["copy", "download"] as const) {
      if (action === "copy" && !(await canCopy(p))) continue;
      const before = await captures(p);
      await (action === "copy" ? copyButton(p) : downloadButton(p)).click();
      await expect(p.locator("#app")).toHaveAttribute("data-captures", String(before + 1));
      await expect(p.locator("#app")).toHaveAttribute("data-capture", "failed");
      await expect(p.locator("#app")).toHaveAttribute("data-capture-reason", "device");
      await expect(dialogOf(p).locator("#snippet-status")).toHaveText("Couldn't make an image this big on this device. Close this and select fewer lines.");
    }
    await p.close();
  }
  // (b) getImageData gives white on Deep Field light: privacy, and no write at all.
  {
    const p = await page.context().newPage();
    await instrument(p, { realWrite: false, whiteReadback: "always" });
    await openIn(p, "/", "light");
    await openDialog(p);
    await clearCalls(p);
    await ((await canCopy(p)) ? copyButton(p) : downloadButton(p)).click();
    await expect(p.locator("#app")).toHaveAttribute("data-capture-reason", "privacy");
    await expect(dialogOf(p).locator("#snippet-status")).toHaveText("This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.");
    expect((await calls(p)).map((c) => c.name)).toEqual(["getImageData"]);
    await p.close();
  }
  // (c) getContext gives null: the frame says why, data-preview failed.
  {
    const p = await page.context().newPage();
    await instrument(p, { realWrite: false, getContextNull: true });
    await openWith(p);
    await selectFixtureLines(p);
    await openFromFileMenu(p, ITEM);
    await expect(dialogOf(p)).toHaveAttribute("data-preview", "failed", { timeout: 30_000 });
    await expect(dialogOf(p).locator(".snippet-frame-text")).toHaveText("Couldn't make an image this big on this device. Close this and select fewer lines.");
    await p.close();
  }
  // (d) Not ready: a slowed render, and a readback that is white only off the click; then a ready Copy works.
  {
    // 4 ms per drawn run: the slowed render outlasts input lag on a loaded machine (at 1 ms a full
    // Firefox run once saw the click land after it). The preview's state at the click is recorded
    // in the page, so a lost race fails as the precondition it is, not as a wrong result.
    await instrument(page, { realWrite: false, slowFillText: 4, whiteReadback: "async" });
    const text = Array.from({ length: 300 }, (_, i) => `value_${i} = ${i}`).join("\n") + "\n";
    await openWith(page, [{ name: "long.py", text }]);
    await selectAll(page);
    await openFromFileMenu(page, /^Capture snippet of long\.py, lines 1 to 300\.\.\./);
    await previewReady(page);
    test.skip(!(await canCopy(page)), `${browserName} offers no image copy`);
    await page.evaluate(() => {
      const w = window as unknown as { __atClick: string[] };
      w.__atClick = [];
      addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest(".snippet-actions button")) w.__atClick.push(document.querySelector("#snippet-dialog")?.getAttribute("data-preview") ?? "none");
      }, true);
    });
    const at = await box(copyButton(page));
    await dialogOf(page).locator("input[value=dark]").check();
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __atClick: string[] }).__atClick), { timeout: 60_000 }).toHaveLength(1);
    expect(await page.evaluate(() => (window as unknown as { __atClick: string[] }).__atClick), "precondition: the click landed while the re-render ran").toEqual(["rendering"]);
    await expect(app(page)).toHaveAttribute("data-capture-reason", "updating", { timeout: 60_000 });
    await expect(dialogOf(page).locator("#snippet-status")).toHaveText("The preview was still updating. Press Copy again.");
    await previewReady(page, "dark numbers name");
    await copyButton(page).click();
    await expect(app(page)).toHaveAttribute("data-capture", "copied");
  }
});

test("26 (a): a download still encoding when the dialog closes ends in the page's notice, and the file arrives", async ({ page }) => {
  await instrument(page, { realWrite: false, toBlobDelay: 1000 });
  await openDialog(page);
  const download = page.waitForEvent("download");
  await downloadButton(page).click();
  // Over 400 ms: the export says it is working.
  await expect(app(page)).toHaveAttribute("data-capture", "exporting");
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("Making the PNG...");
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText("Downloading main-py-lines-2-3.png.");
  expect((await download).suggestedFilename()).toBe("main-py-lines-2-3.png");
});

test("26 (b): a copy waiting for its render when the dialog closes still ends, in the page's notice", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await instrument(page, { realWrite: false, slowFillText: 3 });
  const text = Array.from({ length: 300 }, (_, i) => `value_${i} = ${i}`).join("\n") + "\n";
  await openWith(page, [{ name: "calc.py", text }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of calc\.py, lines 1 to 300\.\.\./);
  await previewReady(page);
  test.skip(!(await canCopy(page)), `${browserName} offers no image copy`);
  // What the dialog showed when it closed: the export's render must still have been running then.
  await page.evaluate(() => {
    const d = document.querySelector("#snippet-dialog")!;
    d.addEventListener("close", () => ((window as unknown as { __closedWhile: string | null }).__closedWhile = d.getAttribute("data-preview")), { capture: true });
  });
  // Points measured now: during the slowed render Playwright's queries wait behind it, while mouse input at
  // a known point reaches the page between its batches (in Firefox a key press did not).
  const at = await box(copyButton(page));
  const shut = await box(dialogOf(page).getByRole("button", { name: "Close" }));
  const before = await captures(page);
  await dialogOf(page).locator("input[value=dark]").check();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.click(shut.x + shut.width / 2, shut.y + shut.height / 2);
  const closedWhile = await page.evaluate(() => (window as unknown as { __closedWhile: string | null }).__closedWhile);
  // Playwright's Firefox delivers the second click only once the slowed render has ended (measured
  // 2026-10-21, with key presses too), so the case can't be driven there; it is never passed silently.
  test.skip(browserName === "firefox" && closedWhile !== "rendering", `firefox: the dialog closed only after the render (${closedWhile})`);
  expect(closedWhile, "closed while the export's render ran").toBe("rendering");
  const c = await calls(page);
  expect(c[0]?.name, `the not-ready path: the write first (${JSON.stringify(c)})`).toBe("write");
  await expect(app(page)).toHaveAttribute("data-captures", String(before + 1), { timeout: 30_000 });
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(notice(page)).toHaveText("Copied an image of calc.py, lines 1 to 300.");
});

for (const action of ["Download (.png)", "Copy image"] as const) {
  test(`26 (c): an export that settles just before the dialog closes still ends in the page's notice (${action})`, async ({ page, browserName }) => {
    await instrument(page, { realWrite: false });
    await openDialog(page);
    const button = dialogOf(page).getByRole("button", { name: action });
    test.skip(!(await button.count()), `${browserName} offers no ${action}`);
    // The dialog closes 10 ms after the PNG settles: after the result was handed to the open dialog's
    // status line (which speaks 50 ms later), before it spoke.
    await page.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, ...rest: unknown[]) {
        return toBlob.call(this, (b: Blob | null) => {
          cb(b);
          setTimeout(() => (document.querySelector("#snippet-dialog") as HTMLDialogElement | null)?.close(), 10);
        }, ...(rest as [string?, number?]));
      };
    });
    const before = await captures(page);
    const download = action === "Download (.png)" ? page.waitForEvent("download") : null;
    await button.click();
    await expect(app(page)).toHaveAttribute("data-captures", String(before + 1));
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(app(page)).toHaveAttribute("data-capture", action === "Copy image" ? "copied" : "downloaded");
    await expect(notice(page)).toHaveText(action === "Copy image" ? "Copied an image of main.py, lines 2 to 3." : "Downloading main-py-lines-2-3.png.");
    if (download) expect((await download).suggestedFilename()).toBe("main-py-lines-2-3.png");
  });
}

test.describe("28: Joined symbols (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one engine: the font-loading path is shared");
  test("the italic JetBrains Mono face is loaded before drawing", async ({ page }) => {
    // Every font load the page asks for, in order, with whether a glyph had been drawn on a canvas yet.
    await page.addInitScript(() => {
      const w = window as unknown as { __loads: { font: string; drawn: boolean }[]; __drawn: boolean };
      w.__loads = [];
      w.__drawn = false;
      const load = FontFaceSet.prototype.load;
      FontFaceSet.prototype.load = function (font: string, text?: string) {
        w.__loads.push({ font, drawn: w.__drawn });
        return load.call(this, font, text);
      };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>) {
        w.__drawn = true;
        return fillText.apply(this, args);
      };
    });
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("codeeditor:ligatures", "on"));
    // No comment in the file: the editor shows no italic code, so the image's own wait must ask for the face.
    await openWith(page, [{ name: "plain.py", text: "def add(a, b):\n    return a + b\n" }]);
    await selectAll(page);
    await openFromFileMenu(page, /^Capture snippet of plain\.py, lines 1 to 2\.\.\./);
    await previewReady(page);
    const loads = await page.evaluate(() => (window as unknown as { __loads: { font: string; drawn: boolean }[] }).__loads);
    expect(loads.filter((l) => /^italic 400 \d+(\.\d+)?px .*JetBrains Mono/.test(l.font) && !l.drawn), JSON.stringify(loads)).not.toHaveLength(0);
    const size = await page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontSize);
    expect(await page.evaluate((s) => document.fonts.check(`italic 400 ${s} 'JetBrains Mono'`), size)).toBe(true);
  });
});

test("29: double activation: one dialog from a double click or two quick clicks; the backdrop closes on one click that began outside", async ({ page, browserName }) => {
  await openWith(page);
  await selectFixtureLines(page);
  // (b) First opening: every chunk request after the click is 800 ms late; two clicks 200 ms apart.
  await page.route(/\/assets\/[\w-]+\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  const button = page.locator("#snippet-button");
  await button.click();
  await page.waitForTimeout(200);
  await button.click();
  await previewReady(page);
  await page.waitForTimeout(600);
  await expect(page.locator("dialog#snippet-dialog[open]")).toHaveCount(1);
  // A delayed request may still be in its handler: unroute() doesn't wait for it, and its later
  // route.continue() then throws "Route is already handled" (WebKit, 2026-10-22). This test sets no
  // other route, so unrouteAll can wait for running handlers (playwright.dev/docs/api/class-page#page-unroute-all).
  await page.unrouteAll({ behavior: "wait" });
  await page.keyboard.press("Escape");

  // (a) The chunk cached: a double click on the head button gives one dialog with focus on its primary action.
  await button.dblclick();
  await page.waitForTimeout(600);
  await expect(page.locator("dialog#snippet-dialog[open]")).toHaveCount(1);
  await expect((await canCopy(page)) ? copyButton(page) : downloadButton(page)).toBeFocused();
  await page.keyboard.press("Escape");

  // (c) A double click on the file menu item: one dialog.
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: ITEM }).dblclick();
  await page.waitForTimeout(600);
  await expect(page.locator("dialog#snippet-dialog[open]")).toHaveCount(1);

  // (c2) One press on the backdrop that the engine reports as the second click of a double click
  // (detail 2): the dialog stays open. With the guard removed, the double clicks above still passed in
  // Chromium (no backdrop click with detail 2 reached the dialog there), so this step proves it there.
  await page.mouse.move(5, 5);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await page.waitForTimeout(200);
  await expect(page.locator("dialog#snippet-dialog[open]"), "a second click on the backdrop leaves the dialog open").toHaveCount(1);

  // (d) A press on the frame released on the backdrop: the dialog stays open.
  const frame = await box(dialogOf(page).locator("#snippet-frame"));
  await page.mouse.move(frame.x + 20, frame.y + 20);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(page.locator("dialog#snippet-dialog[open]")).toHaveCount(1);

  // (e) One click on the backdrop closes it, and focus returns to More file actions.
  await page.mouse.click(5, 5);
  await expect(page.locator("dialog#snippet-dialog")).toHaveCount(0);
  await expect(page.locator("#file-actions")).toBeFocused();

  // (f) A double click on Settings: Settings stays open.
  await page.locator("#settings-button").dblclick();
  await page.waitForTimeout(600);
  await expect(page.getByRole("dialog", { name: /Settings/ })).toBeVisible();
  void browserName;
});

test("30: keys behind the modal do nothing; Ctrl+S keeps the browser's Save away; Enter on Copy still copies", async ({ page }) => {
  await instrument(page, { realWrite: false });
  await openDialog(page);
  await page.evaluate(() => {
    const w = window as unknown as { __saves: boolean[] };
    w.__saves = [];
    addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") w.__saves.push(e.defaultPrevented); });
  });
  const runs = await app(page).getAttribute("data-runs");
  const primary = (await canCopy(page)) ? copyButton(page) : downloadButton(page);
  await primary.focus();
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(300);
  await expect(page.locator("#run-button")).toHaveAttribute("data-running", "false");
  expect(await app(page).getAttribute("data-runs")).toBe(runs);
  await page.keyboard.press("Alt+W");
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  await expect(page.locator('.tabs [role=tab][title="main.py"]')).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await page.keyboard.press(`${MOD}+S`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saves: boolean[] }).__saves)).toEqual([true]);
  await expect(dialogOf(page)).toBeVisible();
  if (await canCopy(page)) {
    const before = await captures(page);
    await copyButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(app(page)).toHaveAttribute("data-captures", String(before + 1));
    await expect(app(page)).toHaveAttribute("data-capture", "copied");
  }
  await page.keyboard.press("Escape");

  // At 390 x 844, Ctrl+Shift+E behind the dialog doesn't open the drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".drawer-toggle").click();
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  await page.keyboard.press(`${MOD}+Shift+E`);
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(app(page)).not.toHaveAttribute("data-drawer");
});

test("31: a held Enter exports once, and a held Enter on the file menu item opens the dialog and exports nothing", async ({ page }, info) => {
  await instrument(page, { realWrite: false });
  await openDialog(page);
  test.skip(!(await canCopy(page)), "no Copy here");
  await page.evaluate(() => {
    const w = window as unknown as { __repeats: boolean[] };
    w.__repeats = [];
    addEventListener("keydown", (e) => { if (e.key === "Enter") w.__repeats.push(e.repeat); }, true);
  });
  // One Copy first: the PNG is then kept, so a second export would be instant and never hide behind a busy one.
  await copyButton(page).click();
  await expect(app(page)).toHaveAttribute("data-capture", "copied");
  const before = await captures(page);
  await copyButton(page).focus();
  await page.keyboard.down("Enter");
  await page.waitForTimeout(100);
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  const repeats = await page.evaluate(() => (window as unknown as { __repeats: boolean[] }).__repeats);
  info.annotations.push({ type: "31 repeat", description: `${info.project.name}: ${JSON.stringify(repeats)}` });
  test.skip(repeats[1] !== true, `this engine sends the second keydown without repeat [U]: ${JSON.stringify(repeats)}`);
  await expect(app(page)).toHaveAttribute("data-captures", String(before + 1));
  await page.waitForTimeout(500);
  expect(await captures(page)).toBe(before + 1);
  await page.keyboard.press("Escape");

  // Held on the file menu item (the chunk is cached by now): the dialog opens, nothing is exported.
  const now = await captures(page);
  await page.locator("#file-actions").focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < 2; i++) {
    if (((await page.evaluate(() => document.activeElement?.querySelector(".menu-label")?.textContent)) ?? "").startsWith("Capture snippet")) break;
    await page.keyboard.press("c");
  }
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await previewReady(page);
  await page.waitForTimeout(300);
  expect(await captures(page)).toBe(now);
});

test("32: an option change clears the last result without a word; it stays clear when the new preview lands", async ({ page }) => {
  await instrument(page, { realWrite: false });
  await openDialog(page);
  test.skip(!(await canCopy(page)), "no Copy here");
  await copyButton(page).click();
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("Copied the image.");
  await dialogOf(page).locator("input[value=light]").check();
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("");
  await previewReady(page, "light numbers name");
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("");
});

test("33: the dialog is described by the preview's label, and by the gaps note when ranges are far apart", async ({ page }) => {
  await openDialog(page);
  await expect(page.getByRole("dialog", { name: TITLE })).toHaveAccessibleDescription(/^Preview of main\.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown\./);
  expect(DESCRIPTION).toBe("Preview of main.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown.");
  await page.keyboard.press("Escape");
  // Line 1, then line 5 added with a modifier-drag: lines 2 to 4 lie between them.
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("Shift+End");
  const l5 = await box(page.locator(".cm-line").nth(4));
  await page.keyboard.down(MOD);
  await page.mouse.move(l5.x + 8, l5.y + l5.height / 2);
  await page.mouse.down();
  await page.mouse.move(l5.x + 80, l5.y + l5.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(MOD);
  await expect(page.locator(".cm-selectionBackground")).toHaveCount(2);
  await openFromFileMenu(page, /^Capture snippet of main\.py, lines 1 to 5\.\.\./);
  await previewReady(page);
  await expect(dialogOf(page)).toHaveAccessibleDescription(/The image includes the lines between your selections\./);
});

test("34: when the head button is hidden by the time the dialog closes, focus goes to Files", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await selectFixtureLines(page);
  await page.locator("#snippet-button").click();
  await previewReady(page);
  // Every focus move after the close, in order: the first must be Files, never the hidden list's button.
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { focusLog: string[] }).focusLog = log;
    document.addEventListener("focusin", (e) => log.push((e.target as HTMLElement).getAttribute("aria-label") ?? (e.target as HTMLElement).tagName), true);
  });
  await page.setViewportSize({ width: 800, height: 900 });
  // At once: WebKit's media query lists still report the old width until the next frame (a full run, 2026-10-21).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { focusLog: string[] }).focusLog[0])).toBe("Files");
});

for (const size of [{ width: 683, height: 330 }]) {
  test(`the file menu fits a short window: ArrowDown reaches every item in view (${size.width} x ${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openWith(page);
    await page.locator(".drawer-toggle").click();
    await page.locator("#file-actions").click();
    const items = page.getByRole("menu", { name: "File actions" }).getByRole("menuitem");
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      await expect(items.nth(i)).toBeFocused();
      await expect(items.nth(i)).toBeInViewport();
      await page.keyboard.press("ArrowDown");
    }
  });
}

test.describe("the file menu fits a short coarse window (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates pointer: coarse in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });
  test("ArrowDown reaches every item of File actions, each in view (844 x 390 coarse)", async ({ page }) => {
    await openWith(page);
    await page.locator(".drawer-toggle").click();
    await page.locator("#file-actions").click();
    const items = page.getByRole("menu", { name: "File actions" }).getByRole("menuitem");
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      await expect(items.nth(i)).toBeFocused();
      await expect(items.nth(i)).toBeInViewport();
      await page.keyboard.press("ArrowDown");
    }
  });
});
