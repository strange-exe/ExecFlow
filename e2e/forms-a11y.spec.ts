// Forms, accessibility and loading, checked against the modern-web guidance (guides forms,
// accessibility, validate-input-after-interaction, accessible-error-announcement,
// performance; audit of 2026-11-17). Each test names the rule it holds:
// - touch screens: text fields are at least 16 px, so iOS Safari doesn't zoom the page on focus;
// - an error that appears while focus stays in the field (rename on Enter) or after leaving it
//   (Arguments on change) is said through a polite live region;
// - a status that changes while typing (the palette's result count, the theme count) is said once
//   the typing pauses, not on every key;
// - required fields say so in code; fields holding names or program input never autocorrect;
// - a field's hint is linked to it; a visible label is its name (no aria-label over it);
// - the theme search sits in a <search> landmark; the visually-hidden recipe uses clip-path;
// - every font is downloaded once (no preload that a browser fetches again).
import type { Page } from "@playwright/test";
import { makeCodeLink } from "../src/core/code-link";
import { parseArgs } from "../src/runner/run-args";
import { expect, importFiles, openApp, openFromTree, openInputBox, openThemePicker, showFiles, test, treeItem } from "./helpers";
import { syncStatus } from "./sync-fake";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const reasonOf = (text: string) => {
  const parsed = parseArgs(text);
  if (parsed.ok) throw new Error("expected arguments that can't be split");
  return parsed.reason;
};

/** Counts how often `selector`'s text changes from now on (read back with `changes`). */
async function watchText(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const w = window as unknown as { textChanges: Record<string, number> };
    w.textChanges ??= {};
    w.textChanges[sel] = 0;
    let last = el.textContent;
    new MutationObserver(() => {
      if (el.textContent === last) return;
      last = el.textContent;
      w.textChanges[sel]++;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }, selector);
  return () => page.evaluate((sel) => (window as unknown as { textChanges: Record<string, number> }).textChanges[sel], selector);
}

test.describe("touch screens", () => {
  test.use({ hasTouch: true });

  test("text fields are at least 16 px, so focusing one doesn't zoom the page", async ({ page }) => {
    await openApp(page);
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    test.skip(!coarse, "this engine doesn't report a coarse pointer for touch emulation");
    await importFiles(page, [{ name: "main.py", text: 'print(input("Name? "))\n' }]);
    await openFromTree(page, "main.py");
    const sizes = await page.evaluate(() => {
      const probe = document.createElement("input");
      probe.className = "probe";
      document.body.append(probe);
      const fields = [...document.querySelectorAll<HTMLElement>("input:not([type=checkbox], [type=radio], [type=range], [type=file]), textarea, select")];
      const out = fields.map((f) => ({ field: f.id || f.className || f.tagName, size: parseFloat(getComputedStyle(f).fontSize) }));
      probe.remove();
      return out;
    });
    expect(sizes.map((s) => s.field)).toEqual(expect.arrayContaining(["stdin", "live-input-field", "probe"]));
    expect(sizes.filter((s) => s.size < 16), "fields under 16 px").toEqual([]);
  });
});

test("a rename refused on Enter is said aloud, since focus stays in the field", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "alpha.py", text: "print('alpha')\n" },
    { name: "beta.py", text: "print('beta')\n" },
  ]);
  await treeItem(page, "beta.py").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for beta.py" });
  await expect(field).toBeFocused();
  await field.fill("alpha.py");
  await field.press("Enter");
  const error = page.locator(".tree-error");
  await expect(error).toBeVisible();
  await expect(field).toBeFocused();
  const said = page.locator('[data-editing="true"] > [aria-live="polite"]');
  await expect(said).toHaveText((await error.textContent())!);
});

test("an Arguments error that shows on leaving the field is said, a moment later", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "import sys\nprint(sys.argv)\n" }]);
  await openFromTree(page, "main.py");
  await openInputBox(page);
  const field = page.locator("#args-field");
  await field.fill('1 "two');
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#args-row")).toHaveAttribute("data-state", "invalid");
  await expect(page.locator("[data-announcer]")).toHaveText(`Arguments: ${reasonOf('1 "two')}`);
});

