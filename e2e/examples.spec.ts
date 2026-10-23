// "New from example..." (.claude/design/batch3/p.md section 3): the dialog from the empty
// workspace, the file menu and the palette; each example is added under a free name, opened, and
// runs to exit code 0 with the input it asks for (Python in every engine; C and C++ with the pack,
// which the tests serve). Waits are on states: the dialog's data-state, the active file, data-runs.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { EXAMPLES } from "../src/ui/examples";
import { expect, expectActive, installCpp, openApp, run, showFiles, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const dialog = (page: Page) => page.locator("dialog#examples");

async function choose(page: Page, name: string) {
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await dialog(page).locator(`[data-example="${name}"]`).click();
  await expect(dialog(page)).toHaveCount(0);
}

test("the empty workspace offers the examples; one is added, opened and focused, and Escape returns to the opener", async ({ page }) => {
  await openApp(page);
  const link = page.locator("#empty-examples");
  await expect(link).toHaveAccessibleName("New from example...");
  await link.click();
  await expect(dialog(page)).toHaveAttribute("data-state", "ready");
  await expect(dialog(page)).toHaveAccessibleName("New from example");
  // Grouped by language, three each; the first example has the focus.
  for (const [lang, n] of [["Python", 3], ["C", 3], ["C++", 3]] as const) {
    await expect(dialog(page).getByRole("group", { name: lang, exact: true }).getByRole("button")).toHaveCount(n);
  }
  await expect(dialog(page).locator("[data-example]").first()).toBeFocused();
  const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}`);
  expect(axe).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(link).toBeFocused();

  await link.click();
  await choose(page, "functions.py");
  await expectActive(page, "functions.py");
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page.locator(".cm-content")).toContainText("def area_of_rectangle(width, height):");
});

test("from the file menu and from the palette; a taken name gets the next free one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.locator("#empty-examples").click();
  await choose(page, "arrays.c");
  await expectActive(page, "arrays.c");

  await showFiles(page);
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "New from example..." }).click();
  await choose(page, "arrays.c");
  await expectActive(page, "arrays-2.c");

  await page.keyboard.press("F1");
  await expect(page.locator("dialog#palette")).toHaveAttribute("data-state", "ready");
  await page.keyboard.type("example");
  await expect(page.locator("#palette-list [role=option][aria-selected=true]")).toHaveAttribute("data-command", "examples");
  await page.keyboard.press("Enter");
  await choose(page, "arrays.c");
  await expectActive(page, "arrays-3.c");
  await expect(treeItem(page, "arrays.c")).toHaveCount(1);
  await expect(treeItem(page, "arrays-2.c")).toHaveCount(1);
});

for (const example of EXAMPLES.filter((e) => e.lang === "python")) {
  test(`${example.name} runs to exit code 0`, async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await page.locator("#empty-examples").click();
    await choose(page, example.name);
    await expectActive(page, example.name);
    const r = await run(page, { input: [...example.input], timeout: 90_000 });
    expect(r.status, r.output).toBe("ok");
  });
}

test("every C and C++ example compiles and runs to exit code 0", async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const compiled = EXAMPLES.filter((e) => e.lang !== "python");
  for (const [i, example] of compiled.entries()) {
    if (i === 0) await page.locator("#empty-examples").click();
    else {
      await page.keyboard.press(`${MOD}+Shift+P`);
      await expect(page.locator("dialog#palette")).toHaveAttribute("data-state", "ready");
      await page.keyboard.type("new from example");
      await page.keyboard.press("Enter");
    }
    await choose(page, example.name);
    await expectActive(page, example.name);
    if (i === 0) await installCpp(page);
    const r = await run(page, { input: [...example.input], timeout: 120_000 });
    expect(r.status, `${example.name}: ${r.output}`).toBe("ok");
  }
});
