// The phone layout (Workbench stage 4, editor option A's mock: .claude/design/editor9/a, its 390 x 844
// phone frame). Below 900 px: a 56 px top bar (the app's mark, Files as the open file's folder and
// name, the sync status, Search, Settings), the board (Code, Flowchart or Output), the run row (the
// stepper: 44 px Previous and Next with "step NN / NN" and its ticks between them; or the run's one
// sentence), and the dock at the foot: one tab list, Code | Flowchart | Output with the problems
// count (44 px tabs, roving tabindex, arrows wrap, Home and End). Run is a 52 px floating action at
// the lower right of the board, above the run row. The variables row is under the code in Code and
// at the top of Output. With the on-screen keyboard open the run row is a 56 px accessory bar.
// (It replaces option A "Segment and dock" of 2026-11-03: the segment under the top bar, Run in a
// dock strip, and a peek of the output's last lines with "All output, N lines".)
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
/** 42 lines: taller than a phone's board, so the code scrolls under Run. */
const TALL = ["total = 0", ...Array.from({ length: 40 }, (_, i) => `total += ${i}`), "print(total)", ""].join("\n");
const LOOP_C = '#include <stdio.h>\nint main(void) {\n    for (int i = 0; i < 3; i++) printf("%d\\n", i);\n    return 0;\n}\n';

const box = async (l: Locator) => (await l.boundingBox())!;
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

/**
 * Run floats in the thumb's reach: its centre in the lower part of the window (it rides above the
 * strip, which grows by the variables' row after a run: 61% down at 360 x 740) and the right half,
 * 52 px tall.
 */
async function expectThumbRun(page: Page, size: { width: number; height: number }, what: string) {
  const runButton = page.locator("#run-button");
  await expect(runButton, `${what}: Run is shown`).toBeVisible();
  const b = await box(runButton);
  const cy = (b.y + b.height / 2) / size.height;
  const cx = (b.x + b.width / 2) / size.width;
  expect(cy, `${what}: Run's centre ${Math.round(cy * 100)}% down`).toBeGreaterThanOrEqual(0.55);
  expect(cx, `${what}: Run's centre ${Math.round(cx * 100)}% across`).toBeGreaterThanOrEqual(0.5);
  expect(Math.round(b.height), `${what}: Run's height`).toBe(52);
  expect(Math.round(b.width), `${what}: Run's width`).toBeGreaterThanOrEqual(96);
  // Over the board, above the run row and the dock: never under the top bar, never over the tabs.
  const [top, dock] = [await box(page.locator(".topbar")), await box(page.locator(".view-bar"))];
  expect(b.y, `${what}: under the top bar`).toBeGreaterThanOrEqual(top.y + top.height);
  expect(b.y + b.height, `${what}: above the dock`).toBeLessThanOrEqual(dock.y - 8);
  const steps = page.locator("#run-steps");
  if (await steps.isVisible()) expect(b.y + b.height, `${what}: above the run row`).toBeLessThanOrEqual((await box(steps)).y);
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
  test(`(${size.width} px) Run floats over the board in the thumb zone, above the run row, before and after a run`, async ({ page }) => {
    await openFile(page, "main.py", MARKS, size);
    await expect(page.locator("#panel .run-strip #run-button")).toBeVisible();
    await expect(page.locator(".topbar #run-button")).toHaveCount(0);
    await expect(page.locator("#run-button")).toHaveCSS("position", "absolute");
    await expectThumbRun(page, size, "before a run");
    await run(page);
    await expect(page.locator("#run-steps")).toHaveAttribute("data-state", "steps", { timeout: 30_000 });
    await expectThumbRun(page, size, "after a run");
    // The runtime state stays in the panel, and the file name in the top bar opens Files.
    await expect(page.locator("#panel #status-runtime")).toHaveCount(1);
    await expect(page.locator(".topbar .drawer-toggle")).toHaveAttribute("aria-controls", "sidebar");
    await expect(page.locator(".topbar .drawer-toggle")).toContainText("main.py");
  });
}

