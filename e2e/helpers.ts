import { expect, test as base, type Page, type Request } from "@playwright/test";

/**
 * WebKit blocks the first worker created after any reload, then logs these itself. The app retries
 * and recovers (START_ATTEMPTS in the runners, ported from Pocket Run), so these exact messages are
 * tolerated in WebKit only.
 */
const WEBKIT_RECOVERED_WORKER_BLOCK = [
  /^Refused to load '[^']+\/assets\/(?:w\/)?[\w-]+\.js' worker because of Cross-Origin-Embedder-Policy\.$/,
  /^Worker load was blocked by Cross-Origin-Embedder-Policy$/,
  /^Failed to load resource: Worker load was blocked by Cross-Origin-Embedder-Policy$/,
  // Not end-anchored: WebKit's text can carry trailing whitespace, which a bare `$` rejects.
  /\/assets\/(?:w\/)?[\w-]+\.js due to access control checks/,
  /\/pyodide\/[\d.]+-heap\d+\/pyodide\.mjs due to access control checks/,
  // A reload or a navigation while the app is still registering its service worker cancels the sw.js download,
  // and WebKit logs the cancelled request this way (Pocket Run CI, 2026-10-12 to 10-15). Harmless:
  // registration happens on the next load. The offline tests prove the service worker really works.
  /^\/[\w.:]+\/sw\.js due to access control checks\.?\s*$/,
];

/**
 * Firefox also logs a console error when a navigation cancels a web font's download: status
 * 2152398850 is NS_BINDING_ABORTED (measured 2026-10-17, a reload right after the first load). The
 * cancelled request itself is covered by the navigation rule in the fixture below.
 */
const FIREFOX_CANCELLED_FONT = /^\[JavaScript Error: "downloadable font: download failed \(.*\): status=2152398850 source: \S+\.woff2"\]$/;

/** How each engine words a request it cancelled (not one that failed). */
const CANCELLED = /^(net::ERR_ABORTED|NS_BINDING_ABORTED|Load request cancelled)$/;

/**
 * WebKit: a navigation while the Python worker is still downloading Pyodide cancels those fetches
 * ("Load request cancelled", "due to access control checks" for pyodide-lock.json, the .wasm and the
 * stdlib zip), and Pyodide's parallel downloads that nobody awaits any more surface as these lines
 * (measured 2026-10-17: 1 run in 3 of workspace.spec.ts's first test). Like a cancelled request, they
 * are excused only when a main-frame navigation began within 2 s of them.
 */
const WEBKIT_CANCELLED_WORKER_LOAD = [
  /^Unhandled Promise Rejection: TypeError: Load failed$/,
  /^(Fetch API cannot|Cannot) load http:\/\/127\.0\.0\.1:\d+\/pyodide\/[\d.]+-heap\d+\/(pyodide-lock\.json|pyodide\.asm\.wasm|pyodide\.asm\.mjs|python_stdlib\.zip) due to access control checks\.?\s*$/,
];

/**
 * Fails any test whose page logs a console error, throws an uncaught exception, or has a request
 * fail or answer with status >= 400. A goto or reload starts a new document and the browser cancels
 * the old one's downloads (a lazy chunk, a font, the Python runtime): such a cancellation is not a
 * failure of the app. So a cancelled request is excused only when a main-frame navigation began
 * after the request started and at most 2 s after it was cancelled (engines report the cancel
 * and the navigation in either order: measured in Firefox and WebKit, 2026-10-17). Every other
 * cancellation, and every other failure, counts.
 * A test can declare extra, specific noise it expects with `test.use(tolerating(/.../))`.
 */
