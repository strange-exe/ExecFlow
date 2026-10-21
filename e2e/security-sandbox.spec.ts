// Security review (SECURITY.md sections 1-4): response headers on every kind of file the build
// serves, and what Python code can still do from inside its worker after the lockdown.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, openFromTree, run, test, tolerating } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const OUT = process.env.PW_OUTDIR ?? "dist";

/** The policy every response must carry (vite.config.ts directives with GitHub allowed). */
const PAGE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' https://api.github.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

function servedPaths(): string[] {
  const list = (dir: string) => readdirSync(join(OUT, dir)).filter((f) => !f.includes("."+"map"));
  const pyDir = readdirSync(join(OUT, "pyodide"))[0];
  const clangDir = readdirSync(join(OUT, "clang"))[0];
  return [
    "/",
    "/index.html",
    "/sw.js",
    "/theme-boot.js",
    "/manifest.webmanifest",
    "/icons/mark-v2.svg",
    "/some/deep/route",
    ...list("assets").filter((f) => f !== "w").map((f) => `/assets/${f}`),
    ...list("assets/w").map((f) => `/assets/w/${f}`),
    `/pyodide/${pyDir}/pyodide.mjs`,
    `/pyodide/${pyDir}/pyodide-lock.json`,
    `/clang/${clangDir}/manifest.json`,
  ];
}

test("every file the site serves carries the page policy, nosniff and isolation; worker files add the site-only policy", async ({ request }) => {
  const problems: string[] = [];
  for (const path of servedPaths()) {
    const res = await request.get(path);
    const h = res.headers();
    if (res.status() !== 200) problems.push(`${path}: HTTP ${res.status()}`);
    const policies = (h["content-security-policy"] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const page = policies[0] ?? "";
    for (const d of PAGE_DIRECTIVES) if (!page.split(";").map((x) => x.trim()).includes(d)) problems.push(`${path}: page policy lacks ${d}`);
    if (/'unsafe-eval'/.test(page)) problems.push(`${path}: unsafe-eval`);
    if (h["x-content-type-options"] !== "nosniff") problems.push(`${path}: no nosniff`);
    if (h["cross-origin-embedder-policy"] !== "require-corp") problems.push(`${path}: no COEP`);
    if (h["cross-origin-opener-policy"] !== "same-origin") problems.push(`${path}: no COOP`);
    if (path.startsWith("/assets/w/")) {
      const worker = policies[1] ?? "";
      if (policies.length !== 2 || !worker.includes("connect-src 'self';") || worker.includes("api.github.com")) problems.push(`${path}: worker policy missing or allows GitHub (${policies.length} policies)`);
    } else if (policies.length !== 1) problems.push(`${path}: ${policies.length} policies`);
  }
  expect(problems).toEqual([]);
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });
  // The test injects an inline script on purpose; each engine reports the refusal in its own words.
  test.use(
    tolerating(
      /^Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval''/,
      /^Refused to execute (inline script|a script because)/,
      /blocked an inline script/,
    ),
  );

  test("a page the service worker serves from its cache keeps the policy and cross-origin isolation", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    await page.locator('.starter[data-language="python"]').click();
    await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
    // main.ts registers the service worker once Python is up; wait until it is installed and active.
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null), { timeout: 180_000 })
      .toBe("activated");
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { scope: reg?.scope, active: reg?.active?.state, waiting: reg?.waiting?.state ?? null, controller: Boolean(navigator.serviceWorker.controller) };
    });
    test.info().annotations.push({ type: "registration before reload", description: JSON.stringify(state) });
    const response = await page.goto("/");
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    const after = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { active: reg?.active?.state, controller: navigator.serviceWorker.controller?.state ?? null };
    });
    expect(after.controller, JSON.stringify({ state, after })).toBe("activated");
    test.info().annotations.push({ type: "served by", description: response?.fromServiceWorker() ? "service worker" : "network" });
    const csp = response?.headers()["content-security-policy"] ?? "";
    for (const d of PAGE_DIRECTIVES) expect(csp.split(";").map((x) => x.trim())).toContain(d);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const ran = await page.evaluate(async () => {
      const s = document.createElement("script");
      s.textContent = "window.__swInjected = true";
      document.head.append(s);
      await new Promise((r) => setTimeout(r, 200));
      return (window as unknown as { __swInjected?: boolean }).__swInjected === true;
    });
    expect(ran).toBe(false);
  });
});

