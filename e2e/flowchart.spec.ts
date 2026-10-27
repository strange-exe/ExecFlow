// The Flowchart view (milestone 3; spec .claude/tasks/flowchart.md, brief flowchart-m3.md): the tab
// beside Output and Problems and the fourth phone view, the chart for C, C++ and Python files drawn
// by the real worker and grammars in the built app, the function picker, zoom and fit, click to the
// code and cursor to the box, the keyboard path and the text alternative, full screen, every state,
// and the failure paths with a Retry that recovers. The service worker is blocked so every request
// reaches the routes below.
import type { Page, Route } from "@playwright/test";
import { afterFetch, expect, importFiles, isNarrow, openApp, openFromTree, setCode, test, tolerating } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const C_PROGRAM = [
  "#include <stdio.h>",
  "int square(int x) {",
  "    return x * x;",
  "}",
  "int main(void) {",
  "    int n = 3;",
  "    for (int i = 0; i < n; i++) {",
  '        printf("%d", square(i));',
  "    }",
  "    return 0;",
  "}",
  "",
].join("\n");

const CPP_PROGRAM = ["#include <iostream>", "using namespace std;", "int main() {", "    int n;", "    cin >> n;", "    if (n > 0) cout << n;", "    return 0;", "}", ""].join("\n");

const PY_PROGRAM = ["def twice(x):", "    return 2 * x", "", "n = int(input())", "while n > 0:", "    print(twice(n))", "    n -= 1", ""].join("\n");

const view = (page: Page) => page.locator("#panel-flowchart .fc-view");
const stage = (page: Page) => page.locator(".fc-stage");
const boxes = (page: Page) => page.locator(".fc-stage [role=listitem][data-node]");
const box = (page: Page, name: string | RegExp) => page.locator(".fc-stage [role=listitem]", { has: page.locator("title", { hasText: name }) });

/**
 * Clicks a box. The stage is scrolled to it first: Playwright's Firefox can't scroll an SVG <g> into
 * view inside a scrolling box ("element is outside of the viewport", every time, 2026-10-26).
 */
async function clickBox(page: Page, name: string) {
  const target = box(page, name);
  await target.evaluate((g) => {
    const stageEl = g.closest(".fc-stage")!;
    const r = g.getBoundingClientRect();
    const s = stageEl.getBoundingClientRect();
    stageEl.scrollTop += r.top + r.height / 2 - (s.top + s.height / 2);
    stageEl.scrollLeft += r.left + r.width / 2 - (s.left + s.width / 2);
  });
  const r = await target.boundingBox();
  await page.mouse.click(r!.x + r!.width / 2, r!.y + r!.height / 2);
}

async function openChart(page: Page) {
  await page.locator(isNarrow(page) ? "#view-flowchart" : "#ptab-flowchart").click();
}

async function ready(page: Page) {
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

/** Imports one file, opens it and shows its flowchart. */
async function chartFor(page: Page, name: string, text: string) {
  await openApp(page);
  await importFiles(page, [{ name, text }]);
  await openFromTree(page, name);
  await openChart(page);
}

const flowchartRequests = (page: Page) => {
  const seen: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/flowchart/")) seen.push(path.split("/").pop()!);
  });
  return seen;
};

