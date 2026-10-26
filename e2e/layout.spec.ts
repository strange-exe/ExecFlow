// Layout v2 (.claude/design/redesign/layout-v2.md, built 2026-10-18): the panel collapsed to its bar
// until the first run, Run stepping back after a failed run, the editor head's error jump and the
// run-log header's lifted exception, the breadcrumb, notices in the status bar, the phone view
// switch without a tab strip, live input on the prompt's line, the grouped file menu and the
// shortcuts dialog's one grid. Every keyboard path these touch is driven with the keyboard.
import type { Page } from "@playwright/test";
import { expect, expectActive, importFiles, openApp, openFromTree, reloadApp, run, setCode, showFiles, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const FILES = [
  { name: "main.py", text: 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n' },
  { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
];
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const runs = async (page: Page) => Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);

/** Run's painted fill, with the pointer moved off it first (a hovered button is never transparent). */
async function runFill(page: Page) {
  await page.mouse.move(4, 4);
  return page.locator("#run-button").evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** Runs main.py (it asks for a name, then fails in calc.py, line 2) and waits for the result. */
async function failedRun(page: Page) {
  const r = await run(page, { input: ["Ada"] });
  expect(r.status, r.output).toBe("error");
}

/** Asks for a line at once, then stays busy for `s` seconds before it ends. */
const askThenBusy = (s: number) => `x = input("Q: ")\nimport time\nt = time.time()\nwhile time.time() - t < ${s}:\n    pass\nprint("got", x)\n`;
/** Prints "start", stays busy for `s` seconds, then asks for a line. */
const busyThenAsk = (s: number) => `import time\nprint("start", flush=True)\nt = time.time()\nwhile time.time() - t < ${s}:\n    pass\nx = input("Q: ")\nprint("got", x)\n`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

test("the panel is its bar until the first run, Ctrl+` opens it, and Run opens it to the remembered height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const toggle = page.locator("#panel-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", "panel-output panel-problems panel-flowchart");
  await expect(page.locator("#panel-output")).toBeHidden();
  await expect(page.locator("#panel-problems")).toBeHidden();
  await expect(page.locator("#panel-flowchart")).toBeHidden();
  // Its 40 px bar, plus the 1 px foot of the editor's sheet (desktop, since the Signal round).
  expect((await box(page, "#panel")).height, "the collapsed panel is its 40 px bar and the sheet's edge").toBe(41);
  expect((await box(page, "#panel .panel-bar")).height).toBe(40);
  expect((await box(page, "#editor-panel")).height, "the code takes the height").toBeGreaterThanOrEqual(700);

  // Ctrl+` opens it and moves the focus in (nothing printed yet: to the Output tab).
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+`");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#panel-output")).toBeVisible();
  await expect(page.locator("#ptab-output")).toBeFocused();

  // A new height from the keyboard, then the toggle collapses it again.
  const splitter = page.getByRole("separator", { name: "Resize the output panel" });
  await splitter.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(splitter).toHaveAttribute("aria-valuenow", "45");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#panel-output")).toBeHidden();
  expect((await box(page, "#panel")).height).toBe(41);

  // Run opens it at the remembered height (45% of the column), and the program's state shows.
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(splitter).toHaveAttribute("aria-valuenow", "45");
  const share = (await box(page, "#panel")).height / ((await box(page, ".center")).height - 1);
  expect(Math.abs(share - 0.45), `panel share ${share}`).toBeLessThan(0.01);
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
});

test("Run steps back after a failed run, keeps its name, shortcut and Ctrl+Enter, and comes back on the next edit or run", async ({ page }) => {
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const app = page.locator("#app");
  const runButton = page.locator("#run-button");
  await expect(app).not.toHaveAttribute("data-last-run");
  const filled = await runFill(page);
  expect(filled, "Run is the filled action").not.toMatch(TRANSPARENT);

  await failedRun(page);
  await expect(app).toHaveAttribute("data-last-run", "failed");
  await expect(runButton).toBeEnabled();
  await expect(runButton).toHaveAccessibleName("Run");
  await expect(runButton).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
  await expect(runButton).toHaveAttribute("title", /^Run \((Ctrl|Cmd)\+Enter\)$/);
  expect(await runFill(page), "after a failure Run is an outline").toMatch(TRANSPARENT);

  // Ctrl+Enter still runs, and the new run clears the step back while it runs.
  const before = await runs(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Enter");
  await expect(app).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(app).not.toHaveAttribute("data-last-run");
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(app).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
  await expect(app).toHaveAttribute("data-last-run", "failed");

  // One typed character brings the filled Run back.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("#");
  await expect(app).not.toHaveAttribute("data-last-run");
  expect(await runFill(page)).toBe(filled);

  // A run that ends well leaves it filled.
  await setCode(page, "print('fine')\n");
  expect((await run(page)).status).toBe("ok");
  await expect(app).not.toHaveAttribute("data-last-run");
  expect(await runFill(page)).toBe(filled);
});

test("after a failed run the error jump comes first in the editor head, and it and the lifted exception open calc.py at line 2", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const jump = page.locator("#error-jump");
  await expect(jump).toBeHidden();
  await failedRun(page);

  // Reading order: in the editor head the jump is the first control after the tab list (one tab
  // stop), then Run, then the quiet Capture snippet button; the runtime words are not a stop.
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Error in calc.py, line 2");
  const stops = await page.locator(".editor-head").evaluate((head) =>
    [...head.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => el.id),
  );
  expect(stops.slice(1), `editor head stops ${stops.join(", ")}`).toEqual(["error-jump", "run-button", "snippet-button"]);
  expect(stops[0]).toMatch(/^tab-/);
  await page.locator('.tabs [role=tab][aria-selected="true"]').focus();
  await page.keyboard.press("Tab");
  await expect(jump).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#run-button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#snippet-button")).toBeFocused();

  // The run-log header: the error band, the facts, and the exception lifted into one button.
  const header = page.locator("#runlog");
  await expect(header).toHaveAttribute("data-failed", "");
  await expect(header.locator("#receipt")).toContainText("Exited with code 1");
  const exception = header.locator("#run-exception");
  await expect(exception).toContainText("ZeroDivisionError: division by zero");
  await expect(exception).toContainText("calc.py, line 2");
  // In the log, only the last line (the exception) is in the danger colour, at 600.
  const paint = await page.evaluate(() => {
    const probe = (v: string) => {
      const s = document.createElement("span");
      s.style.color = `var(${v})`;
      document.body.append(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    };
    const last = document.querySelector("#console .err-last")!;
    const frames = document.querySelector("#console .err")!;
    return { danger: probe("--danger"), fg: probe("--terminal-fg"), last: getComputedStyle(last).color, weight: getComputedStyle(last).fontWeight, frames: getComputedStyle(frames).color, text: last.textContent };
  });
  expect(paint.text).toBe("ZeroDivisionError: division by zero");
  expect(paint.last).toBe(paint.danger);
  expect(paint.weight).toBe("600");
  expect(paint.frames, "traceback frames keep the log's colour").toBe(paint.fg);
  // The stderr bar runs on beside consecutive stderr lines: one bar, not a dash per line (review D,
  // 2026-10-18; dashes are the call site's mark). The pieces of the bar touch or overlap.
  const gaps = await page.locator("#console .err").first().evaluate((el) => {
    const r = [...el.getClientRects()];
    return r.slice(1).map((b, i) => Math.round((b.top - r[i].bottom) * 10) / 10);
  });
  expect(gaps.length, "the traceback spans several lines").toBeGreaterThan(2);
  expect(Math.max(...gaps), `gaps between the bar's pieces: ${gaps.join(", ")}`).toBeLessThanOrEqual(0);

  // Enter on the jump opens calc.py at line 2, the focus in the code, as a Problems row does.
  await jump.focus();
  await page.keyboard.press("Enter");
  await expectActive(page, "calc.py");
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
  await expect(jump, "the error is in this file now").toBeHidden();
  // Back in main.py it shows again; the lifted exception opens the same line.
  await page.locator('.tabs [role=tab][title="main.py"]').click();
  await expect(jump).toBeVisible();
  await exception.click();
  await expectActive(page, "calc.py");
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
  // The next run takes the jump away.
  await page.locator('.tabs [role=tab][title="main.py"]').click();
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(jump).toBeHidden();
});

test("the breadcrumb shows the workspace, the folders and the file, gives way from the left, and a phone shows the name only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const crumb = page.locator(".topbar .crumb");
  await expect(crumb.locator("li")).toHaveText(["Workspace", "main.py"]);
  // The brand is in the top bar here; the drawer's copy of it is for phones only.
  await expect(page.locator(".topbar .brand")).toBeVisible();
  await expect(page.locator("#sidebar .drawer-brand")).toBeHidden();
  // A deep path, made in place (a name with folders makes them).
  const folders = ["course-materials", "semester-two", "week-eleven", "lab-practice", "exercises"];
  const file = "finding_the_largest_value_in_a_list.py";
  const deep = [...folders, file].join("/");
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const name = page.getByRole("textbox", { name: /Name of the new file/ });
  await name.fill(deep);
  await name.press("Enter");
  await expectActive(page, deep);
  await expect(crumb.locator("li")).toHaveText(["Workspace", ...folders, file]);
  await expect(crumb).toHaveAttribute("title", deep);

  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await noOverflow(page), "no horizontal scroll at 1024 px").toBe(true);
  const fit = await crumb.evaluate((ol) => [...ol.querySelectorAll<HTMLElement>(".crumb-text")].filter((t) => t.getClientRects().length > 0).map((t) => ({ text: t.textContent, cut: t.scrollWidth > t.clientWidth + 1 })));
  expect(fit.at(-1), "the file name stays whole").toEqual({ text: file, cut: false });
  expect(fit.slice(0, -1).some((f) => f.cut), `an ancestor gives way: ${JSON.stringify(fit)}`).toBe(true);
  const crumbBox = await box(page, ".topbar .crumb");
  expect(crumbBox.x + crumbBox.width, "the breadcrumb ends before the sync status").toBeLessThanOrEqual((await box(page, "#sync-status")).x);

  // A phone shows the file's name only, after Files. The change of width redraws nothing in the
  // crumb when its path is the same: a rebuild between two reads left this test on a removed node
  // (Linux WebKit, CI 2026-10-23). The same node, marked before, is still there after.
  await crumb.locator(".crumb-file").evaluate((el) => el.setAttribute("data-probe", "kept"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".drawer-toggle")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(crumb.locator(".crumb-file"), "the crumb kept its nodes").toHaveAttribute("data-probe", "kept");
  await expect(crumb.locator(".crumb-file")).toBeVisible();
  await expect(crumb.locator(".crumb-root")).toBeHidden();
  await expect(crumb.locator(".crumb-dir")).toHaveCount(folders.length);
  for (const dir of await crumb.locator(".crumb-dir").all()) await expect(dir).toBeHidden();
  expect((await box(page, ".topbar .crumb-file")).x).toBeGreaterThan((await box(page, ".drawer-toggle")).x);
  expect(await noOverflow(page)).toBe(true);
});

test("notices speak from the status bar: kept rendered while empty, dismissed in place; sync shows once, in the top bar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const notice = page.locator(".statusbar .notice-host > .notice[role=status]");
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveAttribute("data-empty", "true");
  // Sync and save state: the top bar's sync status only.
  await expect(page.locator("#status-sync")).toHaveCount(0);
  const sync = page.locator("#sync-status");
  await expect(sync).toHaveAttribute("data-unsynced", "0");
  await expect(sync).toHaveAccessibleName("Not connected. Your files are saved on this computer. Connect GitHub");
  await expect(sync).toHaveAttribute("title", "Not connected. Your files are saved on this computer. Connect GitHub");

  await importFiles(page, FILES);
  await expect(notice).toHaveAttribute("data-empty", "false");
  await expect(notice).toContainText("Imported 2 files.");
  // One line in the bar (28 px on desktop since the Signal round), between the position and Shortcuts.
  expect((await box(page, ".statusbar")).height).toBe(28);
  await openFromTree(page, "main.py");
  const [pos, words, shortcuts] = [await box(page, "#status-pos"), await box(page, ".notice-text"), await box(page, "#shortcuts-button")];
  expect(pos.x + pos.width).toBeLessThan(words.x);
  expect(words.x + words.width).toBeLessThan(shortcuts.x);
  // From the keyboard (WebKit does not focus a button on click): the dismiss button that had the
  // focus goes with the notice, and the focus is back in the code.
  await notice.getByRole("button", { name: "Dismiss notice" }).focus();
  await page.keyboard.press("Enter");
  await expect(notice).toHaveAttribute("data-empty", "true");
  await expect(notice).toHaveCount(1);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect((await box(page, ".statusbar")).height).toBe(28);
});

