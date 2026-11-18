// The Workbench shell, stage 2 (.claude/design/DESIGN.md, the mock in .claude/design/editor9/a):
// from 1100 px the rail (Files, Search, Source control, Flowchart, New file) and the files sidebar
// stay. The run strip at the code's foot holds Run, then Input and Arguments; the console's head
// has the Output | Problems tabs (Problems with its count) and the run's outcome; the status bar
// shows the language, Ln/Col, Spaces, UTF-8, the runtime state and the theme; the top bar holds the
// breadcrumb, Search, the sync status and Layout, Shortcuts, Settings and About as words. It
// replaced Flow Board S2's Files popover and run-strip count (redesign 7). Under 1100 px nothing
// changes. Every keyboard path is driven with the keyboard.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const OK = { name: "main.py", text: 'print("hi")\n' };
const FAILS = { name: "calc.py", text: "print(1)\nprint(1 / 0)\n" };
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const files = (page: Page) => page.locator(".drawer-toggle");

/** A colour token resolved the way a computed colour is. */
const token = (page: Page, name: string) =>
  page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${v})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

test.describe("from 1100 px", () => {
  test.beforeEach(({ page }) => page.setViewportSize({ width: 1440, height: 900 }));

  test("the run strip is the code's foot: Run, then Input and Arguments, above the console's tabs", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const strip = page.locator("#panel > .run-strip");
    await expect(strip).toBeVisible();
    // The DOM order is the reading and the Tab order: then the stepper and its variables row (stage 3b).
    const order = await strip.evaluate((el) => [...el.children].map((c) => c.id || c.className));
    expect(order).toEqual(["run-button", "run-tools", "run-steps", "run-vars"]);
    expect(await strip.locator(".run-tools").evaluate((el) => [...el.children].map((c) => c.id))).toEqual(["input-toggle", "args-button"]);
    await expect(page.locator("#args-button")).toBeVisible();
    const [s, bar, code] = await Promise.all([box(page, "#panel > .run-strip"), box(page, ".panel-bar"), box(page, "#editor-area")]);
    expect(s.y, "under the code").toBeGreaterThanOrEqual(code.y + code.height);
    expect(bar.y, "over the console's tabs").toBeGreaterThanOrEqual(s.y + s.height - 1);
    expect(Math.round(s.height), "a 48 px strip").toBe(48);
    // Run is the one filled control; Input and Arguments are quiet (no fill).
    const fill = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill("#run-button")).toBe(await token(page, "action"));
    for (const sel of ["#input-toggle", "#args-button"]) expect(await fill(sel), sel).toBe("rgba(0, 0, 0, 0)");
    // A notice (the import's) floats over the code board's foot, inside the board, and never moves
    // the code: the code's box is the same with it and without it.
    const notice = page.locator("#editor-area > .notice-host > .notice[role=status]");
    await expect(notice).toContainText("Imported");
    const [n, panelBox] = [await box(page, "#editor-area > .notice-host > .notice"), await box(page, "#editor-panel")];
    expect(n.x + n.width, "inside the board").toBeLessThanOrEqual(code.x + code.width);
    expect(n.y + n.height, "over the code, above the board's foot").toBeLessThanOrEqual(code.y + code.height);
    await notice.locator(":scope > .icon-btn").click();
    await expect(notice).toHaveAttribute("data-empty", "true");
    expect(await box(page, "#editor-panel"), "the code did not move").toEqual(panelBox);
    // Run and the runtime state left the top bar; the runtime state is in the status bar.
    await expect(page.locator(".topbar #run-button, .topbar #status-runtime")).toHaveCount(0);
    await expect(page.locator(".statusbar #status-runtime")).toHaveCount(1);
    const r = await run(page);
    expect(r.status, r.output).toBe("ok");
    // The outcome, as the run-log header shows it under 1100 px, now at the console head's end.
    const receipt = page.locator(".panel-bar .run-outcome #receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveText(/Finished.*exit code 0.*ran in/);
    await expect(page.locator("#runlog .rl-file")).toHaveText("main.py");
    // The count lives on the Problems tab; the strip's count is a phone's (the dock's foot) only.
    await expect(page.locator("#problems-count")).toHaveCount(0);
    await expect(page.locator("#ptab-problems")).toBeVisible();
    // Keyboard: Run, Input, then Arguments.
    await page.locator("#run-button").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#input-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#args-button")).toBeFocused();
    // Arguments opens the Input box with the caret in the Arguments field.
    await page.keyboard.press("Enter");
    await expect(page.locator("#args-field")).toBeFocused();
    await expect(page.locator("#input-toggle")).toHaveAttribute("aria-expanded", "true");
    // Every control on the strip is 24 px or more.
    for (const sel of ["#run-button", "#input-toggle", "#args-button"]) {
      const b = await box(page, sel);
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(24);
    }
  });

  test("the Problems tab carries the count, in the danger colour while there are errors, and opens the list (pointer and keyboard)", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK, FAILS]);
    await openFromTree(page, "calc.py");
    const r = await run(page);
    expect(r.status, r.output).toBe("error");
    const tab = page.locator("#ptab-problems");
    const count = tab.locator(".count");
    await expect(count).toHaveText(/^\d+$/);
    expect(await count.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "danger"));
    // The line marks stay in the editor.
    await expect(page.locator(".cm-lintRange-error, .cm-lint-marker-error").first()).toBeVisible();
    // With another file active, the editor head's stops, in order: the open file's tab, the error
    // jump (shown only while the error is in a file other than the active one), Share, Capture,
    // then Focus (the Flowchart toggle shows only while the chart board is hidden). The code board is
    // about 580 px here, so the strip may also show "1 more" after the tabs (tabs.ts).
    await openFromTree(page, "main.py");
    await expect(page.locator("#error-jump")).toBeVisible();
    const stops = await page.locator(".editor-head").evaluate((head) =>
      [...head.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => (el.matches(".tabs-more") ? "more" : el.id)),
    );
    expect(stops[0]).toMatch(/^tab-/);
    expect(stops.slice(1).filter((s) => s !== "more")).toEqual(["error-jump", "share-button", "snippet-button", "focus-code"]);
    // The tabs show the list: pointer, then the arrow keys and Enter.
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#panel-problems")).toBeVisible();
    await page.locator("#ptab-output").click();
    await expect(page.locator("#panel-output")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(tab).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await axe(page), "axe after a failed run").toEqual([]);
  });

  test("the rail and the files sidebar stay: Files toggles the sidebar, and the rail's icons are named and 24 px or more", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK, FAILS]);
    await expect(page.locator("#files-popover")).toHaveCount(0);
    const rail = page.getByRole("navigation", { name: "Activity" });
    await expect(rail).toBeVisible();
    await expect(page.locator(".main > #sidebar")).toBeVisible();
    // Files, Search, Source control, Flowchart, New file: in this order, each named by its word.
    const names = await rail.evaluate((el) => [...el.querySelectorAll<HTMLElement>(":scope > button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()));
    expect(names).toEqual(["Files", "Search", "Source control", "Flowchart", "New file"]);
    for (const b of await rail.locator(":scope > button").all()) {
      const r = (await b.boundingBox())!;
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(24);
    }
    // The Files header: New file, New folder, Import files, then the menu.
    expect(await page.locator(".sidebar-actions").evaluate((el) => [...el.children].map((c) => c.id))).toEqual(["new-file", "new-folder", "import-files", "file-actions"]);
    await expect(files(page)).toHaveAttribute("aria-controls", "sidebar");
    await expect(files(page)).toHaveAttribute("aria-expanded", "true");
    await expect(files(page)).not.toHaveAttribute("aria-haspopup");
    expect(await axe(page), "axe with the sidebar shown").toEqual([]);
    // Files hides the sidebar (the code takes its room) and shows it again, from the keyboard too.
    await files(page).click();
    await expect(files(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#sidebar")).toBeHidden();
    await files(page).focus();
    await page.keyboard.press("Enter");
    await expect(files(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#sidebar")).toBeVisible();
    // Choosing a file keeps the sidebar and takes the focus to the code.
    await openFromTree(page, "calc.py");
    await expect(page.locator("#sidebar")).toBeVisible();
  });

  test("the Files menu: Escape closes only the menu; Import files is one press in the header", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await page.locator("#file-actions").click();
    const menu = page.getByRole("menu", { name: "File actions" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#file-actions")).toBeFocused();
    // Import files opens the browser's file chooser.
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#import-files").click();
    expect((await chooser).isMultiple()).toBe(true);
  });

  test("the top bar: the mark, the breadcrumb, Search, the sync status, then Layout, Shortcuts, Settings and About as words; Source control is the sync status's press", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const top = page.locator(".topbar");
    await expect(top.locator(".brand-mark")).toBeVisible();
    await expect(top.getByRole("list", { name: "Open file" })).toContainText("main.py");
    for (const name of ["Search or run a command", "Layout", "Shortcuts", "Settings"]) {
      const control = top.getByRole("button", { name, exact: true });
      await expect(control, name).toBeVisible();
      const b = (await control.boundingBox())!;
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(24);
    }
    await expect(top.getByRole("link", { name: "About ExecFlow" })).toBeVisible();
    await expect(top.locator("#sync-slot")).toBeVisible();
    // Capture and Share are the code board's tab bar's words now, beside Focus.
    await expect(page.locator(".editor-head #snippet-button")).toBeVisible();
    await expect(page.locator(".editor-head #share-button")).toBeVisible();
    await expect(page.locator("#chart-board")).toBeVisible();
    // Settings opens from the keyboard and gives the focus back.
    await top.getByRole("button", { name: "Settings", exact: true }).press("Enter");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-button")).toBeFocused();
    // Source control (not connected): the Connect GitHub dialog, the focus back on the rail's button.
    await page.locator("#quick-source").click();
    await expect(page.getByRole("dialog", { name: "Connect GitHub" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#quick-source")).toBeFocused();
    // New file on the rail starts a name in the sidebar.
    await page.locator("#quick-new-file").click();
    await expect(page.locator("#sidebar .tree-input")).toBeFocused();
  });

  test("the status bar: language, Ln/Col, Spaces, UTF-8, the runtime state and the theme, in mono; the theme opens Settings", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const bar = page.locator(".statusbar");
    await expect(bar).toBeVisible();
    const order = await bar.evaluate((el) => [...el.children].filter((c) => c.getClientRects().length > 0 && !c.matches(".status-gap")).map((c) => c.id));
    expect(order).toEqual(["status-lang", "status-pos", "status-indent", "status-encoding", "status-runtime", "status-theme"]);
    await expect(page.locator("#status-indent")).toHaveText("Spaces: 4");
    await expect(page.locator("#status-encoding")).toHaveText("UTF-8");
    // The default theme, without "ExecFlow" or "(match device)".
    await expect(page.locator("#status-theme")).toHaveText("Theme: Electric Blue");
    expect(await bar.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Geist Mono/);
    const b = await box(page, ".statusbar");
    expect(Math.round(b.height), "a 26 px bar").toBe(26);
    const theme = page.locator("#status-theme");
    expect(Math.min((await theme.boundingBox())!.height, (await theme.boundingBox())!.width)).toBeGreaterThanOrEqual(24);
    await theme.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(theme).toBeFocused();
  });

  test("Signal light's console is the light console ground here (the code board's foot); under 1100 px it is the dark console card", async ({ page }) => {
    await openApp(page);
    // Signal light, chosen in this build (marked, so never moved to the default, Electric Blue).
    await page.evaluate(() => {
      localStorage.setItem("codeeditor:theme", "signal-light");
      localStorage.setItem("codeeditor:theme-default", "electric-blue");
    });
    await openApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const ground = () => page.locator("#panel").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await ground()).toBe("rgb(244, 245, 248)");
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator("#app")).not.toHaveAttribute("data-narrow", "true");
    await expect.poll(ground).toBe("rgb(18, 21, 26)");
  });
});

test.describe("under 1100 px", () => {
  test.beforeEach(({ page }) => page.setViewportSize({ width: 1000, height: 800 }));

  test("nothing moves: Run and the runtime state in the top bar, Input in the console's bar, the rail and the sidebar column, no strip", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    await expect(page.locator(".topbar-end > #status-runtime ~ #run-button")).toBeVisible();
    await expect(page.locator(".run-strip")).toBeHidden();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".main > #sidebar")).toBeVisible();
    await expect(files(page)).toHaveAttribute("aria-controls", "sidebar");
    await expect(page.locator("#runlog #receipt")).toHaveCount(1);
    await expect(page.locator(".panel-actions > #input-toggle")).toBeVisible();
    await expect(page.locator("#args-button, #status-theme, #layout-button")).toHaveCount(0);
    // Crossing to the wide shell and back moves the outcome and the run's tools with it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".panel-bar #receipt")).toHaveCount(1);
    await expect(page.locator(".run-tools > #input-toggle")).toHaveCount(1);
    await expect(page.locator(".main > #sidebar")).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator("#runlog #receipt")).toHaveCount(1);
    await expect(page.locator(".panel-actions > #input-toggle")).toHaveCount(1);
    await expect(page.locator(".main > #sidebar")).toBeVisible();
  });
});
