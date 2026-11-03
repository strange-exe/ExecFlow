// Redesign 8, menus option C, "Flow rail" (.claude/design/redesign8/menus/options.html; the owner's
// pick, 2026-11-03): menus in named groups (role=group named by a caption), edge-to-edge rows whose
// chosen row carries a 3 px bar in the focus colour for the pointer and the keyboard alike (no ring
// box), quiet shortcuts in one notation, Capture's long label split into its words and a detail, an
// unavailable item that stays focusable and says why; the top bar's words from 1280 px and the camera
// on Capture; the tabs in a tray, a long name cut in its stem (the extension stays), unsaved as a dot
// in the close button's place (no italics), and a "more" button when the tabs overflow.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, openApp, openFromTree, openIn, showFiles, test, treeItem } from "./helpers";
import { FIXTURE, box, openWith, selectFixtureLines } from "./snippet-helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const LONG = "assignment_three_final_version_two.py";
const isMacPage = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
const codeMenu = (page: Page) => page.locator("#code-menu");

/** A point inside line n's text (as code-menu.spec.ts pointIn). */
async function pointIn(page: Page, n: number) {
  const b = await box(page.locator(".cm-line").nth(n - 1));
  return { x: b.x + 30, y: b.y + b.height / 2 };
}

/**
 * Colour facts read in the page: the computed colour of `prop` on `el` (or its ::before), the ground
 * painted under it (every background up the tree composited, as e2e/audit.ts does) and their ratio.
 */
function paint(el: Locator, prop: "color" | "border-left-color" | "background-color", pseudo: "" | "::before" = "") {
  return el.evaluate(
    (node, [p, ps]) => {
      type RGBA = [number, number, number, number];
      const parse = (c: string): RGBA => {
        if (c === "transparent") return [0, 0, 0, 0];
        const m = c.match(/^rgba?\(([^)]+)\)$/);
        if (m) {
          const v = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x)));
          return [v[0], v[1], v[2], v[3] ?? 1];
        }
        const s = c.match(/^color\(srgb\s+([^)]+)\)$/);
        if (s) {
          const v = s[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
          return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1];
        }
        throw new Error(`unparsed colour ${c}`);
      };
      const over = (top: RGBA, base: RGBA): RGBA => {
        const a = top[3] + base[3] * (1 - top[3]);
        const ch = (i: number) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a;
        return [ch(0), ch(1), ch(2), a];
      };
      const lum = (c: RGBA) => {
        const f = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      // The ground: from the element itself (a ::before draws over its element's fill) up the tree.
      const layers: RGBA[] = [];
      for (let e: Element | null = node; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let ground: RGBA = [255, 255, 255, 1];
      for (const l of layers.reverse()) ground = over(l, ground);
      const fg = over(parse(getComputedStyle(node, ps || null).getPropertyValue(p)), ground);
      const [x, y] = [lum(fg), lum(ground)].sort((a, b) => b - a);
      const hex = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
      return { fg: hex(fg), ground: hex(ground), ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100 };
    },
    [prop, pseudo] as const,
  );
}

/** The focus token as the page paints it (a probe element's computed colour). */
const focusColour = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--focus)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });

/** The rows whose bar is painted (a ::before with a visible left border). */
const barred = (menu: Locator) =>
  menu.locator("[role=menuitem], [role=menuitemradio]").evaluateAll((els) =>
    els
      .filter((e) => {
        const s = getComputedStyle(e, "::before");
        return s.content !== "none" && parseFloat(s.borderLeftWidth) > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.borderLeftColor);
      })
      .map((e) => e.querySelector(".menu-label")?.textContent ?? ""),
  );

