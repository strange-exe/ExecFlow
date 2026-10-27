// The bottom panel's height when the Flowchart tab opens (owner, 2026-10-26: "grow the bottom panel
// taller if it's small, and keep my own size otherwise"; src/ui/panel-size.ts). Desktop only: a
// panel under 55 percent grows to it through the splitter (its value and the remembered size agree),
// one at or above stays, nothing ever shrinks, leaving the tab keeps the size, a size the student sets
// stands until it is below the threshold at another opening, and a short window keeps the editor.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, test } from "./helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
test.setTimeout(90_000);

const PROGRAM = "int main(void) {\n    int n = 3;\n    if (n > 2) n = 2;\n    return n;\n}\n";
const splitter = (page: Page) => page.getByRole("separator", { name: "Resize the output panel" });
const remembered = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("codeeditor:layout") ?? "{}") as { panel?: number }).panel ?? null);

async function start(page: Page, panel?: number) {
  if (panel !== undefined) {
    // The remembered size, as an earlier visit left it.
    await page.goto("/");
    await page.evaluate((v) => localStorage.setItem("codeeditor:layout", JSON.stringify({ panel: v })), panel);
  }
  await openApp(page);
  await importFiles(page, [{ name: "main.c", text: PROGRAM }]);
  await openFromTree(page, "main.c");
}
const open = async (page: Page, tab: "output" | "problems" | "flowchart") => page.locator(`#ptab-${tab}`).click();
/** The panel's share of the editor's and the panel's rows, in percent (what is on screen). */
const shown = (page: Page) =>
  page.evaluate(() => {
    const e = document.getElementById("editor-area")!.getBoundingClientRect().height;
    const p = document.getElementById("panel")!.getBoundingClientRect().height;
    return Math.round((p / (e + p)) * 100);
  });

test("a small panel grows to 55 percent when the Flowchart tab opens; Output keeps the size", async ({ page }) => {
  await start(page);
  await open(page, "output");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "35");
  await open(page, "flowchart");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
  await expect(splitter(page)).toHaveAttribute("aria-valuetext", "55 percent of the height");
  expect(await remembered(page)).toBe(55);
  expect(Math.abs((await shown(page)) - 55)).toBeLessThanOrEqual(2);
  // No snap back on leaving the tab.
  await open(page, "output");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
  await open(page, "problems");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
});

test("a collapsed panel opened by the Flowchart tab grows too", async ({ page }) => {
  await start(page);
  await open(page, "output");
  await page.locator("#panel-toggle").click();
  await expect(page.locator("#panel")).toHaveAttribute("data-collapsed", "true");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "35");
  await open(page, "flowchart");
  await expect(page.locator("#panel")).toHaveAttribute("data-collapsed", "false");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
});

for (const size of [55, 70]) {
  test(`a panel already at ${size} percent is left as it is (never shrunk)`, async ({ page }) => {
    await start(page, size);
    await open(page, "flowchart");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", String(size));
    expect(await remembered(page)).toBe(size);
  });
}

test("a size the student sets afterwards is theirs, until it is below the threshold at another opening", async ({ page }) => {
  await start(page);
  await open(page, "flowchart");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
  // Taller by the keyboard splitter: kept across openings.
  await splitter(page).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "65");
  await open(page, "output");
  await open(page, "flowchart");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "65");
  expect(await remembered(page)).toBe(65);
  // Shorter while the chart is open: the student's choice stands while the tab stays open...
  await splitter(page).focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "40");
  await page.waitForTimeout(200);
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "40");
  // ...and the next opening of the tab grows it again, as a small panel.
  await open(page, "output");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "40");
  await open(page, "flowchart");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "55");
  // Dragging taller is theirs too.
  const r = (await page.locator("#editor-area").boundingBox())!;
  const s = (await splitter(page).boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2, r.y + r.height * 0.4, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await splitter(page).getAttribute("aria-valuenow"));
  expect(dragged).toBeGreaterThan(55);
  await open(page, "problems");
  await open(page, "flowchart");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", String(dragged));
  expect(await remembered(page)).toBe(dragged);
});

// 530, not 560, since the 0.7.0 shell: the desktop status bar's 28 px went to the rows, so a 560 px
// window now has room for the full 55 percent and no longer reaches the 220 px floor.
for (const height of [400, 530]) {
  test(`a ${height} px window grows the panel only as far as leaves the editor its 220 px`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height });
    await start(page);
    await open(page, "output");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "35");
    const rows = await page.evaluate(() => document.getElementById("editor-area")!.getBoundingClientRect().height + document.getElementById("panel")!.getBoundingClientRect().height);
    const editorBefore = (await page.locator("#editor-area").boundingBox())!.height;
    // 400 px is a short window (the page scrolls, the main area keeps 360 px; app.css): about 350 px
    // of rows, so the panel grows only to 36 percent. 530 px grows it further, still under 55.
    const want = Math.floor(((rows - 220) / rows) * 100);
    const expected = want > 35 ? Math.min(55, want) : 35;
    expect(expected, `rows ${rows}`).toBeGreaterThan(35);
    expect(expected, `rows ${rows}`).toBeLessThan(55);
    await open(page, "flowchart");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", String(expected));
    const editor = (await page.locator("#editor-area").boundingBox())!.height;
    expect(editor).toBeGreaterThanOrEqual(Math.min(editorBefore, 218));
    await expect(page.locator("#editor-area .cm-content")).toBeVisible();
  });
}

test("phones: the Flowchart view changes no panel size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.locator("#view-flowchart").click();
  expect(await remembered(page)).toBeNull();
});
