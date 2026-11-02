// The run trace (Flow Board S4a, .claude/tasks/flow-board.md S4; feature F1): after a Python run the
// chart shows how often the run went each way. Connectors thicken by count (1.5 / 2.5 / 3 / 4 px),
// branches and loop-backs carry a "5x" chip, the legend says what both mean, a polite live region
// says the path in words and Steps as text gives the counts. An edit makes the trace stale at once
// (the redraw then drops it). The exports include it. C and C++ runs leave the chart plain, and a
// generator, which isn't traced, says so. Reduced motion shows the trace without the draw-in, and a
// theme switch keeps it.
import { readFileSync } from "node:fs";
import type { Download, Page } from "@playwright/test";
import { decodeRgba, pngInfo } from "./snippet-helpers";
import { expect, importFiles, installCpp, openApp, openFromTree, openThemePicker, run, setCode, showChart, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const MARKS = [
  "marks = [72, 85, 64, 90, 58]",
  "n = len(marks)",
  "total = 0",
  "best = marks[0]",
  "i = 0",
  "while i < n:",
  '    print("marks", i, marks[i])',
  "    total += marks[i]",
  "    if marks[i] > best:",
  "        best = marks[i]",
  "    i += 1",
  'print("Best:", best)',
  "",
].join("\n");
// Nested ifs, elif, continue and break: a chart the fit draws below 100 % at 1440 x 900.
const GRADES = [
  "scores = [55, 91, 78, 0, 64, 88, 102]",
  "passed = 0",
  "for s in scores:",
  "    if s == 0:",
  "        continue",
  "    if s > 100:",
  "        break",
  "    if s >= 90:",
  '        print("A")',
  "    elif s >= 75:",
  '        print("B")',
  "    else:",
  '        print("C")',
  "    passed += 1",
  "print(passed)",
  "",
].join("\n");
const SUMMARY ="Path of the last run: the loop i < n ran 5 times; marks[i] > best was Yes 2 times, No 3 times.";

const view = (page: Page) => page.locator(".fc-view").first();
const stage = (page: Page) => page.locator(".fc-stage svg");
const chips = (page: Page) => stage(page).locator('[data-part="count"]');
const traced = (page: Page) => stage(page).locator('[data-part="trace"]');
const caption = (page: Page) => page.locator("#fc-trace-caption");
const said = (page: Page) => page.locator("#fc-trace-said");

/** Opens `name` holding `text` with its chart drawn. */
async function openChart(page: Page, name: string, text: string) {
  await openApp(page);
  await importFiles(page, [{ name, text }]);
  await openFromTree(page, name);
  await showChart(page);
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

/** Runs the marks program and waits for its trace on the chart. */
async function tracedMarks(page: Page) {
  await openChart(page, "marks.py", MARKS);
  await expect(view(page)).toHaveAttribute("data-trace", "none");
  await expect(caption(page)).toBeHidden();
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  await expect(view(page)).toHaveAttribute("data-trace", "shown");
}

/** The counts on the edges and their traced widths, sorted. */
const edgeCounts = (page: Page) =>
  traced(page).evaluateAll((paths) =>
    paths.map((p) => `${p.parentElement!.getAttribute("data-count")}:${getComputedStyle(p).strokeWidth}`).sort(),
  );

async function download(page: Page, name: "Download PNG" | "Download SVG"): Promise<{ file: string; bytes: Buffer; download: Download }> {
  const waiting = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#fc-export").click();
  await page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name }).click();
  const d = await waiting;
  return { file: d.suggestedFilename(), bytes: readFileSync((await d.path())!), download: d };
}

