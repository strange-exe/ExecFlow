// The chosen redesign, "CodeEditor Signal" (redesign 2, option a, chosen 2026-10-25): the default
// theme and its first paint, the one-time move from the old default, the fonts (Geist for the
// interface, JetBrains Mono for code with its ligatures off unless chosen), the desktop bar heights
// and the editor as a sheet (12 px corners, a 1 px --border edge, 10 px of --surface right and
// below it, the editor head on --bg), with phones unchanged but for colours and fonts. Every themed
// test emulates the scheme, reloads and proves the scheme and the palette are active first.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, test, waitReady } from "./helpers";
import { rgbOf } from "./pixels";

test.use({ serviceWorkers: "block" });

const MAIN = 'from calc import average\n\nmarks = [72, 85, 90]\nprint("Average:", average(marks))\nprint("Empty:", average([]))\n';
const CALC = "def average(values):\n    total = sum(values)\n    return total / len(values)\n";
type Scheme = "light" | "dark";
const SCHEMES: Scheme[] = ["light", "dark"];
/** The Signal colours these checks read, as designed (src/theme/palettes.ts SIGNAL, kept equal by contrast.test.ts). */
const SIGNAL = {
  light: { bg: "#fcfcfd", surface: "#edf0f3", border: "#d6dbe2", divider: "#d0d6de", focus: "#0b6e80", location: "#2f5bea" },
  dark: { bg: "#0e1116", surface: "#151a21", border: "#252c35", divider: "#2a313b", focus: "#4fd1df", location: "#7ea2ff" },
} as const;

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Emulates the scheme, reloads, and proves Signal is what is painted. */
async function signalIn(page: Page, scheme: Scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", scheme);
  await expect(html).toHaveAttribute("data-palette", "signal");
  await expect(html).toHaveAttribute("data-theme-id", "signal");
  expect(await bodyBg(page)).toBe(rgbOf(SIGNAL[scheme].bg));
}

/** Reloads with the app's scripts held back, runs `check` on what theme-boot.js painted, then lets them go. */
async function reloadHeld(page: Page, check: () => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  await page.locator("#app").waitFor({ state: "attached" });
  await expect(page.locator("#app")).toHaveAttribute("data-state", "loading");
  await check();
  release();
  await waitReady(page);
  await page.unroute("**/assets/*.js");
}

/** The computed style of the first match, for the given properties. */
const styleOf = (page: Page, selector: string, props: string[]) =>
  page.locator(selector).first().evaluate((el, names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(el).getPropertyValue(n)])), props);
const boxOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);

test("Signal is the default, light and dark, and theme-boot.js paints it before the app's code (no flash)", async ({ page }) => {
  await openApp(page);
  for (const scheme of SCHEMES) {
    await signalIn(page, scheme);
    await reloadHeld(page, async () => {
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-palette", "signal");
      await expect(html).toHaveAttribute("data-theme", scheme);
      expect(await bodyBg(page)).toBe(rgbOf(SIGNAL[scheme].bg));
      // The browser's toolbar colour is Signal's chrome too, per scheme.
      expect(await page.locator('meta[name="theme-color"]').evaluateAll((m) => m.map((x) => x.getAttribute("content")))).toEqual([SIGNAL.light.surface, SIGNAL.dark.surface]);
    });
  }
});

