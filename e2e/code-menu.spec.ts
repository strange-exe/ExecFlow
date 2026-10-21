// The editor context menu (.claude/design/snippet-image/final-v3.md sections 2.3 and 9.5, C1 to
// C26): a right-click on selected code, or Shift+F10 / the Menu key with code selected, opens
// "Actions for the selected code" (Capture snippet of lines 2 to 3..., Cut, Copy, Select all);
// everywhere else, and with Shift held, the browser's menu stays. Waits use #app's data-code-menus
// and data-code-menu-results, never wording. A test-only init script records each contextmenu
// (read a task later, after every listener ran) and each copy event.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { audit } from "./audit";
import { expect, openApp, openFromTree, openIn, test } from "./helpers";
import { FIXTURE, MOD, box, openWith, selectFixtureLines } from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const LINES_2_3 = "def add(a, b):\n    return a + b\n";

interface MenuEvent { prevented: boolean; inMenu: boolean; pointerType: string; done: boolean }
interface CopyEvent { prevented: boolean; text: string | null; done: boolean }

test.beforeEach(async ({ context }) => {
  // On the context: a second page (the read-only tab of C18 and C19) records too.
  await context.addInitScript(() => {
    const w = window as unknown as { __menus: MenuEvent[]; __copies: CopyEvent[] };
    w.__menus = [];
    w.__copies = [];
    addEventListener("contextmenu", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const entry = { prevented: false, inMenu: !!target?.closest(".menu"), pointerType: (e as PointerEvent).pointerType ?? "", done: false };
      w.__menus.push(entry);
      setTimeout(() => Object.assign(entry, { prevented: e.defaultPrevented, done: true }));
    });
    addEventListener("copy", (e) => {
      const entry = { prevented: false, text: e.clipboardData?.getData("text/plain") ?? null, done: false };
      w.__copies.push(entry);
      setTimeout(() => Object.assign(entry, { prevented: e.defaultPrevented, done: true }));
    });
  });
});

const menus = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __menus: MenuEvent[] }).__menus.every((m) => m.done))).toBe(true);
  return page.evaluate(() => (window as unknown as { __menus: MenuEvent[] }).__menus);
};
const copies = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copies: CopyEvent[] }).__copies.every((c) => c.done))).toBe(true);
  return page.evaluate(() => (window as unknown as { __copies: CopyEvent[] }).__copies);
};
const clearRecords = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __menus: unknown[]; __copies: unknown[] };
  w.__menus.length = 0;
  w.__copies.length = 0;
});
const counter = async (page: Page, name: "codeMenus" | "codeMenuResults") => Number((await page.locator("#app").evaluate((el, n) => (el as HTMLElement).dataset[n], name)) ?? 0);
const isMacPage = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
const codeMenu = (page: Page) => page.locator("#code-menu");
const line = (page: Page, n: number) => page.locator(".cm-line").nth(n - 1);

/** A point inside line n's text, `col` characters in (the code font's 0 is 9 px at 15 px). */
async function pointIn(page: Page, n: number, col = 4) {
  const b = await box(line(page, n));
  const ch = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector(".cm-content")!);
    const c = document.createElement("canvas").getContext("2d")!;
    // Size and family only: a computed `font` with a line height is not a canvas font in every engine.
    c.font = `${s.fontSize} ${s.fontFamily}`;
    return c.measureText("0").width;
  });
  return { x: b.x + 6 + ch * col + ch / 2, y: b.y + b.height / 2 };
}

/**
 * Scrolls the code to `top` (or its end) once CodeMirror's own scroll to the head is done. The keys'
 * scroll waits for the editor's next measure (a frame later, or at once on a scroll event: view
 * 6.43.14 measure() and onScrollChanged), and undoes a write made before it: C8 read 49, line 3's
 * top, instead of the end (WebKit under load, 2026-10-21). Write, let a frame pass, read; again
 * until the write stays.
 */
async function scrollCode(page: Page, top: number | "bottom") {
  await expect
    .poll(() =>
      page.locator(".cm-scroller").evaluate(async (s, want) => {
        const target = Math.min(want === "bottom" ? s.scrollHeight : want, s.scrollHeight - s.clientHeight);
        s.scrollTop = target;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return Math.abs(s.scrollTop - target) <= 1;
      }, top),
    )
    .toBe(true);
}

async function rightClick(page: Page, at: { x: number; y: number }) {
  const before = await counter(page, "codeMenus");
  await page.mouse.click(at.x, at.y, { button: "right" });
  return before;
}