test.describe("run trace", () => {
  test("a Python run thickens the connectors by count, chips each branch and loop-back, and says the path", async ({ page }) => {
    await tracedMarks(page);
    await expect(caption(page)).toHaveText("Last run");
    await expect(caption(page)).toHaveAttribute("title", "Path of the last run");
    await expect(caption(page)).toBeVisible();
    // Branches and loop-backs: the loop's Yes 5 and No 1, the test's Yes 2 and No 3, the loop-back 5.
    await expect(chips(page)).toHaveCount(5);
    expect((await chips(page).allTextContents()).sort()).toEqual(["1x", "2x", "3x", "5x", "5x"]);
    // Widths by count: 1.5 px once, 2.5 twice, 3 three times, 4 five or more.
    const counts = await edgeCounts(page);
    expect(counts).toContain("5:4px");
    expect(counts).toContain("3:3px");
    expect(counts).toContain("2:2.5px");
    expect(counts).toContain("1:1.5px");
    expect(counts.every((c) => /^(1:1\.5|2:2\.5|3:3|4:3\.5|[5-9]:4|\d{2,}:4)px$/.test(c)), counts.join(" ")).toBe(true);
    // Each chip says its own edge's count.
    const pairs = await chips(page).evaluateAll((gs) => gs.map((g) => `${g.getAttribute("data-count")}x=${g.textContent}`));
    expect(pairs.every((p) => p.split("=")[0] === p.split("=")[1]), pairs.join(" ")).toBe(true);
    // The legend explains both, only while a trace shows.
    // (The count row's swatch is a "5x" chip, hidden from the accessibility tree: the row reads as its words.)
    const rows = page.locator(".fc-legend [data-trace]");
    await expect(rows).toHaveText(["Thicker ran more often", "5xTimes that way ran"]);
    await expect(rows.locator("svg[aria-hidden=true]")).toHaveCount(2);
    // The words: the polite live region, and Steps as text.
    await expect(said(page)).toHaveText(SUMMARY);
    await expect(said(page)).toHaveAttribute("role", "status");
    await page.locator("#fc-steps-toggle").click();
    await expect(page.locator(".fc-steps li", { hasText: "marks[i] > best" })).toContainText("Last run: Yes 2 times, No 3 times.");
    await expect(page.locator(".fc-steps li", { hasText: "i < n" }).first()).toContainText("Last run: Yes 5 times, No 1 time.");
    // The chips are drawing, not controls: hidden from the accessibility tree.
    await expect(stage(page).locator('[data-part="counts"]')).toHaveAttribute("aria-hidden", "true");
    // The draw-in runs (no reduced motion): along each traced line, the chips fading in.
    expect(await traced(page).first().evaluate((p) => getComputedStyle(p).animationName)).toBe("fc-trace-draw");
    expect(await chips(page).first().evaluate((g) => getComputedStyle(g).animationName)).toBe("fc-chip-in");
  });

  test("an edit makes the trace stale at once, and the redraw drops it", async ({ page }) => {
    await tracedMarks(page);
    // Every value data-trace takes from here on, so the brief "stale" can't be missed.
    await view(page).evaluate((v) => {
      const seen: string[] = [];
      (window as unknown as { __traceSeen: string[] }).__traceSeen = seen;
      new MutationObserver(() => seen.push((v as HTMLElement).dataset.trace ?? "")).observe(v, { attributes: true, attributeFilter: ["data-trace"] });
    });
    await setCode(page, MARKS.replace("72", "71"));
    await expect(view(page)).toHaveAttribute("data-trace", "none");
    expect(await page.evaluate(() => (window as unknown as { __traceSeen: string[] }).__traceSeen[0])).toBe("stale");
    await expect(traced(page)).toHaveCount(0);
    await expect(chips(page)).toHaveCount(0);
    await expect(page.locator(".fc-legend [data-trace]")).toHaveCount(0);
    await expect(caption(page)).toBeHidden();
    // Running the new text traces it again.
    const r = await run(page, { timeout: 120_000 });
    expect(r.status, r.output).toBe("ok");
    await expect(view(page)).toHaveAttribute("data-trace", "shown");
    await expect(chips(page)).toHaveCount(5);
  });

  test("Download SVG and Download PNG include the trace; once stale, they don't", async ({ page }) => {
    await tracedMarks(page);
    const svg = await download(page, "Download SVG");
    expect(svg.file).toBe("marks-py-Program-flowchart.svg");
    const xml = svg.bytes.toString("utf8");
    expect(xml.match(/>5x<\/text>/g)?.length, "two 5x chips").toBe(2);
    expect(xml).toContain(">1x</text>");
    expect(xml).toMatch(/stroke-width:4;/);
    expect(xml, "nothing of the live view").not.toMatch(/data-part|pathLength|--fc-i|var\(/);
    const png = await download(page, "Download PNG");
    expect(png.file).toBe("marks-py-Program-flowchart.png");

    // Where each chip is on the chart: the PNG has the chart at 2x from its top left (flowchart-export.spec).
    const boxes = await chips(page).evaluateAll((gs) =>
      gs.map((g) => {
        const r = g.querySelector("rect")!;
        return { x: Number(r.getAttribute("x")), y: Number(r.getAttribute("y")), w: Number(r.getAttribute("width")), h: Number(r.getAttribute("height")) };
      }),
    );
    // The same export once an edit made the trace stale: no chips, plain connectors.
    await setCode(page, MARKS.replace("72", "71"));
    await expect(view(page)).toHaveAttribute("data-trace", "none");
    const plainSvg = (await download(page, "Download SVG")).bytes.toString("utf8");
    expect(plainSvg).not.toMatch(/>\d+x<\/text>/);
    expect(plainSvg).not.toMatch(/stroke-width:4;/);
    const plain = await download(page, "Download PNG");
    expect(pngInfo(plain.bytes).width).toBe(pngInfo(png.bytes).width);
    expect(pngInfo(plain.bytes).height).toBe(pngInfo(png.bytes).height);
    const [a, b] = [decodeRgba(png.bytes), decodeRgba(plain.bytes)];
    // Inside each chip the traced PNG differs from the plain one (the chip's fill, border and count).
    for (const c of boxes) {
      let differ = 0;
      for (let y = Math.ceil(c.y * 2) + 2; y < Math.floor((c.y + c.h) * 2) - 2; y++) {
        for (let x = Math.ceil(c.x * 2) + 2; x < Math.floor((c.x + c.w) * 2) - 2; x++) {
          const [p, q] = [a.at(x, y), b.at(x, y)];
          if (p.some((v, i) => Math.abs(v - q[i]) > 24)) differ++;
        }
      }
      expect(differ, `chip at ${c.x},${c.y}`).toBeGreaterThan(20);
    }
  });

  test("C and C++ runs leave the chart untraced", async ({ page }) => {
    test.setTimeout(300_000);
    const c = "#include <stdio.h>\nint main(void) {\n    for (int i = 0; i < 3; i++) {\n        if (i > 0) printf(\"%d\\n\", i);\n    }\n    return 0;\n}\n";
    const cpp = "#include <iostream>\nint main() {\n    for (int i = 0; i < 3; i++) {\n        if (i > 0) std::cout << i << std::endl;\n    }\n    return 0;\n}\n";
    await openApp(page);
    await importFiles(page, [{ name: "loop.c", text: c }, { name: "loop.cpp", text: cpp }]);
    for (const name of ["loop.c", "loop.cpp"]) {
      await openFromTree(page, name);
      await showChart(page);
      await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await installCpp(page);
      const r = await run(page, { timeout: 180_000 });
      expect(r.status, r.output).toBe("ok");
      await expect(view(page)).toHaveAttribute("data-state", "ready");
      await expect(view(page)).toHaveAttribute("data-trace", "none");
      await expect(traced(page)).toHaveCount(0);
      await expect(chips(page)).toHaveCount(0);
      await expect(caption(page)).toBeHidden();
      await expect(page.locator(".fc-legend [data-trace]")).toHaveCount(0);
      await expect(said(page)).toHaveText("");
    }
  });

  test("a generator ran but isn't traced, and says so; the loop that used it is traced", async ({ page }) => {
    const src = "def evens(n):\n    for k in range(n):\n        if k % 2 == 0:\n            yield k\n\nfor e in evens(6):\n    print(e)\n";
    await openChart(page, "gen.py", src);
    const r = await run(page, { timeout: 120_000 });
    expect(r.status, r.output).toBe("ok");
    await expect(view(page)).toHaveAttribute("data-trace", "shown");
    await expect(chips(page).filter({ hasText: "3x" })).toHaveCount(2); // the loop's Yes and its loop-back
    await page.locator("#fc-picker").selectOption({ label: "evens" });
    await expect(view(page)).toHaveAttribute("data-trace", "none");
    await expect(caption(page)).toHaveText("Not traced");
    await expect(caption(page)).toHaveAttribute("title", "Ran in the last run; generators aren't traced");
    await expect(caption(page)).toBeVisible();
    await expect(said(page)).toHaveText("evens ran in the last run; generators and coroutines aren't traced.");
    await expect(traced(page)).toHaveCount(0);
  });

  test("reduced motion shows the whole trace at once, with no draw-in", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openChart(page, "marks.py", MARKS);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced motion applied").toBe(true);
    const r = await run(page, { timeout: 120_000 });
    expect(r.status, r.output).toBe("ok");
    await expect(view(page)).toHaveAttribute("data-trace", "shown");
    await expect(chips(page)).toHaveCount(5);
    const motion = await stage(page).evaluate((svg) => ({
      fresh: svg.classList.contains("fc-trace-new"),
      lines: [...svg.querySelectorAll('[data-part="trace"]')].map((p) => getComputedStyle(p).animationName),
      chips: [...svg.querySelectorAll('[data-part="count"]')].map((g) => getComputedStyle(g).animationName),
      running: svg.getAnimations({ subtree: true }).length,
    }));
    expect(motion.fresh, "the run is new: only motion is turned off").toBe(true);
    expect(new Set([...motion.lines, ...motion.chips])).toEqual(new Set(["none"]));
    expect(motion.running).toBe(0);
    // Drawn whole: the dash of the line's own length starts at its start.
    expect(await traced(page).first().evaluate((p) => getComputedStyle(p).strokeDashoffset)).toMatch(/^0(px)?$/);
  });

  test("at 1440 the fitted chart is below 100 %, and its chips keep an 11 px count; zooming in leaves them as drawn", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openChart(page, "grades.py", GRADES);
    const r = await run(page, { timeout: 120_000 });
    expect(r.status, r.output).toBe("ok");
    await expect(view(page)).toHaveAttribute("data-trace", "shown");
    await expect(chips(page)).toHaveCount(10);
    const sizes = () =>
      stage(page).evaluate((svg) => {
        const zoom = svg.getBoundingClientRect().width / Number(svg.getAttribute("viewBox")!.split(" ")[2]);
        const chips = [...svg.querySelectorAll('[data-part="count"]')].map((g) => ({
          text: g.querySelector("text")!.getBoundingClientRect().height,
          rect: g.querySelector("rect")!.getBoundingClientRect().height,
          font: Number.parseFloat(getComputedStyle(g.querySelector("text")!).fontSize),
        }));
        // A box's words, for comparison: drawn at the chart's zoom.
        const word = svg.querySelector(".fc-node text")!.getBoundingClientRect().height;
        return { zoom, chips, word };
      });
    const fitted = await sizes();
    expect(fitted.zoom, "the fit draws this chart below 100 %").toBeLessThan(0.95);
    for (const c of fitted.chips) {
      expect(c.font).toBe(11);
      // The count's glyph box at an 11 px font (about 1.2 em), and the chip's 16 px height, on screen.
      expect(c.text, JSON.stringify(c)).toBeGreaterThanOrEqual(11);
      expect(c.rect, JSON.stringify(c)).toBeGreaterThanOrEqual(15.5);
    }
    // Without the counter-scale they would shrink with the boxes' words.
    expect(fitted.chips[0].text).toBeGreaterThan(fitted.word * (11 / 13) * 1.05);
    // Zoomed in past 100 %, the chips grow with the chart as everything else does.
    for (let i = 0; i < 3; i++) await page.locator("#fc-zoom-in").click();
    const zoomed = await sizes();
    expect(zoomed.zoom).toBeGreaterThan(1);
    // 16 px at the zoom (Firefox's box also holds the 1 px border's outer half).
    expect(Math.abs(zoomed.chips[0].rect - 16 * zoomed.zoom), JSON.stringify(zoomed.chips[0])).toBeLessThanOrEqual(1.5 * zoomed.zoom);
  });

  for (const width of [1100, 1440]) {
    test(`at ${width} px the chart bar stays one row with the trace's caption`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openChart(page, "marks.py", MARKS);
      const bar = page.locator(".fc-view .fc-toolbar").first();
      const row = () =>
        bar.evaluate((b) => {
          const shown = [...b.children].filter((c) => (c as HTMLElement).offsetParent !== null).map((c) => c.getBoundingClientRect());
          // One row: some horizontal line crosses every shown item (a wrapped item starts below another's foot).
          return { height: b.getBoundingClientRect().height, oneRow: Math.max(...shown.map((r) => r.top)) < Math.min(...shown.map((r) => r.bottom)) };
        });
      const before = await row();
      const r = await run(page, { timeout: 120_000 });
      expect(r.status, r.output).toBe("ok");
      await expect(view(page)).toHaveAttribute("data-trace", "shown");
      const after = await row();
      expect(after.height, `bar height ${before.height} before the run, ${after.height} after`).toBe(before.height);
      expect(before.oneRow, "one row before the run").toBe(true);
      expect(after.oneRow, "one row after the run").toBe(true);
      const shown = await caption(page).isVisible();
      if (shown) {
        // Between Fit and Steps as text, inside its room; the whole sentence in its title.
        await expect(caption(page)).toHaveAttribute("title", "Path of the last run");
        const [cap, fitB, end] = await Promise.all([caption(page), page.locator("#fc-fit"), page.locator(".fc-view .fc-end").first()].map(async (l) => (await l.boundingBox())!));
        expect(cap.x, "after Fit").toBeGreaterThanOrEqual(fitB.x + fitB.width - 1);
        expect(cap.x + cap.width, "before Steps as text").toBeLessThanOrEqual(end.x + 1);
      }
      test.info().annotations.push({ type: `${width} px`, description: `bar ${after.height} px; caption ${shown ? "shown" : "hidden (a narrow board)"}` });
    });
  }

  test("the trace stays through a theme switch, in the new theme's colours", async ({ page }) => {
    await tracedMarks(page);
    const before = await chips(page).first().locator("rect").evaluate((r) => getComputedStyle(r).fill);
    const settings = await openThemePicker(page);
    const current = await page.locator("html").getAttribute("data-theme-id");
    const next = current === "slate-dark" ? "ExecFlow Signal Light" : "ExecFlow Slate Dark";
    await settings.getByRole("radio", { name: next, exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-id", current ?? "");
    await expect(view(page)).toHaveAttribute("data-trace", "shown");
    await expect(chips(page)).toHaveCount(5);
    expect(await edgeCounts(page)).toContain("5:4px");
    await expect(caption(page)).toHaveText("Last run");
    await expect.poll(() => chips(page).first().locator("rect").evaluate((r) => getComputedStyle(r).fill)).not.toBe(before);
  });
});
