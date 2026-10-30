// The theme picker (Workbench Pro S4, owner's go-ahead 2026-10-30): Settings > Appearance itself
// (owner, 2026-10-30: "Inside Settings"). The picker shows the 45
// built-in themes as 22 family tiles, each with a code preview in its own colours (every syntax
// colour, the failed line, Run) and its variants as native radios, all one group (name=theme, value
// = the theme id stored as before). A search field and a Light/Dark/All filter narrow the tiles; the
// first row is curated ("Start here"), the rest follow A to Z.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, openApp, openThemePicker, test, waitReady } from "./helpers";

test.use({ serviceWorkers: "block" });

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ALL_FAMILIES = 22;
/** src/theme/themes.ts BUILT_IN: Signal, Deep Field and Slate in 3 forms each, and 36 palette themes. */
const BUILT_IN_THEMES = 45;
const START_HERE = ["signal", "slate", "high-contrast", "github", "tokyo-night", "catppuccin"];

const family = (dialog: Locator, id: string) => dialog.locator(`.theme-family[data-theme-family="${id}"]`);
const radio = (dialog: Locator, id: string) => dialog.locator(`input[name=theme][value="${id}"]`);
const visibleFamilies = (dialog: Locator) =>
  dialog.locator(".theme-family").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e as HTMLElement).dataset.themeFamily ?? ""));
const visibleVariants = (tile: Locator) =>
  tile.locator("input[name=theme]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e as HTMLInputElement).value));

test("the picker is Settings > Appearance itself: no second dialog, focus on the chosen theme, and Escape closes Settings back to the gear", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const appearance = settings.locator("#settings-appearance");
  await expect(appearance.locator("#theme-picker")).toBeVisible();
  await expect(appearance.locator("input[name=theme][value=signal]")).toBeFocused();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(settings.getByRole("button", { name: "Change theme" })).toHaveCount(0);
  // The tool row stays at the top of Settings' scroller while the tiles scroll under it.
  const body = settings.locator(".dialog-body");
  await body.evaluate((el) => (el.scrollTop = 600));
  const [tools, pane] = [await box(page, "#theme-picker .theme-tools"), await box(page, "#settings .dialog-body")];
  expect(Math.abs(tools.y - pane.y), "the tools are held at the pane's top").toBeLessThan(2);
  await settings.getByRole("radio", { name: "ExecFlow Slate Dark", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.locator("#settings-button")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "slate-dark");
});

test("themes are family tiles with a code preview, and every variant is a native radio in one group", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  const group = dialog.getByRole("radiogroup", { name: "Colour theme" });
  await expect(group).toBeVisible();
  // One group of native radios holds all 45 built-in themes, each with its stored id as its value.
  const radios = group.locator('input[type="radio"][name="theme"]');
  await expect(radios).toHaveCount(BUILT_IN_THEMES);
  expect(await page.locator('input[name="theme"]').count(), "no theme radio outside the group").toBe(BUILT_IN_THEMES);
  await expect(dialog.locator(".theme-family")).toHaveCount(ALL_FAMILIES);
  // A tile: the family's name, its schemes in words, the preview, then its variants.
  const catppuccin = family(dialog, "catppuccin");
  await expect(catppuccin.locator(".family-name")).toHaveText("Catppuccin");
  await expect(catppuccin.locator(".family-schemes")).toHaveText("Light and dark");
  expect(await catppuccin.locator(".theme-option").allTextContents()).toEqual(["Mocha", "Macchiato", "Frappe", "Latte"]);
  await expect(catppuccin.getByRole("radio", { name: "Catppuccin Latte", exact: true })).toHaveAttribute("value", "catppuccin-latte");
  // A name keeps the theme's own name and holds what its button shows (label in name).
  await expect(dialog.getByRole("radio", { name: "Dracula, Dark", exact: true })).toHaveAttribute("value", "dracula");
  await expect(dialog.getByRole("radio", { name: "ExecFlow Slate Dark", exact: true })).toHaveAttribute("value", "slate-dark");
  await expect(family(dialog, "signal").locator(".family-head .tag")).toHaveText("Default");
  // The preview: hidden from assistive technology, six lines of code, one failed, and Run.
  const prev = family(dialog, "signal").locator(".tile-prev");
  await expect(prev).toHaveAttribute("aria-hidden", "true");
  await expect(prev.locator(".tp-ln")).toHaveCount(6);
  await expect(prev.locator(".tp-ln.is-band")).toHaveCount(1);
  await expect(prev.locator(".tp-run")).toHaveText("Run");
  for (const role of ["keyword", "string", "number", "comment", "function", "type", "variable", "operator", "macro", "punctuation"]) {
    expect(await prev.locator(`[data-role="${role}"]`).count(), `${role} drawn`).toBeGreaterThan(0);
  }
  // No CodeMirror in the picker: the previews are plain spans.
  await expect(dialog.locator(".cm-editor")).toHaveCount(0);
});

