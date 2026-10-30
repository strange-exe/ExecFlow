// Offline after the first load, with the real service worker (most specs block it): the page,
// Python and an installed C/C++ pack keep working offline (from the functional review, 2026-10-17).
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, importFiles, installCpp, openApp, openFromTree, reloadApp, run, setCode, showView, test, tolerating } from "./helpers";

test.setTimeout(240_000);

/** Waits until the service worker that precaches the app is active (main.ts registers it once Python is up). */
async function serviceWorkerActive(page: Page) {
  await expect
    .poll(
      () => page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg?.active?.state ?? "none";
      }),
      { timeout: 120_000 },
    )
    .toBe("activated");
}

async function goOffline(page: Page, context: BrowserContext) {
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await reloadApp(page);
  expect(await page.evaluate(() => crossOriginIsolated), "cross-origin isolated offline").toBe(true);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "page controlled by the service worker").toBe(true);
}

/** Every URL Cache Storage holds, cache by cache. */
const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });

/** The runtime's files, as python-download.ts RUNTIME_FILES lists them. */
const RUNTIME = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

// Python downloads on its first use, not on a first visit (the owner's "On first use", 2026-10-30).
test("a first visit keeps the app for offline use, and no part of Python", async ({ page }) => {
  await openApp(page);
  // The service worker registers after a quiet minute when Python isn't used, or when an offline
  // download starts (main.ts): the second, so the test needn't wait a minute.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("codeeditor:offline-wanted")));
  await serviceWorkerActive(page);
  const cached = await cachedUrls(page);
  const all = Object.values(cached).flat();
  // The precache really ran (the editor's page is in it): the check below isn't vacuous.
  expect(all, JSON.stringify(Object.keys(cached))).toContain("/index.html");
  expect(all.filter((u) => u.startsWith("/pyodide/"))).toEqual([]);
});

test("after Python's first use, the app opens offline and runs Python with live input", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  // The Python worker kept its runtime itself: no service worker controlled this first visit.
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "first visit not controlled").toBe(false);
  const kept = (await cachedUrls(page))["codeeditor-python-runtime"] ?? [];
  expect(kept.map((u) => u.split("/").pop()).sort()).toEqual([...RUNTIME].sort());
  await serviceWorkerActive(page);
  await goOffline(page, context);
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "main.py");
  const r = await run(page, { input: ["Ada"], timeout: 90_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("Ada");
  await context.setOffline(false);
});

test.describe("offline before Python's first use", () => {
  test.use(
    tolerating(
      // The loader and the runtime's files can't be fetched offline (each engine's words).
      /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
      /^Failed to load resource: The Internet connection appears to be offline\.$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+ /,
      /^no-response: no-response :: \[\{"url":"http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^"]+","error":\{\}\}\]$/,
      /^Failed to load resource: FetchEvent\.respondWith received an error: no-response: no-response :: .*\/pyodide\//,
      /^Fetch API cannot load http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\.$/,
      // The offline check's own request (Chromium's console line; WebKit's page error, split at "http:/").
      /^Failed to load resource: net::ERR_FAILED$/,
      /offline-probe-0-py3-none-any\.whl\.?$/,
    ),
  );

  test("Run says Python needs one online start, and runs once the device is online", async ({ page, context }) => {
    await openApp(page);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("codeeditor:offline-wanted")));
    await serviceWorkerActive(page);
    await goOffline(page, context);
    // The runtime's download goes through the service worker's route (vite.config.ts). Check that
    // offline emulation reaches the service worker's own requests in this engine (an uncached file
    // under the route must fail, not answer): Playwright's Firefox let it download Python "offline".
    const swOffline = await page.evaluate((url) => fetch(url).then(() => false, () => true), PROBE_WHEEL);
    test.skip(!swOffline, "this engine's offline emulation doesn't apply to the service worker's own requests");
    await importFiles(page, [{ name: "hi.py", text: 'print("online once")\n' }]);
    await openFromTree(page, "hi.py");
    const runtime = page.locator("#status-runtime");
    await expect(runtime).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
    await expect(runtime).toHaveText("Python needs a one-time download");
    const r = await run(page, { timeout: 30_000 });
    expect(r.status).toBe("unavailable");
    expect(r.output).toMatch(/Python needs a one-time download \(about \d+ MB\) the first time it runs, and this device is offline\. Connect to the internet and press Run again; after that, Python works offline too\./);
    expect(r.output).not.toContain("couldn't start");
    // Online again: Run starts Python (the "try again" is Run itself).
    await context.setOffline(false);
    const again = await run(page, { timeout: 120_000 });
    expect(again.status, again.output).toBe("ok");
    expect(again.output).toContain("online once");
  });
});

