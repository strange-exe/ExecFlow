// Accessibility beyond axe (from the design review of 2026-10-17): what
// is really painted (text, placeholders, icons and field borders against their actual background),
// the reading order in gray and blur shots, reflow at 320 px and 200% zoom, the keyboard-only path
// with every focus stop visible, reduced motion, and every palette theme. It checks with expect.soft,
// so one run shows every problem; screenshots go to SHOTS_DIR/a11y, the measurements to the test's
// own output folder. (Pointer target sizes are axe's target-size rule, run on every view here.)
import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, importFiles, openFromTree, openInputBox, reloadApp, showPanel, showView, test, waitReady } from "./helpers";
import { openConnect, routeGitHub } from "./sync-fake";
import { audit, focusStop, type Audit, type FocusStop } from "./audit";
import { contrast, decodePng, type Pixels, type RGB } from "./pixels";

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
  // And the colours really are that scheme's (CodeEditor Deep Field, the default: no data-palette).
  await expect(page.locator("html")).not.toHaveAttribute("data-palette");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(scheme === "dark" ? "rgb(19, 32, 27)" : "rgb(248, 251, 249)");
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

      // 5. Problems (phones: the view switch's Problems; the panel's own tabs give way to it there).
      await showPanel(page, "problems");
      await expect(page.locator(".problem").first()).toBeVisible();
      await record(page, dir, `problems-${vp.name}-${scheme}`, records);

      // 6. The Input box opened (behind the panel bar's Input toggle; its placeholder is a checked colour).
      await showPanel(page, "output");
      await openInputBox(page);
      await record(page, dir, `input-box-${vp.name}-${scheme}`, records, false);
      await page.locator("#input-toggle").click();
      await expect(page.locator("#stdin")).toBeHidden();

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
      await showPanel(page, "problems");
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
  // The panel bar's collapse toggle, Input, Restart Python, Clear, Maximise the panel, the Problems
  // panel, then the first problem (layout v2 added the first two to the bar).
  const panelPath = await tabPath(page, 7);
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

for (const scheme of ["light", "dark"] as const) {
  test(`the editor's focus indicator is a bar on the gutter edge (${scheme}): no frame, 3:1, and the audit sees it go`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openThemed(page, scheme);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    await page.locator(".cm-content").click();
    const stop = await focusStop(page);
    expect(stop.cls).toContain("cm-content");
    expect(stop.bar, "the gutter-edge bar is drawn").not.toBe("");
    expect(stop.indicator).toBe(true);
    expect(stop.ringContrast, "the bar against the gutter's ground").toBeGreaterThanOrEqual(3);
    // No frame round the whole editor (it out-shouted the code and the gutter clipped it).
    expect(await page.locator(".cm-editor").evaluate((e) => getComputedStyle(e).outlineStyle)).toBe("none");
    const barStyle = () =>
      page.locator(".cm-editor .cm-gutters").evaluate((g) => {
        const a = getComputedStyle(g, "::after");
        return { content: a.content, position: a.position, top: a.top, bottom: a.bottom, right: a.right, width: a.width };
      });
    // Full height on the gutter's right edge.
    expect(await barStyle()).toEqual({ content: '""', position: "absolute", top: "0px", bottom: "0px", right: "0px", width: "2px" });
    const box = (await page.locator(".cm-editor .cm-gutters").boundingBox())!;
    await page.screenshot({
      path: `${dirFor(info, "keyboard")}/editor-focus-bar-${scheme}.png`,
      clip: { x: Math.max(0, box.x), y: box.y, width: box.width + 160, height: 140 },
    });

    // The audit is not vacuous: with the bar hidden, the editor's stop has no indicator.
    const hide = await page.addStyleTag({ content: ".cm-editor .cm-gutters::after { content: none !important; }" });
    const without = await focusStop(page);
    expect(without.cls).toContain("cm-content");
    expect(without.indicator, "an editor without the bar is reported").toBe(false);
    expect(without.ringContrast).toBeNull();
    await hide.evaluate((el) => (el as Element).remove());
    expect((await focusStop(page)).indicator).toBe(true);

    // Only focus draws it: Esc then Tab leaves the editor and the bar goes.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await expect(page.locator(".cm-content")).not.toBeFocused();
    // (CodeMirror drops .cm-focused in its next update after the blur.)
    await expect.poll(async () => (await barStyle()).content).toMatch(/^(none|normal)$/);
  });
}

