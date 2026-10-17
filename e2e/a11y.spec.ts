// Accessibility beyond axe (from the design review of 2026-10-17): what
// is really painted (text, placeholders, icons and field borders against their actual background),
// the reading order in gray and blur shots, reflow at 320 px and 200% zoom, the keyboard-only path
// with every focus stop visible, reduced motion, and every palette theme. It checks with expect.soft,
// so one run shows every problem; screenshots go to SHOTS_DIR/a11y, the measurements to the test's
// own output folder. (Pointer target sizes are axe's target-size rule, run on every view here.)
import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, importFiles, openFromTree, reloadApp, showView, test, waitReady } from "./helpers";
import { openConnect, routeGitHub } from "./sync-fake";
import { audit, focusStop, type Audit, type FocusStop } from "./audit";

test.use({ serviceWorkers: "block" });

const OUT = `${process.env.SHOTS_DIR ?? "e2e/shots"}/a11y`;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const FILES = [
  { name: "main.py", text: 'from calc import ratio\nname = input("Name: ")\nprint("Hello,", name)\nprint(ratio(1, 0))\n' },
  { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n" },
];

function dirFor(info: TestInfo, sub: string) {
  // Measurements are evidence for this run only; screenshots go where the design shots live.
  const dir = sub === "data" ? info.outputPath("data") : `${OUT}/${sub}/${info.project.name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** DESIGN-REFERENCE 6T: load, emulate, reload, then prove the theme is really active. */
async function openThemed(page: Page, scheme: "light" | "dark", reducedMotion: "reduce" | "no-preference" = "no-preference") {
  await page.goto("/");
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(reducedMotion === "reduce");
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === "dark" ? "rgb(14, 18, 23)" : "rgb(253, 253, 255)");
}

/**
 * Gray and blur shots. A modal <dialog> and its ::backdrop sit in the top layer, which a filter on
 * <html> does not reach (measured: the stage-2 Connect "gray" shot is still in colour), so the open
 * dialog gets the same filter.
 */
async function shots(page: Page, dir: string, name: string, hierarchy = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${dir}/${name}.png`, animations: "disabled" });
  if (!hierarchy) return;
  for (const [kind, filter] of [["gray", "grayscale(1)"], ["blur", "blur(6px)"]] as const) {
    const css = `html{filter:${filter}} dialog[open]{filter:${filter}} dialog[open]::backdrop{backdrop-filter:${filter}}`;
    const tag = await page.addStyleTag({ content: css });
    await page.screenshot({ path: `${dir}/${name}-${kind}.png`, animations: "disabled" });
    await tag.evaluate((el) => (el as Element).remove());
  }
}

/** Waits for running transitions (finite ones: the editor's cursor blink never ends). */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)), // a cancelled one rejects
    ).then(() => undefined),
  );

interface ViewRecord {
  view: string;
  axe: string[];
  audit: Audit;
}

