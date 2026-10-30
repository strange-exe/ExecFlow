// Capture snippet (.claude/design/snippet-image/final-v3.md sections 2 to 7, tests 9.2): the file
// menu item, the editor head's button, the dialog with its preview and options, Copy image and
// Download (.png). Production build; the fixture fails on any console error, page error or failed
// request. Waits use state attributes (#app data-capture, data-captures; #snippet-dialog
// data-preview, data-preview-options), never wording. The instrumentation of 9.2 (snippet-helpers.ts)
// lives in init scripts only.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { contrast, deltaE, lift, over, UI_MIXES } from "../src/theme/contrast";
import { audit } from "./audit";
import { expect, hierarchyShots, importFiles, openApp, openFromTree, openIn, openThemePicker, reloadApp, run, test, tolerating } from "./helpers";
import {
  CARD_AT, FIXTURE, MOD, box, calls, canCopy, captures, clearCalls, decodeRgba, dialogOf, downloadPng, hexRgb, inkOf, instrument, markOf, matOf, off,
  openFromFileMenu, openWith, pngInfo, previewPng, previewReady, salience, selectAll, selectFixtureLines, tokens, writtenPng,
} from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ITEM = /^Capture snippet of main\.py, lines 2 to 3\.\.\./;
const TITLE = "Capture snippet of lines 2 to 3";
const DESCRIPTION = `Preview of main.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown. Plain frame, medium background, "Made with ExecFlow" under the card.`;
/**
 * Default options: 822 x 357 at scale 2: round 1's card (694 x 229, final-v3 4.5's fixture row) in
 * round 2's medium background (32 CSS px, 64 bitmap px each side).
 */
const SIZES: Record<string, [number, number]> = { "numbers name": [822, 357], "numbers no-name": [822, 270], "no-numbers name": [772, 357], "no-numbers no-name": [772, 270] };
/** A pixel of the card's code ground in the default image (round 1's (10, 10) inside the card). */
const GROUND = CARD_AT + 10;
const CASE_B = Array.from({ length: 200 }, () => "x".repeat(100)).join("\n") + "\n";
/** Two lines of 40,000 characters wrap to 834 rows: 18,835 CSS px tall, over 16,384 at scale 1. */
const TOO_BIG = `${"x".repeat(40_000)}\n${"y".repeat(40_000)}\n`;

const app = (page: Page) => page.locator("#app");
/** The page's notice: in the sidebar's foot from 900 px, in the status bar below (layout.ts place()). */
const notice = (page: Page) => page.locator(".notice-host .notice-text");
/**
 * The drawn selection: the app's own layer (src/editor/selection-layer.ts). CodeMirror's layer is
 * still in the DOM with the same class, but hidden (highlight.ts), so a bare class counts double.
 */
const BANDS = ".ce-selection-layer .cm-selectionBackground";
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

type Look = { background?: "none" | "small" | "medium" | "large"; frame?: "plain" | "window"; scale?: 1 | 2 | 3 };

/** Sets the dialog's options (round 2's at their defaults unless given) and waits for the preview to show them. */
async function setOptions(page: Page, colors: "match" | "light" | "dark", numbers: boolean, name: boolean, look: Look = {}) {
  const d = dialogOf(page);
  const { background = "medium", frame = "plain", scale = 2 } = look;
  await d.locator(`input[name=snippet-colors][value=${colors}]`).check();
  await d.locator("#snippet-numbers").setChecked(numbers);
  await d.locator("#snippet-name").setChecked(name);
  await d.locator(`#snippet-background-${background}`).check();
  await d.locator(`#snippet-frame-${frame}`).check();
  await d.locator(`#snippet-scale-${scale}`).check();
  await previewReady(page, `${colors} ${numbers ? "numbers" : "no-numbers"} ${name ? "name" : "no-name"} ${scale}x ${background} ${frame}`);
}

/**
 * Test 9's layout walk: a look's inputs set in one task, then their change events in that same
 * task, so a step makes one finished render, not one per changed control (up to three, each about
 * 150 ms in WebKit, plus six Playwright round trips: audit 2026-10-28). The controls' own path
 * (check, setChecked) is setOptions', which the walk still takes for two of its steps.
 */
async function setLook(page: Page, colors: "match" | "light" | "dark", numbers: boolean, name: boolean, look: Look = {}) {
  const { background = "medium", frame = "plain", scale = 2 } = look;
  const wanted: [string, boolean][] = [
    [`input[name=snippet-colors][value=${colors}]`, true], ["#snippet-numbers", numbers], ["#snippet-name", name],
    [`#snippet-background-${background}`, true], [`#snippet-frame-${frame}`, true], [`#snippet-scale-${scale}`, true],
  ];
  await dialogOf(page).evaluate((d, list) => {
    const changed = list.map(([sel, on]) => [d.querySelector<HTMLInputElement>(sel)!, on] as const).filter(([el, on]) => el.checked !== on);
    for (const [el, on] of changed) el.checked = on;
    for (const [el] of changed) el.dispatchEvent(new Event("change", { bubbles: true }));
  }, wanted);
  await previewReady(page, `${colors} ${numbers ? "numbers" : "no-numbers"} ${name ? "name" : "no-name"} ${scale}x ${background} ${frame}`);
}

/**
 * The pixel map of 9.2 on the default image (bitmap coordinates at scale 2): round 1's map moved
 * into the card (CARD_AT px from each side), the background around it, and the card's rounded
 * corners showing the background.
 */
function pixelMap(png: Buffer, t: Record<string, string>) {
  const px = decodeRgba(png);
  const c = CARD_AT;
  const mat = matOf(t);
  for (const [x, y] of [[0, 0], [10, 10], [821, 356], [c - 1, 200], [c + 694, 200], [400, c - 1], [400, c + 229]]) {
    expect(off(px.at(x, y), mat), `background at ${x}, ${y}`).toBeLessThanOrEqual(2);
    expect(px.at(x, y)[3], "opaque").toBe(255);
  }
  // The card's corner pixel is outside its 16 px rounded corner: the background shows there.
  expect(off(px.at(c, c), mat), "the rounded corner shows the background").toBeLessThanOrEqual(2);
  expect(off(px.at(c + 10, c + 10), t.bg), "ground").toBeLessThanOrEqual(2);
  for (const [x, y] of [[347, 0], [347, 228], [0, 114], [693, 114], [0, 20], [693, 208]]) expect(off(px.at(c + x, c + y), t.divider), `edge at ${x}, ${y}`).toBeLessThanOrEqual(2);
  const nameInk = inkOf(px, { x0: c + 34, x1: c + 150, y0: c + 26, y1: c + 71 }, t.bg);
  expect(nameInk && off(hexRgb(nameInk), t["text-secondary"]), `file name ${nameInk}`).toBeLessThanOrEqual(8);
  for (const y of [87, 88]) expect(off(px.at(c + 300, c + y), t.border), `rule row ${y}`).toBeLessThanOrEqual(2);
  expect(off(px.at(c + 20, c + 87), t.bg), "the rule starts at the padding").toBeLessThanOrEqual(2);
  const keyword = inkOf(px, { x0: c + 84, x1: c + 138, y0: c + 113, y1: c + 158 }, t.bg);
  expect(keyword && off(hexRgb(keyword), t["syn-keyword"]), `def ${keyword}`).toBeLessThanOrEqual(8);
  const number = inkOf(px, { x0: c + 34, x1: c + 52, y0: c + 113, y1: c + 158 }, t.bg);
  expect(number && off(hexRgb(number), t["gutter-text"]), `line number ${number}`).toBeLessThanOrEqual(8);
}

/** The default image's size, derived in the page from the code font's measured 0 and its size (the 4.1 constants). */
const derivedSize = (page: Page) =>
  page.locator(".cm-content").evaluate((el) => {
    const s = getComputedStyle(el);
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `400 ${s.fontSize} ${s.fontFamily}`;
    // On the 1/64 px grid, as the renderer does (onGrid: Linux WebKit measured 9.00006 at 15 px).
    const ch = Math.round(c.measureText("0").width * 64) / 64;
    const size = parseFloat(s.fontSize);
    const lineH = size * 1.5;
    const [E, P, V, G, HG, PAD] = [1, 16, 12, 16, 8, 32];
    const width = E + P + ch + G + Math.max(16 * ch, 32 * ch) + P + E + 2 * PAD;
    const height = E + V + lineH + HG + 1 + V + 2 * lineH + V + E + 2 * PAD;
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
    expect([info.width, info.height]).toEqual([822, 357]);
    const derived = await derivedSize(page);
    expect([derived.width, derived.height], `derived from ch ${derived.ch} at ${derived.size} px`).toEqual([822, 357]);
    await expect(dialog.locator("#snippet-size")).toHaveText("822 x 357 px");
    for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]) expect(info.chunks, `no ${chunk} chunk`).not.toContain(chunk);
    const t = await tokens(page);
    // ExecFlow Signal, the default (src/theme/palettes.ts SIGNAL).
    expect(t.bg).toBe(scheme === "light" ? "#ffffff" : "#15181d");
    expect(t["syn-keyword"]).toBe(scheme === "light" ? "#7a2fc2" : "#c99dff");
    expect(t["text-secondary"]).toBe(scheme === "light" ? "#444b56" : "#b9c0ca");
    expect(t.border).toBe(scheme === "light" ? "#d6dbe2" : "#30363f");
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
  expect([info.width, info.height]).toEqual([822, 357]);
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
    const png = await expectDownload(page, "main-py-lines-2-3.png", [822, 357]);
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

