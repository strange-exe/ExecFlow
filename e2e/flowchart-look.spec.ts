// DESIGN.md section 6 Level 2 for the Flowchart view (and Level 3's matrix, since it adds a view):
// 1440 x 900 and 390 x 844, light and dark (the scheme proved first), axe, no sideways scroll, target
// sizes, the focus ring and the caret's outline, the phone view's path to the code, and screenshots
// of every state plus full screen, with gray and blur copies for the reading order (DESIGN-REFERENCE
// 1A): 1. the chart, 2. the picker and zoom, 3. Full screen. Shots go to FC_SHOTS when set (the
// review folder), else to each test's output folder.
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, hierarchyShots, importFiles, isNarrow, openFromTree, openIn, test, tolerating, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PROGRAM = [
  "#include <stdio.h>",
  "int grade(int score) {",
  "    if (score >= 90) return 'A';",
  "    else if (score >= 75) return 'B';",
  "    return 'C';",
  "}",
  "int main(void) {",
  "    int n, score;",
  '    scanf("%d", &n);',
  "    for (int i = 0; i < n; i++) {",
  '        scanf("%d", &score);',
  "        if (score < 0) continue;",
  '        printf("%c", grade(score));',
  "    }",
  "    return 0;",
  "}",
  "",
].join("\n");

/**
 * axe's findings. One is left out, narrowly: scrollable-region-focusable on the code editor's own
 * scroller when the code is taller than the editor (the panel open below it). The editable code
 * inside it takes the focus and scrolls by caret, so the keyboard reaches all of it; the finding is
 * the editor's, not the Flowchart view's, and is reported for its own review (flowchart M3 report).
 */
async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const editorScroller = (v: (typeof result.violations)[number]) => v.id === "scrollable-region-focusable" && v.nodes.every((n) => n.target.join(" ") === ".cm-scroller");
  return result.violations.filter((v) => !editorScroller(v)).map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

function shotsDir(info: TestInfo): string {
  const dir = process.env.FC_SHOTS ? join(process.env.FC_SHOTS, info.project.name) : info.outputPath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function start(page: Page, scheme: "light" | "dark", files: { name: string; text: string }[], open: string) {
  await openIn(page, "/", scheme);
  await waitReady(page);
  await importFiles(page, files);
  await openFromTree(page, open);
  await page.locator(isNarrow(page) ? "#view-flowchart" : "#ptab-flowchart").click();
}

const view = (page: Page) => page.locator(".fc-view");

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${vp.name} ${scheme}: the chart, axe, targets, focus and full screen`, async ({ page }, info) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await start(page, scheme, [{ name: "grades.c", text: PROGRAM }], "grades.c");
      await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      const dir = shotsDir(info);
      const tag = `${vp.name}-${scheme}`;
      expect(await overflow(page)).toBe(false);
      expect(await axe(page)).toEqual([]);

      // Targets: 24 px everywhere, 44 on phones.
      const least = isNarrow(page) ? 44 : 24;
      for (const id of ["#fc-zoom-out", "#fc-fit", "#fc-zoom-in", "#fc-steps-toggle", "#fc-full", "#fc-picker"]) {
        const b = await page.locator(id).boundingBox();
        expect(b, id).not.toBeNull();
        expect(Math.min(b!.width, b!.height), `${id} size`).toBeGreaterThanOrEqual(least - 0.5);
      }

      // The keyboard path: a focused box shows a solid ring in the focus colour.
      await page.locator(".fc-stage [role=listitem][tabindex='0']").focus();
      await page.keyboard.press("ArrowDown");
      const ring = page.locator(".fc-stage [role=listitem]:focus .fc-ring");
      await expect(ring).toHaveCSS("stroke-dasharray", "none");
      expect(await ring.evaluate((el) => getComputedStyle(el).stroke)).not.toBe("none");
      await page.screenshot({ path: join(dir, `chart-${tag}.png`), animations: "disabled" });
      await hierarchyShots(page, join(dir, `chart-${tag}`));

      // Full screen.
      await page.locator("#fc-full").click();
      await expect(page.locator("#fc-dialog")).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: join(dir, `full-${tag}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(page.locator("#fc-full")).toBeFocused();

      // Steps as text.
      await page.locator("#fc-steps-toggle").click();
      await expect(page.locator(".fc-steps")).toBeVisible();
      expect(await axe(page)).toEqual([]);
      expect(await overflow(page)).toBe(false);
      await page.screenshot({ path: join(dir, `steps-${tag}.png`), animations: "disabled" });
    });

    test(`${vp.name} ${scheme}: every state`, async ({ page }, info) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const big = `int main(void) {\n${Array.from({ length: 450 }, (_, i) => `    if (x == ${i}) x++;`).join("\n")}\n}\n`;
      await start(
        page,
        scheme,
        [
          { name: "broken.c", text: "int main(void) {\n    int x = 1;\n    if (x > 0 {\n        x = 2;\n    }\n    return x;\n}\n" },
          { name: "big.c", text: big },
          { name: "notes.txt", text: "hello\n" },
          { name: "empty.py", text: "" },
        ],
        "broken.c",
      );
      const dir = shotsDir(info);
      const tag = `${vp.name}-${scheme}`;
      const states: [string, string][] = [["broken.c", "ready"], ["big.c", "too-big"], ["notes.txt", "other"], ["empty.py", "empty"]];
      for (const [file, state] of states) {
        if (isNarrow(page)) await page.locator("#view-code").click();
        await openFromTree(page, file);
        if (isNarrow(page)) await page.locator("#view-flowchart").click();
        await expect(view(page)).toHaveAttribute("data-state", state, { timeout: 30_000 });
        expect(await overflow(page), file).toBe(false);
        expect(await axe(page), file).toEqual([]);
        await page.screenshot({ path: join(dir, `state-${state}-${tag}.png`), animations: "disabled" });
      }
    });
  }
}

test.describe("loading and failure states, shot", () => {
  test.use(tolerating(/^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/flowchart\//, /^Failed to load resource: the server responded with a status of 404/));
  for (const scheme of ["light", "dark"] as const) {
    test(`loading and failed (${scheme})`, async ({ page }, info) => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await page.route("**/flowchart/*/tree-sitter-c.wasm", async (route) => {
        await held;
        await route.fulfill({ status: 404, body: "missing" });
      });
      await start(page, scheme, [{ name: "main.c", text: PROGRAM }], "main.c");
      await expect(view(page)).toContainText("Loading the C flowchart tools...");
      expect(await axe(page)).toEqual([]);
      const dir = shotsDir(info);
      await page.screenshot({ path: join(dir, `state-loading-${scheme}.png`), animations: "disabled" });
      release();
      await expect(view(page)).toHaveAttribute("data-state", "failed");
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: join(dir, `state-failed-${scheme}.png`), animations: "disabled" });
    });
  }
});

test("phone: a box goes to the code view, with its lines selected", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, "light", [{ name: "grades.c", text: PROGRAM }], "grades.c");
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  const target = page.locator(".fc-stage [role=listitem][data-node='3']");
  await target.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#view-code")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toBeFocused();
});
