// Workbench Pro S3 (the Flowchart tab; .claude/design/redesign5/a/design.md item 6): the chart fitted
// to its card when it opens (the whole chart in view, never drawn larger than full size, never so
// small its words can't be read), one bar holding Function, Zoom out, Zoom in, Fit, Steps as text,
// Export and Full screen in one row, the shapes keeping their colours, a legend naming the shapes
// the chart uses, and the Output tab's tool row (Input, Restart Python, Clear) hidden on this tab.
import type { Locator, Page } from "@playwright/test";
import { expect, importFiles, isNarrow, openFromTree, openIn, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

/** The mockup's program: a loop, two decisions, input and output (redesign5/a/mock.html). */
const EVENS = [
  "#include <stdio.h>",
  "",
  "int main(void) {",
  "    int n;",
  '    scanf("%d", &n);',
  "    // print the even numbers up to n",
  "    for (int i = 1; i <= n; i++) {",
  "        if (i % 2 == 0) {",
  '            printf("%d is even", i);',
  "        }",
  "    }",
  "    return 0;",
  "}",
  "",
].join("\n");

/** A call and a step, no input or output: the legend leaves out the shapes it doesn't use. */
const CALLS = ["int square(int x) {", "    return x * x;", "}", "int main(void) {", "    int n = 3;", "    int s = square(n);", "    if (s > 4) n = 0;", "    return n;", "}", ""].join("\n");

/** Forty decisions in a row: too tall to fit whole at a readable size. */
const TALL = `int main(void) {\n    int x = 0;\n${Array.from({ length: 40 }, (_, i) => `    if (x == ${i}) x++;`).join("\n")}\n    return x;\n}\n`;

const view = (page: Page) => page.locator(".fc-view").first();
const bar = (page: Page) => page.locator(".fc-toolbar");
const stage = (page: Page) => page.locator(".fc-stage");
const chartSvg = (page: Page) => page.locator(".fc-stage svg");
const legend = (page: Page) => page.getByRole("list", { name: "Shapes" });

async function chartFor(page: Page, files: { name: string; text: string }[], open: string, scheme: "light" | "dark" = "light") {
  await openIn(page, "/", scheme);
  await waitReady(page);
  await importFiles(page, files);
  await openFromTree(page, open);
  await page.locator(isNarrow(page) ? "#view-flowchart" : "#ptab-flowchart").click();
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

/** The chart's scale on screen: its drawn width over its own (viewBox) width. */
const scale = (page: Page) =>
  chartSvg(page).evaluate((el) => el.getBoundingClientRect().width / (el as SVGSVGElement).viewBox.baseVal.width);

/** Whether the whole chart is inside the stage's box (to a pixel). */
const wholeInView = (page: Page) =>
  page.evaluate(() => {
    const s = document.querySelector(".fc-stage")!.getBoundingClientRect();
    const g = document.querySelector(".fc-stage svg")!.getBoundingClientRect();
    return g.left >= s.left - 1 && g.right <= s.right + 1 && g.top >= s.top - 1 && g.bottom <= s.bottom + 1;
  });

/** The bar's visible controls in order, each by its accessible name (the select by its label). */
async function barNames(page: Page): Promise<string[]> {
  return bar(page)
    .locator("button, select")
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => (e.tagName === "SELECT" ? (e as HTMLSelectElement).labels?.[0]?.textContent ?? "" : e.getAttribute("aria-label") ?? e.textContent ?? "").trim()),
    );
}

