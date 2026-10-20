// Your own names in the suggestion list (Tier 1 of the autocomplete research, 2026-10-19): the
// open C file's functions, the names of a header it includes with quotes, a Python workspace
// module's members after `helpers.` (typing speed in a big workspace: speed.spec.ts).
import type { Page } from "@playwright/test";
import { expect, expectActive, importFiles, openApp, openFromTree, setCode, showView, test } from "./helpers";

test.use({ serviceWorkers: "block" });

const editor = (page: Page) => page.locator(".cm-editor");
const list = (page: Page) => page.getByRole("listbox", { name: "Suggestions" });
/** The option whose label is exactly `label`. */
const option = (page: Page, label: string) =>
  list(page).getByRole("option").filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label}$`) }) });
const picked = (page: Page) => list(page).locator('[role=option][aria-selected="true"]');
/** CodeMirror ignores the list's keys for 75 ms after it opens (autocomplete 6.20.3 interactionDelay). */
const pastInteractionDelay = (page: Page) => page.waitForTimeout(250);

/** The files the open file's suggestions need from the workspace are parsed (own-completion.ts ownNamesLoader). */
const namesReady = (page: Page) => expect(editor(page)).toHaveAttribute("data-index", "ready");

/** Picks `label` with the arrow keys (nothing is picked when the list opens) and returns its info text. */
async function infoOf(page: Page, label: string): Promise<string | null> {
  await pastInteractionDelay(page);
  const count = await list(page).getByRole("option").count();
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(picked(page)).toHaveCount(1);
    if ((await picked(page).locator(".cm-completionLabel").textContent()) === label) {
      const id = await picked(page).getAttribute("aria-describedby");
      return id ? page.locator(`#${id}`).textContent() : null;
    }
  }
  throw new Error(`${label} is not in the list`);
}

test("a function defined in the file is offered with its kind and declaration", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  await expectActive(page, "main.c");
  await showView(page, "code");
  await setCode(page, "#define LIMIT 10\nstruct point { int x; };\nint add_values(int a, int b) {\n    return a + b;\n}\n\nint main(void) {\n    return ");
  await page.keyboard.type("add");
  const add = option(page, "add_values");
  await expect(add).toBeVisible();
  await expect(add.locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-function/);
  await expect(add.locator(".cm-completionDetail")).toHaveText("int add_values(int a, int b)");
  expect(await infoOf(page, "add_values")).toBe("Function in main.c");
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  // A struct is offered as a type of its own kind.
  await page.keyboard.type(" + sizeof(struct po");
  await expect(option(page, "point").locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-class/);
});

const MAIN_C = '#include <stdio.h>\n#include "util.h"\n\nint main(void) {\n    int total = 0;\n    ';
const UTIL_H = '#ifndef UTIL_H\n#define UTIL_H\n#include "types.h"\nint helper(int x);\n#endif\n';
const TYPES_H = "typedef struct { int w, h; } box_t;\n";
const OTHER_H = "int unrelated_name(void);\n";

test("a function from a header included with quotes is offered; one from a header that isn't included is not", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: MAIN_C },
    { name: "util.h", text: UTIL_H },
    { name: "types.h", text: TYPES_H },
    { name: "other.h", text: OTHER_H },
  ]);
  await openFromTree(page, "main.c");
  await showView(page, "code");
  await setCode(page, MAIN_C);
  await namesReady(page);
  await page.keyboard.type("hel");
  const helper = option(page, "helper");
  await expect(helper).toBeVisible();
  await expect(helper.locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-function/);
  await expect(helper.locator(".cm-completionDetail")).toHaveText("int helper(int x)");
  expect(await infoOf(page, "helper")).toBe("Function in util.h");
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  // Through util.h's own quoted include: a typedef from types.h.
  await page.keyboard.type(" + sizeof(box");
  await expect(option(page, "box_t").locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-type/);
  await page.keyboard.press("Escape");
  // other.h isn't included: Ctrl+Space after "unrel" offers nothing of it.
  await page.keyboard.type(") + unrel");
  await page.keyboard.press("Control+Space");
  await expect(editor(page)).toHaveAttribute("data-completion", /^(closed|active)$/);
  await expect(option(page, "unrelated_name")).toHaveCount(0);
});