test("6: 300 lines fit at scale 2; case B steps down to 1.5 and says so, and its card's last row and column are opaque edge", async ({ page }) => {
  await openWith(page, [{ name: "x.py", text: "x\n".repeat(300) }, { name: "b.py", text: CASE_B }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of x\.py, lines 1 to 300\.\.\./);
  await previewReady(page);
  // Round 1's 730 x 13639 card in the medium background (64 bitmap px each side).
  await expectDownload(page, "x-py-lines-1-300.png", [858, 13767]);
  await expect(dialogOf(page).locator("#snippet-size")).toHaveText("858 x 13767 px");
  await expect(dialogOf(page).locator("#snippet-scale-note")).toHaveText("");
  await page.keyboard.press("Escape");
  await openFromTree(page, "b.py");
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
  await previewReady(page);
  // 1041 x 4633.5 CSS px: 2x is 2082 x 9267 = 19,293,894 px, over the area cap; 1.5x fits.
  const png = await expectDownload(page, "b-py-lines-1-200.png", [1562, 6951]);
  await expect(dialogOf(page).locator("#snippet-size")).toHaveText("1562 x 6951 px");
  await expect(dialogOf(page).locator("#snippet-scale-note")).toHaveText("2x is too big for this image, so it is 1.5x.");
  const px = decodeRgba(png);
  const t = await tokens(page);
  // The card sits 48 px (32 CSS px at 1.5x) inside the image; its rounded corners are 12 px.
  const [x0, y0, x1, y1] = [48, 48, px.width - 49, px.height - 49];
  for (let x = x0 + 13; x < x1 - 13; x++) {
    const p = px.at(x, y1);
    if (p[3] !== 255 || off(p, t.divider) > 2) throw new Error(`the card's last row at ${x}: ${p}`);
  }
  for (let y = y0 + 13; y < y1 - 13; y++) {
    const p = px.at(x1, y);
    if (p[3] !== 255 || off(p, t.divider) > 2) throw new Error(`the card's last column at ${y}: ${p}`);
  }
  for (const [x, y] of [[px.width - 1, px.height - 1], [x1 + 1, 300], [300, y1 + 1]]) expect(off(px.at(x, y), matOf(t)), `background at ${x}, ${y}`).toBeLessThanOrEqual(2);
});

test("7: the options change the image: every combination's size, Light in a dark theme, no name in the file name", async ({ page }) => {
  await openIn(page, "/", "dark");
  await openDialog(page);
  await setOptions(page, "light", false, false);
  const png = await expectDownload(page, "code-lines-2-3.png", [772, 270]);
  expect(off(decodeRgba(png).at(GROUND, GROUND), "#ffffff"), "Light's ground (Signal Light) in a dark theme").toBeLessThanOrEqual(2);
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
  expect(await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image"))).toBe(
    '{"colors":"light","numbers":false,"name":false,"scale":2,"background":true,"padding":"medium","frame":"plain","mark":true}',
  );
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

// At 1440 each file walks 23 option sets, and every one redraws the preview (b.py's is 200 lines),
// so each file is its own test, with its own time budget (both together passed 120 s under a full
// three-engine run, 2026-10-28). Most steps set their inputs in one task (setLook): b.py's test took
// 31 and 32 s in WebKit with one worker before that, 21 and 19 s after (lab, 2026-10-28).
const NOTHING_MOVES = [
  { vp: { width: 1440, height: 900 }, files: ["main.py"] },
  { vp: { width: 1440, height: 900 }, files: ["b.py"] },
  { vp: { width: 390, height: 844 }, files: ["main.py"] },
  { vp: { width: 320, height: 640 }, files: ["main.py"] },
];
for (const { vp, files } of NOTHING_MOVES) {
  test(`9: nothing moves: options at 1440, and Copy's and Download's results at ${vp.width} x ${vp.height}${vp.width === 1440 ? ` (${files[0]})` : ""}`, async ({ page }) => {
    await instrument(page, { realWrite: false });
    await page.setViewportSize(vp);
    await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "b.py", text: CASE_B }]);
    const parts = ["#snippet-frame", ".snippet-options fieldset:nth-of-type(1)", ".snippet-options fieldset:nth-of-type(2)", "#snippet-status", ".snippet-actions .btn >> nth=0", ".snippet-actions .btn >> nth=-1"];
    // Measured with the body (and, side by side, the options column) at its top: checking a lower
    // choice scrolls it into view (the test's own doing).
    const boxes = async () => {
      await dialogOf(page).locator(".dialog-body").evaluate((b) => (b.scrollTop = 0));
      await dialogOf(page).locator(".snippet-options").evaluate((o) => (o.scrollTop = 0));
      return Promise.all(parts.map(async (p) => box(dialogOf(page).locator(p))));
    };
    const near = (a: { x: number; y: number; width: number; height: number }[], b: typeof a, what: string) =>
      a.forEach((r, i) => {
        for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(r[k] - b[i][k]), `${what}: ${parts[i]} ${k}`).toBeLessThanOrEqual(0.5);
      });
    for (const file of files) {
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
              await setLook(page, colors, numbers, name);
              near(first, await boxes(), `${file} ${colors} ${numbers} ${name}`);
            }
        // Round 2: every background and frame (the layouts they make), and every scale. The first
        // look and the last step go through the controls themselves.
        for (const background of ["none", "small", "medium", "large"] as const)
          for (const frame of ["plain", "window"] as const) {
            const set = background === "none" && frame === "plain" ? setOptions : setLook;
            await set(page, "match", true, frame === "plain", { background, frame });
            near(first, await boxes(), `${file} ${background} ${frame}`);
          }
        for (const scale of [1, 3] as const) {
          await setLook(page, "match", false, false, { background: "large", scale });
          near(first, await boxes(), `${file} ${scale}x`);
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

    // Tab: close, Actual size (redesign 6: in the stage's top bar, above the frame), frame, the
    // Colours group, Line numbers, File name, the credit line, Highlight lines, the Background, Frame
    // and Scale groups (round 3's order), Download, Copy; never outside the dialog.
    await dialogOf(page).getByRole("button", { name: "Close" }).focus();
    const seen: string[] = [];
    for (let i = 0; i < 24; i++) {
      seen.push(await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "body";
        if (!a.closest("#snippet-dialog")) return `outside:${a.tagName}#${a.id}`;
        if (a.classList.contains("dialog-body")) return "dialog-body";
        if (a.classList.contains("snippet-options")) return "options-column";
        return a.id || a.getAttribute("aria-label") || a.textContent?.trim() || a.tagName;
      }));
      await page.keyboard.press("Tab");
    }
    expect(seen.filter((s) => s.startsWith("outside")), seen.join(" | ")).toEqual([]);
    // Between cycles the focus may rest on the page (body) or, in WebKit, on the dialog element itself.
    // Firefox also stops on a scroll container that overflows (the body, now that round 2's options make
    // it scroll at 1280 x 720; side by side, round 3's options column): the browser's own stop for
    // keyboard scrolling, recorded, not ours.
    for (const s of ["dialog-body", "options-column"]) if (seen.includes(s)) test.info().annotations.push({ type: "10 scroller", description: `${test.info().project.name}: the scrolling ${s} is a Tab stop` });
    const cycle = seen.filter((s) => s !== "body" && s !== "snippet-dialog" && s !== "dialog-body" && s !== "options-column");
    const order = [
      "Close", "snippet-actual", "snippet-frame", "snippet-colors-match", "snippet-numbers", "snippet-name", "snippet-mark", "snippet-highlight",
      "snippet-background-medium", "snippet-frame-plain", "snippet-scale-2", "Download (.png)", ...((await canCopy(page)) ? ["Copy image"] : []),
    ];
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
    await expect(page.locator(BANDS).first()).toBeVisible();

    // The Shortcuts dialog lists the code menu's keys.
    await page.locator("#shortcuts-button").click();
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    await expect(shortcuts.locator("dd", { hasText: "Menu for the selected code: Capture snippet (an image of the lines), Cut, Copy, Select all" })).toHaveCount(1);
    await expect(shortcuts.locator("dd", { hasText: "The browser's own menu for the selected code" })).toHaveCount(mac ? 0 : 1);
    await expect(shortcuts.locator("dd", { hasText: "More actions for the chosen file (in the list)" })).toHaveCount(1);
  });
}

// 0.7.0 (v07-shell.md): Capture is a ghost button in the top bar, right before Run (Run, the one
// fill, ends the bar); 30 px tall like the desktop tool buttons, wider for its word.
test("11: the head button: in the top bar right before Run, named, quiet, 30 px tall (the desktop tool height); it opens the dialog and gets focus back; none on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  const button = page.locator("#snippet-button");
  const stops = await page.locator(".topbar").evaluate((bar) =>
    [...bar.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => el.id),
  );
  expect(stops.at(-1)).toBe("run-button");
  expect(stops.at(-2)).toBe("snippet-button");
  await expect(button).toHaveAccessibleName("Capture snippet of the selected lines");
  await expect(button).toHaveAttribute("title", "Capture snippet of the selected lines");
  await expect(button).not.toHaveAttribute("aria-haspopup");
  // The visible word starts the name (WCAG 2.5.3).
  await expect(button).toHaveText("Capture");
  const b = await box(button);
  expect(b.height).toBe(30);
  expect(b.width).toBeGreaterThanOrEqual(30);
  const bar = await box(page.locator(".topbar"));
  expect(b.y).toBeGreaterThanOrEqual(bar.y - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
  const run = await box(page.locator("#run-button"));
  expect(run.x, "Run right of Capture").toBeGreaterThanOrEqual(b.x + b.width);
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
    // Capture is in the top bar from 0.7.0: 44 px tall there, at least as wide (it carries its word).
    const b = await box(page.locator("#snippet-button"));
    expect(b.height).toBe(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
    for (const bar of [".editor-head", ".topbar"]) {
      const r0 = await box(page.locator(bar));
      for (const el of await page.locator(`${bar} button:visible`).all()) {
        const r = await box(el);
        const id = `${bar} ${(await el.getAttribute("id")) ?? (await el.getAttribute("class"))}`;
        expect(r.y, id).toBeGreaterThanOrEqual(r0.y - 0.5);
        expect(r.y + r.height, id).toBeLessThanOrEqual(r0.y + r0.height + 0.5);
      }
    }
    await selectFixtureLines(page);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    for (const el of await dialogOf(page).locator(".snippet-actions .btn, .snippet-choice, .snippet-segment, #snippet-actual, .dialog-head .icon-btn").all()) expect((await box(el)).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    // On a touch screen the refusal names no right-click or Shift+F10.
    await page.locator(".cm-content").click();
    await page.locator("#snippet-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-capture-reason", "empty");
    await expect(notice(page)).toHaveText("Select the lines to capture first.");
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
    for (const el of await dialogOf(page).locator(".snippet-actions .btn, .snippet-choice, .snippet-segment, #snippet-actual, .dialog-head .icon-btn").all()) expect((await box(el)).height).toBeGreaterThanOrEqual(44);
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
  await expect(dialogOf(page)).toHaveAttribute("data-layout", "stack");
  await wholeInStage(page, "stacked");
  const body = await box(dialogOf(page).locator(".dialog-body"));
  const frame = await box(dialogOf(page).locator("#snippet-frame"));
  const row = await box(dialogOf(page).locator(".snippet-choice").first());
  expect(frame.y + frame.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
  expect(row.y + row.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
  // A wheel over the body, outside the frame, scrolls the body until File name shows (in small steps:
  // round 2's options make the body long enough that one big step passes it).
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  const label = dialogOf(page).locator("label[for=snippet-name]");
  for (let i = 0; i < 20; i++) {
    const l = await box(label);
    const b = await box(dialogOf(page).locator(".dialog-body"));
    if (l.y + l.height <= b.y + b.height - 0.5) break;
    await page.mouse.wheel(0, 40);
    await expect.poll(async () => (await box(label)).y, "the wheel scrolls the body").toBeLessThan(l.y);
  }
  await expect(label).toBeInViewport();
  // The wheel's scroll can still be moving when the label first shows (Firefox, a full run: 0.75 px short), so wait for it to be whole.
  await expect
    .poll(async () => {
      const label = await box(dialogOf(page).locator("label[for=snippet-name]"));
      const after = await box(dialogOf(page).locator(".dialog-body"));
      return label.y + label.height - (after.y + after.height);
    })
    .toBeLessThanOrEqual(0.5);
}

/**
 * Side by side (round 3, 900 px wide and taller than compact): the stage and Download in view, the
 * whole image in the stage, the body itself never scrolls; the options column is the one scroller
 * when it overflows, and a wheel over it reaches its last group.
 */
async function sideMode(page: Page) {
  const dialog = dialogOf(page);
  await expect(dialog).not.toHaveAttribute("data-compact");
  await expect(dialog).toHaveAttribute("data-layout", "side");
  await wholeInStage(page, "side");
  await expect(dialog.locator("#snippet-frame")).toBeInViewport({ ratio: 1 });
  await expect(downloadButton(page)).toBeInViewport({ ratio: 1 });
  const where = await dialog.evaluate((d) => {
    const r = (sel: string) => {
      const el = d.querySelector(sel) as HTMLElement;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), scrollTop: el.scrollTop, scroll: el.scrollHeight, client: el.clientHeight };
    };
    return { body: r(".dialog-body"), options: r(".snippet-options"), choice: r(".snippet-choice"), active: document.activeElement?.id || document.activeElement?.textContent };
  });
  await expect(dialog.locator(".snippet-choice").first(), JSON.stringify(where)).toBeInViewport({ ratio: 1 });
  const body = await dialog.locator(".dialog-body").evaluate((b) => b.scrollHeight - b.clientHeight);
  expect(body, "the body never scrolls side by side").toBeLessThanOrEqual(1);
  const list = await scrollers(page);
  expect(list.filter((s) => s !== "snippet-options"), `scrollers: ${list.join(", ")}`).toEqual([]);
  const last = dialog.locator("#snippet-scale-3").locator("..");
  if (list.includes("snippet-options")) {
    const row = await box(dialog.locator(".snippet-choice").first());
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    for (let i = 0; i < 40; i++) {
      const l = await box(last);
      const col = await box(dialog.locator(".snippet-options"));
      if (l.y + l.height <= col.y + col.height - 0.5) break;
      await page.mouse.wheel(0, 40);
      await expect.poll(async () => (await box(last)).y, "the wheel scrolls the options column").toBeLessThan(l.y);
    }
  }
  await expect(last).toBeInViewport({ ratio: 1 });
}

// 1093 x 460: 1366 x 768 at 125% with more browser toolbars. Round 3: 900 px and wider is side by
// side; 600 x 900 keeps the stacked layout (preview on top, the body the one scroller).
for (const vp of [{ width: 1440, height: 900 }, { width: 1093, height: 504 }, { width: 1093, height: 460 }, { width: 600, height: 900 }]) {
  const side = vp.width >= 900;
  test(`14: ${side ? "side by side" : "stacked"} at ${vp.width} x ${vp.height}: the preview whole, the first choice in view, ${side ? "the options column" : "the body"} scrolls to the rest`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "b.py", text: CASE_B }]);
    await selectFixtureLines(page);
    if (!side) await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await (side ? sideMode(page) : normalMode(page));
    await page.keyboard.press("Escape");
    await openFromTree(page, "b.py");
    await selectAll(page);
    if (!side) await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
    await previewReady(page);
    await (side ? sideMode(page) : normalMode(page));
  });
}