test("the file menu is grouped by separators that are not focusable and that the arrow keys skip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await treeItem(page, "main.py").focus();
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  // Open, run and close | new, rename, delete | import and export | Capture snippet | the file list's width.
  const separators = menu.getByRole("separator");
  await expect(separators).toHaveCount(4);
  for (const sep of await separators.all()) {
    expect(await sep.evaluate((el) => {
      (el as HTMLElement).focus();
      return document.activeElement === el || (el as HTMLElement).tabIndex >= 0;
    }), "a separator takes no focus").toBe(false);
  }
  const labels = await menu.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.querySelector(".menu-label")!.textContent));
  // Nothing is selected in main.py: the Capture snippet item names no lines (it explains on click).
  expect(labels).toEqual(["Open", "Run", "Close tab", "Share link...", "New file", "New folder", "New from example...", "Rename", "Delete", "Import files", "Import a folder", "Export workspace (.zip)", "Save as PDF...", "Capture snippet of the selected lines...", "Wider file list", "Narrower file list"]);
  // Down walks every item in order, never a separator, and wraps; Up comes back over them.
  const seen: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    seen.push(await page.evaluate(() => `${document.activeElement?.getAttribute("role")}:${document.activeElement?.querySelector(".menu-label")?.textContent}`));
    await page.keyboard.press("ArrowDown");
  }
  expect(seen).toEqual(labels.map((l) => `menuitem:${l}`));
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "New file" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: /^Share link/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#file-actions")).toBeFocused();
});

