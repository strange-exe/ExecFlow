// What a failed run leaves in the code (layout v2 idea 5, build plan 2.3 and 2.4), in the scenario
// every design mock shows: main.py imports calc.py, ratio(1, 0) raises ZeroDivisionError in calc.py
// line 2. The line that raised gets the error band (code and gutter), the call that led there gets
// a dashed outline and a gutter arrow, a selection still shows through the bands, and the next good
// run clears both. Light and dark, desktop, three engines. The colours are sampled from screenshots,
// because what matters is what a translucent band over a selection layer really paints.
import type { Locator, Page } from "@playwright/test";
import { expect, hierarchyShots, importFiles, openFromTree, openIn, run, setCode, test, waitReady } from "./helpers";
import { decodePng, distance, rgbOf, stack, type Pixels, type RGB } from "./pixels";

test.use({ serviceWorkers: "block" });
test.setTimeout(180_000);

const MAIN = 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n';
const CALC = "def ratio(a, b):\n    return a / b\n";
const FIXED = 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 2))\n';

const SHOTS = `${process.env.SHOTS_DIR ?? "e2e/shots"}/run-marks`;
/** Rounding when a browser blends a translucent colour (measured: 0 or 1 per channel). */
const BLEND = 3;

type Tokens = Record<"bg" | "error-band" | "selection" | "active-line" | "call-site" | "text" | "danger", string>;

async function tokens(page: Page): Promise<Tokens> {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (n: string) => css.getPropertyValue(`--${n}`).trim();
    return {
      bg: read("bg"), "error-band": read("error-band"), selection: read("selection"), "active-line": read("active-line"),
      "call-site": read("call-site"), text: read("text"), danger: read("danger"),
    };
  });
}

/** The viewport as painted, one image pixel per CSS pixel (WebKit's desktop device is 2x). */
async function paint(page: Page): Promise<Pixels> {
  return decodePng(await page.screenshot({ scale: "css", animations: "disabled" }));
}

const box = async (l: Locator) => (await l.boundingBox())!;

/** The client rect of characters [from, to) of a line's text. */
function charRect(line: Locator, from: number, to: number) {
  return line.evaluate(
    (el, [a, b]) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let pos = 0;
      let started = false;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent?.length ?? 0;
        if (!started && a < pos + len) {
          range.setStart(n, a - pos);
          started = true;
        }
        if (started && b <= pos + len) {
          range.setEnd(n, b - pos);
          break;
        }
        pos += len;
      }
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    [from, to] as const,
  );
}

/** Selects characters [from, to) of a line with the mouse (click, then Shift+click). */
async function selectChars(page: Page, line: Locator, from: number, to: number) {
  const r = await charRect(line, from, to);
  const y = r.y + r.h / 2;
  await page.mouse.click(r.x + 1, y);
  await page.keyboard.down("Shift");
  await page.mouse.click(r.x + r.w - 1, y);
  await page.keyboard.up("Shift");
  await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
  return r;
}

const fmt = (c: RGB) => `rgb(${c.join(", ")})`;

