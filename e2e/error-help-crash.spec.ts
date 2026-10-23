// Plain-language error help for a failing C program: the build error's, then a crash's (the rest of
// the help's tests are in error-help.spec.ts).
//
// The crash is a store far outside the program's memory, which V8 turns into a trap from the guard
// page's fault. Playwright's Linux headless shell doesn't hand that fault to V8: the tab crashed
// ("Received signal 11 SEGV_ACCERR" at the program's own address, CI and WSL 2026-10-23, 3 of 3),
// while the full Chromium build, which people run, traps it and passed 3 of 3. So in Chromium this
// file runs on the full build (new headless mode); Firefox and WebKit run as everywhere.
import type { Page } from "@playwright/test";
import { expect, importFiles, installCpp, openApp, openFromTree, run, setCode, showPanel, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.use({ channel: [async ({ browserName }, use) => use(browserName === "chromium" ? "chromium" : undefined), { scope: "worker" }] });

const runHelp = (page: Page) => page.locator("#runlog > #run-help");
/** The Problems row (its <li>) for a file and line. */
const problemRow = (page: Page, path: string, line: number) =>
  page.locator(".problems > li").filter({ has: page.locator(`button.problem[data-path="${path}"][data-line="${line}"]`) });

test("a failing C program: the build error's help, then a crash's help under its status", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await importFiles(page, [{ name: "sum.c", text: '#include <stdio.h>\nint main(void) {\n  int total = 5;\n  printf("%d\\n", totl);\n  return 0;\n}\n' }]);
  await openFromTree(page, "sum.c");
  await installCpp(page);
  expect((await run(page, { timeout: 150_000 })).status).toBe("build-failed");
  const help = runHelp(page);
  await expect(help).toHaveAttribute("data-help", "c-undeclared-suggest");
  await expect(help.locator(".err-help-means")).toHaveText("The compiler doesn't know a name totl here. It suggests total, a name it does know that is spelled alike.");
  await expect(page.locator("#run-exception")).toHaveAttribute("aria-describedby", "run-help-text");
  await showPanel(page, "problems");
  await expect(problemRow(page, "sum.c", 4).locator(".err-help")).toHaveAttribute("data-help", "c-undeclared-suggest");

  // A crash has no line to open, so the help sits under the header's status, and under the
  // "Whole program" row in Problems.
  await setCode(page, '#include <stdio.h>\nint main(void) {\n  int marks[5] = {0};\n  int i;\n  scanf("%d", &i);\n  marks[i] = 1;\n  printf("%d\\n", marks[0]);\n  return 0;\n}\n');
  await showPanel(page, "output");
  expect((await run(page, { timeout: 150_000, input: ["100000000"] })).status).toBe("crashed");
  await expect(page.locator("#run-exception")).toHaveCount(0);
  await expect(help).toHaveAttribute("data-help", "crash-memory");
  await expect(help.locator(".err-help-means")).toContainText("a segmentation fault, on most computers");
  await showPanel(page, "problems");
  await expect(page.locator(".problems > li").filter({ has: page.locator(".problem.static") }).locator(".err-help")).toHaveAttribute("data-help", "crash-memory");
});
