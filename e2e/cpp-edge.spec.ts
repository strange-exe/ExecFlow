// C and C++ under the conditions a real user creates (from the functional review, 2026-10-17). The
// pack is served by the local preview server; every test gets a fresh browser profile, so each
// downloads it.
import type { Page } from "@playwright/test";
import { expect, importFiles, installCpp, openApp, openFromTree, reloadApp, run, setCode, showView, test, tolerating, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

const runs = async (page: Page) => Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
const runtime = (page: Page) => page.locator("#status-runtime");

test.describe("a pack download that fails", () => {
  test.use(
    tolerating(
      /^HTTP 503: http:\/\/127\.0\.0\.1:\d+\/clang\/[^/]+\/clang\.wasm\.gz$/,
      /^Failed to load resource: the server responded with a status of 503( \(.*\))?$/,
    ),
  );

  test("says so, offers Try again, and Try again finishes it", async ({ page }) => {
    let fail = true;
    await page.route("**/clang/*/clang.wasm.gz", (route) => (fail ? route.fulfill({ status: 503, body: "busy" }) : route.continue()));
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
    await showView(page, "output");
    await page.locator("#pack-download").click();
    await expect(page.locator(".pack-offer")).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
    await expect(page.locator("#pack-download")).toBeVisible();
    fail = false;
    await page.locator("#pack-download").click();
    await expect(runtime(page)).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 120_000 });
    const r = await run(page, { timeout: 120_000 });
    expect(r.status, r.output).toBe("ok");
  });
});

test("reloading in the middle of the pack download: the offer comes back and the download completes", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/clang/*/sysroot.tar.gz", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await openApp(page);
  await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' }]);
  await openFromTree(page, "main.c");
  await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
  await showView(page, "output");
  await page.locator("#pack-download").click();
  await expect(runtime(page)).toHaveAttribute("data-state", "downloading");
  // Let the other files arrive first.
  await page.waitForTimeout(3000);
  await page.unroute("**/clang/*/sysroot.tar.gz");
  await reloadApp(page);
  release();
  await expect(runtime(page)).not.toHaveAttribute("data-state", /^(not-loaded|checking)$/, { timeout: 30_000 });
  const state = await runtime(page).getAttribute("data-state");
  test.info().annotations.push({ type: "after reload", description: `runtime state ${state}` });
  if (state === "absent") {
    await showView(page, "output");
    await page.locator("#pack-download").click();
  }
  await expect(runtime(page)).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 120_000 });
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("ok");
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("an installed pack is still installed after a reload (a first visit that goes straight to C)", async ({ page }) => {
    // Python never starts here, so the service worker would wait for a quiet minute; the pack
    // download registers it at once (main.ts). Measured 2026-10-17 in Playwright's WebKit: without
    // an active service worker, every entry of the pack's Cache Storage was gone after a reload.
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await installCpp(page);
    const r = await run(page, { timeout: 150_000 });
    expect(r.status, r.output).toBe("ok");
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
      .toBe("activated");
    await reloadApp(page);
    await expect(runtime(page)).not.toHaveAttribute("data-state", /^(not-loaded|checking)$/, { timeout: 30_000 });
    await expect(runtime(page), "the 19.6 MB pack is gone after a reload").not.toHaveAttribute("data-state", "absent");
    const again = await run(page, { timeout: 150_000 });
    expect(again.status, again.output).toBe("ok");
  });
});

/** Deletes one part of the C/C++ pack from Cache Storage, as a browser dropping an entry would. */
async function dropPackPart(page: Page, part: string): Promise<boolean> {
  return page.evaluate(async (name) => {
    let dropped = false;
    for (const cacheName of await caches.keys()) {
      if (!cacheName.startsWith("codeeditor-cpp-")) continue;
      const cache = await caches.open(cacheName);
      for (const req of await cache.keys()) if (new URL(req.url).pathname.endsWith(`/${name}`)) dropped = (await cache.delete(req)) || dropped;
    }
    return dropped;
  }, part);
}

/** Whether Cache Storage holds this part of the pack. */
const hasPackPart = (page: Page, part: string) =>
  page.evaluate(async (name) => {
    for (const cacheName of await caches.keys()) {
      if (!cacheName.startsWith("codeeditor-cpp-")) continue;
      const keys = await (await caches.open(cacheName)).keys();
      if (keys.some((req) => new URL(req.url).pathname.endsWith(`/${name}`))) return true;
    }
    return false;
  }, part);

test("a pack that lost a part offers the download again on the next visit, instead of failing to start", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' }]);
  await openFromTree(page, "main.c");
  await installCpp(page);
  expect(await dropPackPart(page, "clang")).toBe(true);
  await reloadApp(page);
  await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
  await showView(page, "output");
  await expect(page.locator("#pack-download")).toBeVisible();
  await page.locator("#pack-download").click();
  await expect(runtime(page)).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 120_000 });
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("ok");
});