/** The DOM selection's text once focus is back in the code, the state's head (status bar), and the drawn layer on those lines. */
async function selectionIntact(page: Page, text = LINES_2_3, pos = "Ln 4, Col 1", lines = [2, 3]) {
  await expect(page.locator(".cm-content")).toBeFocused();
  const norm = (s: string) => s.replace(/\r/g, "").replace(/\n+/g, "\n").replace(/\n$/, "");
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "").then(norm)).toBe(norm(text));
  await expect(page.locator("#status-pos")).toHaveText(pos);
  for (const n of lines) {
    const l = await box(line(page, n));
    const covered = await page.locator(".cm-selectionBackground").evaluateAll(
      (els, y) => els.some((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.top <= y && r.bottom >= y;
      }),
      l.y + l.height / 2,
    );
    expect(covered, `the drawn selection covers line ${n}`).toBe(true);
  }
}

const labels = (page: Page) => codeMenu(page).locator("[role=menuitem] .menu-label").allTextContents();

async function fixture(page: Page) {
  await openWith(page);
  await selectFixtureLines(page);
  await clearRecords(page);
}

test("C1: a right-click inside the selection opens the code menu: its items, keycaps, hint and focus", async ({ page }) => {
  await fixture(page);
  const mac = await isMacPage(page);
  await rightClick(page, await pointIn(page, 2));
  const menu = codeMenu(page);
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menu", { name: "Actions for the selected code" })).toBeVisible();
  expect(await labels(page)).toEqual(["Capture snippet of lines 2 to 3...", "Cut", "Copy", "Select all"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("separator")).toHaveCount(1);
  const mod = mac ? "Cmd" : "Ctrl";
  expect(await menu.locator(".keycap").allTextContents()).toEqual([`${mod} X`, `${mod} C`, `${mod} A`]);
  await expect(menu.locator(".menu-hint")).toHaveText("Shift+right-click for the browser's menu");
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "app");
  expect((await menus(page)).map((m) => m.prevented)).toEqual([true]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await selectionIntact(page);
});

test("C2: with the editor unfocused, a right-click on the drawn selection keeps it and opens the menu", async ({ page }) => {
  await fixture(page);
  // Focus elsewhere, and the page's selection out of the code too (as after a click elsewhere): only
  // CodeMirror's own state still holds lines 2 to 3, drawn by its selection layer.
  await page.locator("#run-button").focus();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await expect(page.locator(".cm-selectionBackground").first()).toBeAttached();
  // The press guard cancels the right button's mousedown on the selection; this window listener runs
  // after every other one (CodeMirror cancels no right-button press). With only its focus() kept, the
  // rest of this test still passed in every engine.
  await page.evaluate(() => {
    const w = window as unknown as { __presses: boolean[] };
    w.__presses = [];
    addEventListener("mousedown", (e) => {
      if (e.button === 2) w.__presses.push(e.defaultPrevented);
    });
  });
  await rightClick(page, await pointIn(page, 3, 6));
  await expect(codeMenu(page)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __presses: boolean[] }).__presses), "the right button's mousedown was cancelled").toEqual([true]);
  await page.keyboard.press("Escape");
  await selectionIntact(page);
});

test("C3: outside the selection, with nothing selected, and on other gutter cells the browser's menu stays", async ({ page }) => {
  await fixture(page);
  // Line 5 lies outside the selection (line 4 is the blank line whose only position is the selection's inclusive end).
  let before = await rightClick(page, await pointIn(page, 5, 2));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "browser");
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).at(-1)?.prevented).toBe(false);

  // The lint column of line 2, and the fold marker of line 2 (a gutter cell of a selected line that is
  // not its number): not the code, not a line number.
  await selectFixtureLines(page);
  const lint = await box(page.locator(".cm-gutter-lint"));
  const l2 = await box(line(page, 2));
  before = await rightClick(page, { x: lint.x + lint.width / 2, y: l2.y + l2.height / 2 });
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "browser");
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).at(-1)?.prevented).toBe(false);
  await selectFixtureLines(page);
  const fold = await page.locator(".cm-foldGutter .cm-gutterElement").evaluateAll((els, y) => {
    const hit = els.map((e) => e.getBoundingClientRect()).find((r) => r.height > 0 && r.top <= y && r.bottom >= y);
    return hit ? { x: hit.left + hit.width / 2, y } : null;
  }, l2.y + l2.height / 2);
  expect(fold, "line 2 has a fold marker").not.toBeNull();
  before = await rightClick(page, fold!);
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "browser");
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).at(-1)?.prevented).toBe(false);

  // The line number "2" of a selected line: the code menu; "4" (no range covers it): the browser's.
  await selectFixtureLines(page);
  const number = (n: string) => page.locator(".cm-lineNumbers .cm-gutterElement", { hasText: new RegExp(`^${n}$`) });
  const two = await box(number("2"));
  await rightClick(page, { x: two.x + two.width / 2, y: two.y + two.height / 2 });
  await expect(codeMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  const four = await box(number("4"));
  before = await rightClick(page, { x: four.x + four.width / 2, y: four.y + four.height / 2 });
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).at(-1)?.prevented).toBe(false);

  // Nothing selected.
  await page.mouse.click((await pointIn(page, 2)).x, (await pointIn(page, 2)).y);
  before = await rightClick(page, await pointIn(page, 2));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "browser");
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).at(-1)?.prevented).toBe(false);
});