/**
 * Python that posts `msg` to the page the way a program can (js.self.postMessage throws "Illegal
 * invocation" in Chromium, so the other spellings are tried too). Raises with every error if none works.
 */
const forge = (msg: unknown) =>
  [
    "import js, json",
    "def post(text):",
    "    obj = js.JSON.parse(text)",
    "    errors = []",
    "    for how in ('global', 'self', 'reflect'):",
    "        try:",
    "            if how == 'global':",
    "                js.postMessage(obj)",
    "            elif how == 'self':",
    "                js.self.postMessage(obj)",
    "            else:",
    "                js.Reflect.apply(js.DedicatedWorkerGlobalScope.prototype.postMessage, js.globalThis, js.Array.of(obj))",
    "            return how",
    "        except Exception as e:",
    "            errors.append(how + ': ' + str(e))",
    "    raise RuntimeError('; '.join(errors))",
    `post(${JSON.stringify(JSON.stringify(msg))})`,
  ].join("\n");

/** Starts Python on a probe file and returns the console text of its run. */
async function runProbe(page: Page, name: string, code: string, opts: { timeout?: number } = {}) {
  await importFiles(page, [{ name, text: code }]);
  await openFromTree(page, name);
  return run(page, { timeout: opts.timeout ?? 60_000 });
}

test("Pyodide's own helpers can't reach storage or the network after the lockdown", async ({ page, context }) => {
  const site = new URL(test.info().project.use.baseURL!).origin;
  const foreign: string[] = [];
  context.on("request", (r) => {
    if (new URL(r.url()).origin !== site && !r.url().startsWith("data:")) foreign.push(r.url());
  });
  await openApp(page);
  const code = [
    "import js, pyodide_js",
    "def probe(label, fn):",
    "    try:",
    "        fn()",
    "        print(label, 'reachable')",
    "    except BaseException as e:",
    "        print(label, 'blocked')",
    // Emscripten's IDBFS looks the global indexedDB up when it is used.
    "probe('IDBFS.indexedDB', lambda: pyodide_js.FS.filesystems.IDBFS.indexedDB().open)",
    // pyodide.http.open_url is a synchronous XMLHttpRequest.
    "probe('open_url', lambda: __import__('pyodide.http', fromlist=['open_url']).open_url('/index.html'))",
    "probe('indexedDB getter', lambda: js.Object.getOwnPropertyDescriptor(js.WorkerGlobalScope.prototype, 'indexedDB').get)",
    "probe('caches getter', lambda: js.Object.getOwnPropertyDescriptor(js.WorkerGlobalScope.prototype, 'caches').get)",
    "probe('fetch on the prototype', lambda: js.WorkerGlobalScope.prototype.fetch.call)",
    "probe('locks on the prototype', lambda: js.Object.getOwnPropertyDescriptor(js.WorkerNavigator.prototype, 'locks').get)",
    "probe('Function constructor', lambda: js.Function.new('return 1'))",
    "probe('WebSocket via self', lambda: js.self.WebSocket.new('wss://example.invalid/'))",
  ].join("\n");
  const r = await runProbe(page, "probe2.py", code);
  expect(r.status, r.output).toBe("ok");
  const lines = r.output.trim().split("\n");
  expect(lines.length).toBe(8);
  for (const line of lines) expect(line).toMatch(/ blocked$/);
  expect(foreign).toEqual([]);
});

