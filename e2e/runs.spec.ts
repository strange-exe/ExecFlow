// Runs under the conditions a real user creates (from the functional review, 2026-10-17): a
// double-click on Run, Stop while waiting, output floods, files renamed or deleted mid-run, reloads.
// Each test waits on data-* state attributes (data-runs, data-run, data-phase, data-status).
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, reloadApp, run, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const runs = async (page: Page) => Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);

async function pythonReady(page: Page) {
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
}

/** Busy for about `s` seconds, printing before and after (time.sleep is not what is tested). */
const busy = (s: number) => `import time\nprint('start', flush=True)\nt = time.time()\nwhile time.time() - t < ${s}:\n    pass\nprint('end')\n`;

test("double-clicking Run starts the program once and lets it finish", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "slow.py", text: busy(3) }]);
  await openFromTree(page, "slow.py");
  await pythonReady(page);
  const before = await runs(page);
  await page.locator("#run-button").dblclick();
  await expect.poll(() => runs(page), { timeout: 30_000 }).toBeGreaterThan(before);
  // The program takes 3 s: give it, and any second racing run, time to report.
  await page.waitForTimeout(5000);
  const after = await runs(page);
  const status = await page.locator("#receipt").getAttribute("data-status");
  const text = (await page.locator("#console").textContent()) ?? "";
  const receipt = (await page.locator("#receipt").textContent()) ?? "";
  test.info().annotations.push({ type: "after double-click", description: `runs +${after - before}, status ${status}, receipt "${receipt}", console ${JSON.stringify(text)}` });
  expect({ finishedRuns: after - before, status, printedStart: text.includes("start"), printedEnd: text.includes("end") }).toEqual({
    finishedRuns: 1,
    status: "ok",
    printedStart: true,
    printedEnd: true,
  });
});

test("pressing Ctrl+Enter twice quickly runs once; the Run button shows Stop for as long as the program runs", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "slow.py", text: busy(3) }]);
  await openFromTree(page, "slow.py");
  await pythonReady(page);
  const before = await runs(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  // The program printed its first line, or a run already ended.
  await expect
    .poll(async () => ((await page.locator("#console").textContent()) ?? "").includes("start") || (await runs(page)) > before, { timeout: 30_000 })
    .toBe(true);
  // The program is still busy: the button must say Stop, not Run.
  const midRun = { running: await page.locator("#run-button").getAttribute("data-running"), finished: (await runs(page)) - before };
  await expect.poll(() => runs(page), { timeout: 30_000 }).toBeGreaterThan(before + midRun.finished);
  await page.waitForTimeout(1500);
  expect({ midRun, finishedRuns: (await runs(page)) - before, status: await page.locator("#receipt").getAttribute("data-status") }).toEqual({
    midRun: { running: "true", finished: 0 },
    finishedRuns: 1,
    status: "ok",
  });
});

test("Stop while the program waits for input ends it, and the next run reads fresh input", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "ask.py", text: "name = input('Name: ')\nprint('hello', name)\n" }]);
  await openFromTree(page, "ask.py");
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await expect(page.locator("#live-input-field")).toBeFocused();
  await page.keyboard.press("Control+.");
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
  await expect(page.locator("#live-input")).toBeHidden();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
  // Focus went somewhere useful, not to <body>.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  const again = await run(page, { input: ["ada"] });
  expect(again.status, again.output).toBe("ok");
  expect(again.output).toContain("hello ada");
});

test("Stop pressed with the Stop button while waiting for input, twice in a row", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "ask.py", text: "a = input('A: ')\nb = input('B: ')\nprint(a + b)\n" }]);
  await openFromTree(page, "ask.py");
  for (let i = 0; i < 2; i++) {
    const before = await runs(page);
    await page.locator("#run-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
    await page.locator("#run-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
  }
  const r = await run(page, { input: ["x", "y"] });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("xy");
});

test("a program that floods stdout is stopped at the output limit and the page stays usable", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "flood.py", text: "i = 0\nwhile True:\n    print('line', i)\n    i += 1\n" }]);
  await openFromTree(page, "flood.py");
  await pythonReady(page);
  const started = Date.now();
  const r = await run(page, { timeout: 60_000 });
  const ms = Date.now() - started;
  expect(r.status).toBe("output-limit");
  // 512 Ki characters is the default limit; the console holds about that much, not more.
  expect(r.output.length).toBeLessThan(600 * 1024);
  expect(r.output.length).toBeGreaterThan(400 * 1024);
  test.info().annotations.push({ type: "flood", description: `stdout flood to output-limit in ${ms} ms, ${r.output.length} chars shown` });
  // The page answers at once.
  const t0 = Date.now();
  await page.evaluate(() => 1);
  expect(Date.now() - t0).toBeLessThan(500);
  await page.locator("#clear-output").click();
  await expect(page.locator("#receipt")).toBeHidden();
});