test("a menu that opens under a still pointer fills one row, the focused one; a real move hands both to the row under it", async ({ page, browserName }, info) => {
  // 320 x 640: the file menu is taller than the room below its button, so it opens over the button,
  // under the pointer that just clicked it.
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await showFiles(page);
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  const rows = () =>
    menu.getByRole("menuitem").evaluateAll((els) =>
      els.map((e) => ({
        label: e.querySelector(".menu-label")!.textContent!, fill: getComputedStyle(e).backgroundColor, hovered: e.matches(":hover"), focused: e === document.activeElement,
      })),
    );
  const still = await rows();
  info.annotations.push({ type: "rows under a still pointer", description: JSON.stringify(still.filter((r) => r.hovered || r.focused)) });
  // WebKit reports no :hover for a row that appears under a still pointer; the other two do.
  if (browserName !== "webkit") expect(still.some((r) => r.hovered && !r.focused), "precondition: another row lies under the still pointer").toBe(true);
  expect(still.filter((r) => !TRANSPARENT.test(r.fill)).map((r) => r.label), "filled rows").toEqual(["Open"]);
  // A real move onto another row: focus and the fill go there together.
  const target = menu.getByRole("menuitem", { name: /^Rename/ });
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await expect(target).toBeFocused();
  // Polled: the fill changes over the 120 ms state transition.
  await expect.poll(async () => (await rows()).filter((r) => !TRANSPARENT.test(r.fill)).map((r) => r.label), { message: "filled rows after the move" }).toEqual(["Rename"]);
});