test("R1: the code menu: named groups, Capture's short label and its detail, one notation, a one-line hint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await selectFixtureLines(page);
  const mac = await isMacPage(page);
  const at = await pointIn(page, 2);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = codeMenu(page);
  await expect(menu).toBeVisible();
  // Two groups, each a role=group named by its caption: the selection's lines, then the clipboard.
  const groups = menu.getByRole("group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAccessibleName("Selection lines 2 to 3");
  await expect(groups.nth(1)).toHaveAccessibleName("Clipboard");
  await expect(groups.nth(0).getByRole("menuitem")).toHaveCount(1);
  await expect(groups.nth(1).getByRole("menuitem")).toHaveCount(3);
  // Capture: its words on the row, the lines in the caption; the name still says them all.
  const capture = groups.nth(0).getByRole("menuitem");
  await expect(capture.locator(".menu-label")).toHaveText("Capture snippet...");
  await expect(capture).toHaveAccessibleName("Capture snippet of lines 2 to 3...");
  await expect(menu.locator(".menu-cap-detail").first()).toHaveText("lines 2 to 3");
  await expect(menu.locator(".menu-cap-detail").first()).toBeVisible();
  const clipped = await menu.locator(".menu-label, .menu-cap-name, .menu-cap-detail").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent));
  expect(clipped, "no label or caption is cut short").toEqual([]);
  // Capture's icon is the camera.
  await expect(capture.locator("svg[data-icon=camera]")).toHaveCount(1);
  // Shortcuts: one notation, the one the notices use ("Ctrl+C"), as quiet text, not boxed keycaps.
  const mod = mac ? "Cmd" : "Ctrl";
  expect(await menu.locator(".menu-key").allTextContents()).toEqual([`${mod}+X`, `${mod}+C`, `${mod}+A`]);
  await expect(menu.locator(".keycap")).toHaveCount(0);
  // The browser-menu hint: one line.
  const hint = menu.locator(".menu-hint");
  await expect(hint).toHaveText("Browser menu: Shift+right-click");
  const lines = await hint.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
  });
  expect(lines, "the hint is one line").toBe(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`R2: the chosen row carries the focus-colour bar for the keyboard and the pointer, no ring box, 3:1 (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await openWith(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await selectFixtureLines(page);
    // The keyboard: Shift+F10 opens the menu on its first row; Down moves the bar.
    await page.keyboard.press("Shift+F10");
    const menu = codeMenu(page);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const cut = menu.getByRole("menuitem", { name: /^Cut/ });
    await expect(cut).toBeFocused();
    await expect.poll(() => barred(menu)).toEqual(["Cut"]);
    const focus = await focusColour(page);
    const bar = await cut.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { width: parseFloat(s.borderLeftWidth), colour: s.borderLeftColor, outline: getComputedStyle(el).outlineStyle, ring: getComputedStyle(el).boxShadow };
    });
    expect(bar.width).toBe(3);
    expect(bar.colour).toBe(focus);
    expect(bar.outline, "no outline box beside the bar").toBe("none");
    expect(bar.ring, "no inset ring either").toBe("none");
    const contrast = await paint(cut, "border-left-color", "::before");
    expect(contrast.ratio, `bar ${contrast.fg} on the chosen row ${contrast.ground}`).toBeGreaterThanOrEqual(3);
    // The pointer: a real move onto Copy hands it the bar (and the focus); one row is barred at a time.
    const copy = menu.getByRole("menuitem", { name: /^Copy/ });
    const b = await box(copy);
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 4 });
    await expect(copy).toBeFocused();
    await expect.poll(() => barred(menu)).toEqual(["Copy"]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
}

test("R3: File actions is in named groups; an unavailable item stays focusable, says why and does nothing", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page);
  await showFiles(page);
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  const names = await menu.getByRole("group").evaluateAll((els) =>
    els.map((g) => (g.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()),
  );
  expect(names).toEqual(["File main.py", "New", "Change", "Workspace", "Selection main.py"]);
  await expect(menu.getByRole("group").first()).toHaveAccessibleName("File main.py");
  await expect(menu.getByRole("menuitem", { name: /^Capture snippet/ }).locator(".menu-label")).toHaveText("Capture snippet...");
  await page.keyboard.press("Escape");

  // A second browser tab is read-only: Rename stays in the menu, focusable, with its reason.
  const second = await context.newPage();
  await second.setViewportSize({ width: 1440, height: 900 });
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await openFromTree(second, "main.py");
  await showFiles(second);
  await treeItem(second, "main.py").locator(":scope > .tree-row").click();
  await showFiles(second);
  await second.locator("#file-actions").click();
  const reader = second.getByRole("menu", { name: "File actions" });
  const rename = reader.getByRole("menuitem", { name: "Rename" });
  await expect(rename).toHaveAttribute("aria-disabled", "true");
  await expect(rename).toHaveAccessibleDescription("Read-only in this tab");
  await expect(rename.locator(".menu-sub")).toHaveText("Read-only in this tab");
  // The keyboard reaches it (End, then up over Delete... whichever: it is in the arrow order).
  const order = await reader.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.querySelector(".menu-label")?.textContent));
  const at = order.indexOf("Rename");
  expect(at).toBeGreaterThan(0);
  for (let i = 0; i < at; i++) await second.keyboard.press("ArrowDown");
  await expect(rename).toBeFocused();
  await second.keyboard.press("Enter");
  await expect(reader).toBeVisible();
  await expect(rename).toBeFocused();
  // force: Playwright counts an aria-disabled element as disabled and would wait for it to enable
  // (playwright.dev/docs/actionability); a real pointer still reaches it, and it must do nothing.
  await rename.click({ force: true });
  await expect(reader).toBeVisible();
  await expect(second.locator(".tree-input")).toHaveCount(0);
  await second.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  await second.close();
});

test("R4: from 1280 px Shortcuts and Settings show their words, under it their icons; names unchanged; Capture is a camera", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWith(page);
  const shortcuts = page.locator("#shortcuts-button");
  const settings = page.locator("#settings-button");
  const shown = (l: Locator) => l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 8 && s.display !== "none" && s.clipPath === "none" && el.scrollWidth <= el.clientWidth + 0.5;
  });
  await expect(shortcuts).toHaveAccessibleName("Shortcuts");
  await expect(settings).toHaveAccessibleName("Settings");
  expect(await shown(shortcuts.locator(".status-btn-label")), "Shortcuts' word at 1280").toBe(true);
  expect(await shown(settings.locator(".rail-label")), "Settings' word at 1280").toBe(true);
  await expect(page.locator("#snippet-button svg[data-icon=camera]")).toHaveCount(1);
  await expect(page.locator("#snippet-button")).toHaveAccessibleName("Capture snippet of the selected lines");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll at 1280").toBe(true);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => shown(shortcuts.locator(".status-btn-label"))).toBe(false);
  expect(await shown(settings.locator(".rail-label"))).toBe(false);
  await expect(shortcuts).toHaveAccessibleName("Shortcuts");
  await expect(settings).toHaveAccessibleName("Settings");
});

test("R5: a long tab name loses its stem's end, never its extension; unsaved is a dot in the close button's place, no italics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: LONG, text: "print(1)\n" }]);
  await openFromTree(page, LONG);
  const tab = page.locator(`.tab:has([role=tab][title="${LONG}"])`);
  const role = tab.getByRole("tab");
  await expect(role).toHaveAccessibleName(LONG);
  const parts = await tab.evaluate((el) => {
    const stem = el.querySelector<HTMLElement>(".tab-stem")!;
    const ext = el.querySelector<HTMLElement>(".tab-ext")!;
    const t = el.getBoundingClientRect();
    const e = ext.getBoundingClientRect();
    return { cut: stem.scrollWidth > stem.clientWidth, ext: ext.textContent, extInside: e.left >= t.left && e.right <= t.right, extWhole: ext.scrollWidth <= ext.clientWidth + 0.5 };
  });
  expect(parts).toEqual({ cut: true, ext: ".py", extInside: true, extWhole: true });

  // Unsaved: a dot where the close button's x sits, the name upright.
  await page.locator(".cm-content").click();
  await page.keyboard.type("x");
  await expect(tab).toHaveAttribute("data-dirty", "true");
  await expect(role).toHaveAccessibleName(`${LONG}, unsaved`);
  await page.mouse.move(5, 5);
  expect(await tab.locator(".tab-name").evaluate((el) => getComputedStyle(el).fontStyle)).toBe("normal");
  const close = tab.locator(".tab-close");
  await expect(close.locator(".dirty-dot")).toBeVisible();
  await expect(close.locator("svg[data-icon=x]")).toBeHidden();
  // Hover shows the x in the dot's place.
  await close.hover();
  await expect(close.locator("svg[data-icon=x]")).toBeVisible();
  await expect(close.locator(".dirty-dot")).toBeHidden();
  // A clean, inactive tab shows no close button at rest.
  await page.mouse.move(5, 5);
  const other = page.locator('.tab:has([role=tab][title="main.py"])');
  await expect(other).toHaveAttribute("data-active", "false");
  await expect(other.locator(".tab-close")).toHaveCSS("opacity", "0");
});

test("R6: tabs that overflow the strip fade at the edge and list the hidden ones under a 'more' button", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const files = Array.from({ length: 9 }, (_, i) => ({ name: `exercise_${i + 1}_loops.py`, text: `print(${i})\n` }));
  await openWith(page, files);
  for (const f of files.slice(1)) await openFromTree(page, f.name);
  const more = page.locator(".tabs-more");
  await expect(more).toBeVisible();
  await expect(more).toHaveText(/^\d+ more$/);
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  // The first tab is out of view after the last was opened: the menu offers it and choosing it opens it.
  await page.locator(".tabs").evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await more.click();
  const menu = page.getByRole("menu", { name: "More open files" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: files[0].name }).click();
  await expect(page.locator(`.tabs [role=tab][title="${files[0].name}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`.tabs [role=tab][title="${files[0].name}"]`)).toBeInViewport({ ratio: 0.9 });
});

