// Offline after the first load, with the real service worker (most specs block it): the page,
// Python and an installed C/C++ pack keep working offline (from the functional review, 2026-10-17).
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, importFiles, installCpp, openApp, openFromTree, reloadApp, run, test, tolerating } from "./helpers";

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

test("after the first visit the app opens offline and runs Python with live input", async ({ page, context }) => {
  await openApp(page);
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await serviceWorkerActive(page);
  await goOffline(page, context);
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "main.py");
  const r = await run(page, { input: ["Ada"], timeout: 90_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("Ada");
  await context.setOffline(false);
});

/** The folder vite.config.ts serves Pyodide from (version plus heap cap). */
const PYODIDE_DIR = `${JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version}-heap${JSON.parse(readFileSync("scripts/python-heap.json", "utf8")).mb}`;
const PROBE_WHEEL = `/pyodide/${PYODIDE_DIR}/offline-probe-0-py3-none-any.whl`;

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