test("the palette says its result count once typing pauses, not on every key", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print(1)\n" }]);
  await page.keyboard.press("F1");
  const input = page.locator("#palette-input");
  await expect(input).toBeFocused();
  const status = "dialog#palette [role=status]";
  const changes = await watchText(page, status);
  await input.pressSequentially("run", { delay: 40 });
  await expect(page.locator(status)).toHaveText(/\d+ results?|No commands match/);
  await page.waitForTimeout(800);
  expect(await changes(), "status changes for three keys").toBe(1);
});

test("the theme search says its count once typing pauses, and sits in a search landmark", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  await expect(dialog.locator("search #theme-search")).toHaveCount(1);
  const search = dialog.getByRole("searchbox", { name: "Search themes" });
  await search.focus();
  const status = "#theme-status";
  await expect(page.locator(status)).toHaveAttribute("role", "status");
  const changes = await watchText(page, status);
  await search.pressSequentially("nord", { delay: 40 });
  // The visible count follows every key; the spoken one waits.
  await expect(dialog.locator("#theme-count")).toHaveText(/^1 of \d+ families$/);
  await expect(page.locator(status)).toHaveText(/^1 of \d+ families$/);
  await page.waitForTimeout(800);
  expect(await changes(), "spoken count changes for four keys").toBe(1);
});

test("the connect form marks its required fields in code", async ({ page }) => {
  await openApp(page);
  await syncStatus(page).click();
  await expect(page.locator("#connect-dialog")).toBeVisible();
  for (const id of ["connect-owner", "connect-repo", "connect-token"]) await expect(page.locator(`#${id}`)).toHaveAttribute("required", "");
  await expect(page.locator("#connect-branch")).not.toHaveAttribute("required");
});

test("fields that hold names or program input never autocorrect, and the live input's key hint is read with it", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print(1)\n" }]);
  await openFromTree(page, "main.py");
  for (const id of ["stdin", "live-input-field"]) {
    await expect(page.locator(`#${id}`), id).toHaveAttribute("autocorrect", "off");
    await expect(page.locator(`#${id}`), id).toHaveAttribute("autocapitalize", "none");
  }
  await expect(page.locator("#live-input-field")).toHaveAttribute("aria-describedby", "live-hint");
  await expect(page.locator("#live-hint")).toHaveText(/Ctrl\+D ends input/);

  await showFiles(page);
  await treeItem(page, "main.py").focus();
  await page.keyboard.press("F2");
  await expect(page.locator(".tree-input")).toHaveAttribute("autocorrect", "off");
  await page.keyboard.press("Escape");

  await page.keyboard.press("F1");
  await expect(page.locator("#palette-input")).toHaveAttribute("autocorrect", "off");
  await page.keyboard.press("Escape");

  await openThemePicker(page);
  await expect(page.locator("#theme-search")).toHaveAttribute("autocorrect", "off");
});

test("a code link's Input and Function fields take their names from their visible labels", async ({ page }) => {
  const made = await makeCodeLink("https://example.test", "ask.py", 'def f():\n    return 1\n\nprint(input("Name? "))\n');
  if (!made.ok) throw new Error(made.refusal.kind);
  await openApp(page, `/${made.url.slice(made.url.indexOf("#"))}`);
  await expect(page.locator("dialog#code-link")).toHaveAttribute("data-state", "ready");
  const stdin = page.locator("#code-link-stdin");
  await expect(stdin).not.toHaveAttribute("aria-label");
  await expect(stdin).toHaveAttribute("autocorrect", "off");
  await expect(page.locator("#code-link-function")).not.toHaveAttribute("aria-label");
  await page.locator("#code-link-run").click();
  await expect(stdin).toBeVisible({ timeout: 60_000 });
  await expect(stdin).toHaveAccessibleName("Input");
});

test("the visually-hidden recipe clips with clip-path", async ({ page }) => {
  await openApp(page);
  const clip = await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "visually-hidden";
    document.body.append(el);
    const value = getComputedStyle(el).clipPath;
    el.remove();
    return value;
  });
  expect(clip).toBe("inset(50%)");
});

// A font preload was tried (2026-11-17) and left out: Playwright's WebKit then downloaded Geist
// twice (the preload and the @font-face request, 29.7 KB each). This keeps any later preload honest.
for (const path of ["/", "/about"]) {
  test(`${path} downloads each font once`, async ({ page }) => {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.endsWith(".woff2")));
    expect(fonts.length, "fonts downloaded").toBeGreaterThan(0);
    expect(fonts, "each font once").toEqual([...new Set(fonts)]);
  });
}