test.describe("14 and 15: coarse pointer sizes (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates pointer: coarse in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1280, height: 800 } });
  test("1280 x 800 coarse is side by side; 844 x 390 coarse is compact", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await openWith(page);
    await selectFixtureLines(page);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    await sideMode(page);
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
  await expect(dialogOf(page), "compact is always stacked, at any width").toHaveAttribute("data-layout", "stack");
  // At open the preview frame, the dialog's top, has focus (the APG dialog pattern for content that
  // would scroll the start out of view): the title and the preview are in view, not the footer.
  await expect(dialogOf(page).locator("#snippet-frame")).toBeFocused();
  // (WebKit then scrolls the dialog by a few px on its own, measured 3 at 455 x 213; the title stays whole.)
  await expect(dialogOf(page).locator(".dialog-title"), "the title is in view at open").toBeInViewport({ ratio: 1 });
  const frameTop = await dialogOf(page).locator("#snippet-frame").evaluate((f) => f.getBoundingClientRect().top - f.closest("dialog")!.getBoundingClientRect().top);
  expect(frameTop, "the focused frame's top edge is in view at open").toBeGreaterThanOrEqual(0);
  expect(frameTop).toBeLessThan(await dialogOf(page).evaluate((d) => d.clientHeight));
  const controls = [
    "Close", "#snippet-frame", "#snippet-actual", "#snippet-colors-match", "#snippet-numbers", "#snippet-name", "#snippet-highlight", "#snippet-background-medium",
    "#snippet-frame-plain", "#snippet-scale-2", "Download (.png)", "Copy image",
  ];
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

// 1093 x 300: wide enough for side by side, too short for it; compact wins (round 3).
for (const vp of [{ width: 683, height: 330 }, { width: 455, height: 213 }, { width: 320, height: 256 }, { width: 1093, height: 300 }]) {
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
        // Choices the body has scrolled wholly out of its box (they lie, clipped, under the footer) are no
        // targets there: audit.ts leaves them out (inView).
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

test("17: a tall preview is a named, focusable image, whole in Fit; at Actual size it scrolls by keyboard and shows ink at its end", async ({ page }) => {
  await openWith(page, [{ name: "b.py", text: CASE_B }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
  await previewReady(page);
  const frame = dialogOf(page).locator("#snippet-frame");
  await expect(frame).toHaveAttribute("role", "img");
  await expect(frame).toHaveAccessibleName(`Preview of b.py, lines 1 to 200, in the editor's colours; line numbers shown; file name shown. Plain frame, medium background, "Made with ExecFlow" under the card.`);
  // Round 3: Fit shows the whole image, so the stage has nothing to scroll; Actual size makes it scroll.
  await wholeInStage(page, "fit");
  await dialogOf(page).getByRole("button", { name: "Actual size" }).click();
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
  // By keyboard, so the ring is the :focus-visible one: from Actual size (redesign 6: in the stage's
  // top bar, right before the frame), Tab. (Shift+Tab from the Colours group stops on the options
  // rail in Firefox when it scrolls: the browser's own stop, test 10.)
  await dialogOf(page).locator("#snippet-actual").focus();
  await page.keyboard.press("Tab");
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
  // codeX = E + P + 1 digit + G = 42; the placeholder is column 6; row 1 starts at codeTop 56.5;
  // the card sits 32 CSS px inside the image (scale 2).
  let danger = 0;
  const c = CARD_AT;
  for (let y = c + 113; y <= c + 158; y++) for (let x = c + Math.floor((42 + 6 * 9) * 2); x <= c + Math.ceil((42 + 7 * 9) * 2); x++) if (off(px.at(x, y), t.danger) <= 8) danger++;
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

test("20: the Colours choices name what they give, in Signal, Slate and High contrast; Match is this tab's paint", async ({ page, context }) => {
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
  expect(off(decodeRgba(await previewPng(page)).at(GROUND, GROUND), "#fdfdff"), "Slate's light ground").toBeLessThanOrEqual(2);
  await setOptions(page, "match", true, true);
  await page.keyboard.press("Escape");

  // Slate Light matched: the production build serves one of its tokens in three-digit form (#rgb).
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "slate-light"));
  await reloadApp(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name");
  expect(off(decodeRgba(await previewPng(page)).at(GROUND, GROUND), "#fdfdff"), "Slate Light matched").toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");

  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "high-contrast"));
  await reloadApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "palette");
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  expect(await labels()).toEqual(["Match the editor (High contrast)", "ExecFlow Signal Light", "ExecFlow Signal Dark"]);
  await setOptions(page, "match", true, true);
  const hc = await tokens(page);
  const matched = decodeRgba(await previewPng(page));
  expect(off(matched.at(GROUND, GROUND), hc.bg), "Match: this page's ground").toBeLessThanOrEqual(2);
  expect(off(matched.at(10, 10), matOf(hc)), "Match: this page's background").toBeLessThanOrEqual(2);
  await setOptions(page, "light", true, true);
  const light = decodeRgba(await previewPng(page));
  expect(off(light.at(GROUND, GROUND), "#ffffff"), "Signal Light's ground").toBeLessThanOrEqual(2);
  expect(off(light.at(10, 10), matOf({ bg: "#ffffff", action: "#2f5bea" })), "Signal Light's background").toBeLessThanOrEqual(2);
  await setOptions(page, "match", true, true);
  await page.keyboard.press("Escape");

  // Theme from this tab: page B picks Deep Field Dark; page A's Match image keeps page A's own ground.
  const b = await context.newPage();
  await openApp(b);
  // The themes are in the theme picker (Settings > Appearance) since Workbench Pro S4.
  const picker = await openThemePicker(b);
  await picker.locator('input[name=theme][value="deep-field-dark"]').check();
  await expect(b.locator("html")).toHaveAttribute("data-theme-id", "deep-field-dark");
  await page.bringToFront();
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name");
  const aGround = (await tokens(page)).bg;
  expect(off(decodeRgba(await previewPng(page)).at(GROUND, GROUND), aGround), `page A's ground ${aGround}`).toBeLessThanOrEqual(2);
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
    // Seen where it now lives (the sidebar's foot at this width), and still the polite live region.
    await expect(notice(page)).toBeInViewport();
    await expect(page.locator(".notice-host .notice")).toHaveAttribute("role", "status");
    await expect(page.locator(".notice-host .notice")).toHaveAttribute("data-tone", "error");
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

test("23: with Tab moving focus, Shift+Tab from the code reaches the head button (past the open tab and Run)", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await selectFixtureLines(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press(mac ? "Shift+Alt+M" : "Control+M");
  // 0.7.0: Capture sits in the top bar before Run, so Shift+Tab from the code goes back through the
  // editor head (the open tab; the error jump is hidden before a run), then Run, then Capture: the
  // DOM order is the visual order (layout.ts).
  const path: string[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Shift+Tab");
    path.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || ""));
  }
  info.annotations.push({ type: "23", description: `${info.project.name}: Shift+Tab from the code went ${path.join(" < ")}` });
  expect(path).toEqual([await page.locator(".editor-head [role=tab][aria-selected=true]").getAttribute("id"), "run-button", "snippet-button"]);
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

// 25 is four failure paths, one test each: together they ran past one 120 s budget on Linux WebKit
// (CI 58d661f, attempts 1 and 3), and a split names the slow part if one ever is.
test("25 (a): toBlob gives no PNG: Copy (with and without an early write rejection) and Download say \"this device\"", async ({ page }) => {
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
});

test("25 (b): getImageData gives white on Deep Field light: privacy, and no write at all", async ({ page }) => {
  await instrument(page, { realWrite: false, whiteReadback: "always" });
  await openIn(page, "/", "light");
  await openDialog(page);
  await clearCalls(page);
  await ((await canCopy(page)) ? copyButton(page) : downloadButton(page)).click();
  await expect(page.locator("#app")).toHaveAttribute("data-capture-reason", "privacy");
  await expect(dialogOf(page).locator("#snippet-status")).toHaveText("This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.");
  expect((await calls(page)).map((c) => c.name)).toEqual(["getImageData"]);
});

test("25 (c): getContext gives null: the frame says why, data-preview failed", async ({ page }) => {
  await instrument(page, { realWrite: false, getContextNull: true });
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await expect(dialogOf(page)).toHaveAttribute("data-preview", "failed", { timeout: 30_000 });
  await expect(dialogOf(page).locator(".snippet-frame-text")).toHaveText("Couldn't make an image this big on this device. Close this and select fewer lines.");
});

test("25 (d): not ready: a slowed render, and a readback that is white only off the click; then a ready Copy works", async ({ page, browserName }) => {
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
  // The close event is a task of its own: wait for it, not for the click's return (Linux WebKit read
  // it before it came: CI, 2026-10-23).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __closedWhile?: string | null }).__closedWhile !== undefined), { timeout: 30_000 }).toBe(true);
  const closedWhile = await page.evaluate(() => (window as unknown as { __closedWhile: string | null }).__closedWhile);
  // Playwright's Firefox delivers the second click only once the slowed render has ended (measured
  // 2026-10-21, with key presses too), so the case can't be driven there; it is never passed silently.
  // Linux WebKit may do the same; Windows WebKit and Chromium drive it.
  test.skip(browserName !== "chromium" && closedWhile !== "rendering", `${browserName}: the dialog closed only after the render (${closedWhile})`);
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
  // The Shortcuts list's key (a lone ? opens nothing anywhere since 2026-10-24: WCAG 2.1.4).
  await page.keyboard.press(`${MOD}+/`);
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
  await expect(page.getByRole("dialog", { name: TITLE })).toHaveAccessibleDescription(
    /^Preview of main\.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown\. Plain frame, medium background, "Made with ExecFlow" under the card\./,
  );
  expect(DESCRIPTION).toBe(`Preview of main.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown. Plain frame, medium background, "Made with ExecFlow" under the card.`);
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
  await expect(page.locator(BANDS)).toHaveCount(2);
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
  try {
    await expect(page.getByRole("button", { name: "Files", exact: true })).toBeFocused();
  } catch (e) {
    // Say where focus went and what the page knew of its width (WebKit at 4 workers: 1 run in 20 at HEAD, 2026-10-22).
    const where = await page.evaluate(() => ({
      log: (window as unknown as { focusLog: string[] }).focusLog, active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      innerWidth, narrow: matchMedia("(max-width: 899px)").matches, dialog: document.querySelectorAll("#snippet-dialog").length,
    }));
    throw new Error(`${(e as Error).message}\nwhere focus went: ${JSON.stringify(where)}`);
  }
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

// ---------------------------------------------------------------- 35 to 41: round 2 (.claude/design/batch3/s.md)

test("35: the scale gives the exact PNG size at 1x, 2x and 3x; the size line says it; 3x steps down when it can't fit", async ({ page }) => {
  await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "b.py", text: CASE_B }]);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  // The sizes below need the code face itself (an advance of 0.6 em): a fallback font would draw a
  // different image, and the size check alone could hide it. Its measured advance is kept for CI.
  const face = await page.evaluate(() => {
    const f = [...document.fonts].find((x) => x.family.replace(/"/g, "") === "JetBrains Mono" && x.style === "normal" && x.weight === "400");
    const m = document.createElement("canvas").getContext("2d")!;
    m.font = '400 15px "JetBrains Mono"';
    return { status: f?.status ?? "missing", advance: m.measureText("0").width };
  });
  test.info().annotations.push({ type: "code face", description: JSON.stringify(face) });
  expect(face.status, "the code face is loaded when the preview is ready").toBe("loaded");
  expect(Math.abs(face.advance - 9), `the code face's advance at 15 px (${face.advance})`).toBeLessThan(1 / 128);
  const t = await tokens(page);
  // 411 x 178.5 CSS px (the card and the medium background): ceil(size x scale).
  for (const [scale, size] of [[1, [411, 179]], [3, [1233, 536]], [2, [822, 357]]] as const) {
    await dialogOf(page).locator(`#snippet-scale-${scale}`).check();
    await previewReady(page, `match numbers name ${scale}x medium plain`);
    await expect(dialogOf(page).locator("#snippet-size")).toHaveText(`${size[0]} x ${size[1]} px`);
    const png = await expectDownload(page, "main-py-lines-2-3.png", [...size]);
    const px = decodeRgba(png);
    const c = 32 * scale;
    expect(off(px.at(c + 6 * scale, c + 6 * scale), t.bg), `${scale}x: the card's ground`).toBeLessThanOrEqual(2);
    expect(off(px.at(c - 1, Math.round(size[1] / 2)), matOf(t)), `${scale}x: the background left of the card`).toBeLessThanOrEqual(2);
    // The edge is max(1, round(scale)) px: its last pixel is divider, the next one ground.
    const y = Math.round(size[1] / 2);
    expect(off(px.at(c + scale - 1, y), t.divider), `${scale}x: the edge's last pixel`).toBeLessThanOrEqual(2);
    expect(off(px.at(c + scale + 1, y), t.bg), `${scale}x: ground after the edge`).toBeLessThanOrEqual(2);
  }
  // The Scale group is described by the size (in the footer since round 3) and the step note under
  // it, so both are current in the change's own task (before the render lands): a screen reader
  // reading the newly checked choice hears the new size.
  const sizeAtChange = (id: string) =>
    dialogOf(page).locator(id).evaluate((input) => {
      (input as HTMLInputElement).click();
      return [document.getElementById("snippet-size")!.textContent, document.getElementById("snippet-scale-note")!.textContent];
    });
  expect(await sizeAtChange("#snippet-scale-1"), "the size at the change, before the render").toEqual(["411 x 179 px", ""]);
  await previewReady(page, "match numbers name 1x medium plain");
  await expect(dialogOf(page).locator("#snippet-size")).toHaveText("411 x 179 px");
  await expect(dialogOf(page).getByRole("group", { name: "Scale" })).toHaveAccessibleDescription("411 x 179 px");
  await page.keyboard.press("Escape");
  // Case B at 3x: 3x and 2x are over the area cap; 1.5x fits, and the note under Scale says so (at once too).
  await openFromTree(page, "b.py");
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of b\.py, lines 1 to 200\.\.\./);
  await previewReady(page);
  expect(await sizeAtChange("#snippet-scale-3"), "the stepped size at the change").toEqual(["1562 x 6951 px", "3x is too big for this image, so it is 1.5x."]);
  await previewReady(page, "match numbers name 3x medium plain");
  await expect(dialogOf(page).locator("#snippet-size")).toHaveText("1562 x 6951 px");
  await expect(dialogOf(page).locator("#snippet-scale-note")).toHaveText("3x is too big for this image, so it is 1.5x.");
  await expect(dialogOf(page).getByRole("group", { name: "Scale" })).toHaveAccessibleDescription("3x is too big for this image, so it is 1.5x. 1562 x 6951 px");
  await expectDownload(page, "b-py-lines-1-200.png", [1562, 6951]);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image")))!).scale).toBe(3);
});

test("36: the background: none is the card alone with transparent corners; small, medium and large pad it with a solid fill", async ({ page }) => {
  await openDialog(page);
  const t = await tokens(page);
  const mat = matOf(t);
  // Batch 4's "Made with ExecFlow" line (on by default): a 12 px line on an 18 px box. It takes a
  // bottom band of 32 CSS px (64 bitmap px), so medium and large keep their size and small grows at
  // its foot only (293 to 325); without a background it is the card's last row (229 to 265).
  for (const [background, size, pad] of [["none", [694, 265], 0], ["small", [758, 325], 32], ["large", [950, 485], 128], ["medium", [822, 357], 64]] as const) {
    await setOptions(page, "match", true, true, { background });
    const png = await previewPng(page);
    const info = pngInfo(png);
    expect([info.width, info.height], background).toEqual([...size]);
    const px = decodeRgba(png);
    const [w, h] = size;
    // The line's ink, right-aligned with the card (its padding without a background), reads at 4.5:1 on its ground.
    const ground = background === "none" ? t.bg : mat;
    // Bitmap px at 2x: the line is about 288 px wide ("Made with ExecFlow", 20 characters of 7.2 CSS px).
    // Round 3: the brand mark sits left of the words (test 45), so the words' ink is read from their own box.
    const right = background === "none" ? 694 - 2 * 17 : pad + 694;
    const rows = background === "none" ? { y0: 2 * (56.5 + 45) + 2, y1: h - 2 * 9 } : { y0: pad + 229, y1: h - 1 };
    const ink = inkOf(px, { x0: right - 290, x1: right, ...rows }, ground);
    const expected = lift(t["text-secondary"], [ground], 4.5);
    expect(ink && off(hexRgb(ink), expected), `${background}: the credit's ink ${ink} (${expected} on ${ground})`).toBeLessThanOrEqual(12);
    expect(contrast(expected, ground), `${background}: the credit on its ground`).toBeGreaterThanOrEqual(4.5);
    expect(inkOf(px, { x0: right - 600, x1: right - 330, ...rows }, ground), `${background}: right-aligned, nothing left of it`).toBeNull();
    if (background === "none") {
      // The corners outside the 16 px radius are fully transparent; the card's edge and ground are opaque.
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) expect(px.at(x, y)[3], `corner ${x}, ${y}`).toBe(0);
      expect(px.at(347, 0)[3]).toBe(255);
      expect(off(px.at(347, 0), t.divider), "top edge").toBeLessThanOrEqual(2);
      expect(off(px.at(10, 10), t.bg), "ground just inside the corner").toBeLessThanOrEqual(2);
      expect(px.at(10, 10)[3]).toBe(255);
    } else {
      // A solid fill (no gradient): the same colour at the four corners and the middle of each side.
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [Math.round(w / 2), 1], [1, Math.round(h / 2)], [pad - 1, Math.round(h / 2)]]) {
        expect(off(px.at(x, y), mat), `${background}: background at ${x}, ${y}`).toBeLessThanOrEqual(2);
        expect(px.at(x, y)[3]).toBe(255);
      }
      expect(off(px.at(pad, pad), mat), `${background}: the card's rounded corner shows the background`).toBeLessThanOrEqual(2);
      expect(off(px.at(pad + 10, pad + 10), t.bg), `${background}: the card's ground`).toBeLessThanOrEqual(2);
    }
  }
  // Background off keeps the padding chosen before: on again, it is medium.
  await setOptions(page, "match", true, true, { background: "none" });
  await expect(dialogOf(page).locator("#snippet-background-none")).toBeChecked();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image")))!)).toMatchObject({ background: false, padding: "medium" });
  await expect(dialogOf(page).locator("#snippet-frame")).toHaveAccessibleName(/file name shown\. Plain frame, no background, "Made with ExecFlow" at the card's foot\.$/);
});

test("37: the window frame: a title bar in the chrome's ground with the file name, a rule under it; no name keeps the bar", async ({ page }) => {
  await openDialog(page);
  const t = await tokens(page);
  const c = CARD_AT;
  for (const name of [true, false]) {
    await setOptions(page, "match", true, name, { frame: "window" });
    const png = await previewPng(page);
    // The card is 347 x 110.5: a bar of 8 + 22.5 + 8, the 1 px rule, 12, two rows, 12 and the edge.
    expect([pngInfo(png).width, pngInfo(png).height]).toEqual([822, 349]);
    const px = decodeRgba(png);
    expect(off(px.at(c + 10, c + 30), t.surface), "the bar's ground, under its rounded corner").toBeLessThanOrEqual(2);
    expect(off(px.at(c + 600, c + 70), t.surface), "the bar's right end").toBeLessThanOrEqual(2);
    for (const y of [79, 80]) expect(off(px.at(c + 300, c + y), t.divider), `the rule under the bar, row ${y}`).toBeLessThanOrEqual(2);
    expect(off(px.at(c + 10, c + 90), t.bg), "the code's ground under the rule").toBeLessThanOrEqual(2);
    const nameInk = inkOf(px, { x0: c + 34, x1: c + 150, y0: c + 18, y1: c + 63 }, t.surface);
    if (name) expect(nameInk && off(hexRgb(nameInk), t["text-secondary"]), `the name in the bar ${nameInk}`).toBeLessThanOrEqual(8);
    else expect(nameInk, "no name: the bar is empty").toBeNull();
    await expect(dialogOf(page).locator("#snippet-frame")).toHaveAccessibleName(new RegExp(`file name ${name ? "shown" : "hidden"}\\. Window frame, medium background, "Made with ExecFlow" under the card\\.$`));
  }
  const d = await downloadPng(page);
  expect(d.name, "with the name hidden, the file is not named after it either").toBe("code-lines-2-3.png");
});

test("37 (b): where a theme's chrome is its code ground (Nord), the window's bar takes the hovered-chrome ground, so Window still shows", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "nord"));
  await openDialog(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "nord");
  const t = await tokens(page);
  expect(t.surface, "Nord's chrome is its code ground (the case this covers)").toBe(t.bg);
  // contrast.ts UI_MIXES.hover over the surface: the ground of a hovered row in the app's chrome.
  const bar = over(t.surface, t.text, UI_MIXES.hover.pct / 100);
  expect(deltaE(bar, t.bg), "the bar is visibly not the code ground").toBeGreaterThanOrEqual(0.03);
  await setOptions(page, "match", true, true, { frame: "window" });
  const c = CARD_AT;
  const px = decodeRgba(await previewPng(page));
  expect(off(px.at(c + 600, c + 30), bar), "the bar's ground").toBeLessThanOrEqual(2);
  expect(off(px.at(c + 10, c + 90), t.bg), "the code's ground under the rule").toBeLessThanOrEqual(2);
  const nameInk = inkOf(px, { x0: c + 34, x1: c + 150, y0: c + 18, y1: c + 63 }, bar);
  expect(nameInk && off(hexRgb(nameInk), t["text-secondary"]), `the name in the bar ${nameInk}`).toBeLessThanOrEqual(8);
  // The export's readback checks the ground it drew there, so Download still works.
  const d = await downloadPng(page);
  expect(off(decodeRgba(d.bytes).at(c + 600, c + 30), bar), "the downloaded bar").toBeLessThanOrEqual(2);
  await expect(app(page)).toHaveAttribute("data-capture", "downloaded");
});

