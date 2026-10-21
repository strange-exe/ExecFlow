// The suggestion (autocomplete) list as a student meets it: opening it, the way out of the editor
// with the list open or inside a snippet, tabs that turn read-only, target sizes and contrast
// (Tier 0 of the autocomplete research, 2026-10-18); library names, the "Suggestions while typing"
// setting and the lazy library data (Tier 1, 2026-10-19).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { audit } from "./audit";
import {
  expect, expectActive, importFiles, openApp, openFromTree, reloadApp, responseBodies, setCode, showView, test, tolerating, waitReady,
} from "./helpers";

test.use({ serviceWorkers: "block" });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const list = (page: Page) => page.getByRole("listbox", { name: "Suggestions" });
/** The option whose label is exactly `label` (the label span; the detail is a separate span). */
const option = (page: Page, label: string) =>
  list(page).getByRole("option").filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label}$`) }) });
const editorText = (page: Page) => page.locator(".cm-content").evaluate((el) => (el as HTMLElement).innerText);
/** The editor's lines, as CodeMirror shows them (an empty line is ""). */
const lines = (page: Page) => page.locator(".cm-content .cm-line").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
/** The option an arrow key picked (none until then: selectOnOpen is false). */
const picked = (page: Page) => list(page).locator('[role=option][aria-selected="true"]');

/**
 * CodeMirror ignores the list's keys for 75 ms after it opens (autocomplete 6.20.3,
 * interactionDelay): a key pressed sooner falls through to the editor whatever the setting, so a
 * test of Enter or the arrows would pass without the list taking part. Wait well past it.
 */
const pastInteractionDelay = (page: Page) => page.waitForTimeout(250);

/** A new main.py from the Python starter, emptied, with the cursor in the editor. */
async function emptyPythonFile(page: Page) {
  await page.locator('.starter[data-language="python"]').click();
  // (Phones have no tab strip: expectActive checks the selected tab is attached, the editor shown.)
  await expectActive(page, "main.py");
  await showView(page, "code");
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-language", "python");
  await setCode(page, "");
}

/** Escape then Tab: focus leaves the editor and the text stays as it was. */
async function escapeTabLeaves(page: Page) {
  const before = await editorText(page);
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-content")).not.toBeFocused();
  expect(await editorText(page), "Tab changed the text instead of leaving").toBe(before);
}

test("the list opens by typing and with Ctrl+Space, with 24 px rows and a space before each detail", async ({ page }) => {
  await openApp(page);
  await emptyPythonFile(page);
  await page.keyboard.type("pr");
  await expect(option(page, "print")).toBeVisible();
  const heights = await list(page).getByRole("option").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights), `option heights ${heights.join(", ")}`).toBeGreaterThanOrEqual(24);
  const targets = (await audit(page)).targets.filter((t) => t.sel.includes("[role=option]"));
  expect(targets, "undersized options").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await expect(option(page, "print")).toBeVisible();
  await page.keyboard.press("Escape");

  // Label and detail are separate words in the text, not "deffunction".
  await setCode(page, "");
  await page.keyboard.type("de");
  const def = option(page, "def");
  await expect(def).toBeVisible();
  await expect(def).toHaveAccessibleName("def function");
  await expect(def.locator(".cm-completionDetail")).toHaveText("function");
});

test("Enter accepts only a picked suggestion: with nothing picked it makes a new line", async ({ page }) => {
  await openApp(page);
  await emptyPythonFile(page);
  const content = page.locator(".cm-content");

  // "n = i": the list offers names starting with i, nothing is picked, and Enter is a new line.
  // (Soft checks: one run shows every way the list's Enter is wrong.)
  await page.keyboard.type("n = i");
  await expect(list(page).getByRole("option").first()).toBeVisible();
  await expect.soft(picked(page), "nothing is picked when the list opens").toHaveCount(0);
  await expect.soft(content).not.toHaveAttribute("aria-activedescendant", /./);
  await pastInteractionDelay(page);
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  expect.soft(await lines(page), "Enter after n = i").toEqual(["n = i", ""]);

  // "print" matches an option exactly; Enter still makes a new line.
  await setCode(page, "");
  await page.keyboard.type("print");
  await expect(option(page, "print")).toBeVisible();
  await expect.soft(picked(page)).toHaveCount(0);
  await pastInteractionDelay(page);
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  expect.soft(await lines(page), "Enter after print").toEqual(["print", ""]);

  // Down picks the first option (named by aria-activedescendant); then Enter accepts it.
  await setCode(page, "");
  await page.keyboard.type("prin");
  await expect(option(page, "print")).toBeVisible();
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await expect(picked(page)).toHaveCount(1);
  const first = await list(page).getByRole("option").first().getAttribute("id");
  await expect(picked(page)).toHaveAttribute("id", first ?? "(no id)");
  await expect(content).toHaveAttribute("aria-activedescendant", first ?? "(no id)");
  await expect(picked(page).locator(".cm-completionLabel")).toHaveText("print");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  expect(await lines(page)).toEqual(["print"]);

  // Up from nothing picks the last option.
  await setCode(page, "");
  await page.keyboard.type("i");
  await expect(option(page, "if").first()).toBeVisible();
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowUp");
  await expect(picked(page)).toHaveCount(1);
  expect(await picked(page).evaluate((li) => li === li.parentElement?.lastElementChild)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  expect(await lines(page)).toEqual(["i"]);
});

test("Escape then Tab leaves the editor with the list closed, with it open, and inside a snippet", async ({ page }) => {
  await openApp(page);
  await emptyPythonFile(page);

  // 1. Nothing open: CodeMirror's own Escape.
  await escapeTabLeaves(page);

  // 2. The list open: the Escape that closes it also arms the way out.
  await page.locator(".cm-content").click();
  await page.keyboard.type("pr");
  await expect(option(page, "print")).toBeVisible();
  await escapeTabLeaves(page);
  expect(await editorText(page)).toBe("pr");

  // 3. Right after accepting a snippet: the Escape that ends it also arms the way out.
  await setCode(page, "");
  await page.keyboard.type("def");
  await option(page, "def").click();
  await expect(page.locator(".cm-snippetField").first()).toBeVisible();
  expect(await editorText(page)).toMatch(/^def name\(params\):/);
  await escapeTabLeaves(page);
  await expect(page.locator(".cm-snippetField")).toHaveCount(0);

  // 4. In a snippet with the list open: Tab alone moves to the next field, and the Escape that
  //    closes the list arms the way out (so that Tab leaves rather than moving on). The snippet stays.
  await setCode(page, "");
  await page.keyboard.type("def");
  await option(page, "def").click();
  await expect(page.locator(".cm-snippetField").first()).toBeVisible();
  await page.keyboard.type("fo");
  await expect(list(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.type("n");
  expect(await editorText(page)).toMatch(/^def fo\(n\):/);
  await expect(list(page)).toBeVisible();
  await escapeTabLeaves(page);
  await expect(page.locator(".cm-snippetField").first()).toBeAttached();
});

// Section 3 of the research doc: in Ctrl+M mode (Shift+Alt+M on macOS) Tab always leaves the
// editor, with the list open (accepting nothing) and inside a snippet (it can't move between
// fields there; the Shortcuts dialog says so). From the behaviour review's probe (RB-3, 2026-10-19).
test("in Ctrl+M mode Tab leaves the editor with the list open, accepting nothing, and inside a snippet", async ({ page }) => {
  await openApp(page);
  await emptyPythonFile(page);
  const content = page.locator(".cm-content");
  const toggle = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Shift+Alt+m" : "Control+m";
  await page.keyboard.press(toggle);
  await page.keyboard.type("pri");
  await expect(option(page, "print")).toBeVisible();
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await expect(picked(page)).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(content, "Tab in Ctrl+M mode leaves").not.toBeFocused();
  await expect(list(page), "leaving the editor closes the list").toHaveCount(0);
  expect(await editorText(page)).toBe("pri");

  // Back in (the mode stays on): a snippet accepted with Down and Enter; Tab leaves it.
  await setCode(page, "");
  await page.keyboard.type("def");
  await expect(option(page, "def")).toBeVisible();
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await expect(picked(page).locator(".cm-completionLabel")).toHaveText("def");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-snippetField").first()).toBeVisible();
  const before = await editorText(page);
  await page.keyboard.press("Tab");
  await expect(content, "Tab in Ctrl+M mode leaves a snippet too").not.toBeFocused();
  expect(await editorText(page)).toBe(before);
  await content.click();
  await page.keyboard.press(toggle);
});

test("a tab that turns read-only closes its list and offers none; the writer's edits still reach it", async ({ page, context }) => {
  await openApp(page);
  await emptyPythonFile(page);
  await expect(page.locator("#app")).toHaveAttribute("data-role", "writer");
  await page.keyboard.type("pr");
  await expect(option(page, "print")).toBeVisible();
  const content = page.locator(".cm-content");
  // aria-autocomplete is there while the file has suggestion sources (CodeMirror's own attribute).
  await expect(content).toHaveAttribute("aria-autocomplete", "list");
  await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  // Where print's option is drawn, for a mouse press once the tab is read-only.
  const printBox = (await option(page, "print").boundingBox())!;

  // Another tab takes over editing: this one turns read-only with the list still open.
  const second = await context.newPage();
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await second.locator("#read-only-banner").getByRole("button", { name: "Edit here" }).click();
  await expect(second.locator("#app")).toHaveAttribute("data-role", "writer", { timeout: 10_000 });
  await expect(page.locator("#app")).toHaveAttribute("data-role", "reader", { timeout: 10_000 });
  await expect(content).toHaveAttribute("aria-readonly", "true");

  // Its sources went with the lock, so the open list closed and no option is left to click: a press
  // where print's option was changes nothing.
  await expect(content).not.toHaveAttribute("aria-autocomplete", /./);
  await expect(list(page)).toHaveCount(0);
  await page.mouse.click(printBox.x + printBox.width / 2, printBox.y + printBox.height / 2);
  expect(await editorText(page)).toBe("pr");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+Space");
  await expect(content).not.toHaveAttribute("aria-autocomplete", /./);
  await expect(list(page)).toHaveCount(0);
  expect(await editorText(page)).toBe("pr");

  // The writer's saved edit still replaces the reader's text (refusing picks doesn't block this).
  await second.locator(".cm-content").click();
  await second.keyboard.press("Control+End");
  await second.keyboard.type("  # from the second tab");
  await expect(second.locator('.tab[data-dirty="true"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(content).toContainText("# from the second tab", { timeout: 10_000 });
  await second.close();
});

/** WCAG relative luminance contrast of two "rgb(...)" colours, the first drawn at `alpha` over the second. */
function ratioOver(fg: string, bg: string, alpha: number): number {
  const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const [f, b] = [parse(fg), parse(bg)];
  const mixed = [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha));
  const lum = (v: number[]) => {
    const [r, g, bl] = v.map((x) => {
      const s = x / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(mixed), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const scheme of ["light", "dark"] as const) {
  test(`with the list open (${scheme}): axe is clean, icons and details are solid and readable`, async ({ page }, info) => {
    // Load, emulate, reload, then prove the theme is active (Firefox drops emulation set before the first load).
    await page.goto("/");
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await waitReady(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await emptyPythonFile(page);
    await page.keyboard.type("i");
    await expect(option(page, "if").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // axe-core 4.13 exempts a scrolling listbox that a role=combobox controls ("combobox popup"):
    // the arrow keys move the active option and the list scrolls to it. CodeMirror's list works
    // the same way, controlled from the editor, which is a textbox (ARIA 1.2 allows
    // aria-autocomplete, aria-controls and aria-activedescendant there), so axe reports
    // scrollable-region-focusable on it. That one finding on the list itself is a false positive:
    // the keyboard reach it stands for is checked after the scan.
    const listId = await page.locator(".cm-content").getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    const onlyTheList = (v: (typeof result.violations)[number]) =>
      v.id === "scrollable-region-focusable" && v.nodes.every((n) => n.target.join(" ") === `#${listId}`);
    const axe = result.violations.filter((v) => !onlyTheList(v)).map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
    expect(axe).toEqual([]);

    // Nothing is picked when the list opens (selectOnOpen: false): Down picks the first option, so
    // the checks below see a picked row as well as plain ones. (The scan took far longer than the
    // 75 ms CodeMirror waits before the list takes keys.)
    await expect(picked(page)).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(picked(page)).toHaveCount(1);
    const box = (await page.locator(".cm-tooltip-autocomplete").boundingBox())!;
    await page.screenshot({
      path: `${process.env.SHOTS_DIR ?? "e2e/shots"}/suggestions/${info.project.name}-${scheme}.png`,
      animations: "disabled",
      clip: { x: Math.max(0, box.x - 120), y: Math.max(0, box.y - 60), width: box.width + 240, height: box.height + 90 },
    });

    // Every kind icon and detail: solid (no opacity) and at least 4.5:1 on its row, selected or not.
    const painted = await list(page).getByRole("option").evaluateAll((rows) =>
      rows.flatMap((row) => {
        // What is really painted behind the row: a translucent fill (the picked option's
        // list-selected wash, the active-line band) is composited over the grounds below it.
        const back = (el: Element | null): string => {
          const layers: number[][] = [];
          for (let e = el; e; e = e.parentElement) {
            const [r, g, b, a = 1] = (getComputedStyle(e).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
            if (r === undefined || a === 0) continue;
            layers.push([r, g, b, a]);
            if (a >= 1) break;
          }
          let acc = [255, 255, 255];
          for (const [r, g, b, a] of layers.reverse()) acc = [r, g, b].map((v, i) => v * a + acc[i] * (1 - a));
          return `rgb(${acc.map((v) => Math.round(v)).join(", ")})`;
        };
        return [...row.querySelectorAll(".cm-completionIcon, .cm-completionDetail")].map((el) => ({
          what: `${el.className} in "${row.textContent}"${row.hasAttribute("aria-selected") ? " (selected)" : ""}`,
          color: getComputedStyle(el).color,
          opacity: Number(getComputedStyle(el).opacity),
          bg: back(row),
        }));
      }),
    );
    expect(painted.some((p) => p.what.includes("cm-completionIcon"))).toBe(true);
    expect(painted.some((p) => p.what.includes("cm-completionDetail"))).toBe(true);
    expect(painted.some((p) => p.what.includes("(selected)"))).toBe(true);
    const low = painted.filter((p) => p.opacity < 1 || ratioOver(p.color, p.bg, 1) < 4.5).map((p) => `${p.what}: ${p.color} at ${p.opacity} on ${p.bg}`);
    expect(low).toEqual([]);

    // The keyword icon is a mask over the icon's colour, not an emoji: WebKit ignored CodeMirror's
    // text-presentation selector and painted a colour key that no theme colour reached.
    const keyword = await list(page).locator(".cm-completionIcon-keyword").first().evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return { content: after.content, mask: after.getPropertyValue("mask-image") || after.getPropertyValue("-webkit-mask-image"), fill: after.backgroundColor, color: getComputedStyle(el).color };
    });
    expect(keyword.content, "no emoji or text in the keyword icon").toMatch(/^(""|''|none)$/);
    expect(keyword.mask).toContain("data:image/svg+xml");
    expect(keyword.fill, "the key takes the icon's colour").toBe(keyword.color);

    // Keyboard reach of the scrolling list: ArrowUp on the first option (picked above) wraps to the
    // last one, and the list scrolls so that it is in view.
    expect(await list(page).evaluate((ul) => ul.scrollHeight > ul.clientHeight), "the list scrolls").toBe(true);
    expect(await picked(page).evaluate((li) => li === li.parentElement?.firstElementChild), "Down picked the first option").toBe(true);
    await page.keyboard.press("ArrowUp");
    const selected = picked(page);
    await expect(selected).toHaveCount(1);
    expect(await selected.evaluate((li) => li === li.parentElement?.lastElementChild)).toBe(true);
    expect(
      await selected.evaluate((li) => {
        const [r, p] = [li.getBoundingClientRect(), li.parentElement!.getBoundingClientRect()];
        return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
      }),
      "the last option scrolled into view",
    ).toBe(true);
  });
}

