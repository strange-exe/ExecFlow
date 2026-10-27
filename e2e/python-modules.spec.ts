// Python modules, packages and written files as a student meets them (from the functional review, 2026-10-17).
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, openInputBox, run, setCode, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(150_000);

const activeTitle = (page: Page) => page.locator('.tabs [role=tab][aria-selected="true"]');

test("a syntax error in an imported module is marked in that module, on its line", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "import helper\nprint(helper.f())\n" },
    { name: "helper.py", text: "x = 1\n\ndef f(:\n    return x\n" },
  ]);
  await openFromTree(page, "main.py");
  const r = await run(page, { timeout: 90_000 });
  expect(r.status).toBe("error");
  await page.locator("#ptab-problems").click();
  const rows = await page.locator(".problem").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-path")}:${e.getAttribute("data-line")}`));
  expect(rows, JSON.stringify(rows)).toContain("helper.py:3");
  await page.locator('.problem[data-path="helper.py"]').first().click();
  await expect(activeTitle(page)).toHaveAttribute("title", "helper.py");
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 3,/);
  await expect(page.locator(".cm-lint-marker-error")).toHaveCount(1);
});

test("a runtime error inside a package in a sub-folder is marked there; the run's frames lead to it", async ({ page }) => {
  await openApp(page);
  const create = async (path: string, text: string) => {
    await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
    await page.locator("#new-file").click();
    const field = page.getByRole("textbox", { name: /Name of the new file/ });
    await field.fill(path);
    await field.press("Enter");
    await expect(activeTitle(page)).toHaveAttribute("title", path);
    if (text) await setCode(page, text);
    await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  };
  await create("shapes/__init__.py", "");
  await create("shapes/area.py", "def square(side):\n    if side < 0:\n        raise ValueError('negative side')\n    return side * side\n");
  await create("main.py", "from shapes.area import square\nprint(square(3))\nprint(square(-1))\n");
  const r = await run(page, { timeout: 90_000 });
  expect(r.status).toBe("error");
  expect(r.output).toContain("9");
  await expect(page.locator("#console .err").first()).toContainText("ValueError");
  await page.locator("#ptab-problems").click();
  const rows = await page.locator(".problem").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-path")}:${e.getAttribute("data-line")}`));
  expect(rows, JSON.stringify(rows)).toContain("shapes/area.py:3");
});

test("pandas downloads on first import and the status line names it", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "pd.py", text: "import pandas as pd\nprint(pd.DataFrame({'a': [1, 2, 3]})['a'].sum())\n" }]);
  await openFromTree(page, "pd.py");
  const labels: string[] = [];
  await page.exposeFunction("notePhaseLabel", (p: string) => labels.push(p));
  await page.evaluate(() => {
    const el = document.getElementById("run-status")!;
    new MutationObserver(() => {
      const label = el.querySelector(".phase-label")?.textContent ?? "";
      (window as unknown as { notePhaseLabel(p: string): void }).notePhaseLabel(`${el.dataset.phase}|${label}`);
    }).observe(el, { attributes: true, childList: true, subtree: true });
  });
  const r = await run(page, { timeout: 140_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("6");
  const downloading = [...new Set(labels.filter((l) => l.startsWith("downloading|")))];
  test.info().annotations.push({ type: "phases", description: JSON.stringify(downloading) });
  expect(downloading.some((l) => /pandas/.test(l)), JSON.stringify(downloading)).toBe(true);
});

test("a file written in the program's own folder is saved with its folder, and a changed copy replaces it without a question", async ({ page }) => {
  await openApp(page);
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: /Name of the new file/ });
  await field.fill("proj/main.py");
  await field.press("Enter");
  await expect(activeTitle(page)).toHaveAttribute("title", "proj/main.py");
  await setCode(page, "import sys\nwith open('data.txt', 'w') as f:\n    f.write(sys.stdin.readline())\nprint('wrote')\n");
  // The Input box sits behind the panel bar's Input toggle.
  await openInputBox(page);
  await page.locator("#stdin").fill("first\n");
  const r1 = await run(page, { timeout: 90_000 });
  expect(r1.status, r1.output).toBe("ok");
  const saved = page.locator('#console [data-stream="note"]').filter({ hasText: "to your files" });
  await expect(saved).toContainText("Saved proj/data.txt to your files.");
  await expect(treeItem(page, "proj/data.txt")).toBeVisible();

  // Same program, same text: nothing new to save, so no line about it.
  await openFromTree(page, "proj/main.py");
  await run(page, { timeout: 60_000 });
  await expect(saved).toHaveCount(0);

  // Different text: saved over the old copy with no question, and the open copy follows.
  await openFromTree(page, "proj/data.txt");
  await openFromTree(page, "proj/main.py");
  // Re-reading the files after the write changes no row, so the tree keeps its rows: a redraw in
  // the middle of the next click would replace the row pressed and the click would open nothing.
  await treeItem(page, "proj/data.txt").evaluate((li) => (li.dataset.probe = "kept"));
  await page.locator("#stdin").fill("second\n");
  await run(page, { timeout: 60_000 });
  await expect(saved).toContainText("Saved proj/data.txt to your files.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(treeItem(page, "proj/data.txt"), "the same row node after the write").toHaveAttribute("data-probe", "kept");
  await openFromTree(page, "proj/data.txt");
  await expect(page.locator(".cm-content")).toContainText("second");
});