async function boxes(loc: Locator) {
  return loc.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const vp of [
  { width: 1440, height: 900 },
  { width: 1100, height: 800 },
  { width: 900, height: 760 },
  { width: 390, height: 844 },
]) {
  test.describe(`${vp.width} x ${vp.height}`, () => {
    test.use({ viewport: vp });

    test("one bar: Function, Zoom out, Zoom in, Fit, Steps as text, Export, Full screen, in one row", async ({ page }) => {
      await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c");
      expect(await barNames(page)).toEqual(["Function", "Zoom out", "Zoom in", "Fit", "Steps as text", "Export", "Full screen"]);
      // One row: every control's middle on the same line, and no label wrapping onto a second line.
      const controls = await boxes(bar(page).locator("button, select"));
      const mids = controls.map((r) => r.top + r.height / 2);
      expect(Math.max(...mids) - Math.min(...mids), "controls on one line").toBeLessThanOrEqual(2);
      const tallest = Math.max(...controls.map((r) => r.height));
      expect(tallest, "no wrapped label").toBeLessThanOrEqual(isNarrow(page) ? 44.5 : 40);
      // Targets: 24 px everywhere, 44 on phones.
      const least = isNarrow(page) ? 44 : 24;
      for (const r of controls) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(least - 0.5);
      // The bar is the only tool row on this tab: Input, Restart Python and Clear are the Output tab's.
      await expect(bar(page)).toBeVisible();
      await expect(page.locator("#panel .panel-actions")).toBeHidden();
      // Nothing of the bar is cut off, and the page never scrolls sideways.
      const b = (await bar(page).boundingBox())!;
      for (const r of controls) expect(r.right, "inside the bar").toBeLessThanOrEqual(b.x + b.width + 0.5);
      expect(await sideways(page)).toBe(0);
    });

    test("fit on open: the whole chart in view, no larger than full size; Fit brings it back after a zoom", async ({ page }) => {
      await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c");
      const fitted = await scale(page);
      expect(fitted).toBeLessThanOrEqual(1.001);
      // Under the code (900 to 1099 px) the card is too short for this chart at a readable size:
      // there the chart stops at three quarters of full size and scrolls down (the "fit" tests below).
      const whole = vp.width !== 900;
      if (whole) expect(await wholeInView(page), "the whole chart in view").toBe(true);
      else expect(Math.abs(fitted - 0.75), "the readable floor").toBeLessThan(0.002);
      await page.locator("#fc-zoom-in").click();
      expect(await scale(page)).toBeGreaterThan(fitted);
      await page.locator("#fc-fit").click();
      expect(Math.abs((await scale(page)) - fitted)).toBeLessThan(0.002);
      if (whole) expect(await wholeInView(page)).toBe(true);
    });
  });
}

test.describe("fit", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("a chart taller than the card is fitted whole on open (the full-size drawing would overflow)", async ({ page }) => {
    await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c");
    // The premise: at full size this chart is taller than the card here.
    const [h, room] = await page.evaluate(() => [(document.querySelector(".fc-stage svg") as SVGSVGElement).viewBox.baseVal.height, document.querySelector(".fc-stage")!.clientHeight]);
    expect(h, "premise: taller than the card").toBeGreaterThan(room);
    expect(await wholeInView(page)).toBe(true);
    expect(await scale(page)).toBeLessThan(1);
  });

  test("a very tall chart fits the width at a readable size and scrolls down, never sideways", async ({ page }) => {
    await chartFor(page, [{ name: "main.c", text: TALL }], "main.c");
    const s = await scale(page);
    expect(s, "readable: not below three quarters").toBeGreaterThanOrEqual(0.75 - 0.002);
    const fits = await page.evaluate(() => {
      const st = document.querySelector(".fc-stage")!;
      return { across: st.scrollWidth <= st.clientWidth, down: st.scrollHeight > st.clientHeight };
    });
    expect(fits).toEqual({ across: true, down: true });
  });

  test("a resize keeps a fitted chart fitted; after a zoom it keeps the zoom", async ({ page }) => {
    await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c");
    const before = await scale(page);
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => scale(page)).toBeGreaterThan(before + 0.01);
    expect(await wholeInView(page)).toBe(true);
    await page.locator("#fc-zoom-in").click();
    const zoomed = await scale(page);
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(200);
    expect(Math.abs((await scale(page)) - zoomed)).toBeLessThan(0.002);
  });
});

