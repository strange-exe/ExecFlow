// Save as PDF (.claude/design/pdf.md): the file menu item and the command palette open the dialog;
// its primary action builds the print-only layout and opens the browser's print dialog, and
// afterprint takes the layout away with focus back where it was. window.print is replaced by a
// recorder in these tests (the real dialog can't be driven); the layout is checked with print media
// emulated, and in Chromium page.pdf() prints it for real: page breaks, the footer on every page
// and the code text are read back from the PDF (e2e/pdf-text.ts). Production build; the fixture
// fails on any console error, page error or failed request. Waits use state attributes.
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { PRINT_INK } from "../src/theme/print-ink";
import { afterFetch, expect, importFiles, openApp, openFromTree, test, tolerating } from "./helpers";
import { pdfFillColours, pdfPages } from "./pdf-text";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const MAIN = "# total of two numbers\ndef add(a, b):\n    return a + b\n\nprint(add(2, 3))\n";
const UTIL = `#include <stdio.h>\n\nint main(void) {\n    printf("${"wrap me ".repeat(30)}\\n");\n    return 0;\n}\n`;
/** About three pages of Python at 13 pt a line. */
const LONG = Array.from({ length: 150 }, (_, i) => `value_${i} = ${i} * 2  # line ${i + 1}`).join("\n") + "\n";
const FILES = [{ name: "main.py", text: MAIN }, { name: "util.c", text: UTIL }, { name: "long.py", text: LONG }];

const dialog = (page: Page) => page.locator("dialog#pdf-dialog");
const app = (page: Page) => page.locator("#app");

/** window.print records what the page looked like when it was called, and opens nothing. */
async function recordPrints(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __prints: unknown[] };
    w.__prints = [];
    window.print = () => {
      w.__prints.push({
        printing: document.documentElement.dataset.printing ?? null,
        title: document.title,
        files: [...document.querySelectorAll<HTMLElement>(".print-file")].map((s) => s.dataset.path),
        dialogOpen: document.querySelector("dialog[open]") !== null,
      });
    };
  });
}
const prints = (page: Page) => page.evaluate(() => (window as unknown as { __prints: { printing: string | null; title: string; files: string[]; dialogOpen: boolean }[] }).__prints);
/** The browser's print dialog closes. */
const afterPrint = (page: Page) => page.evaluate(() => void dispatchEvent(new Event("afterprint")));

async function openWithFiles(page: Page) {
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
}

async function openFromFileMenu(page: Page) {
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Save as PDF..." }).click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
}

const fileBox = (page: Page, path: string) => dialog(page).locator(`input[type=checkbox][data-path="${path}"]`);

/** Chooses `paths` (and only them) and opens the print dialog; waits until the layout is in the page. */
async function printFiles(page: Page, paths: string[]) {
  for (const box of await dialog(page).locator("input[data-path]").all()) await box.setChecked(paths.includes((await box.getAttribute("data-path"))!));
  await dialog(page).getByRole("button", { name: "Open print dialog" }).click();
  await expect(app(page)).toHaveAttribute("data-print", "printing");
}

test("1: the file menu item opens the dialog with the open file chosen, one line on what comes next, and focus on the primary action", async ({ page }) => {
  await openWithFiles(page);
  await openFromFileMenu(page);
  const d = page.getByRole("dialog", { name: "Save as PDF" });
  await expect(d).toBeVisible();
  await expect(d).toHaveAccessibleDescription('Your browser\'s print dialog opens next. Choose "Save as PDF" as the printer.');
  await expect(fileBox(page, "main.py")).toBeChecked();
  await expect(fileBox(page, "util.c")).not.toBeChecked();
  await expect(fileBox(page, "long.py")).not.toBeChecked();
  await expect(d.getByRole("checkbox", { name: "main.py" })).toBeChecked();
  await expect(d.getByRole("button", { name: "Open print dialog" })).toBeFocused();
  await expect(d.getByRole("radio", { name: "Print-safe light" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: "Line numbers" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: '"Made with CodeEditor" footer' })).toBeChecked();
  const axe = await new AxeBuilder({ page }).include("#pdf-dialog").withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  // Escape closes it, nothing prints, and focus goes back to the menu's button.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#file-actions")).toBeFocused();
  await expect(page.locator("#print-root")).toHaveCount(0);
});