test("38: highlighted lines: a band behind the listed lines, nothing dimmed; the entry is checked when committed, never mid-typing", async ({ page }) => {
  const text = "def add(a, b):\n    total = a + b\n    return total\n\nprint(add(2, 3))\n";
  await openWith(page, [{ name: "calc.py", text }]);
  await selectAll(page);
  await openFromFileMenu(page, /^Capture snippet of calc\.py, lines 1 to 5\.\.\./);
  await previewReady(page);
  const t = await tokens(page);
  const mark = markOf(t);
  const field = dialogOf(page).locator("#snippet-highlight");
  const error = dialogOf(page).locator("#snippet-highlight-error");
  await expect(field).toHaveAccessibleName("Highlight lines");
  await expect(field).toHaveAccessibleDescription("Numbers or ranges from 1 to 5, separated by commas, such as 1-3.");
  // A valid entry applies as it is typed.
  await field.fill("2-3");
  await previewReady(page, "match numbers name 2x medium plain hl:2-3");
  const c = CARD_AT;
  // Rows start at codeTop 56.5 CSS px, 22.5 each (scale 2): row k from c + 113 + 45k.
  const rowY = (k: number) => c + 113 + 45 * k + 22;
  let px = decodeRgba(await previewPng(page));
  for (const [k, lit] of [[0, false], [1, true], [2, true], [3, false], [4, false]] as const) {
    expect(off(px.at(c + 5, rowY(k)), lit ? mark : t.bg), `row ${k + 1} ${lit ? "banded" : "plain"}, under its number`).toBeLessThanOrEqual(2);
    expect(off(px.at(c + 690, rowY(k)), lit ? mark : t.bg), `row ${k + 1} at the card's right`).toBeLessThanOrEqual(2);
  }
  // Nothing is dimmed: the code on and off the band keeps its own colours.
  const keyword = (k: number, ground: string) => inkOf(px, { x0: c + 84 + 72, x1: c + 84 + 72 + 108, y0: c + 113 + 45 * k, y1: c + 113 + 45 * k + 44 }, ground);
  const lit = keyword(2, mark);
  expect(lit && off(hexRgb(lit), t["syn-keyword"]), `"return" on the band ${lit}`).toBeLessThanOrEqual(8);
  const plainDef = inkOf(px, { x0: c + 84, x1: c + 138, y0: c + 113, y1: c + 157 }, t.bg);
  expect(plainDef && off(hexRgb(plainDef), t["syn-keyword"]), `"def" off the band ${plainDef}`).toBeLessThanOrEqual(8);
  await expect(dialogOf(page).locator("#snippet-frame")).toHaveAccessibleName(/\. Plain frame, medium background, highlighted: lines 2 to 3, "Made with ExecFlow" under the card\.$/);

  // Mid-typing an incomplete entry says nothing and keeps the band; committing (Tab) says what is wrong.
  await field.fill("2-");
  await expect(error).toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid");
  await field.fill("9");
  await expect(error).toHaveCount(0);
  await field.press("Tab");
  await expect(error).toHaveText("Line 9 isn't in the image: it shows lines 1 to 5.");
  // Round 3: Tab goes on to the Background group (Highlight lines now comes before it), and the
  // message under the field stays in view.
  await expect(dialogOf(page).locator("#snippet-background-medium")).toBeFocused();
  await expect(error).toBeInViewport({ ratio: 1 });
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription("Line 9 isn't in the image: it shows lines 1 to 5. Numbers or ranges from 1 to 5, separated by commas, such as 1-3.");
  // In error, no band: the preview is exactly what exports.
  await previewReady(page, "match numbers name 2x medium plain");
  px = decodeRgba(await previewPng(page));
  for (const k of [1, 2]) expect(off(px.at(c + 5, rowY(k)), t.bg), `row ${k + 1}: no band while the entry is in error`).toBeLessThanOrEqual(2);
  // While in error, typing another invalid entry changes neither the message nor its polite live
  // region (reported when committed, never mid-typing: s.md decision 10); Enter commits it.
  const live = dialogOf(page).locator(".snippet-highlight-live");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await live.evaluate((el) => {
    const w = window as unknown as { liveChanges: number };
    w.liveChanges = 0;
    new MutationObserver((records) => (w.liveChanges += records.length)).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await field.fill("99");
  await field.pressSequentially("9x");
  await field.fill("x, 2");
  await expect(error, "the committed message stays until the next commit").toHaveText("Line 9 isn't in the image: it shows lines 1 to 5.");
  expect(await page.evaluate(() => (window as unknown as { liveChanges: number }).liveChanges), "live-region changes while typing").toBe(0);
  await previewReady(page, "match numbers name 2x medium plain");
  // The body scrolled back to its top: Enter (focus stays in the field) brings the message into view too.
  await dialogOf(page).locator(".dialog-body").evaluate((b) => (b.scrollTop = 0));
  await field.press("Enter");
  await expect(error).toHaveText('"x" isn\'t a line number or a range such as 1-3.');
  await expect(field).toBeFocused();
  await expect(dialogOf(page)).toBeVisible();
  await expect(error).toBeInViewport({ ratio: 1 });
  // A valid entry clears the error at once.
  await field.fill("5, 1, 1-2");
  await expect(error).toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid");
  await previewReady(page, "match numbers name 2x medium plain hl:1-2,5");
  // Exported as shown.
  const d = await downloadPng(page);
  const out = decodeRgba(d.bytes);
  for (const [k, banded] of [[0, true], [1, true], [2, false], [4, true]] as const) expect(off(out.at(c + 5, rowY(k)), banded ? mark : t.bg), `exported row ${k + 1}`).toBeLessThanOrEqual(2);
  // Never remembered: the next opening starts empty.
  await page.keyboard.press("Escape");
  // (Only the highlight changed, so nothing was written; a stored value would hold no highlight either.)
  expect((await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image"))) ?? "").not.toContain("highlight");
  await openFromFileMenu(page, /^Capture snippet of calc\.py, lines 1 to 5\.\.\./);
  await previewReady(page, "match numbers name 2x medium plain");
  await expect(field).toHaveValue("");
});

test("39: a round-1 device's options migrate: its choices kept, the new ones at their defaults, then saved whole", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("codeeditor:snippet-image", '{"colors":"dark","numbers":false,"name":true}'));
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "dark no-numbers name 2x medium plain");
  for (const id of ["#snippet-colors-dark", "#snippet-name", "#snippet-background-medium", "#snippet-frame-plain", "#snippet-scale-2"]) await expect(dialogOf(page).locator(id)).toBeChecked();
  await expect(dialogOf(page).locator("#snippet-numbers")).not.toBeChecked();
  await dialogOf(page).locator("#snippet-frame-window").check();
  await previewReady(page, "dark no-numbers name 2x medium window");
  // Batch 4: the "Made with ExecFlow" line arrives on, as every new option does (its default).
  await expect(dialogOf(page).locator("#snippet-mark")).toBeChecked();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image")))!)).toEqual(
    { colors: "dark", numbers: false, name: true, scale: 2, background: true, padding: "medium", frame: "window", mark: true },
  );
});