test.describe("on a touch screen", () => {
  // Decided before the context exists: Firefox refuses isMobile, and only Chromium is known to report pointer: coarse.
  test.skip(({ browserName }) => browserName !== "chromium", "Playwright emulates a mobile device (pointer: coarse) in Chromium only");
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("options are 44 px tall", async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulated").toBe(true);
    await emptyPythonFile(page);
    await page.keyboard.type("pr");
    await expect(option(page, "print")).toBeVisible();
    const heights = await list(page).getByRole("option").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.min(...heights), `option heights ${heights.join(", ")}`).toBeGreaterThanOrEqual(44);
  });
});

// ---------------------------------------------------------------- library names (Tier 1)

const editor = (page: Page) => page.locator(".cm-editor");

/** The file's library data has loaded (library-completion.ts libraryLoader marks the editor). */
const libraryReady = (page: Page) => expect(editor(page)).toHaveAttribute("data-library", "ready");

/** A new file from a starter, emptied, the cursor in the editor and its library data loaded. */
async function emptyStarter(page: Page, language: "python" | "c" | "cpp") {
  await page.locator(`.starter[data-language="${language}"]`).click();
  await expectActive(page, { python: "main.py", c: "main.c", cpp: "main.cpp" }[language]);
  await showView(page, "code");
  await expect(editor(page)).toHaveAttribute("data-language", language);
  await libraryReady(page);
  await setCode(page, "");
}