test("the first row is curated, the rest follow A to Z, and a family's preview shows its chosen variant", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  const start = dialog.locator('.theme-section[data-section="start"]');
  await expect(start.getByRole("heading", { name: "Start here" })).toBeVisible();
  expect(await start.locator(".theme-family").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.themeFamily))).toEqual(START_HERE);
  const all = dialog.locator('.theme-section[data-section="all"]');
  await expect(all.getByRole("heading", { name: "All families, A to Z" })).toBeVisible();
  const rest = await all.locator(".theme-family .family-name").allTextContents();
  expect(rest).toHaveLength(ALL_FAMILIES - START_HERE.length);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
  expect(rest[0]).toBe("Ayu");
  const tile = family(dialog, "catppuccin");
  const ground = () => tile.locator(".tile-prev").evaluate((el) => getComputedStyle(el).backgroundColor);
  const mocha = await ground();
  await tile.getByRole("radio", { name: "Catppuccin Latte", exact: true }).check();
  await expect.poll(ground).not.toBe(mocha);
  expect(await tile.locator(".tile-prev").getAttribute("data-variant")).toBe("catppuccin-latte");
});

test("keyboard: focus starts on the chosen theme, arrows choose the next variant at once, Tab leaves the group, and focus is visible", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  const signal = radio(dialog, "signal");
  await expect(signal).toBeChecked();
  await expect(signal).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(radio(dialog, "signal-light")).toBeFocused();
  await expect(radio(dialog, "signal-light")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "signal-light");
  // The focused variant's button shows the ring (keyboard focus).
  const ring = await dialog.locator('[data-theme-option="signal-light"]').evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring.outline).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("ArrowLeft");
  await expect(radio(dialog, "signal")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "signal");
  // Tab goes past the other 44 radios to the next control.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name ?? "")).not.toBe("theme");
  // The filter and the search field come before the group, and before them Settings' scrolling body
  // (a region the keyboard can scroll, dialogs.ts watchScroll).
  await signal.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("radio", { name: "All", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("searchbox", { name: "Search themes" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(".dialog-body")).toBeFocused();
});

test("search narrows the tiles, says how many match, and an empty result offers to clear it", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  const search = dialog.getByRole("searchbox", { name: "Search themes" });
  const count = dialog.locator("#theme-count");
  await expect(count).toHaveText(`${ALL_FAMILIES} of ${ALL_FAMILIES} families`);
  await expect(count).toHaveAttribute("role", "status");
  await search.fill("latte");
  await expect.poll(() => visibleFamilies(dialog)).toEqual(["catppuccin"]);
  await expect(count).toHaveText(`1 of ${ALL_FAMILIES} families`);
  // A section with nothing to show goes, heading and all.
  await expect(dialog.locator('.theme-section[data-section="all"]')).toBeHidden();
  await search.fill("night");
  await expect.poll(() => visibleFamilies(dialog)).toEqual(["tokyo-night", "night-owl", "nightfox"]);
  // Nothing matches: the empty state names the search and clears it; focus goes back to the field.
  await search.fill("zzz");
  await expect.poll(() => visibleFamilies(dialog)).toEqual([]);
  const empty = dialog.locator(".theme-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No theme matches "zzz".');
  await expect(count).toHaveText(`0 of ${ALL_FAMILIES} families`);
  await empty.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(empty).toBeHidden();
  await expect.poll(async () => (await visibleFamilies(dialog)).length).toBe(ALL_FAMILIES);
  // Escape in a filled field clears it and keeps Settings open; the next Escape closes it.
  await search.fill("nord");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(dialog).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toBeHidden();
  // Settings opens again with the search cleared.
  await page.locator("#theme-search").evaluate((el) => ((el as HTMLInputElement).value = "stale"));
  await openThemePicker(page);
  await expect(search).toHaveValue("");
});

test("the Light / Dark / All filter shows the variants of that scheme, match device in both, and never hides the chosen one", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  const filter = dialog.getByRole("group", { name: "Show" });
  await expect(filter.getByRole("radio", { name: "All", exact: true })).toBeChecked();
  await filter.getByRole("radio", { name: "Light", exact: true }).check();
  await expect.poll(() => visibleFamilies(dialog)).not.toContain("dracula");
  expect(await visibleFamilies(dialog)).toHaveLength(14);
  expect(await visibleVariants(family(dialog, "catppuccin"))).toEqual(["catppuccin-latte"]);
  // Signal is chosen (match device): its Dark is hidden, Match device and Light stay.
  expect(await visibleVariants(family(dialog, "signal"))).toEqual(["signal", "signal-light"]);
  // The preview shows a variant that is offered: Latte's colours in Catppuccin's tile.
  expect(await family(dialog, "catppuccin").locator(".tile-prev").getAttribute("data-variant")).toBe("catppuccin-latte");
  await filter.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect.poll(() => visibleFamilies(dialog)).toContain("dracula");
  expect(await visibleFamilies(dialog), "every family has a dark variant or follows the device").toHaveLength(ALL_FAMILIES);
  expect(await visibleVariants(family(dialog, "catppuccin"))).toEqual(["catppuccin-mocha", "catppuccin-macchiato", "catppuccin-frappe"]);
  // A chosen light theme stays on show under Dark.
  await filter.getByRole("radio", { name: "All", exact: true }).check();
  await radio(dialog, "signal-light").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "signal-light");
  await filter.getByRole("radio", { name: "Dark", exact: true }).check();
  expect(await visibleVariants(family(dialog, "signal"))).toEqual(["signal", "signal-light", "signal-dark"]);
  await filter.getByRole("radio", { name: "All", exact: true }).check();
  await expect.poll(async () => (await visibleFamilies(dialog)).length).toBe(ALL_FAMILIES);
  // Search and filter together.
  await dialog.getByRole("searchbox", { name: "Search themes" }).fill("rose");
  await filter.getByRole("radio", { name: "Light", exact: true }).check();
  await expect.poll(() => visibleFamilies(dialog)).toEqual(["rose-pine"]);
  expect(await visibleVariants(family(dialog, "rose-pine"))).toEqual(["rose-pine-dawn"]);
});

