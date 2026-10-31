// Run and Output polish (UI/UX batch 2026-10-24, unit U3; .claude/tasks/ux-polish.md): Python's
// first download in words (B9), the C/C++ first run in two presses (B10), Run's step-back and the
// run header limited to the file they belong to (B11, owner decision), and help for runs stopped at
// a limit, crash words, a file without main() and the -O0 label (B13).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, importFiles, installCpp, openApp, openFromTree, reloadApp, run, setCode, showView, test, tolerating } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
const runs = async (page: Page) => Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
const runtime = (page: Page) => page.locator("#status-runtime");
const announcer = (page: Page) => page.locator("[data-announcer]");

/** Run's painted fill, with the pointer moved off it first (a hovered button is never transparent). */
async function runFill(page: Page) {
  await page.mouse.move(4, 4);
  return page.locator("#run-button").evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** Every data-phase the run header's status takes from now on (a MutationObserver in the page). */
async function recordPhases(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { phases: string[] }).phases = seen;
    const el = document.querySelector("#run-status")!;
    new MutationObserver(() => seen.push(el.getAttribute("data-phase") ?? "")).observe(el, { attributes: true, attributeFilter: ["data-phase"] });
  });
  return () => page.evaluate(() => (window as unknown as { phases: string[] }).phases);
}

/** Sets the time limit in Settings, as a student does. */
async function setTimeLimit(page: Page, seconds: number) {
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Time limit (seconds)").fill(String(seconds));
  await settings.getByLabel("Time limit (seconds)").press("Tab");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}

