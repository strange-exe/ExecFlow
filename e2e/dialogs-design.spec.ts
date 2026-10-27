// UX polish, unit U2 (.claude/tasks/ux-polish.md, 2026-10-24): dialogs and visual consistency,
// measured as rendered in all three engines. A2: a dialog body that scrolls is a keyboard-scrollable
// region, and the Shortcuts list reads on phones. C14: dialog buttons at the primary height. C15: a
// footer rule only while the body scrolls, no empty band above a short footer, one field-error look
// and one result line. C16: text roles and type tokens. C17: the editor's focus bar steps down in the
// palette themes. C18: icons on the 12 to 20 px scale, the fold caret, the quiet Default tag, the
// error help's code chip and the empty workspace's buttons. src/styles/consistency.test.ts and
// focus-bar.test.ts check the same rules in the stylesheets.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { contrast as ratio, over } from "../src/theme/contrast";
import { BUILT_IN, themePalette } from "../src/theme/themes";
import { expect, importFiles, openApp, openFromTree, run, setCode, showFiles, showPanel, showView, test, treeItem } from "./helpers";
import { openConnect, routeGitHub, routeSignIn } from "./sync-fake";

/** GitHub and the sign-in relay are the fakes (e2e/sync-fake.ts): Connect opens on Sign in with GitHub. */
async function openWithSignIn(page: Page) {
  await routeGitHub(page);
  await routeSignIn(page);
  await openApp(page);
}

test.use({ serviceWorkers: "block" });

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SCALE = [12, 14, 16, 18, 20];
const MAIN = "def area(r):\n    return 3.14159 * r * r\n\nfor r in range(1, 4):\n    print(r, area(r))\n";

/** A token's value as the engine computes a colour (rgb(), whatever the engine's own spelling of the source). */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const el = document.createElement("i");
    el.style.color = `var(${n})`;
    document.body.append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }, name);

/** "rgb(1, 2, 3)", "rgba(...)" or "color(srgb 0.1 0.2 0.3)" as 0..255 channels. */
function channels(css: string): number[] {
  const srgb = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/.exec(css);
  if (srgb) return srgb.slice(1, 4).map((v) => Number(v) * 255);
  return (/rgba?\(([^)]+)\)/.exec(css)?.[1] ?? "").split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number);
}
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Every visible icon whose box is not a square on the 12 to 20 px scale. */
async function offScale(page: Page, view: string) {
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll<SVGElement>("svg.icon, svg.brand-mark")]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height, what: `${e.getAttribute("data-icon") ?? e.getAttribute("class")} in ${e.parentElement?.className || e.parentElement?.tagName}` };
      })
      .filter((s) => s.w > 0),
  );
  expect(sizes.length, `${view}: icons were measured`).toBeGreaterThan(0);
  return sizes.filter((s) => !SCALE.some((px) => Math.abs(s.w - px) < 0.05) || Math.abs(s.w - s.h) > 0.05).map((s) => `${view}: ${s.what} ${s.w.toFixed(2)}x${s.h.toFixed(2)}`);
}

