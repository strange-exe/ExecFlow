// The layout fix on Flow Board (owner's report on 0.26.0, 2026-11-02), from 1100 px: the splitter
// between the code board and the chart board, hiding the chart board, the output beside the code
// (with its own splitter, and a fall-back below when there is no room), focus code (and the browser's
// full screen as a palette command); and three fixes found in the review shots: one way to the
// problems (the run strip's count; the console has no tabs there), a console that stays its head
// until the first run, and thin themed scrollbars on the boards. Under 1100 px nothing changes.
// Every keyboard path is driven with the keyboard.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, setCode, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const MAIN = { name: "main.py", text: 'n = 3\nfor i in range(n):\n    print(i)\nprint("done")\n' };
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const center = (page: Page) => page.locator(".center");
const boardSplit = (page: Page) => page.getByRole("separator", { name: "Resize the flowchart" });
const consoleSplit = (page: Page) => page.locator(".center > .console-split");
const nodes = (page: Page) => page.locator("#chart-board .fc-stage [role=listitem][data-node]");
const value = async (_page: Page, sel: ReturnType<typeof boardSplit>) => Number(await sel.getAttribute("aria-valuenow"));

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

/** The chart is drawn: wait for it before any reload, which would cancel its parser's fetch. */
async function chartReady(page: Page) {
  await expect(page.locator("#chart-board .fc-view")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
}

async function openMain(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await importFiles(page, [MAIN]);
  await openFromTree(page, "main.py");
  await chartReady(page);
}

/** Reloads the page once the chart is drawn, then opens main.py again and waits for its chart. */
async function reloadMain(page: Page) {
  await chartReady(page);
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  if ((await page.locator('.tabs [role=tab][title="main.py"]').count()) === 0) await openFromTree(page, "main.py");
}

/** Where the boards stand: the layout's attributes, the console's state and the parts' boxes. */
async function layoutNow(page: Page) {
  const c = center(page);
  const rect = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox();
    return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  return {
    chart: await c.getAttribute("data-chart"),
    console: await c.getAttribute("data-console"),
    collapsed: await page.locator("#panel").getAttribute("data-collapsed"),
    tab: await page.locator("#panel").getAttribute("data-tab"),
    code: await rect("#editor-area"),
    panel: await rect("#panel"),
    board: await rect("#chart-board:visible"),
  };
}

test.describe("the board splitter", () => {
  test("sizes the chart board from the keyboard and the pointer, keeps both boards at their least, is remembered, and is clamped when the window narrows", async ({ page }) => {
    await openMain(page);
    const split = boardSplit(page);
    await expect(split).toBeVisible();
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    await expect(split).toHaveAttribute("aria-controls", "chart-board");
    expect(await split.getAttribute("aria-valuemin")).toBe("320");
    // Its target is 24 px or more; its drawn line is thin.
    const s = await box(page, ".center > .board-split");
    expect(s.width, "the target").toBeGreaterThanOrEqual(16);
    // The pointer's reach is the bar's ::after, standing out either side of the 16 px gap.
    const reach = await split.evaluate((el) => el.getBoundingClientRect().width - parseFloat(getComputedStyle(el, "::after").left) - parseFloat(getComputedStyle(el, "::after").right));
    expect(reach, "the pointer's reach").toBeGreaterThanOrEqual(24);
    const line = await split.evaluate((el) => parseFloat(getComputedStyle(el, "::before").width));
    expect(line, "a thin drawn line").toBeLessThanOrEqual(2);

    // The default: two equal boards; the value is the chart board's width.
    const start = await value(page, split);
    expect(Math.abs((await box(page, "#chart-board")).width - start)).toBeLessThan(2);
    expect(Math.abs((await box(page, "#chart-board")).width - ((await box(page, "#editor-area")).width + 2)), "equal boards").toBeLessThan(2);

    // ArrowLeft moves the bar towards the code: the chart board grows by 16 px; ArrowRight gives it back.
    await split.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await value(page, split)).toBe(start + 16);
    expect(Math.abs((await box(page, "#chart-board")).width - (start + 16))).toBeLessThan(2);
    await page.keyboard.press("ArrowRight");
    expect(await value(page, split)).toBe(start);
    // Home and End go to the limits: the chart's least (320) and the code's least (420).
    await page.keyboard.press("Home");
    expect(await value(page, split)).toBe(320);
    expect(Math.round((await box(page, "#chart-board")).width)).toBe(320);
    await page.keyboard.press("End");
    const max = Number(await split.getAttribute("aria-valuemax"));
    expect(await value(page, split)).toBe(max);
    expect(Math.round((await box(page, "#editor-area")).width) + 2, "the code board at its least").toBeGreaterThanOrEqual(420);
    // A double-click restores the default.
    await split.dblclick();
    expect(await value(page, split)).toBe(start);

    // The pointer: dragged 100 px left, the chart board is 100 px wider.
    const b = await box(page, ".center > .board-split");
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 100, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(Math.abs((await value(page, split)) - (start + 100))).toBeLessThanOrEqual(2);
    const dragged = await value(page, split);

    // Remembered on this device.
    await reloadMain(page);
    await expect(boardSplit(page)).toHaveAttribute("aria-valuenow", String(dragged));

    // The window narrows: the size is clamped so the code keeps 420 px; widened again, it comes back.
    await boardSplit(page).focus();
    await page.keyboard.press("End");
    const wanted = await value(page, boardSplit(page));
    await page.setViewportSize({ width: 1150, height: 900 });
    await expect.poll(async () => value(page, boardSplit(page))).toBeLessThan(wanted);
    expect(Math.round((await box(page, "#editor-area")).width) + 2).toBeGreaterThanOrEqual(420);
    expect(Math.round((await box(page, "#chart-board")).width)).toBeGreaterThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no sideways scroll").toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => value(page, boardSplit(page))).toBe(wanted);
  });
});