/**
 * Forced colours (Windows High Contrast) replace every author background colour with a system
 * colour (Canvas behind the gutter), so a bar painted only as a background vanishes there, while a
 * border takes a contrasting system colour (CSS Color Adjust 1, section 3.1). The old frame, an
 * outline, survived forced colours; the bar must too. Measured in pixels at the bar's place on the
 * gutter edge: focused against the gutter ground beside it, and against the same place once focus
 * has left the editor.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`in forced colours (${scheme}) the editor's focus bar still shows`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.emulateMedia({ colorScheme: scheme, forcedColors: "active" });
    await page.reload();
    await waitReady(page);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "forced colours emulated").toBe(true);
    await importFiles(page, FILES);
    await openFromTree(page, "main.py");
    await page.locator(".cm-content").click();
    await expect(page.locator(".cm-editor")).toHaveClass(/\bcm-focused\b/);

    const gutters = page.locator(".cm-editor .cm-gutters");
    const box = (await gutters.boundingBox())!;
    const border = await gutters.evaluate((g) => parseFloat(getComputedStyle(g).borderRightWidth) || 0);
    // The bar is the 2 px just inside the gutter's own right border; the ground is blank gutter
    // below the last line number.
    const at = { x: box.x + box.width - border - 1, y: box.y + box.height * 0.6 };
    const paint = async () => decodePng(await page.screenshot({ scale: "css", animations: "disabled" }));
    let px = await paint();
    const bar = px.at(at.x, at.y);
    const ground = px.at(at.x - 8, at.y);
    await page.screenshot({
      path: `${dirFor(info, "keyboard")}/editor-focus-bar-forced-${scheme}.png`,
      clip: { x: Math.max(0, box.x), y: box.y, width: box.width + 160, height: 140 },
    });

    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await expect(page.locator(".cm-content")).not.toBeFocused();
    await expect(page.locator(".cm-editor")).not.toHaveClass(/\bcm-focused\b/);
    px = await paint();
    const left = px.at(at.x, at.y);
    info.annotations.push({ type: "forced-colour pixels", description: JSON.stringify({ at, bar, ground, left }) });
    expect.soft(contrast(bar, ground), `bar ${bar} on the gutter ground ${ground}`).toBeGreaterThanOrEqual(3);
    expect.soft(contrast(bar, left), `bar ${bar} against the same place unfocused ${left}`).toBeGreaterThanOrEqual(3);
  });
}

/**
 * Forced colours also drop author box-shadows and paint every author background as Canvas, so the
 * indicators drawn as a fill or a shadow vanished there (review D, 2026-10-18): the selected tab's
 * and panel tab's location bars, the open file's bar in the tree, the error jump's danger bar, the
 * error line's gutter bar and dot, the call site's arrow, the panel splitter's focus and the picked
 * suggestion. app.css
 * draws them as borders (or a text arrow) in forced colours, which take a system colour. Measured in
 * pixels: the strongest contrast in each mark's place against the same place without the mark.
 */