export const test = base.extend<{ consoleErrors: string[]; tolerate: RegExp[] }>({
  tolerate: [[], { option: true }],
  consoleErrors: [
    async ({ page, tolerate }, use, testInfo) => {
      const errors: string[] = [];
      const engine = testInfo.project.name;
      const tolerated = (text: string) =>
        tolerate.some((re) => re.test(text)) ||
        (engine === "webkit" && WEBKIT_RECOVERED_WORKER_BLOCK.some((re) => re.test(text))) ||
        (engine === "firefox" && FIREFOX_CANCELLED_FONT.test(text));
      /** Messages a navigation can explain: checked against the navigations once the test ends. */
      const ifNavigated: { text: string; at: number }[] = [];
      const record = (text: string) => {
        if (tolerated(text)) return;
        if (engine === "webkit" && WEBKIT_CANCELLED_WORKER_LOAD.some((re) => re.test(text))) ifNavigated.push({ text, at: Date.now() });
        else errors.push(text);
      };
      page.on("console", (m) => { if (m.type() === "error") record(m.text()); });
      // WebKit also reports the blocked worker load as a page error (no stack; Playwright splits
      // "Cannot load http://..." at the colon into name and message), so the same list applies.
      page.on("pageerror", (e) => { if (!tolerated(e.message) && !tolerated(`${e.name}:${e.message}`)) record(e.message); });
      const navigations: number[] = [];
      const startedAt = new WeakMap<Request, number>();
      const cancelled: { text: string; started: number; failed: number }[] = [];
      const startsDocument = (r: Request) => {
        try {
          return r.isNavigationRequest() && r.frame() === page.mainFrame();
        } catch {
          return false; // a request without a frame (service worker) never starts a document
        }
      };
      page.on("request", (r) => {
        startedAt.set(r, Date.now());
        if (startsDocument(r)) navigations.push(Date.now());
      });
      page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(Date.now()); });
      page.on("requestfailed", (r) => {
        const reason = (r.failure()?.errorText ?? "").trim();
        const text = `request failed: ${r.url()} ${reason}`;
        if (tolerated(text)) return;
        // A request whose start wasn't seen needs a navigation within 2 s either side of the cancel.
        if (CANCELLED.test(reason)) cancelled.push({ text, started: startedAt.get(r) ?? Date.now() - 2000, failed: Date.now() });
        else errors.push(text);
      });
      page.on("response", (r) => {
        const text = `HTTP ${r.status()}: ${r.url()}`;
        if (r.status() >= 400 && !tolerated(text)) errors.push(text);
      });
      await use(errors);
      for (const c of cancelled) {
        if (!navigations.some((t) => t >= c.started && t <= c.failed + 2000)) errors.push(c.text);
      }
      for (const m of ifNavigated) {
        if (!navigations.some((t) => t >= m.at - 2000 && t <= m.at + 2000)) errors.push(m.text);
      }
      expect(errors, "console errors and failed requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/**
 * Options for test.use() that tolerate these messages. Playwright reads an array given to test.use()
 * as its own [value, options] tuple, so `{ tolerate: [a, b] }` would arrive as just `a` (measured).
 */
export const tolerating = (...patterns: RegExp[]) => ({ tolerate: [patterns, { scope: "test" }] as unknown as RegExp[] });

/**
 * Grayscale and blur screenshots for the reading-order check (DESIGN-REFERENCE 1A). A modal
 * <dialog> and its ::backdrop sit in the top layer, which a filter on <html> doesn't reach (the
 * Connect dialog's "gray" shot was still in colour), so an open dialog gets the same filter.
 */
export async function hierarchyShots(page: Page, name: string) {
  for (const [kind, filter] of [["gray", "grayscale(1)"], ["blur", "blur(6px)"]] as const) {
    const tag = await page.addStyleTag({ content: `html{filter:${filter}} dialog[open]{filter:${filter}} dialog[open]::backdrop{backdrop-filter:${filter}}` });
    await page.screenshot({ path: `${name}-${kind}.png`, animations: "disabled" });
    await tag.evaluate((el) => (el as Element).remove());
  }
}

/** Loads `path`, then emulates the colour scheme and reloads (Firefox drops emulation set before the first load). */
export async function openIn(page: Page, path: string, colorScheme?: "light" | "dark") {
  await page.goto(path);
  if (!colorScheme) return;
  await page.emulateMedia({ colorScheme });
  await page.reload();
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "colour scheme applied").toBe(colorScheme === "dark");
}

// ---------------------------------------------------------------- the workbench (UI specs)

/** Opens the app and waits until the workbench says it is ready (storage open, tabs restored). */
export async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await waitReady(page);
}

export async function waitReady(page: Page) {
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

/**
 * Reads the body of every response whose path `wanted` accepts, for size and content checks.
 * `settled()` waits for every body seen so far and fails the test if one could not be read. A
 * response can also arrive after a test's last check: Playwright's click on a control in the empty
 * workspace moves the pointer over it, which prefetches the editor chunk (workbench.ts), and a read
 * still running when the test ends rejects with "Test ended" (measured in the gate run, 2026-10-18).
 * So each read keeps its own outcome instead of rejecting where nobody awaits it.
 */
export function responseBodies<T>(page: Page, wanted: (path: string) => boolean, read: (path: string, body: Buffer) => T) {
  const reads: Promise<{ path: string; value?: T; error?: string }>[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (!wanted(path)) return;
    reads.push(r.body().then((b) => ({ path, value: read(path, b) }), (e: unknown) => ({ path, error: String(e) })));
  });
  return {
    /** How many matching responses have arrived so far. */
    count: () => reads.length,
    async settled(): Promise<T[]> {
      const all = await Promise.all(reads);
      expect(all.filter((x) => x.error !== undefined).map((x) => `${x.path}: ${x.error}`), "response bodies that could not be read").toEqual([]);
      return all.map((x) => x.value as T);
    },
  };
}

/** Reloads and waits for the workbench to be ready again (downloads the reload cancels don't count). */
export async function reloadApp(page: Page) {
  await page.reload();
  await waitReady(page);
}

export type FileSpec = { name: string; text: string };

/** On narrow screens the file list is a drawer: open it (no-op where the sidebar always shows). */
export async function showFiles(page: Page) {
  const toggle = page.locator(".drawer-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await expect(page.locator("#sidebar")).toBeInViewport();
  }
}

/** Imports files through the real "Import files" picker (the sidebar's More file actions menu). */
export async function importFiles(page: Page, files: FileSpec[]) {
  await showFiles(page);
  const before = await page.locator(".tree [role=treeitem]").count();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: "text/plain", buffer: Buffer.from(f.text) })));
  await expect.poll(() => page.locator(".tree [role=treeitem]").count()).toBeGreaterThan(before);
}

