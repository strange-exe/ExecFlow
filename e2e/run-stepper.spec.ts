// The step-through (Workbench stage 3, option A's mock: .claude/design/editor9/a): after a Python run
// the run strip's stepper says "step NN / NN" between Previous and Next, a tick bar shows where the
// step is, the variables row shows the step's `name = value` pairs, the code's gutter counts each
// line's runs so far ("x7") with the step's line marked by a pink bar, and the chart marks the step's
// box (a thicker pink outline) and the connectors taken so far. Left, Right, Home and End step while
// the stepper has the focus (the code keeps its own arrows). An edit drops the steps; C and C++ get
// one quiet sentence. Variable values are the program's text: shown only as text.
// Every wait is on a state attribute (#run-steps data-state / data-step), never on wording.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, setCode, showChart, test } from "./helpers";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
test.setTimeout(150_000);

const SUM_EVENS = "total = 0\nfor n in range(1, 7):\n    if n % 2 == 0:\n        total += n\nprint(total)\n";
const TIMES = String.fromCodePoint(0xd7);
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const steps = (page: Page) => page.locator("#run-steps");
const view = (page: Page) => page.locator(".fc-view").first();
const vars = (page: Page) => page.locator("#run-vars .run-var");

/** The gutter's counts, top to bottom (lines that ran so far; not the hidden spacer that holds its width). */
const gutterCounts = (page: Page) =>
  page
    .locator(".ce-run-counts .cm-gutterElement")
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility !== "hidden").map((e) => (e.textContent ?? "").trim()).filter(Boolean));

