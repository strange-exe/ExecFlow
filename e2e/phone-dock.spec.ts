// The phone layout, option A "Segment and dock" (owner's pick, 2026-11-03; mock-up
// .claude/design/redesign8/phone/options.html). Below 900 px: the top bar holds the mark, the file
// name (it opens Files), the sync status, Search and Settings; a Code | Flowchart segment sits under
// it; one dock at the foot holds Run in the thumb zone, the run's outcome or the runtime state, the
// last lines of the same #console (clamped, never copied) and "All output, N lines". After a run the
// code stays on screen; with the on-screen keyboard open the dock is a 56 px accessory bar.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, importFiles, openFromTree, openIn, run, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(150_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Eight lines of output; the last three are "Sum: 369", "Average: 73.8" and "Best: 90". */
const MARKS = [
  "marks = [72, 85, 64, 90, 58]",
  "for i, m in enumerate(marks):",
  '    print(f"marks[{i}] = {m}")',
  'print("Sum:", sum(marks))',
  'print("Average:", sum(marks) / len(marks))',
  'print("Best:", max(marks))',
  "",
].join("\n");
/** Raises ZeroDivisionError on line 7, after one line of output. */
const BROKEN = [
  "marks = [72, 85, 64, 90, 58]",
  "total = 0",
  "for m in marks:",
  "    total += m",
  'print("Sum:", total)',
  "count = 0",
  'print("Average:", total / count)',
  "",
].join("\n");
/** A line far wider than a phone, inside a loop (indent 4). */
const LONG = 'for i in range(3):\n    print("this line is much wider than any phone screen, so it has to wrap", i, i * 2, i * 3)\n';

const box = async (l: Locator) => (await l.boundingBox())!;

async function openFile(page: Page, name: string, text: string, size = { width: 390, height: 844 }, scheme?: "light" | "dark") {
  await page.setViewportSize(size);
  if (scheme) {
    await openIn(page, "/", scheme);
    await waitReady(page);
  } else {
    await page.goto("/");
    await waitReady(page);
  }
  await importFiles(page, [{ name, text }]);
  await openFromTree(page, name);
  await expect(page.locator("#app")).toHaveAttribute("data-narrow", String(size.width < 900));
}

/** Run's centre is in the lower third and the right half (the thumb's reach), and it is a big target. */
async function expectThumbRun(page: Page, size: { width: number; height: number }, what: string) {
  const run = page.locator("#run-button");
  await expect(run, `${what}: Run is in the dock`).toBeVisible();
  const b = await box(run);
  const cy = (b.y + b.height / 2) / size.height;
  const cx = (b.x + b.width / 2) / size.width;
  expect(cy, `${what}: Run's centre ${Math.round(cy * 100)}% down`).toBeGreaterThanOrEqual(0.66);
  expect(cx, `${what}: Run's centre ${Math.round(cx * 100)}% across`).toBeGreaterThanOrEqual(0.5);
  expect(b.y + b.height, `${what}: Run is on screen`).toBeLessThanOrEqual(size.height);
  expect(Math.round(b.height), `${what}: Run's height`).toBeGreaterThanOrEqual(48);
  expect(Math.round(b.width), `${what}: Run's width`).toBeGreaterThanOrEqual(96);
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Every visible control outside the code: [name, width, height]. */
const controls = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a[href], [role=tab], input:not([type=hidden]), select, summary")]
      .filter((el) => !el.closest(".cm-editor") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight; // visually hidden labels are 1 px
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [el.id || el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.tagName, Math.round(r.width), Math.round(r.height)] as const;
      }),
  );

for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 768, height: 1024 }]) {
  test(`(${size.width} px) Run sits in the dock, in the thumb zone, before and after a run`, async ({ page }) => {
    await openFile(page, "main.py", MARKS, size);
    await expect(page.locator("#panel .run-strip #run-button")).toBeVisible();
    await expect(page.locator(".topbar #run-button")).toHaveCount(0);
    await expectThumbRun(page, size, "before a run");
    await run(page);
    await expectThumbRun(page, size, "after a run");
    // The runtime state lives in the dock too, and the file name in the top bar opens Files.
    await expect(page.locator("#panel #status-runtime")).toHaveCount(1);
    await expect(page.locator(".topbar .drawer-toggle")).toHaveAttribute("aria-controls", "sidebar");
    await expect(page.locator(".topbar .drawer-toggle")).toContainText("main.py");
  });
}