test("a part that goes missing during the download is fetched again before the pack counts as installed", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/clang/*/sysroot.tar.gz", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await openApp(page);
  await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' }]);
  await openFromTree(page, "main.c");
  await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
  await showView(page, "output");
  await page.locator("#pack-download").click();
  // clang and lld come first; the sysroot is held back meanwhile.
  await expect.poll(() => hasPackPart(page, "lld"), { timeout: 60_000 }).toBe(true);
  expect(await dropPackPart(page, "clang")).toBe(true);
  release();
  await expect(runtime(page)).toHaveAttribute("data-state", /^(idle|booting|ready)$/, { timeout: 120_000 });
  expect(await hasPackPart(page, "clang")).toBe(true);
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("ok");
});

test("Stop while a C program waits in scanf, then the next run reads fresh input", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "twice.c", text: '#include <stdio.h>\nint main(void) {\n    int n;\n    if (scanf("%d", &n) != 1) return 2;\n    printf("%d\\n", n * 2);\n    return 0;\n}\n' }]);
  await openFromTree(page, "twice.c");
  await installCpp(page);
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 120_000 });
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
  await expect(page.locator("#live-input")).toBeHidden();
  const r = await run(page, { input: ["21"], timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("42");
});

test("a C program that floods stdout is stopped at the output limit", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "flood.c", text: '#include <stdio.h>\nint main(void) {\n    for (unsigned long i = 0;; i++) printf("line %lu\\n", i);\n}\n' }]);
  await openFromTree(page, "flood.c");
  await installCpp(page);
  const started = Date.now();
  const r = await run(page, { timeout: 120_000 });
  expect(r.status).toBe("output-limit");
  expect(r.output.length).toBeLessThan(600 * 1024);
  test.info().annotations.push({ type: "C flood", description: `${Date.now() - started} ms, ${r.output.length} chars` });
  const t0 = Date.now();
  await page.evaluate(() => 1);
  expect(Date.now() - t0).toBeLessThan(500);
});

test("the time limit from Settings stops a C program that never finishes", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "spin.c", text: "int main(void) {\n    volatile unsigned long n = 0;\n    for (;;) n++;\n}\n" }]);
  await openFromTree(page, "spin.c");
  await installCpp(page);
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Time limit (seconds)").fill("2");
  await settings.getByLabel("Time limit (seconds)").press("Tab");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  const started = Date.now();
  const r = await run(page, { timeout: 120_000 });
  expect(r.status).toBe("timeout");
  test.info().annotations.push({ type: "C time limit", description: `${Date.now() - started} ms including the build` });
  await expect(page.locator("[data-announcer]")).toHaveText(/2 second limit/);
});

test("double-clicking Run on a C file builds and runs it once", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "hi.c", text: '#include <stdio.h>\nint main(void) { puts("hi"); return 0; }\n' }]);
  await openFromTree(page, "hi.c");
  await installCpp(page);
  const before = await runs(page);
  await page.locator("#run-button").dblclick();
  await expect.poll(() => runs(page), { timeout: 120_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(3000);
  expect({
    finishedRuns: (await runs(page)) - before,
    status: await page.locator("#receipt").getAttribute("data-status"),
    printed: ((await page.locator("#console").textContent()) ?? "").includes("hi"),
  }).toEqual({ finishedRuns: 1, status: "ok", printed: true });
});

test("an error in a header in a sub-folder, included by two files, is listed once and marked in the header", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: '#include <stdio.h>\n#include "lib/util.h"\nint main(void) { printf("%d\\n", square(3)); return 0; }\n' },
    { name: "util.c", text: '#include "lib/util.h"\nint square(int x) { return x * x; }\n' },
  ]);
  // The header lives in lib/, created through the tree.
  await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
  await page.locator("#new-file").click();
  const name = page.getByRole("textbox", { name: "Name of the new file at the top level" });
  await name.fill("lib/util.h");
  await name.press("Enter");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "lib/util.h");
  await setCode(page, "#ifndef UTIL_H\n#define UTIL_H\nint square(int x)\n#endif\n");
  await openFromTree(page, "main.c");
  await installCpp(page);
  const r = await run(page, { timeout: 150_000 });
  expect(r.status).toBe("build-failed");
  await page.locator("#ptab-problems").click();
  const rows = await page.locator(".problem").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-path")}:${e.getAttribute("data-line")} ${e.querySelector(".problem-message")?.textContent}`));
  test.info().annotations.push({ type: "problems", description: JSON.stringify(rows) });
  expect(rows.some((row) => row.startsWith("lib/util.h:3 ")), JSON.stringify(rows)).toBe(true);
  expect(rows.length, `duplicate rows: ${JSON.stringify(rows)}`).toBe(new Set(rows).size);
  await page.locator('.problem[data-path="lib/util.h"]').first().click();
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "lib/util.h");
  await expect(page.locator("#status-pos")).toHaveText(/^Ln 3,/);
  await expect(page.locator(".cm-lint-marker-error").first()).toBeVisible();
});

test("a header renamed while the build runs: every Problems row names a file that exists", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: '#include <stdio.h>\n#include "util.h"\nint main(void) {\n    int n;\n    scanf("%d", &n);\n    printf("%d\\n", square(n));\n    return 0;\n}\n' },
    { name: "util.h", text: "int square(int x);\n" },
    { name: "util.c", text: '#include "util.h"\nint square(int x) { int unused; return x * x; }\n' },
  ]);
  await openFromTree(page, "main.c");
  await installCpp(page);
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "waiting", { timeout: 120_000 });
  // util.c has a warning (unused variable); rename it while the program waits.
  await treeItem(page, "util.c").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "New name for util.c" });
  await field.fill("square.c");
  await field.press("Enter");
  await expect(treeItem(page, "square.c")).toBeVisible();
  await page.locator("#live-input-field").fill("4");
  await page.locator("#live-input-field").press("Enter");
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 60_000 });
  await page.locator("#ptab-problems").click();
  const listed = await page.locator(".problem[data-path]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  const tree = await page.locator(".tree [role=treeitem]").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  test.info().annotations.push({ type: "problems", description: JSON.stringify(listed) });
  expect(listed.filter((p) => !tree.includes(p)), `Problems rows ${JSON.stringify(listed)} vs files ${JSON.stringify(tree)}`).toEqual([]);
});