test("the dock is one tab list at the foot: Code, Flowchart, Output; 44 px tabs, roving tabindex, arrows wrap, Home and End", async ({ page }) => {
  await openFile(page, "main.py", MARKS);
  const list = page.getByRole("tablist", { name: "View" });
  const tabs = list.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  const [code, chart, output] = [page.locator("#view-code"), page.locator("#view-flowchart"), page.locator("#dock-toggle")];
  await expect(code).toHaveAccessibleName("Code");
  await expect(chart).toHaveAccessibleName("Flowchart");
  await expect(output).toHaveAccessibleName("Output");
  await expect(code).toHaveAttribute("aria-controls", "editor-area");
  await expect(chart).toHaveAttribute("aria-controls", "chart-board");
  await expect(output).toHaveAttribute("aria-controls", "panel");
  // The dock: 64 px, the window's foot but for the status bar's line under it.
  const [dock, status] = [await box(page.locator(".view-bar")), await box(page.locator(".statusbar"))];
  expect(Math.round(dock.height), "the dock's height").toBe(64);
  expect(Math.abs(dock.y + dock.height - status.y), "the status bar's line under the dock").toBeLessThanOrEqual(1);
  expect(Math.round(status.y + status.height)).toBe(844);
  for (const t of [code, chart, output]) {
    const b = await box(t);
    expect(Math.min(b.width, b.height), `${await t.getAttribute("id")}`).toBeGreaterThanOrEqual(44);
  }
  // Roving tabindex: only the chosen tab is in the Tab order.
  const stops = () => page.evaluate(() => [...document.querySelectorAll('[role=tablist][aria-label="View"] [role=tab]')].map((t) => `${t.id}:${t.getAttribute("tabindex") ?? "0"}:${t.getAttribute("aria-selected")}`));
  expect(await stops()).toEqual(["view-code:0:true", "view-flowchart:-1:false", "dock-toggle:-1:false"]);
  await code.focus();
  for (const [key, id] of [["ArrowRight", "view-flowchart"], ["ArrowRight", "dock-toggle"], ["ArrowRight", "view-code"], ["End", "dock-toggle"], ["Home", "view-code"], ["ArrowLeft", "dock-toggle"]] as const) {
    await page.keyboard.press(key);
    await expect(page.locator(`#${id}`), key).toBeFocused();
    await expect(page.locator(`#${id}`), key).toHaveAttribute("aria-selected", "true");
    expect((await stops()).filter((s) => s.endsWith(":0:true")), key).toEqual([`${id}:0:true`]);
    await expect(page.locator("#run-button"), `${key}: Run stays`).toBeInViewport();
  }
  // Output: the whole console in the board's place.
  await expect(page.locator("#panel")).toHaveAttribute("data-dock", "all");
  await expect(page.locator("#panel-output")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeHidden();
  // Flowchart: the chart board, the code gone.
  await chart.click();
  await expect(chart).toHaveAttribute("aria-selected", "true");
  await expect(output).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#chart-board #panel-flowchart")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeHidden();
  await expect(page.locator("#panel-output")).toBeHidden();
  await code.click();
  await expect(page.locator(".cm-content")).toBeInViewport();
  await expect(page.locator("#panel")).toHaveAttribute("data-dock", "peek");
});

test("Output carries the problems count; after a failed run the code stays with its error line, and Output shows the exception", async ({ page }) => {
  await openFile(page, "main.py", BROKEN);
  const output = page.locator("#dock-toggle");
  await expect(output.locator(".dock-count")).toHaveText("0");
  await expect(output).toHaveAccessibleName("Output");
  const fill = await page.locator("#run-button").evaluate((el) => getComputedStyle(el).backgroundColor);
  await run(page);
  await expect(page.locator("#view-code")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content .cm-line.ce-error-line"), "the band on line 7").toBeInViewport();
  await expect(page.locator("#run-button")).toBeInViewport();
  await expect(output.locator(".dock-count")).toHaveText("1");
  await expect(output.locator(".dock-count")).toHaveAttribute("data-tone", "error");
  await expect(output).toHaveAccessibleName(/^Output, 1 error/);
  // Run steps back to an outline in the text colour after a failure, on an opaque ground (it
  // floats over the code): not the action fill (the pointer leaves it first, or the click's
  // pointer still hovers it and draws the hover tint on Linux WebKit).
  await page.mouse.move(0, 0);
  const runLook = await page.locator("#run-button").evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color };
  });
  expect(runLook.bg, "opaque").toMatch(/^rgb\(/);
  expect(runLook.border, "the outline is the text colour").toBe(runLook.color);
  expect(runLook.bg, "not the action fill").not.toBe(fill);
  await output.click();
  await expect(output).toHaveAttribute("aria-selected", "true");
  const exception = page.locator("#panel #run-exception");
  await expect(exception).toBeInViewport();
  await expect(exception).toContainText("ZeroDivisionError");
  await expect(exception).toContainText("line 7");
  await expect(page.locator("#console")).toContainText("Sum: 369");
});