/** axe with the list open: clean but for the one false positive on the list itself (see above). */
async function axeWithListOpen(page: Page): Promise<string[]> {
  const listId = await page.locator(".cm-content").getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const onlyTheList = (v: (typeof result.violations)[number]) =>
    v.id === "scrollable-region-focusable" && v.nodes.every((n) => n.target.join(" ") === `#${listId}`);
  return result.violations.filter((v) => !onlyTheList(v)).map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

test("#include <st offers stdio.h and no keywords; Down then Enter writes the whole line", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "c");
  await page.keyboard.type("#include <st");
  await expect(option(page, "stdio.h")).toBeVisible();
  await expect(option(page, "int")).toHaveCount(0);
  // stdio.h leads the headers (library-completion.ts BEGINNER): the first Down picks it.
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await expect(picked(page).locator(".cm-completionLabel")).toHaveText("stdio.h");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  expect(await lines(page)).toEqual(["#include <stdio.h>"]);
});

/** The labels of the open list, top to bottom (the list renders from its first option until one is picked). */
const order = (page: Page) => list(page).locator(".cm-completionLabel").allTextContents();

// Review finding RB-2 (2026-10-19): options without a section (keywords, snippets) always ranked
// above every library name, however well they matched, so `str` showed struct, restrict, register
// and _Static_assert before strlen (26th of 48), and the common names lost to alphabetical order.
test("the best match comes first: common library names lead, and a fuzzy keyword never beats a prefix match", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "c");
  const first = async (typed: string, want: string) => {
    await setCode(page, "");
    await page.keyboard.type(typed);
    // The list answers what was typed: while a query runs (pending) it still shows the last one's
    // options, and "p" already offers puts (Firefox in a full run, 2026-10-21: printf came first).
    await expect(page.locator(".cm-editor")).toHaveAttribute("data-completion", "active");
    await expect(option(page, want).first()).toBeVisible();
    const labels = await order(page);
    expect(labels[0], `${typed}: ${labels.slice(0, 8).join(", ")}`).toBe(want);
    await page.keyboard.press("Escape");
    return labels;
  };
  const str = await first("str", "strlen");
  // Every name that starts with "str" ranks above the keywords that only contain s, t and r.
  const lastPrefix = Math.max(...str.map((l, i) => (l.startsWith("str") ? i : -1)));
  for (const fuzzy of ["restrict", "register", "_Static_assert"]) {
    if (str.includes(fuzzy)) expect(str.indexOf(fuzzy), `${fuzzy} below every str... name`).toBeGreaterThan(lastPrefix);
  }
  await first("pu", "puts");
  await first("#include <st", "stdio.h");

  await importFiles(page, [{ name: "main.cpp", text: "int main() {\n}\n" }]);
  await openFromTree(page, "main.cpp");
  await showView(page, "code");
  await libraryReady(page);
  await first("std::co", "cout");
  await first("#include <io", "iostream");

  await importFiles(page, [{ name: "main.py", text: "print(1)\n" }]);
  await openFromTree(page, "main.py");
  await showView(page, "code");
  await libraryReady(page);
  await first("import ma", "math");
});

