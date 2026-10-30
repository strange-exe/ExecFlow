// The Flowchart export (milestone 4; brief .claude/tasks/flowchart-m4.md): Download PNG, Download
// SVG and Copy image (where the browser can copy images) from the Flowchart toolbar and its full
// screen view, in Print-safe light (the default) or the editor's colours, with the brand footer on
// every export. PNGs are decoded here and read at the footer's computed spots; SVGs are parsed back
// in the page and walked for anything active or external. Sample files and shots go to FC_EXPORT
// when set (the review folder), else to each test's output folder.
import AxeBuilder from "@axe-core/playwright";
import type { Download, Page, TestInfo } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_MARK } from "../src/editor/brand-mark";
import { FOOTER, FOOTER_TEXT, mixHex, printColors } from "../src/flowchart/export";
import { CHART_TINT } from "../src/flowchart/render";
import { expect, importFiles, isNarrow, openFromTree, openIn, test, waitReady } from "./helpers";
import { decodeRgba, inkOf, off, pngInfo, type RgbaPixels } from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const C_PROGRAM = [
  "#include <stdio.h>",
  "int main(void) {",
  "    int n, score;",
  '    scanf("%d", &n);',
  "    for (int i = 0; i < n; i++) {",
  '        scanf("%d", &score);',
  "        if (score < 0) continue;",
  '        printf("%d", score);',
  "    }",
  "    return 0;",
  "}",
  "",
].join("\n");
const CPP_PROGRAM = ["#include <iostream>", "using namespace std;", "int main() {", "    int n;", "    cin >> n;", "    if (n > 0) cout << n;", "    return 0;", "}", ""].join("\n");
const PY_PROGRAM = ["def twice(x):", "    return 2 * x", "", "n = int(input())", "while n > 0:", "    print(twice(n))", "    n -= 1", ""].join("\n");

const LANGS = [
  { lang: "C", file: "grades.c", text: C_PROGRAM, fn: "main", png: "grades-c-main-flowchart.png", footer: "grades.c, function main" },
  { lang: "C++", file: "shapes.cpp", text: CPP_PROGRAM, fn: "main", png: "shapes-cpp-main-flowchart.png", footer: "shapes.cpp, function main" },
  { lang: "Python", file: "loop.py", text: PY_PROGRAM, fn: "Program", png: "loop-py-Program-flowchart.png", footer: "loop.py, top level" },
] as const;

const view = (page: Page) => page.locator(".fc-view");
const status = (page: Page) => page.locator("#fc-status");
const menuItem = (page: Page, name: string) => page.getByRole("menu", { name: "Export" }).getByRole(/^Print|^Match/.test(name) ? "menuitemradio" : "menuitem", { name });