test.describe("the Flowchart tab", () => {
  test("nothing of the flowchart loads before the tab is opened; then the runtime and the C grammar do", async ({ page }) => {
    const seen = flowchartRequests(page);
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: C_PROGRAM }]);
    await openFromTree(page, "main.c");
    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
    await openChart(page);
    await ready(page);
    expect(seen.sort()).toEqual(["tree-sitter-c.wasm", "web-tree-sitter.wasm"]);
  });

  for (const [lang, name, text, expected] of [
    ["C", "main.c", C_PROGRAM, ["Start, line 5", "int n = 3, line 6", "int i = 0, line 7", "Decision: i < n ?, line 7", 'Call to square: printf("%d", square(i)), line 8', "i++, line 7", "End: return 0, line 10"]],
    ["C++", "main.cpp", CPP_PROGRAM, ["Start, line 3", "int n, line 4", "Input or output: cin >> n, line 5", "Decision: n > 0 ?, line 6", "Input or output: cout << n, line 6", "End: return 0, line 7"]],
    ["Python", "main.py", PY_PROGRAM, ["Start, line 1", "Input or output: n = int(input()), line 4", "Decision: n > 0 ?, line 5", "Call to twice: print(twice(n)), line 6", "n -= 1, line 7", "End, line 7"]],
  ] as const) {
    test(`charts a ${lang} program with the real grammar`, async ({ page }) => {
      await chartFor(page, name, text);
      await ready(page);
      const names = await boxes(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      expect(names).toEqual([...expected]);
      // The chart is SVG drawn with DOM calls: no foreign content.
      expect(await page.locator(".fc-stage svg foreignObject, .fc-stage svg script").count()).toBe(0);
    });
  }

  test("tab keys: Output, Problems and Flowchart in one tablist (arrows, Home, End); phones get a fourth view", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    if (isNarrow(page)) {
      await expect(page.locator(".view-switch [role=tab]")).toHaveText(["Code", "Output", "Problems", "Flowchart"]);
      await expect(page.locator("#view-flowchart")).toHaveAttribute("aria-selected", "true");
      return;
    }
    await expect(page.locator(".panel-tabs [role=tab]")).toHaveText(["Output", "Problems", "Flowchart"]);
    const tab = page.locator("#ptab-flowchart");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#ptab-output")).toBeFocused();
    await page.keyboard.press("End");
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#ptab-problems")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.locator("#ptab-output")).toHaveAttribute("aria-selected", "true");
  });

  test("the chart follows the open file; the picker lists the file's functions, entry point first", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: C_PROGRAM }, { name: "util.py", text: PY_PROGRAM }]);
    await openFromTree(page, "main.c");
    await openChart(page);
    await ready(page);
    const picker = page.locator("#fc-picker");
    await expect(picker.locator("option")).toHaveText(["main", "square"]);
    await picker.selectOption({ label: "square" });
    await expect(boxes(page)).toHaveCount(2);
    await expect(boxes(page).nth(1)).toHaveAttribute("aria-label", "End: return x * x, line 3");
    // Another file: its chart, its functions.
    if (isNarrow(page)) await page.locator("#view-code").click();
    await openFromTree(page, "util.py");
    if (isNarrow(page)) await openChart(page);
    await ready(page);
    await expect(picker.locator("option")).toHaveText(["Program", "twice"]);
    await expect(box(page, "Decision: n > 0 ?")).toHaveCount(1);
  });

  test("functions that share a name (C++ overloads) can each be picked, and stay picked through an edit", async ({ page }) => {
    const src = ["int f(int x) { return x; }", "int f(int x, int y) {", "    if (x) return y;", "    return x;", "}", "int main() { return f(1) + f(1, 2); }", ""].join("\n");
    await chartFor(page, "over.cpp", src);
    await ready(page);
    const picker = page.locator("#fc-picker");
    await expect(picker.locator("option")).toHaveText(["main", "f", "f"]);
    // The second f: Start, its test, and two returns (the first f is Start and one return).
    await picker.selectOption({ index: 2 });
    await expect(boxes(page)).toHaveCount(4);
    await expect(box(page, "Decision: x ?")).toHaveCount(1);
    await expect(picker).toHaveValue("2");
    if (isNarrow(page)) return;
    // An edit elsewhere redraws the same function, not the first one with its name.
    await page.locator(".cm-line", { hasText: "int main()" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await page.waitForTimeout(800);
    await ready(page);
    await expect(boxes(page)).toHaveCount(4);
    await expect(picker).toHaveValue("2");
  });

  test("other languages and an empty file say so", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "notes.txt", text: "hello\n" }, { name: "empty.c", text: "" }]);
    await openFromTree(page, "notes.txt");
    await openChart(page);
    await expect(view(page)).toHaveAttribute("data-state", "other");
    await expect(view(page)).toContainText("Flowcharts are for C, C++ and Python files.");
    if (isNarrow(page)) await page.locator("#view-code").click();
    await openFromTree(page, "empty.c");
    if (isNarrow(page)) await openChart(page);
    await expect(view(page)).toHaveAttribute("data-state", "empty");
    await expect(view(page)).toContainText("This file is empty");
  });

  test("redraws 300 ms after typing stops", async ({ page }) => {
    test.skip(isNarrow(page), "on phones the code and the chart are separate views");
    await chartFor(page, "main.py", "x = 1\n");
    await ready(page);
    await expect(boxes(page)).toHaveCount(3);
    await setCode(page, "x = 1\nif x:\n    print(x)\n");
    await expect(box(page, "Decision: x ?")).toHaveCount(1);
  });
});