test('39 (b): a round-2 device gains the "Made with ExecFlow" line, on; turned off it is remembered, drawn nowhere, and named in data-preview-options', async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("codeeditor:snippet-image", '{"colors":"match","numbers":true,"name":true,"scale":2,"background":true,"padding":"small","frame":"plain"}'));
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page, "match numbers name 2x small plain");
  await expect(dialogOf(page).getByRole("checkbox", { name: '"Made with ExecFlow" line' })).toBeChecked();
  await dialogOf(page).locator("#snippet-mark").uncheck();
  await previewReady(page, "match numbers name 2x small plain no-mark");
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("codeeditor:snippet-image")))!)).toMatchObject({ padding: "small", mark: false });
  await expect(dialogOf(page).locator("#snippet-frame")).toHaveAccessibleName(/file name shown\. Plain frame, small background\.$/);
});

for (const vp of [{ width: 1440, height: 900 }, { width: 600, height: 900 }, { width: 390, height: 844 }]) {
  test(`40: P1 at ${vp.width} x ${vp.height}: no empty band above the buttons, the status shares their row where it fits; the image is centred`, async ({ page }) => {
    await instrument(page, { realWrite: false });
    await page.setViewportSize(vp);
    await openWith(page);
    await selectFixtureLines(page);
    if (vp.width < 900) await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    const status = dialogOf(page).locator("#snippet-status");
    const actions = dialogOf(page).locator(".snippet-actions");
    const body = dialogOf(page).locator(".dialog-body");
    const download = await box(downloadButton(page));
    const footer = await box(actions);
    const bodyBefore = await box(body);
    const s = await box(status);
    // Redesign 6: from 900 px one row (the size, the status, the buttons); below it the full-screen
    // sheet stacks the status (none while empty), the size, then Download and Copy side by side.
    const wide = vp.width >= 900;
    if (wide) {
      // One row: the status beside the buttons, its two reserved lines no taller than the row needs.
      expect(s.y, "the status starts in the buttons' row").toBeGreaterThanOrEqual(footer.y);
      expect(s.y + s.height, "the status ends in the buttons' row").toBeGreaterThan(download.y);
      expect(s.x + s.width, "the status is left of the buttons").toBeLessThanOrEqual(download.x);
      if (vp.width === 1440) expect(footer.height, "rule, 12, a 40 px row, 24").toBeLessThanOrEqual(78);
    } else {
      expect(s.height, "the empty status takes no room on a narrow footer").toBe(0);
      // Redesign 6: 12, the PNG's size (16 and 8) above the buttons, the 44 px buttons, 12.
      expect(footer.height).toBeLessThanOrEqual(101);
      // Download and Copy side by side, each half the row, 44 px tall.
      if (await canCopy(page)) {
        const copy = await box(copyButton(page));
        expect(Math.abs(copy.y - download.y), "Download and Copy share a row").toBeLessThanOrEqual(0.5);
        expect(copy.x, "Copy right of Download").toBeGreaterThan(download.x + download.width - 0.5);
        expect(Math.abs(copy.width - download.width), "the two halves").toBeLessThanOrEqual(1);
        expect(copy.height).toBeGreaterThanOrEqual(44);
      }
      expect(download.height).toBeGreaterThanOrEqual(44);
      const sizeBox = await box(dialogOf(page).locator("#snippet-size"));
      expect(sizeBox.y + sizeBox.height, "the size sits just above Download").toBeLessThanOrEqual(download.y + 0.5);
      expect(sizeBox.x + sizeBox.width, "right-aligned with the buttons").toBeGreaterThan(download.x);
    }
    // The stage centres the image: as much room above it as below.
    const frame = await dialogOf(page).locator("#snippet-frame").evaluate((f) => {
      const r = f.getBoundingClientRect();
      const c = f.querySelector("canvas")!.getBoundingClientRect();
      return { above: c.top - r.top, below: r.bottom - c.bottom };
    });
    expect(Math.abs(frame.above - frame.below), JSON.stringify(frame)).toBeLessThanOrEqual(1);
    if (vp.width === 1440) {
      // The stage keeps the default look's height (medium background, plain frame), not the tallest
      // look's: with the 2-line fixture every option is in view with the preview, nothing scrolled.
      await body.evaluate((b) => (b.scrollTop = 0));
      await expect(dialogOf(page).locator("#snippet-frame canvas")).toBeInViewport({ ratio: 1 });
      await expect(dialogOf(page).locator("#snippet-highlight-hint")).toBeInViewport({ ratio: 1 });
      // A taller look (large background, window frame) stays whole in the stage instead of scrolling it
      // (round 3: side by side the stage is tall enough to show it at 1:1; tests 42 and 43 cover the shrink).
      await setOptions(page, "match", true, true, { background: "large", frame: "window" });
      await wholeInStage(page, "large window");
      await setOptions(page, "match", true, true);
    }
    // A result appears without moving the buttons or the body's bottom edge (test 9 covers every
    // width and result); at 600 it is two lines, which fit the two reserved lines exactly.
    await downloadPng(page);
    await expect(status).toHaveText("Downloading main-py-lines-2-3.png.");
    const after = await box(downloadButton(page));
    expect(Math.abs(after.y - download.y) + Math.abs(after.x - download.x)).toBeLessThanOrEqual(0.5);
    if (wide) {
      const footerAfter = await box(actions);
      const bodyAfter = await box(body);
      expect(Math.abs(footerAfter.height - footer.height), "the footer's height with a result").toBeLessThanOrEqual(0.5);
      expect(Math.abs(bodyAfter.height - bodyBefore.height), "the body's height with a result").toBeLessThanOrEqual(0.5);
    }
  });
}