async function openPy(page: Page, name: string, text: string) {
  await openApp(page);
  await importFiles(page, [{ name, text }]);
  await openFromTree(page, name);
  await showChart(page);
  await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

async function runToSteps(page: Page) {
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  await expect(steps(page)).toHaveAttribute("data-state", "steps", { timeout: 30_000 });
  return r;
}

test.describe("run stepper", () => {
  test("a Python run: the stepper sits at the end; keys and buttons step the code, the chart and the variables", async ({ page }) => {
    await openPy(page, "sum_evens.py", SUM_EVENS);
    // Before a run: one quiet sentence, no stepper.
    await expect(steps(page)).toHaveAttribute("data-state", "words");
    await expect(page.locator("#run-steps .run-stepper")).toBeHidden();
    // The counts' column is held from the start in a Python file: their arrival moves no code.
    const codeX = async () => (await page.locator(".cm-content").boundingBox())!.x;
    const before = await codeX();
    await runToSteps(page);
    expect(await codeX()).toBe(before);

    // The end of the run: 20 steps (Start and 19 events), the whole run's counts.
    await expect(steps(page)).toHaveAttribute("data-total", "20");
    await expect(steps(page)).toHaveAttribute("data-step", "19");
    await expect(page.locator("#step-count")).toHaveText("step 19 / 19");
    expect(await gutterCounts(page)).toEqual([`${TIMES}1`, `${TIMES}7`, `${TIMES}6`, `${TIMES}3`, `${TIMES}1`]);
    await expect(vars(page)).toHaveText(["total = 12", "n = 6"]);
    await expect(page.locator("#step-next")).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#step-prev")).toHaveAttribute("aria-disabled", "false");
    await expect(view(page)).toHaveAttribute("data-step", "19");
    await expect(page.locator('.fc-node[data-now="true"]')).toHaveCount(1);
    await expect(page.locator('.fc-node[data-now="true"]')).toHaveAttribute("data-kind", "end");
    // Ticks: one per step after Start, all taken, the last the current one.
    await expect(page.locator(".step-ticks > i")).toHaveCount(19);
    await expect(page.locator('.step-ticks > i[data-tick="cur"]')).toHaveCount(1);
    // Each tick is a visible 4 px bar at the strip's end (an empty tick's content is 0 wide: a flex
    // basis alone squeezed them to 1 px), and the stepper isn't Settings' boxed font-size stepper.
    const tickWidths = await page.locator(".step-ticks > i").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(Math.min(...tickWidths)).toBeGreaterThanOrEqual(3.5);
    expect(await page.locator("#run-steps .run-stepper").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

    // Home: Start. Nothing has run, nothing is counted or taken.
    await page.locator("#step-next").focus();
    await page.keyboard.press("Home");
    await expect(steps(page)).toHaveAttribute("data-step", "0");
    await expect(page.locator("#step-count")).toHaveText("step 00 / 19");
    expect(await gutterCounts(page)).toEqual([]);
    await expect(page.locator(".cm-line.ce-run-now")).toHaveCount(0);
    await expect(page.locator("#run-vars .run-vars-note")).toBeVisible();
    await expect(vars(page)).toHaveCount(0);
    await expect(page.locator('.fc-node[data-now="true"]')).toHaveAttribute("data-kind", "start");
    await expect(page.locator(".fc-stage [data-edge][data-taken]")).toHaveCount(0);
    await expect(page.locator("#step-prev")).toHaveAttribute("aria-disabled", "true");

    // Three steps on: line 3 (the test) is about to run with n = 1, total = 0.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(steps(page)).toHaveAttribute("data-step", "3");
    await expect(page.locator(".cm-line.ce-run-now")).toHaveCount(1);
    await expect(page.locator(".cm-line.ce-run-now")).toHaveText("    if n % 2 == 0:");
    expect(await gutterCounts(page)).toEqual([`${TIMES}1`, `${TIMES}1`, `${TIMES}1`]);
    // n took its value at this step: its item says so (the dot's words, for screen readers).
    await expect(vars(page)).toHaveText(["total = 0", "n = 1, changed"]);
    await expect(page.locator('.fc-node[data-now="true"]')).toHaveAttribute("data-kind", "decision");
    expect(await page.locator(".fc-stage g[data-edge][data-taken]").count()).toBeGreaterThanOrEqual(3);
    // The marks: a bar on the code line (a shape), a thicker pink outline on the box.
    const bar = await page.locator(".cm-line.ce-run-now").evaluate((el) => getComputedStyle(el).boxShadow);
    expect(bar).not.toBe("none");
    const outline = () =>
      page.locator('.fc-node[data-now="true"] > polygon').first().evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--focus)";
        document.body.append(probe);
        const focus = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(el);
        return { pink: s.stroke === focus, width: s.strokeWidth };
      });
    // The outline grows with the spring (220 ms): its resting width.
    await expect.poll(outline).toEqual({ pink: true, width: "2.5px" });
    // Only that box: the ones before it are plain again.
    const thick = await page.locator(".fc-node > :is(rect, polygon, circle):not(.fc-ring)").evaluateAll((els) => els.filter((e) => (e as SVGElement).style.strokeWidth === "2.5px").length);
    expect(thick).toBe(1);

    // The buttons step too; End goes back to the end. Focus stays on the stepper.
    await page.locator("#step-prev").click();
    await expect(steps(page)).toHaveAttribute("data-step", "2");
    // (Safari doesn't focus a clicked button: the keys need the focus on the stepper.)
    await page.locator("#step-prev").focus();
    await page.keyboard.press("End");
    await expect(steps(page)).toHaveAttribute("data-step", "19");
    await expect(page.locator("#step-prev")).toBeFocused();
    // The live region says where the keys stopped (politely, once).
    await expect(page.locator("#step-said")).toHaveAttribute("role", "status");
    await expect(page.locator("#step-said")).toHaveText("Step 19 of 19, the call returned.");

    // The code keeps its own arrows: they move the caret, never the step.
    await page.locator(".cm-content").click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Home");
    await expect(steps(page)).toHaveAttribute("data-step", "19");

    // Accessible: no axe violations with the stepper and the variables on screen.
    const axe = (await new AxeBuilder({ page }).include("#run-steps").include("#run-vars").withTags(AXE_TAGS).analyze()).violations;
    expect(axe.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    // Targets: the keys are at least 24 px.
    for (const id of ["#step-prev", "#step-next"]) {
      const box = (await page.locator(id).boundingBox())!;
      expect(Math.min(box.width, box.height), id).toBeGreaterThanOrEqual(24);
    }
  });

  test("an edit drops the steps and the code's counts; the next run brings them back", async ({ page }) => {
    await openPy(page, "sum_evens.py", SUM_EVENS);
    await runToSteps(page);
    expect((await gutterCounts(page)).length).toBe(5);
    await setCode(page, SUM_EVENS.replace("7", "5"));
    await expect(steps(page)).not.toHaveAttribute("data-state", "steps");
    expect(await gutterCounts(page)).toEqual([]);
    await expect(page.locator(".cm-line.ce-run-now")).toHaveCount(0);
    await expect(page.locator("#run-vars")).toBeHidden();
    await expect(view(page)).not.toHaveAttribute("data-step", /.*/);
    await expect(page.locator('.fc-view[data-step] .fc-node[data-now="true"]')).toHaveCount(0);
    await runToSteps(page);
    // range(1, 5): 1 + 5 + 4 + 2 + 1 line events, then the return.
    await expect(steps(page)).toHaveAttribute("data-total", "15");
    expect(await gutterCounts(page)).toEqual([`${TIMES}1`, `${TIMES}5`, `${TIMES}4`, `${TIMES}2`, `${TIMES}1`]);
  });

  test("a value that looks like HTML shows as text: no element, no dialog", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const payload = "<img src=x onerror=alert(1)>";
    await openPy(page, "xss.py", `x = "${payload}"\ny = "</li><b>bold</b>"\nprint(len(x))\n`);
    await runToSteps(page);
    await expect(vars(page)).toHaveText([`x = '${payload}'`, "y = '</li><b>bold</b>'"]);
    await expect(page.locator("#run-vars img, #run-vars b, #run-steps img")).toHaveCount(0);
    await expect(page.locator("#run-vars .run-var-value").first()).toHaveText(`'${payload}'`);
    await expect(page.locator("#run-vars .run-var").first()).toHaveAttribute("title", `x = '${payload}'`);
    expect(await page.locator("img[src='x']").count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test("a long run: a proportional bar, and the values say where their recording stopped", async ({ page }) => {
    await openPy(page, "long.py", "t = 0\nfor i in range(6000):\n    t += i\nprint(t)\n");
    await runToSteps(page);
    await expect(page.locator(".step-ticks .step-track")).toHaveCount(1);
    await expect(page.locator(".step-ticks > i")).toHaveCount(0);
    // At the end the values had stopped (VALUE_STEPS): the row says after which step, and lists none.
    await expect(page.locator("#run-vars")).toHaveAttribute("data-known", "false");
    await expect(page.locator("#run-vars .run-vars-note")).toHaveText(/^Values stopped being recorded after step \d+\.$/);
    await expect(vars(page)).toHaveCount(0);
    const after = Number(/step (\d+)\./.exec((await page.locator("#run-vars .run-vars-note").textContent())!)![1]);
    // Home, then to the last step with values: they show again.
    await page.locator("#step-prev").focus();
    await page.keyboard.press("Home");
    await expect(steps(page)).toHaveAttribute("data-step", "0");
    await expect(page.locator("#run-vars")).toHaveAttribute("data-known", "true");
    expect(after).toBeGreaterThan(9000);
  });

  test("C and C++ files: no stepper, one quiet sentence", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [
      { name: "loop.c", text: "#include <stdio.h>\nint main(void) {\n    for (int i = 0; i < 3; i++) printf(\"%d\\n\", i);\n    return 0;\n}\n" },
      { name: "loop.cpp", text: "#include <iostream>\nint main() {\n    for (int i = 0; i < 3; i++) std::cout << i;\n    return 0;\n}\n" },
    ]);
    for (const name of ["loop.c", "loop.cpp"]) {
      await openFromTree(page, name);
      await showChart(page);
      await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await expect(steps(page)).toHaveAttribute("data-state", "words");
      await expect(page.locator("#run-steps .run-steps-words")).toHaveText("Step-through is for Python for now.");
      await expect(page.locator("#run-steps .run-stepper")).toBeHidden();
      await expect(page.locator("#run-vars")).toBeHidden();
      // No step-through, so no column held for its counts.
      await expect(page.locator(".ce-run-counts")).toHaveCount(0);
    }
  });

  test("a variable whose value changed at the step carries a changed mark: a dot and the word, never colour alone", async ({ page }) => {
    await openPy(page, "sum_evens.py", SUM_EVENS);
    await runToSteps(page);
    await page.locator("#step-next").focus();
    await page.keyboard.press("Home");
    const read = () =>
      page.locator("#run-vars .run-var").evaluateAll((els) =>
        els.map((li) => ({
          name: li.querySelector(".run-var-name")!.textContent!,
          value: li.querySelector(".run-var-value")!.textContent!,
          changed: li.getAttribute("data-changed") === "true",
          dot: (() => {
            const d = li.querySelector<HTMLElement>(".run-var-dot");
            const r = d?.getBoundingClientRect();
            return !!d && d.getAttribute("aria-hidden") === "true" && !!r && r.width >= 4 && r.height >= 4 && getComputedStyle(d).display !== "none";
          })(),
          said: li.querySelector(".visually-hidden")?.textContent ?? "",
        })),
      );
    let before = new Map<string, string>();
    let marked = 0;
    for (let k = 0; k < 20; k++) {
      await expect(steps(page)).toHaveAttribute("data-step", String(k));
      const now = await read();
      for (const v of now) {
        // Within one call (sum_evens has one), a name is changed when it is new or its text differs.
        const want = k > 0 && before.get(v.name) !== v.value;
        expect(v.changed, `step ${k}: ${v.name} = ${v.value}`).toBe(want);
        expect(v.dot, `step ${k}: ${v.name}'s dot`).toBe(want);
        expect(v.said, `step ${k}: ${v.name}'s words`).toBe(want ? ", changed" : "");
        if (want) marked++;
      }
      before = new Map(now.map((v) => [v.name, v.value]));
      await page.keyboard.press("ArrowRight");
    }
    expect(marked, "marks were drawn").toBeGreaterThan(5);
  });

  test("from 900 to 1099 px the stepper sits at the code card's foot, beside the language and the position", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await openPy(page, "sum_evens.py", SUM_EVENS);
    await runToSteps(page);
    const foot = page.locator(".editor-foot");
    await expect(foot.locator("#run-steps .run-stepper")).toBeVisible();
    await expect(page.locator("#run-vars")).toBeVisible();
    await expect(vars(page)).toHaveText(["total = 12", "n = 6"]);
    const [lang, pos, stepper, footBox] = await Promise.all(["#status-lang", "#status-pos", "#run-steps", ".editor-foot"].map(async (s) => (await page.locator(s).boundingBox())!));
    // One row: the stepper after the facts, never over them, inside the foot.
    expect(stepper.x).toBeGreaterThanOrEqual(Math.max(lang.x + lang.width, pos.x + pos.width));
    expect(stepper.x + stepper.width).toBeLessThanOrEqual(footBox.x + footBox.width + 1);
    expect(stepper.y).toBeGreaterThanOrEqual(footBox.y - 1);
    expect(stepper.y + stepper.height).toBeLessThanOrEqual(footBox.y + footBox.height + 1);
    // The keys step it.
    await page.locator("#step-prev").click();
    await expect(steps(page)).toHaveAttribute("data-step", "18");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("reduced motion: the ticks and keys change without moving", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPy(page, "sum_evens.py", SUM_EVENS);
    await runToSteps(page);
    const durations = await page.locator(".step-ticks > i").first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(durations.split(",").every((d) => d.trim() === "0s")).toBe(true);
  });
});