test("import ma offers math and no builtins; math.sq offers sqrt with its signature, and Down then Enter accepts it", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "python");
  await page.keyboard.type("import ma");
  await expect(option(page, "math")).toBeVisible();
  await expect(option(page, "map")).toHaveCount(0);
  await expect(option(page, "max")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await setCode(page, "import math\n");
  await page.keyboard.type("math.sq");
  const sqrt = option(page, "sqrt");
  await expect(sqrt).toBeVisible();
  await expect(sqrt.locator(".cm-completionDetail")).toHaveText("(x, /)");
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await expect(picked(page).locator(".cm-completionLabel")).toHaveText("sqrt");
  // Our own one-line info, linked to the picked option for screen readers (only a synchronous info is).
  await expect(picked(page)).toHaveAttribute("aria-describedby", /./);
  const info = await picked(page).getAttribute("aria-describedby");
  await expect(page.locator(`#${info}`)).toHaveText("Function in math");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  expect(await lines(page)).toEqual(["import math", "math.sqrt"]);
});

test("C++ headers come in two groups whose headings are for the eye only; axe is clean with them open", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "cpp");
  await page.keyboard.type("#include <std");
  await expect(option(page, "stdexcept")).toBeVisible();
  const headings = list(page).locator("completion-section");
  await expect(headings).toHaveText(["C++ library", "C library"]);
  for (const h of await headings.all()) await expect(h).toHaveAttribute("aria-hidden", "true");
  await page.evaluate(() => document.fonts.ready);
  expect(await axeWithListOpen(page)).toEqual([]);
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeInViewport();
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/shots"}/suggestions/cpp-headers-${test.info().project.name}.png`, animations: "disabled" });
});