test("the variables row is under the code in Code and at the top of Output; Run covers neither the run row nor the code's last line", async ({ page }) => {
  await openFile(page, "main.py", TALL);
  await run(page);
  const steps = page.locator("#run-steps");
  await expect(steps).toHaveAttribute("data-state", "steps", { timeout: 30_000 });
  const vars = page.locator("#run-vars");
  await expect(vars.locator(".run-var")).toHaveText(["total = 780"]);
  const [editor, varsBox, stepBox, runBox] = [await box(page.locator("#editor-panel")), await box(vars), await box(steps), await box(page.locator("#run-button"))];
  expect(varsBox.y, "the variables under the code").toBeGreaterThanOrEqual(editor.y + editor.height - 1);
  expect(varsBox.y + varsBox.height, "over the run row").toBeLessThanOrEqual(stepBox.y + 1);
  expect(Math.round(stepBox.height), "the run row").toBe(64);
  expect(overlaps(runBox, stepBox), "Run is clear of the run row").toBe(false);
  expect(overlaps(runBox, varsBox), "and of the variables").toBe(false);
  for (const id of ["#step-prev", "#step-next"]) {
    const b = await box(page.locator(id));
    expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(44);
  }
  // The code's end, scrolled to as far as it goes, and reached with Ctrl+End: its last line is clear of Run.
  const lastLine = page.locator(".cm-content .cm-line", { hasText: "print(total)" });
  await page.locator(".cm-scroller").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(lastLine).toBeVisible();
  expect(overlaps(await box(lastLine), runBox), "scrolled to the end: the last line is clear of Run").toBe(false);
  await page.locator(".cm-scroller").evaluate((el) => el.scrollTo(0, 0));
  await page.locator(".cm-content .cm-line").first().click();
  await page.keyboard.press("Control+End");
  await expect(lastLine).toBeVisible();
  await expect.poll(async () => overlaps(await box(lastLine), await box(page.locator("#run-button"))), { message: "Ctrl+End: the last line is clear of Run" }).toBe(false);
  // Output: the variables lead, then the console's tabs.
  await page.locator("#dock-toggle").click();
  const [panel, varsOut, tabsBox] = [await box(page.locator("#panel")), await box(vars), await box(page.locator("#ptab-output"))];
  expect(Math.abs(varsOut.y - panel.y), "the variables at the top of Output").toBeLessThanOrEqual(1);
  expect(varsOut.y + varsOut.height).toBeLessThanOrEqual(tabsBox.y);
  // Flowchart: the chart keeps the room (no variables row), the run row stays.
  await page.locator("#view-flowchart").click();
  await expect(vars).toBeHidden();
  await expect(steps).toBeVisible();
  // The chart's legend is folded behind Key (owner, 2026-11-19); opened, every item is clear of
  // Run, which floats over the board's foot.
  const legend = page.locator("#chart-board .fc-legend li");
  await expect(legend.first()).toBeHidden();
  await page.locator("#fc-key").click();
  await expect(legend.first()).toBeVisible();
  const runOverChart = await box(page.locator("#run-button"));
  for (const item of await legend.all()) expect(overlaps(await box(item), runOverChart), `legend: ${await item.textContent()}`).toBe(false);
});

