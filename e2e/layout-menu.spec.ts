// The Layout menu (owner, 2026-11-07: "i want the output window alongside codeditor not beneath ... multiple
// view styles user can choose"): from 1100 px a Layout button in the top bar lists every arrangement of
// the code board as one choice each: the output below or beside the code, with or without the
// flowchart, and Focus code. A choice is remembered (Focus code is a mode, as before). Where there is no
// room for the output beside the code, that choice stays in the list, says why, and explains on a click.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const MAIN = { name: "main.py", text: 'print("hi")\n' };
const BELOW_CHART = "Output below the code, with the flowchart";
const BESIDE_CHART = "Output beside the code, with the flowchart";
const BELOW_ALONE = "Output below the code, without the flowchart";
const BESIDE_ALONE = "Output beside the code, without the flowchart";
const FOCUS = "Focus code";

const center = (page: Page) => page.locator(".center");
const button = (page: Page) => page.getByRole("button", { name: "Layout", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "Layout" });
const choice = (page: Page, name: string) => menu(page).getByRole("menuitemradio", { name, exact: true });
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

async function openMain(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await importFiles(page, [MAIN]);
  await openFromTree(page, "main.py");
  if (width >= 1100) await expect(page.locator("#chart-board .fc-view")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
}

async function pick(page: Page, name: string) {
  await button(page).click();
  await expect(menu(page)).toBeVisible();
  await choice(page, name).click();
  await expect(menu(page)).toBeHidden();
}

async function state(page: Page) {
  const c = center(page);
  return {
    chart: await c.getAttribute("data-chart"),
    console: await c.getAttribute("data-console"),
    focus: await c.getAttribute("data-focus"),
    collapsed: await page.locator("#panel").getAttribute("data-collapsed"),
  };
}

test("the Layout button lists five arrangements, the current one checked, in two named groups", async ({ page }) => {
  await openMain(page);
  await expect(button(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-haspopup", "menu");
  await button(page).click();
  await expect(button(page)).toHaveAttribute("aria-expanded", "true");
  const names = await menu(page).getByRole("menuitemradio").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.textContent?.trim()));
  expect(names).toEqual([BELOW_CHART, BESIDE_CHART, BELOW_ALONE, BESIDE_ALONE, FOCUS]);
  await expect(menu(page).getByRole("group", { name: "With the flowchart" })).toBeVisible();
  await expect(menu(page).getByRole("group", { name: "Without the flowchart" })).toBeVisible();
  await expect(choice(page, BELOW_CHART)).toHaveAttribute("aria-checked", "true");
  for (const n of [BESIDE_CHART, BELOW_ALONE, BESIDE_ALONE, FOCUS]) await expect(choice(page, n)).toHaveAttribute("aria-checked", "false");
  expect((await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => v.id), "axe, the menu open").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
});

test("each choice arranges the boards, opens the output where it has one, and is remembered", async ({ page }) => {
  await openMain(page);
  await pick(page, BESIDE_CHART);
  expect(await state(page)).toEqual({ chart: "shown", console: "beside", focus: "false", collapsed: "false" });
  const code = await box(page, "#editor-area");
  const out = await box(page, "#panel");
  expect(out.x, "the output is right of the code").toBeGreaterThan(code.x + code.width);
  expect((await box(page, "#chart-board")).x, "the flowchart right of both").toBeGreaterThan(out.x + out.width);

  await pick(page, BESIDE_ALONE);
  expect(await state(page)).toEqual({ chart: "hidden", console: "beside", focus: "false", collapsed: "false" });
  await expect(page.locator("#chart-board")).toBeHidden();

  await pick(page, BELOW_ALONE);
  expect(await state(page)).toEqual({ chart: "hidden", console: "below", focus: "false", collapsed: "false" });
  expect((await box(page, "#panel")).y, "the output is under the code").toBeGreaterThan((await box(page, "#editor-area")).y + 100);

  // Remembered on this device.
  await pick(page, BESIDE_ALONE);
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  if ((await page.locator('.tabs [role=tab][title="main.py"]').count()) === 0) await openFromTree(page, "main.py");
  // The output stands beside the code at once, not folded to its head until a run.
  await expect.poll(() => state(page)).toEqual({ chart: "hidden", console: "beside", focus: "false", collapsed: "false" });
  await button(page).click();
  await expect(choice(page, BESIDE_ALONE)).toHaveAttribute("aria-checked", "true");
  await choice(page, BELOW_CHART).click();
  expect(await state(page)).toMatchObject({ chart: "shown", console: "below", focus: "false", collapsed: "false" });
});

test("Focus code is a choice too, and any other choice leaves it", async ({ page }) => {
  await openMain(page);
  await pick(page, FOCUS);
  expect(await state(page)).toMatchObject({ focus: "true" });
  await button(page).click();
  await expect(choice(page, FOCUS)).toHaveAttribute("aria-checked", "true");
  await expect(choice(page, BELOW_CHART)).toHaveAttribute("aria-checked", "false");
  await choice(page, BESIDE_CHART).click();
  expect(await state(page)).toEqual({ chart: "shown", console: "beside", focus: "false", collapsed: "false" });
});

test("from the keyboard: Enter opens it on the first choice, the arrows move, Enter chooses, focus returns", async ({ page }) => {
  await openMain(page);
  await button(page).focus();
  await page.keyboard.press("Enter");
  await expect(choice(page, BELOW_CHART)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(choice(page, BESIDE_CHART)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
  expect(await state(page)).toMatchObject({ console: "beside" });
});

test("at 1100 px the output can't stand beside the code and the flowchart: that choice says why and stays put", async ({ page }) => {
  await openMain(page, 1100, 800);
  await button(page).click();
  const tight = choice(page, BESIDE_CHART);
  await expect(tight).toHaveAttribute("aria-disabled", "true");
  await expect(tight).toHaveAccessibleDescription(/wider window/);
  await expect(choice(page, BESIDE_ALONE)).not.toHaveAttribute("aria-disabled", "true");
  // Playwright won't click an aria-disabled item: chosen from the keyboard, it explains instead of acting.
  await tight.focus();
  await page.keyboard.press("Enter");
  await expect(menu(page), "an unavailable choice keeps the menu open").toBeVisible();
  await expect(page.locator(".notice")).toContainText("There isn't room for the output beside the code");
  expect(await state(page)).toMatchObject({ chart: "shown", console: "below" });
  await choice(page, BESIDE_ALONE).click();
  expect(await state(page)).toMatchObject({ chart: "hidden", console: "beside" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no sideways scroll").toBe(0);
});

test("under 1100 px there is no Layout button (the output stays under the code there)", async ({ page }) => {
  await openMain(page, 1000, 800);
  await expect(button(page)).toHaveCount(0);
});
