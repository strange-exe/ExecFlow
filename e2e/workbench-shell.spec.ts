// Workbench Pro, stage S2 "Shell" (.claude/design/redesign5/a/design.md, "Layout changes against
// today" items 1-8): the console card beside the code from 1100 px with an x-axis splitter, the
// activity rail, the breadcrumb top bar that hides Capture and the runtime state with no file and
// shows Run disabled, the empty workspace's one primary action over a ruled list, and the phone's
// bottom view bar. Every keyboard path is driven with the keyboard.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, reloadApp, run, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const FAILS = [{ name: "main.py", text: "print(1)\nprint(1 / 0)\n" }];
/** The console's x-axis splitter (the y-axis one is the other `separator` controlling the panel). */
const xSplit = (page: Page) => page.locator('.center > [role=separator][aria-orientation="vertical"]');

async function withRun(page: Page) {
  await openApp(page);
  await importFiles(page, FAILS);
  await openFromTree(page, "main.py");
  const r = await run(page);
  expect(r.status, r.output).toBe("error");
}

/** The action colour, resolved the way a computed background is. */
const actionColour = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--action)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });

test.describe("desktop", () => {
  test.beforeEach(({ page }) => page.setViewportSize({ width: 1440, height: 900 }));

  test("from 1100 px the console card sits beside the code, and its x-axis splitter resizes it from the keyboard and remembers the share", async ({ page }) => {
    await withRun(page);
    const split = xSplit(page);
    await expect(split).toBeVisible();
    await expect(split).toHaveAttribute("aria-controls", "panel");
    await expect(split).toHaveAccessibleName("Resize the output panel");
    // The y-axis splitter of the stacked layout is out of reach here (not shown, so not a Tab stop).
    await expect(page.locator('.center > [role=separator][aria-orientation="horizontal"]')).toBeHidden();
    const code = await box(page, "#editor-area");
    const con = await box(page, "#panel");
    expect(con.x, "the console is right of the code").toBeGreaterThan(code.x + code.width);
    expect(Math.abs(con.y - code.y), "the two cards share a top edge").toBeLessThan(2);
    expect(con.height, "the console runs the work area's full height").toBeGreaterThan(code.height - 2);
    // The value is the console's share of the width, in percent, between its min and max.
    const value = async () => Number(await split.getAttribute("aria-valuenow"));
    expect(await split.getAttribute("aria-valuemin")).toBe("20");
    expect(await split.getAttribute("aria-valuemax")).toBe("80");
    const start = await value();
    expect(start).toBe(46);
    // ArrowLeft moves the bar left: the console grows; ArrowRight gives the width back.
    await split.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await value()).toBe(start + 2);
    expect((await box(page, "#panel")).width, "the console is wider").toBeGreaterThan(con.width + 10);
    await page.keyboard.press("ArrowRight");
    expect(await value()).toBe(start);
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await value(), "Shift takes four steps").toBe(start + 8);
    await page.keyboard.press("Home");
    expect(await value()).toBe(20);
    await page.keyboard.press("End");
    expect(await value()).toBe(80);
    await page.keyboard.press("Enter");
    expect(await value(), "Enter restores the default").toBe(46);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    // The share is kept on this device.
    await reloadApp(page);
    await openFromTree(page, "main.py");
    await page.locator("#ptab-output").click();
    await expect(xSplit(page)).toHaveAttribute("aria-valuenow", "50");
  });

  test("under 1100 px the console docks under the code again, with the y-axis splitter", async ({ page }) => {
    await withRun(page);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(xSplit(page)).toBeHidden();
    await expect(page.locator('.center > [role=separator][aria-orientation="horizontal"]')).toBeVisible();
    const code = await box(page, "#editor-area");
    const con = await box(page, "#panel");
    expect(con.y, "the console is under the code").toBeGreaterThanOrEqual(code.y + code.height);
  });

  test("the activity rail holds Files, Search, Flowchart and New file, with Shortcuts and Settings at its foot; Files hides and shows the file list", async ({ page }) => {
    await openApp(page);
    await importFiles(page, FAILS);
    const rail = page.getByRole("navigation", { name: "Activity" });
    await expect(rail).toBeVisible();
    const names = await rail.getByRole("button").evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()));
    expect(names).toEqual(["Files", "Search", "Flowchart", "New file", "Shortcuts", "Settings"]);
    const r = await box(page, ".rail");
    expect(Math.round(r.x)).toBe(0);
    expect(Math.round(r.width)).toBe(64);
    // Shortcuts and Settings sit at the rail's foot.
    const settings = await box(page, "#settings-button");
    expect(settings.y + settings.height).toBeGreaterThan(900 - 80);
    // The file list sits beside the rail, and the About link stays in its foot.
    const side = await box(page, "#sidebar");
    expect(side.x).toBeGreaterThanOrEqual(r.x + r.width - 1);
    await expect(page.locator(".sidebar-foot a[href='/about']")).toBeVisible();
    // Files hides the list (the work area takes its room) and shows it again, with the keyboard.
    const files = rail.getByRole("button", { name: "Files" });
    await expect(files).toHaveAttribute("aria-expanded", "true");
    await files.focus();
    await page.keyboard.press("Enter");
    await expect(files).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#sidebar")).toBeHidden();
    expect((await box(page, ".topbar")).x).toBeLessThan(r.x + r.width + 2);
    await page.keyboard.press("Enter");
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(files).toHaveAttribute("aria-expanded", "true");
  });

  test("a failed run's header: the exit with an icon, one error chip that opens the line, and the help inset, with no red band", async ({ page }) => {
    await withRun(page);
    const header = page.locator("#runlog");
    await expect(header).toHaveAttribute("data-failed", "");
    // No band: the header's ground is the console's, not the error band.
    const band = await header.evaluate((el) => getComputedStyle(el, "::before").content);
    expect(band === "none" || band === "normal").toBe(true);
    expect(await header.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("0px");
    const chip = page.locator("#run-exception");
    await expect(chip).toContainText("ZeroDivisionError");
    await expect(chip).toContainText("main.py, line 2");
    // The chip takes its own line, as wide as the header's content.
    const h = await box(page, "#runlog");
    const c = await box(page, "#run-exception");
    expect(c.width).toBeGreaterThan(h.width * 0.8);
    const help = page.locator("#runlog > .err-help");
    await expect(help).toBeVisible();
    expect(await help.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    await chip.click();
    await expect(page.locator(".cm-activeLine")).toContainText("print(1 / 0)");
  });

  test("the panel tabs are a segmented control with full screen and hide at the head's end; Input, Restart and Clear show on Output only", async ({ page }) => {
    await withRun(page);
    const head = page.locator("#panel .panel-bar");
    await expect(head.locator('[role=tablist][aria-label="Panel"]')).toBeVisible();
    // Full screen, then hide, end the head.
    const max = await box(page, "#panel-max");
    const hide = await box(page, "#panel-toggle");
    const bar = await box(page, "#panel .panel-bar");
    expect(max.x).toBeLessThan(hide.x);
    expect(bar.x + bar.width - (hide.x + hide.width)).toBeLessThan(16);
    await expect(page.locator("#clear-output")).toBeVisible();
    await page.locator("#ptab-problems").click();
    await expect(page.locator("#clear-output")).toBeHidden();
    await expect(page.locator("#input-toggle")).toBeHidden();
    await page.locator("#ptab-output").click();
    await expect(page.locator("#input-toggle")).toBeVisible();
  });
});

