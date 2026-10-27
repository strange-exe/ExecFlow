import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, setCode, showFiles, test, treeItem } from "./helpers";

// The 0.7.0 shell, direction B "Calm" (.claude/design/DESIGN.md, "Shell direction for 0.7.0"): a
// full-height sidebar (workspace, quick actions, the tree, a foot with sync and Settings), a top bar
// over the editor column only (breadcrumb, "Search or run a command", Capture, Run), the editor and
// its panel on one sheet, the status bar's facts in the panel bar and the sidebar foot.
test.use({ serviceWorkers: "block" });

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

/** The WCAG contrast ratio of two computed rgb() colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const C_FILE = "int even(int n){\n    return n % 2 == 0;\n}\n\nint main(void){\n    int total = even(4) + even(5) + even(6) + even(7);\n    return total;\n}\n";

async function withFiles(page: Page) {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: C_FILE },
    { name: "util.cpp", text: "int f() { return 1; }\n" },
    { name: "calc.py", text: "print(1)\n" },
    { name: "list.h", text: "int f(void);\n" },
    { name: "notes.txt", text: "todo\n" },
  ]);
  await openFromTree(page, "main.c");
}

test.describe("desktop", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 900, "desktop layout");
  test.beforeEach(({ page }) => page.setViewportSize({ width: 1440, height: 900 }));

  test("the sidebar runs the window's full height: workspace, quick actions, the tree, and a foot with sync and Settings", async ({ page }) => {
    await withFiles(page);
    const side = await box(page, "#sidebar");
    expect(Math.round(side.y), "the sidebar starts at the top of the window").toBe(0);
    expect(Math.round(side.y + side.height), "and ends at its foot").toBe(900);
    const sidebar = page.locator("#sidebar");
    // The workspace at the top: its name, and where it lives.
    await expect(sidebar.locator(".ws-switcher #ws-name")).toHaveText("Workspace");
    await expect(sidebar.locator(".ws-switcher .ws-owner")).toHaveText("On this computer");
    // Quick actions with their real keys.
    const quick = sidebar.locator(".quick-actions");
    await expect(quick.getByRole("button", { name: /^Search/ })).toBeVisible();
    await expect(quick.getByRole("button", { name: /^Flowchart/ })).toBeVisible();
    await expect(quick.getByRole("button", { name: /^New file/ })).toBeVisible();
    await expect(quick.locator(".keycap").first()).toHaveText("Ctrl P");
    // The foot: the sync status and Settings, at the sidebar's bottom edge.
    await expect(sidebar.locator(".sidebar-foot #sync-status")).toBeVisible();
    await expect(sidebar.locator(".sidebar-foot #settings-button")).toBeVisible();
    const foot = await box(page, ".sidebar-foot");
    expect(Math.round(foot.y + foot.height)).toBe(900);
    // The tree sits between the quick actions and the foot.
    const tree = await box(page, ".tree-host");
    expect(tree.y).toBeGreaterThan((await box(page, ".quick-actions")).y);
    expect(tree.y + tree.height).toBeLessThanOrEqual(foot.y + 1);
  });

  test("the top bar is over the editor column only: breadcrumb, the command field, Capture, then Run", async ({ page }) => {
    await withFiles(page);
    const side = await box(page, "#sidebar");
    const top = await box(page, ".topbar");
    expect(top.x, "the top bar starts right of the sidebar").toBeGreaterThanOrEqual(side.x + side.width - 1);
    const field = page.locator(".topbar #palette-button");
    await expect(field).toContainText("Search or run a command");
    await expect(field.locator(".keycap")).toHaveText("Ctrl P");
    await expect(field).toHaveAccessibleName(/^Search or run a command/);
    await expect(page.locator(".topbar #run-button")).toBeVisible();
    await expect(page.locator(".topbar #snippet-button")).toContainText("Capture");
    // Capture comes before Run, and Run ends the bar.
    const capture = await box(page, "#snippet-button");
    const run = await box(page, "#run-button");
    expect(capture.x).toBeLessThan(run.x);
    expect(top.x + top.width - (run.x + run.width)).toBeLessThan(24);
    // The command field opens the palette, and Escape gives focus back to it.
    await field.click();
    await expect(page.locator("dialog#palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog#palette")).toBeHidden();
    await expect(field).toBeFocused();
  });

  test("Run keeps its states in the top bar: the one accent fill, outline while running or with nothing runnable", async ({ page }) => {
    await withFiles(page);
    const run = page.locator(".topbar #run-button");
    const fill = await run.evaluate((el) => getComputedStyle(el).backgroundColor);
    const action = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--action)";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(fill).toBe(action);
    // A text file has nothing to run: Run steps back to its outline, still enabled.
    await openFromTree(page, "notes.txt");
    await page.mouse.move(4, 4);
    await expect(run).toBeEnabled();
    expect(await run.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  });

  test("quick actions: Search opens the palette, Flowchart opens its tab, New file starts a name in the tree", async ({ page }) => {
    await withFiles(page);
    const quick = page.locator(".quick-actions");
    await quick.getByRole("button", { name: /^Search/ }).click();
    await expect(page.locator("dialog#palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await quick.getByRole("button", { name: /^Flowchart/ }).click();
    await expect(page.locator("#ptab-flowchart")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#panel-flowchart")).toBeVisible();
    await quick.getByRole("button", { name: /^New file/ }).click();
    await expect(page.locator(".tree-input")).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("the status bar's facts: language and Ln/Col in the panel bar, notices in the sidebar foot, Shortcuts there too", async ({ page }) => {
    await withFiles(page);
    await expect(page.locator(".statusbar")).toBeHidden();
    await expect(page.locator(".panel-bar #status-lang")).toHaveText("C");
    await expect(page.locator(".panel-bar #status-pos")).toHaveText(/^Ln \d+, Col \d+$/);
    // A notice (the import's) shows in the sidebar foot, in its live region.
    await expect(page.locator(".sidebar-foot .notice-host .notice")).toBeAttached();
    await importFiles(page, [{ name: "more.py", text: "print(2)\n" }]);
    await expect(page.locator(".sidebar-foot .notice-host")).toContainText("Imported");
    await expect(page.locator(".sidebar-foot .notice-host")).toBeInViewport();
    await expect(page.locator(".sidebar-foot #shortcuts-button")).toBeVisible();
    await page.locator("#shortcuts-button").click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("tree rows are 28 px, and each file's type is a text badge, not a colour", async ({ page }) => {
    await withFiles(page);
    const badge = (path: string) => treeItem(page, path).locator(":scope > .tree-row .tree-type");
    await expect(badge("main.c")).toHaveText("C");
    await expect(badge("util.cpp")).toHaveText("C++");
    await expect(badge("calc.py")).toHaveText("Py");
    await expect(badge("list.h")).toHaveText("H");
    await expect(badge("notes.txt")).toHaveText("Txt");
    // The badge is decoration beside a name that already says the extension.
    await expect(badge("main.c")).toHaveAttribute("aria-hidden", "true");
    const row = await box(page, '.tree [data-path="main.c"] > .tree-row');
    expect(Math.round(row.height)).toBe(28);
  });

  test("the chosen tree row is lifted and ringed, with a location edge that keeps 3:1, on a folder too", async ({ page }) => {
    await withFiles(page);
    await page.locator("#new-folder").click();
    await page.keyboard.insertText("lab");
    await page.keyboard.press("Enter");
    await expect(treeItem(page, "lab")).toBeAttached();
    // A folder is chosen but never the open file: the chosen row's cue must stand on its own.
    await treeItem(page, "lab").locator(":scope > .tree-row").click();
    await expect(treeItem(page, "lab")).toHaveAttribute("aria-selected", "true");
    const look = await treeItem(page, "lab").locator(":scope > .tree-row").evaluate((el) => {
      const s = getComputedStyle(el);
      const color = (v: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${v})`;
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      return { fill: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow, raised: color("--surface-raised"), location: color("--location") };
    });
    expect(look.fill, "lifted to surface-raised").toBe(look.raised);
    expect(look.shadow, "an inset ring").toContain("inset");
    expect(look.image, "the location edge").toContain(look.location);
    expect(contrast(look.location, look.raised), `edge ${look.location} on the row ${look.raised}`).toBeGreaterThanOrEqual(3);
  });

  test("a selection hugs the text: a selected line's band ends where its text ends, not at the editor's edge", async ({ page }) => {
    await withFiles(page);
    await setCode(page, C_FILE);
    // Lines 1 to 3 selected from the start of line 1 to the end of line 3.
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+End");
    const content = await box(page, ".cm-content");
    const marks = page.locator(".ce-selection-layer .cm-selectionBackground");
    await expect.poll(() => marks.count()).toBeGreaterThanOrEqual(3);
    const line2 = await page.locator(".cm-line").nth(1).evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const rects = [...r.getClientRects()];
      return Math.max(...rects.map((x) => x.right));
    });
    const rights = await marks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    for (const right of rights) expect(right, "no band runs to the editor's edge").toBeLessThan(content.x + content.width - 100);
    // Line 2's band ends at its text, plus at most a character for the line break.
    expect(Math.min(...rights.map((r) => Math.abs(r - line2)))).toBeLessThan(12);
    // CodeMirror's own full-width layer is not shown.
    await expect(page.locator(".cm-scroller > .cm-selectionLayer")).toBeHidden();
  });
});

test.describe("phones and zoom", () => {
  test("320 px wide and 200% zoom (720 x 450): nothing scrolls sideways, the shell keeps its parts", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withFiles(page);
    for (const size of [{ width: 320, height: 640 }, { width: 720, height: 450 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await expect(page.locator("#app")).toHaveAttribute("data-narrow", "true");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal scroll at ${size.width} x ${size.height}`).toBeLessThanOrEqual(0);
      await expect(page.locator("#run-button")).toBeInViewport();
      await expect(page.locator(".drawer-toggle")).toBeVisible();
      await showFiles(page);
      // The drawer has the workspace and the quick actions too.
      await expect(page.locator("#sidebar .ws-switcher")).toBeInViewport();
      await expect(page.locator("#sidebar .quick-actions")).toBeInViewport();
      await page.locator(".drawer-toggle").click();
    }
  });
});