const forgedDone = { type: "done", exitCode: 0, interrupted: false, recycle: false, outOfMemory: false, ms: 1, diagnostics: [], written: [{ path: "ok.txt", text: "x\n" }], writtenSkipped: 0 };

test("a program can't send the page messages: every way to reach postMessage fails, and nothing is offered", async ({ page }) => {
  await openApp(page);
  const r = await runProbe(page, "forge.py", [forge(forgedDone), "print('never shown')"].join("\n"));
  // The forge raised (no postMessage is left to call), so the program ended with its own error.
  expect(r.status, r.output).toBe("error");
  expect(r.output).toContain("RuntimeError");
  for (const how of ["global", "self", "reflect"]) expect(r.output).toContain(`${how}: `);
  expect(r.output).not.toContain("never shown");
  await expect(page.locator(".notice").getByRole("button", { name: "Add to workspace" })).toHaveCount(0);
  expect(await page.locator(".tree [role=treeitem]").evaluateAll((items) => items.map((i) => i.getAttribute("data-path")))).toEqual(["forge.py"]);
});

test("a program that tries to forge a 'done' can't outlive the run: Stop and the time limit still hold, and the next run works", async ({ page }) => {
  await openApp(page);
  await page.locator("#settings-button").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Time limit (seconds)").fill("3");
  await settings.getByLabel("Time limit (seconds)").press("Tab");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  // If the forge got through, the page would think the run ended while the loop kept going.
  const code = ["try:", ...forge(forgedDone).split("\n").map((l) => `    ${l}`), "except RuntimeError:", "    pass", "while True:", "    pass"].join("\n");
  const first = await runProbe(page, "hide.py", code);
  expect(first.status, first.output).toBe("timeout");
  const second = await runProbe(page, "second.py", "print('second ran')\n", { timeout: 30_000 });
  expect(second.status, second.output).toBe("ok");
  expect(second.output).toContain("second ran");
});

test("a program that clears or replaces the worker's message handler doesn't stall the next run", async ({ page }) => {
  await openApp(page);
  // Python's js.globalThis is a proxy, so js.self.onmessage = ... and setattr(js, ...) reach the
  // setter with the wrong `this` and throw in every engine. Calling the setter itself with no `this`
  // does reach the real global (measured in all three engines, 2026-10-17): that is the spelling a
  // program would use, and it must work here, or this test would pass without the worker going deaf.
  const code = [
    "import js",
    "from pyodide.ffi import create_proxy",
    "def accessor(kind):",
    "    p = js.globalThis",
    "    while p is not None:",
    "        d = js.Object.getOwnPropertyDescriptor(p, 'onmessage')",
    "        if d is not None:",
    "            return getattr(d, kind)",
    "        p = js.Object.getPrototypeOf(p)",
    "    raise RuntimeError('no onmessage accessor')",
    "def assign(value):",
    "    js.Reflect.apply(accessor('set'), None, js.Array.of(value))",
    "assign(None)",
    // JS null reads back as None or as pyodide.ffi.jsnull, depending on the Pyodide version.
    "print('cleared', repr(js.Reflect.apply(accessor('get'), None, js.Array.of())))",
    "assign(create_proxy(lambda e: None))",
    "print('replaced', js.Reflect.apply(accessor('get'), None, js.Array.of()) is not None)",
  ].join("\n");
  const first = await runProbe(page, "deaf.py", code);
  expect(first.status, first.output).toBe("ok");
  expect(first.output).toMatch(/^cleared (None|jsnull|null)$/m);
  expect(first.output).toMatch(/^replaced True$/m);
  // The same warm worker runs this one: it must still hear the page, well inside the 15 s limit.
  const t0 = Date.now();
  const second = await runProbe(page, "second.py", "print('second ran')\n", { timeout: 30_000 });
  expect(second.status, second.output).toBe("ok");
  expect(second.output).toContain("second ran");
  expect(Date.now() - t0, "the second run waited for the time limit").toBeLessThan(12_000);
});