test("in forced colours the selected tab and panel tab, the open file, the error marks and the splitter's focus still show", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "forced colours emulated").toBe(true);
  await importFiles(page, FILES);
  await openFromTree(page, "calc.py");
  await openFromTree(page, "main.py");
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  await expect(page.locator("#error-jump")).toBeVisible();
  await expect(page.locator(".cm-gutter-lint .cm-gutterElement.ce-call-line")).toBeVisible();
  await page.mouse.move(1, 1);

  type Box = { x: number; y: number; width: number; height: number };
  const shot = async () => decodePng(await page.screenshot({ scale: "css", animations: "disabled" }));
  // Every new set of diagnostics redraws the gutter's marks as new nodes (the syntax check that
  // follows opening a Python file does it about 500 ms later), and a node replaced while it is
  // measured has no box: measure again until the box comes from an attached node.
  const rect = async (selector: string): Promise<Box> => {
    const at = page.locator(selector).first();
    const got: { box: Box | null } = { box: null };
    await expect(async () => {
      got.box = await at.boundingBox();
      expect(got.box, `${selector} has a box`).not.toBeNull();
    }).toPass({ timeout: 5_000 });
    return got.box!;
  };
  const strongest = (px: Pixels, r: Box, ref: RGB) => {
    let best = 1;
    for (let y = Math.ceil(r.y); y < r.y + r.height; y++) for (let x = Math.ceil(r.x); x < r.x + r.width; x++) best = Math.max(best, contrast(px.at(x, y), ref));
    return best;
  };
  const marks: Record<string, { marked: number; plain: number }> = {};
  /** `marked`: where the indicator is drawn; `plain`: the same place without it (its colour is the reference). */
  const measure = (name: string, marked: Box, plain: Box, px: Pixels, pxPlain = px) => {
    const ref = pxPlain.at(Math.ceil(plain.x), Math.ceil(plain.y));
    marks[name] = { marked: strongest(px, marked, ref), plain: strongest(pxPlain, plain, ref) };
  };
  const foot = (r: Box, inset: number): Box => ({ x: r.x + inset, y: r.y + r.height - 2, width: r.width - 2 * inset, height: 2 });
  const lead = (r: Box, dx = 0): Box => ({ x: r.x + dx, y: r.y + 4, width: 2, height: r.height - 8 });
  const up = (r: Box): Box => ({ ...r, y: r.y - r.height });

  let px = await shot();
  measure("selected tab", foot(await rect('.tab[data-active="true"]'), 6), foot(await rect('.tab[data-active="false"]'), 6), px);
  measure("selected panel tab", foot(await rect("#ptab-output"), 10), foot(await rect("#ptab-problems"), 10), px);
  measure("open file in the tree", lead(await rect('.tree [aria-current="true"] > .tree-row')), lead(await rect('.tree [data-path="calc.py"] > .tree-row')), px);
  const jump = await rect("#error-jump");
  measure("error jump", lead(jump), lead(jump, -8), px);
  const header = await rect("#runlog");
  measure("failed run's header", lead(header), lead(header, 4), px);
  const call = await rect(".cm-gutter-lint .cm-gutterElement.ce-call-line");
  measure("call site arrow", call, up(call), px);

  // calc.py, where the error was raised: the gutter bar and the dot on line 2.
  await page.locator("#error-jump").click();
  await expect(page.locator(".cm-lineNumbers .cm-gutterElement.ce-error-line")).toBeVisible();
  await page.mouse.move(1, 1);
  px = await shot();
  const errorCell = await rect(".cm-lineNumbers .cm-gutterElement.ce-error-line");
  measure("error line's gutter bar", lead(errorCell), lead(up(errorCell)), px);
  const dot = await rect(".cm-gutter-lint .cm-lint-marker-error");
  measure("error dot", dot, up(dot), px);

  // The panel splitter, reached from the code with Escape then Tab: its ring, against the same rows unfocused.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("separator", { name: "Resize the output panel" })).toBeFocused();
  // Past the gutter (its edge is a line of its own), over the empty end of the code.
  const splitter = await rect(".center > .splitter");
  const gutters = await rect(".cm-editor .cm-gutters");
  const above: Box = { x: gutters.x + gutters.width + 40, y: splitter.y - 2, width: 200, height: 2 };
  const focused = await shot();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("separator", { name: "Resize the output panel" })).not.toBeFocused();
  measure("panel splitter's focus", above, above, focused, await shot());

  // The suggestion list's picked option (a fill and a bar elsewhere): against an option not picked.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("i");
  await expect(page.locator(".cm-tooltip-autocomplete [role=option]").nth(1)).toBeVisible();
  // A list just opened ignores keys for 75 ms (CodeMirror's interactionDelay): Down until one is picked.
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".cm-tooltip-autocomplete [role=option][aria-selected]")).toHaveCount(1, { timeout: 500 });
  }).toPass();
  // The second option, away from the list's rounded corner (its border curves into the first row).
  await page.keyboard.press("ArrowDown");
  const options = page.locator(".cm-tooltip-autocomplete [role=option]");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(1, 1);
  // The option's own left edge only: its kind icon (an italic f on some) leans into a wider strip.
  const edge = (r: Box): Box => ({ x: r.x, y: r.y + 2, width: 1, height: r.height - 4 });
  measure("picked suggestion", edge((await options.nth(1).boundingBox())!), edge((await options.nth(2).boundingBox())!), await shot());

  // The keyword kind icon, a key drawn as a mask over a fill (forced colours turned the fill into
  // Canvas, so the key vanished: review RB-4, 2026-10-19): in a row that isn't picked, against the
  // row's own left padding.
  const keyword = await page.locator(".cm-tooltip-autocomplete [role=option]:not([aria-selected]) .cm-completionIcon-keyword").first().boundingBox();
  const keywordRow = await page.locator(".cm-tooltip-autocomplete [role=option]:not([aria-selected])").filter({ has: page.locator(".cm-completionIcon-keyword") }).first().boundingBox();
  expect(keyword && keywordRow, "a keyword row that isn't picked").toBeTruthy();
  measure("keyword icon", keyword!, { x: keywordRow!.x + 1, y: keyword!.y, width: 2, height: keyword!.height }, await shot());

  info.annotations.push({ type: "forced-colour marks", description: JSON.stringify(marks) });
  for (const [name, m] of Object.entries(marks)) {
    expect.soft(m.marked, `${name}: the mark against its place unmarked`).toBeGreaterThanOrEqual(3);
    expect.soft(m.plain, `${name}: the unmarked place is plain`).toBeLessThan(1.5);
  }
  await page.screenshot({ path: `${dirFor(info, "keyboard")}/forced-marks.png` });
});

/**
 * The menus' separators split their groups (the file menu's five; the code menu's Capture snippet
 * from Cut, Copy and Select all, reading order 9). A 1 px background vanished in forced colours (it
 * turns into Canvas like the menu); drawn as a border it takes a system colour. Measured in pixels:
 * the strongest contrast along each separator against the menu's ground just above it.
 */