test.describe("chart and code", () => {
  test("a click on a box selects its lines in the editor and puts the caret there", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    await clickBox(page, "Decision: i < n ?");
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("    for (int i = 0; i < n; i++) {");
  });

  test("moving the caret in the editor outlines its box", async ({ page }) => {
    test.skip(isNarrow(page), "on phones the code and the chart are separate views");
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    await page.locator(".cm-line").nth(9).click(); // line 10: return 0
    await expect(page.locator(".fc-stage [data-current=true]")).toHaveAttribute("aria-label", "End: return 0, line 10");
    await page.locator(".cm-line").nth(5).click(); // line 6
    await expect(page.locator(".fc-stage [data-current=true]")).toHaveAttribute("aria-label", "int n = 3, line 6");
    // The caret moving never takes the focus from the code.
    await expect(page.locator(".cm-content")).toBeFocused();
  });

  test("keyboard: one Tab stop, arrows in reading order, Home and End; Enter goes to the code", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    const first = boxes(page).first();
    await first.focus();
    await expect(boxes(page).locator("xpath=self::*[@tabindex='0']")).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(box(page, "int n = 3")).toBeFocused();
    await page.keyboard.press("End");
    await expect(box(page, "End: return 0")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // Browsing keeps the focus in the chart.
    await expect(box(page, "int i = 0")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("    for (int i = 0; i < n; i++) {");
  });

  test("the steps as text: an outline in reading order, never the chart alone", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    const toggle = page.locator("#fc-steps-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const items = page.locator(".fc-steps li");
    await expect(items).toHaveCount(7);
    await expect(items.nth(3)).toHaveText("4. Decision: i < n ? Yes: step 5. No: step 7.");
  });

  test("zoom in, zoom out and fit; Ctrl+wheel zooms, a plain wheel scrolls", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    const width = () => page.locator(".fc-stage svg").evaluate((el) => el.getBoundingClientRect().width);
    const fitted = await width();
    await page.locator("#fc-zoom-in").click();
    expect(await width()).toBeGreaterThan(fitted * 1.2);
    await page.locator("#fc-zoom-out").click();
    await page.locator("#fc-zoom-out").click();
    expect(await width()).toBeLessThan(fitted);
    await page.locator("#fc-fit").click();
    expect(Math.abs((await width()) - fitted)).toBeLessThan(1);
    const s = await stage(page).boundingBox();
    await page.mouse.move(s!.x + s!.width / 2, s!.y + s!.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await expect.poll(width).toBeGreaterThan(fitted * 1.05);
  });

  test("full screen: a modal view of the same chart; Escape and the same button close it; focus returns", async ({ page }) => {
    await chartFor(page, "main.c", C_PROGRAM);
    await ready(page);
    const full = page.locator("#fc-full");
    await full.click();
    const dialog = page.locator("dialog#fc-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".fc-stage [role=listitem]")).toHaveCount(7);
    const size = await dialog.boundingBox();
    const vp = page.viewportSize()!;
    expect(size!.width).toBeGreaterThan(vp.width - 2);
    expect(size!.height).toBeGreaterThan(vp.height - 2);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(full).toBeFocused();
    await full.click();
    await expect(dialog).toBeVisible();
    await page.locator("#fc-full").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#fc-full")).toBeFocused();
    await expect(view(page).locator(".fc-stage [role=listitem]")).toHaveCount(7);
  });
});

test.describe("states", () => {
  test("a syntax mistake: the chart for what parses, a banner and a link to the line", async ({ page }) => {
    await chartFor(page, "main.c", "int main(void) {\n    int x = 1;\n    if (x > 0 {\n        x = 2;\n    }\n    return x;\n}\n");
    await ready(page);
    const banner = page.locator(".fc-banner");
    await expect(banner).toContainText("Line 3 has a mistake, so this part of the chart may be incomplete");
    await banner.getByRole("button", { name: "Go to line 3" }).click();
    await expect(page.locator(".cm-content")).toBeFocused();
    await expect(page.locator("#status-pos")).toContainText("Ln 3");
  });

  test("too big: more than 400 steps", async ({ page }) => {
    const body = Array.from({ length: 450 }, (_, i) => `    if (x == ${i}) x++;`).join("\n");
    await chartFor(page, "big.c", `int main(void) {\n    int x = 0;\n${body}\n    return x;\n}\n`);
    await expect(view(page)).toHaveAttribute("data-state", "too-big", { timeout: 30_000 });
    await expect(view(page)).toContainText("This function has more than 400 steps; open a smaller function");
  });

  test("loading: a skeleton, and words after 400 ms", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/flowchart/*/tree-sitter-python.wasm", async (route: Route) => {
      await held;
      await route.continue();
    });
    await chartFor(page, "main.py", PY_PROGRAM);
    await expect(view(page)).toHaveAttribute("data-state", "loading");
    await expect(page.locator(".fc-skeleton")).toBeVisible();
    await expect(view(page)).toContainText("Loading the Python flowchart tools...");
    release();
    await ready(page);
  });

  test.describe("failure paths", () => {
    test.use(tolerating(/^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/flowchart\//, /^Failed to load resource: the server responded with a status of 404/));

    for (const file of ["web-tree-sitter.wasm", "tree-sitter-c.wasm"]) {
      test(`${file} missing: an error, and Retry fetches it again and draws the chart`, async ({ page }) => {
        let fail = true;
        let requests = 0;
        await page.route(`**/flowchart/*/${file}`, (route) => {
          requests++;
          return fail ? route.fulfill({ status: 404, body: "missing" }) : route.continue();
        });
        await chartFor(page, "main.c", C_PROGRAM);
        await expect(view(page)).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
        await expect(view(page)).toContainText("Couldn't load the C flowchart tools.");
        fail = false;
        await page.locator("#fc-retry").click();
        await ready(page);
        expect(requests).toBeGreaterThanOrEqual(2);
      });
    }

    test("the worker takes longer than 2 s: it is stopped, and Retry starts a new one", async ({ page }) => {
      // The flowchart worker's script is swapped for one that starts a parse and never ends it.
      let hang = true;
      await page.route(
        "**/assets/w/*.js",
        afterFetch(async (route) => {
          const res = await route.fetch();
          const body = await res.text();
          if (hang && body.includes("web-tree-sitter")) {
            return route.fulfill({
              response: res,
              body: "self.onmessage = (e) => { self.postMessage({ type: 'parsing', id: e.data.id }); for (;;) {} };",
            });
          }
          return route.fulfill({ response: res, body });
        }),
      );
      await chartFor(page, "main.c", C_PROGRAM);
      await expect(view(page)).toHaveAttribute("data-state", "timeout", { timeout: 30_000 });
      await expect(view(page)).toContainText("The flowchart took too long to draw.");
      hang = false;
      await page.locator("#fc-retry").click();
      await ready(page);
    });
  });
});

test.describe("attacks", () => {
  test("labels with markup and direction characters stay text", async ({ page }) => {
    const rlo = String.fromCodePoint(0x202e);
    // Import refuses direction characters (core/safety.ts), so they arrive as typed (or pasted) text.
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: "int main(void) {}\n" }]);
    await openFromTree(page, "main.c");
    // Typed as one insertion (the editor draws the direction character as a placeholder, so the
    // shown text can't be compared as setCode does).
    await page.locator(".cm-content").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(`#include <stdio.h>\nint main(void) {\n    printf("</text><script>alert(1)</script>");\n    printf("<img src=x onerror=alert(1)>");\n    printf("${rlo}abc");\n    return 0;\n}\n`);
    await expect(page.locator(".cm-content")).toContainText("onerror");
    await openChart(page);
    await ready(page);
    await expect(page.locator(".fc-stage script, .fc-stage img, .fc-stage foreignObject")).toHaveCount(0);
    await expect(box(page, "<img src=x onerror=alert(1)>")).toHaveCount(1);
    await expect(box(page, "[U+202E]abc")).toHaveCount(1);
    const raw = await page.locator(".fc-stage").evaluate((el) => el.textContent!.includes(String.fromCodePoint(0x202e)));
    expect(raw).toBe(false);
  });

  test("a huge file while typing: too big, and the editor keeps up", async ({ page }) => {
    test.skip(isNarrow(page), "on phones the code and the chart are separate views");
    const lines = Array.from({ length: 9000 }, (_, i) => `x${i} = ${i}`).join("\n");
    await chartFor(page, "big.py", `${lines}\n`);
    await expect(view(page)).toHaveAttribute("data-state", "too-big", { timeout: 30_000 });
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    const t = Date.now();
    await page.keyboard.type("yyyyyyyyyy", { delay: 30 });
    await expect(page.locator(".cm-line", { hasText: "yyyyyyyyyy" })).toHaveCount(1);
    expect(Date.now() - t, "ten keys and the redraws they start").toBeLessThan(5000);
    // Each redraw after typing stops is the worker's: the page stays usable and the state holds.
    await page.waitForTimeout(800);
    await expect(view(page)).toHaveAttribute("data-state", "too-big");
  });

  test("a ladder of 395 breaks and continues: too big, and the page never stops answering while it is worked out", async ({ page }) => {
    // The attack pass's worst case (milestone 5): laid out on the page, it held the main thread 5.5 s.
    const ladder = Array.from({ length: 395 }, (_, i) => `        ${i ? "else " : ""}if (x == ${i}) ${i % 2 ? "continue" : "break"};`).join("\n");
    await openApp(page);
    await importFiles(page, [{ name: "ladder.c", text: `int main(void) {\n    int x = 99;\n    do {\n${ladder}\n    } while (x--);\n    return 0;\n}\n` }]);
    await openFromTree(page, "ladder.c");
    // The longest gap between 20 ms ticks on the page, from opening the chart until it settles.
    await page.evaluate(() => {
      const w = window as unknown as { maxGap: number };
      w.maxGap = 0;
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        w.maxGap = Math.max(w.maxGap, now - last);
        last = now;
      }, 20);
    });
    await openChart(page);
    await expect(view(page)).toHaveAttribute("data-state", "too-big", { timeout: 30_000 });
    await expect(view(page)).toContainText("This function has too many break and continue lines to draw; open a smaller function");
    const gap = await page.evaluate(() => (window as unknown as { maxGap: number }).maxGap);
    expect(gap, "the page's longest pause while the chart was worked out (ms)").toBeLessThan(400);
  });

  test("rapid file switching: the last file's chart wins", async ({ page }) => {
    test.skip(isNarrow(page), "the drawer covers the chart on phones");
    await openApp(page);
    const big = `int main(void) {\n${Array.from({ length: 300 }, (_, i) => `    if (x == ${i}) x++;`).join("\n")}\n}\n`;
    await importFiles(page, [{ name: "a.c", text: big }, { name: "b.py", text: PY_PROGRAM }, { name: "c.cpp", text: CPP_PROGRAM }]);
    await openFromTree(page, "a.c");
    await openChart(page);
    for (const name of ["b.py", "a.c", "c.cpp", "a.c", "b.py"]) await openFromTree(page, name);
    await ready(page);
    await expect(page.locator("#fc-picker option")).toHaveText(["Program", "twice"]);
    await expect(box(page, "Decision: n > 0 ?")).toHaveCount(1);
  });
});