for (const scheme of ["light", "dark"] as const) {
  test(`R7: badges and tab text keep their contrast; the menus and tabs pass axe (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIn(page, "/", scheme);
    await openWith(page, [{ name: "main.py", text: FIXTURE }, { name: "calc.c", text: "int main(void) { return 0; }\n" }]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await openFromTree(page, "calc.c");
    // Tabs: the open tab's name and badge, an inactive tab's name and badge (on the tray).
    for (const path of ["calc.c", "main.py"]) {
      const tab = page.locator(`.tab:has([role=tab][title="${path}"])`);
      for (const part of [".tab-name", ".file-badge"]) {
        const c = await paint(tab.locator(part).first(), "color");
        expect(c.ratio, `${path} ${part} ${c.fg} on ${c.ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The open tab's top edge in the location colour (3:1 against the tray beside it).
    const edge = await paint(page.locator('.tab[data-active="true"]'), "border-left-color", "::before");
    expect(edge.ratio, `top edge ${edge.fg} on ${edge.ground}`).toBeGreaterThanOrEqual(3);
    // Tree rows' badges.
    await showFiles(page);
    for (const path of ["calc.c", "main.py"]) {
      const c = await paint(treeItem(page, path).locator(":scope > .tree-row .file-badge"), "color");
      expect(c.ratio, `tree ${path} badge ${c.fg} on ${c.ground}`).toBeGreaterThanOrEqual(4.5);
    }
    // File actions open: axe over the whole page.
    await page.locator("#file-actions").click();
    await expect(page.getByRole("menu", { name: "File actions" })).toBeVisible();
    const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
    expect(axe).toEqual([]);
  });
}

test("R8: in a short window File actions scrolls inside itself, its focused row is the one tab stop, and axe passes", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await openWith(page);
  await showFiles(page);
  await page.locator("#file-actions").click();
  const menu = page.getByRole("menu", { name: "File actions" });
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1), "the menu scrolls at 600 px").toBe(true);
  const stops = () => menu.locator('[role=menuitem][tabindex="0"]').evaluateAll((els) => els.map((e) => e.querySelector(".menu-label")?.textContent));
  expect(await stops()).toEqual(["Open"]);
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toBeInViewport();
  expect(await stops()).toEqual([await items.last().locator(".menu-label").textContent()]);
  const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  expect(axe).toEqual([]);
  // Tab still leaves (closes) the menu.
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
});