test("C4: several ranges: any selected range opens the menu, Capture spans them, Copy copies them all", async ({ page }, info) => {
  await openWith(page);
  // The caret in "add" on line 2; Mod+D twice selects it and its next occurrence on line 5. The added range
  // is not the main one (@codemirror/search addRange(..., false)): the right-click goes to it, on line 5.
  const caret = await pointIn(page, 2, 5);
  await page.mouse.click(caret.x, caret.y);
  await page.keyboard.press(`${MOD}+D`);
  await page.keyboard.press(`${MOD}+D`);
  await expect(page.locator(".cm-selectionBackground")).toHaveCount(2);
  await expect(page.locator("#status-pos"), "the main range is still the one on line 2").toHaveText(/^Ln 2,/);
  const at = await pointIn(page, 5, 7);
  await clearRecords(page);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  expect((await labels(page))[0]).toBe("Capture snippet of lines 2 to 5...");
  const results = await counter(page, "codeMenuResults");
  await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(results + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "copied");
  const copy = (await copies(page)).at(-1)!;
  expect(copy.text?.replace(/\r/g, "")).toBe("add\nadd");
  expect(copy.prevented).toBe(true);
  // Both ranges are still drawn, on lines 2 and 5.
  for (const n of [2, 5]) {
    const l = await box(line(page, n));
    expect(await page.locator(".cm-selectionBackground").evaluateAll((els, y) => els.some((e) => {
      const r = e.getBoundingClientRect();
      return r.top <= y && r.bottom >= y;
    }), l.y + l.height / 2), `range on line ${n}`).toBe(true);
  }

  // Variant: a cursor added on line 4 makes the main range empty; the menu still opens on a selected range.
  const l4 = await box(line(page, 4));
  await page.keyboard.down(MOD);
  await page.mouse.click(l4.x + 4, l4.y + l4.height / 2);
  await page.keyboard.up(MOD);
  await clearRecords(page);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  const r2 = await counter(page, "codeMenuResults");
  await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(r2 + 1));
  const result = await page.locator("#app").getAttribute("data-code-menu-result");
  const fired = (await copies(page)).length > 0;
  info.annotations.push({ type: "C4 variant", description: `${info.project.name}: copy event fired ${fired}, result ${result}` });
  if (result === "copied") expect((await copies(page)).at(-1)?.text?.replace(/\r/g, "")).toBe("add\nadd");
  else {
    expect(result).toBe("copy-failed");
    await expect(page.locator(".notice-text")).toHaveText(/^Couldn't copy from the menu\. Press (Ctrl|Cmd)\+C to copy\.$/);
  }
});

test("C5: Shift+right-click on the selection gives the browser's menu and keeps the selection", async ({ page, browserName }, info) => {
  await fixture(page);
  const at = await pointIn(page, 2);
  const before = await counter(page, "codeMenus");
  await page.keyboard.down("Shift");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.keyboard.up("Shift");
  await expect(codeMenu(page)).toHaveCount(0);
  const recorded = await menus(page);
  info.annotations.push({ type: "C5", description: `${browserName}: ${JSON.stringify(recorded)}, data-code-menus +${(await counter(page, "codeMenus")) - before}` });
  if (browserName !== "firefox") {
    expect(recorded.map((m) => m.prevented)).toEqual([false]);
  }
  // Focus goes back to the code for the check (the browser's menu would hold it in real use).
  await page.locator(".cm-content").focus();
  await selectionIntact(page);
});