test.describe("legend and colours", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: a legend under the chart names its shapes, each swatch in its shape's colours`, async ({ page }) => {
      await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c", scheme);
      await expect(legend(page)).toBeVisible();
      await expect(legend(page).getByRole("listitem")).toHaveText(["Start and end", "Step", "Input or output", "Decision"]);
      const [l, s] = [(await legend(page).boundingBox())!, (await stage(page).boundingBox())!];
      expect(l.y, "under the chart").toBeGreaterThanOrEqual(s.y + s.height - 1);
      // Coloured shapes kept: each kind's outline differs from a plain step's, and the legend's
      // swatch has the very outline and fill of its shape in the chart.
      const looks = await page.evaluate(() => {
        const look = (el: Element | null) => (el ? { stroke: getComputedStyle(el).stroke, fill: getComputedStyle(el).fill } : null);
        // Not the box's focus ring (an unpainted rect drawn first).
        const shapeOf = (kind: string) => look(document.querySelector(`.fc-stage g[data-kind="${kind}"] :is(rect, polygon, circle):not(.fc-ring)`));
        const swatchOf = (kind: string) => look(document.querySelector(`.fc-legend [data-kind="${kind}"] :is(rect, polygon, circle)`));
        return Object.fromEntries(["start", "process", "io", "decision"].map((k) => [k, { shape: shapeOf(k), swatch: swatchOf(k) }]));
      });
      for (const [kind, { shape, swatch }] of Object.entries(looks)) {
        expect(shape, kind).not.toBeNull();
        expect(swatch, kind).toEqual(shape);
      }
      for (const kind of ["start", "io", "decision"]) expect(looks[kind].shape!.stroke, kind).not.toBe(looks.process.shape!.stroke);
      // Swatches are pictures of the words beside them: hidden from screen readers.
      expect(await legend(page).locator("svg:not([aria-hidden=true])").count()).toBe(0);
    });
  }

  test("the legend lists only the shapes this chart uses, and follows the chart into full screen", async ({ page }) => {
    await chartFor(page, [{ name: "calls.c", text: CALLS }], "calls.c");
    await page.locator("#fc-picker").selectOption({ label: "main" });
    await expect(view(page)).toHaveAttribute("data-state", "ready");
    await expect(legend(page).getByRole("listitem")).toHaveText(["Start and end", "Step", "Decision", "Function call"]);
    await page.locator("#fc-full").click();
    const dialog = page.locator("dialog#fc-dialog");
    await expect(dialog.getByRole("list", { name: "Shapes" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("no chart, no legend: an empty file shows its message alone", async ({ page }) => {
    await chartFor(page, [{ name: "main.c", text: EVENS }, { name: "empty.c", text: "" }], "main.c");
    await expect(legend(page)).toBeVisible();
    await openFromTree(page, "empty.c");
    await expect(view(page)).toHaveAttribute("data-state", "empty");
    await expect(legend(page)).toBeHidden();
  });
});

test.describe("the Output tab's tool row", () => {
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${vp.width} px: Input, Restart Python and Clear hide on the Flowchart tab and come back on Output`, async ({ page }) => {
      await page.setViewportSize(vp);
      await chartFor(page, [{ name: "main.py", text: "n = int(input())\nprint(n * 2)\n" }], "main.py");
      for (const id of ["#input-toggle", "#restart-python", "#clear-output"]) await expect(page.locator(id), id).toBeHidden();
      await page.locator(isNarrow(page) ? "#view-output" : "#ptab-output").click();
      for (const id of ["#input-toggle", "#restart-python", "#clear-output"]) await expect(page.locator(id), id).toBeVisible();
      await expect(bar(page)).toBeHidden();
    });
  }
});

test.describe("phones", () => {
  for (const vp of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    test(`${vp.width} px: the bar, the fitted chart and the legend fit the screen`, async ({ page }) => {
      await page.setViewportSize(vp);
      await chartFor(page, [{ name: "main.c", text: EVENS }], "main.c");
      expect(await sideways(page)).toBe(0);
      const b = (await bar(page).boundingBox())!;
      // 390 px holds the bar in one row; 320 px can't hold seven 44 px controls, so the end's three
      // (Steps as text, Export, Full screen) wrap together to a second row. Never overlapping.
      expect(b.height, vp.width >= 390 ? "one row" : "two rows at most").toBeLessThanOrEqual(vp.width >= 390 ? 60 : 108);
      const controls = await boxes(bar(page).locator("button, select"));
      for (const [i, r] of controls.entries()) {
        expect(r.right, `control ${i} inside the screen`).toBeLessThanOrEqual(vp.width + 0.5);
        for (const q of controls.slice(i + 1)) {
          const apart = r.right <= q.left + 0.5 || q.right <= r.left + 0.5 || r.bottom <= q.top + 0.5 || q.bottom <= r.top + 0.5;
          expect(apart, `controls ${i} and another overlap`).toBe(true);
        }
      }
      const s = (await stage(page).boundingBox())!;
      const g = (await chartSvg(page).boundingBox())!;
      expect(g.x + g.width, "the chart fits across").toBeLessThanOrEqual(s.x + s.width + 1);
      await expect(legend(page)).toBeVisible();
      const l = (await legend(page).boundingBox())!;
      expect(l.x + l.width).toBeLessThanOrEqual(vp.width + 0.5);
      // The legend stays a strip: two lines at most, so the chart keeps the screen.
      expect(l.height).toBeLessThanOrEqual(56);
    });
  }
});
