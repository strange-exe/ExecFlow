// Security review (SECURITY.md section 2): markup and text-direction payloads through every way
// text gets into the page: typed names, imported files, file content, program output and
// tracebacks, clang diagnostics and theme files. Nothing may execute or become an element, and no
// policy violation may even be attempted (CSP would block an injected handler, so "no alert" alone
// proves nothing: the DOM and the violation log are checked too).
import type { Page } from "@playwright/test";
import { expect, installCpp, OWN_JSON_LD, openApp, openFromTree, openThemePicker, run, setCode, showFiles, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const RLO = String.fromCodePoint(0x202e);
const IMG = "<img src=x onerror=alert(1)>";

/** Records dialogs and CSP violations from the first load on. */
async function watch(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`));
  });
  return dialogs;
}

/** Elements or attributes that only exist if some text was parsed as HTML. */
async function injected(page: Page) {
  return page.evaluate((ownJsonLd) => {
    const found: string[] = [];
    let ownSeen = false;
    for (const el of document.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) found.push(`${tag}[${a.name}]`);
      // CodeMirror's own cursor helpers are <img class="cm-widgetBuffer">.
      if (tag === "img" && !el.classList.contains("cm-widgetBuffer")) found.push("img");
      if (["b", "iframe", "object", "embed", "svg:script", "foreignobject"].includes(tag)) found.push(tag);
      // The page's own structured data (index.html: a JSON-LD data block in <head>, never run) is not
      // one: once, in <head>, with index.html's exact text. Any other is.
      const script = el as HTMLScriptElement;
      const ownData = !ownSeen && el.parentElement === document.head && script.type === "application/ld+json" && script.text === ownJsonLd;
      if (ownData) ownSeen = true;
      if (tag === "script" && !script.src && !ownData) found.push("inline script");
      if (/^\s*javascript:/i.test(el.getAttribute("href") ?? "")) found.push("javascript: link");
    }
    return { found, csp: (window as unknown as { __csp: string[] }).__csp };
  }, OWN_JSON_LD);
}

async function expectInert(page: Page, dialogs: string[]) {
  expect(await injected(page)).toEqual({ found: [], csp: [] });
  expect(dialogs).toEqual([]);
}

async function newEntry(page: Page, kind: "file" | "folder", name: string) {
  await showFiles(page);
  await page.locator(".tree-host").click({ position: { x: 20, y: 300 } });
  await page.locator(kind === "file" ? "#new-file" : "#new-folder").click();
  const field = page.getByRole("textbox", { name: new RegExp(`Name of the new ${kind}`) });
  await field.fill(name);
  await field.press("Enter");
  return field;
}

async function pick(page: Page, files: { name: string; text: string | Buffer }[]) {
  await showFiles(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: "text/plain", buffer: Buffer.isBuffer(f.text) ? f.text : Buffer.from(f.text) })));
}

/** A one-entry .zip (stored, CRC left 0) whose entry tries to climb out of the workspace. */
function zipWithEntry(entry: string): Buffer {
  const name = Buffer.from(entry);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  return Buffer.concat([local, name, Buffer.from("x = 1\n")]);
}

test("the inline-script check lets through only the page's own JSON-LD block: a second copy or an altered one is caught", async ({ page }) => {
  const dialogs = await watch(page);
  await openApp(page);
  await expectInert(page, dialogs);
  const own = page.locator('head > script[type="application/ld+json"]');
  await own.evaluate((el) => document.head.append(el.cloneNode(true)));
  expect((await injected(page)).found).toEqual(["inline script"]);
  await page.locator('head > script[type="application/ld+json"]').last().evaluate((el) => el.remove());
  await own.evaluate((el) => (el.textContent += " "));
  expect((await injected(page)).found).toEqual(["inline script"]);
});

test("typed file and folder names stay text: quotes and entities are kept literally, markup and direction characters are refused", async ({ page }) => {
  const dialogs = await watch(page);
  await openApp(page);
  const quoted = "q' onmouseover='alert(1)' x.py";
  await newEntry(page, "file", quoted);
  await expect(treeItem(page, quoted)).toBeVisible();
  await expect(treeItem(page, quoted).locator(":scope > .tree-row")).toContainText(quoted);
  const entity = "a&lt;b&gt;.py";
  await newEntry(page, "file", entity);
  await expect(treeItem(page, entity).locator(":scope > .tree-row")).toContainText(entity);

  for (const bad of [`<svg onload=alert(1)>`, "javascript:alert(1)", `x${RLO}yp.txt`]) {
    const field = await newEntry(page, "folder", bad);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
  }
  await expectInert(page, dialogs);
});

test("imported files: refused names are explained without markup or direction characters reaching the page", async ({ page }) => {
  const dialogs = await watch(page);
  await openApp(page);
  await pick(page, [
    { name: `${IMG}.py`, text: "print(1)\n" },
    { name: `evil${RLO}yp.txt`, text: "print(2)\n" },
    { name: "fine.py", text: `print("${IMG}")\n` },
    // The UI has no zip import: an archive is a binary file, refused whole, never extracted.
    { name: "evil.zip", text: zipWithEntry("../../escape.py") },
  ]);
  await expect(treeItem(page, "fine.py")).toBeVisible();
  await expect(treeItem(page, "evil.zip")).toHaveCount(0);
  expect(await page.locator(".tree [role=treeitem]").evaluateAll((items) => items.map((i) => i.getAttribute("data-path")))).toEqual(["fine.py"]);
  const notice = page.locator(".notice");
  await expect(notice).toHaveAttribute("data-tone", "warning");
  await expect(notice).toContainText(`${IMG}.py`);
  await notice.screenshot({ path: test.info().outputPath("refused-notice.png") });
  await expectInert(page, dialogs);
  // The refused name is shown, but its right-to-left override must not reorder the rest of the sentence.
  expect(await notice.textContent()).not.toContain(RLO);
});

test("file content, stdout, stderr, a traceback and its lint panel are text", async ({ page }) => {
  const dialogs = await watch(page);
  await openApp(page);
  const code = [
    "import sys",
    `print("${IMG}<b>out</b>")`,
    `sys.stderr.write("<b>err</b><img src=x onerror=alert(2)>" + chr(10))`,
    `raise ValueError("<img src=x onerror=alert(3)>")`,
  ].join("\n");
  await pick(page, [{ name: "markup.py", text: code + "\n" }]);
  await openFromTree(page, "markup.py");
  await expect(page.locator(".cm-content")).toContainText(`print("${IMG}<b>out</b>")`);
  const r = await run(page);
  expect(r.status).toBe("error");
  expect(r.output).toContain(`${IMG}<b>out</b>`);
  expect(r.output).toContain("<b>err</b><img src=x onerror=alert(2)>");
  expect(r.output).toContain("ValueError: <img src=x onerror=alert(3)>");
  await expect(page.locator("#console [data-stream=stderr]").first()).toBeVisible();
  await expect(page.locator(".problems .problem-message").first()).toHaveText("ValueError: <img src=x onerror=alert(3)>");
  // CodeMirror's lint panel renders the same message (renderMessage).
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".cm-panel-lint")).toContainText("<img src=x onerror=alert(3)>");
  await expectInert(page, dialogs);
});

test("clang diagnostics and C program output are text, and the C pack comes only from this site", async ({ page, context }) => {
  test.setTimeout(300_000);
  const site = new URL(test.info().project.use.baseURL!).origin;
  const foreign: string[] = [];
  context.on("request", (r) => {
    if (new URL(r.url()).origin !== site && !r.url().startsWith("data:")) foreign.push(r.url());
  });
  const dialogs = await watch(page);
  await openApp(page);
  await pick(page, [{ name: "main.c", text: `#include <stdio.h>\n#error ${IMG}\nint main(void) { return 0; }\n` }]);
  await openFromTree(page, "main.c");
  await installCpp(page);
  const bad = await run(page, { timeout: 180_000 });
  expect(bad.status).not.toBe("ok");
  await expect(page.locator(".problems .problem-message").first()).toContainText(IMG);
  await setCode(page, `#include <stdio.h>\nint main(void) { printf("${IMG}<b>c</b>\\n"); fprintf(stderr, "<b>err</b>\\n"); return 0; }\n`);
  const good = await run(page, { timeout: 120_000 });
  expect(good.status, good.output).toBe("ok");
  expect(good.output).toContain(`${IMG}<b>c</b>`);
  expect(good.output).toContain("<b>err</b>");
  await expectInert(page, dialogs);
  expect(foreign).toEqual([]);
});