test("after a failed run the code stays: the error line's band, the dock's error and Run are on screen together", async ({ page }) => {
  await openFile(page, "main.py", BROKEN);
  await run(page);
  await expect(page.locator("#view-code")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content .cm-line.ce-error-line"), "the band on line 7").toBeInViewport();
  const error = page.locator("#panel #run-exception");
  await expect(error).toBeInViewport();
  await expect(error).toContainText("ZeroDivisionError");
  await expect(error).toContainText("line 7");
  await expect(page.locator("#run-button")).toBeInViewport();
  // Run steps back to its outline after a failure: no fill. The pointer leaves it first, or the click's
  // pointer still hovers it and draws the hover tint (Linux WebKit).
  await page.mouse.move(0, 0);
  expect(await page.locator("#run-button").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  // Nothing in the dock overlaps the code: the editor ends where the dock begins.
  const [editor, dock] = [await box(page.locator(".editor-area")), await box(page.locator("#panel"))];
  expect(editor.y + editor.height).toBeLessThanOrEqual(dock.y + 1);
});

test("the dock shows the last 3 lines; All output expands and collapses from the keyboard", async ({ page }) => {
  await openFile(page, "main.py", MARKS);
  await run(page);
  const panel = page.locator("#panel");
  const toggle = page.locator("#dock-toggle");
  await expect(panel).toHaveAttribute("data-dock", "peek");
  await expect(toggle).toHaveText(/All output, 8 lines/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The same #console, clamped: three lines tall, scrolled to its end.
  const peek = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("#console-scroll")!;
    const line = parseFloat(getComputedStyle(document.querySelector("#console")!).lineHeight);
    const s = scroller.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#console")!);
    // Text rows only: the log's blocks (display: block spans) give a rect of their own, many lines tall.
    const rows = [...range.getClientRects()].filter((r) => r.height > 0 && r.height < line * 1.5 && r.bottom > s.top + 1 && r.top < s.bottom - 1);
    return { lines: s.height / line, visibleRows: new Set(rows.map((r) => Math.round(r.top))).size, consoles: document.querySelectorAll("#console").length };
  });
  expect(peek.consoles, "one #console, never copied").toBe(1);
  expect(peek.lines, "the peek is at most about 3 lines tall").toBeLessThanOrEqual(3.9);
  expect(peek.visibleRows, "3 lines show").toBe(3);
  await expect(page.locator("#console")).toContainText("Best: 90");
  await expect(page.locator(".cm-content")).toBeInViewport();

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toHaveAttribute("data-dock", "all");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".cm-content")).toBeHidden();
  const all = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("#console-scroll")!;
    return scroller.getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector("#console")!).lineHeight);
  });
  expect(all, "all output: room for every line").toBeGreaterThanOrEqual(8);
  // Run stays where the thumb found it: the strip sits under the log, over the foot.
  await expectThumbRun(page, { width: 390, height: 844 }, "all output");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveAttribute("data-dock", "peek");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".cm-content")).toBeInViewport();
});

test("the segment switches Code and Flowchart, by pointer and arrow keys; the dock stays", async ({ page }) => {
  await openFile(page, "main.py", MARKS);
  const tabs = page.locator(".view-bar [role=tablist] [role=tab]");
  await expect(tabs).toHaveText(["Code", "Flowchart"]);
  // Under the top bar, full width, 44 px targets.
  const [top, seg] = [await box(page.locator(".topbar")), await box(page.locator(".view-bar"))];
  expect(Math.abs(seg.y - (top.y + top.height))).toBeLessThanOrEqual(1);
  for (const b of [await box(tabs.nth(0)), await box(tabs.nth(1))]) expect(Math.round(b.height)).toBeGreaterThanOrEqual(44);
  const code = page.locator("#view-code");
  const chart = page.locator("#view-flowchart");
  await expect(code).toHaveAttribute("aria-selected", "true");
  await expect(chart).toHaveAttribute("aria-selected", "false");
  await chart.click();
  await expect(chart).toHaveAttribute("aria-selected", "true");
  await expect(code).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#chart-board #panel-flowchart")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeHidden();
  await expect(page.locator("#run-button")).toBeInViewport();
  await chart.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toBeInViewport();
  await page.keyboard.press("End");
  await expect(chart).toBeFocused();
  await expect(chart).toHaveAttribute("aria-selected", "true");
});

test("with the keyboard open the segment hides and the dock is a 56 px accessory bar; Run closes the keyboard and shows the peek", async ({ page }) => {
  await openFile(page, "main.py", MARKS);
  await page.locator(".cm-content").click();
  // The on-screen keyboard under interactive-widget=resizes-content: the window gets shorter while
  // the code has focus (visualViewport follows it).
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(page.locator("#app")).toHaveAttribute("data-keyboard", "open");
  await expect(page.locator(".view-bar")).toBeHidden();
  await expect(page.locator(".statusbar")).toBeHidden();
  const hide = page.locator("#hide-keyboard");
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAccessibleName("Hide keyboard");
  expect(Math.round((await box(page.locator("#panel"))).height), "the accessory bar").toBe(56);
  await expect(page.locator("#run-button")).toBeInViewport();
  const strip = await box(page.locator("#panel"));
  expect(strip.y + strip.height, "on the keyboard's edge").toBeGreaterThanOrEqual(499);
  // Hide keyboard: the code lets go of the focus (the keyboard goes), and the dock comes back.
  await hide.click();
  await expect(page.locator("#app")).not.toHaveAttribute("data-keyboard", "open");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") === null)).toBe(true);
  // Typing again opens it again; Run ends typing and shows the result in the peek.
  await page.locator(".cm-content").click();
  await expect(page.locator("#app")).toHaveAttribute("data-keyboard", "open");
  await run(page);
  await expect(page.locator("#app")).not.toHaveAttribute("data-keyboard", "open");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") === null)).toBe(true);
  await expect(page.locator("#panel")).toHaveAttribute("data-dock", "peek");
  await expect(page.locator("#console-scroll")).toBeVisible();
  // Typing again after a run: the bar shows the runtime state again (the outcome is not on it).
  await page.locator(".cm-content").click();
  await expect(page.locator("#app")).toHaveAttribute("data-keyboard", "open");
  await expect(page.locator("#panel .run-strip #status-runtime")).toBeVisible();
  await expect(page.locator("#panel .run-strip .run-outcome")).toBeHidden();
});