// Design decision 17 (review RB-7); the scope rules are in using-std.test.ts.
test("after using namespace std; std names come without the prefix, below your own names; without it they don't", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "cpp");
  await setCode(page, "#include <vector>\nusing namespace std;\nint vec_total;\n\nint main() {\n    ");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("vec");
  const vector = option(page, "vector");
  await expect(vector).toBeVisible();
  await expect(vector.locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-class/);
  // Your own vec_total matches as well (a prefix) and comes first.
  expect((await order(page)).slice(0, 2)).toEqual(["vec_total", "vector"]);
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(picked(page).locator(".cm-completionLabel")).toHaveText("vector");
  await expect(picked(page)).toHaveAccessibleDescription("std::vector, declared in <vector>");
  await page.keyboard.press("Enter");
  expect((await lines(page)).at(-1)).toBe("    vector");

  // Without the directive: no std name without the prefix.
  await setCode(page, "#include <vector>\nint vec_total;\n\nint main() {\n    ");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("vec");
  await expect(option(page, "vec_total")).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-completion", "active");
  await expect(option(page, "vector")).toHaveCount(0);
});

test("Suggestions while typing: off, typing opens no list but Ctrl+Space does, and it stays off after a reload", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "python");
  const content = page.locator(".cm-content");
  // On (the default): the keystroke that can open the list starts a query in the same update.
  await page.keyboard.type("pr");
  await expect(editor(page)).toHaveAttribute("data-completion", /^(pending|active)$/);
  await expect(option(page, "print")).toBeVisible();
  await page.keyboard.press("Escape");
  await setCode(page, "");

  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const box = settings.getByRole("checkbox", { name: "Suggestions while typing" });
  await expect(box).toBeChecked();
  await expect(box).toHaveAccessibleDescription("Ctrl+Space always shows them.");
  await box.uncheck();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // Off: with typing activation the same update that shows "pr" would have marked it pending.
  const typedStaysClosed = async () => {
    await setCode(page, "");
    await page.keyboard.type("pr");
    await expect(content).toHaveText("pr");
    await expect(editor(page)).toHaveAttribute("data-completion", "closed");
    await expect(list(page)).toHaveCount(0);
    await page.keyboard.press("Control+Space");
    await expect(option(page, "print")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list(page)).toHaveCount(0);
  };
  await typedStaysClosed();

  await reloadApp(page);
  await expectActive(page, "main.py");
  await showView(page, "code");
  await page.locator("#settings-button").click();
  await expect(box).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await typedStaysClosed();
});