test("a header edited in its own tab is read again: its new function is offered, also once that tab is closed", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: MAIN_C },
    { name: "util.h", text: UTIL_H },
    { name: "types.h", text: TYPES_H },
  ]);
  // Open in a tab: the index reads the tab's text, typed or not.
  await openFromTree(page, "util.h");
  await showView(page, "code");
  await setCode(page, UTIL_H.replace("#endif", "int helper_two(void);\n#endif"));
  await openFromTree(page, "main.c");
  await showView(page, "code");
  await setCode(page, MAIN_C);
  await namesReady(page);
  await page.keyboard.type("helper_t");
  await expect(option(page, "helper_two")).toBeVisible();
  await page.keyboard.press("Escape");

  // Edited again and closed (which saves it): now the stored text is what counts.
  await openFromTree(page, "util.h");
  await showView(page, "code");
  await setCode(page, UTIL_H.replace("#endif", "int helper_three(void);\n#endif"));
  await page.keyboard.press("Alt+w");
  await expect(page.locator('.tabs [role=tab][title="util.h"]')).toHaveCount(0);
  await openFromTree(page, "main.c");
  await showView(page, "code");
  await setCode(page, MAIN_C);
  await namesReady(page);
  await page.keyboard.type("helper_th");
  await expect(option(page, "helper_three")).toBeVisible();
  await expect(option(page, "helper_two")).toHaveCount(0);
});

test("a header that is not open and changes in storage (an import replaces it) is read again", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: MAIN_C },
    { name: "util.h", text: UTIL_H },
    { name: "types.h", text: TYPES_H },
  ]);
  await openFromTree(page, "main.c");
  await showView(page, "code");
  await setCode(page, MAIN_C);
  await namesReady(page);
  await page.keyboard.type("helper");
  await expect(option(page, "helper")).toBeVisible();
  await page.keyboard.press("Escape");

  // The same name again, and Replace: storage changes under the index, util.h never opened.
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles([{ name: "util.h", mimeType: "text/plain", buffer: Buffer.from(UTIL_H.replace("#endif", "int helper_four(void);\n#endif")) }]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "success");
  await setCode(page, MAIN_C);
  await namesReady(page);
  await page.keyboard.type("helper_f");
  await expect(option(page, "helper_four")).toBeVisible();
});

test("helpers. lists a def from your helpers.py, with its kind", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "import helpers\n" },
    { name: "helpers.py", text: "def greet(name):\n    return f'Hi {name}'\n\nclass Point:\n    pass\n\nLIMIT = 3\n" },
  ]);
  await openFromTree(page, "main.py");
  await showView(page, "code");
  await setCode(page, "import helpers\n\n");
  await namesReady(page);
  await page.keyboard.type("helpers.");
  const greet = option(page, "greet");
  await expect(greet).toBeVisible();
  await expect(greet.locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-function/);
  await expect(greet.locator(".cm-completionDetail")).toHaveText("def greet(name)");
  await expect(option(page, "Point").locator(".cm-completionIcon")).toHaveClass(/cm-completionIcon-class/);
  await expect(option(page, "LIMIT")).toBeVisible();
  expect(await infoOf(page, "greet")).toBe("Function in helpers.py");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  await expect(page.locator(".cm-content .cm-line").nth(2)).toHaveText("helpers.greet");
});

// Typed straight away, without waiting for data-index: the first query comes before the index has
// read the file, and the list must catch up by itself once it has (late-data.ts). Before that fix
// "helpers." stayed empty and "hel" kept a list without helper until another key (review RB-1).
test("a module just imported is offered after helpers. once it has been read, with no further key", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "print('hi')\n" },
    { name: "helpers.py", text: "def greet(name):\n    return name\n" },
  ]);
  await openFromTree(page, "main.py");
  await showView(page, "code");
  await expect(editor(page)).toHaveAttribute("data-library", "ready");
  await setCode(page, "");
  await page.keyboard.type("import helpers", { delay: 80 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("helpers.", { delay: 80 });
  await expect(option(page, "greet")).toBeVisible();
});

test("a header just included is offered once it has been read, with no further key, and typing on keeps it", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: "int main(void) {\n    return 0;\n}\n" },
    { name: "util.h", text: "int helper(int x);\n" },
  ]);
  await openFromTree(page, "main.c");
  await showView(page, "code");
  await expect(editor(page)).toHaveAttribute("data-library", "ready");
  await setCode(page, '#include "util.h"\n');
  await page.keyboard.type("int x = hel", { delay: 50 });
  await expect(option(page, "helper")).toBeVisible();
  // Complete now: typing on refilters the list and keeps helper.
  await page.keyboard.type("p");
  await expect(option(page, "helper")).toBeVisible();
  await expect(editor(page)).toHaveAttribute("data-index", "ready");
});

// Typing responsiveness in a workspace of about 200 files: e2e/speed.spec.ts, its own project.
