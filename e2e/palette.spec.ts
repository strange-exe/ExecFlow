// The command palette and quick open (.claude/design/batch3/p.md section 1): F1 and Ctrl+Shift+P on
// the commands, Ctrl+P and the top bar's Search on files and commands; the WAI-ARIA APG combobox
// with its listbox; Enter, the pointer, Escape and where focus goes; a run in progress; a read-only
// tab; Ctrl+P never reaching the browser's Print. Every wait is on a state (the dialog's data-state,
// aria attributes, the active file, a focused element), never on wording or time.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, expectActive, importFiles, openApp, openFromTree, setCode, test, waitReady } from "./helpers";
import { contrast, decodePng } from "./pixels";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const MAC = process.platform === "darwin";
const MOD = MAC ? "Meta" : "Control";
const FILES = [
  { name: "main.py", text: 'name = input("Name: ")\nprint("Hello,", name)\n' },
  { name: "calc.py", text: "def ratio(a, b):\n    return a / b\n\nprint(ratio(4, 2))\n" },
];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const palette = (page: Page) => page.locator("dialog#palette");
const field = (page: Page) => page.locator("#palette-input");

/** The palette is open and drawn in `mode`, its field focused. */
async function expectOpen(page: Page, mode: "all" | "commands") {
  await expect(palette(page)).toHaveAttribute("data-state", "ready");
  await expect(palette(page)).toHaveAttribute("data-mode", mode);
  await expect(field(page)).toBeFocused();
}

/** The active option (aria-activedescendant) and its aria-selected agree. */
async function activeOption(page: Page) {
  const id = await field(page).getAttribute("aria-activedescendant");
  expect(id, "an active option").toBeTruthy();
  const option = page.locator(`#${id}`);
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#palette-list [role=option][aria-selected=true]")).toHaveCount(1);
  return option;
}

async function setUp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
}

test("F1, Ctrl+Shift+P, Ctrl+P and Search open it as an APG combobox, and Escape gives the focus back", async ({ page }) => {
  await setUp(page);
  const search = page.locator("#palette-button");
  await expect(search).toHaveAccessibleName("Search files and commands");
  await expect(search).toHaveAttribute("aria-keyshortcuts", "Control+P Control+Shift+P F1");

  // F1 from the code: commands only, the field holds ">".
  await page.locator(".cm-content").click();
  await page.keyboard.press("F1");
  await expectOpen(page, "commands");
  await expect(field(page)).toHaveValue(">");
  await expect(field(page)).toHaveAttribute("role", "combobox");
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");
  await expect(field(page)).toHaveAttribute("aria-controls", "palette-list");
  await expect(page.locator("#palette-list")).toHaveAttribute("role", "listbox");
  await expect(palette(page)).toHaveAccessibleName("Search files and commands");
  expect(await (await activeOption(page)).getAttribute("data-command")).toBe("run");
  // Grouped while nothing is typed; each group is named.
  await expect(page.locator("#palette-list [role=group]").first()).toHaveAccessibleName("Run");
  // Escape: back to the code (the editor has the focus again).
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();

  await page.keyboard.press(`${MOD}+Shift+P`);
  await expectOpen(page, "commands");
  // Ctrl+P inside switches to files and commands, F1 back; the typed words stay.
  await page.keyboard.type("calc");
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  await expect(field(page)).toHaveValue("calc");
  await page.keyboard.press("F1");
  await expect(field(page)).toHaveValue(">calc");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();

  // Ctrl+P: the files first (the open one first, marked), then the commands.
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  await expect(field(page)).toHaveValue("");
  await expect(page.locator("#palette-list [role=group]").nth(0)).toHaveAccessibleName("Files");
  await expect(page.locator("#palette-list [role=group]").nth(1)).toHaveAccessibleName("Commands");
  const first = await activeOption(page);
  await expect(first).toHaveAttribute("data-path", "main.py");
  await expect(first).toHaveAttribute("data-current", "true");
  await page.keyboard.press("Escape");

  // The top bar's Search: files and commands; Escape returns to it.
  await search.click();
  await expectOpen(page, "all");
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  // And by keyboard (Enter on the focused control).
  await page.keyboard.press("Enter");
  await expectOpen(page, "all");
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
});