test("the shortcuts dialog lines every description up on one x", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.locator("#shortcuts-button").click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  // Search, Run, Files, Editor, Suggestions, Panels.
  await expect(dialog.locator("dl")).toHaveCount(6);
  const xs = await dialog.locator("dd").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(xs.length).toBeGreaterThan(15);
  expect([...new Set(xs)], "every description starts at one x").toHaveLength(1);
});

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Files opened with the focus on the page itself (a dismissed notice, a tap in Safari) puts the focus in the list, every time", async ({ page }) => {
    // WebKit judged the tree row by the drawer's closed (hidden) style when nothing had made it
    // compute the open one yet: from the page body the row didn't take the focus 2 times in 6
    // (2026-10-25 probe). Opened from the code, the editor's blur computed it first.
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
    await openFromTree(page, "main.py");
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(await page.evaluate(() => document.activeElement === document.body), "the focus starts on the page").toBe(true);
      await page.keyboard.press("Control+Shift+E");
      await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), `round ${i}: the focus is in the list`).toBe("treeitem");
      await page.keyboard.press("Escape");
      await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
    }
  });

  test("no tab strip: the drawer marks open files, Alt+W and the file menu's Close tab close them, and one switch moves between Code, Output, Problems and Flowchart", async ({ page }) => {
    await openApp(page);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    await openFromTree(page, "calc.py");
    // No tab list of files on screen; the top bar has Files, the file's name, sync, Run, Settings.
    await expect(page.getByRole("tablist", { name: "Open files" })).toBeHidden();
    await expect(page.locator(".topbar .brand")).toBeHidden();
    await expect(page.locator(".topbar .crumb-file")).toHaveText("calc.py");
    await expect(page.locator(".topbar > #run-button")).toBeVisible();
    expect(Math.round((await box(page, "#editor-panel")).y), "chrome above the code").toBe(92);

    // The drawer marks every file open in a tab, with an icon and a description. Its head carries
    // the brand (layout v2 idea 12: none in the phone top bar, the drawer shows it).
    await showFiles(page);
    const brand = page.locator("#sidebar .drawer-brand");
    await expect(brand).toBeVisible();
    await expect(brand).toHaveText("CodeEditor");
    await expect(brand.locator("svg.brand-mark")).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    for (const path of ["main.py", "calc.py"]) {
      await expect(treeItem(page, path).locator(":scope > .tree-row [data-open]")).toBeVisible();
      await expect(treeItem(page, path)).toHaveAttribute("aria-describedby", /\btree-desc-open\b/);
    }
    await expect(page.locator("#tree-desc-open")).toHaveText("open in a tab");
    await page.keyboard.press("Escape");
    await expect(page.locator(".drawer-toggle")).toBeFocused();

    // Alt+W closes the active file; the drawer no longer marks it.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Alt+w");
    await expectActive(page, "main.py");
    await showFiles(page);
    await expect(treeItem(page, "calc.py").locator("[data-open]")).toHaveCount(0);
    await expect(treeItem(page, "calc.py")).not.toHaveAttribute("aria-describedby", /\btree-desc-open\b/);
    // So does the file menu's Close tab.
    await treeItem(page, "main.py").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: /^Close tab/ }).click();
    await expect(treeItem(page, "main.py").locator("[data-open]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");

    // The view switch: one tab list, arrows (wrapping), Home and End.
    const switcher = page.getByRole("tablist", { name: "View" });
    await expect(switcher.getByRole("tab")).toHaveText(["Code", "Output", "Problems", "Flowchart"]);
    const selected = switcher.locator('[role=tab][aria-selected="true"]');
    await page.locator("#view-code").focus();
    for (const [key, id] of [["ArrowRight", "view-output"], ["ArrowRight", "view-problems"], ["ArrowRight", "view-flowchart"], ["ArrowRight", "view-code"], ["End", "view-flowchart"], ["Home", "view-code"], ["ArrowLeft", "view-flowchart"], ["ArrowLeft", "view-problems"]] as const) {
      await page.keyboard.press(key);
      await expect(selected, key).toHaveAttribute("id", id);
      await expect(page.locator(`#${id}`)).toBeFocused();
    }
    await expect(page.locator("#panel-problems")).toBeVisible();
    await expect(page.locator(".problems-view")).toBeVisible();
    await page.keyboard.press("Home");
    await expect(page.locator("#editor-area")).toBeVisible();
    await expect(page.locator("#panel")).toBeHidden();
  });

  test("live input sits on the prompt's line, named by the prompt; End input is in the header, 44 px; the exception opens the Code view at its line", async ({ page }) => {
    await openApp(page);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    await page.locator("#run-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
    await expect(page.locator("#view-output")).toHaveAttribute("aria-selected", "true");
    const field = page.locator("#live-input-field");
    await expect(field).toBeFocused();
    // Its name holds the visible prompt (first) and what the field is for (WCAG 2.5.3).
    await expect(field).toHaveAccessibleName(/^Name:\s+Input for the program$/);
    await expect(page.getByRole("textbox", { name: "Input for the program" })).toBeFocused();
    // The prompt and the field share one line.
    const prompt = await box(page, "#live-prompt");
    const input = await box(page, "#live-input-field");
    expect(prompt.x + prompt.width, "the field follows the prompt").toBeLessThanOrEqual(input.x);
    expect(Math.abs(prompt.y + prompt.height / 2 - (input.y + input.height / 2)), "on the same line").toBeLessThan(8);
    // End input is in the run-log header, right after the waiting words, and a 44 px target.
    const end = page.locator("#runlog > #live-input-end");
    await expect(end).toBeVisible();
    expect((await box(page, "#live-input-end")).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("#run-status")).toContainText("Waiting for input");
    await expect(page.locator("#run-status")).toContainText("(timer paused)");
    expect((await box(page, "#run-status")).x).toBeLessThan((await box(page, "#live-input-end")).x);

    await field.fill("Ada");
    await field.press("Enter");
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
    // The prompt is back in the log, with the answer after it.
    expect(await page.locator("#console").evaluate((el) => (el as HTMLElement).innerText)).toContain("Name: Ada\nHello, Ada");
    // Problems carries its count in the switch.
    await expect(page.locator("#view-problems .count")).toHaveText("2");
    await expect(page.locator("#view-problems")).toHaveAccessibleName("Problems, 1 error, 1 note");
    // The Problems view is one ground: the list fills it to its foot (review D: it ended at its
    // last row, with the panel's own ground below).
    await page.locator("#view-problems").click();
    await expect(page.locator(".problem").first()).toBeVisible();
    const [list, view] = [await box(page, ".problems-view"), await box(page, "#panel")];
    expect(Math.round(list.y + list.height), "the list reaches the foot of the view").toBe(Math.round(view.y + view.height));
    await page.locator("#view-output").click();
    // The lifted exception: a full-width 44 px button that opens the Code view at calc.py line 2.
    const exception = page.locator("#run-exception");
    const [excBox, header] = [await box(page, "#run-exception"), await box(page, "#runlog")];
    expect(excBox.height).toBeGreaterThanOrEqual(44);
    expect(excBox.width, "full width of the header").toBeGreaterThan(header.width - 40);
    await exception.click();
    await expect(page.locator("#view-code")).toHaveAttribute("aria-selected", "true");
    await expectActive(page, "calc.py");
    await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
    expect(await noOverflow(page)).toBe(true);
  });

  test("with no tab strip, the top bar's file name shows an unsaved file as a tab does: a dot, italics and ', unsaved'", async ({ page }) => {
    await openApp(page);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    // Autosave runs 400 ms after typing stops: record the name the moment it changed.
    await page.evaluate(() => {
      const seen: Record<string, string>[] = [];
      (window as unknown as { crumbSeen: typeof seen }).crumbSeen = seen;
      const crumb = document.querySelector(".topbar .crumb")!;
      new MutationObserver(() => {
        const file = crumb.querySelector<HTMLElement>('.crumb-file[data-dirty="true"]');
        if (!file || seen.length) return;
        seen.push({
          text: file.textContent ?? "",
          italic: getComputedStyle(file.querySelector(".crumb-text")!).fontStyle,
          dot: getComputedStyle(file.querySelector(".dirty-dot")!).display === "none" ? "hidden" : "shown",
        });
      }).observe(crumb, { subtree: true, childList: true, attributes: true });
    });
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("  # edited");
    const seen = () => page.evaluate(() => (window as unknown as { crumbSeen: Record<string, string>[] }).crumbSeen[0] ?? null);
    await expect.poll(seen).not.toBeNull();
    expect(await seen()).toEqual({ text: "main.py, unsaved", italic: "italic", dot: "shown" });
    // Autosave clears it, and the name is the file's name again.
    await expect(page.locator('.topbar .crumb-file[data-dirty="true"]')).toHaveCount(0);
    await expect(page.locator(".topbar .crumb-file")).toHaveText("main.py");
  });
});