test("a program that interleaves stdout and stderr in a flood is stopped within the time limit and the page stays usable", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "mixed.py", text: "import sys\ni = 0\nwhile True:\n    print('out', i)\n    print('err', i, file=sys.stderr)\n    i += 1\n" }]);
  await openFromTree(page, "mixed.py");
  await pythonReady(page);
  await page.locator("#run-button").click();
  // The default limits are 15 s of running and 512 Ki characters: one of them ends the run. Measured
  // 2026-10-17 in Chromium: the page's main thread was blocked for 210 s instead (console layout per
  // frame grows with the number of stdout/stderr spans: 0.5 s at 32 K, 1.3 s at 64 K, 5.1 s at 128 K).
  await expect(page.locator("#app"), "the run should end by the 15 s time limit or the output limit").toHaveAttribute("data-runs", "1", { timeout: 45_000 });
  expect(await page.locator("#receipt").getAttribute("data-status")).toMatch(/^(output-limit|timeout)$/);
  const t0 = Date.now();
  await page.locator("#ptab-problems").click();
  await expect(page.locator("#ptab-problems")).toHaveAttribute("aria-selected", "true");
  expect(Date.now() - t0, "switching panel tabs after the flood").toBeLessThan(2000);
});

test("a module renamed while its program runs: the error is listed under the file's new name", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "from calc import ratio\ninput('go? ')\nprint(ratio(1, 0))\n" },
    { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
  ]);
  await openFromTree(page, "main.py");
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  // Rename calc.py (closed) while the program waits.
  await treeItem(page, "calc.py").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for calc.py" });
  await field.fill("calc2.py");
  await field.press("Enter");
  await expect(treeItem(page, "calc2.py")).toBeVisible();
  await page.locator("#live-input-field").fill("y");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error");
  await page.locator("#ptab-problems").click();
  const listed = await page.locator(".problem[data-path]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  const tree = await page.locator(".tree [role=treeitem]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  // Every Problems row names a file that exists (clicking one must open something).
  expect(listed.filter((p) => !tree.includes(p)), `Problems rows ${JSON.stringify(listed)} vs files ${JSON.stringify(tree)}`).toEqual([]);
});

/** Runs main.py, which imports calc.py, and deletes calc.py while the program waits for input. */
async function deleteModuleMidRun(page: Page) {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "from calc import ratio\ninput('go? ')\nprint(ratio(1, 0))\n" },
    { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
  ]);
  await openFromTree(page, "main.py");
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await treeItem(page, "calc.py").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "calc.py")).toHaveCount(0);
  await page.locator("#live-input-field").fill("y");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error");
}

test("a module deleted while its program runs leaves no Problems row", async ({ page }) => {
  await deleteModuleMidRun(page);
  await page.locator("#ptab-problems").click();
  await expect(page.locator('.problem[data-path="calc.py"]'), "a Problems row for a deleted file").toHaveCount(0);
});

test("a module deleted while its program runs: a new file of that name starts without the old error", async ({ page }) => {
  await deleteModuleMidRun(page);
  // A new, empty calc.py is a different file: no error marker from the old one.
  await page.locator(".tree-host").click({ position: { x: 20, y: 300 } });
  await page.locator("#new-file").click();
  const name = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await name.fill("calc.py");
  await name.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "calc.py");
  await expect(page.locator(".cm-lint-marker-error"), "an old error marker on a new, empty file").toHaveCount(0);
});

test("reloading while a program runs: the page comes back idle and the next run works", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "loop.py", text: "while True:\n    pass\n" }, { name: "hi.py", text: "print('hi')\n" }]);
  await openFromTree(page, "loop.py");
  await page.locator("#run-button").click();
  await expect(page.locator("#run-status")).toHaveAttribute("data-phase", "running", { timeout: 60_000 });
  await reloadApp(page);
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
  await expect(page.locator("#run-button")).toHaveAttribute("data-running", "false");
  await openFromTree(page, "hi.py");
  const r = await run(page, { timeout: 60_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("hi");
});

test("reloading while a program waits for input keeps what was typed in the editor", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "ask.py", text: "x = input('x? ')\n" }]);
  await openFromTree(page, "ask.py");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("print(x)\n");
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await reloadApp(page);
  await expect(page.locator(".cm-content")).toContainText("print(x)");
  const r = await run(page, { input: ["7"], timeout: 60_000 });
  expect(r.output).toContain("7");
});