test.describe("hiding the flowchart", () => {
  test("Hide flowchart gives the code board the canvas, the chart stops drawing, the head's Flowchart brings it back, and the choice is remembered", async ({ page }) => {
    await openMain(page);
    const hide = page.getByRole("button", { name: "Hide flowchart" });
    const toggle = page.locator("#chart-toggle");
    await expect(toggle).toBeHidden();
    const canvas = await box(page, ".center");
    await hide.focus();
    await page.keyboard.press("Enter");
    await expect(center(page)).toHaveAttribute("data-chart", "hidden");
    await expect(page.locator("#chart-board")).toBeHidden();
    await expect(boardSplit(page)).toHaveCount(0);
    // The code board spans the canvas, and the focus went to the control that brings the chart back.
    expect((await box(page, "#editor-area")).width, "the code board spans the canvas").toBeGreaterThan(canvas.width - 64);
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAccessibleName("Flowchart");
    expect(await axe(page), "axe, the chart hidden").toEqual([]);

    // Hidden, the chart doesn't follow the code (no redraw), and catches up once shown.
    const before = await nodes(page).count();
    await setCode(page, `${MAIN.text}print("one")\nprint("two")\n`);
    await page.waitForTimeout(1_000);
    expect(await nodes(page).count(), "no redraw while hidden").toBe(before);

    // Remembered: still hidden after a reload.
    await reloadMain(page);
    await expect(center(page)).toHaveAttribute("data-chart", "hidden");
    await page.locator("#chart-toggle").click();
    await expect(center(page)).toHaveAttribute("data-chart", "shown");
    await expect(page.locator("#chart-board")).toBeVisible();
    await expect(page.locator("#chart-toggle")).toBeHidden();
    await chartReady(page);
    await expect.poll(async () => nodes(page).count(), "drawn again once shown").toBeGreaterThan(before);
    await reloadMain(page);
    await expect(center(page)).toHaveAttribute("data-chart", "shown");
  });

  test("the board's motion: out with an ease-in, in with an ease-out, none under reduced motion", async ({ page }) => {
    await openMain(page);
    const timings = async () =>
      page.evaluate(() => {
        const board = document.getElementById("chart-board")!;
        const press = document.querySelector<HTMLElement>(board.hidden || !board.getClientRects().length ? "#chart-toggle" : "#chart-hide")!;
        press.click();
        return board.getAnimations().map((a) => {
          const t = (a.effect as KeyframeEffect).getTiming();
          return { duration: t.duration, easing: t.easing };
        });
      });
    expect(await timings(), "reduced motion: none").toEqual([]);
    await page.locator("#chart-toggle").click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // The page sees the change before the next press (WebKit reports it a moment late).
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
    const out = await timings();
    expect(out).toEqual([{ duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)" }]);
    await expect(center(page)).toHaveAttribute("data-chart", "hidden");
    const into = await timings();
    expect(into).toEqual([{ duration: 160, easing: "cubic-bezier(0, 0, 0.2, 1)" }]);
  });

  test("the palette hides and shows the flowchart", async ({ page }) => {
    await openMain(page);
    await page.keyboard.press("F1");
    await page.locator("#palette-input").fill("hide the flowchart");
    await expect(page.locator("#palette-list [role=option]").first()).toContainText("Hide the flowchart");
    await page.keyboard.press("Enter");
    await expect(center(page)).toHaveAttribute("data-chart", "hidden");
    await page.keyboard.press("F1");
    await page.locator("#palette-input").fill("show the flowchart");
    await expect(page.locator("#palette-list [role=option]").first()).toContainText("Show the flowchart");
    await page.keyboard.press("Enter");
    await expect(center(page)).toHaveAttribute("data-chart", "shown");
  });
});

test.describe("the output beside the code", () => {
  test("Output beside puts the console right of the code with its own splitter, the run strip under both; remembered; Output below puts it back", async ({ page }) => {
    await openMain(page);
    await run(page);
    const place = page.locator("#panel-beside");
    await expect(place).toHaveAccessibleName("Output beside");
    await place.click();
    await expect(center(page)).toHaveAttribute("data-console", "beside");
    await expect(place).toHaveAccessibleName("Output below");
    const code = await box(page, "#editor-area");
    const con = await box(page, "#panel");
    const strip = await box(page, ".run-strip");
    expect(con.x, "the console is right of the code").toBeGreaterThan(code.x + code.width);
    expect(Math.abs(con.y - code.y), "level with it").toBeLessThan(2);
    expect(strip.y, "the run strip is the board's foot").toBeGreaterThanOrEqual(Math.max(code.y + code.height, con.y + con.height) - 1);
    expect(strip.x).toBeLessThanOrEqual(code.x + 1);
    expect(strip.x + strip.width).toBeGreaterThanOrEqual(con.x + con.width - 1);
    expect((await box(page, "#chart-board")).x, "the chart board stays right").toBeGreaterThan(con.x + con.width);
    expect(await axe(page), "axe, the output beside").toEqual([]);

    // Its splitter: named, 16 px steps, Home at 320, and the code keeps 420. At 1440 px with the
    // chart board at its default the code board has room only for the least output (320 px): the
    // chart board is made narrower first.
    const split = page.getByRole("separator", { name: "Resize the output panel" });
    await expect(split).toHaveAttribute("aria-orientation", "vertical");
    expect(await value(page, split)).toBe(320);
    expect(await split.getAttribute("aria-valuemax")).toBe("320");
    await boardSplit(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => Number(await split.getAttribute("aria-valuemax"))).toBeGreaterThan(400);
    const start = await value(page, split);
    await split.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await value(page, split)).toBe(start + 16);
    expect(Math.abs((await box(page, "#panel")).width - (start + 16))).toBeLessThan(2);
    await page.keyboard.press("Home");
    expect(await value(page, split)).toBe(320);
    await page.keyboard.press("End");
    expect(Math.round((await box(page, "#editor-area")).width) + 1).toBeGreaterThanOrEqual(420);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    const kept = await value(page, split);

    // Remembered: the place and the size (the console opens there with the next run).
    await reloadMain(page);
    await run(page);
    await expect(center(page)).toHaveAttribute("data-console", "beside");
    await expect(page.getByRole("separator", { name: "Resize the output panel" })).toHaveAttribute("aria-valuenow", String(kept));
    await page.locator("#panel-beside").click();
    await expect(center(page)).toHaveAttribute("data-console", "below");
    expect((await box(page, "#panel")).y, "the console is under the code again").toBeGreaterThan((await box(page, "#editor-area")).y + 100);
    await expect(consoleSplit(page)).toBeHidden();
  });

  test("at 1100 px with the chart shown there is no room: the output stays below and says why; hidden chart, it moves beside", async ({ page }) => {
    await openMain(page, 1100, 800);
    await run(page);
    const place = page.locator("#panel-beside");
    await place.click();
    await expect(center(page)).toHaveAttribute("data-console", "below");
    await expect(place).toHaveAttribute("title", /needs a wider window/);
    await expect(page.locator(".notice")).toContainText("There isn't room for the output beside the code");
    await page.locator("#chart-hide").click();
    await expect(center(page)).toHaveAttribute("data-console", "beside");
    expect(Math.round((await box(page, "#editor-area")).width) + 1).toBeGreaterThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no sideways scroll").toBe(0);
    await page.locator("#chart-toggle").click();
    await expect(center(page)).toHaveAttribute("data-console", "below");
  });
});

test.describe("focus code", () => {
  for (const how of ["button", "shortcut", "escape"] as const) {
    test(`fills the canvas with the code and restores the layout exactly (${how})`, async ({ page }) => {
      await openMain(page);
      await run(page);
      // A layout of the student's own: the chart a little wider, the output beside the code.
      await boardSplit(page).focus();
      await page.keyboard.press("ArrowLeft");
      await page.locator("#panel-beside").click();
      await expect(center(page)).toHaveAttribute("data-console", "beside");
      const before = await layoutNow(page);
      const button = page.locator("#focus-code");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect(button).toHaveAttribute("aria-keyshortcuts", "Shift+Alt+Enter");
      if (how === "shortcut") {
        await page.locator(".cm-content").click();
        const text = await page.locator(".cm-content").innerText();
        await page.keyboard.press("Shift+Alt+Enter");
        expect(await page.locator(".cm-content").innerText(), "the key typed nothing").toBe(text);
      } else await button.click();
      await expect(center(page)).toHaveAttribute("data-focus", "true");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#chart-board")).toBeHidden();
      await expect(page.locator("#panel-output")).toBeHidden();
      await expect(page.locator(".run-strip")).toBeVisible();
      await expect(page.locator(".topbar")).toBeVisible();
      const canvas = await box(page, ".center");
      expect((await box(page, "#editor-area")).width, "the code fills the canvas").toBeGreaterThan(canvas.width - 64);
      expect(await axe(page), "axe, focus code").toEqual([]);
      if (how === "shortcut") await page.keyboard.press("Shift+Alt+Enter");
      else if (how === "button") await button.click();
      else {
        // Escape in the code keeps its own jobs; outside it, it leaves focus code.
        await page.locator(".cm-content").click();
        await page.keyboard.press("Escape");
        await expect(center(page)).toHaveAttribute("data-focus", "true");
        await page.locator("#run-button").focus();
        await page.keyboard.press("Escape");
      }
      await expect(center(page)).toHaveAttribute("data-focus", "false");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => layoutNow(page), "the layout comes back exactly").toEqual(before);
    });
  }

  test("Shift+Alt+Enter is listed in the Shortcuts dialog and the palette, and the palette offers the browser's full screen", async ({ page }) => {
    await openMain(page);
    // Outside the code (Ctrl+/ there comments the line).
    await page.locator("#settings-button").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+/" : "Control+/");
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toContainText("Focus code");
    await expect(dialog).toContainText(/Shift\s*Alt\s*Enter|Shift\s*Option\s*Return/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("F1");
    await page.locator("#palette-input").fill("focus code");
    await expect(page.locator("#palette-list [role=option]").first()).toContainText("Focus code");
    await page.locator("#palette-input").fill("full screen");
    await expect(page.locator("#palette-list [role=option]").first()).toContainText("Full screen");
    await page.keyboard.press("Escape");
  });

  test("under 1100 px there is no focus code, no board splitter and no Output beside", async ({ page }) => {
    await openMain(page, 1440, 900);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator("#focus-code")).toBeHidden();
    await expect(page.locator("#panel-beside")).toBeHidden();
    await expect(page.locator("#chart-hide")).toBeHidden();
    await expect(page.locator(".center > [role=separator][aria-orientation=vertical]:visible")).toHaveCount(0);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Shift+Alt+Enter");
    await expect(center(page)).not.toHaveAttribute("data-focus", "true");
  });
});