test("the library data is not part of the first visit: each part loads when a file of its language is shown", async ({ page }) => {
  const MARKS = { python: "gen-python-completions.mjs", c: "gen-c-completions.mjs" } as const;
  const bodies = responseBodies(
    page,
    (path) => /^\/assets\/[^/]+\.js$/.test(path),
    (path, body) => ({ path, data: (Object.keys(MARKS) as (keyof typeof MARKS)[]).filter((k) => body.includes(MARKS[k])) }),
  );
  /** Which data each chunk carried, one entry per chunk and library (each in its own chunk). */
  const loaded = async () => (await bodies.settled()).flatMap((b) => b.data);
  await openApp(page);
  await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
  expect(await loaded(), "library data on the first visit").toEqual([]);

  await page.locator('.starter[data-language="python"]').click();
  await expectActive(page, "main.py");
  await libraryReady(page);
  expect(await loaded()).toEqual(["python"]);

  await importFiles(page, [{ name: "main.c", text: "int main(void) {\n    return 0;\n}\n" }]);
  await openFromTree(page, "main.c");
  await libraryReady(page);
  expect((await loaded()).sort()).toEqual(["c", "python"]);
});

// The library and own-name suggestions are a chunk of their own (completion-loader.ts). On a first
// visit its request can fail after the editor chunk came (the network goes, a deploy replaced the
// files). Typing then offers the keywords and snippets, which are the editor chunk's, and nothing
// else, and nothing throws; the browser reports only its own failed request. A query after the retry
// window loads it, where the browser fetches it again (Chromium and Firefox, as the HTML Standard
// says), and the shown file's loaders start then; a reload works too. Playwright 1.64's WebKit never
// asked for the chunk again in that browser context, in the page or after two reloads (aborted or
// answered 404, measured 2026-10-21), so there only the failure is checked.
test.describe("when the suggestion chunk can't load on a first visit", () => {
  test.use(
    tolerating(
      // The browser's own report of the one request this test makes fail.
      /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js (net::ERR_INTERNET_DISCONNECTED|NS_ERROR_OFFLINE|Blocked by Web Inspector)$/,
    ),
  );

  test("typing offers only keywords and snippets and nothing throws; a later try and a reload bring the library names and the loaders back", async ({ page, browserName }) => {
    // library-data.ts's error text: only the suggestion chunk has it (design.spec finds it the same way).
    const MARK = "not library data";
    let failing = true;
    const failed: string[] = [];
    await page.route("**/assets/*.js", async (route) => {
      const response = await route.fetch();
      if (failing && (await response.text()).includes(MARK)) {
        failed.push(new URL(route.request().url()).pathname);
        return route.abort("internetdisconnected");
      }
      return route.fulfill({ response });
    });
    // The retry window (CODE_RETRY_MS, 30 s) is passed by moving Date.now on, not by waiting.
    await page.addInitScript(() => {
      const now = Date.now.bind(Date);
      const w = window as unknown as { __later: number };
      w.__later = 0;
      Date.now = () => now() + w.__later;
    });
    const editor = page.locator(".cm-editor");
    const typeWord = async (text: string) => {
      await page.keyboard.type(text, { delay: 100 });
      // Every query has answered (pending while the sources run).
      await expect(editor).toHaveAttribute("data-completion", /^(closed|active)$/);
    };

    /** The option whose detail is exactly `detail`: the printf snippet's is "statement", the library function's its prototype. */
    const withDetail = (detail: string) => list(page).getByRole("option").filter({ has: page.locator(".cm-completionDetail", { hasText: new RegExp(`^${detail.replace(/[()*.]/g, "\\$&")}$`) }) });
    const PRINTF = "int printf(const char *, ...)";

    await openApp(page);
    await page.locator('.starter[data-language="c"]').click();
    await expect(editor).toHaveAttribute("data-library", "failed");
    expect(failed, "the suggestion chunk's request was made to fail").toHaveLength(1);
    await setCode(page, "int main(void) {\n    ");
    await page.keyboard.press("Control+End");
    // The keywords and snippets are the editor chunk's: offered while the chunk is missing.
    await typeWord("ret");
    await expect(option(page, "return")).toBeVisible();
    await page.keyboard.press("Escape");
    await setCode(page, "int main(void) {\n    ");
    await page.keyboard.press("Control+End");
    await typeWord("pri");
    await expect(withDetail("statement"), "the printf snippet").toBeVisible();
    // Nothing from the chunk that failed: no library function, nor the file's own main.
    await expect(withDetail(PRINTF)).toHaveCount(0);
    await expect(list(page).locator(".cm-completionIcon-function")).toHaveCount(0);
    await page.keyboard.press("Control+Space");
    await expect(editor).toHaveAttribute("data-completion", "active");
    await expect(list(page).locator(".cm-completionIcon-function")).toHaveCount(0);

    if (browserName === "webkit") return; // see above: WebKit doesn't fetch it again in this context

    // The network is back and the retry window has passed: the next query loads the chunk.
    failing = false;
    await page.evaluate(() => void ((window as unknown as { __later: number }).__later = 31_000));
    await page.keyboard.type("n", { delay: 100 });
    await expect(withDetail(PRINTF)).toBeVisible();
    // The shown file's loaders started too: the library data and its headers' names.
    await expect(editor).toHaveAttribute("data-library", "ready");
    await expect(editor).toHaveAttribute("data-index", "ready");
    await page.keyboard.press("Escape");

    await reloadApp(page);
    await expectActive(page, "main.c");
    await expect(editor).toHaveAttribute("data-library", "ready");
    await expect(editor).toHaveAttribute("data-index", "ready");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("pri", { delay: 100 });
    await expect(withDetail(PRINTF)).toBeVisible();
  });
});