test("theme files: a markup name is cleaned, unknown keys and CSS values are refused as text", async ({ page }) => {
  const dialogs = await watch(page);
  await openApp(page);
  const colors = Object.fromEntries(
    ["paper", "sheet", "bar", "ink", "muted", "rule", "accent", "on-accent", "ok", "err", "warn", "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-def"].map((k, i) => [k, i % 2 ? "#f0f0f0" : "#101010"]),
  );
  // Load theme file is in the theme picker's foot (Settings, Change theme) since Workbench Pro S4.
  const settings = await openThemePicker(page);
  const message = settings.locator(".theme-foot > [role=status]");
  const load = async (text: string) => {
    const chooser = page.waitForEvent("filechooser");
    await settings.getByRole("button", { name: "Load theme file" }).click();
    await (await chooser).setFiles({ name: "theme.json", mimeType: "application/json", buffer: Buffer.from(text) });
  };
  await load(JSON.stringify({ name: `${IMG} Night`, scheme: "dark", colors }));
  await expect(message).toHaveAttribute("data-tone", "info");
  await expect(message).toContainText("Loaded");
  // Only letters, digits, spaces and ._'()&+- are kept from a theme's name.
  await expect(settings.locator(".family-name").filter({ hasText: /^img srcx onerroralert\(1\) Night$/ })).toHaveCount(1);
  await load(JSON.stringify({ name: "x", scheme: "dark", colors: { ...colors, ink: "url(javascript:alert(1))" } }));
  await expect(message).toHaveAttribute("data-tone", "error");
  await load(JSON.stringify({ name: "x", scheme: "dark", colors, [IMG]: 1 }));
  await expect(message).toHaveAttribute("data-tone", "error");
  await expect(message).toContainText(IMG);
  // A JSON escape gets a direction character past the byte check; it must not reach the message either.
  const escaped = `{"name":"x","scheme":"dark","colors":${JSON.stringify(colors)},"${"\\"}u202eevil":1}`;
  await load(escaped);
  await expect(message).toHaveAttribute("data-tone", "error");
  // Only colours reach the page's inline style: #rrggbb, or #rrggbbaa for the four translucent band
  // tokens of contract v2 (src/theme/contrast.ts isTokenValue), and pixel sizes.
  const inline = await page.evaluate(() => [...document.documentElement.style].map((p) => [p, document.documentElement.style.getPropertyValue(p)] as const));
  expect(inline.length, "the loaded theme's colours are inline").toBeGreaterThan(0);
  for (const [prop, v] of inline) {
    const band = ["--active-line", "--error-band", "--selection", "--list-selected"].includes(prop);
    expect(v, prop).toMatch(band ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$|^\d+px$/i);
  }
  await expectInert(page, dialogs);
  expect(await message.textContent()).not.toContain(RLO);
});