test("C6: right-clicking again at the same point gives the browser's menu", async ({ page }, info) => {
  await fixture(page);
  const at = await pointIn(page, 2);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  await rightClick(page, at);
  await expect(codeMenu(page)).toHaveCount(0);
  const second = (await menus(page)).at(-1)!;
  expect(second).toMatchObject({ prevented: false, inMenu: false });
  await page.locator(".cm-content").focus();
  const kept = await page.locator("#status-pos").textContent();
  info.annotations.push({ type: "C6", description: `${info.project.name}: after the second right-click the head is at ${kept}` });
  await selectionIntact(page);
});

test("C7: a second right-click on the open menu closes it at once and gives the browser's menu", async ({ page }, info) => {
  await fixture(page);
  const at = await pointIn(page, 2);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  await rightClick(page, { x: at.x + 4, y: at.y + 4 });
  await expect(codeMenu(page)).toHaveCount(0);
  const second = (await menus(page)).at(-1)!;
  expect(second).toMatchObject({ prevented: false, inMenu: false });
  await page.locator(".cm-content").focus();
  info.annotations.push({ type: "C7", description: `${info.project.name}: the head after the press aimed at the menu: ${await page.locator("#status-pos").textContent()}` });
});

/** The primary cursor's box (drawSelection draws it at the main range's head), read while the code has focus. */
const caret = (page: Page) => box(page.locator(".cm-cursor-primary"));

test("C8: Shift+F10 with a selection opens the menu at the head, with the keyboard hint; off-screen heads scroll in", async ({ page, browserName }) => {
  await fixture(page);
  const mac = await isMacPage(page);
  const c = await caret(page);
  await page.keyboard.press("Shift+F10");
  const menu = codeMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  const m = await box(menu);
  const below = Math.abs(m.y - (c.y + c.height + 4)) <= 2;
  const above = Math.abs(m.y + m.height - (c.y - 4)) <= 2;
  expect(below || above, `menu at ${JSON.stringify(m)}, caret ${JSON.stringify(c)}`).toBe(true);
  expect(Math.abs(m.x - c.x)).toBeLessThanOrEqual(2);
  if (mac) await expect(menu.locator(".menu-hint")).toHaveCount(0);
  else await expect(menu.locator(".menu-hint")).toHaveText("Press Shift+F10 again for the browser's menu");
  if (browserName === "chromium") expect(await menus(page), "the keydown was cancelled: no contextmenu").toEqual([]);
  await page.keyboard.press("Escape");
  await selectionIntact(page);

  // The head out of view: the code scrolls to it and the menu opens there, and stays open.
  const text = Array.from({ length: 120 }, (_, i) => `line_${i + 1} = ${i + 1}`).join("\n") + "\n";
  await openWith(page, [{ name: "long.py", text }]);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await scrollCode(page, "bottom");
  expect(await page.locator(".cm-scroller").evaluate((s) => s.scrollTop)).toBeGreaterThan(500);
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  expect(await page.locator(".cm-scroller").evaluate((s) => s.scrollTop)).toBeLessThan(500);
  await page.waitForTimeout(500);
  await expect(menu, "the scroll at open did not close it").toBeVisible();
  await page.keyboard.press("Escape");
});

test("C9: the Menu key opens the code menu, and no browser menu covers it (Chromium, Windows host)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium" || process.platform !== "win32", "the Menu key's keyup contextmenu is Chromium's Windows path");
  await fixture(page);
  await page.keyboard.press("ContextMenu");
  await expect(codeMenu(page)).toBeVisible();
  await page.waitForTimeout(200);
  const recorded = await menus(page);
  for (const m of recorded) expect(m, JSON.stringify(recorded)).toMatchObject({ inMenu: true, prevented: true });
  await expect(codeMenu(page)).toBeVisible();
});

test("C10: Shift+F10 again closes the code menu and lets the browser's menu come", async ({ page, browserName }) => {
  await fixture(page);
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await clearRecords(page);
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toHaveCount(0);
  await selectionIntact(page);
  if (browserName === "chromium") expect((await menus(page)).map((m) => ({ prevented: m.prevented, inMenu: m.inMenu }))).toEqual([{ prevented: false, inMenu: false }]);
});

test("C11: Shift+F10 with nothing selected leaves the browser's keyboard menu alone", async ({ page, browserName }) => {
  await openWith(page);
  await page.locator(".cm-content").click();
  await clearRecords(page);
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(200);
  await expect(codeMenu(page)).toHaveCount(0);
  if (browserName === "chromium") expect((await menus(page)).map((m) => m.prevented)).toEqual([false]);
});