test("typing filters and ranks; Down, Up and the pointer move the active option; Enter and a click choose", async ({ page }) => {
  await setUp(page);
  await page.locator("#palette-button").click();
  await expectOpen(page, "all");
  // "calc": the file first (by its name), then nothing else matches as well.
  await page.keyboard.type("calc");
  await expect(await activeOption(page)).toHaveAttribute("data-path", "calc.py");
  // The matched letters are marked.
  await expect((await activeOption(page)).locator("mark.palette-hit")).toHaveText("calc");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expectActive(page, "calc.py");
  await expect(page.locator(".cm-content")).toBeFocused();

  // ">" alone: commands only, and Down and Up wrap round the list.
  await page.keyboard.press(`${MOD}+P`);
  await page.keyboard.type(">");
  await expectOpen(page, "commands");
  const count = Number(await palette(page).getAttribute("data-count"));
  expect(count).toBeGreaterThan(20);
  await page.keyboard.press("ArrowUp");
  await expect(await activeOption(page)).toHaveAttribute("id", `palette-opt-${count - 1}`);
  await page.keyboard.press("ArrowDown");
  await expect(await activeOption(page)).toHaveAttribute("id", "palette-opt-0");
  await page.keyboard.press("PageDown");
  await expect(await activeOption(page)).toHaveAttribute("id", "palette-opt-8");

  // Initials: "nfe" finds New from example...
  await field(page).fill(">nfe");
  await expect(await activeOption(page)).toHaveAttribute("data-command", "examples");
  // Nothing matches: no options, the list collapsed, said in words.
  await field(page).fill(">zzzz");
  await expect(palette(page)).toHaveAttribute("data-count", "0");
  await expect(field(page)).toHaveAttribute("aria-expanded", "false");
  await expect(field(page)).not.toHaveAttribute("aria-activedescendant", /.+/);
  await expect(page.locator(".palette-empty")).toBeVisible();

  // A pointer that moves over an option makes it the active one; a click chooses it.
  await field(page).fill(">go to");
  const line = page.locator("#palette-list [role=option][data-command=gotoLine]");
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await expect(line).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toBeFocused();
  await line.click();
  // CodeMirror's own Go to line panel opens on the code, with the focus in its field.
  const goto = page.locator(".cm-goto-line input[name=line]");
  await expect(goto).toBeFocused();
  await goto.fill("3");
  await goto.press("Enter");
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 3,/);
});

test("the editor's commands act on the code: comment, select next match, fold", async ({ page }) => {
  await setUp(page);
  await setCode(page, "x = 1\nx = 2\nif x:\n    print(x)\n");
  await page.keyboard.press(`${MOD}+Home`);
  const choose = async (text: string, id: string) => {
    await page.keyboard.press("F1");
    await expectOpen(page, "commands");
    await page.keyboard.type(text);
    await expect(await activeOption(page)).toHaveAttribute("data-command", id);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
  };
  await choose("comment", "comment");
  await expect(page.locator(".cm-line").first()).toHaveText("# x = 1");
  await choose("undo", "undo");
  await expect(page.locator(".cm-line").first()).toHaveText("x = 1");
  // Select "x", then the next match too: two selections.
  await page.keyboard.press("Shift+ArrowRight");
  await choose("next match", "selectNext");
  await expect.poll(() => page.locator(".cm-selectionBackground").count()).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");
  // Fold the if block at the cursor: its body goes behind a placeholder.
  await page.locator(".cm-line").nth(2).click();
  await choose("fold the", "fold");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await choose("unfold every", "unfoldAll");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
});

test("Ctrl+P never reaches the browser's Print: in the code, outside it and inside the palette", async ({ page }) => {
  await setUp(page);
  // A listener added after the app's sees whether the app took the key (defaultPrevented).
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { printKeys: boolean[] }).printKeys = seen;
    addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey)) seen.push(e.defaultPrevented);
    });
  });
  const seen = () => page.evaluate(() => (window as unknown as { printKeys: boolean[] }).printKeys);
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  await page.keyboard.press(`${MOD}+P`);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.press("Escape");
  await page.locator("#settings-button").focus();
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  expect(await seen()).toEqual([true, true, true, true]);
});

test("while Settings or a menu owns the keyboard, the palette's keys do nothing: no palette, no Print, no Help", async ({ page }) => {
  await setUp(page);
  // A listener added after the app's sees whether the app took the key (defaultPrevented).
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { paletteKeys: boolean[] }).paletteKeys = seen;
    addEventListener("keydown", (e) => {
      if (e.key === "F1" || (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey))) seen.push(e.defaultPrevented);
    });
  });
  const seen = () => page.evaluate(() => (window as unknown as { paletteKeys: boolean[] }).paletteKeys);
  await page.locator("#settings-button").click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await page.keyboard.press(`${MOD}+P`);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.press("F1");
  expect(await seen()).toEqual([true, true, true]);
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator("#file-actions").click();
  await expect(page.getByRole("menu", { name: "File actions" }).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press(`${MOD}+P`);
  await page.keyboard.press("F1");
  expect(await seen()).toEqual([true, true, true, true, true]);
  await expect(page.getByRole("menu", { name: "File actions" })).toHaveCount(1);
  await expect(palette(page)).toHaveCount(0);
});