test("2: the command palette opens it too; Escape returns focus to the code", async ({ page }) => {
  await openWithFiles(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("F1");
  // The palette is a lazy chunk: type once its field has the focus.
  await expect(page.locator("#palette-input")).toBeFocused();
  await page.keyboard.type("save as pdf");
  const option = page.getByRole("option", { name: /^Save as PDF\.\.\./ });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#palette-input")).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(fileBox(page, "main.py")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("3: printing: the layout replaces the app on paper, in the editor's highlight colours; afterprint takes it away and focus comes back", async ({ page }) => {
  await recordPrints(page);
  await openWithFiles(page);
  await openFromFileMenu(page);
  await printFiles(page, ["main.py", "util.c"]);
  const [p] = await prints(page);
  expect(p).toEqual({ printing: "true", title: "main.py and 1 more file", files: ["main.py", "util.c"], dialogOpen: false });
  // On screen nothing changed: the layout is never drawn there.
  await expect(page.locator("#print-root")).toBeHidden();
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  try {
    // On paper only the layout: no app chrome.
    await expect(page.locator("#print-root")).toBeVisible();
    for (const chrome of ["#app", ".statusbar", "#file-actions"]) await expect(page.locator(chrome).first()).toBeHidden();
    const root = page.locator("#print-root");
    await expect(root.locator(".print-path")).toHaveText(["main.py", "util.c"]);
    // Each file starts on a new page.
    expect(await root.locator(".print-file").nth(1).evaluate((el) => getComputedStyle(el).breakBefore)).toBe("page");
    // Line numbers; the code's text exactly (trailing newline: no empty last line).
    await expect(root.locator(".print-file").first().locator(".print-n")).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(root.locator(".print-file").first().locator(".print-c").nth(1)).toHaveText("def add(a, b):");
    // The highlight style's colours in the print-safe palette.
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const colourOf = (text: string) => root.locator(".print-c span", { hasText: new RegExp(`^${text}$`) }).first().evaluate((el) => getComputedStyle(el).color);
    expect(await colourOf("def")).toBe(rgb(PRINT_INK["syn-keyword"]));
    expect(await colourOf("print")).toBe(rgb(PRINT_INK["syn-function"]));
    expect(await root.locator(".print-c span.i").first().evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontStyle])).toEqual([rgb(PRINT_INK["syn-comment"]), "italic"]);
    expect(await root.locator(".print-n").first().evaluate((el) => getComputedStyle(el).color)).toBe(rgb(PRINT_INK["gutter-text"]));
    // The long printf line wraps (never cut): its cell is several rows tall and nothing overflows the page's width.
    const long = root.locator(".print-file").nth(1).locator(".print-c").nth(3);
    const box = (await long.boundingBox())!;
    expect(box.height, "the long line wraps onto more rows").toBeGreaterThan(13 * 1.33 * 2);
    expect(await long.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await long.evaluate((el) => getComputedStyle(el, "::after").maskImage || getComputedStyle(el, "::after").getPropertyValue("-webkit-mask-image"))).toMatch(/^url\(/);
    // The footer: page margin boxes where the browser draws them (Chromium), else the table's own footer row, without a page number.
    const date = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date()));
    const boxes = (await root.getAttribute("data-boxes")) === "true";
    test.info().annotations.push({ type: "3 footer", description: `${test.info().project.name}: ${boxes ? "page margin boxes" : "the table's footer row"}` });
    expect(boxes, "Chromium draws margin boxes; Firefox and WebKit don't").toBe(test.info().project.name === "chromium");
    const foot = root.locator(".print-foot").first();
    if (boxes) await expect(foot).toBeHidden();
    else await expect(foot).toHaveText(`main.py, ${date}. Made with CodeEditor`);
    expect(await page.locator("#print-pages").textContent()).toContain("@page ce-file-1");
    await page.screenshot({ path: test.info().outputPath("print-media.png"), fullPage: true });
  } finally {
    await page.emulateMedia({ media: null });
  }
  await afterPrint(page);
  await expect(app(page)).toHaveAttribute("data-print", "done");
  await expect(page.locator("#print-root")).toHaveCount(0);
  await expect(page.locator("#print-pages")).toHaveCount(0);
  expect(await page.evaluate(() => [document.documentElement.dataset.printing ?? null, document.title])).toEqual([null, "CodeEditor"]);
  await expect(page.locator("#file-actions")).toBeFocused();
});

test("4: nothing chosen: the dialog says so beside the files and moves focus there; choosing one clears it", async ({ page }) => {
  await recordPrints(page);
  await openWithFiles(page);
  await openFromFileMenu(page);
  await dialog(page).getByRole("button", { name: "Clear" }).click();
  await dialog(page).getByRole("button", { name: "Open print dialog" }).click();
  const error = dialog(page).locator("#pdf-files-error");
  await expect(error).toHaveText("Choose at least one file.");
  await expect(dialog(page).getByRole("group", { name: "Files" })).toHaveAccessibleDescription("Choose at least one file.");
  // Focus goes to the first file of the list (the tree's order).
  await expect(dialog(page).locator("input[data-path]").first()).toBeFocused();
  const axe = await new AxeBuilder({ page }).include("#pdf-dialog").withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.keyboard.press("Space");
  await expect(error).toHaveCount(0);
  expect(await prints(page)).toEqual([]);
  // Select all chooses every file.
  await dialog(page).getByRole("button", { name: "Select all" }).click();
  for (const f of FILES) await expect(fileBox(page, f.name)).toBeChecked();
});