// 320 px too: there the list's own width cap (95vw) left it 6 px from the right edge (review RB-6).
for (const [width, height] of [[320, 640], [390, 844]] as const) test.describe(`at ${width} px`, () => {
  test.use({ viewport: { width, height } });

  test("the open list keeps 8 px from the screen's sides with no sideways scroll, and the info never covers an option", async ({ page }) => {
    await openApp(page);
    await emptyStarter(page, "c");
    // Long prototypes in the details: the widest list a beginner sees.
    await page.keyboard.type("pri");
    await expect(option(page, "printf").first()).toBeVisible();
    // CodeMirror creates a tooltip 10000 px above the screen and places it in its next measure
    // (WebKit was read once before that: top -10000, left 0): wait until it is on screen.
    await expect(page.locator(".cm-tooltip-autocomplete")).toBeInViewport();
    const measure = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const r = document.querySelector(".cm-tooltip-autocomplete")!.getBoundingClientRect();
        return { scroll: root.scrollWidth - root.clientWidth, width: root.clientWidth, left: r.left, right: r.right, top: r.top };
      });
    const m = await measure();
    test.info().annotations.push({ type: `list at ${width} px`, description: `x ${m.left.toFixed(1)}..${m.right.toFixed(1)} of ${m.width}, top ${m.top.toFixed(1)}` });
    expect(m.scroll, "sideways scroll with the list open").toBeLessThanOrEqual(0);
    expect(m.left, "8 px from the left edge").toBeGreaterThanOrEqual(8 - 0.5);
    expect(m.right, "8 px from the right edge").toBeLessThanOrEqual(m.width - 8 + 0.5);

    // Pick the library's printf (the printf statement comes first: the same boost, and the keyword list's options lead).
    await pastInteractionDelay(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(picked(page).locator(".cm-completionDetail")).toHaveText("int printf(const char *, ...)");
    // No room beside the list here: the info would cover the next option, so it isn't drawn, and it
    // is still the picked option's description.
    const info = page.locator(".cm-completionInfo");
    await expect(info).toHaveClass(/cm-completionInfo-(left|right)-narrow/);
    await expect(info).toBeHidden();
    await expect(picked(page)).toHaveAccessibleDescription("Declared in <stdio.h>");
    const next = picked(page).locator("xpath=following-sibling::li[1]");
    expect(
      await next.evaluate((li) => {
        const r = li.getBoundingClientRect();
        return li.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }),
      "the option below the picked one can be reached",
    ).toBe(true);
    expect((await measure()).scroll, "sideways scroll with an option picked").toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/shots"}/suggestions/library-${width}-${test.info().project.name}.png`, animations: "disabled" });
  });
});

test("on a wide screen the picked option's info is drawn beside the list", async ({ page }) => {
  await openApp(page);
  await emptyStarter(page, "c");
  await page.keyboard.type("pri");
  await expect(option(page, "printf").first()).toBeVisible();
  await pastInteractionDelay(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(picked(page).locator(".cm-completionDetail")).toHaveText("int printf(const char *, ...)");
  const info = page.locator(".cm-completionInfo");
  await expect(info).toBeVisible();
  await expect(info).toHaveText("Declared in <stdio.h>");
  await expect(info).toHaveClass(/cm-completionInfo-(left|right)(?!-)/);
  await expect(picked(page)).toHaveAccessibleDescription("Declared in <stdio.h>");
  await expect(info).toBeInViewport();
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "e2e/shots"}/suggestions/library-info-${test.info().project.name}.png`, animations: "disabled" });
});