/** Screenshots of the stepper mid-run (step 7 of sum_evens), for the design review. */
const SHOTS = `${process.env.SHOTS_DIR ?? "e2e/shots"}/run-stepper`;
for (const [size, scheme] of [["1440", "light"], ["1440", "dark"], ["390", "dark"], ["390", "light"]] as const) {
  test(`screenshot: mid-run at ${size} px, ${scheme}`, async ({ page }, info) => {
    if (size === "390") await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "scheme applied").toBe(scheme === "dark");
    await importFiles(page, [{ name: "sum_evens.py", text: SUM_EVENS }]);
    await openFromTree(page, "sum_evens.py");
    if (size === "1440") {
      await showChart(page);
      await expect(view(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    }
    await runToSteps(page);
    await page.locator("#step-next").focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    await expect(steps(page)).toHaveAttribute("data-step", "7");
    await page.screenshot({ path: `${SHOTS}/${info.project.name}/mid-run-${size}-${scheme}.png`, animations: "disabled" });
  });
}

test.describe("run stepper on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false });

  test("the stepper is the run row under the variables, Run floating above both, with 44 px keys", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "sum_evens.py", text: SUM_EVENS }]);
    await openFromTree(page, "sum_evens.py");
    // Below 900 px the code wraps and every column costs code width: the counts' column takes none
    // until there are counts (from 900 px it is held, so their arrival moves no code).
    expect((await page.locator(".ce-run-counts").boundingBox())?.width ?? 0).toBe(0);
    // The chart never opened: the run loads it off screen for the steps.
    await runToSteps(page);
    expect((await page.locator(".ce-run-counts").boundingBox())!.width).toBeGreaterThan(10);
    await expect(steps(page)).toHaveAttribute("data-step", "19");
    expect(await gutterCounts(page)).toEqual([`${TIMES}1`, `${TIMES}7`, `${TIMES}6`, `${TIMES}3`, `${TIMES}1`]);
    await expect(page.locator("#panel .run-strip #run-steps")).toBeVisible();
    await expect(vars(page)).toHaveText(["total = 12", "n = 6"]);
    for (const id of ["#step-prev", "#step-next"]) {
      const box = (await page.locator(id).boundingBox())!;
      expect(Math.min(box.width, box.height), id).toBeGreaterThanOrEqual(44);
    }
    // Stage 4 (the phone mock): Run floats above the variables and the stepper (it was the strip's
    // last row, under them).
    const [stepBox, varsBox, runBox] = [(await steps(page).boundingBox())!, (await page.locator("#run-vars").boundingBox())!, (await page.locator("#run-button").boundingBox())!];
    expect(varsBox.y + varsBox.height).toBeLessThanOrEqual(stepBox.y + 1);
    expect(runBox.y + runBox.height).toBeLessThanOrEqual(varsBox.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#step-prev").tap();
    await expect(steps(page)).toHaveAttribute("data-step", "18");
  });
});
