import { expect, importFiles, openApp, openFromTree, run, setCode, showView, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

test("a program in two files reads live input and imports its helper", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: 'from helper import shout\nname = input("Name: ")\nprint(shout(name))\n' },
    { name: "helper.py", text: "def shout(s):\n    return s.upper() + '!'\n" },
  ]);
  await openFromTree(page, "main.py");
  const r = await run(page, { input: ["ada"] });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("Name: ada\nADA!");
  // The receipt: status word, exit code and time, as chips.
  await expect(page.locator('#receipt [data-status-chip="ok"]')).toBeVisible();
  // The result is announced (polite live region).
  await expect(page.locator("[data-announcer]")).toHaveText(/Finished: main\.py exited with code 0\./);
});

test("the live input field is labelled, focused while the program waits, and Ctrl+D ends input", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "lines.py", text: "import sys\nn = 0\nfor line in sys.stdin:\n    n += 1\nprint('lines:', n)\n" }]);
  await openFromTree(page, "lines.py");
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  const field = page.getByRole("textbox", { name: "Input for the program" });
  await expect(field).toBeFocused();
  await expect(page.locator("#run-status")).toHaveAttribute("data-phase", "waiting");
  await field.fill("one");
  await field.press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting");
  await field.press("Control+d");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
  await expect(page.locator("#console")).toContainText("lines: 1");
  await expect(page.locator("#console .echo.end")).toHaveText("(end of input)\n");
});

test("a traceback marks the right file and line, and Problems jumps there", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "from calc import ratio\nprint(ratio(1, 0))\n" },
    { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
  ]);
  await openFromTree(page, "main.py");
  const r = await run(page);
  expect(r.status).toBe("error");
  // stderr is marked by a bar, its last line (the exception) by colour and weight too, and the
  // run-log header names the exception and where it was raised (v1's "error output above" chip
  // said only that there was some).
  await expect(page.locator("#console .err").first()).toContainText("ZeroDivisionError");
  await expect(page.locator("#console .err-last")).toHaveText("ZeroDivisionError: division by zero");
  await expect(page.locator("#runlog")).toHaveAttribute("data-failed", "");
  await expect(page.locator("#run-exception")).toContainText("ZeroDivisionError: division by zero");
  await expect(page.locator("#run-exception")).toContainText("calc.py, line 2");
  await expect(page.locator("[data-announcer]")).toHaveText(/ZeroDivisionError in calc\.py, line 2/);

  // Problems: a button per diagnostic, with the severity word and path:line.
  await expect(page.locator("#ptab-problems .count")).not.toHaveText("");
  await page.locator("#ptab-problems").click();
  const problem = page.locator('.problem[data-path="calc.py"][data-line="2"]');
  await expect(problem).toContainText("Error");
  await expect(problem).toContainText("calc.py:2");
  await problem.click();
  await showView(page, "code");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "calc.py");
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 2,/);
  await expect(page.locator(".cm-lint-marker-error")).toHaveCount(1);
  await expect(treeItem(page, "calc.py")).toHaveAttribute("aria-current", "true");
});

test("a problem with keyboard focus keeps it when a later check updates the Problems list", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.py", text: "from calc import ratio\nprint(ratio(1, 0))\n" },
    { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
  ]);
  await openFromTree(page, "main.py");
  expect((await run(page)).status).toBe("error");
  await page.locator("#ptab-problems").click();
  const problem = page.locator('.problem[data-path="calc.py"][data-line="2"]');
  await problem.focus();
  await expect(problem).toBeFocused();
  // Every Problems update writes the tab's label, changed or not: the signal that one ran.
  await page.evaluate(() => {
    const tab = document.getElementById("ptab-problems")!;
    (window as unknown as { problemsUpdated: Promise<void> }).problemsUpdated = new Promise((resolve) =>
      new MutationObserver((_, observer) => {
        observer.disconnect();
        resolve();
      }).observe(tab, { attributeFilter: ["aria-label"] }),
    );
  });
  // A script click doesn't move focus. Once Python is ready again, the idle check of main.py runs
  // and its result updates the list (on a slow machine this landed in the middle of a Tab path).
  await page.evaluate(() => document.getElementById("restart-python")!.click());
  await page.evaluate(() => (window as unknown as { problemsUpdated: Promise<void> }).problemsUpdated);
  await expect(problem).toBeFocused();
});

test("numpy is downloaded on first import and the run says so", async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await importFiles(page, [{ name: "np.py", text: "import numpy as np\nprint(int(np.arange(5).sum()))\n" }]);
  await openFromTree(page, "np.py");
  const phases: string[] = [];
  await page.exposeFunction("notePhase", (p: string) => phases.push(p));
  await page.evaluate(() => {
    const el = document.getElementById("run-status")!;
    new MutationObserver(() => (window as unknown as { notePhase(p: string): void }).notePhase(el.dataset.phase ?? "")).observe(el, { attributes: true });
  });
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("10");
  expect(phases).toContain("downloading");
});

test("Stop ends a program that never finishes, and the time limit from Settings applies", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "loop.py", text: "while True:\n    pass\n" }]);
  await openFromTree(page, "loop.py");
  const runs = Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
  await page.locator("#run-button").click();
  await expect(page.locator("#run-button")).toHaveAttribute("data-running", "true", { timeout: 45_000 });
  await expect(page.locator("#run-button")).toHaveAccessibleName(/Stop/);
  await expect(page.locator("#run-status")).toHaveAttribute("data-phase", "running", { timeout: 45_000 });
  await page.keyboard.press("Control+.");
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(runs + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");

  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Time limit (seconds)").fill("2");
  await settings.getByLabel("Time limit (seconds)").press("Tab");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.locator("#settings-button")).toBeFocused();
  const r = await run(page, { timeout: 40_000 });
  expect(r.status).toBe("timeout");
  await expect(page.locator("[data-announcer]")).toHaveText(/2 second limit/);
});

test("Python checks syntax while you type, before any run", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "warm.py", text: "print('warm')\n" }]);
  await openFromTree(page, "warm.py");
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  await setCode(page, "def broken(:\n    pass\n");
  await expect(page.locator(".cm-lint-marker-error")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#ptab-problems .count")).toHaveText("1");
  await setCode(page, "def fixed():\n    pass\n");
  await expect(page.locator(".cm-lint-marker-error")).toHaveCount(0, { timeout: 10_000 });
});

test("Restart Python starts a clean interpreter", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "state.py", text: "import builtins\nprint(getattr(builtins, 'seen', 'fresh'))\nbuiltins.seen = 'kept'\n" }]);
  await openFromTree(page, "state.py");
  expect((await run(page)).output).toContain("fresh");
  expect((await run(page)).output).toContain("kept"); // the warm interpreter keeps changes to builtins
  await page.locator("#restart-python").click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  expect((await run(page)).output).toContain("fresh");
});

test("a file the program writes is offered, and added to the workspace on request", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "write.py", text: "with open('result.txt', 'w') as f:\n    f.write('42\\n')\nprint('done')\n" }]);
  await openFromTree(page, "write.py");
  const r = await run(page);
  expect(r.status, r.output).toBe("ok");
  const notice = page.locator(".notice");
  await expect(notice).toContainText("result.txt");
  await notice.getByRole("button", { name: "Add to workspace" }).click();
  await expect(treeItem(page, "result.txt")).toBeVisible();
});
