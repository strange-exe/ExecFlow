// Plain-language error help (src/core/error-help.ts, drawn by src/ui/error-help-view.ts): after a
// failed run it is the run-log header's last line, under the lifted error (or under a crash's
// status), and the exception button's description; in Problems it sits under the first row of each
// kind, as that row's description. Its table is a lazy chunk that a first visit never loads, and if
// it can't load the errors show as before. Every piece of it is text, never markup.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  expect, hierarchyShots, importFiles, openApp, openFromTree, openIn, responseBodies, run, setCode, showPanel, showView, test,
  tolerating, waitReady,
} from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const SHOTS = `${process.env.SHOTS_DIR ?? "e2e/shots"}/error-help`;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** A phrase of the help table, to find its chunk (the chunk's name is a hash). */
const TABLE_MARK = "a name it does know that is spelled alike";

const TYPO_PY = "total = 5\nprint(totl)\n";
const TYPO_MEANS = "Python doesn't know a name totl at this point. It suggests total, a name it does know that is spelled alike.";

const runHelp = (page: Page) => page.locator("#runlog > #run-help");
/** The Problems row (its <li>) for a file and line. */
const problemRow = (page: Page, path: string, line: number) =>
  page.locator(".problems > li").filter({ has: page.locator(`button.problem[data-path="${path}"][data-line="${line}"]`) });

test("a failing Python program: the help sits under the lifted error and under its Problems row", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "typo.py", text: TYPO_PY }]);
  await openFromTree(page, "typo.py");
  expect((await run(page)).status).toBe("error");

  // Output: the header's last line, a note named for what it is; the specifics from the message in code.
  const help = runHelp(page);
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute("data-help", "py-name-suggest");
  await expect(help).toHaveAttribute("role", "note");
  await expect(page.getByRole("note", { name: "What this error means" })).toBeVisible();
  await expect(help.locator(".err-help-means")).toHaveText(TYPO_MEANS);
  await expect(help.locator(".err-help-tips")).toHaveText(
    "Check the spelling and the capital letters. If totl is a new variable, give it a value on a line that runs before this one.",
  );
  await expect(help.locator("code")).toHaveText(["totl", "total", "totl"]);
  // Not colour alone: a lightbulb, and its own words, apart from the exception's red.
  await expect(help.locator("svg.err-help-icon")).toHaveAttribute("aria-hidden", "true");
  // The exception button carries it as its description, so focusing it reads the help.
  const exception = page.locator("#run-exception");
  await expect(exception).toHaveAttribute("aria-describedby", "run-help-text");
  await expect(exception).toHaveAccessibleDescription(/^Python doesn't know a name totl at this point\..*before this one\.$/);
  // It adds no tab stop: Tab from the exception leaves the header for the log (Firefox stops on the
  // log's scroller first, as it does for any scrollable box; the others on the log itself).
  await exception.focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toMatch(/^console(-scroll)?$/);

  // Problems: under the row, lined up with its words, and the row's description.
  await showPanel(page, "problems");
  const row = problemRow(page, "typo.py", 2);
  await expect(row.locator(".err-help")).toHaveAttribute("data-help", "py-name-suggest");
  await expect(row.locator(".err-help-means")).toHaveText(TYPO_MEANS);
  await expect(row.locator("button.problem")).toHaveAccessibleDescription(/^Python doesn't know a name totl at this point\..*before this one\.$/);
  const icon = await row.locator("button.problem .problem-severity").boundingBox();
  const text = await row.locator(".err-help-icon").boundingBox();
  expect(Math.abs(icon!.x - text!.x), "the help lines up with the severity word").toBeLessThanOrEqual(1);

  // Fixed and run again: the help goes with the error, in both places.
  await setCode(page, "total = 5\nprint(total)\n");
  expect((await run(page)).status).toBe("ok");
  await expect(page.locator(".err-help")).toHaveCount(0);
});

test("the idle check's problem gets its help before anything runs", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "check.py", text: 'print("ready")\n' }]);
  await openFromTree(page, "check.py");
  expect((await run(page)).status).toBe("ok"); // Python is ready, so the check runs on the next edit
  await setCode(page, 'x = 3\nif x > 1\n    print("big")\n');
  await showPanel(page, "problems");
  const row = problemRow(page, "check.py", 2);
  await expect(row.locator(".err-help")).toHaveAttribute("data-help", "py-colon", { timeout: 15_000 });
  await expect(row.locator(".err-help-means")).toHaveText(
    "Python expected a colon (:) here. A line that starts a block, such as if, elif, else, for, while, def or class, ends with a colon.",
  );
  await expect(page.locator("#runlog > .err-help")).toHaveCount(0); // the earlier run was fine
});

// The failing C program (a build error, then a crash) is in error-help-crash.spec.ts: in Chromium it
// needs the full build.