test("5: the options are remembered on this device, cleaned when read; numbers off and the editor's colours reach the layout", async ({ page, browserName }) => {
  await recordPrints(page);
  // An explicit dark theme, not "match device": Firefox matches prefers-color-scheme as light under
  // print media (whatever scheme is emulated), so a device-following theme turned light mid-test on CI.
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "signal-dark"));
  await openWithFiles(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await openFromFileMenu(page);
  await dialog(page).getByRole("radio", { name: "The editor's colours" }).check();
  await dialog(page).getByRole("checkbox", { name: "Line numbers" }).uncheck();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("codeeditor:print")))!)).toEqual({ colours: "theme", numbers: false, footer: true });
  await printFiles(page, ["main.py"]);
  await page.emulateMedia({ media: "print" });
  const root = page.locator("#print-root");
  await expect(root).toHaveAttribute("data-colours", "theme");
  await expect(root.locator(".print-n").first()).toBeHidden();
  // The editor's own dark ground and keyword colour.
  const t = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() }));
  const bg = await root.locator(".print-file").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(`rgb(${[1, 3, 5].map((i) => parseInt(t.bg.slice(i, i + 2), 16)).join(", ")})`);
  await page.emulateMedia({ media: null });
  if (browserName === "chromium") {
    // On paper too, with "Background graphics" off (print-color-adjust: exact on the layout).
    const pdf = await page.pdf({ preferCSSPageSize: true, format: "A4" });
    writeFileSync(test.info().outputPath("sample-theme.pdf"), pdf);
    expect([...pdfFillColours(pdf)], "the editor's dark ground is printed").toContain(t.bg);
  }
  await afterPrint(page);
  await expect(app(page)).toHaveAttribute("data-print", "done");
  await page.evaluate(() => localStorage.setItem("codeeditor:print", '{"colours":"neon","numbers":"x"}'));
  await openFromFileMenu(page);
  await expect(dialog(page).getByRole("radio", { name: "Print-safe light" })).toBeChecked();
  await expect(dialog(page).getByRole("checkbox", { name: "Line numbers" })).toBeChecked();
});

test("6 (Chromium): page.pdf prints it: each file from a new page, a footer with the path, Page n of N, the date and the mark on every page, the code's text", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "page.pdf() is Chromium's");
  await recordPrints(page);
  await openWithFiles(page);
  await openFromFileMenu(page);
  await printFiles(page, ["main.py", "util.c", "long.py"]);
  await expect(page.locator("#print-root")).toHaveAttribute("data-boxes", "true");
  // printBackground off is the print dialog's default ("Background graphics" unticked).
  const pdf = await page.pdf({ preferCSSPageSize: true, format: "A4" });
  writeFileSync(test.info().outputPath("sample.pdf"), pdf);
  const pages = pdfPages(pdf);
  const squash = (s: string) => s.replace(/\s+/g, "");
  // The list's order (the tree's): long.py's 150 lines on three pages (56 lines a page), then main.py, then util.c.
  const owner = (s: string) => (s.includes("value_") ? "long.py" : s.includes("#include") ? "util.c" : s.includes("defadd") ? "main.py" : null);
  expect(pages.map((t) => owner(squash(t))), "one file per page, each from a new page").toEqual(["long.py", "long.py", "long.py", "main.py", "util.c"]);
  const date = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date()));
  const count = (s: string, part: string) => s.split(part).length - 1;
  pages.forEach((text, i) => {
    const s = squash(text);
    const file = owner(s)!;
    expect(s, `page ${i + 1}: Page ${i + 1} of 5`).toContain(`Page${i + 1}of5`);
    expect(s, `page ${i + 1}: the mark`).toContain("MadewithCodeEditor");
    expect(s, `page ${i + 1}: the footer names the file and the date`).toContain(squash(`${file}, ${date}`));
    // The heading on a file's first page only (the footer names it on every page).
    const first = i === 0 || owner(squash(pages[i - 1])) !== file;
    expect(count(s, file), `page ${i + 1}: ${file} named ${first ? "in the heading and the footer" : "in the footer"}`).toBe(first ? 2 : 1);
    // No "Made with" claim beyond those words, and no browser header or footer (title, address).
    expect(s).not.toMatch(/verified|author/i);
    expect(s).not.toContain("127.0.0.1");
  });
  const all = squash(pages.join(" "));
  expect(all).toContain("defadd(a,b):");
  expect(all).toContain("value_149=149*2#line150");
  expect(all, "the wrapped line is all there").toContain(squash("wrap me ".repeat(30)));
  // The print-safe ink, with "Background graphics" off: the keyword, string and number colours are on the page.
  const fills = pdfFillColours(pdf);
  for (const t of ["syn-keyword", "syn-string", "syn-number", "gutter-text", "text-secondary"] as const) expect([...fills], t).toContain(PRINT_INK[t]);
  // Printing fires the browser's own afterprint (page.pdf prints as the dialog does): the layout went with it, focus is back.
  await expect(app(page)).toHaveAttribute("data-print", "done");
  await expect(page.locator("#print-root")).toHaveCount(0);
  await expect(page.locator("#file-actions")).toBeFocused();
  // And with Chromium's own "Headers and footers" on, still only ours (the empty top box and our bottom boxes keep its out).
  await openFromFileMenu(page);
  await printFiles(page, ["main.py", "util.c", "long.py"]);
  const browsers = await page.pdf({ preferCSSPageSize: true, format: "A4", displayHeaderFooter: true });
  writeFileSync(test.info().outputPath("sample-browser-headers.pdf"), browsers);
  const withBrowsers = pdfPages(browsers);
  expect(withBrowsers.length).toBe(5);
  for (const text of withBrowsers) {
    expect(text, "no browser header (the title)").not.toContain("long.py and 2 more files");
    expect(text, "no browser footer (the address)").not.toContain("127.0.0.1");
    expect(text.replace(/\s+/g, "")).toContain("MadewithCodeEditor");
  }
  await expect(app(page)).toHaveAttribute("data-print", "done");
});