test("C12: focus and selection: Escape, Tab, a click elsewhere, Select all; hover moves focus", async ({ page }) => {
  await fixture(page);
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("#status-pos"), "the same selection extends").toHaveText("Ln 5, Col 1");
  await page.keyboard.press("Shift+ArrowUp");

  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(codeMenu(page)).toHaveCount(0);
  await selectionIntact(page);

  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  const status = await box(page.locator(".statusbar"));
  await page.mouse.click(status.x + 4, status.y + status.height / 2);
  await expect(codeMenu(page)).toHaveCount(0);
  await expect(page.locator(".cm-selectionBackground").first()).toBeAttached();
  await expect(page.locator("#status-pos")).toHaveText("Ln 4, Col 1");

  // Hover: the row under the pointer takes focus; Enter acts on it. (Focus left the code with the
  // click above, and a raw focus() would put the caret at the start: select again by keyboard.)
  await selectFixtureLines(page);
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await clearRecords(page);
  const copy = codeMenu(page).getByRole("menuitem", { name: /^Copy/ });
  await copy.hover();
  await expect(copy).toBeFocused();
  const results = await counter(page, "codeMenuResults");
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(results + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "copied");
  expect((await copies(page)).length).toBe(1);
  await expect(page.locator("dialog#snippet-dialog")).toHaveCount(0);

  // Select all.
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await codeMenu(page).getByRole("menuitem", { name: /^Select all/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "selected");
  await expect(page.locator(".cm-content")).toBeFocused();
  const norm = (s: string) => s.replace(/\r/g, "").replace(/\n+/g, "\n").replace(/\n$/, "");
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "").then(norm)).toBe(norm(FIXTURE));
});

test("C13: a left click on the selection only dismisses the menu; elsewhere it moves the caret", async ({ page }) => {
  await fixture(page);
  // The menu opens at the pointer and covers what lies right of it and below: the left clicks land to its left.
  const at = await pointIn(page, 2, 9);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  const inside = await pointIn(page, 3, 1);
  expect(inside.x).toBeLessThan((await box(codeMenu(page))).x);
  await page.mouse.click(inside.x, inside.y);
  await expect(codeMenu(page)).toHaveCount(0);
  await selectionIntact(page);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  const five = await pointIn(page, 5, 3);
  expect(five.x).toBeLessThan((await box(codeMenu(page))).x);
  await page.mouse.click(five.x, five.y);
  await expect(codeMenu(page)).toHaveCount(0);
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 5,/);
});

test("C14: closing the menu or the dialog never scrolls the code (WebKit scrolls on a raw focus)", async ({ page }, info) => {
  const text = Array.from({ length: 120 }, (_, i) => `line_${i + 1} = ${i + 1}`).join("\n") + "\n";
  await openWith(page, [{ name: "long.py", text }]);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 91; i++) await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("#status-pos")).toHaveText("Ln 101, Col 1");
  const scroller = page.locator(".cm-scroller");
  await scrollCode(page, await scroller.evaluate((s) => 49 * 22.5 - s.clientHeight / 2));
  await page.waitForTimeout(100);
  const target = page.locator(".cm-line", { hasText: /^line_50 = 50$/ });
  const ua = await page.evaluate(() => navigator.userAgent);
  info.annotations.push({ type: "C14 user agent", description: ua });
  for (const step of ["escape", "copy", "capture"] as const) {
    const t = await box(target);
    const top = await scroller.evaluate((s) => s.scrollTop);
    await rightClick(page, { x: t.x + 30, y: t.y + t.height / 2 });
    await expect(codeMenu(page)).toBeVisible();
    if (step === "escape") await page.keyboard.press("Escape");
    else if (step === "copy") await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
    else {
      await codeMenu(page).getByRole("menuitem", { name: /^Capture snippet of lines 10 to 100/ }).click();
      await expect(page.locator("dialog#snippet-dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog#snippet-dialog")).toHaveCount(0);
    }
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.waitForTimeout(150);
    expect(Math.abs((await scroller.evaluate((s) => s.scrollTop)) - top), `scrollTop after ${step}`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => getSelection()?.isCollapsed), `the DOM selection is back after ${step}`).toBe(false);
    await expect(page.locator("#status-pos")).toHaveText("Ln 101, Col 1");
  }
});

test("C15: Capture snippet opens the dialog; Escape brings focus back to the code with the selection", async ({ page }) => {
  await fixture(page);
  await page.keyboard.press("Shift+F10");
  await expect(codeMenu(page)).toBeVisible();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Capture snippet of lines 2 to 3" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/^Preview of main\.py, lines 2 to 3, in the editor's colours; line numbers shown; file name shown\./);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await selectionIntact(page);
});