test("choosing a theme applies it at once and keeps it across a reload; the picker then opens on it", async ({ page }) => {
  await openApp(page);
  const dialog = await openThemePicker(page);
  await dialog.getByRole("radio", { name: "Dracula, Dark", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "dracula");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "palette");
  expect(await page.evaluate(() => localStorage.getItem("codeeditor:theme"))).toBe("dracula");
  await page.reload();
  await waitReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "dracula");
  await openThemePicker(page);
  await expect(radio(dialog, "dracula")).toBeChecked();
  await expect(radio(dialog, "dracula")).toBeFocused();
  await expect(radio(dialog, "dracula")).toBeInViewport();
  // A click on a preview chooses the variant it shows.
  await family(dialog, "nord").locator(".tile-prev").click();
  await expect(radio(dialog, "nord")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "nord");
});

/** Every non-blank piece of text in a preview against the ground it is painted on (bands composited). */
function previewContrast(prev: Locator) {
  return prev.evaluate((root) => {
    const rgba = (s: string) => {
      const m = s.match(/[\d.]+/g)!.map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const ch = (v: number) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    };
    const groundOf = (el: Element) => {
      const stack: ReturnType<typeof rgba>[] = [];
      for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c.a > 0) stack.unshift(c);
        if (c.a === 1) break;
      }
      let g = stack[0];
      for (const top of stack.slice(1)) g = { r: top.r * top.a + g.r * (1 - top.a), g: top.g * top.a + g.g * (1 - top.a), b: top.b * top.a + g.b * (1 - top.a), a: 1 };
      return g;
    };
    const out: { text: string; ratio: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement!;
      const fg = rgba(getComputedStyle(el).color);
      const [a, b] = [lum(fg), lum(groundOf(el))].sort((x, y) => y - x);
      out.push({ text: n.textContent, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
    }
    return out;
  });
}