test("long lines wrap below 900 px with a hanging indent, and nothing scrolls sideways at 320 px", async ({ page }) => {
  await openFile(page, "main.py", LONG, { width: 320, height: 640 });
  const wrap = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
    const line = document.querySelectorAll<HTMLElement>(".cm-content .cm-line")[1];
    const range = document.createRange();
    range.selectNodeContents(line);
    const rows = [...range.getClientRects()].filter((r) => r.width > 0);
    const tops = [...new Set(rows.map((r) => Math.round(r.top)))].sort((a, b) => a - b);
    const leftOf = (top: number) => Math.min(...rows.filter((r) => Math.round(r.top) === top).map((r) => r.left));
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    line.append(probe);
    const ch = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return { sideways: scroller.scrollWidth > scroller.clientWidth + 1, rows: tops.length, first: leftOf(tops[0]), second: leftOf(tops[1] ?? tops[0]), ch };
  });
  expect(wrap.sideways, "the code never scrolls sideways").toBe(false);
  expect(wrap.rows, "the long line takes several rows").toBeGreaterThan(1);
  // The first row starts at the line's start (its 4 spaces are drawn); the rows after it start 2
  // columns past the line's own indent: 6 columns in.
  expect(Math.abs(wrap.second - wrap.first - 6 * wrap.ch), `hanging indent ${wrap.second - wrap.first} px, ch ${wrap.ch}`).toBeLessThanOrEqual(2);
  expect(await noSideScroll(page), "no sideways page scroll, code view").toBe(true);
  await run(page);
  expect(await noSideScroll(page), "after a run").toBe(true);
  // The strip stays one row at 320 px: the outcome's words wrap beside Run, not above it.
  const [strip, runBox] = [await box(page.locator("#panel .run-strip")), await box(page.locator("#run-button"))];
  expect(Math.round(strip.height), "one row: Run and its 8 px padding").toBeLessThanOrEqual(64);
  expect(runBox.y - strip.y, "Run on the strip's first row").toBeLessThanOrEqual(9);
  await page.locator("#dock-toggle").click();
  expect(await noSideScroll(page), "all output").toBe(true);
  await page.locator("#dock-toggle").click();
  await page.locator("#view-flowchart").click();
  expect(await noSideScroll(page), "flowchart").toBe(true);
});

test("every control is 24 px or more, and the primary touch controls 44 px", async ({ page }) => {
  await openFile(page, "main.py", BROKEN);
  const check = async (state: string) => {
    for (const [name, w, h] of await controls(page)) {
      expect.soft(Math.min(w, h), `${state}: ${name} is ${w} x ${h}`).toBeGreaterThanOrEqual(24);
    }
  };
  await check("before a run");
  await run(page);
  await check("after a failed run");
  await page.locator("#dock-toggle").click();
  await check("all output");
  for (const id of ["#dock-toggle", "#input-toggle", "#clear-output", "#ptab-output", "#ptab-problems"]) {
    expect.soft(Math.round((await box(page.locator(id))).height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
  await page.locator("#dock-toggle").click();
  for (const id of ["#run-button", "#view-code", "#view-flowchart", ".topbar .drawer-toggle", "#palette-button", "#settings-button", "#problems-count", "#run-exception"]) {
    expect.soft(Math.round((await box(page.locator(id))).height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
});

test("Signal light keeps a light console ground on phones (no dark slab)", async ({ page }) => {
  await openFile(page, "main.py", MARKS, { width: 390, height: 844 }, "light");
  await run(page);
  const grounds = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim();
    return { root, panel: getComputedStyle(document.querySelector("#panel")!).getPropertyValue("--terminal-bg").trim(), scheme: getComputedStyle(document.querySelector("#panel")!).colorScheme };
  });
  expect(grounds.panel).toBe(grounds.root);
  expect(grounds.scheme).not.toBe("dark");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing at 390 px (${scheme}): before a run, after a failed run, all output, flowchart`, async ({ page }) => {
    await openFile(page, "main.py", BROKEN, { width: 390, height: 844 }, scheme);
    const scan = async (state: string) => {
      const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect.soft(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${scheme} ${state}`).toEqual([]);
    };
    await scan("before a run");
    await run(page);
    await scan("after a failed run");
    await page.locator("#dock-toggle").click();
    await scan("all output");
    await page.locator("#dock-toggle").click();
    await page.locator("#view-flowchart").click();
    await expect(page.locator("#chart-board #panel-flowchart")).toBeVisible();
    await scan("flowchart");
  });
}