test("in forced colours the menus' separators still show", async ({ page, browserName }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "forced colours emulated").toBe(true);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  // Only an engine that really paints forced colours can show this (Playwright's WebKit matches the
  // media query but keeps the author colours: the menu stayed --surface-raised, measured 2026-10-21).
  const painted = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "Canvas";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { canvas, menu: getComputedStyle(document.querySelector(".menu")!).backgroundColor };
  });
  test.skip(painted.menu !== painted.canvas, `${browserName} keeps author colours under forced-colors emulation (${JSON.stringify(painted)})`);
  await page.mouse.move(1, 1);
  const px = decodePng(await page.screenshot({ scale: "css", animations: "disabled" }));
  const seps = await menu.locator(".menu-sep").evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  expect(seps, "the file menu's separators").toHaveLength(4);
  const shown = seps.map((s) => {
    const ref = px.at(Math.ceil(s.x + 4), Math.floor(s.y) - 2);
    let best = 1;
    for (let y = Math.floor(s.y); y < Math.ceil(s.y + Math.max(s.height, 1)); y++) for (let x = Math.ceil(s.x + 2); x < s.x + s.width - 2; x++) best = Math.max(best, contrast(px.at(x, y), ref));
    return Math.round(best * 100) / 100;
  });
  info.annotations.push({ type: "forced-colour separators", description: JSON.stringify({ seps, shown }) });
  for (const [i, c] of shown.entries()) expect.soft(c, `separator ${i + 1} against the menu's ground`).toBeGreaterThanOrEqual(3);
});

/**
 * The output log's ring is drawn on its scroller, inset, so no side of it is ever scrolled out of
 * view (review D, 2026-10-18: drawn on the log itself, its top and bottom were clipped whenever the
 * log was taller than the panel), and it stays clear of the stderr bar.
 */
test("the output log's focus ring is drawn whole, clear of the stderr bar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openThemed(page, "light");
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 60_000 });
  await page.locator("#live-input-field").fill("Ada");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  // The log is taller than its scroller: the case that clipped the ring.
  expect(await page.locator("#console-scroll").evaluate((s) => s.scrollHeight > s.clientHeight + 4)).toBe(true);
  await page.keyboard.press("Control+`");
  const stop = await focusStop(page);
  expect(stop.id).toBe("console");
  expect(stop.indicator, `the log's ring: ${stop.outline}`).toBe(true);
  expect(stop.clipped, "no side of the ring is cut off").toEqual([]);
  expect(stop.ringContrast).toBeGreaterThanOrEqual(3);
  const gap = await page.evaluate(() => {
    // An inset ring (negative offset) ends that far inside the scroller's edge.
    const scroller = document.querySelector<HTMLElement>("#console-scroll")!;
    const inner = scroller.getBoundingClientRect().left + Math.max(0, -parseFloat(getComputedStyle(scroller).outlineOffset));
    return document.querySelector("#console .err")!.getClientRects()[0].left - inner;
  });
  expect(gap, "the ring stays 8 px or more clear of the stderr bar").toBeGreaterThanOrEqual(8);
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

// Each file tree item is named by the text in its row (aria-labelledby). Skipping the rendering of
// rows scrolled out of view (content-visibility: auto, tried for typing speed on 2026-10-20) left
// 23 of 100 items without a name in Chromium's accessibility tree, which axe (reading the DOM)
// doesn't see. So this reads the browser's own tree.
test("every file tree item has its name in the browser's accessibility tree, scrolled out of view too", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the browser's accessibility tree is read through CDP (Accessibility.getFullAXTree), Chromium only");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitReady(page);
  const files = [{ name: "main.c", text: "int main(void) {\n    return 0;\n}\n" }];
  for (let i = 0; files.length < 100; i++) files.push({ name: `part_${String(i).padStart(3, "0")}.c`, text: `int f${i}(void) { return ${i}; }\n` });
  await importFiles(page, files);
  await expect(page.locator(".tree [role=treeitem]")).toHaveCount(100);
  await openFromTree(page, "main.c");
  // Most rows are below the fold (the list shows about 30 at this size).
  expect(await page.locator('.tree [role=treeitem][data-path="part_098.c"]').evaluate((el) => el.getBoundingClientRect().top > innerHeight)).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { role?: { value: string }; name?: { value: string }; ignored?: boolean }[] };
  const names = nodes.filter((n) => n.role?.value === "treeitem" && !n.ignored).map((n) => n.name?.value ?? "");
  expect(names.length, "tree items in the accessibility tree").toBe(100);
  expect(names.filter((n) => !files.some((f) => f.name === n)), "tree items without their file's name").toEqual([]);
  await cdp.detach();
});