/** The tree item for a path. */
export const treeItem = (page: Page, path: string) => page.locator(`.tree [role=treeitem][data-path="${path}"]`);

/** Below 900 px the layout is the phone one (drawer, view switch, no tab strip). */
export const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 900;

/**
 * The file is the active one: the editor is labelled with its path and shown, and its tab is the
 * selected one. Below 900 px there is no tab strip (files switch in the drawer), so there the tab
 * is checked as attached and selected; everywhere else it must be visible too.
 */
export async function expectActive(page: Page, path: string) {
  await expect(page.locator(`.cm-content[aria-label="Code editor, ${path}"]`)).toBeVisible();
  const tab = page.locator(`.tabs [role=tab][title="${path}"]`);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  if (!isNarrow(page)) await expect(tab).toBeVisible();
}

/** Opens a file from the tree and waits until it is the active file. */
export async function openFromTree(page: Page, path: string) {
  await showFiles(page);
  await treeItem(page, path).locator(":scope > .tree-row").click();
  await expectActive(page, path);
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Replaces the open file's text (typed as one insertion, so auto-closing brackets don't interfere). */
export async function setCode(page: Page, text: string) {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  if (text) await page.keyboard.insertText(text);
  else await page.keyboard.press("Delete");
  await expect.poll(async () => squash((await content.evaluate((el) => (el as HTMLElement).innerText)) ?? "")).toBe(squash(text));
}

/** Runs the open file and resolves once that run has finished: its receipt status and the console text. */
export async function run(page: Page, opts: { timeout?: number; input?: string[] } = {}) {
  // A file is open and runnable (opening one is asynchronous: storage is read first).
  await expect(page.locator("#app")).toHaveAttribute("data-runnable", "true");
  const runs = Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
  await page.locator("#run-button").click();
  for (const line of opts.input ?? []) {
    await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: opts.timeout ?? 45_000 });
    await page.locator("#live-input-field").fill(line);
    await page.locator("#live-input-field").press("Enter");
  }
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(runs + 1), { timeout: opts.timeout ?? 45_000 });
  return {
    status: await page.locator("#receipt").getAttribute("data-status"),
    output: (await page.locator("#console").textContent()) ?? "",
  };
}

/** On narrow screens, picks Code, Output or Problems in the switch (no-op where all show). */
export async function showView(page: Page, view: "code" | "output" | "problems") {
  const tab = page.locator(`#view-${view}`);
  if (await tab.isVisible()) await tab.click();
}

/**
 * Shows Output or Problems: below 900 px with the view switch (the panel's own tabs give way to
 * it there), elsewhere with the panel's tab (which also opens a collapsed panel).
 */
export async function showPanel(page: Page, tab: "output" | "problems") {
  await page.locator(isNarrow(page) ? `#view-${tab}` : `#ptab-${tab}`).click();
}

/** Opens the Input box (text given to the program first) from the panel bar's toggle. */
export async function openInputBox(page: Page) {
  const toggle = page.locator("#input-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator("#stdin")).toBeVisible();
}

/** Installs the C/C++ pack the way a student does: open a C file, press Download in Output. */
export async function installCpp(page: Page) {
  const runtime = page.locator("#status-runtime");
  await expect(runtime).toHaveAttribute("data-runtime", "cpp");
  await expect(runtime).not.toHaveAttribute("data-state", /^(not-loaded|checking)$/, { timeout: 30_000 });
  if ((await runtime.getAttribute("data-state")) === "absent") {
    await showView(page, "output");
    await page.locator("#pack-download").click();
  }
  await expect(runtime).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 120_000 });
}