// ---------------------------------------------------------------- review findings (2026-10-18)

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`(${name}) a program still running keeps Stop, its output and its input field after its file is closed and deleted`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await importFiles(page, [{ name: "ask.py", text: askThenBusy(3) }]);
    await openFromTree(page, "ask.py");
    const app = page.locator("#app");
    const stop = page.locator("#run-button");
    const field = page.locator("#live-input-field");
    await stop.click();
    await expect(app).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
    await expect(field).toBeFocused();
    // Alt+W closes the only open file while the program waits.
    await page.keyboard.press("Alt+w");
    await expect(page.locator('[data-empty="no-file"]')).toBeAttached();
    await expect(stop, "Stop stays while the program waits").toBeVisible();
    await expect(stop).toHaveAccessibleName("Stop");
    await expect(field).toBeVisible();
    // Deleting the file empties the workspace; the program still waits.
    await showFiles(page);
    await treeItem(page, "ask.py").focus();
    await page.keyboard.press("Delete");
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator('[data-empty="workspace"]')).toBeAttached();
    if (viewport.width < 900) {
      await page.keyboard.press("Escape");
      await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
    }
    await expect(stop, "Stop stays with no files left").toBeVisible();
    await expect(field, "and so does the field the program waits on").toBeVisible();
    await field.fill("Ada");
    await field.press("Enter");
    // Busy for 3 s more: still running, still a Stop.
    await expect(app).toHaveAttribute("data-run", "running");
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAccessibleName("Stop");
    await expect(app).toHaveAttribute("data-run", "idle", { timeout: 30_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok");
    // Nothing runs and nothing is left: the empty workspace leads, with no Run (layout v2).
    await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
    await expect(stop).toBeHidden();
  });
}

