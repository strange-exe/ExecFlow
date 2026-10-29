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
  // Under 1100 px the console docks under the code (Workbench Pro); beside it, the share is a width
  // (e2e/workbench-shell.spec.ts).
  await page.setViewportSize({ width: 1000, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const toggle = page.locator("#panel-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", "panel-output panel-problems panel-flowchart");
  await expect(page.locator("#panel-output")).toBeHidden();
  await expect(page.locator("#panel-problems")).toBeHidden();
  await expect(page.locator("#panel-flowchart")).toBeHidden();
  // Its 44 px head and the Output tab's tool row (Input is given before a first run), inside the
  // card's 1 px edge.
  const collapsedHeight = async () => Math.round((await box(page, "#panel .panel-bar")).height + (await box(page, "#panel .panel-actions")).height + 2);
  expect((await box(page, "#panel .panel-bar")).height).toBe(44);
  await expect(page.locator("#input-toggle")).toBeVisible();
  expect(Math.round((await box(page, "#panel")).height), "the collapsed panel is its head and tool row").toBe(await collapsedHeight());
  expect((await box(page, "#editor-panel")).height, "the code takes the height").toBeGreaterThanOrEqual(600);

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
  expect(Math.round((await box(page, "#panel")).height)).toBe(await collapsedHeight());

  // Run opens it at the remembered height (45% of the two cards' rows), and the program's state shows.
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(splitter).toHaveAttribute("aria-valuenow", "45");
  const share = (await box(page, "#panel")).height / ((await box(page, "#panel")).height + (await box(page, "#editor-area")).height);
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

test("on a Mac the shortcuts are announced with Meta and shown with Cmd, and Meta+P is the key that works", async ({ page }) => {
  // The runners are not Macs (the other specs expect Control): make this page one before it loads.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true }));
  await page.setViewportSize(DESKTOP);
  await openApp(page);
  expect(await page.evaluate(() => navigator.platform), "the page sees a Mac").toBe("MacIntel");
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const runButton = page.locator("#run-button");
  const palette = page.locator("#palette-button");
  await expect(palette).toHaveAttribute("aria-keyshortcuts", "Meta+P Meta+Shift+P F1");
  await expect(palette).toHaveAttribute("title", "Search or run a command (Cmd+P)");
  await expect(page.locator("#quick-search")).toHaveAttribute("aria-keyshortcuts", "Meta+P");
  await expect(runButton).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
  await expect(runButton).toHaveAttribute("title", "Run (Cmd+Enter)");

  // While it runs, Stop is announced with Meta too; after it, Run again.
  await runButton.click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(runButton).toHaveAttribute("aria-keyshortcuts", "Meta+Period");
  await expect(runButton).toHaveAttribute("title", "Stop (Cmd+.)");
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  await expect(runButton).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");

  // The announced key is the one that opens the palette.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+P");
  await expect(page.locator("#palette-input")).toBeFocused();
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
  // stop), and its only other stop. Since the 0.7.0 shell Capture and Run are in the top bar over
  // the editor (the command field, then Capture, then Run); the runtime words are not a stop.
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName("Error in calc.py, line 2");
  const stopsIn = (sel: string) =>
    page.locator(sel).evaluate((head) =>
      [...head.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => el.id),
    );
  const stops = await stopsIn(".editor-head");
  expect(stops.slice(1), `editor head stops ${stops.join(", ")}`).toEqual(["error-jump"]);
  expect(stops[0]).toMatch(/^tab-/);
  expect(await stopsIn(".topbar"), "top bar stops").toEqual(["palette-button", "snippet-button", "run-button"]);
  await page.locator('.tabs [role=tab][aria-selected="true"]').focus();
  await page.keyboard.press("Tab");
  await expect(jump).toBeFocused();
  // The top bar's order by keyboard: the command field, Capture, Run.
  await page.locator("#palette-button").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#snippet-button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#run-button")).toBeFocused();
  // Then on into the editor head: the open file's tab, then the jump.
  await page.keyboard.press("Tab");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(jump).toBeFocused();

  // The run-log header: the error band, the facts, and the exception lifted into one button.
  const header = page.locator("#runlog");
  await expect(header).toHaveAttribute("data-failed", "");
  await expect(header.locator("#receipt")).toContainText("Exited with code 1");
  const exception = header.locator("#run-exception");
  await expect(exception).toContainText("ZeroDivisionError: division by zero");
  await expect(exception).toContainText("calc.py, line 2");
  // In the log, only the last line (the exception) is in the danger colour, at 600. The tokens are read
  // inside the console, which has its own (dark) colours in both schemes.
  const paint = await page.evaluate(() => {
    const probe = (v: string) => {
      const s = document.createElement("span");
      s.style.color = `var(${v})`;
      document.querySelector("#console")!.append(s);
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

test("the breadcrumb shows the folders and the file, gives way from the left, and a phone shows the name only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const crumb = page.locator(".topbar .crumb");
  // Workbench Pro: the breadcrumb starts with the workspace's name (the one heading the sidebar),
  // then the folders and the file; the app's mark heads the rail.
  // The "/" between segments is decorative (aria-hidden): compare each segment's own words.
  await expect(crumb.locator("li > .crumb-text")).toHaveText(["Workspace", "main.py"]);
  await expect(page.locator("#sidebar .ws-switcher #ws-name")).toHaveText("Workspace");
  await expect(page.locator(".rail > .rail-mark > svg.brand-mark")).toBeVisible();
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
  await expect(crumb.locator("li > .crumb-text")).toHaveText(["Workspace", ...folders, file]);
  await expect(crumb.locator(".crumb-sep")).toHaveCount(folders.length + 1);
  for (const sep of await crumb.locator(".crumb-sep").all()) await expect(sep).toHaveAttribute("aria-hidden", "true");
  await expect(crumb).toHaveAttribute("title", deep);

  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await noOverflow(page), "no horizontal scroll at 1024 px").toBe(true);
  const fit = await crumb.evaluate((ol) => [...ol.querySelectorAll<HTMLElement>(".crumb-text")].filter((t) => t.getClientRects().length > 0).map((t) => ({ text: t.textContent, cut: t.scrollWidth > t.clientWidth + 1 })));
  // Since the 0.7.0 shell the top bar also holds the command field (160 px at least), the runtime
  // words, Capture and Run, so a 38-character name may lose part of its stem at 1024 px; it still
  // reads: at least 120 px of it (about 15 characters) with its extension whole, and the folders
  // give way first. (Before this rule the bar left the file 0 px: a lone "c" by the field.)
  const fileBox = await box(page, ".topbar .crumb-file .crumb-name");
  expect(fileBox.width, "the file name keeps room to be read").toBeGreaterThanOrEqual(Math.min(120, (await crumb.locator(".crumb-name").evaluate((e) => [...e.children].reduce((sum, c) => sum + c.scrollWidth, 0)))));
  const ext = await box(page, ".topbar .crumb-file .crumb-ext");
  expect(ext.width, "the extension is shown").toBeGreaterThan(0);
  expect(ext.x + ext.width, "the extension is whole").toBeLessThanOrEqual(fileBox.x + fileBox.width + 1);
  expect(fit.at(-1)?.text).toBe(file);
  expect(fit.slice(0, -1).some((f) => f.cut), `an ancestor gives way: ${JSON.stringify(fit)}`).toBe(true);
  if (fit.at(-1)?.cut) expect(fit.slice(0, -1).every((f) => f.cut), `the file is cut only after every folder: ${JSON.stringify(fit)}`).toBe(true);
  const crumbBox = await box(page, ".topbar .crumb");
  // The sync status is in the sidebar's foot now; the breadcrumb gives way to the command field.
  expect(crumbBox.x + crumbBox.width, "the breadcrumb ends before the command field").toBeLessThanOrEqual((await box(page, "#palette-button")).x);

  // A phone shows the file's name only, after the app's mark. The change of width redraws nothing in the
  // crumb when its path is the same: a rebuild between two reads left this test on a removed node
  // (Linux WebKit, CI 2026-10-23). The same node, marked before, is still there after.
  await crumb.locator(".crumb-file").evaluate((el) => el.setAttribute("data-probe", "kept"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".view-bar .drawer-toggle")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(crumb.locator(".crumb-file"), "the crumb kept its nodes").toHaveAttribute("data-probe", "kept");
  await expect(crumb.locator(".crumb-file")).toBeVisible();
  await expect(crumb.locator(".crumb-dir")).toHaveCount(folders.length);
  for (const dir of await crumb.locator(".crumb-dir").all()) await expect(dir).toBeHidden();
  await expect(crumb.locator(".crumb-root")).toBeHidden();
  const markBox = await box(page, ".topbar .brand-mark");
  expect((await box(page, ".topbar .crumb-file")).x).toBeGreaterThanOrEqual(markBox.x + markBox.width);
  expect(await noOverflow(page)).toBe(true);
});

test("notices speak from the sidebar's foot: kept rendered while empty, dismissed in place; sync shows once, in the foot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  // 0.7.0 shell: no status bar on desktop; the notice slot is in the sidebar's foot, over the sync
  // status, Shortcuts and Settings (layout.ts place()).
  await expect(page.locator(".statusbar")).toBeHidden();
  const notice = page.locator(".sidebar-foot .notice-host > .notice[role=status]");
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveAttribute("data-empty", "true");
  // Sync and save state: the foot's sync status only.
  await expect(page.locator("#status-sync")).toHaveCount(0);
  const sync = page.locator(".sidebar-foot #sync-status");
  await expect(sync).toHaveAttribute("data-unsynced", "0");
  await expect(sync).toHaveAccessibleName("Not connected. Your files are saved on this computer. Connect GitHub");
  await expect(sync).toHaveAttribute("title", "Not connected. Your files are saved on this computer. Connect GitHub");

  await importFiles(page, FILES);
  await expect(notice).toHaveAttribute("data-empty", "false");
  await expect(notice).toContainText("Imported 2 files.");
  await openFromTree(page, "main.py");
  // On screen, inside the sidebar, over the sync status and About (Shortcuts is in the rail since
  // Workbench Pro); the foot keeps to the window's bottom edge (the tree gives up the room).
  await expect(notice).toBeInViewport();
  const [side, words, syncBox, about, foot] = [await box(page, "#sidebar"), await box(page, ".notice-text"), await box(page, "#sync-status"), await box(page, "#about-link"), await box(page, ".sidebar-foot")];
  expect(words.x).toBeGreaterThanOrEqual(side.x);
  expect(words.x + words.width).toBeLessThanOrEqual(side.x + side.width);
  expect(words.y + words.height).toBeLessThanOrEqual(syncBox.y);
  expect(words.y + words.height).toBeLessThanOrEqual(about.y);
  expect(Math.round(foot.y + foot.height)).toBe(900);
  // From the keyboard (WebKit does not focus a button on click): the dismiss button that had the
  // focus goes with the notice, and the focus is back in the code.
  await notice.getByRole("button", { name: "Dismiss notice" }).focus();
  await page.keyboard.press("Enter");
  await expect(notice).toHaveAttribute("data-empty", "true");
  await expect(notice).toHaveCount(1);
  await expect(page.locator(".cm-content")).toBeFocused();
  expect(Math.round((await box(page, ".sidebar-foot")).y + (await box(page, ".sidebar-foot")).height)).toBe(900);
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
    // No tab list of files on screen; the top bar has the app's mark and the file's name at its
    // start, and Search, sync, Run and Settings at its end (Workbench Pro: Files is in the view bar).
    await expect(page.getByRole("tablist", { name: "Open files" })).toBeHidden();
    await expect(page.locator(".topbar .topbar-start > svg.brand-mark")).toBeVisible();
    await expect(page.locator(".topbar .drawer-toggle")).toHaveCount(0);
    await expect(page.locator(".topbar .crumb-file")).toHaveText("calc.py");
    const ends = await page.locator(".topbar .topbar-end").evaluate((el) => [...el.children].filter((c) => c.getClientRects().length > 0).map((c) => c.id || c.className));
    expect(ends).toEqual(["palette-button", "sync-slot", "run-button", "settings-button"]);
    await expect(page.locator(".topbar #run-button")).toBeVisible();
    expect(Math.round((await box(page, "#editor-panel")).y), "chrome above the code: the top bar only").toBe(48);

    // The drawer marks every file open in a tab, with an icon and a description. Its head carries
    // the workspace (the app's mark is in the top bar).
    await showFiles(page);
    const brand = page.locator("#sidebar .ws-switcher");
    await expect(brand).toBeVisible();
    await expect(brand.locator("#ws-name")).toHaveText("Workspace");
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
    // Nothing runs and nothing is left: the empty workspace leads, and Run is back, disabled
    // (Workbench Pro item 7: named Run again, not Stop).
    await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
    await expect(stop).toHaveAttribute("aria-disabled", "true");
    await expect(stop).toHaveAccessibleName("Run");
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
  // Under 1100 px, where the console docks under the code (the x-axis splitter beside it does the
  // same: e2e/design.spec.ts "splitters are separators").
  await page.setViewportSize({ width: 1000, height: 800 });
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
    // 0.7.0 Settings: the sections list beside the pane is on the first screen, so the Editor options
    // are one choice away whatever the height. The first three are on the first screen (the
    // dialog's legal foot now takes a line: the options after them, from "Enter accepts the top
    // suggestion" (2026-10-28) on, start below it).
    const nav = dialog.getByRole("navigation", { name: "Settings sections" });
    await expect(nav.getByRole("button", { name: "Editor" })).toBeInViewport();
    const body = await box(page, "#settings .dialog-body");
    for (const id of ["#set-code-size", "#set-wrap", "#set-suggest"]) {
      const control = await box(page, id);
      expect(control.y + control.height, `${id} is on the first screen`).toBeLessThanOrEqual(body.y + body.height);
    }
    expect((await box(page, ".theme-option:has(input:checked)")).y).toBeLessThan((await box(page, "#set-code-size")).y);
    // 0.7.0 Settings: the first section is Appearance; "Colour theme" is the radio group's own
    // visible label under it (settings-dialog.ts #theme-title), then the Editor section.
    await expect(themes).toHaveAccessibleName("Colour theme");
    await expect(dialog.locator("h3").first()).toHaveText("Appearance");
    await expect(dialog.getByRole("heading", { name: "Editor" })).toBeVisible();
    // Every theme is still offered: Slate, the popular ones and the rest are one fold away.
    const more = dialog.locator(".theme-more");
    expect(await more.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    const all = await themes.locator("input[name=theme]").count();
    await more.locator("summary").click();
    for (const id of ["slate-dark", "tokyo-night", "nord"]) await expect(themes.locator(`input[name=theme][value="${id}"]`)).toBeVisible();
    expect(await themes.locator("input[name=theme]").count()).toBe(all);
    expect(all, "every built-in theme").toBeGreaterThanOrEqual(27);
    // Editor in the list brings every editor option on screen, its heading focused.
    await nav.getByRole("button", { name: "Editor" }).click();
    await expect(dialog.getByRole("heading", { name: "Editor" })).toBeFocused();
    const pane = await box(page, "#settings .dialog-body");
    for (const id of ["#set-code-size", "#set-wrap", "#set-suggest", "#set-enter-top", "#set-ligatures"]) {
      const control = await box(page, id);
      expect(control.y, `${id} below the pane's top`).toBeGreaterThanOrEqual(pane.y);
      expect(control.y + control.height, `${id} in the pane`).toBeLessThanOrEqual(pane.y + pane.height);
    }
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