async function record(page: Page, dir: string, view: string, records: ViewRecord[], hierarchy = true) {
  await settled(page);
  await shots(page, dir, view, hierarchy);
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const axe = result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`);
  const a = await audit(page);
  records.push({ view, axe, audit: a });
  expect.soft(axe, `axe ${view}`).toEqual([]);
  expect.soft(a.overflow.scrollWidth <= a.overflow.clientWidth, `horizontal scroll in ${view}: ${a.overflow.wide.join(" | ")}`).toBe(true);
}

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

for (const vp of viewports) {
  for (const scheme of ["light", "dark"] as const) {
    test(`key views ${vp.name} ${scheme}: shots, gray and blur, axe, painted contrast, targets`, async ({ page }, info) => {
      test.setTimeout(240_000);
      const dir = dirFor(info, "shots");
      const records: ViewRecord[] = [];
      const gh = await routeGitHub(page);
      await page.setViewportSize(vp);
      await openThemed(page, scheme);
      const narrow = vp.width < 900;

      // 1. Empty workspace (reading order 4).
      await expect(page.locator('[data-empty="workspace"]')).toBeVisible();
      await record(page, dir, `empty-${vp.name}-${scheme}`, records);

      // 2. Editing (no result yet).
      await importFiles(page, FILES);
      await openFromTree(page, "main.py");
      if (narrow) await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
      await showView(page, "code");
      if ((await page.locator(".notice").getAttribute("data-empty")) === "false") await page.locator(".notice [aria-label='Dismiss notice']").click();
      await record(page, dir, `editing-${vp.name}-${scheme}`, records);

      // 3. Waiting for input (reading order 2): the prompt and the focused field lead.
      await page.locator("#run-button").click();
      await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
      await expect(page.locator("#live-input-field")).toBeFocused();
      await record(page, dir, `waiting-${vp.name}-${scheme}`, records);
      await page.locator("#live-input-field").fill("Ada");
      await page.locator("#live-input-field").press("Enter");
      await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      await record(page, dir, `ran-output-${vp.name}-${scheme}`, records);

      // 4. Editing with an error (reading order 1): the marked line, Run, then the result. The file
      // that ran marks the call that led to the error (line 4), with the cursor there; the module
      // where it was raised is flagged in the tree (icon plus description, not colour alone).
      const marked = (kind: string) =>
        page.locator(`.cm-lint-marker-${kind}, .cm-lintRange-${kind}`).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
      await showView(page, "code");
      expect.soft(await marked("info"), "main.py marks the call that led to the error").toBe(true);
      await expect.soft(page.locator("#status-pos")).toHaveText(/^Ln 4,/);
      if (!narrow) await expect.soft(page.locator('.tree [role=treeitem][data-path="calc.py"] [data-errors]')).toBeVisible();
      await record(page, dir, `error-code-${vp.name}-${scheme}`, records);
      await openFromTree(page, "calc.py");
      if (narrow) await expect(page.locator(".drawer-toggle")).toHaveAttribute("aria-expanded", "false");
      await showView(page, "code");
      expect.soft(await marked("error"), "calc.py marks the line that raised").toBe(true);
      await expect.soft(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-errors", "true");
      await record(page, dir, `error-calc-${vp.name}-${scheme}`, records);

      // 5. Problems.
      await showView(page, "output");
      await page.locator("#ptab-problems").click();
      await expect(page.locator(".problem").first()).toBeVisible();
      await record(page, dir, `problems-${vp.name}-${scheme}`, records);

      // 6. The Input box opened (its placeholder is the browser's own colour).
      await page.locator("#ptab-output").click();
      await page.locator(".stdin summary").click();
      await expect(page.locator("#stdin")).toBeVisible();
      await record(page, dir, `input-box-${vp.name}-${scheme}`, records, false);
      await page.locator(".stdin summary").click();

      // 7. Settings.
      await page.locator("#settings-button").click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await record(page, dir, `settings-${vp.name}-${scheme}`, records);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();

      // 8. Connect GitHub (reading order 3).
      await showView(page, "code");
      const dialog = await openConnect(page);
      await expect(dialog).toBeVisible();
      await record(page, dir, `connect-${vp.name}-${scheme}`, records);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(gh.seen, "no GitHub request without Connect").toEqual([]);

      const data = dirFor(info, "data");
      writeFileSync(`${data}/views-${vp.name}-${scheme}.json`, JSON.stringify(records, null, 1));
      const low = records.flatMap((r) => r.audit.pairs.filter((p) => p.ratio < p.min).map((p) => `${r.view}: ${p.kind} ${p.sel} "${p.text}" ${p.fg} on ${p.bg} ${p.ratio} < ${p.min}`));
      expect.soft(low, "painted pairs under their minimum").toEqual([]);
    });
  }
}

/** 320 px (400% of 1280) and 200% zoom of a 1440x900 window (720x450 CSS px at 2x). */
for (const size of [
  { name: "320", width: 320, height: 640, scale: 1 },
  { name: "zoom200", width: 720, height: 450, scale: 2 },
]) {
  test.describe(`reflow ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale });
    test(`reflow ${size.name}: every view fits, nothing important is cut off`, async ({ page }, info) => {
      test.setTimeout(180_000);
      const dir = dirFor(info, "reflow");
      const records: ViewRecord[] = [];
      await routeGitHub(page);
      await openThemed(page, "light");
      await record(page, dir, `empty-${size.name}`, records, false);
      await importFiles(page, FILES);
      await openFromTree(page, "main.py");
      await showView(page, "code");
      await record(page, dir, `editing-${size.name}`, records, false);
      await expect(page.locator("#run-button")).toBeInViewport();
      await page.locator("#run-button").click();
      await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
      await expect(page.locator("#live-input-field")).toBeInViewport();
      await record(page, dir, `waiting-${size.name}`, records, false);
      await page.locator("#live-input-field").fill("Ada");
      await page.locator("#live-input-field").press("Enter");
      await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
      await page.locator("#receipt").scrollIntoViewIfNeeded();
      await record(page, dir, `ran-${size.name}`, records, false);
      await page.locator("#ptab-problems").click();
      await expect(page.locator(".problem").first()).toBeVisible();
      await record(page, dir, `problems-${size.name}`, records, false);
      await page.locator("#settings-button").click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await record(page, dir, `settings-${size.name}`, records, false);
      // The last control can be reached by scrolling the dialog.
      await page.locator("#sign-out-clear").scrollIntoViewIfNeeded();
      await expect(page.locator("#sign-out-clear")).toBeInViewport();
      await page.screenshot({ path: `${dir}/settings-end-${size.name}.png` });
      await page.keyboard.press("Escape");
      await showView(page, "code");
      const dialog = await openConnect(page);
      await record(page, dir, `connect-${size.name}`, records, false);
      await expect(page.locator("#connect-submit")).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
      await page.keyboard.press("Escape");
      writeFileSync(`${dirFor(info, "data")}/reflow-${size.name}.json`, JSON.stringify(records, null, 1));
      // Nothing that matters is cut short here: the Problems message wraps, the sync status and
      // the status bar fit (WCAG 1.4.10).
      const cut = records.flatMap((r) => r.audit.truncated.filter((t) => /problem-message|sync-words|status-item/.test(t.sel)).map((t) => `${r.view}: ${t.sel} "${t.text}" ${t.shown}/${t.full}`));
      expect.soft(cut, "text cut off at this width").toEqual([]);
      const low = records.flatMap((r) => r.audit.pairs.filter((p) => p.ratio < p.min).map((p) => `${r.view}: ${p.kind} ${p.sel} "${p.text}" ${p.fg} on ${p.bg} ${p.ratio} < ${p.min}`));
      expect.soft(low, "painted pairs under their minimum").toEqual([]);
    });
  });
}