for (const how of ["collapsed", "problems", "phone-code"] as const) {
  test(`a program that asks for input while its output is out of view shows the field and focuses it (${how})`, async ({ page }) => {
    await page.setViewportSize(how === "phone-code" ? PHONE : DESKTOP);
    await openApp(page);
    await importFiles(page, [{ name: "ask.py", text: busyThenAsk(5) }]);
    await openFromTree(page, "ask.py");
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await page.locator("#run-button").click();
    await expect(page.locator("#console")).toContainText("start", { timeout: 30_000 });
    if (how === "collapsed") {
      await page.locator("#panel-toggle").click();
      await expect(page.locator("#panel-output")).toBeHidden();
    } else if (how === "problems") {
      await page.locator("#ptab-problems").click();
      await expect(page.locator("#panel-output")).toBeHidden();
    } else {
      await page.locator("#view-code").click();
      await expect(page.locator("#panel")).toBeHidden();
    }
    // The output went out of view while the program was still busy (before it asked).
    await expect(page.locator("#app")).toHaveAttribute("data-run", "running");
    await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
    const field = page.locator("#live-input-field");
    await expect(field, "the field the program waits on is shown").toBeVisible();
    await expect(field, "and has the focus").toBeFocused();
    await field.fill("x");
    await field.press("Enter");
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
  });
}

