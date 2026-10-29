// The bottom panel's height when the Flowchart tab opens (owner, 2026-10-26: "grow the bottom panel
// taller if it's small, and keep my own size otherwise"; src/ui/panel-size.ts). Desktop only: a
// panel under 55 percent grows to it through the splitter (its value and the remembered size agree),
// one at or above stays, nothing ever shrinks, leaving the tab keeps the size, a size the student sets
// stands until it is below the threshold at another opening, and a short window keeps the editor.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, test } from "./helpers";

// Under 1100 px the console docks under the code (Workbench Pro), where this rule applies; beside
// the code it runs the full height already (the last desktop test).
test.use({ serviceWorkers: "block", viewport: { width: 1000, height: 900 } });
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

// Workbench Pro's 56 px top bar and 8 px gutter left a 400 px (short) window 342 px of rows, too few
// to grow at all (35 percent is already all the 220 px floor allows), so the two heights that reach
// the floor between 35 and 55 percent are 450 and 560 now.
for (const height of [450, 560]) {
  test(`a ${height} px window grows the panel only as far as leaves the editor its 220 px`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height });
    await start(page);
    await open(page, "output");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "35");
    const rows = await page.evaluate(() => document.getElementById("editor-area")!.getBoundingClientRect().height + document.getElementById("panel")!.getBoundingClientRect().height);
    const editorBefore = (await page.locator("#editor-area").boundingBox())!.height;
    // 450 px leaves about 376 px of rows, so the panel grows only to 41 percent; 560 px grows it
    // further, still under 55.
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

test("beside the code (1100 px and wider) the Flowchart tab changes no size: the console runs the full height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "output");
  const cols = page.locator('[role=separator][aria-orientation="vertical"][aria-controls="panel"]');
  await expect(cols).toHaveAttribute("aria-valuenow", "46");
  await open(page, "flowchart");
  await expect(page.locator("#panel-flowchart")).toBeVisible();
  await expect(cols).toHaveAttribute("aria-valuenow", "46");
  expect(await remembered(page)).toBeNull();
  const [code, con] = [(await page.locator("#editor-area").boundingBox())!, (await page.locator("#panel").boundingBox())!];
  expect(Math.abs(con.height - code.height)).toBeLessThan(2);
});

test("phones: the Flowchart view changes no panel size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.locator("#view-flowchart").click();
  expect(await remembered(page)).toBeNull();
});