test("a device on the old default (Deep Field, match device) moves to Signal once, with no flash; Deep Field chosen again stays", async ({ page }) => {
  await openApp(page);
  await page.emulateMedia({ colorScheme: "dark" });
  // What the build before Signal left on a device that never chose a theme, or chose the default.
  await page.evaluate(() => {
    localStorage.setItem("codeeditor:theme", "deep-field");
    localStorage.setItem("codeeditor:theme-paint", JSON.stringify({ system: true, scheme: "dark", palette: "deep-field", colors: null }));
    localStorage.removeItem("codeeditor:theme-default");
  });
  await reloadHeld(page, async () => {
    await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
    expect(await bodyBg(page)).toBe(rgbOf(SIGNAL.dark.bg));
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "signal");
  expect(await page.evaluate(() => [localStorage.getItem("codeeditor:theme"), localStorage.getItem("codeeditor:theme-default")])).toEqual(["signal", "signal"]);

  // Deep Field's "match device", chosen in Settings after the move, is kept across reloads.
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.locator(".theme-more summary").click();
  await settings.getByRole("radio", { name: "CodeEditor Deep Field (match device)" }).check();
  await page.keyboard.press("Escape");
  await reloadHeld(page, async () => {
    await expect(page.locator("html")).not.toHaveAttribute("data-palette");
    expect(await bodyBg(page)).toBe("rgb(19, 32, 27)"); // Deep Field's dark field #13201b
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "deep-field");
});

test("Settings leads with Signal (the default) and High contrast; Deep Field is folded with Slate", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const upFront = settings.locator(".theme-list > .theme-grid").first().locator("[data-theme-option]");
  await expect(upFront).toHaveCount(4);
  expect(await upFront.evaluateAll((els) => els.map((e) => e.getAttribute("data-theme-option")))).toEqual(["signal", "signal-light", "signal-dark", "high-contrast"]);
  await expect(settings.getByRole("radio", { name: /^CodeEditor Signal \(match device\)/ })).toBeChecked();
  await expect(settings.locator('[data-theme-option="signal"] .tag')).toHaveText("Default");
  const fold = settings.locator(".theme-more");
  await expect(fold).not.toHaveAttribute("open");
  expect(await fold.locator(".theme-group").allTextContents()).toEqual(["CodeEditor Deep Field", "CodeEditor Slate", "Popular editor themes", "Other editor themes"]);
  for (const id of ["deep-field", "deep-field-light", "deep-field-dark"]) await expect(fold.locator(`[data-theme-option="${id}"]`)).toHaveCount(1);
});

test("fonts: Geist and JetBrains Mono load at every weight used and the weights differ; ligatures stay off unless chosen, which changes ligatures only", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  await expect(page.locator(".cm-content")).toContainText("#include");
  const family = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await family("body")).toMatch(/^"?Geist"?,/);
  expect(await family(".cm-content")).toMatch(/^"?JetBrains Mono"?,/);
  expect(await family(".tab-name")).toMatch(/^"?JetBrains Mono"?,/);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");

  const faces = await page.evaluate(async () => {
    const want = [["Geist", "400", "normal"], ["Geist", "500", "normal"], ["Geist", "600", "normal"], ["JetBrains Mono", "400", "normal"], ["JetBrains Mono", "400", "italic"], ["JetBrains Mono", "600", "normal"]];
    const out: string[] = [];
    // The last one is a control: a family nobody declared must come out missing.
    for (const [fam, weight, style] of [...want, ["No Such Family", "400", "normal"]]) {
      const loaded = await document.fonts.load(`${style} ${weight} 16px "${fam}"`);
      const ok = loaded.some((f) => f.family.replace(/"/g, "") === fam && f.status === "loaded" && f.style === style);
      out.push(`${fam} ${weight} ${style}: ${ok ? "loaded" : `missing (${loaded.length} faces answered)`}`);
    }
    return out;
  });
  expect(faces.pop()).toMatch(/^No Such Family 400 normal: missing/);
  expect(faces.filter((f) => !f.endsWith(": loaded"))).toEqual([]);
  // Nothing else is declared: Source Sans 3 and Source Code Pro are gone.
  expect(await page.evaluate(() => [...new Set([...document.fonts].map((f) => f.family.replace(/"/g, "")))].sort())).toEqual(["Geist", "JetBrains Mono"]);

  // One variable file draws 400 and 600 differently in every engine (WebKit once drew a variable
  // face at its default instance only).
  const widths = await page.evaluate(() => ["400", "600"].map((weight) => {
    const s = document.createElement("span");
    s.textContent = "Waiting for input 42";
    s.style.cssText = `font: ${weight} 14px var(--font-ui); position: absolute; white-space: nowrap; visibility: hidden;`;
    document.body.append(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  }));
  expect(Math.abs(widths[1] - widths[0]), `400 vs 600 widths ${widths.join(" vs ")}`).toBeGreaterThan(1);

  const lig = () => page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontVariantLigatures);
  expect(await lig()).toBe("none");
  const before = await family(".cm-content");
  await page.locator("#settings-button").click();
  await page.getByLabel("Joined symbols in code").check();
  expect(await lig()).not.toBe("none");
  expect(await family(".cm-content"), "the same font, ligatures on").toBe(before);
  await expect(page.getByText("Off shows exactly what you type.")).toBeVisible();
  await page.getByLabel("Joined symbols in code").uncheck();
  expect(await lig()).toBe("none");
});

for (const scheme of SCHEMES) {
  test(`desktop ${scheme}: the editor and the panel are one sheet on --bg, 12 px corners and a 1 px edge, set 10 px into the --surface frame`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await signalIn(page, scheme);
    const p = SIGNAL[scheme];
    const edge = `1px solid ${rgbOf(p.border)}`;

    // The empty workspace: the sheet is rounded all round.
    const empty = await styleOf(page, ".editor-area", ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "border-top", "border-bottom", "border-left", "border-right", "background-color"]);
    expect(empty).toEqual({
      "border-top-left-radius": "12px", "border-top-right-radius": "12px", "border-bottom-left-radius": "12px", "border-bottom-right-radius": "12px",
      "border-top": edge, "border-bottom": edge, "border-left": edge, "border-right": edge, "background-color": rgbOf(p.bg),
    });

    await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
    await openFromTree(page, "main.py");
    expect((await run(page)).status).toBe("error");
    await openFromTree(page, "calc.py");

    // The frame: the main area and the editor column on --surface; no line under the top bar, none over the status bar.
    expect((await styleOf(page, ".main", ["background-color"]))["background-color"]).toBe(rgbOf(p.surface));
    expect(await styleOf(page, ".center", ["background-color", "padding-right", "padding-bottom", "padding-left", "padding-top"])).toEqual({
      "background-color": rgbOf(p.surface), "padding-right": "10px", "padding-bottom": "10px", "padding-left": "0px", "padding-top": "0px",
    });
    expect((await styleOf(page, ".topbar", ["border-bottom-width"]))["border-bottom-width"]).toBe("0px");
    expect((await styleOf(page, ".statusbar", ["box-shadow"]))["box-shadow"]).toBe("none");

    // The sheet: top corners on the editor area, bottom corners on the panel, one 1 px edge round both.
    expect(await styleOf(page, ".editor-area", ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "border-top", "border-left", "border-right", "border-bottom-width", "background-color"])).toEqual({
      "border-top-left-radius": "12px", "border-top-right-radius": "12px", "border-bottom-left-radius": "0px", "border-bottom-right-radius": "0px",
      "border-top": edge, "border-left": edge, "border-right": edge, "border-bottom-width": "0px", "background-color": rgbOf(p.bg),
    });
    expect(await styleOf(page, ".center > .panel", ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "border-top-width", "border-left", "border-right", "border-bottom"])).toEqual({
      "border-top-left-radius": "0px", "border-top-right-radius": "0px", "border-bottom-left-radius": "12px", "border-bottom-right-radius": "12px",
      "border-top-width": "0px", "border-left": edge, "border-right": edge, "border-bottom": edge,
    });
    // 10 px of --surface right of and below the sheet.
    const [center, area, panel] = [await boxOf(page, ".center"), await boxOf(page, ".editor-area"), await boxOf(page, ".center > .panel")];
    expect(Math.round(center.right - area.right)).toBe(10);
    expect(Math.round(center.right - panel.right)).toBe(10);
    expect(Math.round(center.bottom - panel.bottom)).toBe(10);
    expect(Math.round(area.left - center.left)).toBe(0);
    expect(Math.round(area.top - center.top)).toBe(0);

    // The editor head sits on the code's ground with a --border line under it.
    expect(await styleOf(page, ".editor-head", ["background-color", "border-bottom"])).toEqual({ "background-color": rgbOf(p.bg), "border-bottom": edge });

    // The file list | editor splitter shows no line, but stays a keyboard-operable separator with its focus ring.
    const splitter = page.getByRole("separator", { name: "Resize the file list" });
    expect((await styleOf(page, ".main > .splitter", ["background-color"]))["background-color"]).toBe("rgba(0, 0, 0, 0)");
    // Reached from the file list with Tab, so every engine draws its keyboard focus (:focus-visible).
    await page.locator('.tree [role=treeitem][tabindex="0"]').focus();
    await page.keyboard.press("Tab");
    await expect(splitter).toBeFocused();
    const width = Number(await splitter.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect(splitter).not.toHaveAttribute("aria-valuenow", String(width));
    expect(await splitter.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    expect((await styleOf(page, ".main > .splitter", ["background-color"]))["background-color"]).toBe(rgbOf(p.focus));
    await page.keyboard.press("ArrowLeft");
    await expect(splitter).toHaveAttribute("aria-valuenow", String(width));

    // The panel collapsed to its bar keeps the sheet's foot.
    await page.locator(".panel-toggle").click();
    await expect(page.locator(".center")).toHaveAttribute("data-panel", "collapsed");
    expect(await styleOf(page, ".center > .panel", ["border-bottom-left-radius", "border-bottom"])).toEqual({ "border-bottom-left-radius": "12px", "border-bottom": edge });
    const collapsed = await boxOf(page, ".center > .panel");
    expect(Math.round(center.bottom - collapsed.bottom)).toBe(10);
  });
}

test("desktop bars: top bar 48, editor head 44, panel bar 40, status bar 28, rows 30, icon buttons 30, Run 32; every target 24 or more", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
  await openFromTree(page, "main.py");
  const h = async (sel: string) => Math.round((await boxOf(page, sel)).height);
  expect(await h(".topbar")).toBe(48);
  expect(await h(".editor-head")).toBe(44);
  expect(await h(".sidebar-head")).toBe(44);
  expect(await h(".panel-bar")).toBe(40);
  expect(await h(".statusbar")).toBe(28);
  expect(await h(".tree-row")).toBe(30);
  expect(await h("#run-button")).toBe(32);
  expect(await h("#settings-button")).toBe(30);
  // WCAG 2.2 SC 2.5.8: every visible control on the page is 24 x 24 CSS px or more.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, [role=tab], [role=separator], input, select, a[href]")]
      .filter((el) => el.offsetParent !== null && !el.closest(".cm-editor, .visually-hidden, [hidden]") && el.getAttribute("type") !== "hidden")
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // A splitter is a 1 px line whose grab area is its 11 px ::after (an exception audit.ts records).
      .filter(({ el, r }) => r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) && !el.matches(".splitter"))
      .map(({ el, r }) => `${el.id || el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  expect(small).toEqual([]);
});

for (const scheme of SCHEMES) {
  test(`phone ${scheme}: no sheet, the 44 px targets kept, Signal's colours and fonts`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await signalIn(page, scheme);
    // The status bar's own height, before an import's notice can give it a second line.
    expect(Math.round((await boxOf(page, ".statusbar")).height)).toBe(24);
    await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
    await openFromTree(page, "main.py");
    const p = SIGNAL[scheme];
    expect(await styleOf(page, ".editor-area", ["border-top-left-radius", "border-top-width", "border-left-width"])).toEqual({ "border-top-left-radius": "0px", "border-top-width": "0px", "border-left-width": "0px" });
    expect(await styleOf(page, ".center", ["padding-right", "padding-bottom", "background-color"])).toEqual({ "padding-right": "0px", "padding-bottom": "0px", "background-color": rgbOf(p.bg) });
    const h = async (sel: string) => Math.round((await boxOf(page, sel)).height);
    expect(await h(".topbar")).toBe(48);
    expect(await h("#run-button")).toBe(44);
    expect(await h(".view-switch")).toBe(44);
    // The status bar's top edge: light draws a 2 px rule in the location blue, dark the 1 px divider.
    expect((await styleOf(page, ".statusbar", ["box-shadow"]))["box-shadow"]).toBe(scheme === "light" ? `${rgbOf(p.location)} 0px 2px 0px 0px inset` : `${rgbOf(p.divider)} 0px 1px 0px 0px inset`);
    expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Geist"?,/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll").toBe(true);
  });
}