test.describe("the highlighting chunk can't load", () => {
  // The 404 below is the point of the test, reported in each engine's own words (as args.spec's).
  test.use(
    tolerating(
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js (net::ERR_ABORTED|NS_ERROR_CORRUPTED_CONTENT|Load request cancelled)$/,
    ),
  );

  test("8: the dialog says so and prints nothing; once the chunk loads again, the next press prints", async ({ page, browserName }) => {
    await recordPrints(page);
    let refused = 0;
    let failing = true;
    // Found by its content (its name is a hash): the chunk that exports printFile.
    await page.route(
      /\/assets\/[\w-]+\.js$/,
      afterFetch(async (route) => {
        const response = await route.fetch();
        if (failing && /as printFile\b/.test(await response.text())) {
          refused++;
          return route.fulfill({ status: 404, body: "" });
        }
        return route.fulfill({ response });
      }),
    );
    await openWithFiles(page);
    await openFromFileMenu(page);
    await expect.poll(() => refused).toBeGreaterThan(0);
    await dialog(page).getByRole("button", { name: "Open print dialog" }).click();
    await expect(dialog(page).locator("#pdf-status")).toHaveText("Couldn't prepare the pages. Check the connection, then try again.");
    await expect(dialog(page)).toHaveAttribute("data-state", "ready");
    expect(await prints(page)).toEqual([]);
    await expect(page.locator("#print-root")).toHaveCount(0);
    failing = false;
    if (browserName === "webkit") {
      // Playwright's WebKit keeps a failed dynamic import() failed for the whole context (lessons.md 2026-10-21).
      test.info().annotations.push({ type: "webkit", description: "recovery not checked: a failed import stays failed in the context" });
      return;
    }
    await dialog(page).getByRole("button", { name: "Open print dialog" }).click();
    await expect(app(page)).toHaveAttribute("data-print", "printing");
    expect((await prints(page)).map((p) => p.files)).toEqual([["main.py"]]);
    await afterPrint(page);
    await expect(app(page)).toHaveAttribute("data-print", "done");
  });
});

test("7 (Chromium): the footer off prints no mark, no page furniture and none of the browser's own (title, address, page)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "page.pdf() is Chromium's");
  await recordPrints(page);
  await openWithFiles(page);
  await openFromFileMenu(page);
  await dialog(page).getByRole("checkbox", { name: '"Made with CodeEditor" footer' }).uncheck();
  await printFiles(page, ["main.py"]);
  await expect(page.locator("#print-root .print-foot")).toHaveCount(0);
  const pages = pdfPages(await page.pdf({ preferCSSPageSize: true, format: "A4", displayHeaderFooter: true }));
  expect(pages).toHaveLength(1);
  const s = pages[0].replace(/\s+/g, "");
  expect(s).toContain("defadd(a,b):");
  for (const absent of ["MadewithCodeEditor", "Page1of1", "127.0.0.1", "1/1"]) expect(s, absent).not.toContain(absent);
  await expect(app(page)).toHaveAttribute("data-print", "done");
});