test("the help shows what the program wrote as text, cut short, never as markup", async ({ page }) => {
  await openApp(page);
  const key = `<img src=x onerror="window.__pwned=1">${"k".repeat(80)}`;
  await importFiles(page, [{ name: "keys.py", text: `d = {}\nprint(d[${JSON.stringify(key)}])\n` }]);
  await openFromTree(page, "keys.py");
  expect((await run(page)).status).toBe("error");
  const help = runHelp(page);
  await expect(help).toHaveAttribute("data-help", "py-key");
  // Cut at 48 characters with "...", the quote Python prints included.
  await expect(help.locator(".err-help-means code")).toHaveText(`${`'${key}`.slice(0, 45)}...`);
  await expect(page.locator(".err-help img, .err-help [onerror]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test.describe("the help's chunk", () => {
  // The 404 is the point of the second test; each engine reports it in its own words (as design.spec).
  test.use(
    tolerating(
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js (net::ERR_ABORTED|NS_ERROR_CORRUPTED_CONTENT|Load request cancelled)$/,
    ),
  );

  test("is not on a first visit, and arrives with the first run", async ({ page }) => {
    const bodies = responseBodies(page, (path) => /^\/assets\/[^/]+\.js$/.test(path), (path, b) => ({ url: path, table: b.includes(TABLE_MARK) }));
    await openApp(page);
    await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
    expect((await bodies.settled()).filter((c) => c.table).map((c) => c.url), "the help table on a first visit").toEqual([]);
    await importFiles(page, [{ name: "typo.py", text: TYPO_PY }]);
    await openFromTree(page, "typo.py");
    expect((await bodies.settled()).filter((c) => c.table), "the help table before a run or a problem").toHaveLength(0);
    expect((await run(page)).status).toBe("error");
    await expect(runHelp(page)).toBeVisible();
    expect((await bodies.settled()).filter((c) => c.table)).toHaveLength(1);
  });

  test("can't load: the error shows without help, and a later run brings it", async ({ page, browserName }) => {
    await openApp(page);
    await importFiles(page, [{ name: "typo.py", text: TYPO_PY }]);
    await openFromTree(page, "typo.py");
    let refused = 0;
    await page.route(/\/assets\/[\w-]+\.js$/, async (route) => {
      const response = await route.fetch();
      if ((await response.text()).includes(TABLE_MARK)) {
        refused++;
        return route.fulfill({ status: 404, body: "" });
      }
      return route.fulfill({ response });
    });
    expect((await run(page)).status).toBe("error");
    await expect(page.locator("#run-exception")).toContainText("NameError");
    await expect(page.locator("#run-exception")).not.toHaveAttribute("aria-describedby", /./);
    await showPanel(page, "problems");
    await expect(problemRow(page, "typo.py", 2).locator("button.problem")).toBeVisible();
    await expect(page.locator(".err-help")).toHaveCount(0);
    expect(refused).toBeGreaterThan(0);
    await page.unrouteAll({ behavior: "wait" });
    await showPanel(page, "output");
    expect((await run(page)).status).toBe("error");
    // Playwright's WebKit keeps a failed dynamic import() failed for the whole context (lessons.md
    // 2026-10-21; design.spec records the same for the Shortcuts list): there the error keeps
    // showing without help, and nothing hangs.
    if (browserName === "webkit") {
      await expect(page.locator(".err-help")).toHaveCount(0);
      test.info().annotations.push({ type: "webkit", description: "recovery not checked: a failed import stays failed in the context" });
      return;
    }
    await expect(runHelp(page)).toHaveAttribute("data-help", "py-name-suggest");
  });
});

/** The Level 2 look: the help in Output and in Problems, 1440 x 900 and 390 x 844, light and dark. */
for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`look ${vp.name} ${scheme}: the help in Output and Problems, axe clean, no sideways scroll`, async ({ page, browserName }) => {
      await page.setViewportSize(vp);
      await openIn(page, "/", scheme);
      await waitReady(page);
      await importFiles(page, [
        { name: "main.py", text: 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n' },
        { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
      ]);
      await openFromTree(page, "main.py");
      expect((await run(page, { input: ["Ada"] })).status).toBe("error");
      await showView(page, "output");
      await expect(runHelp(page)).toHaveAttribute("data-help", "py-zero-division");
      const shoot = async (view: string) => {
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect.soft(axe.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`), `axe ${view}`).toEqual([]);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect.soft(wide, `sideways scroll in ${view}`).toBe(false);
        const name = `${SHOTS}/${view}-${vp.name}-${scheme}-${browserName}`;
        await page.screenshot({ path: `${name}.png`, animations: "disabled" });
        await hierarchyShots(page, name);
      };
      // The help is on screen with the error it explains.
      await expect(runHelp(page)).toBeInViewport();
      await shoot("output");
      await showPanel(page, "problems");
      const row = problemRow(page, "calc.py", 2);
      await expect(row.locator(".err-help")).toHaveAttribute("data-help", "py-zero-division");
      // The call site in main.py (an info row) gets no help of its own.
      await expect(page.locator(".problems .err-help")).toHaveCount(1);
      await expect(row.locator(".err-help")).toBeInViewport();
      await shoot("problems");
    });
  }
}