test.describe("41: the highlight field and the new choices on a coarse pointer (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates pointer: coarse in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("44 px targets for the new choices and the field; the error is announced and drawn with its bar", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulated").toBe(true);
    await openWith(page);
    await selectFixtureLines(page);
    await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    for (const id of ["#snippet-background-none", "#snippet-frame-window", "#snippet-scale-3"]) expect((await box(dialogOf(page).locator(id).locator(".."))).height).toBeGreaterThanOrEqual(44);
    expect((await box(dialogOf(page).locator("#snippet-highlight"))).height).toBeGreaterThanOrEqual(44);
    await dialogOf(page).locator("#snippet-highlight").fill("1");
    await dialogOf(page).locator("#snippet-highlight").press("Enter");
    const error = dialogOf(page).locator("#snippet-highlight-error");
    await expect(error).toHaveText("Line 1 isn't in the image: it shows lines 2 to 3.");
    expect(await error.evaluate((e) => getComputedStyle(e).boxShadow)).toMatch(/inset/);
  });
});

// ---------------------------------------------------------------- 42 to 45: round 3 (.claude/tasks/snippet-dialog-v3.md)

/** The lead's audit file (.claude/verify/snippet-audit/dialog.audit.ts): 67 lines of C. */
const TREE_C = (() => {
  const lines = [
    "#include <stdio.h>", "#include <stdlib.h>", "", "struct node {", "    int data;", "    struct node *left, *right;", "};", "",
    "struct node *make(int value) {", "    struct node *n = malloc(sizeof *n);", "    n->data = value;", "    n->left = n->right = NULL;", "    return n;", "}", "",
  ];
  for (let i = 0; i < 48; i++) lines.push(`int step${i}(int x) { return x + ${i}; }`);
  lines.push("int main(void) {", '    printf("Number of leaf nodes: %d", step0(1));', "    return 0;", "}", "");
  return lines.join("\n");
})();
const TREE_ITEM = /^Capture snippet of tree\.c, lines 1 to 67\.\.\./;

/** The dialog's elements that scroll now (either way), by class or id. */
const scrollers = (page: Page) =>
  dialogOf(page).evaluate((d) =>
    [d, ...d.querySelectorAll<HTMLElement>("*")]
      .filter((el) => {
        const s = getComputedStyle(el);
        const y = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const x = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
        return x || y;
      })
      .map((el) => el.id || el.className),
  );

/** The preview canvas lies wholly inside the stage's box, and the stage doesn't scroll. */
async function wholeInStage(page: Page, what: string) {
  const g = await dialogOf(page).locator("#snippet-frame").evaluate((f) => {
    const r = f.getBoundingClientRect();
    const c = f.querySelector("canvas")!.getBoundingClientRect();
    return {
      stage: { top: r.top, left: r.left, right: r.right, bottom: r.bottom }, canvas: { top: c.top, left: c.left, right: c.right, bottom: c.bottom },
      scrolls: f.scrollHeight > f.clientHeight + 1 || f.scrollWidth > f.clientWidth + 1,
    };
  });
  const msg = `${what}: ${JSON.stringify(g)}`;
  expect(g.canvas.top, msg).toBeGreaterThanOrEqual(g.stage.top - 0.5);
  expect(g.canvas.left, msg).toBeGreaterThanOrEqual(g.stage.left - 0.5);
  expect(g.canvas.right, msg).toBeLessThanOrEqual(g.stage.right + 0.5);
  expect(g.canvas.bottom, msg).toBeLessThanOrEqual(g.stage.bottom + 0.5);
  expect(g.scrolls, msg).toBe(false);
}