test("C16: Copy and Cut go through the editor's own copy handler; Cut is one undo step", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page);
  await page.keyboard.press("Shift+F10");
  await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "copied");
  const copy = (await copies(page)).at(-1)!;
  expect(copy.prevented).toBe(true);
  expect(copy.text?.replace(/\r/g, "")).toBe(LINES_2_3);
  if (browserName === "chromium") expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r/g, "")).toBe(LINES_2_3);

  await clearRecords(page);
  const results = await counter(page, "codeMenuResults");
  await page.keyboard.press("Shift+F10");
  await codeMenu(page).getByRole("menuitem", { name: /^Cut/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(results + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "cut");
  expect((await copies(page)).at(-1)?.text?.replace(/\r/g, "")).toBe(LINES_2_3);
  await expect(page.locator(".cm-line")).toHaveCount(4);
  await expect(page.locator(".cm-content")).not.toContainText("def add");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).toContainText("def add(a, b):");
  await expect(page.locator(".cm-line")).toHaveCount(6);
});

test("C17: Copy and Cut are judged by their effect, never by execCommand's answer", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => (document.execCommand = () => false));
  await page.keyboard.press("Shift+F10");
  await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "copy-failed");
  await expect(page.locator(".notice-text")).toHaveText(/^Couldn't copy from the menu\. Press (Ctrl|Cmd)\+C to copy\.$/);
  await expect(page.locator(".cm-content")).toBeFocused();

  await page.evaluate(() => (document.execCommand = () => true));
  let results = await counter(page, "codeMenuResults");
  await page.keyboard.press("Shift+F10");
  await codeMenu(page).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(results + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "copy-failed");
  results = await counter(page, "codeMenuResults");
  await page.keyboard.press("Shift+F10");
  await codeMenu(page).getByRole("menuitem", { name: /^Cut/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-results", String(results + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "cut-failed");
  await expect(page.locator(".notice-text")).toHaveText(/^Couldn't cut from the menu\. Press (Ctrl|Cmd)\+X to cut\.$/);
  await expect(page.locator(".cm-content")).toContainText("def add(a, b):");
});

const READ_ONLY = "This tab is read-only: the workspace is open for editing in another tab. Choose Edit here to edit in this tab.";

test("C18: on a read-only tab every item is there; Cut explains, Copy and Capture work", async ({ page, context }) => {
  await openWith(page);
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await openFromTree(second, "main.py");
  await selectFixtureLines(second);
  await clearRecords(second);
  await rightClick(second, await pointIn(second, 2));
  const menu = codeMenu(second);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  for (const item of await menu.getByRole("menuitem").all()) {
    await expect(item).not.toHaveAttribute("disabled");
    await expect(item).not.toHaveAttribute("aria-disabled");
  }
  await menu.getByRole("menuitem", { name: /^Cut/ }).click();
  await expect(second.locator("#app")).toHaveAttribute("data-code-menu-result", "read-only-tab");
  await expect(second.locator(".notice-text")).toHaveText(READ_ONLY);
  await expect(second.locator(".cm-content")).toContainText("def add(a, b):");
  expect(await copies(second)).toEqual([]);
  await rightClick(second, await pointIn(second, 2));
  await codeMenu(second).getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(second.locator("#app")).toHaveAttribute("data-code-menu-result", "copied");
  await rightClick(second, await pointIn(second, 2));
  await codeMenu(second).getByRole("menuitem", { name: /^Capture snippet/ }).click();
  await expect(second.locator("dialog#snippet-dialog")).toBeVisible();
  await second.keyboard.press("Escape");
  await second.close();
});

test("C19: read-only is checked at the click: a role change while the menu is open makes Cut explain", async ({ page, context }) => {
  await openWith(page);
  await selectFixtureLines(page);
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await page.bringToFront();
  await page.locator(".cm-content").focus();
  await rightClick(page, await pointIn(page, 2));
  await expect(codeMenu(page)).toBeVisible();
  await second.locator("#read-only-banner").getByRole("button", { name: "Edit here" }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-role", "reader", { timeout: 10_000 });
  // The menu may have closed when the other page took the focus; reopen it on the same selection then.
  if (!(await codeMenu(page).isVisible())) {
    test.info().annotations.push({ type: "C19", description: `${test.info().project.name}: the code menu closed when the other page was used (window blur); reopened after the role change` });
    await page.bringToFront();
    await rightClick(page, await pointIn(page, 2));
  }
  await codeMenu(page).getByRole("menuitem", { name: /^Cut/ }).click();
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu-result", "read-only-tab");
  await expect(page.locator(".notice-text")).toHaveText(READ_ONLY);
  await expect(page.locator(".cm-content")).toContainText("def add(a, b):");
  await second.close();
});

test("C20: touch never gets the code menu", async ({ page }) => {
  await fixture(page);
  const before = await counter(page, "codeMenus");
  // At a point on the selection, so only the touch rule can send the request to the browser.
  const at = await pointIn(page, 2);
  const prevented = await page.locator(".cm-line").nth(1).evaluate((el, p) => {
    const where = { clientX: p.x, clientY: p.y, bubbles: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...where, pointerType: "touch", isPrimary: true }));
    const e = new PointerEvent("contextmenu", { ...where, pointerType: "touch", cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, at);
  expect(prevented).toBe(false);
  await expect(codeMenu(page)).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-code-menus", String(before + 1));
  await expect(page.locator("#app")).toHaveAttribute("data-code-menu", "browser");
});

test.describe("C20 with a touch screen (Chromium)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "CDP's tap gesture is Chromium's");
  test.use({ hasTouch: true });
  test("a long tap on the selection: any touch contextmenu is left alone", async ({ page }, info) => {
    await fixture(page);
    const at = await pointIn(page, 2);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeTapGesture", { x: Math.round(at.x), y: Math.round(at.y), duration: 1000 });
    await page.waitForTimeout(300);
    const recorded = await menus(page);
    info.annotations.push({ type: "C20 tap", description: JSON.stringify(recorded) });
    for (const m of recorded) if (m.pointerType === "touch") expect(m.prevented).toBe(false);
    await expect(codeMenu(page)).toHaveCount(0);
  });
});

test("C21: near the bottom-right corner the menu flips; it fits small windows and scrolls there", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("codeeditor:settings", JSON.stringify({ lineWrapping: true })));
  const text = Array.from({ length: 80 }, (_, i) => `line_${i} = "${"x".repeat(300)}"`).join("\n") + "\n";
  await openWith(page, [{ name: "long.py", text }]);
  await expect(page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+A`);
  const p = await page.locator(".cm-scroller").evaluate((s) => {
    const b = s.getBoundingClientRect();
    return { x: b.left + s.clientWidth - 6, y: b.top + s.clientHeight - 6 };
  });
  await rightClick(page, p);
  const menu = codeMenu(page);
  await expect(menu).toBeVisible();
  const m = await box(menu);
  expect(m.x).toBeGreaterThanOrEqual(4);
  expect(m.y).toBeGreaterThanOrEqual(4);
  expect(m.x + m.width).toBeLessThanOrEqual(1440 - 4);
  expect(m.y + m.height).toBeLessThanOrEqual(900 - 4);
  expect(m.y + m.height, "flipped above the pointer").toBeLessThanOrEqual(p.y + 0.5);
  expect(m.x + m.width, "flipped left of the pointer").toBeLessThanOrEqual(p.x + 0.5);
  await page.keyboard.press("Escape");

  for (const vp of [{ width: 320, height: 640 }, { width: 320, height: 256 }]) {
    await page.setViewportSize(vp);
    await openWith(page);
    await selectFixtureLines(page);
    await rightClick(page, await pointIn(page, 2));
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal overflow at ${vp.width} x ${vp.height}`).toBe(true);
    const mb = await box(menu);
    expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width - 4 + 0.5);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    const selectAll = menu.getByRole("menuitem", { name: /^Select all/ });
    await expect(selectAll).toBeFocused();
    await expect(selectAll).toBeInViewport();
    await page.keyboard.press("Escape");
  }
});

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`C22: the code menu passes axe and the painted-pair audit (${vp.name}, ${scheme}); the hint describes it and never widens it`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openIn(page, "/", scheme);
      await openWith(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await selectFixtureLines(page);
      await rightClick(page, await pointIn(page, 2));
      const menu = codeMenu(page);
      await expect(menu).toBeVisible();
      const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
      expect(axe).toEqual([]);
      const a = await audit(page);
      const pairs = a.pairs.filter((p) => p.sel.includes("menu"));
      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.filter((p) => p.ratio < p.min).map((p) => `${p.sel} ${p.text} ${p.ratio}`)).toEqual([]);
      const min = vp.width < 900 ? 44 : 24;
      for (const item of await menu.getByRole("menuitem").all()) expect((await box(item)).height).toBeGreaterThanOrEqual(min);
      await expect(menu).toHaveAccessibleDescription("Shift+right-click for the browser's menu");
      await expect(menu.locator(".menu-hint")).toHaveAttribute("aria-hidden", "true");
      const shown = await menu.evaluate((m) => {
        const hint = m.querySelector<HTMLElement>(".menu-hint")!;
        const label = m.querySelector(".menu-label")!;
        const textLeft = hint.getBoundingClientRect().left + parseFloat(getComputedStyle(hint).paddingLeft);
        const width = m.getBoundingClientRect().width;
        hint.style.display = "none";
        const without = m.getBoundingClientRect().width;
        hint.style.display = "";
        return { width, without, textLeft, labelLeft: label.getBoundingClientRect().left };
      });
      expect(Math.abs(shown.width - shown.without), "the hint never widens the menu").toBeLessThanOrEqual(1);
      expect(Math.abs(shown.textLeft - shown.labelLeft), "the hint's text lines up with the labels").toBeLessThanOrEqual(1);
    });
  }
}

