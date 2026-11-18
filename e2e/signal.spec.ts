// "ExecFlow Signal" (redesign 2, option a, chosen 2026-10-25), the default until Electric Blue
// (Workbench, 2026-11-18), and the default's first paint: Electric Blue now, painted before the
// app's code, the one-time move of both old defaults (Signal and Deep Field, match device) to it,
// the fonts (TASA Orbiter for the interface, Geist Mono for code with its ligatures off unless
// chosen), the desktop bar heights and the boards, with phones unchanged but for colours and fonts.
// Signal's own checks pin Signal (chosen, marked so it is never moved). Every themed test emulates
// the scheme, reloads and proves the scheme and the palette are active first.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, openThemePicker, run, showFiles, test, waitReady } from "./helpers";
import { decodePng, rgbOf } from "./pixels";

test.use({ serviceWorkers: "block" });

const MAIN = 'from calc import average\n\nmarks = [72, 85, 90]\nprint("Average:", average(marks))\nprint("Empty:", average([]))\n';
const CALC = "def average(values):\n    total = sum(values)\n    return total / len(values)\n";
type Scheme = "light" | "dark";
const SCHEMES: Scheme[] = ["light", "dark"];
/** The Signal colours these checks read, as designed (src/theme/palettes.ts SIGNAL, kept equal by contrast.test.ts). */
const SIGNAL = {
  light: { bg: "#ffffff", surface: "#eceef2", border: "#d6dbe2", divider: "#dde1e7", focus: "#0b6e80", location: "#2f5bea" },
  dark: { bg: "#15181d", surface: "#0b0d10", border: "#30363f", divider: "#262b33", focus: "#4fd1df", location: "#7ea2ff" },
} as const;
/**
 * The output panel's colours (Workbench Pro, 2026-10-29: the console is dark in both schemes): in
 * light, tokens.css paints the panel with SIGNAL_CONSOLE; in dark it is Signal dark's own. Kept
 * equal to palettes.ts by contrast.test.ts.
 */
const CONSOLE = {
  light: { "terminal-bg": "#12151a", "terminal-fg": "#e5e8ed", border: "#30363f" },
  dark: { "terminal-bg": "#0f1115", "terminal-fg": "#e5e8ed", border: "#30363f" },
} as const;

/** The Electric Blue colours these checks read (src/theme/palettes.ts ELECTRIC_BLUE; contrast.test.ts and themes.test.ts check them there). */
const ELECTRIC = {
  light: { bg: "#f4f4f6", surface: "#ffffff" },
  dark: { bg: "#0c0c0e", surface: "#141417" },
} as const;

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Chooses Signal (match device) as a student would in this build: saved, and marked so it is never moved. */
async function chooseSignal(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem("codeeditor:theme", "signal");
    localStorage.setItem("codeeditor:theme-default", "electric-blue");
    localStorage.setItem("codeeditor:theme-paint", JSON.stringify({ system: true, scheme: "light", palette: "signal", colors: null }));
  });
}

/** Chooses Signal, emulates the scheme, reloads, and proves Signal is what is painted. */
async function signalIn(page: Page, scheme: Scheme) {
  await chooseSignal(page);
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

test("Electric Blue is the default, light and dark, and theme-boot.js paints it before the app's code (no flash)", async ({ page }) => {
  await openApp(page);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await waitReady(page);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme emulated").toBe(scheme === "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", "electric-blue");
    await reloadHeld(page, async () => {
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-palette", "electric-blue");
      await expect(html).toHaveAttribute("data-theme", scheme);
      expect(await bodyBg(page)).toBe(rgbOf(ELECTRIC[scheme].bg));
      // The browser's toolbar colour is Electric Blue's chrome too, per scheme.
      expect(await page.locator('meta[name="theme-color"]').evaluateAll((m) => m.map((x) => x.getAttribute("content")))).toEqual([ELECTRIC.light.surface, ELECTRIC.dark.surface]);
    });
  }
});