for (const scheme of ["light", "dark"] as const) {
  test(`42: 1440 x 900, 67 lines (${scheme}): side by side, the whole snippet in the stage, one scroller at most, preview and Download in view; Actual size scrolls the stage and Fit undoes it`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await openWith(page, [{ name: "tree.c", text: TREE_C }]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await selectAll(page);
    await openFromFileMenu(page, TREE_ITEM);
    await previewReady(page);
    const dialog = dialogOf(page);
    await expect(dialog).toHaveAttribute("data-layout", "side");
    // Redesign 6: 1200 px wide at most, inside 24 px gutters; the options a 360 px rail to the right of the stage.
    const d = await box(dialog);
    expect(d.width).toBeGreaterThan(1000);
    expect(d.width).toBeLessThanOrEqual(1200 + 0.5);
    expect(d.x).toBeGreaterThanOrEqual(24 - 0.5);
    expect(d.y).toBeGreaterThanOrEqual(24 - 0.5);
    const stage = await box(dialog.locator("#snippet-frame"));
    const options = await box(dialog.locator(".snippet-options"));
    expect(options.x, "the options are right of the stage").toBeGreaterThanOrEqual(stage.x + stage.width - 0.5);
    expect(options.width).toBeGreaterThanOrEqual(320 - 0.5);
    expect(options.width).toBeLessThanOrEqual(360 + 0.5);
    await wholeInStage(page, "fit");
    expect((await scrollers(page)).length, `scrollers in Fit: ${(await scrollers(page)).join(", ")}`).toBeLessThanOrEqual(1);
    // Nothing was scrolled to get here: the preview and Download are both in view.
    await expect(dialog.locator("#snippet-frame canvas")).toBeInViewport({ ratio: 1 });
    await expect(downloadButton(page)).toBeInViewport({ ratio: 1 });
    // The size sits beside Download in the footer, and the Scale group is still described by it.
    await expect(dialog.locator(".snippet-actions #snippet-size")).toHaveText("1146 x 3282 px");
    await expect(dialog.getByRole("group", { name: "Scale" })).toHaveAccessibleDescription(/^1146 x 3282 px/);
    const size = await box(dialog.locator("#snippet-size"));
    const dl = await box(downloadButton(page));
    expect(size.x + size.width, "the size is left of Download, in its row").toBeLessThanOrEqual(dl.x + 0.5);
    expect(Math.abs(size.y + size.height / 2 - (dl.y + dl.height / 2))).toBeLessThanOrEqual(2);

    // Actual size: 1:1 in the stage, which scrolls; Fit undoes it.
    const toggle = dialog.getByRole("button", { name: "Actual size" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const actual = await dialog.locator("#snippet-frame").evaluate((f) => {
      const c = f.querySelector("canvas")!;
      return { shown: c.getBoundingClientRect().width, drawn: c.width / 2, scrolls: f.scrollHeight > f.clientHeight + 1 };
    });
    expect(actual.shown, JSON.stringify(actual)).toBeCloseTo(actual.drawn, 0);
    expect(actual.scrolls, JSON.stringify(actual)).toBe(true);
    // An option change keeps Actual size for this opening.
    await setOptions(page, "match", true, true, { frame: "window" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await wholeInStage(page, "fit again");
    expect((await scrollers(page)).length).toBeLessThanOrEqual(1);
    // Fit is the default at each opening.
    await toggle.click();
    await page.keyboard.press("Escape");
    await openFromFileMenu(page, TREE_ITEM);
    await previewReady(page);
    await expect(dialog.getByRole("button", { name: "Actual size" })).toHaveAttribute("aria-pressed", "false");
    await wholeInStage(page, "reopened");
    await page.keyboard.press("Escape");

    // A few lines: the image at 1:1 (never enlarged), centred, whole.
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+Home`);
    await expect(page.locator("#status-pos")).toHaveText("Ln 1, Col 1");
    // Four lines (line 3 is blank, and a blank last line is never captured).
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator("#status-pos")).toHaveText("Ln 5, Col 1");
    await openFromFileMenu(page, /^Capture snippet of tree\.c, lines 1 to 4\.\.\./);
    await previewReady(page);
    await wholeInStage(page, "4 lines");
    const small = await dialog.locator("#snippet-frame canvas").evaluate((c) => ({ shown: c.getBoundingClientRect().width, drawn: (c as HTMLCanvasElement).width / 2 }));
    expect(small.shown, JSON.stringify(small)).toBeCloseTo(small.drawn, 0);
  });
}

test("43: 390 x 844, 67 lines: stacked, the preview above the options at most 45% of the window, no sideways scroll, the body the one scroller", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, [{ name: "tree.c", text: TREE_C }]);
  await selectAll(page);
  await page.locator(".drawer-toggle").click();
  await openFromFileMenu(page, TREE_ITEM);
  await previewReady(page);
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAttribute("data-layout", "stack");
  await wholeInStage(page, "phone fit");
  const stage = await box(dialog.locator("#snippet-frame"));
  const first = await box(dialog.locator(".snippet-options fieldset").first());
  expect(stage.y + stage.height, "the preview is above the options").toBeLessThanOrEqual(first.y + 0.5);
  expect(stage.height, "at most 45% of the window's height").toBeLessThanOrEqual(0.45 * 844 + 1);
  expect(await page.evaluate(() => {
    const dlg = document.querySelector("#snippet-dialog")!;
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth && dlg.scrollWidth <= dlg.clientWidth;
  }), "no sideways scroll").toBe(true);
  expect(await scrollers(page)).toEqual(["dialog-body"]);
  // Actual size scrolls the stage (both ways here), and Fit brings the whole image back.
  const toggle = dialog.getByRole("button", { name: "Actual size" });
  await toggle.click();
  await expect.poll(async () => (await scrollers(page)).includes("snippet-frame")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "still no sideways page scroll").toBe(true);
  await toggle.click();
  await wholeInStage(page, "phone fit again");
});

/** The three segmented groups, as round 2 named them: legends, radio names and values. */
const SEGMENTS = [
  { legend: "Background", id: "background", items: [["none", "None (the card alone)"], ["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
  { legend: "Frame", id: "frame", items: [["plain", "Plain"], ["window", "Window"]] },
  { legend: "Scale", id: "scale", items: [["1", "1x"], ["2", "2x"], ["3", "3x"]] },
] as const;

for (const scheme of ["light", "dark"] as const) {
  test(`44: Background, Frame and Scale are segmented radio groups: names, arrows, a selected state that is not colour alone at 3:1, 24 px targets; the order (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await openDialog(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    const dialog = dialogOf(page);
    // The order: Colours, Show, Highlight lines, then Background, Frame, Scale.
    const order = await dialog.locator(".snippet-options").evaluate((o) =>
      [...o.children].map((c) => (c.querySelector(":scope > legend, :scope > label")?.textContent ?? "").trim()));
    expect(order).toEqual(["Colours", "Show", "Highlight lines", "Background", "Frame", "Scale"]);
    // Colours keeps its list: "Match the editor (light)" does not fit a segment.
    await expect(dialog.locator(".snippet-segments input[name=snippet-colors]")).toHaveCount(0);
    for (const g of SEGMENTS) {
      const group = dialog.getByRole("group", { name: g.legend });
      await expect(group).toBeVisible();
      await expect(group.locator(".snippet-segments")).toHaveCount(1);
      const radios = group.getByRole("radio");
      await expect(radios).toHaveCount(g.items.length);
      for (const [value, name] of g.items) {
        const radio = group.getByRole("radio", { name, exact: true });
        await expect(radio).toHaveAttribute("value", value);
        await expect(radio).toHaveAttribute("id", `snippet-${g.id}-${value}`);
        await expect(radio).toHaveAttribute("name", `snippet-${g.id}`);
      }
      // One row of segments, each a 24 px target or more.
      const boxes = await Promise.all(g.items.map(([value]) => box(dialog.locator(`#snippet-${g.id}-${value}`).locator(".."))));
      for (const b of boxes) {
        expect(b.height).toBeGreaterThanOrEqual(24);
        expect(b.width).toBeGreaterThanOrEqual(24);
        expect(Math.abs(b.y - boxes[0].y), `${g.legend}: one row`).toBeLessThanOrEqual(0.5);
      }
      // The selected segment: its 2 px ring at 3:1 or more against the neighbour's ground and its own, and a heavier label.
      const look = await group.evaluate((fs) => {
        const segs = [...fs.querySelectorAll<HTMLElement>(".snippet-segment")];
        const sel = segs.find((s) => s.querySelector("input")!.checked)!;
        const other = segs.find((s) => s !== sel)!;
        const css = (el: Element) => getComputedStyle(el);
        // A colour as the page paints it: a canvas fill read back (resolves color-mix, oklch and alpha over the dialog's ground).
        const paint = (color: string, ground: string) => {
          const c = document.createElement("canvas");
          c.width = c.height = 1;
          const x = c.getContext("2d", { willReadFrequently: true })!;
          x.fillStyle = ground;
          x.fillRect(0, 0, 1, 1);
          x.fillStyle = color;
          x.fillRect(0, 0, 1, 1);
          const [r, g2, b] = x.getImageData(0, 0, 1, 1).data;
          return `#${[r, g2, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        };
        const dialogBg = css(fs.closest("dialog")!).backgroundColor;
        const shadow = css(sel).boxShadow;
        const ring = /(rgba?\([^)]*\)|#[0-9a-f]+|oklch\([^)]*\)|color\([^)]*\))/i.exec(shadow)?.[1] ?? "";
        return {
          shadow, ring: paint(ring || "transparent", dialogBg),
          selGround: paint(css(sel).backgroundColor, dialogBg), otherGround: paint(css(other).backgroundColor, dialogBg),
          selWeight: Number(css(sel.querySelector("label")!).fontWeight), otherWeight: Number(css(other.querySelector("label")!).fontWeight),
        };
      });
      expect(look.shadow, `${g.legend}: a ring on the selected segment`).toMatch(/inset/);
      expect(contrast(look.ring, look.otherGround), `${g.legend}: ring ${look.ring} against the neighbour ${look.otherGround}`).toBeGreaterThanOrEqual(3);
      expect(contrast(look.ring, look.selGround), `${g.legend}: ring ${look.ring} against its own ground ${look.selGround}`).toBeGreaterThanOrEqual(3);
      expect(look.selWeight, `${g.legend}: the selected label is heavier`).toBeGreaterThan(look.otherWeight);
    }
    // Arrows change the value (radio semantics), and the preview follows.
    await dialog.locator("#snippet-background-medium").focus();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.locator("#snippet-background-large")).toBeChecked();
    await expect(dialog.locator("#snippet-background-large")).toBeFocused();
    await previewReady(page, "match numbers name 2x large plain");
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.locator("#snippet-background-medium")).toBeChecked();
    await dialog.locator("#snippet-frame-plain").focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator("#snippet-frame-window")).toBeChecked();
    await previewReady(page, "match numbers name 2x medium window");
    await dialog.locator("#snippet-scale-2").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(dialog.locator("#snippet-scale-1")).toBeChecked();
    // The window frame's card at 1x: 411 x 174.5 CSS px (test 37's 822 x 349 at 2x).
    await expect(dialog.locator("#snippet-size")).toHaveText("411 x 175 px");
    await previewReady(page, "match numbers name 1x medium window");
    // A press on a segment, anywhere on it (its corner too), checks it.
    const small = await box(dialog.locator("#snippet-background-small").locator(".."));
    await page.mouse.click(small.x + 4, small.y + small.height - 4);
    await expect(dialog.locator("#snippet-background-small")).toBeChecked();
    // The focused segment shows the focus ring (reached by Tab from Highlight lines, so it is keyboard focus in every engine).
    await dialog.locator("#snippet-highlight").focus();
    await page.keyboard.press("Tab");
    await expect(dialog.locator("#snippet-background-small")).toBeFocused();
    const ring = await dialog.locator("#snippet-background-small").evaluate((i) => {
      const seg = i.parentElement!;
      const s = getComputedStyle(seg);
      return { focusVisible: i.matches(":focus-visible"), outline: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring.focusVisible && ring.outline !== "none" && ring.width >= 2, JSON.stringify(ring)).toBe(true);
    // Each label fits inside its segment's padding, the bold chosen one too, and no segment's width
    // moves when the choice (and so the bold label) moves.
    const fit = (legend: string) =>
      dialog.getByRole("group", { name: legend }).evaluate((fs) =>
        [...fs.querySelectorAll<HTMLElement>(".snippet-segment > label")].map((label) => {
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => (n.parentElement?.closest(".visually-hidden") || !n.textContent?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
          });
          const range = document.createRange();
          range.selectNodeContents(walker.nextNode()!);
          const t = range.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          const s = getComputedStyle(label);
          const left = l.left + parseFloat(s.paddingLeft);
          const right = l.right - parseFloat(s.paddingRight);
          return { text: range.toString(), width: Math.round(l.width * 10) / 10, inside: t.left >= left - 0.5 && t.right <= right + 0.5, t: [t.left, t.right], box: [left, right] };
        }));
    for (const g of SEGMENTS) {
      let widths: number[] | null = null;
      for (const [value] of g.items) {
        await dialog.locator(`#snippet-${g.id}-${value}`).check();
        const segs = await fit(g.legend);
        for (const s of segs) expect(s.inside, `${g.legend} with ${value} chosen: ${JSON.stringify(s)}`).toBe(true);
        const w = segs.map((s) => s.width);
        if (widths) expect(w, `${g.legend}: the widths stay when ${value} is chosen`).toEqual(widths);
        widths = w;
      }
    }
  });
}

/** The brand mark's tile in the image (bitmap px at scale 2): the credit's text is measured in the page with the code font. */
async function markBox(page: Page, background: "none" | "small" | "medium" | "large") {
  const textWidth = await page.locator(".cm-content").evaluate((el) => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `400 12px ${getComputedStyle(el).fontFamily}`;
    return Math.round(c.measureText("Made with ExecFlow").width * 64) / 64;
  });
  // The fixture's card at 1x: 347 x 114.5; a 12 px credit on an 18 px line box (snippet-render.test.ts).
  const pad = { none: 0, small: 16, medium: 32, large: 64 }[background];
  const band = Math.max(pad, 18 + 14);
  const top = background === "none" ? 56.5 + 45 + 4 : pad + 114.5 + (band - 18) / 2;
  const right = background === "none" ? 347 - 17 : pad + 347;
  const size = 12;
  const x = right - textWidth - size / 3 - size;
  const y = top + (18 - size) / 2;
  return { x: x * 2, y: y * 2, size: size * 2 };
}

for (const scheme of ["light", "dark"] as const) {
  test(`45: the exported PNG carries the brand mark before "Made with ExecFlow": the tile's blue and the glyph's white, every background (${scheme})`, async ({ page }) => {
    await openIn(page, "/", scheme);
    await openDialog(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    const BLUE = "#2f5bea";
    for (const background of ["none", "small", "medium", "large"] as const) {
      await setOptions(page, "match", true, true, { background });
      const px = decodeRgba((await downloadPng(page)).bytes);
      const m = await markBox(page, background);
      const at = (u: number, v: number) => px.at(Math.round(m.x + u * m.size), Math.round(m.y + v * m.size));
      // The tile's blue above and below the glyph, and on both sides of it.
      for (const [u, v] of [[0.5, 0.16], [0.5, 0.84], [0.5, 0.5], [0.09, 0.5], [0.91, 0.5]] as const) {
        expect(off(at(u, v), BLUE), `${background}: blue at ${u}, ${v} of the tile (${at(u, v)})`).toBeLessThanOrEqual(8);
      }
      // The glyph's white: each chevron's arms hold white pixels.
      const count = (u0: number, u1: number, v0: number, v1: number, hex: string) => {
        let n = 0;
        for (let y = Math.round(m.y + v0 * m.size); y <= Math.round(m.y + v1 * m.size); y++)
          for (let x = Math.round(m.x + u0 * m.size); x <= Math.round(m.x + u1 * m.size); x++) if (off(px.at(x, y), hex) <= 8) n++;
        return n;
      };
      expect(count(0.15, 0.42, 0.25, 0.75, "#ffffff"), `${background}: the left chevron's white`).toBeGreaterThanOrEqual(8);
      expect(count(0.58, 0.85, 0.25, 0.75, "#ffffff"), `${background}: the right chevron's white`).toBeGreaterThanOrEqual(8);
      // Nothing blue left of the tile (the line stays right-aligned).
      expect(count(-1.5, -0.2, 0, 1, BLUE), `${background}: nothing of the mark left of its tile`).toBe(0);
    }
  });
}

// ---------------------------------------------------------------- 46: redesign 6 (.claude/design/redesign6/snippet/design.md)

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`46: redesign 6 at ${vp.width} x ${vp.height}: the stage panel and its bar, swatch chips, switches, segmented rows, the footer's order, the Esc hint`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openWith(page);
    await selectFixtureLines(page);
    const phone = vp.width < 900;
    if (phone) await page.locator(".drawer-toggle").click();
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    const dialog = dialogOf(page);
    await expect(dialog).toHaveAttribute("data-layout", phone ? "stack" : "side");

    // The stage: a sunken panel of its own ground holding the frame and its bar; the bar (Actual
    // size) above the frame side by side, under the image on phones.
    const panel = dialog.locator(".snippet-panel");
    await expect(panel.locator("#snippet-frame")).toHaveCount(1);
    await expect(panel.locator(".snippet-stagebar #snippet-actual")).toHaveCount(1);
    const frame = await box(dialog.locator("#snippet-frame"));
    const actual = await box(dialog.locator("#snippet-actual"));
    if (phone) expect(actual.y, "Actual size under the image").toBeGreaterThanOrEqual(frame.y + frame.height - 0.5);
    else expect(actual.y + actual.height, "Actual size above the image").toBeLessThanOrEqual(frame.y + 0.5);
    // The Tab order is the drawn order (WCAG 2.4.3): Actual size, then the frame side by side; the
    // frame, then Actual size under it on phones.
    const [first, second] = phone ? ["#snippet-frame", "#snippet-actual"] : ["#snippet-actual", "#snippet-frame"];
    await dialog.locator(first).focus();
    await page.keyboard.press("Tab");
    await expect(dialog.locator(second), "Tab goes on to what is drawn next").toBeFocused();
    const [stageGround, dialogGround] = await panel.evaluate((p) => [getComputedStyle(p).backgroundColor, getComputedStyle(p.closest("dialog")!).backgroundColor]);
    expect(stageGround, "the stage has a ground of its own").not.toBe(dialogGround);

    // The head: an Esc keycap hint, hidden from assistive technology (the button keeps its title); not on phones.
    const hint = dialog.locator(".snippet-esc");
    await expect(hint).toHaveAttribute("aria-hidden", "true");
    await expect(hint.locator(".keycap")).toHaveText("Esc");
    if (phone) await expect(hint).toBeHidden();
    else await expect(hint).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveAttribute("title", "Close (Esc)");

    // Colours: three chips, each a native radio over its whole chip, a swatch hidden from AT and its
    // name; the selected chip has the tick and the strong weight (never colour alone).
    const chips = dialog.locator(".snippet-chip");
    await expect(chips).toHaveCount(3);
    const chipState = () =>
      chips.evaluateAll((cs) =>
        cs.map((c) => ({
          tick: getComputedStyle(c.querySelector(".snippet-tick")!).display !== "none",
          weight: Number(getComputedStyle(c.querySelector("label")!).fontWeight),
          swatchHidden: c.querySelector(".snippet-swatch")?.getAttribute("aria-hidden"),
          card: getComputedStyle(c.querySelector(".snippet-mini")!).backgroundColor,
        })),
      );
    let state = await chipState();
    expect(state.map((s) => s.tick)).toEqual([true, false, false]);
    expect(state[0].weight).toBeGreaterThan(state[1].weight);
    expect(state.every((s) => s.swatchHidden === "true")).toBe(true);
    // Each swatch is a picture of its choice: Light's card and Dark's card differ.
    expect(state[1].card).not.toBe(state[2].card);
    for (let i = 0; i < 3; i++) {
      const c = await box(chips.nth(i));
      const r = await box(chips.nth(i).locator("input"));
      expect(Math.abs(r.width - c.width) + Math.abs(r.height - c.height), "the radio covers its chip").toBeLessThanOrEqual(1);
      expect(c.height).toBeGreaterThanOrEqual(44);
    }
    // A press on a chip's swatch chooses it.
    const swatch = await box(chips.nth(1).locator(".snippet-swatch"));
    await page.mouse.click(swatch.x + swatch.width / 2, swatch.y + swatch.height / 2);
    await expect(dialog.locator("#snippet-colors-light")).toBeChecked();
    await previewReady(page, "light numbers name");
    state = await chipState();
    expect(state.map((s) => s.tick)).toEqual([false, true, false]);

    // Show: switches over native checkboxes; the whole row is the target, the track hidden from AT.
    for (const id of ["snippet-numbers", "snippet-name", "snippet-mark"]) {
      const input = dialog.locator(`#${id}`);
      await expect(input).toHaveAttribute("type", "checkbox");
      const row = input.locator("..");
      await expect(row.locator(".snippet-track")).toHaveAttribute("aria-hidden", "true");
      const rb = await box(row);
      const ib = await box(input);
      expect(Math.abs(rb.width - ib.width) + Math.abs(rb.height - ib.height), `${id}: the checkbox covers its row`).toBeLessThanOrEqual(1);
      expect(rb.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
    }
    // A press on the track (the row's far end) turns the switch off; the knob moves.
    const knobAt = () => dialog.locator("#snippet-numbers").locator("..").locator(".snippet-track").evaluate((t) => getComputedStyle(t, "::after").transform);
    const on = await knobAt();
    const numbersRow = await box(dialog.locator("#snippet-numbers").locator(".."));
    await page.mouse.click(numbersRow.x + numbersRow.width - 8, numbersRow.y + numbersRow.height / 2);
    await expect(dialog.locator("#snippet-numbers")).not.toBeChecked();
    await previewReady(page, "light no-numbers name");
    // The knob slides for --dur: polled until it rests at the start.
    await expect.poll(knobAt, { message: "the knob's place shows the state" }).not.toBe(on);
    await expect.poll(knobAt).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

    // Background, Frame and Scale: the legend left of its track side by side, above it on phones.
    for (const name of ["Background", "Frame", "Scale"]) {
      const group = dialog.getByRole("group", { name });
      const legend = await box(group.locator("legend"));
      const track = await box(group.locator(".snippet-segments"));
      if (phone) expect(legend.y + legend.height, `${name}: legend above`).toBeLessThanOrEqual(track.y + 0.5);
      else {
        expect(legend.x + legend.width, `${name}: legend left`).toBeLessThanOrEqual(track.x + 0.5);
        expect(Math.abs(legend.y + legend.height / 2 - (track.y + track.height / 2)), `${name}: one row`).toBeLessThanOrEqual(2);
      }
    }

    // The rail: 360 px side by side.
    if (!phone) expect((await box(dialog.locator(".snippet-options"))).width).toBeCloseTo(360, 0);

    // The footer: the PNG's size (its tag hidden from AT), the status, then Download and the one filled Copy image.
    await expect(dialog.locator(".snippet-size-tag")).toHaveText("PNG");
    await expect(dialog.locator(".snippet-size-tag")).toHaveAttribute("aria-hidden", "true");
    await expect(dialog.locator("#snippet-size")).toHaveText(/^\d+ x \d+ px$/);
    const size = await box(dialog.locator(".snippet-size"));
    const download = await box(downloadButton(page));
    if (phone) expect(size.y + size.height, "the size above the buttons").toBeLessThanOrEqual(download.y + 0.5);
    else {
      const status = await box(dialog.locator("#snippet-status"));
      expect(size.x + size.width, "the size first").toBeLessThanOrEqual(status.x + 0.5);
      expect(status.x + status.width, "the status before the buttons").toBeLessThanOrEqual(download.x + 0.5);
    }
    if (await canCopy(page)) {
      const fills = await dialog.locator(".snippet-actions .btn").evaluateAll((bs) => bs.map((b) => getComputedStyle(b).backgroundColor));
      const action = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--action)";
        document.querySelector("dialog#snippet-dialog")!.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(fills.filter((f) => f === action), "one filled button").toHaveLength(1);
      expect(fills.at(-1), "Copy image is the filled one").toBe(action);
    }

    if (phone) {
      // The full-screen sheet.
      const d = await box(dialog);
      expect([d.x, d.y, d.width, d.height].map((v) => Math.round(v))).toEqual([0, 0, 390, 844]);
    }
    expect(await page.evaluate(() => {
      const dlg = document.querySelector("#snippet-dialog")!;
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth && dlg.scrollWidth <= dlg.clientWidth;
    }), "no sideways scroll").toBe(true);
  });
}

test("46 (b): a resize across 900 px moves Actual size to where it is drawn in the Tab order, and focus stays on it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await selectFixtureLines(page);
  await openFromFileMenu(page, ITEM);
  await previewReady(page);
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAttribute("data-layout", "side");
  const order = () => dialog.locator(".snippet-panel").evaluate((p) => [...p.querySelectorAll("#snippet-actual, #snippet-frame")].map((e) => e.id));
  expect(await order()).toEqual(["snippet-actual", "snippet-frame"]);
  await dialog.locator("#snippet-actual").focus();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(dialog).toHaveAttribute("data-layout", "stack");
  await expect.poll(order, { message: "stacked: the frame, then Actual size under it" }).toEqual(["snippet-frame", "snippet-actual"]);
  await expect(dialog.locator("#snippet-actual"), "focus stays on Actual size").toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog).toHaveAttribute("data-layout", "side");
  await expect.poll(order, { message: "side by side: Actual size, then the frame" }).toEqual(["snippet-actual", "snippet-frame"]);
  await expect(dialog.locator("#snippet-actual"), "focus stays on Actual size").toBeFocused();
});

// ---------------------------------------------------------------- 47: forced colours (Windows High Contrast)

test.describe("47: forced colours (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates forced colours in Chromium only");
  test("47: keyboard focus on a chosen segment or Colours chip looks different from the choice, and every swatch keeps an edge", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWith(page);
    await selectFixtureLines(page);
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "forced colours emulated").toBe(true);
    await openFromFileMenu(page, ITEM);
    await previewReady(page);
    const dialog = dialogOf(page);
    const outline = (sel: string) =>
      dialog.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineOffset}`;
      });
    const segOf = (id: string) => `.snippet-segment:has(> #${id})`;
    const swatchOf = (id: string) => `.snippet-chip:has(> #${id}) .snippet-swatch`;
    // Unfocused: the chosen segment and chip carry the selection outline; every swatch has an edge.
    await dialog.locator("#snippet-highlight").focus();
    const chosenSeg = await outline(segOf("snippet-background-medium"));
    const chosenSwatch = await outline(swatchOf("snippet-colors-match"));
    expect(chosenSeg).not.toMatch(/^none/);
    for (const id of ["snippet-colors-light", "snippet-colors-dark"]) {
      expect(await outline(swatchOf(id)), `${id}: an unchosen swatch keeps an edge`).not.toMatch(/^none/);
    }
    // Keyboard focus (Tab from Highlight lines reaches the chosen Background segment) changes the look.
    await page.keyboard.press("Tab");
    await expect(dialog.locator("#snippet-background-medium")).toBeFocused();
    expect(await outline(segOf("snippet-background-medium")), "focused segment differs from chosen").not.toBe(chosenSeg);
    // The chosen Frame segment, unfocused, still shows only the choice.
    expect(await outline(segOf("snippet-frame-plain"))).toBe(chosenSeg);
    // Colours: Shift+Tab from Line numbers reaches the chosen chip.
    await dialog.locator("#snippet-numbers").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("#snippet-colors-match")).toBeFocused();
    expect(await outline(swatchOf("snippet-colors-match")), "focused chip differs from chosen").not.toBe(chosenSwatch);
  });
});

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