async function openShortcuts(page: Page) {
  await page.locator("#shortcuts-button").click();
  const dialog = page.locator("dialog#shortcuts");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openDeleteConfirm(page: Page, path: string) {
  await showFiles(page);
  await treeItem(page, path).locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** From the last visible thing in the body to the top of the footer's first button. */
const bandAboveFooter = (dialog: Locator) =>
  dialog.evaluate((d) => {
    const body = d.querySelector(".dialog-body")!;
    const kids = [...body.querySelectorAll<HTMLElement>(":scope > *")].filter((c) => c.getClientRects().length && getComputedStyle(c).position !== "absolute" && c.getBoundingClientRect().height > 0);
    const last = Math.max(...kids.map((c) => c.getBoundingClientRect().bottom));
    return d.querySelector(".dialog-actions .btn")!.getBoundingClientRect().top - last;
  });

const footerRule = (dialog: Locator) => dialog.locator(".dialog-actions").evaluate((a) => getComputedStyle(a).boxShadow);

test("A2: a dialog body that scrolls is a named, focusable region the keyboard scrolls, in every engine; a short one is not", async ({ page }) => {
  await page.setViewportSize(DESK);
  await openApp(page);
  const dialog = await openShortcuts(page);
  const body = dialog.locator(".dialog-body");
  await expect(dialog).toHaveAttribute("data-overflow", "");
  await expect(body).toHaveAttribute("tabindex", "0");
  await expect(dialog.getByRole("region", { name: "Keyboard shortcuts" })).toHaveCount(1);
  // Tab from Close reaches the body; the keys scroll it, to its end.
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Tab");
  await expect(body).toBeFocused();
  expect(await body.evaluate((b) => getComputedStyle(b).outlineStyle), "a visible focus ring").not.toBe("none");
  await page.keyboard.press("PageDown");
  await expect.poll(() => body.evaluate((b) => b.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  await expect.poll(() => body.evaluate((b) => b.scrollTop + b.clientHeight >= b.scrollHeight - 1)).toBe(true);
  const axe = await new AxeBuilder({ page }).include("dialog#shortcuts").withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
  await page.keyboard.press("Escape");

  // A short dialog: no extra Tab stop, no region, no footer rule.
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  const confirm = await openDeleteConfirm(page, "main.py");
  await expect(confirm).not.toHaveAttribute("data-overflow", "");
  for (const attr of ["tabindex", "role"]) await expect(confirm.locator(".dialog-body")).not.toHaveAttribute(attr, /./);
  await page.keyboard.press("Escape");
});

test("A2: on a phone the keys sit above their description, full width; on a desktop each row's keys meet its description", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openApp(page);
  let dialog = await openShortcuts(page);
  const phone = await dialog.evaluate((d) => {
    const body = d.querySelector(".dialog-body")!;
    const content = body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) - parseFloat(getComputedStyle(body).paddingRight);
    const rows = [...d.querySelectorAll("dt")].map((dt) => ({ dt: dt.getBoundingClientRect(), dd: (dt.nextElementSibling as HTMLElement).getBoundingClientRect(), what: dt.nextElementSibling!.textContent }));
    return { content, right: d.getBoundingClientRect().right, narrow: rows.filter((r) => r.dd.width < content - 2 || r.dd.top < r.dt.bottom - 0.5).map((r) => `${r.what} ${Math.round(r.dd.width)}`), wide: [...d.querySelectorAll<HTMLElement>("*")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > d.getBoundingClientRect().right + 1).length };
  });
  expect(phone.narrow, `every description gets the content width (${Math.round(phone.content)} px) under its keys`).toEqual([]);
  expect(phone.wide, "nothing wider than the dialog").toBe(0);
  await page.keyboard.press("Escape");

  await page.setViewportSize(DESK);
  dialog = await openShortcuts(page);
  const desk = await dialog.evaluate((d) => {
    const body = d.querySelector(".dialog-body")!;
    const content = body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) - parseFloat(getComputedStyle(body).paddingRight);
    return {
      content,
      rows: [...d.querySelectorAll("dt")].map((dt) => {
        const dd = (dt.nextElementSibling as HTMLElement).getBoundingClientRect();
        const keysRight = Math.max(...[...dt.querySelectorAll("kbd")].map((k) => k.getBoundingClientRect().right));
        return { gap: dd.left - keysRight, width: dd.width, what: dt.nextElementSibling!.textContent };
      }),
    };
  });
  expect(desk.rows.filter((r) => r.gap > 24 || r.gap < 0).map((r) => `${r.what}: ${Math.round(r.gap)} px`), "keys end beside their description").toEqual([]);
  expect(Math.min(...desk.rows.map((r) => r.width)), "the descriptions keep half the width").toBeGreaterThanOrEqual(desk.content * 0.45);
});

test("C14 + C15: buttons at the primary height; a short dialog has no rule and no empty band; a scrolling one has the rule", async ({ page }) => {
  await page.setViewportSize(DESK);
  await openWithSignIn(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  const confirm = await openDeleteConfirm(page, "main.py");
  for (const b of await confirm.locator(".dialog-actions .btn").all()) expect((await b.boundingBox())!.height, "confirm buttons").toBeCloseTo(32, 0);
  expect(await footerRule(confirm), "no rule on a short footer").toBe("none");
  expect(await bandAboveFooter(confirm), "no empty band above a short footer").toBeLessThanOrEqual(28);
  await page.keyboard.press("Escape");

  // Share, not connected: a short dialog too.
  await treeItem(page, "main.py").locator(":scope > .tree-row").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share link..." }).click();
  const share = page.locator("dialog#share-dialog");
  await expect(share).toHaveAttribute("data-state", /./);
  expect(await footerRule(share)).toBe("none");
  expect(await bandAboveFooter(share), "Share: no empty band").toBeLessThanOrEqual(28);
  await page.keyboard.press("Escape");

  // Connect: Sign in leads at the primary height; with the token form open it steps back to the
  // outline style and never outranks the filled Connect.
  const connect = await openConnect(page);
  const signIn = page.locator("#connect-signin");
  expect((await signIn.boundingBox())!.height).toBeCloseTo(32, 0);
  await page.locator("#connect-use-token").click();
  const submit = page.locator("#connect-submit");
  await expect(submit).toBeVisible();
  await expect(signIn).not.toHaveClass(/\bprimary\b/);
  await expect(submit).toHaveClass(/\bprimary\b/);
  expect((await submit.boundingBox())!.height).toBeCloseTo(32, 0);
  expect((await signIn.boundingBox())!.height).toBeLessThanOrEqual((await submit.boundingBox())!.height + 0.5);
  // A short window: the body scrolls, and only then the footer draws the --divider rule.
  await page.setViewportSize({ width: 1440, height: 640 });
  await expect(connect).toHaveAttribute("data-overflow", "");
  const divider = channels(await token(page, "--divider"));
  const rule = await footerRule(connect);
  expect(rule, "the footer rule").toContain("inset");
  expect(channels(rule)).toEqual(divider);
  await page.keyboard.press("Escape");

  // Phones keep 44 px dialog buttons.
  await page.setViewportSize(PHONE);
  const phoneConfirm = await openDeleteConfirm(page, "main.py");
  for (const b of await phoneConfirm.locator(".dialog-actions .btn").all()) expect((await b.boundingBox())!.height).toBeCloseTo(44, 0);
  await page.keyboard.press("Escape");
});

test("C15: one field-error look in Connect, Capture snippet and Save as PDF; one result line in every dialog", async ({ page }) => {
  await page.setViewportSize(DESK);
  await openWithSignIn(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  await openFromTree(page, "main.py");
  const look = (l: Locator) =>
    l.evaluate((e) => {
      const s = getComputedStyle(e);
      const i = getComputedStyle(e.querySelector("svg")!);
      return [s.backgroundColor, s.boxShadow, s.borderRadius, s.padding, s.fontSize, s.fontWeight, s.lineHeight, s.color, s.columnGap, i.width, i.color].join(" | ");
    });
  const line = (l: Locator) =>
    l.evaluate((e) => {
      const s = getComputedStyle(e);
      return [e.classList.contains("result-line"), s.display, s.columnGap, s.fontSize, s.lineHeight, s.color].join(" | ");
    });

  const looks: Record<string, string> = {};
  const lines: Record<string, string> = {};
  // Capture snippet: a highlight that names no line.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.locator("#snippet-button").click();
  const snippet = page.locator("dialog#snippet-dialog");
  await expect(snippet).toBeVisible();
  await page.locator("#snippet-highlight").fill("x");
  await page.locator("#snippet-highlight").press("Enter");
  await expect(page.locator("#snippet-highlight-error")).toBeVisible();
  looks.snippet = await look(page.locator("#snippet-highlight-error"));
  lines.snippet = await line(page.locator("#snippet-status"));
  await page.keyboard.press("Escape");
  await expect(snippet).toHaveCount(0);

  // Save as PDF: no file chosen.
  await showFiles(page);
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Save as PDF..." }).click();
  await expect(page.locator("dialog#pdf-dialog")).toBeVisible();
  await page.locator("#pdf-none").click();
  await page.locator("#pdf-print").click();
  await expect(page.locator("#pdf-files-error")).toBeVisible();
  looks.pdf = await look(page.locator("#pdf-files-error"));
  lines.pdf = await line(page.locator("#pdf-status"));
  await page.keyboard.press("Escape");

  // Connect: the token form sent empty.
  await openConnect(page);
  lines.signin = await line(page.locator("#connect-signin-result"));
  await page.locator("#connect-use-token").click();
  await page.locator("#connect-submit").click();
  await expect(page.locator("#connect-token-error")).toBeVisible();
  looks.connect = await look(page.locator("#connect-token-error"));
  lines.connect = await line(page.locator("#connect-result"));
  await page.keyboard.press("Escape");

  // (Share link's result line exists once GitHub is connected: share-design.spec.ts draws it, and
  // src/styles/consistency.test.ts keeps its rules to the shared .result-line.)

  // The arguments field's error uses the same class (its look is the one rule).
  await expect(page.locator("#args-error")).toHaveClass(/\bfield-error\b/);

  expect(new Set(Object.values(looks)).size, JSON.stringify(looks, null, 1)).toBe(1);
  expect(Object.values(lines).every((l) => l.startsWith("true | flex")), JSON.stringify(lines, null, 1)).toBe(true);
  expect(new Set(Object.values(lines)).size, JSON.stringify(lines, null, 1)).toBe(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`C16 + C18 (${scheme}): text roles, one heading weight, titles on their line heights, the empty workspace and the quiet Default tag`, async ({ page }) => {
    await page.setViewportSize(DESK);
    await openApp(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    const color = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
    const secondary = await token(page, "--text-secondary");
    const text = await token(page, "--text");

    // The empty workspace.
    const empty = page.locator(".empty-state[data-empty=workspace]");
    await expect(empty).toBeVisible();
    expect(await color(empty.locator(".empty-lede"))).toBe(secondary);
    expect((await empty.locator(".empty-lede").boundingBox())!.width, "the lede is as wide as its column").toBeCloseTo((await empty.boundingBox())!.width, 0);
    expect(await empty.locator(".empty-title").evaluate((e) => getComputedStyle(e).lineHeight)).toBe("36px");
    const connect = empty.getByRole("button", { name: "Connect GitHub" });
    const importBtn = empty.getByRole("button", { name: "Import files" });
    const edge = (l: Locator) => l.evaluate((e) => `${getComputedStyle(e).borderTopWidth} ${getComputedStyle(e).borderTopStyle} ${getComputedStyle(e).borderTopColor}`);
    expect(await edge(connect), "Connect GitHub is an outline button like Import").toBe(await edge(importBtn));

    // Examples: the lede in the secondary tier, the language titles at 500.
    await page.locator("#empty-examples").click();
    const examples = page.locator("dialog#examples");
    await expect(examples).toBeVisible();
    expect(await color(examples.locator(".examples-lede"))).toBe(secondary);
    for (const h of await examples.locator(".section-title").all()) expect(await h.evaluate((e) => getComputedStyle(e).fontWeight)).toBe("500");
    expect(await examples.locator(".dialog-title").evaluate((e) => getComputedStyle(e).lineHeight)).toBe("26px");
    await page.keyboard.press("Escape");

    // Settings: section titles at 500; the Default tag is quiet text.
    await page.locator("#settings-button").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    for (const h of await settings.locator(".section-title").all()) expect(await h.evaluate((e) => getComputedStyle(e).fontWeight)).toBe("500");
    const tag = settings.locator(".tag").first();
    expect(await tag.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("0px");
    expect(await color(tag)).toBe(secondary);
    await page.keyboard.press("Escape");

    // The delete confirmation's question is body text.
    await importFiles(page, [{ name: "main.py", text: MAIN }]);
    const confirm = await openDeleteConfirm(page, "main.py");
    for (const p of await confirm.locator(".dialog-body p").all()) expect(await color(p)).toBe(text);
    await page.keyboard.press("Escape");

    // Chrome text on its own line heights. The command field is tier 2 (--fs-2 / --lh-2: 13 / 18 px);
    // the sidebar's "Files" label is tier 3 since the 0.7.0 shell (--fs-hint / --lh-hint: 12 / 16 px,
    // app.css .region-title), under the workspace and the quick actions.
    expect(await page.locator(".region-title").first().evaluate((e) => `${getComputedStyle(e).fontSize} / ${getComputedStyle(e).lineHeight}`)).toBe("12px / 16px");
    expect(await page.locator("#palette-button").evaluate((e) => getComputedStyle(e).lineHeight)).toBe("18px");
  });
}

test("C17: the editor's focus bar is the 70% step in a palette theme (GitHub-style Light), and Deep Field light keeps the focus colour", async ({ page }) => {
  await page.setViewportSize(DESK);
  const bar = async () => {
    await page.locator(".cm-content").click();
    return page.evaluate(() => getComputedStyle(document.querySelector(".cm-gutters")!, "::after").backgroundColor);
  };
  await openApp(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  await openFromTree(page, "main.py");
  expect(channels(await bar()), "Deep Field light: the focus colour").toEqual(channels(await token(page, "--focus")));

  await page.evaluate(() => localStorage.setItem("codeeditor:theme", "github-light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-id", "github-light");
  await openFromTree(page, "main.py");
  const p = themePalette(BUILT_IN.find((t) => t.id === "github-light")!).palette;
  const drawn = channels(await bar());
  const want = channels(`rgb(${[1, 3, 5].map((i) => parseInt(over(p.bg, p.focus, 0.7).slice(i, i + 2), 16)).join(", ")})`);
  drawn.forEach((v, i) => expect(Math.abs(v - want[i]), `channel ${i}: ${hex(drawn)} vs ${hex(want)}`).toBeLessThanOrEqual(1.5));
  expect(ratio(hex(drawn), p.bg), "3:1 or more on the code").toBeGreaterThanOrEqual(3);
  expect(ratio(hex(drawn), p.bg), "a step down from the text colour").toBeLessThan(ratio(p.focus, p.bg));
});

test("C18: icons render at 12, 14, 16, 18 or 20 px across the views; the fold marker is the caret; the error help's code is a chip", async ({ page }) => {
  await page.setViewportSize(DESK);
  await openWithSignIn(page);
  const bad: string[] = [];
  bad.push(...(await offScale(page, "empty")));
  await importFiles(page, [{ name: "main.py", text: MAIN }, { name: "oops.py", text: "print(zz)\n" }]);
  await openFromTree(page, "main.py");
  bad.push(...(await offScale(page, "editor")));

  // The fold marker: Phosphor's caret, down while open, right once folded.
  // (CodeMirror keeps one hidden marker in the gutter to size it: only visible ones count.)
  const gutter = page.locator(".cm-foldGutter");
  const marker = (icon: string) => gutter.locator(`svg[data-icon="${icon}"]`).filter({ visible: true }).first();
  await expect(marker("caret-down")).toBeVisible();
  expect(await gutter.textContent(), "no text glyph").not.toContain(String.fromCodePoint(0x2304));
  await expect(marker("caret-down").locator("xpath=..")).toHaveAttribute("title", "Fold line");
  await marker("caret-down").click();
  await expect(marker("caret-right")).toBeVisible();
  await expect(marker("caret-right").locator("xpath=..")).toHaveAttribute("title", "Unfold line");
  await expect(page.locator(".cm-foldPlaceholder")).toBeVisible();
  bad.push(...(await offScale(page, "folded")));

  // A failed run: the error help's code chip, the run header, Problems.
  await openFromTree(page, "oops.py");
  await run(page, { timeout: 120_000 });
  const code = page.locator(".runlog .err-help code").first();
  await expect(code).toBeVisible();
  const chip = await code.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, radius: getComputedStyle(e).borderTopLeftRadius }));
  expect(chip.radius).toBe("5px"); // --r-key (5 px since the Signal round)
  expect(chip.bg, "a ground of its own").not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  bad.push(...(await offScale(page, "failed run")));
  await showPanel(page, "problems");
  bad.push(...(await offScale(page, "problems")));
  await showPanel(page, "output");

  // Menus and dialogs.
  await showFiles(page);
  await page.locator("#file-actions").click();
  await expect(page.locator(".menu")).toBeVisible();
  bad.push(...(await offScale(page, "file actions menu")));
  await page.keyboard.press("Escape");
  for (const [view, open] of [
    ["settings", "#settings-button"],
    ["shortcuts", "#shortcuts-button"],
  ] as const) {
    await page.locator(open).click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    bad.push(...(await offScale(page, view)));
    await page.keyboard.press("Escape");
  }
  await openConnect(page);
  bad.push(...(await offScale(page, "connect")));
  await page.locator("#connect-use-token").click();
  bad.push(...(await offScale(page, "connect token")));
  await page.keyboard.press("Escape");

  // Phone: the top bar, the switch, the output view.
  await page.setViewportSize(PHONE);
  await showView(page, "output");
  bad.push(...(await offScale(page, "phone output")));
  await showView(page, "code");
  bad.push(...(await offScale(page, "phone code")));
  expect(bad).toEqual([]);
});

test("C18: icons stay on the scale in the editor's own text: a phone's status bar and the snippet and PDF dialogs", async ({ page }) => {
  await page.setViewportSize(DESK);
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: MAIN }]);
  await openFromTree(page, "main.py");
  const bad: string[] = [];
  await setCode(page, MAIN);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.locator("#snippet-button").click();
  await expect(page.locator("dialog#snippet-dialog")).toBeVisible();
  bad.push(...(await offScale(page, "snippet")));
  await page.keyboard.press("Escape");
  await showFiles(page);
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Save as PDF..." }).click();
  await expect(page.locator("dialog#pdf-dialog")).toBeVisible();
  bad.push(...(await offScale(page, "pdf")));
  await page.keyboard.press("Escape");
  expect(bad).toEqual([]);
});