test("after the error's file is renamed, the lifted exception and the error jump follow it; once it is deleted they go", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await failedRun(page);
  const exception = page.locator("#run-exception");
  const jump = page.locator("#error-jump");
  await expect(exception).toContainText("calc.py, line 2");
  await treeItem(page, "calc.py").focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("textbox", { name: "New name for calc.py" });
  await rename.fill("helpers.py");
  await rename.press("Enter");
  await expect(treeItem(page, "helpers.py")).toBeVisible();
  await expect(page.locator(".problem").filter({ hasText: "helpers.py" }).first()).toBeAttached();
  // The header and the editor head say where the error is now, as Problems does.
  await expect(exception).toContainText("helpers.py, line 2");
  await expect(exception).not.toContainText("calc.py");
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Error in helpers.py, line 2");
  await exception.click();
  await expectActive(page, "helpers.py");
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
  // Deleted: nothing points at it any more; the run still reads as failed.
  await treeItem(page, "helpers.py").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "helpers.py")).toHaveCount(0);
  await expectActive(page, "main.py");
  await expect(exception).toHaveCount(0);
  await expect(jump).toBeHidden();
  await expect(page.locator("#runlog")).toHaveAttribute("data-failed", "");
});

test("the C/C++ download offer opens a collapsed panel once: collapsed again by the user, it stays so on the next visit to a C file", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  // The import opens a.c (the first file it added), with the panel still collapsed to its bar.
  await importFiles(page, [{ name: "a.c", text: "int main(void) { return 0; }\n" }, { name: "b.py", text: "print(1)\n" }]);
  await openFromTree(page, "a.c");
  const toggle = page.locator("#panel-toggle");
  const offer = page.locator(".pack-offer");
  const runtime = page.locator("#status-runtime");
  await expect(runtime).not.toHaveAttribute("data-state", /^(not-loaded|checking)$/, { timeout: 30_000 });
  test.skip((await runtime.getAttribute("data-state")) !== "absent", "the pack is installed in this browser profile");
  await expect(toggle, "the offer opened the panel").toHaveAttribute("aria-expanded", "true");
  await expect(offer).toHaveAttribute("data-state", "offer");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await openFromTree(page, "b.py");
  await expect(offer).toHaveAttribute("data-state", "hidden");
  await page.locator(".tabs [role=tab][title='a.c']").click();
  await expectActive(page, "a.c");
  // The offer is drawn again for a.c (so the decision was made), and the user's collapse is kept.
  await expect(offer).toHaveAttribute("data-state", "offer");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the Input toggle opens its box with the caret in it; Escape closes it and gives the focus back", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const toggle = page.locator("#input-toggle");
  const stdin = page.locator("#stdin");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(stdin, "the box it opened has the caret").toBeFocused();
  await page.keyboard.type("7");
  await page.keyboard.press("Escape");
  await expect(stdin).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(stdin).toBeFocused();
  await expect(stdin).toHaveValue("7");
});