test.describe("the console from 1100 px", () => {
  test("the run strip's count is the one way to the problems: no tabs, a heading that names what shows, and Output to go back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await importFiles(page, [{ name: "calc.py", text: "print(1)\nprint(1 / 0)\n" }]);
    await openFromTree(page, "calc.py");
    expect((await run(page)).status).toBe("error");
    await expect(page.locator(".panel-tabs")).toBeHidden();
    const title = page.getByRole("heading", { name: "Output", exact: true });
    await expect(title).toBeVisible();
    await expect(page.locator("#panel-back")).toBeHidden();
    const count = page.locator("#problems-count");
    await expect(count).toHaveAttribute("aria-controls", "panel-problems");
    await expect(count).toHaveAttribute("aria-expanded", "false");
    await count.focus();
    await page.keyboard.press("Enter");
    await expect(count).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#panel-problems")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Problems", exact: true })).toBeVisible();
    await expect(page.locator("#panel-back")).toBeVisible();
    await expect(count).toBeFocused();
    expect(await axe(page), "axe, problems").toEqual([]);
    // The count again goes back too.
    await page.keyboard.press("Enter");
    await expect(page.locator("#panel-output")).toBeVisible();
    await expect(count).toHaveAttribute("aria-expanded", "false");
    // Under 1100 px the tabs come back, and the count is a plain button.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator(".panel-tabs")).toBeVisible();
    await expect(page.locator("#panel-title")).toBeHidden();
    await expect(page.locator("#panel-back")).toBeHidden();
    await expect(count).not.toHaveAttribute("aria-expanded", /.*/);
  });

  test("before the first run the console stays its head, with Input in reach, even once a problem is found; a run opens it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await importFiles(page, [{ name: "warm.py", text: "print('warm')\n" }]);
    await openFromTree(page, "warm.py");
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await setCode(page, "def broken(:\n    pass\n");
    await expect(page.locator(".cm-lint-marker-error")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("#problems-count")).toHaveAttribute("data-tone", "error");
    const panel = page.locator("#panel");
    await expect(panel).toHaveAttribute("data-collapsed", "true");
    await expect(page.locator("#input-toggle")).toBeVisible();
    expect((await box(page, "#panel")).height, "the console is its head").toBeLessThan(140);
    await setCode(page, "print('fixed')\n");
    await run(page);
    await expect(panel).toHaveAttribute("data-collapsed", "false");
    await expect(page.locator("#panel-output")).toBeVisible();
  });
});