test("a C file's one sentence (no step-through) shows on a phone, in the run row", async ({ page }) => {
  await openFile(page, "loop.c", LOOP_C);
  await run(page, { timeout: 120_000 });
  const steps = page.locator("#run-steps");
  await expect(steps).toHaveAttribute("data-state", "words");
  const words = page.locator("#run-steps .run-steps-words");
  await expect(words).toHaveText("Step-through is for Python for now.");
  await expect(words).toBeInViewport();
  expect(await words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the sentence is whole").toBe(true);
  const [w, runBox] = [await box(words), await box(page.locator("#run-button"))];
  expect(overlaps(w, runBox), "Run is clear of it").toBe(false);
});

test("with the keyboard open the dock hides and the run row is a 56 px accessory bar; Run closes the keyboard and the code stays", async ({ page }) => {
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
  await expect(page.locator("#run-button")).toHaveCSS("position", "static");
  await expect(page.locator("#run-button")).toBeInViewport();
  const strip = await box(page.locator("#panel"));
  expect(strip.y + strip.height, "on the keyboard's edge").toBeGreaterThanOrEqual(499);
  // Hide keyboard: the code lets go of the focus (the keyboard goes), and the dock comes back.
  await hide.click();
  await expect(page.locator("#app")).not.toHaveAttribute("data-keyboard", "open");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") === null)).toBe(true);
  // Typing again opens it again; Run ends typing, and the code stays on screen.
  await page.locator(".cm-content").click();
  await expect(page.locator("#app")).toHaveAttribute("data-keyboard", "open");
  await run(page);
  await expect(page.locator("#app")).not.toHaveAttribute("data-keyboard", "open");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") === null)).toBe(true);
  await expect(page.locator("#panel")).toHaveAttribute("data-dock", "peek");
  await expect(page.locator("#view-code")).toHaveAttribute("aria-selected", "true");
  // Typing again after a run: the bar shows the runtime state (not the stepper).
  await page.locator(".cm-content").click();
  await expect(page.locator("#app")).toHaveAttribute("data-keyboard", "open");
  await expect(page.locator("#panel .run-strip #status-runtime")).toBeVisible();
  await expect(page.locator("#panel .run-strip #run-steps")).toBeHidden();
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
  await expect(page.locator("#run-steps")).toHaveAttribute("data-state", "steps", { timeout: 30_000 });
  expect(await noSideScroll(page), "after a run").toBe(true);
  await page.locator("#dock-toggle").click();
  expect(await noSideScroll(page), "output").toBe(true);
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
  for (const id of ["#problems-count"]) {
    expect.soft(Math.round((await box(page.locator(id))).height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
  await run(page);
  await check("after a failed run");
  await page.locator("#dock-toggle").click();
  await check("output");
  for (const id of ["#input-toggle", "#clear-output", "#ptab-output", "#ptab-problems", "#run-exception"]) {
    expect.soft(Math.round((await box(page.locator(id))).height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
  await page.locator("#view-code").click();
  for (const id of ["#run-button", "#view-code", "#view-flowchart", "#dock-toggle", ".topbar .drawer-toggle", "#palette-button", "#settings-button"]) {
    expect.soft(Math.round((await box(page.locator(id))).height), `${id} height`).toBeGreaterThanOrEqual(44);
  }
});

test("reduced motion: choosing a tab changes the selection at once, with no animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFile(page, "main.py", MARKS);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.locator("#view-flowchart").click();
  await expect(page.locator("#view-flowchart")).toHaveAttribute("aria-selected", "true");
  const motion = await page.evaluate(() =>
    ["#view-flowchart", "#chart-board", "#run-button"].map((s) => {
      const cs = getComputedStyle(document.querySelector(s)!);
      return [s, cs.animationDuration, cs.transitionDuration];
    }),
  );
  for (const [sel, anim, trans] of motion) {
    expect(anim.split(",").every((d) => parseFloat(d) === 0), `${sel} animation ${anim}`).toBe(true);
    expect(trans.split(",").every((d) => parseFloat(d) === 0), `${sel} transition ${trans}`).toBe(true);
  }
});

test("Signal light keeps a light console ground on phones (no dark slab)", async ({ page }) => {
  // Signal (match device), chosen in this build: marked, so never moved to the default, Electric Blue.
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("codeeditor:theme", "signal");
    localStorage.setItem("codeeditor:theme-default", "electric-blue");
  });
  await openFile(page, "main.py", MARKS, { width: 390, height: 844 }, "light");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
  await run(page);
  const grounds = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim();
    return { root, panel: getComputedStyle(document.querySelector("#panel")!).getPropertyValue("--terminal-bg").trim(), scheme: getComputedStyle(document.querySelector("#panel")!).colorScheme };
  });
  expect(grounds.panel).toBe(grounds.root);
  expect(grounds.scheme).not.toBe("dark");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing at 390 px (${scheme}): before a run, after a failed run, output, flowchart`, async ({ page }) => {
    await openFile(page, "main.py", BROKEN, { width: 390, height: 844 }, scheme);
    const scan = async (state: string) => {
      const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect.soft(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${scheme} ${state}`).toEqual([]);
    };
    await scan("before a run");
    await run(page);
    await scan("after a failed run");
    await page.locator("#dock-toggle").click();
    await scan("output");
    await page.locator("#view-flowchart").click();
    await expect(page.locator("#chart-board #panel-flowchart")).toBeVisible();
    await scan("flowchart");
    // The folded legend, opened (owner, 2026-11-19).
    await page.locator("#fc-key").click();
    await expect(page.getByRole("list", { name: "Shapes" })).toBeVisible();
    await scan("flowchart, key open");
  });
}