test("every preview's text reads at 4.5:1 or more in each of the 45 themes, measured as drawn", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const dialog = await openThemePicker(page);
  const ids = await dialog.locator("input[name=theme]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(ids).toHaveLength(BUILT_IN_THEMES);
  const low: string[] = [];
  for (const id of ids) {
    await radio(dialog, id).check();
    const prev = dialog.locator(`.theme-family:has(input[value="${id}"]) .tile-prev`);
    await expect(prev).toHaveAttribute("data-variant", id);
    const pairs = await previewContrast(prev);
    expect(pairs.length, `${id}: text measured`).toBeGreaterThan(30);
    for (const p of pairs) if (p.ratio < 4.5) low.push(`${id}: "${p.text}" ${p.ratio}`);
  }
  expect(low).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the picker passes axe with Signal ${scheme}, at 1440 and 390, the empty state included`, async ({ page }) => {
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await openApp(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await waitReady(page);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(scheme === "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const dialog = await openThemePicker(page);
      const scan = async (what: string) => {
        const axe = await new AxeBuilder({ page }).include("#theme-picker").withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${size.width} ${what} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(", ")}`)).toEqual([]);
      };
      await scan("all");
      await dialog.getByRole("searchbox", { name: "Search themes" }).fill("zzz");
      await expect(dialog.locator(".theme-empty")).toBeVisible();
      await scan("empty");
      // The first Escape clears the search, the second closes Settings.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
}

for (const width of [390, 320]) {
  test(`phone layout at ${width} px: one tile per row, the tools fit, nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openApp(page);
    const dialog = await openThemePicker(page);
    const body = dialog.locator(".dialog-body");
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth), "Settings' body does not scroll sideways").toBeLessThanOrEqual(0);
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth), "nor Settings").toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // One column of tiles, each as wide as the list.
    const boxes = await dialog.locator(".theme-section[data-section=start] .theme-family").evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom - 1);
    expect(Math.abs(boxes[1].left - boxes[0].left)).toBeLessThan(1);
    // Search, filter and count sit inside the picker, and every variant button is 24 px or more.
    const d = await box(page, "#theme-picker");
    for (const sel of ["#theme-search", ".theme-filter", "#theme-count"]) {
      const b = await box(page, `#theme-picker ${sel}`);
      expect(b.x, sel).toBeGreaterThanOrEqual(d.x);
      expect(b.x + b.width, sel).toBeLessThanOrEqual(d.x + d.width);
    }
    const sizes = await dialog.locator(".theme-option").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getBoundingClientRect()).map((r) => Math.min(r.width, r.height)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(24);
  });
}
