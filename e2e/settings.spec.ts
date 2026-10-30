import type { Page } from "@playwright/test";
import { expect, openApp, reloadApp, test } from "./helpers";

// Settings in 0.7.0: two panes from 900 px (the sections on the left, the settings on the right,
// one scroller), one column with the sections as a picker row on phones; a font-size stepper,
// switches for on/off options, every note under its own field, the version slot and the legal
// line at the foot. Ids and storage keys are the ones before (other specs use them).
test.use({ serviceWorkers: "block" });

const SECTIONS = ["Appearance", "Editor", "Running programs", "Storage", "GitHub", "Danger zone"];

async function openSettings(page: Page) {
  await page.locator("#settings-button").click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("codeeditor:settings") ?? "{}") as Record<string, unknown>);

test("desktop: the sections list sits left of the settings, and choosing one brings it up and marks it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const dialog = await openSettings(page);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button")).toHaveText(SECTIONS);
  const navBox = (await nav.boundingBox())!;
  const pane = (await dialog.locator(".dialog-body").boundingBox())!;
  expect(navBox.x + navBox.width, "the list is left of the pane").toBeLessThanOrEqual(pane.x + 1);
  expect(Math.abs(navBox.y - pane.y), "side by side").toBeLessThan(40);
  await expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");

  // By mouse: Storage comes to the top of the pane and is the marked one.
  await nav.getByRole("button", { name: "Storage" }).click();
  await expect(nav.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-current", "true");
  await expect(nav.getByRole("button", { name: "Appearance" })).not.toHaveAttribute("aria-current", "true");
  const heading = dialog.getByRole("heading", { name: "Storage" });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  const top = (await heading.boundingBox())!.y - pane.y;
  // At the pane's top, or as near as the pane scrolls (the last sections are shorter than it).
  const atEnd = await dialog.locator(".dialog-body").evaluate((el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  expect(top < 48 || atEnd, `the section's heading at the pane's top (${top} px down)`).toBe(true);

  // By keyboard: arrows move along the list, Enter goes there.
  await nav.getByRole("button", { name: "Storage" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("button", { name: "GitHub" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(nav.getByRole("button", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(nav.getByRole("button", { name: "Appearance" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(nav.getByRole("button", { name: "Danger zone" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Danger zone" })).toBeFocused();
  await expect(dialog.locator("#sign-out-clear")).toBeInViewport();

  // Scrolling the pane by hand moves the mark too.
  await dialog.locator(".dialog-body").evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");
});

test("the code font size is a stepper: buttons and typing both work, clamped to 12 to 20, and it is kept", async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const size = dialog.getByRole("spinbutton", { name: "Code font size (px)" });
  const smaller = dialog.getByRole("button", { name: "Smaller code font" });
  const larger = dialog.getByRole("button", { name: "Larger code font" });
  await expect(size).toHaveValue("15");
  await larger.click();
  await expect(size).toHaveValue("16");
  expect((await stored(page)).codeSize).toBe(16);
  await smaller.click();
  await smaller.click();
  await expect(size).toHaveValue("14");
  await size.fill("99");
  await size.press("Tab");
  await expect(size).toHaveValue("20");
  await expect(larger, "no step past the limit").toBeDisabled();
  await size.fill("3");
  await size.press("Tab");
  await expect(size).toHaveValue("12");
  await expect(smaller).toBeDisabled();
  await expect(larger).toBeEnabled();
  // The editor's code follows the setting.
  expect(await page.locator("#app").evaluate((el) => getComputedStyle(el).getPropertyValue("--code-size").trim())).toBe("12px");
});

test("emptying a number field keeps its value: code size, time limit and output limit don't fall to their minimum", async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const cases = [
    { name: "Code font size (px)", key: "codeSize", value: "17" },
    { name: "Time limit (seconds)", key: "timeLimitS", value: "7" },
    { name: "Output limit (thousands)", key: "outputLimitK", value: "64" },
  ];
  for (const { name, key, value } of cases) {
    const field = dialog.getByRole("spinbutton", { name });
    await field.fill(value);
    await field.press("Tab");
    await expect(field).toHaveValue(value);
    expect((await stored(page))[key], `${key} saved`).toBe(Number(value));
    await field.fill("");
    await field.press("Tab");
    await expect(field, `${key}: an empty field shows the kept value again`).toHaveValue(value);
    expect((await stored(page))[key], `${key}: an empty field saves nothing`).toBe(Number(value));
  }
  await expect(dialog.getByRole("button", { name: "Smaller code font" })).toBeEnabled();
  expect(await page.locator("#app").evaluate((el) => getComputedStyle(el).getPropertyValue("--code-size").trim())).toBe("17px");
});

test("on/off settings are switches with their own notes; a change is kept and shows again on reopening", async ({ page }) => {
  await openApp(page);
  let dialog = await openSettings(page);
  for (const id of ["set-wrap", "set-suggest", "set-enter-top", "set-ligatures", "set-wall", "set-wextra", "set-autosync"]) {
    await expect(dialog.locator(`#${id}`), id).toHaveAttribute("role", "switch");
  }
  const wrap = dialog.getByRole("switch", { name: "Wrap long lines" });
  await expect(wrap).not.toBeChecked();
  // Drawn as a track, not as the checkbox's square (its 18 px rule once won over the switch's).
  const track = (await wrap.boundingBox())!;
  expect(track.width, "a switch's track is wide").toBeGreaterThanOrEqual(track.height * 1.6);
  await wrap.click();
  await expect(wrap).toBeChecked();
  expect((await stored(page)).lineWrapping).toBe(true);
  // A note belongs to its own switch only.
  const suggest = dialog.getByRole("switch", { name: "Suggestions while typing" });
  await expect(suggest).toHaveAccessibleDescription("Ctrl+Space always shows them.");
  await expect(wrap).toHaveAccessibleDescription("");
  // Space toggles a focused switch, as a checkbox's does.
  await suggest.focus();
  await page.keyboard.press("Space");
  await expect(suggest).not.toBeChecked();
  await page.keyboard.press("Escape");
  await reloadApp(page);
  dialog = await openSettings(page);
  await expect(dialog.getByRole("switch", { name: "Wrap long lines" })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Suggestions while typing" })).not.toBeChecked();
});

test("selects for the standards and optimisation; every field note sits under its own field; no empty grid cells", async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  for (const [name, value] of [["C standard", "gnu11"], ["C++ standard", "c++17"], ["Optimisation", "2"]] as const) {
    await expect(dialog.getByRole("combobox", { name })).toHaveValue(value);
  }
  // Each note is described by exactly one control, and sits right under it.
  const notes = await dialog.locator(".dialog-body .field-note[id]").evaluateAll((els) =>
    els.map((n) => {
      const owners = [...document.querySelectorAll(`[aria-describedby~="${n.id}"]`)];
      const row = owners[0]?.closest(".setting");
      return { id: n.id, owners: owners.length, inRow: Boolean(row?.contains(n)) };
    }),
  );
  // Statuses, not field notes: storage, GitHub, and the theme picker's count of families shown
  // (Appearance is the picker since 0.15.0; the count is role=status, described by no control).
  for (const n of notes.filter((x) => !["storage-status", "github-status", "theme-count"].includes(x.id))) {
    expect(n.owners, `${n.id}: one owner`).toBe(1);
    expect(n.inRow, `${n.id}: inside its own field's row`).toBe(true);
  }
  expect(await dialog.locator(".field-grid").count(), "no grid of fields with empty cells").toBe(0);
});

test("the foot holds the version slot and the legal line; the sections stay reachable at 390 px as a picker row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const dialog = await openSettings(page);
  const foot = dialog.locator(".settings-foot");
  await expect(foot.locator("#settings-version")).toBeAttached();
  await expect(foot.locator(".settings-legal")).toBeVisible();
  await expect(foot.getByRole("link", { name: "Privacy" })).toBeVisible();
  // One column: the picker row above the settings, which take the dialog's width.
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  const navBox = (await nav.boundingBox())!;
  const pane = (await dialog.locator(".dialog-body").boundingBox())!;
  expect(navBox.y + navBox.height).toBeLessThanOrEqual(pane.y + 1);
  expect(pane.width).toBeGreaterThan(300);
  for (const b of await nav.getByRole("button").all()) expect((await b.boundingBox())!.height, "44 px targets on phones").toBeGreaterThanOrEqual(44);
  await nav.getByRole("button", { name: "Danger zone" }).click();
  await expect(dialog.locator("#sign-out-clear")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