test.describe("B9: Python's first start", () => {
  test("says it downloads Python once, about how big and how far it got", async ({ page }) => {
    // The .wasm (the biggest part) is held back, as on a slow connection.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/pyodide/*/pyodide.asm.wasm", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
    await openFromTree(page, "main.py");
    await page.locator("#run-button").click();
    const status = page.locator("#run-status");
    await expect(status).toHaveAttribute("data-phase", "downloading", { timeout: 15_000 });
    await expect(status.locator(".phase-label")).toHaveText(/^Downloading Python \(one time, about \d+ MB\): \d+\.\d of \d+\.\d MB$/);
    // The status bar says it too, as it does for the C/C++ download.
    await expect(runtime(page)).toContainText(/^Downloading Python \d+%$/);
    release();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", "1", { timeout: 60_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok");
    await expect(page.locator("#console")).toContainText("hello");
  });

  // "One time" rests on the runtime kept in Cache Storage after the first start (0.19.0,
  // src/runner/python-download.ts; before that, the service worker's precache). Here the service
  // worker runs, as it does for a student, and no route is set (a page with routes has no HTTP cache).
  test.describe("with the service worker", () => {
    test.use({ serviceWorkers: "allow" });
    test("a start from this device's copy (the next visit) never mentions a download", async ({ page }) => {
      await openApp(page);
      await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
      await openFromTree(page, "main.py");
      await expect(runtime(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
      await expect
        .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? "none"), { timeout: 120_000 })
        .toBe("activated");
      await reloadApp(page);
      expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), "controlled by the service worker").toBe(true);
      await openFromTree(page, "main.py");
      const phases = await recordPhases(page);
      expect((await run(page)).status).toBe("ok");
      expect(await phases()).not.toContain("downloading");
    });
  });

  test("a start that has to fetch the runtime again (no service worker, no cache) says so", async ({ page }) => {
    // The control for the test above (its check is not vacuous): the .wasm arrives 2 s late.
    await page.route("**/pyodide/*/pyodide.asm.wasm", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue().catch(() => {});
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
    await openFromTree(page, "main.py");
    const phases = await recordPhases(page);
    expect((await run(page)).status).toBe("ok");
    expect(await phases()).toContain("downloading");
  });

  // The download's failure path (0.19.0: Python downloads on first use, src/runner/python-download.ts).
  test.describe("a runtime file the site doesn't send", () => {
    test.use(
      tolerating(
        /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\/pyodide\.asm\.wasm$/,
        /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      ),
    );

    test("says the download didn't finish, keeps none of it, and the next Run downloads it", async ({ page }) => {
      const wasm = "**/pyodide/*/pyodide.asm.wasm";
      await page.route(wasm, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
      await openApp(page);
      await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
      await openFromTree(page, "main.py");
      await expect(runtime(page)).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
      await expect(runtime(page)).toHaveText("Python couldn't start");
      const r = await run(page, { timeout: 30_000 });
      expect(r.status).toBe("unavailable");
      expect(r.output).toContain("Python couldn't start: its one-time download didn't finish (the site answered pyodide.asm.wasm with HTTP 404). Press Run to try again.");
      // The site answers again: Run is the retry, and nothing of the 404 was kept to get in its way.
      await page.unroute(wasm);
      const again = await run(page, { timeout: 60_000 });
      expect(again.status, again.output).toBe("ok");
      expect(again.output).toContain("hello");
    });
  });

  // The download's sha256 check (each file is pinned by the build, vite.config.ts __PYODIDE_FILES__).
  test("a runtime file that arrives damaged is never kept, and the next Run downloads it whole", async ({ page }) => {
    const wasm = "**/pyodide/*/pyodide.asm.wasm";
    let damaged = 0;
    await page.route(wasm, async (route) => {
      // The site's own file, the right size and type, with one byte changed on the way.
      const real = await route.fetch();
      const body = Buffer.from(await real.body());
      body[body.length >> 1] ^= 0xff;
      damaged += 1;
      await route.fulfill({ response: real, body });
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
    await openFromTree(page, "main.py");
    await expect(runtime(page)).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
    const r = await run(page, { timeout: 60_000 });
    expect(r.status).toBe("unavailable");
    expect(r.output).toContain("Python couldn't start: its one-time download was damaged (pyodide.asm.wasm didn't match). Press Run to try again.");
    expect(damaged, "the damaged copy was what the worker got").toBeGreaterThan(0);
    const kept = await page.evaluate(async () => (await (await caches.open("codeeditor-python-runtime")).keys()).map((k) => new URL(k.url).pathname.split("/").pop()));
    expect(kept).not.toContain("pyodide.asm.wasm");
    await page.unroute(wasm);
    const again = await run(page, { timeout: 60_000 });
    expect(again.status, again.output).toBe("ok");
    expect(again.output).toContain("hello");
  });

  // The download never holds more of a file than the build's size for it (python-download.ts). The
  // refused answer is cancelled, which Chromium reports as an aborted request.
  test.describe("a runtime file bigger than the build's", () => {
    test.use(tolerating(/^request failed: http:\/\/127\.0\.0\.1:\d+\/pyodide\/[^ ]+\/pyodide\.asm\.wasm net::ERR_ABORTED$/));
    test("is refused, never kept, and the next Run downloads it", async ({ page }) => {
      const wasm = "**/pyodide/*/pyodide.asm.wasm";
      await page.route(wasm, async (route) => {
        const real = await route.fetch();
        // The site's own file with 1 MB more after it (another file under the name, a padded answer).
        const body = Buffer.concat([Buffer.from(await real.body()), Buffer.alloc(1024 * 1024)]);
        await route.fulfill({ status: 200, contentType: "application/wasm", body });
      });
      await openApp(page);
      await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
      await openFromTree(page, "main.py");
      await expect(runtime(page)).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
      const r = await run(page, { timeout: 60_000 });
      expect(r.status).toBe("unavailable");
      // Refused by its declared length or, without one, at the piece that passes the size.
      expect(r.output).toMatch(/Python couldn't start: its one-time download was damaged \(pyodide\.asm\.wasm (is \d+ bytes, more than|is larger than) the \d+ bytes expected\)\. Press Run to try again\./);
      const kept = await page.evaluate(async () => (await (await caches.open("codeeditor-python-runtime")).keys()).map((k) => new URL(k.url).pathname.split("/").pop()));
      expect(kept).not.toContain("pyodide.asm.wasm");
      await page.unroute(wasm);
      const again = await run(page, { timeout: 60_000 });
      expect(again.status, again.output).toBe("ok");
      expect(again.output).toContain("hello");
    });
  });

  // A kept copy is checked again by the first start of each page load (python-download.ts missingFiles).
  // With the service worker allowed, as for a student: Playwright's WebKit with service workers
  // blocked kept no Cache Storage across a reload (measured 2026-10-31), which would make this vacuous.
  test.describe("a kept copy, on the next page load", () => {
    test.use({ serviceWorkers: "allow" });
    test("a kept runtime file that changed on this device is caught by the page's next start and downloaded again", async ({ page }) => {
      await openApp(page);
      await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
      await openFromTree(page, "main.py");
      await expect(runtime(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
      /** The kept .wasm's sha256, or null when none is kept. */
      const keptWasm = () =>
        page.evaluate(async () => {
          const cache = await caches.open("codeeditor-python-runtime");
          const key = (await cache.keys()).find((k) => k.url.endsWith("/pyodide.asm.wasm"));
          if (!key) return null;
          const digest = await crypto.subtle.digest("SHA-256", await (await cache.match(key))!.arrayBuffer());
          return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        });
      const whole = await keptWasm();
      // The build's own file: the first start kept exactly it.
      const dir = readdirSync("public/pyodide")[0];
      expect(whole).toBe(createHash("sha256").update(readFileSync(`public/pyodide/${dir}/pyodide.asm.wasm`)).digest("hex"));
      // One byte of the kept copy changes, the type and size stay (a flipped bit on disk).
      await page.evaluate(async () => {
        const cache = await caches.open("codeeditor-python-runtime");
        const key = (await cache.keys()).find((k) => k.url.endsWith("/pyodide.asm.wasm"))!;
        const bytes = new Uint8Array(await (await cache.match(key))!.arrayBuffer());
        bytes[bytes.length >> 1] ^= 0xff;
        await cache.put(key, new Response(bytes, { headers: { "content-type": "application/wasm" } }));
      });
      expect(await keptWasm(), "the copy really changed").not.toBe(whole);
      await reloadApp(page);
      // The kept files outlived the reload (the check below would prove nothing otherwise).
      const keptNames = await page.evaluate(async () => (await (await caches.open("codeeditor-python-runtime")).keys()).map((k) => k.url.split("/").pop()));
      expect(keptNames, "Cache Storage kept across the reload").toContain("python_stdlib.zip");
      await openFromTree(page, "main.py");
      const r = await run(page, { timeout: 60_000 });
      expect(r.status, r.output).toBe("ok");
      expect(r.output).toContain("hello");
      expect(await keptWasm(), "the changed copy was replaced by the site's").toBe(whole);
    });
  });

  // What the sha256 pin does not cover (python-download.ts, header): on a page no service worker
  // controls, the loader and its glue are run by import(), which goes to the network, not to the
  // checked copies. Only the copies kept for the service worker (later visits) are pinned.
  test("on a page no service worker controls, the runtime's two scripts are imported from the network", async ({ page }) => {
    const asked: Record<string, number> = {};
    await page.route("**/pyodide/*/*.{mjs,wasm}", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop()!;
      asked[name] = (asked[name] ?? 0) + 1;
      await route.continue();
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: 'print("hello")\n' }]);
    await openFromTree(page, "main.py");
    await expect(runtime(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
    // The .wasm is asked for once (the checked download; Pyodide's own fetch is answered from it).
    expect(asked["pyodide.asm.wasm"]).toBe(1);
    // Each script twice: the checked download, then the import that runs it.
    expect(asked["pyodide.mjs"]).toBe(2);
    expect(asked["pyodide.asm.mjs"]).toBe(2);
  });
});

test.describe("B10: the C/C++ first run", () => {
  test.setTimeout(240_000);

  test("Run, then Download: the program runs once the download is in, and the notice goes", async ({ page }) => {
    // The last part of the pack is held back, so the download is seen running.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/clang/*/sysroot.tar.gz", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("pack ok"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
    const notice = page.locator(".notice");

    await page.locator("#run-button").click();
    await expect(page.locator("#pack-download")).toBeFocused();
    await expect(notice).toContainText("one-time download first");
    // Download, from the keyboard where Run left the focus.
    await page.keyboard.press("Enter");
    await expect(runtime(page)).toHaveAttribute("data-state", "downloading");
    await expect(notice, "the notice's button was used").not.toContainText("one-time download first");
    await expect(page.locator(".pack-offer")).toContainText("main.c runs when it finishes.");
    // The focus didn't fall to the page when the button went.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

    release();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", "1", { timeout: 120_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok");
    await expect(page.locator("#console")).toContainText("pack ok");
    await expect(page.locator(".pack-offer")).toBeHidden();
    await expect(notice).not.toContainText("download");
    // The offer held the focus when it went: Run (whose press it stood for) has it now.
    await expect(page.locator("#run-button")).toBeFocused();
    await page.waitForTimeout(1500);
    expect(await runs(page), "it ran once").toBe(1);
  });

  test("Run pressed while the download runs: one run, once it is in", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/clang/*/sysroot.tar.gz", async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("pack ok"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
    await showView(page, "output");
    await page.locator("#pack-download").click();
    await expect(runtime(page)).toHaveAttribute("data-state", "downloading");
    await expect(page.locator(".pack-offer")).not.toContainText("runs when it finishes");
    await page.locator("#run-button").click();
    await expect(page.locator(".notice")).toContainText("main.c runs as soon as it finishes.");
    await expect(page.locator(".pack-offer")).toContainText("main.c runs when it finishes.");
    expect(await runs(page)).toBe(0);
    release();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", "1", { timeout: 120_000 });
    await expect(page.locator("#console")).toContainText("pack ok");
    await page.waitForTimeout(1500);
    expect(await runs(page), "it ran once").toBe(1);
  });

  test.describe("a download that fails", () => {
    test.use(
      tolerating(
        /^HTTP 503: http:\/\/127\.0\.0\.1:\d+\/clang\/[^/]+\/sysroot\.tar\.gz$/,
        /^Failed to load resource: the server responded with a status of 503( \(.*\))?$/,
      ),
    );
  test("drops the queued run: a later download runs nothing by itself", async ({ page }) => {
    // The first download fails (the pack's last part is refused); the second goes through.
    let refuse = true;
    await page.route("**/clang/*/sysroot.tar.gz", (route) => (refuse ? route.fulfill({ status: 503, body: "busy" }) : route.continue()));
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("late"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 30_000 });
    await page.locator("#run-button").click();
    await expect(page.locator("#pack-download")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(runtime(page)).toHaveAttribute("data-state", "absent", { timeout: 60_000 });
    // Nothing on screen still promises the run.
    await expect(page.locator(".notice")).not.toContainText("runs as soon as it finishes");
    await expect(page.locator(".pack-offer")).not.toContainText("runs when it finishes");
    refuse = false;
    await showView(page, "output");
    await page.locator("#pack-download").click();
    await expect(runtime(page)).not.toHaveAttribute("data-state", /absent|downloading|checking/, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    expect(await runs(page), "the old press doesn't run the file much later").toBe(0);
  });
  });

  test("a download started from the offer alone runs nothing by itself", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "main.c", text: '#include <stdio.h>\nint main(void) { puts("x"); return 0; }\n' }]);
    await openFromTree(page, "main.c");
    await installCpp(page);
    await page.waitForTimeout(1500);
    expect(await runs(page)).toBe(0);
  });
});

test.describe("B11: Run's step-back and the run header belong to the file that ran", () => {
  test("another file's Run stays filled, the header says Last run: bad.py, and coming back steps back again", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [
      { name: "bad.py", text: "print(1 / 0)\n" },
      { name: "other.py", text: "print('fine')\n" },
    ]);
    await openFromTree(page, "other.py");
    const filled = await runFill(page);
    expect(filled).not.toMatch(TRANSPARENT);
    await openFromTree(page, "bad.py");
    expect((await run(page)).status).toBe("error");
    const app = page.locator("#app");
    const file = page.locator("#runlog .rl-file");
    await expect(app).toHaveAttribute("data-last-run", "failed");
    await expect(file).toHaveText("bad.py");
    await expect(page.locator("#runlog")).not.toHaveAttribute("data-other");

    // A file that never ran: its Run is filled, and the header says whose result it shows.
    await openFromTree(page, "other.py");
    await expect(app).not.toHaveAttribute("data-last-run");
    expect(await runFill(page)).toBe(filled);
    await expect(file).toHaveText("Last run: bad.py");
    await expect(page.locator("#runlog")).toHaveAttribute("data-other", "");

    // Back to the file that failed: Run steps back again, the header is its own.
    await openFromTree(page, "bad.py");
    await expect(app).toHaveAttribute("data-last-run", "failed");
    await expect(file).toHaveText("bad.py");

    // An edit (anywhere: the fix may be in a file the program uses) ends the step-back.
    await openFromTree(page, "other.py");
    await setCode(page, "print('still fine')\n");
    await openFromTree(page, "bad.py");
    await expect(app).not.toHaveAttribute("data-last-run");

    // Running the other file makes the header its own.
    await openFromTree(page, "other.py");
    expect((await run(page)).status).toBe("ok");
    await expect(file).toHaveText("other.py");
    await openFromTree(page, "bad.py");
    await expect(file).toHaveText("Last run: other.py");
  });

  test("Last run names the folder when the open file has the same name (lab1/bad.py is not lab2/bad.py)", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "readme.txt", text: "notes\n" }]);
    // Files in folders go in through New file, which makes the folders (import keeps base names).
    for (const [path, code] of [["lab1/bad.py", "print('one')\n"], ["lab2/bad.py", "print(1 / 0)\n"]]) {
      await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
      await page.locator("#new-file").click();
      const field = page.getByRole("textbox", { name: /Name of the new file/ });
      await field.fill(path);
      await field.press("Enter");
      await expect(page.locator(`.tree [role=treeitem][data-path="${path}"]`)).toHaveCount(1);
      await setCode(page, code);
    }
    await openFromTree(page, "lab2/bad.py");
    expect((await run(page)).status).toBe("error");
    await openFromTree(page, "lab1/bad.py");
    await expect(page.locator("#runlog .rl-file")).toHaveText("Last run: lab2/bad.py");
  });
});

test.describe("B13: runs that never end, crashes, and a file without main()", () => {
  test("the output limit: help about a loop that never ends, and no exit code 130", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "flood.py", text: "n = 0\nwhile n < 10:\n    print(n)\n" }]);
    await openFromTree(page, "flood.py");
    expect((await run(page)).status).toBe("output-limit");
    await expect(page.locator("#receipt")).not.toContainText("exit code");
    const help = page.locator("#run-help");
    await expect(help).toHaveAttribute("data-help", "limit-output");
    await expect(help).toHaveAttribute("role", "note");
    await expect(help).toContainText("A loop that never ends prints the same lines again and again.");
  });

  test("the time limit: help about the loop's condition, and no exit code 130; Stop shows no exit code either", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [{ name: "spin.py", text: "n = 0\nwhile n < 10:\n    pass\n" }]);
    await openFromTree(page, "spin.py");
    await setTimeLimit(page, 2);
    expect((await run(page)).status).toBe("timeout");
    await expect(page.locator("#receipt")).not.toContainText("exit code");
    const help = page.locator("#run-help");
    await expect(help).toHaveAttribute("data-help", "limit-time");
    await expect(help).toContainText("after the 2 second time limit");
    await expect(help).toContainText("Check that each pass of the loop changes what its condition tests");

    await setTimeLimit(page, 30);
    const before = await runs(page);
    await page.locator("#run-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-run", "running");
    await page.waitForTimeout(1000);
    await page.locator("#run-button").click();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 30_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
    await expect(page.locator("#receipt")).not.toContainText("exit code");
    await expect(page.locator("#run-help")).toHaveCount(0);
  });

  test("a C crash is one plain sentence after Crashed, never 'crashed' twice", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    await importFiles(page, [{ name: "boom.c", text: "#include <stdlib.h>\nint main(void) {\n    abort();\n}\n" }]);
    await openFromTree(page, "boom.c");
    await installCpp(page);
    expect((await run(page, { timeout: 120_000 })).status).toBe("crashed");
    await expect(page.locator("#console .note")).toContainText("The program stopped itself: abort() was called");
    await expect(announcer(page)).toHaveText(/^Crashed\. The program stopped itself: abort\(\) was called/);
    const words = `${await page.locator("#runlog").textContent()} ${await page.locator("#console").textContent()} ${await announcer(page).textContent()}`;
    expect(words.toLowerCase()).not.toMatch(/crashed: the program crashed/);
    expect(words.match(/crashed/gi) ?? []).toHaveLength(2); // the header's status word, and the announcement's
  });

  test("running a helper file without main() offers the program's main.c, and the offer runs it", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    await importFiles(page, [
      { name: "main.c", text: '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%d\\n", square(7)); return 0; }\n' },
      { name: "util.h", text: "int square(int x);\n" },
      { name: "util.c", text: '#include "util.h"\nint square(int x) { return x * x; }\n' },
    ]);
    await openFromTree(page, "util.c");
    await installCpp(page);
    expect((await run(page, { timeout: 120_000 })).status).toBe("build-failed");
    const offer = page.locator("#run-offer");
    await expect(offer).toContainText("This file has no main().");
    const button = offer.getByRole("button", { name: "Run main.c" });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator("#app")).toHaveAttribute("data-runs", "2", { timeout: 120_000 });
    await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "main.c");
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "ok");
    await expect(page.locator("#console")).toContainText("49");
    await expect(offer).toHaveCount(0);
  });

  test("the offer goes as soon as Run is pressed again, so it can never act as Stop for the starting run", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    await importFiles(page, [
      { name: "main.c", text: '#include <stdio.h>\nint square(int x);\nint main(void) { printf("%d\\n", square(7)); return 0; }\n' },
      { name: "util.c", text: "int square(int x) { return x * x; }\n" },
    ]);
    await openFromTree(page, "util.c");
    await installCpp(page);
    expect((await run(page, { timeout: 120_000 })).status).toBe("build-failed");
    await expect(page.locator("#run-offer")).toBeVisible();
    // Run again, then the old offer in the same task (while the run is still starting).
    const offerLeft = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#run-button")!.click();
      const button = document.querySelector<HTMLButtonElement>("#run-offer-button");
      button?.click();
      return Boolean(button?.isConnected);
    });
    expect(offerLeft, "the offer is gone the moment Run is pressed").toBe(false);
    await expect(page.locator("#app")).toHaveAttribute("data-runs", "2", { timeout: 120_000 });
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "build-failed");
    await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "util.c");
  });

  test("Settings says what -O0 costs", async ({ page }) => {
    await openApp(page);
    await page.locator("#settings-button").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.locator('#set-opt option[value="0"]')).toHaveText("-O0 (none, quickest to build; makes memory bugs harder to see)");
  });
});