for (const scheme of ["light", "dark"] as const) {
  test(`a failed run marks the error line and the call that led there (${scheme}); the next good run clears both`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await waitReady(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
    const t = await tokens(page);
    const name = `${SHOTS}/${info.project.name}-${scheme}`;

    await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
    await openFromTree(page, "main.py");
    const failed = await run(page, { input: ["Ada"], timeout: 90_000 });
    expect(failed.status, failed.output).toBe("error");

    // ---- main.py, the file that ran: line 4 is the call that led to the error.
    const line4 = page.locator(".cm-content .cm-line").nth(3);
    await expect(line4).toHaveText("print(ratio(1, 0))");
    const call = line4.locator(".cm-lintRange.ce-call-site");
    await expect.soft(call, "the call is marked as a call site").toHaveCount(1);
    if ((await call.count()) === 1) {
      await expect.soft(call).toHaveText("print(ratio(1, 0))");
      expect.soft(await call.evaluate((e) => {
        const s = getComputedStyle(e);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, underline: s.textDecorationLine };
      }), "a 2 px dashed outline in --call-site instead of the info underline").toEqual({
        style: "dashed", width: "2px", color: rgbOf(t["call-site"]), underline: "none",
      });
    }
    // Its arrow sits in the lint column on line 4, where the info square would be; there is no square.
    const arrow = page.locator(".cm-gutter-lint .cm-gutterElement.ce-call-line");
    await expect.soft(arrow, "one gutter arrow").toHaveCount(1);
    if ((await arrow.count()) === 1) {
      expect.soft(Math.abs((await box(arrow)).y - (await box(line4)).y), "the arrow is on line 4").toBeLessThan(2);
      const drawn = await arrow.evaluate((e) => {
        const a = getComputedStyle(e, "::before");
        return { mask: a.getPropertyValue("mask-image") || a.getPropertyValue("-webkit-mask-image"), fill: a.backgroundColor, display: a.display };
      });
      expect.soft(drawn.mask, "the arrow is a mask, not an emoji or text").toContain("data:image/svg+xml");
      expect.soft(drawn.fill, "the arrow is --call-site").toBe(rgbOf(t["call-site"]));
      expect.soft(drawn.display).toBe("block");
    }
    await expect.soft(page.locator(".cm-gutter-lint .cm-lint-marker-info"), "no info square for a call site").toHaveCount(0);
    await expect.soft(page.locator(".ce-error-line"), "the file that ran has no error line of its own").toHaveCount(0);
    await page.screenshot({ path: `${name}-main.png`, animations: "disabled" });
    await hierarchyShots(page, `${name}-main`);

    // ---- calc.py, where it was raised: jump there from its Problems row (cursor on line 2).
    await page.locator("#ptab-problems").click();
    await page.locator('.problem[data-path="calc.py"]').first().click();
    await expect(page.locator('.tabs [role=tab][aria-selected="true"][title="calc.py"]')).toBeVisible();
    await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
    const lines = page.locator(".cm-content .cm-line");
    const band = page.locator(".cm-content .cm-line.ce-error-line");
    await expect.soft(band, "the line that raised has the band").toHaveCount(1);
    await expect.soft(band).toHaveText("    return a / b");
    // The cursor is on the error line too: the band, not the cursor-line tint, is what shows.
    await expect.soft(band).toHaveClass(/\bcm-activeLine\b/);
    const gutters = await page.locator(".cm-gutters .cm-gutter").count();
    await expect.soft(page.locator(".cm-gutterElement.ce-error-line"), "a banded cell in every gutter column").toHaveCount(gutters);
    const number = page.locator(".cm-lineNumbers .cm-gutterElement.ce-error-line");
    await expect.soft(number).toHaveText("2");
    if ((await number.count()) === 1) {
      const n = await number.evaluate((e) => ({ color: getComputedStyle(e).color, bar: getComputedStyle(e).boxShadow }));
      expect.soft(n.color, "the error line's number is --text").toBe(rgbOf(t.text));
      expect.soft(n.bar, "a 2 px --danger bar on its leading edge").toContain(rgbOf(t.danger));
      expect.soft(n.bar).toContain("inset");
    }
    await expect.soft(page.locator(".cm-lint-marker-error"), "the gutter dot stays").toHaveCount(1);

    // What is really painted: the band is error-band over the code ground, in the code and the
    // gutter; a plain line (line 3) is the code ground.
    const numberOf = (n: number) => page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: new RegExp(`^${n}$`) });
    const [l2, l3, n2, n3] = [await box(lines.nth(1)), await box(lines.nth(2)), await box(numberOf(2)), await box(numberOf(3))];
    let px = await paint(page);
    const bandColour = stack(t.bg, t["error-band"]);
    const samples = {
      code: px.at(l2.x + l2.width - 30, l2.y + l2.height / 2),
      gutter: px.at(n2.x + 6, n2.y + n2.height / 2),
      plainCode: px.at(l3.x + l3.width - 30, l3.y + l3.height / 2),
      plainGutter: px.at(n3.x + 6, n3.y + n3.height / 2),
    };
    const sampled = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, fmt(v)]));
    test.info().annotations.push({ type: "band pixels", description: JSON.stringify({ expected: fmt(bandColour), bg: t.bg, ...sampled }) });
    expect.soft(distance(samples.plainCode, stack(t.bg)), `plain line ${sampled.plainCode} is the code ground ${t.bg}`).toBeLessThanOrEqual(BLEND);
    expect.soft(distance(samples.plainGutter, stack(t.bg)), `plain gutter ${sampled.plainGutter}`).toBeLessThanOrEqual(BLEND);
    // 16: well above the cursor-line tint alone (7 in light, measured with the band removed).
    expect.soft(distance(samples.code, samples.plainCode), "the band differs from the plain ground").toBeGreaterThanOrEqual(16);
    expect.soft(distance(samples.code, bandColour), `band ${sampled.code} is error-band over bg ${fmt(bandColour)}`).toBeLessThanOrEqual(BLEND);
    expect.soft(distance(samples.gutter, bandColour), `gutter cell ${sampled.gutter}`).toBeLessThanOrEqual(BLEND);
    await page.screenshot({ path: `${name}-calc.png`, animations: "disabled" });
    await hierarchyShots(page, `${name}-calc`);

    // ---- Selection stays visible on the error line and on the cursor line. Whitespace is selected
    // so the sample inside the selection hits no glyph: the 4 spaces of indentation on line 2, and
    // the space after "def" on line 1.
    const onBand = await selectChars(page, lines.nth(1), 0, 4);
    px = await paint(page);
    const insideBand = px.at(onBand.x + onBand.w / 2, onBand.y + onBand.h / 2);
    const outsideBand = px.at(l2.x + l2.width - 30, l2.y + l2.height / 2);
    const selectedBand = stack(t.bg, t.selection, t["error-band"]);
    expect.soft(distance(insideBand, outsideBand), `selection on the error line: ${fmt(insideBand)} vs ${fmt(outsideBand)}`).toBeGreaterThanOrEqual(4);
    expect.soft(distance(insideBand, selectedBand), `error band over the selection ${fmt(insideBand)}, expected ${fmt(selectedBand)}`).toBeLessThanOrEqual(BLEND);
    await page.screenshot({ path: `${name}-selection-band.png`, animations: "disabled", clip: { x: l2.x - 80, y: l2.y - 30, width: 420, height: 90 } });

    const l1 = await box(lines.nth(0));
    const onCursorLine = await selectChars(page, lines.nth(0), 3, 4);
    await expect(lines.nth(0)).toHaveClass(/\bcm-activeLine\b/);
    px = await paint(page);
    const insideCursor = px.at(onCursorLine.x + onCursorLine.w / 2, onCursorLine.y + onCursorLine.h / 2);
    const outsideCursor = px.at(l1.x + l1.width - 30, l1.y + l1.height / 2);
    const selectedCursor = stack(t.bg, t.selection, t["active-line"]);
    expect.soft(distance(insideCursor, outsideCursor), `selection on the cursor line: ${fmt(insideCursor)} vs ${fmt(outsideCursor)}`).toBeGreaterThanOrEqual(4);
    expect.soft(distance(insideCursor, selectedCursor), `cursor line over the selection ${fmt(insideCursor)}, expected ${fmt(selectedCursor)}`).toBeLessThanOrEqual(BLEND);
    await page.screenshot({ path: `${name}-selection-cursor.png`, animations: "disabled", clip: { x: l1.x - 80, y: l1.y - 30, width: 420, height: 90 } });

    // ---- The next good run clears both marks.
    await openFromTree(page, "main.py");
    await setCode(page, FIXED);
    const ok = await run(page, { input: ["Ada"], timeout: 90_000 });
    expect(ok.status, ok.output).toBe("ok");
    expect(ok.output).toContain("0.5");
    await expect(page.locator(".cm-lintRange.ce-call-site"), "the call site is gone").toHaveCount(0);
    await expect(page.locator(".cm-gutterElement.ce-call-line"), "the arrow is gone").toHaveCount(0);
    await openFromTree(page, "calc.py");
    await expect(page.locator(".cm-content .cm-line.ce-error-line"), "the band is gone").toHaveCount(0);
    await expect(page.locator(".cm-gutterElement.ce-error-line")).toHaveCount(0);
    await expect(page.locator(".cm-lint-marker-error")).toHaveCount(0);
  });
}