/** Presses Tab `n` times, recording every stop. */
async function tabPath(page: Page, n: number, key = "Tab") {
  const stops: FocusStop[] = [];
  for (let i = 0; i < n; i++) {
    // Tab inside the editor indents (by design); its documented way out is Esc then Tab.
    if (stops.at(-1)?.cls.includes("cm-content")) await page.keyboard.press("Escape");
    await page.keyboard.press(key);
    stops.push(await focusStop(page));
  }
  return stops;
}

const label = (s: FocusStop) => `${s.tag}${s.id ? `#${s.id}` : ""}${s.role ? `[${s.role}]` : ""} "${s.name}"`;

test("keyboard only: Tab path, tree, editor escape, tabs, panels, dialogs, menus; focus always visible", async ({ page }, info) => {
  test.setTimeout(180_000);
  const dir = dirFor(info, "keyboard");
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeGitHub(page);
  await openThemed(page, "light");
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await openFromTree(page, "calc.py");
  await reloadApp(page); // no notice, two tabs restored
  const log: Record<string, unknown> = {};
  const data = dirFor(info, "data");
  const save = () => writeFileSync(`${data}/keyboard.json`, JSON.stringify(log, null, 1));
  log.editorName = await page.locator(".cm-content").evaluate((el) => ({
    label: el.getAttribute("aria-label"),
    describedby: el.getAttribute("aria-describedby"),
    description: (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" | "),
  }));
  // WCAG 2.1.2: Tab indents in the editor, so the way out is part of its description.
  expect.soft((log.editorName as { description: string }).description, "the editor says how to leave it").toMatch(/Escape and then Tab/);

  // 1. The whole Tab order from the top of the page.
  await page.locator("body").focus();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const forward = await tabPath(page, 40);
  log.forward = forward.map((s) => ({ ...s, label: label(s) }));
  save();
  for (const [i, s] of forward.entries()) {
    if (s.tag === "body") continue;
    await page.screenshot({ path: `${dir}/tab-${String(i + 1).padStart(2, "0")}.png`, clip: { x: Math.max(0, s.rect.x - 12), y: Math.max(0, s.rect.y - 12), width: Math.min(1440, s.rect.w + 24) || 24, height: Math.min(900, s.rect.h + 24) || 24 } }).catch(() => undefined);
  }
  const invisible = forward.filter((s) => s.tag !== "body" && (!s.visible || !s.inViewport)).map(label);
  expect.soft(invisible, "focus stops that can't be seen").toEqual([]);
  const noRing = forward.filter((s) => s.tag !== "body" && s.visible && !s.indicator).map(label);
  expect.soft(noRing, "focus stops without an indicator").toEqual([]);
  const lowRing = forward.filter((s) => s.ringContrast !== null && s.ringContrast < 3).map((s) => `${label(s)} ${s.ringContrast}`);
  expect.soft(lowRing, "focus rings under 3:1").toEqual([]);

  // 2. Tree: Ctrl+Shift+E, arrows, Enter opens into the editor.
  await page.keyboard.press("Control+Shift+E");
  let stop = await focusStop(page);
  expect.soft(stop.role, "Ctrl+Shift+E focuses the tree").toBe("treeitem");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  const second = await focusStop(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  stop = await focusStop(page);
  log.tree = { afterArrow: label(second), afterEnter: label(stop) };
  expect.soft(stop.cls, "Enter on a file moves into the editor").toContain("cm-content");
  await page.screenshot({ path: `${dir}/editor-focused.png` });

  // 3. Editor: Tab indents; Esc then Tab leaves (and leaves the text alone).
  const textBefore = await page.locator(".cm-content").innerText();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  stop = await focusStop(page);
  log.escTab = label(stop);
  expect.soft(stop.cls, "Esc then Tab leaves the editor").not.toContain("cm-content");
  expect.soft(await page.locator(".cm-content").innerText(), "no tab was typed").toBe(textBefore);
  await page.screenshot({ path: `${dir}/after-esc-tab.png` });
  await page.keyboard.press("Shift+Tab");
  const back = await focusStop(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Tab");
  const before = await focusStop(page);
  log.escShiftTab = { back: label(back), beforeEditor: label(before) };
  save();

  // 4. Editor tabs: arrows activate, Enter goes into the editor.
  await page.locator('.tabs [role=tab][aria-selected="true"]').focus();
  const firstTab = await page.locator('.tabs [role=tab][aria-selected="true"]').getAttribute("title");
  await page.keyboard.press("ArrowRight");
  await expect.soft(page.locator('.tabs [role=tab][aria-selected="true"]'), "ArrowRight moves to the next file").not.toHaveAttribute("title", firstTab ?? "");
  const nextTab = await page.locator('.tabs [role=tab][aria-selected="true"]').getAttribute("title");
  stop = await focusStop(page);
  expect.soft(stop.role).toBe("tab");
  await page.screenshot({ path: `${dir}/tab-focused.png` });
  await page.keyboard.press("Enter");
  expect.soft((await focusStop(page)).cls).toContain("cm-content");
  log.tabs = { firstTab, nextTab };

  // 5. Run from the keyboard; the input field takes focus; then the output and Problems.
  await page.keyboard.press("Control+Home");
  await page.locator('.tabs [role=tab][title="main.py"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.tabs [role=tab][title="main.py"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content")).toContainText("from calc import ratio");
  save();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  expect.soft((await focusStop(page)).id, "the waiting program's field has focus").toBe("live-input-field");
  await page.keyboard.type("Ada");
  await page.keyboard.press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  const afterRun = await focusStop(page);
  log.afterRun = afterRun;
  await page.screenshot({ path: `${dir}/after-run.png` });
  await page.keyboard.press("Control+`");
  stop = await focusStop(page);
  expect.soft(stop.id, "Ctrl+` focuses the output").toBe("console");
  log.output = stop;
  await page.locator("#ptab-output").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#ptab-problems")).toHaveAttribute("aria-selected", "true");
  // Restart Python, Clear, Maximise the panel, the Problems panel, then the first problem.
  const panelPath = await tabPath(page, 5);
  log.problemsPath = panelPath.map(label);
  const problem = panelPath.find((s) => s.cls.includes("problem"));
  expect.soft(problem, "Tab reaches a problem").toBeTruthy();
  if (problem) {
    await page.locator("button.problem").first().focus();
    await page.keyboard.press("Enter");
    stop = await focusStop(page);
    log.problemEnter = label(stop);
    expect.soft(stop.cls, "Enter on a problem goes to the code").toContain("cm-content");
    await page.screenshot({ path: `${dir}/problem-jump.png` });
  }

  // 6. Dialogs: focus moves in, stays in, every stop visible, Escape returns focus.
  const dialogs: Record<string, unknown> = {};
  for (const [name, opener, open] of [
    ["settings", "#settings-button", "Enter"],
    ["connect", "#sync-status", "Enter"],
    ["shortcuts", "#settings-button", "?"],
  ] as const) {
    await page.locator(opener).focus();
    await page.keyboard.press(open);
    const box = page.locator("dialog[open]");
    await expect(box).toBeVisible();
    const first = await focusStop(page);
    const stops = await tabPath(page, 30);
    dialogs[name] = { first: label(first), stops: stops.map((s) => ({ ...s, label: label(s) })) };
    // "body" is the browser's own UI between the last and first control of a modal dialog (Chromium).
    expect.soft([first, ...stops].filter((s) => !s.inDialog && s.tag !== "body").map(label), `${name}: focus left the modal dialog`).toEqual([]);
    expect.soft(stops.filter((s) => s.tag !== "body" && (!s.visible || !s.indicator)).map(label), `${name}: stops without a visible indicator`).toEqual([]);
    await page.screenshot({ path: `${dir}/dialog-${name}.png` });
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    stop = await focusStop(page);
    expect.soft(`#${stop.id}`, `${name}: focus returns to its opener`).toBe(name === "shortcuts" ? "#settings-button" : opener);
  }
  log.dialogs = dialogs;

  // 7. Menus: the file actions menu button.
  await page.locator("#file-actions").focus();
  await page.keyboard.press("ArrowDown");
  stop = await focusStop(page);
  expect.soft(stop.role, "the menu opens on its first item").toBe("menuitem");
  await page.keyboard.press("ArrowDown");
  await page.screenshot({ path: `${dir}/menu.png` });
  log.menu = label(await focusStop(page));
  await page.keyboard.press("Escape");
  expect.soft((await focusStop(page)).id, "Escape returns to the menu button").toBe("file-actions");

  save();
});

test("reduced motion: no transition on the drawer, no running animations; and with motion allowed there is one", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const motion of ["no-preference", "reduce"] as const) {
    await openThemed(page, "light", motion);
    const drawerDuration = await page.locator("#sidebar").evaluate((el) => getComputedStyle(el).transitionDuration);
    await page.locator(".drawer-toggle").click();
    await expect(page.locator(".workbench")).toHaveAttribute("data-drawer", "open");
    const running = await page.evaluate(() => document.getAnimations().map((a) => `${a.constructor.name} ${(a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? ""}`));
    if (motion === "reduce") {
      expect.soft(drawerDuration.split(",").every((d) => parseFloat(d) === 0), `drawer transition ${drawerDuration}`).toBe(true);
      expect.soft(running, "animations under reduced motion").toEqual([]);
    } else {
      expect.soft(drawerDuration, "the drawer slides when motion is allowed").not.toBe("0s");
    }
    await page.keyboard.press("Escape");
  }
});

/** Every palette theme from the picker, painted over the error state: does the guard cover what the UI draws? */
test("palette themes: painted contrast in the error state", async ({ page }, info) => {
  test.skip(info.project.name !== "chromium", "colour maths is the same in every engine");
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openThemed(page, "light");
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  await openFromTree(page, "calc.py");
  await expect(page.locator(".cm-lint-marker-error, .cm-lintRange-error").first()).toBeVisible({ timeout: 15_000 });
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const more = settings.locator(".theme-more");
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator("summary").click();
  const names = await settings.locator(".theme-option[data-theme-option]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.themeOption ?? ""));
  await page.keyboard.press("Escape");
  const results: Record<string, { low: string[]; axe: string[] }> = {};
  const dir = dirFor(info, "themes");
  for (const name of names) {
    await page.locator("#settings-button").click();
    if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator("summary").click();
    await settings.locator(`.theme-option[data-theme-option="${name}"] input[type=radio]`).check();
    // Colours change with a 140 ms transition: measure the settled state, not a frame half-way.
    await settled(page);
    const settingsAudit = await audit(page);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await settled(page);
    const a = await audit(page);
    const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
    const low = [...a.pairs, ...settingsAudit.pairs.map((p) => ({ ...p, sel: `settings: ${p.sel}` }))]
      .filter((p) => p.ratio < p.min)
      .map((p) => `${p.kind} ${p.sel} "${p.text}" ${p.fg} on ${p.bg} ${p.ratio} < ${p.min}`);
    results[name] = { low, axe };
    await page.screenshot({ path: `${dir}/${name.replace(/[^\w]+/g, "-")}.png` });
  }
  writeFileSync(`${dirFor(info, "data")}/themes.json`, JSON.stringify(results, null, 1));
  const failing = Object.entries(results).filter(([, r]) => r.low.length || r.axe.length).map(([n, r]) => `${n}: ${[...r.low, ...r.axe].slice(0, 6).join(" | ")}`);
  expect.soft(failing, "palette themes with painted pairs under their minimum").toEqual([]);
});