// Found in S3's review shots: with a C file open before the compiler's one-time download, the
// runtime's words ("C/C++ needs a one-time download") kept the top bar's end at its full width, so
// the page scrolled sideways (146 px at 900, 7 px at 1100) and Run was cut off at the right edge.
test.describe("the top bar with a long runtime state", () => {
  for (const width of [900, 1000, 1099, 1100, 1279, 1280, 1366, 1440]) {
    test(`${width} px: the page never scrolls sideways and Run stays whole; the words stay in the name`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page);
      await importFiles(page, [{ name: "main.c", text: "int main(void) {\n    return 0;\n}\n" }]);
      await openFromTree(page, "main.c");
      const runtime = page.locator(".topbar #status-runtime");
      await expect(runtime).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
      await expect(runtime).toContainText("C/C++ needs a one-time download");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      const run = await box(page, "#run-button");
      expect(run.x + run.width, "Run inside the window").toBeLessThanOrEqual(width + 0.5);
      // Shortened on screen, the full words are still its text and its tooltip.
      await expect(runtime).toHaveAttribute("title", "C/C++ needs a one-time download");
    });
  }
});

test.describe("an empty workspace", () => {
  test.beforeEach(({ page }) => page.setViewportSize({ width: 1440, height: 900 }));

  test("one blue New file over a ruled list; Capture and the runtime state hidden; Run shown but disabled until a file is open", async ({ page }) => {
    await openApp(page);
    const empty = page.locator("#editor-empty");
    const primary = empty.getByRole("button", { name: "New file" });
    await expect(primary).toBeVisible();
    await page.mouse.move(4, 4);
    expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await actionColour(page));
    // The other ways in, in order, as one ruled list (not cards).
    const list = empty.getByRole("list", { name: "Other ways to start" });
    await expect(list.getByRole("button")).toHaveText([/^New from example/, /^Import files/, /^Import a folder/, /^Connect GitHub/]);
    // No file: no Capture, no runtime state, and Run disabled (still named Run, still reachable).
    await expect(page.locator("#snippet-button")).toBeHidden();
    await expect(page.locator("#status-runtime")).toBeHidden();
    const runButton = page.locator("#run-button");
    await expect(runButton).toBeVisible();
    await expect(runButton).toHaveAttribute("aria-disabled", "true");
    await expect(runButton).toHaveAccessibleName(/^Run/);
    expect(await runButton.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await actionColour(page));
    // The breadcrumb names the workspace alone.
    await expect(page.locator(".crumb")).toHaveText("Workspace", { useInnerText: true });
    // New file starts a name in the tree, from the keyboard.
    await primary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".tree-input")).toBeFocused();
    await page.keyboard.type("hello.py");
    await page.keyboard.press("Enter");
    await expect(runButton).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#snippet-button")).toBeVisible();
    await expect(page.locator(".crumb")).toHaveText(/Workspace\s*\/\s*hello\.py/);
  });
});

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a bottom view bar: Files, Code, Output, Problems with its count, Flowchart; 52 px items; Run is 44 px", async ({ page }) => {
    await withRun(page);
    const bar = page.getByRole("navigation", { name: "Views" });
    await expect(bar).toBeVisible();
    const b = await box(page, ".view-bar");
    expect(Math.round(b.y + b.height), "the bar ends the screen").toBe(844);
    const items = bar.locator("button");
    await expect(items).toHaveText(["Files", "Code", "Output", /^Problems\s*1$/, "Flowchart"]);
    for (const el of await items.all()) expect(Math.round((await el.boundingBox())!.height)).toBeGreaterThanOrEqual(52);
    expect(Math.round((await box(page, "#run-button")).height)).toBe(44);
    // The views are tabs, moved with the arrow keys; Files opens the drawer and closes it again.
    const output = page.locator("#view-output");
    await output.click();
    await expect(output).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#console")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#view-problems")).toBeFocused();
    await expect(page.locator("#view-problems")).toHaveAttribute("aria-selected", "true");
    const files = bar.getByRole("button", { name: "Files" });
    await files.click();
    await expect(files).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#sidebar")).toBeInViewport();
    // The bar stays above the drawer: Files closes it.
    await files.click();
    await expect(files).toHaveAttribute("aria-expanded", "false");
    // The About link is in the status bar here.
    await expect(page.locator(".statusbar a[href='/about']")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