test("C23: a held Shift+F10 opens one menu and leaves it open", async ({ page }, info) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as unknown as { __repeats: boolean[] };
    w.__repeats = [];
    addEventListener("keydown", (e) => { if (e.key === "F10") w.__repeats.push(e.repeat); }, true);
  });
  await page.keyboard.down("Shift");
  await page.keyboard.down("F10");
  await page.keyboard.down("F10");
  await page.keyboard.up("F10");
  await page.keyboard.up("Shift");
  const repeats = await page.evaluate(() => (window as unknown as { __repeats: boolean[] }).__repeats);
  info.annotations.push({ type: "C23 repeat", description: `${info.project.name}: ${JSON.stringify(repeats)}` });
  test.skip(repeats[1] !== true, `this engine sends the second keydown without repeat [U]: ${JSON.stringify(repeats)}`);
  await expect(codeMenu(page)).toBeVisible();
  await expect(page.locator("#code-menu")).toHaveCount(1);
});

test("C24: app shortcuts don't act behind the menu; Ctrl+S keeps the browser's Save away", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as unknown as { __saves: boolean[] };
    w.__saves = [];
    addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") w.__saves.push(e.defaultPrevented); });
  });
  const runs = await page.locator("#app").getAttribute("data-runs");
  await page.keyboard.press("Shift+F10");
  const menu = codeMenu(page);
  await expect(menu).toBeVisible();
  const first = menu.getByRole("menuitem").first();
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(300);
  expect(await page.locator("#app").getAttribute("data-runs")).toBe(runs);
  await expect(page.locator("#run-button")).toHaveAttribute("data-running", "false");
  await expect(menu).toBeVisible();
  // menu.ts stops Ctrl+Enter itself; Alt+W is the step that proves the window guard (workbench.ts).
  await page.keyboard.press("Alt+W");
  await page.waitForTimeout(200);
  await expect(page.locator('.tabs [role=tab][title="main.py"]')).toHaveCount(1);
  await expect(menu).toBeVisible();
  await page.keyboard.press(`${MOD}+S`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saves: boolean[] }).__saves)).toEqual([true]);
  await expect(first).toBeFocused();
  await expect(menu).toBeVisible();
});