// The runtime's files are kept only by the Python worker, once each one's sha256 matched the build's
// (python-download.ts). On a page the service worker controls, the worker's download passes through
// the service worker's route for those files, which must never keep what the network sent itself
// (sw-cache-guard.ts neverStore): a damaged copy it kept would be served on every later start.
test("a damaged runtime file that passes through the service worker is never kept", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("codeeditor:offline-wanted")));
  await serviceWorkerActive(page);
  await reloadApp(page);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "page controlled by the service worker").toBe(true);
  const wasm = "**/pyodide/*/pyodide.asm.wasm";
  let throughWorker = 0;
  await context.route(wasm, async (route) => {
    if (route.request().serviceWorker()) throughWorker += 1;
    // The site's own file, the right size and type, with one byte changed on the way.
    const real = await route.fetch();
    const body = Buffer.from(await real.body());
    body[body.length >> 1] ^= 0xff;
    await route.fulfill({ response: real, body });
  });
  await importFiles(page, [{ name: "hi.py", text: 'print("whole again")\n' }]);
  await openFromTree(page, "hi.py");
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", /^(failed|ready)$/, { timeout: 60_000 });
  // Playwright routes the service worker's own requests in Chromium only; elsewhere this is untested.
  test.skip(throughWorker === 0, "this engine doesn't route the service worker's own requests");
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "failed");
  const r = await run(page, { timeout: 60_000 });
  expect(r.status).toBe("unavailable");
  expect(r.output).toContain("Python couldn't start: its one-time download was damaged (pyodide.asm.wasm didn't match). Press Run to try again.");
  const kept = ((await cachedUrls(page))["codeeditor-python-runtime"] ?? []).map((u) => u.split("/").pop());
  expect(kept).not.toContain("pyodide.asm.wasm");
  await context.unroute(wasm);
  const again = await run(page, { timeout: 120_000 });
  expect(again.status, again.output).toBe("ok");
  expect(again.output).toContain("whole again");
});

/** The folder vite.config.ts serves Pyodide from (version plus heap cap). */
const PYODIDE_DIR = `${JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version}-heap${JSON.parse(readFileSync("scripts/python-heap.json", "utf8")).mb}`;
const PROBE_WHEEL = `/pyodide/${PYODIDE_DIR}/offline-probe-0-py3-none-any.whl`;