// The owner's call, 2026-11-18: "New default, move Signal users (Recommended)".
for (const [label, before] of [
  ["Signal, marked by a Signal build", { theme: "signal", seen: "signal", palette: "signal" }],
  ["Deep Field, never marked (saved before Signal)", { theme: "deep-field", seen: null, palette: "deep-field" }],
] as const) {
  test(`a device on an old default (${label}, match device) moves to Electric Blue once, with no flash; chosen again it stays`, async ({ page }) => {
    await openApp(page);
    await page.emulateMedia({ colorScheme: "dark" });
    // What the earlier build left on a device that never chose a theme, or chose the default.
    await page.evaluate((b) => {
      localStorage.setItem("codeeditor:theme", b.theme);
      localStorage.setItem("codeeditor:theme-paint", JSON.stringify({ system: true, scheme: "dark", palette: b.palette, colors: null }));
      if (b.seen) localStorage.setItem("codeeditor:theme-default", b.seen);
      else localStorage.removeItem("codeeditor:theme-default");
    }, before);
    await reloadHeld(page, async () => {
      await expect(page.locator("html")).toHaveAttribute("data-palette", "electric-blue");
      expect(await bodyBg(page)).toBe(rgbOf(ELECTRIC.dark.bg));
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", "electric-blue");
    expect(await page.evaluate(() => [localStorage.getItem("codeeditor:theme"), localStorage.getItem("codeeditor:theme-default")])).toEqual(["electric-blue", "electric-blue"]);

    // The old default's "match device", chosen in the theme picker after the move, is kept across reloads.
    const picker = await openThemePicker(page);
    const name = before.theme === "signal" ? "ExecFlow Signal (match device)" : "ExecFlow Deep Field (match device)";
    await picker.getByRole("radio", { name }).check();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await reloadHeld(page, async () => {
      if (before.theme === "signal") {
        await expect(page.locator("html")).toHaveAttribute("data-palette", "signal");
        expect(await bodyBg(page)).toBe(rgbOf(SIGNAL.dark.bg));
      } else {
        await expect(page.locator("html")).not.toHaveAttribute("data-palette");
        expect(await bodyBg(page)).toBe("rgb(19, 32, 27)"); // Deep Field's dark field #13201b
      }
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", before.theme);
  });
}

// Workbench Pro S4 (owner's go-ahead 2026-10-30): the picker's first row is "Start here", the
// redesign4 picker study's curated row (the default, Slate, High contrast, GitHub-style, Tokyo
// Night, Catppuccin, as families). Electric Blue leads since 2026-11-18, chosen, with its three
// forms and the Default mark; Signal moves to the A to Z list beside Deep Field.
test("the theme picker leads with Electric Blue (the default, chosen) and High contrast; Signal and Deep Field are in the A to Z list", async ({ page }) => {
  await openApp(page);
  const picker = await openThemePicker(page);
  const upFront = picker.locator('.theme-section[data-section="start"] [data-theme-option]');
  expect((await upFront.evaluateAll((els) => els.map((e) => e.getAttribute("data-theme-option")))).slice(0, 3)).toEqual(["electric-blue", "electric-blue-light", "electric-blue-dark"]);
  await expect(picker.locator('.theme-section[data-section="start"] [data-theme-option="high-contrast"]')).toHaveCount(1);
  await expect(picker.getByRole("radio", { name: /^ExecFlow Electric Blue \(match device\)/ })).toBeChecked();
  await expect(picker.locator('[data-theme-family="electric-blue"] .family-head .tag')).toHaveText("Default");
  const rest = picker.locator('.theme-section[data-section="all"]');
  for (const id of ["signal", "signal-light", "signal-dark", "deep-field", "deep-field-light", "deep-field-dark"]) await expect(rest.locator(`[data-theme-option="${id}"]`)).toHaveCount(1);
});

// Since Workbench Pro S4 a family has one preview, of its chosen variant (or the one pointed at):
// the Signal tile shows "match device" (chosen) and follows the device; pointing at Light shows
// Light's own colours whatever the device's scheme.
test("a 'match device' preview redraws when the device switches scheme with the picker open, and keeps the focus; a fixed variant keeps its scheme", async ({ page }) => {
  await openApp(page);
  await signalIn(page, "light");
  const picker = await openThemePicker(page);
  const prev = picker.locator('[data-theme-family="signal"] .tile-prev');
  const tileBg = () => prev.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--tile-bg"));
  expect(await tileBg()).toBe(SIGNAL.light.bg);
  const radio = picker.getByRole("radio", { name: /^ExecFlow Signal \(match device\)/ });
  await expect(radio).toBeFocused();
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(prev).toHaveAttribute("data-variant", "signal");
    await expect.poll(tileBg).toBe(SIGNAL[scheme].bg);
    await expect(radio).toBeFocused();
  }
  await picker.locator('[data-theme-option="signal-dark"]').hover();
  await expect(prev).toHaveAttribute("data-variant", "signal-dark");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    expect(await tileBg(), "a fixed variant keeps its own scheme").toBe(SIGNAL.dark.bg);
  }
  await expect(radio).toBeFocused();
});

test("fonts: TASA Orbiter and Geist Mono load at every weight used and the weights differ; ligatures stay off unless chosen, which changes ligatures only", async ({ page, browserName }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  await expect(page.locator(".cm-content")).toContainText("#include");
  const family = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await family("body")).toMatch(/^"?TASA Orbiter"?,/);
  expect(await family(".cm-content")).toMatch(/^"?Geist Mono"?,/);
  expect(await family(".tab-name")).toMatch(/^"?Geist Mono"?,/);
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");

  const faces = await page.evaluate(async () => {
    const want = [["TASA Orbiter", "400", "normal"], ["TASA Orbiter", "500", "normal"], ["TASA Orbiter", "600", "normal"], ["Geist Mono", "400", "normal"], ["Geist Mono", "400", "italic"], ["Geist Mono", "600", "normal"]];
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
  // Nothing else is declared: Geist and JetBrains Mono (and before them Source Sans 3 and Source Code Pro) are gone.
  expect(await page.evaluate(() => [...new Set([...document.fonts].map((f) => f.family.replace(/"/g, "")))].sort())).toEqual(["Geist Mono", "TASA Orbiter"]);

  // One variable file draws 400 and 600 differently in every engine (WebKit once drew a variable
  // face at its default instance only). TASA Orbiter keeps nearly the same advance at every weight
  // (400 and 600 measured 0.19 px apart over 20 characters), so the check counts the ink the page
  // itself draws (a screenshot of real text, not a canvas).
  const inkOf = async (family: string, weight: string) => {
    await page.evaluate(([f, w]) => {
      const s = document.createElement("div");
      s.id = "ink-probe";
      s.textContent = "Waiting for input 42";
      s.style.cssText = `font: ${w} 20px ${f}; position: fixed; top: 0; left: 0; z-index: 99999; padding: 4px; background: #fff; color: #000; white-space: nowrap;`;
      document.body.append(s);
    }, [family, weight]);
    const shot = decodePng(await page.locator("#ink-probe").screenshot({ animations: "disabled" }));
    let sum = 0;
    for (let y = 0; y < shot.height; y++) for (let x = 0; x < shot.width; x++) sum += 255 - Math.min(...shot.at(x, y));
    await page.evaluate(() => document.getElementById("ink-probe")!.remove());
    return Math.round(sum / 255);
  };
  const ui = [await inkOf("var(--font-ui)", "400"), await inkOf("var(--font-ui)", "600")];
  // The control: Geist Mono, the other variable file. Playwright's WebKit on Windows draws every
  // variable face's outlines at one instance (measured 2026-11-18: Geist Mono, and the Geist this
  // replaced, gave the same ink at 400 and 600; only Geist's advances moved). There the UI check
  // can't be made, so it is noted, and only WebKit may take that way out.
  const code = [await inkOf("var(--font-code)", "400"), await inkOf("var(--font-code)", "600")];
  if (code[1]! / code[0]! < 1.05) {
    expect(browserName, `only WebKit draws one instance (code ink ${code.join(" vs ")})`).toBe("webkit");
    test.info().annotations.push({ type: "weights not drawn", description: `this WebKit draws variable outlines at one instance: UI ink ${ui.join(" vs ")}, code ink ${code.join(" vs ")}` });
  } else {
    expect(ui[1]! / ui[0]!, `400 vs 600 ink ${ui.join(" vs ")}`).toBeGreaterThan(1.15);
  }

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
  test(`desktop ${scheme}: Workbench from 1100 px, flush panes split by 1 px hairlines: the code (over its console) and the chart on --bg, the chrome on --surface`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await signalIn(page, scheme);
    const p = SIGNAL[scheme];
    const c = CONSOLE[scheme];
    const corners = ["border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius"];
    const square = Object.fromEntries(corners.map((k) => [k, "0px"]));
    const hairline = (shadow: string) => expect(shadow, "a 1 px --divider hairline").toContain(`${rgbOf(p.divider)} 0px`);

    // The empty workspace (Workbench, .claude/design/editor9/a): no cards, no canvas round them;
    // the code pane is flush, square, on the code's ground, and the run strip is its foot.
    expect((await page.locator(".center").evaluate((el) => getComputedStyle(el, "::before").content))).toBe("none");
    expect(await styleOf(page, ".editor-area", [...corners, "border-top-width", "background-color"])).toEqual({ ...square, "border-top-width": "0px", "background-color": rgbOf(p.bg) });
    await expect(page.locator(".center > .panel > .run-strip")).toBeVisible();
    await expect(page.locator("#chart-board")).toBeHidden();

    await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
    await openFromTree(page, "main.py");
    expect((await run(page)).status).toBe("error");
    await openFromTree(page, "calc.py");

    // The chrome: the main area, the top bar (a hairline under it) and the mono status bar (a
    // hairline over it) on --surface; the boards' area on the code's ground with no padding and no
    // column gap (the 9 px board splitter is its own column).
    expect((await styleOf(page, ".main", ["background-color"]))["background-color"]).toBe(rgbOf(p.surface));
    expect(await styleOf(page, ".center", ["background-color", "padding-right", "padding-bottom", "padding-left", "padding-top", "column-gap"])).toEqual({
      "background-color": rgbOf(p.bg), "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px", "padding-top": "0px", "column-gap": "0px",
    });
    const top = await styleOf(page, ".topbar", ["background-color", "box-shadow", "border-bottom-width"]);
    expect(top["background-color"]).toBe(rgbOf(p.surface));
    hairline(top["box-shadow"]);
    await expect(page.locator(".workbench > .statusbar")).toBeVisible();
    const foot = await styleOf(page, ".workbench > .statusbar", ["background-color", "box-shadow"]);
    expect(foot["background-color"]).toBe(rgbOf(p.surface));
    hairline(foot["box-shadow"]);
    const [codeBox, chartBox] = [(await page.locator("#editor-area").boundingBox())!, (await page.locator("#chart-board").boundingBox())!];
    expect(Math.round(chartBox.x - (codeBox.x + codeBox.width)), "the 9 px board splitter between the panes").toBe(9);

    // Flush panes: square corners, no edge and no shadow of their own; one soft shadow is kept for
    // floating things (menus, dialogs).
    for (const sel of [".editor-area", "#chart-board", ".center > .panel"]) {
      const { "box-shadow": shadow, ...shape } = await styleOf(page, sel, [...corners, "border-top-width", "border-left-width", "box-shadow"]);
      expect(shape, sel).toEqual({ ...square, "border-top-width": "0px", "border-left-width": "0px" });
      // Only inset hairlines (no blur): "<colour> 0px 0px 0px 1px inset" or none.
      for (const part of shadow === "none" ? [] : shadow.split(/,(?![^(]*\))/)) expect(part, `${sel}: no drop shadow`).toMatch(/inset/);
    }
    expect((await styleOf(page, ".editor-area", ["background-color"]))["background-color"]).toBe(rgbOf(p.bg));
    // The panel's ground, the program's text and the browser's own controls and scrollbars in it, in
    // the console's colours. From 1100 px (Flow Board S2) the console is the code board's foot, so in
    // light it is Signal light's own light console, not Workbench Pro's dark card (still the
    // console under 1100 px: CONSOLE.light, flow-board.spec.ts).
    const wide = scheme === "light" ? { "terminal-bg": "#f4f5f8", "terminal-fg": "#16191d", "color-scheme": "light" } : { ...c, "color-scheme": "dark" };
    expect(await styleOf(page, ".center > .panel", ["background-color", "color-scheme"])).toEqual({ "background-color": rgbOf(wide["terminal-bg"]), "color-scheme": wide["color-scheme"] });
    expect((await styleOf(page, "#panel-output .console", ["color"])).color).toBe(rgbOf(wide["terminal-fg"]));
    // The chart's ground: its own tone with the static dot grid, on the stage only.
    const stage = await styleOf(page, "#chart-board .fc-stage", ["background-color", "background-image", "animation-name"]);
    expect(stage["background-color"]).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    expect(stage["background-image"]).toMatch(/^radial-gradient\(/);
    expect(stage["animation-name"]).toBe("none");
    expect((await styleOf(page, ".editor-area", ["background-image"]))["background-image"]).toBe("none");
    // Flush to the boards' area: the chart pane to its right and bottom edges, the code at its left
    // and top, equal panes (the 9 px splitter between); the console under the code with the 1 px
    // splitter line (its 24 px target is its ::after) between them.
    const [center, area, panel, chart] = [await boxOf(page, ".center"), await boxOf(page, ".editor-area"), await boxOf(page, ".center > .panel"), await boxOf(page, "#chart-board")];
    expect(Math.round(center.right - chart.right)).toBe(0);
    expect(Math.round(center.bottom - chart.bottom)).toBe(0);
    expect(Math.round(center.bottom - panel.bottom)).toBe(0);
    expect(Math.round(area.left - center.left)).toBe(0);
    expect(Math.round(area.top - center.top)).toBe(0);
    expect(Math.round(chart.top - center.top)).toBe(0);
    expect(Math.round(panel.top - area.bottom), "the 1 px splitter between the code and its console").toBe(1);
    expect(Math.abs(chart.width - area.width), "two equal panes").toBeLessThan(1);

    // The tab bar is chrome: --surface with a hairline under it.
    const head = await styleOf(page, ".editor-head", ["background-color", "box-shadow"]);
    expect(head["background-color"]).toBe(rgbOf(p.surface));
    hairline(head["box-shadow"]);

    // The console hidden to its head still docks at the code's foot, the chart pane beside it.
    await page.locator(".panel-toggle").click();
    await expect(page.locator(".center")).toHaveAttribute("data-panel", "collapsed");
    const [collapsed, code, still] = [await boxOf(page, ".center > .panel"), await boxOf(page, ".editor-area"), await boxOf(page, "#chart-board")];
    expect(Math.round(center.bottom - collapsed.bottom)).toBe(0);
    expect(Math.round(collapsed.top - code.bottom), "the splitter's line above it").toBe(1);
    expect(Math.round(code.right), "the code keeps its pane's width").toBe(Math.round(area.right));
    expect(Math.round(still.left)).toBe(Math.round(chart.left));

    // The file list | editor splitter shows no line of its own under 1100 px, but stays a
    // keyboard-operable separator with its focus ring.
    await page.setViewportSize({ width: 1000, height: 800 });
    const splitter = page.getByRole("separator", { name: "Resize the file list" });
    // The layout crosses 1100 px a frame after the resize in WebKit: wait for the column's splitter
    // and for About in the sidebar's foot.
    await expect(splitter).toBeVisible();
    await expect(page.locator(".sidebar-foot #about-link")).toBeVisible();
    expect((await styleOf(page, ".main > .splitter", ["background-color"]))["background-color"]).toBe("rgba(0, 0, 0, 0)");
    // Reached with Tab, so every engine draws its keyboard focus (:focus-visible). The sidebar's foot
    // (sync, About) follows the tree; About is its last stop (Workbench Pro).
    await page.locator("#about-link").focus();
    await page.keyboard.press("Tab");
    await expect(splitter).toBeFocused();
    const width = Number(await splitter.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect(splitter).not.toHaveAttribute("aria-valuenow", String(width));
    expect(await splitter.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    expect((await styleOf(page, ".main > .splitter", ["background-color"]))["background-color"]).toBe(rgbOf(p.focus));
    await page.keyboard.press("ArrowLeft");
    await expect(splitter).toHaveAttribute("aria-valuenow", String(width));
  });
}

test("desktop bars: at 1000 px top bar 56, editor head 44, Files head 36, console head 44, no status bar, rows 32, rail buttons 60 wide, Run 32; from 1100 px the Workbench's compact bars; every target 24 or more", async ({ page }) => {
  // Measured at 1000 px, then at 1440 (Workbench) below.
  await page.setViewportSize({ width: 1000, height: 800 });
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "calc.py", text: CALC }]);
  await openFromTree(page, "main.py");
  const h = async (sel: string) => Math.round((await boxOf(page, sel)).height);
  // Workbench Pro (S2, tokens.md "Bars"): the sidebar's top row is the workspace switcher, as tall
  // as the 56 px top bar (--h-topbar); the "Files" heading is a 36 px row (app.css .sidebar-head);
  // the console's head is 44 like the code card's; tree rows are 32 (--h-row); the status bar is
  // gone on desktop; the rail's buttons are 60 px wide, at least 48 tall (an icon over its word).
  expect(await h(".topbar")).toBe(56);
  expect(await h(".ws-switcher")).toBe(56);
  expect(await h(".editor-head")).toBe(44);
  expect(await h(".sidebar-head")).toBe(36);
  expect(await h(".panel-bar")).toBe(44);
  await expect(page.locator(".statusbar")).toBeHidden();
  expect(await h(".tree-row")).toBe(32);
  expect(await h("#run-button")).toBe(32);
  const settings = await boxOf(page, "#settings-button");
  expect(Math.round(settings.width)).toBe(60);
  expect(Math.round(settings.height)).toBeGreaterThanOrEqual(48);
  // WCAG 2.2 SC 2.5.8: every visible control on the page is 24 x 24 CSS px or more.
  const small = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, [role=tab], [role=separator], input, select, a[href]")]
        .filter((el) => el.offsetParent !== null && !el.closest(".cm-editor, .visually-hidden, [hidden]") && el.getAttribute("type") !== "hidden")
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        // A splitter is a 1 px line whose grab area is its 11 px ::after (an exception audit.ts records).
        .filter(({ el, r }) => r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) && !el.matches(".splitter"))
        .map(({ el, r }) => `${el.id || el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`),
    );
  expect(await small()).toEqual([]);
  // From 1100 px (Workbench, the mock's compact chrome): a 44 px top bar, 38 px tab and Files heads,
  // a 48 px run strip with Run 32, a 34 px console head, a 26 px status bar, 26 px tree rows and a
  // 48 px icon rail; every target still 24 px or more.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".workbench > .statusbar")).toBeVisible();
  expect(await h(".topbar")).toBe(44);
  expect(await h(".editor-head")).toBe(38);
  expect(await h(".sidebar-head")).toBe(38);
  expect(await h(".run-strip")).toBe(48);
  expect(await h(".run-strip > #run-button")).toBe(32);
  expect(await h(".panel-bar")).toBe(34);
  expect(await h(".workbench > .statusbar")).toBe(26);
  expect(Math.round((await boxOf(page, ".rail")).width)).toBe(48);
  await showFiles(page);
  expect(await h(".tree-row")).toBe(26);
  expect(await small()).toEqual([]);
});

for (const scheme of SCHEMES) {
  test(`phone ${scheme}: no sheet, the 44 px targets kept, Signal's colours and the fonts`, async ({ page }) => {
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
    expect(await h(".topbar")).toBe(56);
    // Run floats over the board, 52 px (Workbench stage 4, editor option A's phone frame).
    expect(await h("#run-button")).toBe(52);
    // The dock at the foot: 48 px tabs in a 64 px bar, on the status bar's line, which ends the
    // screen.
    expect(await h(".view-switch")).toBe(48);
    expect(await h(".view-bar")).toBe(64);
    expect(Math.round((await boxOf(page, ".view-bar")).bottom)).toBe(Math.round((await boxOf(page, ".statusbar")).top));
    expect(Math.round((await boxOf(page, ".statusbar")).bottom)).toBe(844);
    // The status bar's top edge: light draws a 2 px rule in the location blue, dark the 1 px divider.
    expect((await styleOf(page, ".statusbar", ["box-shadow"]))["box-shadow"]).toBe(scheme === "light" ? `${rgbOf(p.location)} 0px 2px 0px 0px inset` : `${rgbOf(p.divider)} 0px 1px 0px 0px inset`);
    expect(await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?TASA Orbiter"?,/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll").toBe(true);
  });
}