test("C25: the menu closes when the code scrolls under it or the window loses focus", async ({ page }) => {
  const text = Array.from({ length: 120 }, (_, i) => `line_${i + 1} = ${i + 1}`).join("\n") + "\n";
  await openWith(page, [{ name: "long.py", text }]);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  const at = await pointIn(page, 1, 2);
  await rightClick(page, at);
  await expect(codeMenu(page)).toBeVisible();
  const code = await box(page.locator(".cm-scroller"));
  await page.mouse.move(code.x + code.width / 2, code.y + code.height - 40);
  await page.mouse.wheel(0, 300);
  await expect(codeMenu(page)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();

  await page.locator(".cm-scroller").evaluate((s) => (s.scrollTop = 0));
  await page.waitForTimeout(100);
  await rightClick(page, await pointIn(page, 1, 2));
  await expect(codeMenu(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(codeMenu(page)).toHaveCount(0);
});

test("C26: a held Shift's autorepeat between press and release never turns Shift+right-click into the code menu (Chromium, Windows host)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium" || process.platform !== "win32", "Chromium's Windows mouseup timing");
  await fixture(page);
  const at = await pointIn(page, 2);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Shift");
  await page.mouse.down({ button: "right" });
  await page.keyboard.down("Shift");
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Shift");
  await page.waitForTimeout(200);
  await expect(codeMenu(page)).toHaveCount(0);
  expect((await menus(page)).map((m) => m.prevented)).toEqual([false]);
  await page.locator(".cm-content").focus();
  await selectionIntact(page);
});