// Section 3 of the research doc: keywords, snippets and the Tier 1 data work offline, because they
// are in or beside the precached CodeMirror chunk. From the behaviour review's probe (RB-3, 2026-10-19).
test("after the first visit, suggestions work offline: keywords, library names and your own names", async ({ page, context }) => {
  const editor = page.locator(".cm-editor");
  const option = (label: string) =>
    page.getByRole("listbox", { name: "Suggestions" }).getByRole("option")
      .filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  const offers = async (prefix: string, typed: string, label: string) => {
    await setCode(page, prefix);
    // The files a suggestion needs are read once typing pauses; this test is about offline, not timing.
    await expect(editor).toHaveAttribute("data-index", "ready");
    await page.keyboard.type(typed);
    await expect(editor).toHaveAttribute("data-completion", "active");
    await expect(option(label).first(), `${typed} offers ${label} offline`).toBeVisible();
    await page.keyboard.press("Escape");
  };
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await importFiles(page, [
    { name: "helpers.py", text: "def greet(name):\n    return name\n" },
    { name: "main.c", text: '#include "util.h"\nint main(void) {\n    return 0;\n}\n' },
    { name: "util.h", text: "int helper(int x);\n" },
  ]);
  await openFromTree(page, "main.py");
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await serviceWorkerActive(page);
  await goOffline(page, context);
  await openFromTree(page, "main.py");
  await showView(page, "code");
  // Neither data chunk was ever needed online after the reload: both come from the precache.
  await expect(editor).toHaveAttribute("data-library", "ready");
  await offers("", "pri", "print");
  await offers("", "import ma", "math");
  await offers("import math\n", "math.sq", "sqrt");
  await offers("import helpers\n", "helpers.gr", "greet");

  await openFromTree(page, "main.c");
  await showView(page, "code");
  await expect(editor).toHaveAttribute("data-library", "ready");
  await offers("", "#include <st", "stdio.h");
  await offers('#include "util.h"\nint main(void) {\n    ', "pri", "printf");
  await offers('#include "util.h"\nint main(void) {\n    ', "hel", "helper");
  await context.setOffline(false);
});

test.describe("a package never downloaded, first imported offline", () => {
  test.use(
    tolerating(
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\.whl /,
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\/offline-probe-0-py3-none-any\.whl$/,
      /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
      /^Failed to load resource: The Internet connection appears to be offline\.$/,
      // WebKit: the service worker's CacheFirst route has no cached copy and no network.
      /^no-response: no-response :: \[\{"url":"http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^"]+\.whl","error":\{\}\}\]$/,
      /^Failed to load resource: FetchEvent\.respondWith received an error: no-response: no-response :: .*\.whl/,
      /^Fetch API cannot load http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\.whl\.$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      // The offline check's own request (Chromium's console line; WebKit's page error, split at "http:/").
      /^Failed to load resource: net::ERR_FAILED$/,
      /offline-probe-0-py3-none-any\.whl\.?$/,
    ),
  );

  test("fails with a clear message, and works after going online and restarting Python", async ({ page, context }) => {
    await openApp(page);
    await importFiles(page, [{ name: "np.py", text: "import numpy as np\nprint(int(np.arange(4).sum()))\n" }]);
    await openFromTree(page, "np.py");
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await serviceWorkerActive(page);
    await goOffline(page, context);
    // The wheel download goes through the service worker's own fetch. Check that offline emulation
    // reaches it in this engine (an uncached wheel URL must fail, not answer 404).
    const swOffline = await page.evaluate((url) => fetch(url).then(() => false, () => true), PROBE_WHEEL);
    test.skip(!swOffline, "this engine's offline emulation doesn't apply to the service worker's own requests");
    const r = await run(page, { timeout: 120_000 });
    expect(r.status).toBe("error");
    test.info().annotations.push({ type: "offline numpy", description: r.output.slice(-600) });
    expect(r.output).toContain("numpy");
    await context.setOffline(false);
    await page.locator("#restart-python").click();
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    const again = await run(page, { timeout: 150_000 });
    expect(again.status, again.output).toBe("ok");
    expect(again.output).toContain("6");
  });
});

test("an installed C/C++ pack keeps working offline", async ({ page, context }) => {
  await openApp(page);
  await importFiles(page, [{ name: "hi.c", text: '#include <stdio.h>\nint main(void) { puts("offline hi"); return 0; }\n' }]);
  await openFromTree(page, "hi.c");
  await installCpp(page);
  const online = await run(page, { timeout: 150_000 });
  expect(online.status, online.output).toBe("ok");
  // Python never started here, so the service worker registers after a quiet minute (main.ts).
  await serviceWorkerActive(page);
  await goOffline(page, context);
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 60_000 });
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("offline hi");
  await context.setOffline(false);
});