test("Ctrl+P is the letter P: a layout that types another letter there keeps its key (Dvorak's Ctrl+L)", async ({ page }) => {
  await setUp(page);
  await page.locator("#settings-button").focus();
  // A key event as that layout sends it: the physical P position (code KeyP) with the layout's letter.
  // The app decides at once: it takes the key (defaultPrevented) exactly when it opens the palette.
  const send = (key: string) =>
    page.evaluate(({ key, mac }) => {
      const e = new KeyboardEvent("keydown", { key, code: "KeyP", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(e);
      return e.defaultPrevented;
    }, { key, mac: MAC });
  expect(await send("l"), "Dvorak's Ctrl+L stays the browser's").toBe(false);
  await expect(palette(page)).toHaveCount(0);
  // A layout with no Latin letters (Russian: the P position types U+0437) still opens it there.
  expect(await send(String.fromCodePoint(0x437))).toBe(true);
  await expectOpen(page, "all");
});

test("an editor command with nothing to act on says so, and the code keeps the focus", async ({ page }) => {
  await setUp(page);
  await setCode(page, "x = 1\nx = 2\n");
  await page.keyboard.press(`${MOD}+Home`);
  const notice = page.locator(".notice");
  // The cursor's line starts no block, nothing is folded, the file has no problems, nothing to redo.
  for (const [text, id] of [["next problem", "nextProblem"], ["fold the", "fold"], ["unfold every", "unfoldAll"], ["redo", "redo"]] as const) {
    // From an empty notice, so the one that follows is this command's.
    if ((await notice.getAttribute("data-empty")) !== "true") await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(notice).toHaveAttribute("data-empty", "true");
    const before = await page.locator(".cm-content").innerText();
    await page.keyboard.press("F1");
    await expectOpen(page, "commands");
    await page.keyboard.type(text);
    await expect(await activeOption(page)).toHaveAttribute("data-command", id);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(notice, id).toHaveAttribute("data-empty", "false");
    await expect(notice, id).toHaveAttribute("data-tone", "info");
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.locator(".cm-content").innerText(), id).toBe(before);
  }
});

test("a command that stopped applying while the palette was open isn't run: the list is drawn again", async ({ page }) => {
  await setUp(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await page.keyboard.press("F1");
  await expectOpen(page, "commands");
  await page.keyboard.type("stop");
  await expect(await activeOption(page)).toHaveAttribute("data-command", "stop");
  // The program ends while the palette stays open, as one that finishes on its own does: its input
  // is sent from the page, behind the modal dialog.
  await page.evaluate(() => document.querySelector<HTMLFormElement>("#live-input")!.requestSubmit());
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle", { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", /.+/);
  const status = await page.locator("#receipt").getAttribute("data-status");
  expect(status).not.toBe("stopped");
  await page.keyboard.press("Enter");
  // Still open, Stop gone, nothing stopped; Run is there again.
  await expectOpen(page, "commands");
  await expect(page.locator("#palette-list [data-command=stop]")).toHaveCount(0);
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", status!);
  await field(page).fill(">run the");
  await expect(await activeOption(page)).toHaveAttribute("data-command", "run");
});

test("an option's name reads as one phrase: the label, a comma, then its keys or its folder", async ({ page }) => {
  await setUp(page);
  await importFiles(page, [{ name: "labs/sum.py", text: "print(1)\n" }]);
  // main.py is the file shown, whatever the import opened.
  await openFromTree(page, "main.py");
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  await page.keyboard.type("sum");
  await expect(await activeOption(page)).toHaveAccessibleName("sum.py, in labs");
  await field(page).fill("main");
  await expect(await activeOption(page)).toHaveAccessibleName("main.py, open now");
  await field(page).fill(">go to a line");
  await expect(await activeOption(page)).toHaveAccessibleName(`Go to a line, ${MAC ? "Cmd" : "Ctrl"} Alt G`);
});

/**
 * Forced colours (Windows High Contrast) paint author backgrounds as Canvas and drop box-shadows, so
 * the active option's wash and bar vanish there; palette.css draws an outline instead, as app.css
 * does for the suggestion list. Measured in pixels: the active option's left edge against the same
 * edge of an option that isn't active.
 */
test("in forced colours the active option keeps a visible mark", async ({ page, browserName }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.reload();
  await waitReady(page);
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), "forced colours emulated").toBe(true);
  await importFiles(page, FILES);
  await openFromTree(page, "main.py");
  await page.keyboard.press("F1");
  await expectOpen(page, "commands");
  // Only an engine that really paints forced colours can show this (Playwright's WebKit matches the
  // media query but keeps the author colours; a11y.spec's separators test does the same check).
  const painted = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "Canvas";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { canvas, dialog: getComputedStyle(document.querySelector("dialog#palette")!).backgroundColor };
  });
  test.skip(painted.dialog !== painted.canvas, `${browserName} keeps author colours under forced-colors emulation (${JSON.stringify(painted)})`);
  const options = page.locator("#palette-list [role=option]");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(1, 1);
  const px = decodePng(await page.screenshot({ scale: "css", animations: "disabled" }));
  const edge = async (n: number) => {
    const r = (await options.nth(n).boundingBox())!;
    return { x: r.x, y: r.y + 4, width: 2, height: r.height - 8 };
  };
  const plain = await edge(1);
  const ref = px.at(Math.ceil(plain.x), Math.ceil(plain.y));
  const strongest = (r: { x: number; y: number; width: number; height: number }) => {
    let best = 1;
    for (let y = Math.ceil(r.y); y < r.y + r.height; y++) for (let x = Math.ceil(r.x); x < r.x + r.width; x++) best = Math.max(best, contrast(px.at(x, y), ref));
    return best;
  };
  const m = { marked: strongest(await edge(0)), plain: strongest(plain) };
  info.annotations.push({ type: "forced-colour active option", description: JSON.stringify(m) });
  expect(m.marked, "the active option's edge against an inactive one").toBeGreaterThanOrEqual(3);
  expect(m.plain, "an inactive option's edge is plain").toBeLessThan(1.5);
});

