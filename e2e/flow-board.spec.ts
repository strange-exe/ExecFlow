// Flow Board, stage S2 (redesign 7, .claude/design/redesign7/a/design.md "Where every feature
// lives" and "Motion"): from 1100 px the rail and the sidebar column retire. Run, the run's
// outcome, the runtime state and the problems count form the run strip at the code board's foot;
// Files in the code board's head opens the file list as a popover; the top row keeps Search, the
// sync status, Capture, Shortcuts, Settings and About. Under 1100 px nothing changes. Every
// keyboard path is driven with the keyboard.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, showFiles, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const OK = { name: "main.py", text: 'print("hi")\n' };
const FAILS = { name: "calc.py", text: "print(1)\nprint(1 / 0)\n" };
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const pop = (page: Page) => page.locator("#files-popover");
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

  test("the run strip is the code board's foot: Run, the outcome, the runtime state and the count, above the console's tabs", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const strip = page.locator("#panel > .run-strip");
    await expect(strip).toBeVisible();
    // The DOM order is the reading and the Tab order.
    const order = await strip.evaluate((el) => [...el.children].map((c) => c.id || c.className));
    expect(order).toEqual(["run-button", "run-outcome", "status-runtime", "problems-count"]);
    const [s, bar, code] = await Promise.all([box(page, "#panel > .run-strip"), box(page, ".panel-bar"), box(page, "#editor-area")]);
    expect(s.y, "under the code").toBeGreaterThanOrEqual(code.y + code.height);
    expect(bar.y, "over the console's tabs").toBeGreaterThanOrEqual(s.y + s.height - 1);
    expect(Math.round(s.height), "a 44 px bar, like the heads").toBe(44);
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
    // Run and the runtime state left the top bar.
    await expect(page.locator(".topbar #run-button, .topbar #status-runtime")).toHaveCount(0);
    const r = await run(page);
    expect(r.status, r.output).toBe("ok");
    // The outcome, as the run-log header shows it under 1100 px, now on the strip.
    const receipt = strip.locator("#receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveText(/Finished.*exit code 0.*ran in/);
    await expect(page.locator("#runlog .rl-file")).toHaveText("main.py");
    await expect(page.locator("#problems-count")).toHaveText("No problems");
    // Keyboard: Run, then the count (the outcome holds no stop).
    await page.locator("#run-button").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#problems-count")).toBeFocused();
    // Every control on the strip is 24 px or more.
    for (const sel of ["#run-button", "#problems-count"]) {
      const b = await box(page, sel);
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(24);
    }
  });

  test("the count names the first problem's line, in the danger colour, and opens the Problems list (pointer and keyboard)", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK, FAILS]);
    await openFromTree(page, "calc.py");
    const r = await run(page);
    expect(r.status, r.output).toBe("error");
    const count = page.locator("#problems-count");
    await expect(count).toHaveText(/^\d+ problems?, line 2$/);
    await expect(count).toHaveAttribute("data-tone", "error");
    expect(await count.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "danger"));
    // The line marks stay in the editor.
    await expect(page.locator(".cm-lintRange-error, .cm-lint-marker-error").first()).toBeVisible();
    // With another file active, the editor head's stops, in order: Files, the open file's tab, then
    // the error jump (shown only while the error is in a file other than the active one).
    await openFromTree(page, "main.py");
    await expect(page.locator("#error-jump")).toBeVisible();
    const stops = await page.locator(".editor-head").evaluate((head) =>
      [...head.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0).map((el) => (el.matches(".drawer-toggle") ? "files" : el.id)),
    );
    expect(stops).toHaveLength(3);
    expect(stops[0]).toBe("files");
    expect(stops[1]).toMatch(/^tab-/);
    expect(stops[2]).toBe("error-jump");
    await count.click();
    await expect(page.locator("#ptab-problems")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#ptab-problems")).toBeFocused();
    await expect(page.locator("#panel-problems")).toBeVisible();
    // Back to Output, then the keyboard: Enter on the count.
    await page.locator("#ptab-output").click();
    await count.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ptab-problems")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#ptab-problems")).toBeFocused();
    expect(await axe(page), "axe after a failed run").toEqual([]);
  });

  test("Files opens the file list as a named popover under it: focus goes in, Escape closes it and returns focus, a press outside closes it", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK, FAILS]);
    // The rail and the sidebar column are gone; the list lives in the popover.
    await expect(page.locator(".rail")).toBeHidden();
    await expect(page.locator(".main > .splitter")).toBeHidden();
    await expect(pop(page).locator("#sidebar")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Files" })).toBeVisible();
    await expect(files(page)).toHaveAttribute("aria-expanded", "true");
    await expect(files(page)).toHaveAttribute("aria-haspopup", "dialog");
    await expect(files(page)).toHaveAttribute("aria-controls", "files-popover");
    const [b, p] = await Promise.all([box(page, ".drawer-toggle"), box(page, "#files-popover")]);
    expect(p.y, "under Files").toBeGreaterThanOrEqual(b.y + b.height);
    expect(Math.abs(p.x - b.x), "aligned with Files").toBeLessThanOrEqual(8);
    expect(await axe(page), "axe with the popover open").toEqual([]);
    // Escape closes it and gives the focus back to Files.
    await treeItem(page, "main.py").focus();
    await page.keyboard.press("Escape");
    await expect(pop(page)).toBeHidden();
    await expect(files(page)).toBeFocused();
    await expect(files(page)).toHaveAttribute("aria-expanded", "false");
    // Enter on Files opens it with the focus inside, on the tree.
    await page.keyboard.press("Enter");
    await expect(pop(page)).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest("#files-popover [role=tree]") !== null), "focus in the tree").toBe(true);
    // Choosing a file closes it and takes the focus to the code.
    await treeItem(page, "calc.py").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('.cm-content[aria-label="Code editor, calc.py"]')).toBeFocused();
    await expect(pop(page)).toBeHidden();
    // A press elsewhere closes it, and the press does what it does (the editor takes the focus).
    await showFiles(page);
    await expect(pop(page)).toBeVisible();
    await page.locator(".cm-content").click();
    await expect(pop(page)).toBeHidden();
    await expect(page.locator(".cm-content")).toBeFocused();
    // Files itself toggles it.
    await files(page).click();
    await expect(pop(page)).toBeVisible();
    await files(page).click();
    await expect(pop(page)).toBeHidden();
    await expect(files(page)).toBeFocused();
  });

  test("the popover stays open for its own menus and dialogs, and Escape in a menu closes only the menu", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await expect(pop(page)).toBeVisible();
    await page.locator("#file-actions").click();
    const menu = page.getByRole("menu", { name: "File actions" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(pop(page)).toBeVisible();
    await expect(page.locator("#file-actions")).toBeFocused();
  });

  test("the rail's other items stay reachable: Search, the sync status, Capture, Shortcuts, Settings and About in the top row, New file in the popover, the chart on its board", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    const top = page.locator(".topbar");
    for (const name of ["Search or run a command", "Capture snippet of the selected lines", "Shortcuts", "Settings"]) {
      const control = top.getByRole("button", { name, exact: true });
      await expect(control, name).toBeVisible();
      const b = (await control.boundingBox())!;
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(24);
    }
    await expect(top.getByRole("link", { name: "About ExecFlow" })).toBeVisible();
    await expect(top.locator("#sync-slot")).toBeVisible();
    await expect(top.locator(".brand-mark")).toBeVisible();
    await expect(page.locator("#chart-board")).toBeVisible();
    // Shortcuts and Settings open from the keyboard.
    await top.getByRole("button", { name: "Settings", exact: true }).press("Enter");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-button")).toBeFocused();
    await showFiles(page);
    await expect(pop(page).locator("#new-file")).toBeVisible();
    await pop(page).locator("#new-file").click();
    await expect(pop(page).locator(".tree-input")).toBeFocused();
  });

  test("motion: the popover fades in and rises 4 px over 160 ms ease-out, leaves over 120 ms ease-in; none under reduced motion", async ({ page }) => {
    // Every Element.animate call on the popover, as asked (not as sampled mid-flight).
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      (window as unknown as { popCalls: unknown[] }).popCalls = calls;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, frames, options) {
        if (this.id === "files-popover") calls.push({ frames, options });
        return animate.call(this, frames, options);
      };
    });
    await openApp(page);
    await importFiles(page, [OK]);
    await page.keyboard.press("Escape");
    await expect(pop(page)).toBeHidden();
    const calls = () => page.evaluate(() => (window as unknown as { popCalls: unknown[] }).popCalls.splice(0));
    await calls();
    await files(page).click();
    await page.keyboard.press("Escape");
    await expect(pop(page)).toBeHidden();
    expect(await calls()).toEqual([
      { frames: [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], options: { duration: 160, easing: "cubic-bezier(0, 0, 0.2, 1)" } },
      { frames: [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(4px)" }], options: { duration: 120, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" } },
    ]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await files(page).click();
    await expect(pop(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pop(page)).toBeHidden();
    expect(await calls(), "no motion under reduced motion").toEqual([]);
  });

  test("Signal light's console is the light console ground here (the code board's foot); under 1100 px it is the dark console card", async ({ page }) => {
    await openApp(page);
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

  test("nothing moves: Run and the runtime state in the top bar, the rail and the sidebar column, no strip and no popover", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [OK]);
    await openFromTree(page, "main.py");
    await expect(page.locator(".topbar-end > #status-runtime ~ #run-button")).toBeVisible();
    await expect(page.locator(".run-strip")).toBeHidden();
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".main > #sidebar")).toBeVisible();
    await expect(pop(page)).toBeHidden();
    await expect(files(page)).not.toHaveAttribute("aria-haspopup");
    await expect(page.locator("#runlog #receipt")).toHaveCount(1);
    // Crossing to the wide shell and back moves the outcome and the list with it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".run-strip #receipt")).toHaveCount(1);
    await expect(pop(page).locator("#sidebar")).toHaveCount(1);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator("#runlog #receipt")).toHaveCount(1);
    await expect(page.locator(".main > #sidebar")).toBeVisible();
  });
});