function outDir(info: TestInfo): string {
  const dir = process.env.FC_EXPORT ? join(process.env.FC_EXPORT, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function start(page: Page, scheme: "light" | "dark", files: { name: string; text: string }[], open: string) {
  await openIn(page, "/", scheme);
  await waitReady(page);
  await importFiles(page, files);
  await openFromTree(page, open);
  await page.locator(isNarrow(page) ? "#view-flowchart" : "#ptab-flowchart").click();
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

/** Chooses a menu item from the Export button (the one in the dialog when full screen is open). */
async function choose(page: Page, name: string) {
  await page.locator("#fc-export").click();
  await menuItem(page, name).click();
}

async function download(page: Page, name: "Download PNG" | "Download SVG"): Promise<{ file: string; bytes: Buffer; download: Download }> {
  const waiting = page.waitForEvent("download", { timeout: 30_000 }).catch(async () => {
    throw new Error(`no download: status "${await status(page).textContent()}"`);
  });
  const [d] = await Promise.all([waiting, choose(page, name)]);
  return { file: d.suggestedFilename(), bytes: readFileSync((await d.path())!), download: d };
}

/** The chart's own size on screen (its viewBox): the export adds the footer under it. */
const chartSize = (page: Page) =>
  page.locator(".fc-stage svg").evaluate((s) => {
    const [, , w, h] = s.getAttribute("viewBox")!.split(" ").map(Number);
    return { width: w, height: h };
  });

/** Checks a PNG's footer: the mark's blue and white at their computed spots, the words' ink, the ground. */
function checkFooter(px: RgbaPixels, chartHeight: number, scale: number, colors: { bg: string; text: string }) {
  const k = FOOTER.mark / BRAND_MARK.view;
  const markX = FOOTER.margin;
  const markY = chartHeight + (FOOTER.height - FOOTER.mark) / 2;
  const at = (vx: number, vy: number) => px.at(Math.floor((markX + vx * k) * scale), Math.floor((markY + vy * k) * scale));
  expect(off(at(16, 16), BRAND_MARK.tile.fill), "the mark's tile").toBeLessThanOrEqual(2);
  expect(off(at(16, 5), BRAND_MARK.tile.fill), "the mark's tile, top").toBeLessThanOrEqual(2);
  // The middle of the left chevron's upper stroke.
  expect(off(at(9.25, 13), BRAND_MARK.glyph.stroke), "the mark's glyph").toBeLessThanOrEqual(24);
  // The ground at the image's corner and beside the mark.
  expect(off(px.at(2, 2), colors.bg), "the ground").toBeLessThanOrEqual(1);
  expect(off(px.at(Math.floor(8 * scale), Math.floor(markY * scale)), colors.bg), "the footer's ground").toBeLessThanOrEqual(1);
  // "Made with ExecFlow": its ink is the text colour.
  const textX = FOOTER.margin + FOOTER.mark + FOOTER.gap;
  const y = chartHeight + FOOTER.height / 2;
  const area = { x0: Math.floor(textX * scale), x1: Math.floor((textX + FOOTER_TEXT.length * FOOTER.textW) * scale), y0: Math.floor((y - 8) * scale), y1: Math.floor((y + 6) * scale) };
  if (scale < 1) {
    // Under 1x the 12 px words are a few pixels tall, all edge: they are there, well off the ground.
    let far = 0;
    for (let yy = area.y0; yy <= area.y1; yy++) for (let xx = area.x0; xx <= area.x1; xx++) far = Math.max(far, off(px.at(xx, yy), colors.bg));
    expect(far, "the credit's words, against the ground").toBeGreaterThanOrEqual(120);
    return;
  }
  const ink = inkOf(px, area, colors.bg);
  expect(ink, "the credit's ink").not.toBeNull();
  expect(off(ink ? [parseInt(ink.slice(1, 3), 16), parseInt(ink.slice(3, 5), 16), parseInt(ink.slice(5, 7), 16)] : [0, 0, 0], colors.text), `the credit's ink ${ink}`).toBeLessThanOrEqual(6);
}

/** Parses the SVG back in the page and lists anything that isn't plain drawing. */
async function svgProblems(page: Page, xml: string) {
  return page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length) return { problems: ["parsererror"], title: "", texts: [] as string[], width: 0, height: 0 };
    const allowed = new Set(["svg", "title", "rect", "g", "polyline", "polygon", "line", "circle", "text", "tspan", "path"]);
    const problems: string[] = [];
    for (const el of [doc.documentElement, ...doc.documentElement.querySelectorAll("*")]) {
      if (!allowed.has(el.localName)) problems.push(`element ${el.localName}`);
      if (el.namespaceURI !== "http://www.w3.org/2000/svg") problems.push(`namespace ${el.localName} ${el.namespaceURI}`);
      for (const a of el.attributes) {
        const v = a.value;
        if (/^on/i.test(a.name) || /href/i.test(a.name) || a.name === "class" || a.name === "tabindex" || a.name.startsWith("data-")) problems.push(`attribute ${el.localName} ${a.name}`);
        if (/url\(|var\(|@import|javascript:|expression\(/i.test(v)) problems.push(`value ${el.localName} ${a.name}=${v}`);
        if ((a.name === "fill" || a.name === "stroke") && !/^(#[0-9a-f]{6}|none)$/.test(v)) problems.push(`colour ${el.localName} ${a.name}=${v}`);
        if (a.name === "style") for (const m of v.matchAll(/(?:fill|stroke):\s*([^;]+)/g)) if (!/^(#[0-9a-f]{6}|none)$/.test(m[1].trim())) problems.push(`style colour ${m[1]}`);
      }
    }
    const root = doc.documentElement;
    return {
      problems,
      title: root.querySelector("title")?.textContent ?? "",
      texts: [...root.querySelectorAll(":scope > g text")].map((t) => t.textContent ?? ""),
      width: Number(root.getAttribute("width")),
      height: Number(root.getAttribute("height")),
    };
  }, xml);
}

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // As in flowchart-look.spec.ts: the code editor's own scroller, reported there for its review.
  const editorScroller = (v: (typeof result.violations)[number]) => v.id === "scrollable-region-focusable" && v.nodes.every((n) => n.target.join(" ") === ".cm-scroller");
  return result.violations.filter((v) => !editorScroller(v)).map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}

const PRINT = printColors();

test.describe("Flowchart export", () => {
  for (const L of LANGS) {
    test(`${L.lang}: Download PNG and Download SVG in Print-safe light, each with the brand footer`, async ({ page }, info) => {
      await start(page, "light", [{ name: L.file, text: L.text }], L.file);
      const dir = outDir(info);
      const chart = await chartSize(page);

      const png = await download(page, "Download PNG");
      expect(png.file).toBe(L.png);
      await expect(status(page)).toHaveText(`Downloading ${L.png}.`);
      await png.download.saveAs(join(dir, png.file));

      const svg = await download(page, "Download SVG");
      expect(svg.file).toBe(L.png.replace(/png$/, "svg"));
      await expect(status(page)).toHaveText(`Downloading ${svg.file}.`);
      await svg.download.saveAs(join(dir, svg.file));
      const parsed = await svgProblems(page, svg.bytes.toString("utf8"));
      expect(parsed.problems).toEqual([]);
      expect(parsed.title).toBe(`Flowchart of ${L.fn} in ${L.file}`);
      expect(parsed.texts).toEqual([FOOTER_TEXT, L.footer]);
      expect(parsed.height).toBe(chart.height + FOOTER.height);
      expect(parsed.width).toBeGreaterThanOrEqual(chart.width);

      // The PNG is the SVG's size at 2x, on white, with the mark and the words where they are computed to be.
      const info2 = pngInfo(png.bytes);
      expect([info2.width, info2.height]).toEqual([parsed.width * 2, parsed.height * 2]);
      checkFooter(decodeRgba(png.bytes), chart.height, 2, { bg: PRINT.bg, text: PRINT.text });
      expect(PRINT.bg).toBe("#ffffff");
      // In colour, as the SVG and the view: a decision is tinted with the warning hue, above its words.
      const points = (await page.locator(".fc-stage svg g[data-kind=decision] polygon").first().getAttribute("points"))!;
      const [top, , bottom] = points.split(" ").map((p) => p.split(",").map(Number));
      const left = Math.round((parsed.width - chart.width) / 2);
      const tint = decodeRgba(png.bytes).at(Math.floor((left + top[0]) * 2), Math.floor((top[1] + (bottom[1] - top[1]) * 0.25) * 2));
      expect(off(tint, mixHex(PRINT.warning, PRINT["surface-raised"], CHART_TINT)), "the decision's tint").toBeLessThanOrEqual(2);
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: Match the editor gives the theme's ground; Print-safe stays white; the choice is remembered`, async ({ page }, info) => {
      await start(page, scheme, [{ name: "grades.c", text: C_PROGRAM }], "grades.c");
      const dir = outDir(info);
      const chart = await chartSize(page);
      const theme = await view(page).evaluate((v) => {
        const s = getComputedStyle(v);
        return { bg: s.getPropertyValue("--bg").trim().toLowerCase(), text: s.getPropertyValue("--text").trim().toLowerCase() };
      });
      // The scheme is really active: the page's ground is dark in dark, light in light. (The chart sits
      // on the console, which Signal keeps dark in both schemes, so "Match the editor" matches that.)
      const pageBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase());
      const lum = parseInt(pageBg.slice(1, 3), 16);
      expect(scheme === "dark" ? lum < 64 : lum > 192, `the ${scheme} page ground ${pageBg}`).toBe(true);

      // Print-safe is the default, in either scheme.
      await page.locator("#fc-export").click();
      await expect(menuItem(page, "Print-safe light")).toHaveAttribute("aria-checked", "true");
      await expect(menuItem(page, "Match the editor")).toHaveAttribute("aria-checked", "false");
      expect(await axe(page), "axe with the Export menu open").toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu", { name: "Export" })).toHaveCount(0);
      await expect(page.locator("#fc-export")).toBeFocused();
      const print = await download(page, "Download PNG");
      checkFooter(decodeRgba(print.bytes), chart.height, 2, { bg: PRINT.bg, text: PRINT.text });

      await choose(page, "Match the editor");
      const match = await download(page, "Download PNG");
      checkFooter(decodeRgba(match.bytes), chart.height, 2, theme);
      await match.download.saveAs(join(dir, `match-${scheme}-${match.file}`));
      const svg = await download(page, "Download SVG");
      const xml = svg.bytes.toString("utf8");
      expect(xml).toContain(`fill="${theme.bg}"`);
      expect((await svgProblems(page, xml)).problems).toEqual([]);
      await svg.download.saveAs(join(dir, `match-${scheme}-${svg.file}`));

      // Remembered: the menu shows it on the next opening, and after the chart redraws.
      await page.locator("#fc-export").click();
      await expect(menuItem(page, "Match the editor")).toHaveAttribute("aria-checked", "true");
      await expect(menuItem(page, "Print-safe light")).toHaveAttribute("aria-checked", "false");
      await page.keyboard.press("Escape");
      await expect(status(page)).toHaveText(`Downloading ${svg.file}.`);
      expect(await axe(page), "axe with the status shown").toEqual([]);
      await page.screenshot({ path: join(dir, `toolbar-${scheme}.png`), animations: "disabled" });
    });
  }

  test("Copy image where the browser can copy images, else no such item", async ({ page, context, browserName }) => {
    const real = browserName === "chromium";
    if (real) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, "light", [{ name: "grades.c", text: C_PROGRAM }], "grades.c");
    // canCopyImages's own rule (core/snippet.ts): a secure context, ClipboardItem, clipboard.write, PNG support.
    const can = await page.evaluate(() => {
      if (!window.isSecureContext || typeof ClipboardItem !== "function" || typeof navigator.clipboard?.write !== "function") return false;
      const supports = (ClipboardItem as unknown as { supports?: (t: string) => boolean }).supports;
      return typeof supports === "function" ? supports.call(ClipboardItem, "image/png") : true;
    });
    await page.locator("#fc-export").click();
    const items = await page.getByRole("menu", { name: "Export" }).getByRole("menuitem").allTextContents();
    if (!can) {
      expect(items.map((t) => t.trim())).toEqual(["Download PNG", "Download SVG"]);
      test.info().annotations.push({ type: "copy", description: `${browserName}: no image copy offered` });
      return;
    }
    expect(items.map((t) => t.trim())).toEqual(["Download PNG", "Download SVG", "Copy image"]);
    await page.keyboard.press("Escape");
    if (!real) {
      // Other engines' headless clipboards: the write is recorded (its PNG kept), as Capture snippet's specs do.
      await page.evaluate(() => {
        const w = window as unknown as { __png: Promise<number[]> | null };
        w.__png = null;
        navigator.clipboard.write = async (list: ClipboardItem[]) => {
          w.__png = list[0].getType("image/png").then(async (b) => Array.from(new Uint8Array(await b.arrayBuffer())));
          await w.__png;
        };
      });
    }
    await choose(page, "Copy image");
    await expect(status(page)).toHaveText("Copied the image.", { timeout: 15_000 });
    const bytes = real
      ? await page.evaluate(async () => {
          const [item] = await navigator.clipboard.read();
          return Array.from(new Uint8Array(await (await item.getType("image/png")).arrayBuffer()));
        })
      : await page.evaluate(() => (window as unknown as { __png: Promise<number[]> }).__png);
    const chart = await chartSize(page);
    checkFooter(decodeRgba(Buffer.from(bytes)), chart.height, 2, { bg: PRINT.bg, text: PRINT.text });
  });

  test("full screen exports too: the menu opens in the dialog and the download leaves from it", async ({ page }, info) => {
    await start(page, "light", [{ name: "grades.c", text: C_PROGRAM }], "grades.c");
    await page.locator("#fc-full").click();
    const dialog = page.locator("dialog#fc-dialog");
    await expect(dialog).toBeVisible();
    await page.locator("#fc-export").click();
    await expect(dialog.getByRole("menu", { name: "Export" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Escape closes the menu, not the full screen view.
    await expect(dialog).toBeVisible();
    await expect(page.locator("#fc-export")).toBeFocused();
    const png = await download(page, "Download PNG");
    expect(png.file).toBe("grades-c-main-flowchart.png");
    await expect(dialog.locator("#fc-status")).toHaveText("Downloading grades-c-main-flowchart.png.");
    const svg = await download(page, "Download SVG");
    expect((await svgProblems(page, svg.bytes.toString("utf8"))).problems).toEqual([]);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: join(outDir(info), "full-screen.png"), animations: "disabled" });
  });

  test("a chart past the browsers' safe size exports at a lower scale and says so", async ({ page }, info) => {
    // 150 decisions, one under another: about 20,000 px tall, so 2x would pass 16,384 px.
    const text = Array.from({ length: 150 }, (_, i) => `if x > ${i}:\n    x = ${i}`).join("\n") + "\n";
    await start(page, "light", [{ name: "tall.py", text: `x = 1\n${text}` }], "tall.py");
    const chart = await chartSize(page);
    expect(chart.height * 2, "the chart is past the cap at 2x").toBeGreaterThan(16_384);
    const png = await download(page, "Download PNG");
    const msg = (await status(page).textContent()) ?? "";
    const m = /^Downloading tall-py-Program-flowchart\.png\. The chart is too big for a 2x image, so this one is ([\d.]+)x\.$/.exec(msg);
    expect(m, msg).not.toBeNull();
    const scale = Number(m![1]);
    expect(scale).toBeLessThan(2);
    const { width, height } = pngInfo(png.bytes);
    expect(height).toBe(Math.ceil((chart.height + FOOTER.height) * scale));
    expect(height).toBeLessThanOrEqual(16_384);
    expect(width * height).toBeLessThanOrEqual(16_777_216);
    checkFooter(decodeRgba(png.bytes), chart.height, scale, { bg: PRINT.bg, text: PRINT.text });
    await png.download.saveAs(join(outDir(info), png.file));
  });
});