test("it works while a program waits for input: Stop is there and stops it", async ({ page }) => {
  await setUp(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 45_000 });
  await expect(page.locator("#live-input-field")).toBeFocused();
  await page.keyboard.press("F1");
  await expectOpen(page, "commands");
  await page.keyboard.type("stop");
  await expect(await activeOption(page)).toHaveAttribute("data-command", "stop");
  await expect(page.locator("#palette-list [data-command=run]")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle", { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
});

test("a read-only tab lists what it can't do and explains on choose, as the menus do", async ({ page, context }) => {
  await setUp(page);
  await expect(page.locator("#app")).toHaveAttribute("data-role", "writer");
  const second = await context.newPage();
  await second.setViewportSize({ width: 1440, height: 900 });
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");
  await expectActive(second, "main.py");
  const before = await second.locator(".cm-line").first().textContent();
  await second.locator(".cm-content").click();
  await second.keyboard.press("F1");
  await expect(second.locator("dialog#palette")).toHaveAttribute("data-state", "ready");
  await second.keyboard.type("comment");
  await expect(second.locator("#palette-list [role=option][aria-selected=true]")).toHaveAttribute("data-command", "comment");
  await second.keyboard.press("Enter");
  await expect(second.locator(".notice")).toHaveAttribute("data-tone", "info");
  await expect(second.locator(".notice")).not.toHaveAttribute("data-empty", "true");
  expect(await second.locator(".cm-line").first().textContent()).toBe(before);
  await second.close();
});

test("open, it passes axe and fits a 320 px window without sideways scrolling", async ({ page }) => {
  await setUp(page);
  await page.keyboard.press(`${MOD}+P`);
  await expectOpen(page, "all");
  const axe = (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id} x${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  expect(axe).toEqual([]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator("#palette-button").click();
  await expectOpen(page, "all");
  const fits = await page.evaluate(() => {
    const r = document.querySelector("dialog#palette")!.getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  expect(fits.left).toBeGreaterThanOrEqual(0);
  expect(fits.right).toBeLessThanOrEqual(fits.width);
  expect(fits.scroll).toBe(true);
  // The control is a 44 px target on a phone.
  await page.keyboard.press("Escape");
  const b = (await page.locator("#palette-button").boundingBox())!;
  expect(Math.round(b.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(b.height)).toBeGreaterThanOrEqual(44);
});