test("the panel's splitter says when the panel is collapsed, and its first key only opens the panel", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const toggle = page.locator("#panel-toggle");
  const splitter = page.getByRole("separator", { name: "Resize the output panel" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(splitter).toHaveAttribute("aria-valuenow", "35");
  await expect(splitter).toHaveAttribute("aria-valuetext", /^Collapsed/);
  await splitter.focus();
  await page.keyboard.press("ArrowUp");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(splitter, "the first key opened the panel and resized nothing").toHaveAttribute("aria-valuenow", "35");
  await expect(splitter).toHaveAttribute("aria-valuetext", "35 percent of the height");
  await page.keyboard.press("ArrowUp");
  await expect(splitter).toHaveAttribute("aria-valuenow", "40");
  await toggle.click();
  await expect(splitter).toHaveAttribute("aria-valuetext", /^Collapsed/);
  await expect(splitter).toHaveAttribute("aria-valuenow", "40");
});

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`(${name}) a file left open comes back in place: never "No file open" first, and nothing in the code area moves`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    // Watch the next load from its first moment: what the centre shows, and every layout shift.
    await page.addInitScript(() => {
      type Shift = { value: number; moved: string[] };
      const w = window as unknown as { seen: string[]; shifts: Shift[] };
      w.seen = [];
      w.shifts = [];
      const note = (what: string) => {
        if (!w.seen.includes(what)) w.seen.push(what);
      };
      new MutationObserver(() => {
        if (document.querySelector('[data-empty="no-file"]')) note("no-file");
        if (document.querySelector(".cm-content")) note("code");
      }).observe(document, { subtree: true, childList: true });
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] })[]) {
            const center = document.querySelector(".center");
            const moved = (entry.sources ?? [])
              .filter((s) => s.node && center?.contains(s.node) && Math.abs(s.previousRect.y - s.currentRect.y) >= 1)
              .map((s) => `${s.node instanceof Element ? `${s.node.tagName.toLowerCase()}#${s.node.id}.${s.node.className}` : s.node?.nodeName} y${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)}`);
            w.shifts.push({ value: entry.value, moved });
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        // The Layout Instability API is Chromium's.
      }
    });
    await reloadApp(page);
    await expectActive(page, "main.py");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const w = window as unknown as { seen: string[]; shifts: { value: number; moved: string[] }[] };
      return { seen: w.seen, shifts: w.shifts };
    });
    info.annotations.push({ type: "start-up", description: JSON.stringify({ seen: result.seen, shifts: result.shifts }) });
    expect(result.seen, "the code came back without a 'No file open' page first").toEqual(["code"]);
    if (info.project.name === "chromium") {
      expect(result.shifts.flatMap((s) => s.moved), "nothing in the code area moved down while the file came back").toEqual([]);
    }
  });
}

for (const viewport of [DESKTOP, { width: 1366, height: 768 }]) {
  test(`Settings at ${viewport.width}x${viewport.height}: the colour theme leads under one heading, the editor options follow on the first screen, and every theme is one fold away`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page);
    await page.locator("#settings-button").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // The editor options are on the first screen (review D: they had moved about 1,300 px down),
    // after the chosen theme, which has the focus.
    const themes = dialog.getByRole("radiogroup");
    const chosen = themes.locator('input[name=theme][value="signal"]');
    await expect(chosen).toBeChecked();
    await expect(chosen).toBeFocused();
    const body = await box(page, "#settings .dialog-body");
    for (const id of ["#set-code-size", "#set-wrap", "#set-ligatures"]) {
      const control = await box(page, id);
      expect(control.y + control.height, `${id} is on the first screen`).toBeLessThanOrEqual(body.y + body.height);
    }
    expect((await box(page, ".theme-option:has(input:checked)")).y).toBeLessThan((await box(page, "#set-code-size")).y);
    // The radio group is named by its section's own heading: no stack of titles above the tiles.
    await expect(themes).toHaveAccessibleName("Colour theme");
    await expect(dialog.locator("h3").first()).toHaveText("Colour theme");
    await expect(dialog.getByRole("heading", { name: "Editor" })).toBeVisible();
    // Every theme is still offered: Slate, the popular ones and the rest are one fold away.
    const more = dialog.locator(".theme-more");
    expect(await more.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    const all = await themes.locator("input[name=theme]").count();
    await more.locator("summary").click();
    for (const id of ["slate-dark", "tokyo-night", "nord"]) await expect(themes.locator(`input[name=theme][value="${id}"]`)).toBeVisible();
    expect(await themes.locator("input[name=theme]").count()).toBe(all);
    expect(all, "every built-in theme").toBeGreaterThanOrEqual(27);
  });
}

test("Settings: a chosen theme from the fold opens it, so the chosen theme is always on show", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  await page.locator("#settings-button").click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator(".theme-more summary").click();
  await dialog.locator('input[name=theme][value="slate-light"]').check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.locator("#settings-button").click();
  await expect(dialog.locator(".theme-more")).toHaveJSProperty("open", true);
  await expect(dialog.locator('input[name=theme][value="slate-light"]')).toBeFocused();
});
