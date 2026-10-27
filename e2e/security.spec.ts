import { expect, importFiles, openApp, openFromTree, run, test, tolerating } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(90_000);

const FAKE_TOKEN = "github_pat_11FAKE0TEST0TOKEN0FOR0E2E0ONLY000000000000000000000000000000000";

/** Plants a token-shaped secret where "Remember on this computer" keeps the real one. */
async function plantSecret(page: import("@playwright/test").Page) {
  await page.evaluate(async (token) => {
    const open = indexedDB.open("codeeditor-secrets", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("secrets");
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction("secrets", "readwrite");
    tx.objectStore("secrets").put({ planted: token }, "e2e-planted");
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();
  }, FAKE_TOKEN);
}

test("the page and every worker script it starts carry the Content-Security-Policy", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (w) => workers.push(w.url()));
  const response = await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
  await page.locator('.starter[data-language="python"]').click();
  await expect(page.locator("#status-runtime")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  expect(workers.length).toBeGreaterThan(0);
  for (const url of [response!.url(), ...workers]) {
    const csp = (await page.request.get(url)).headers()["content-security-policy"] ?? "";
    expect(csp, url).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp, url).toContain("object-src 'none'");
    expect(csp, url).not.toContain("'unsafe-eval'");
  }
  for (const url of workers) {
    // Worker scripts get the second, site-only policy as well: no GitHub and no analytics script.
    const policies = ((await page.request.get(url)).headers()["content-security-policy"] ?? "").split(",").map((p) => p.trim());
    expect(policies.some((p) => p.includes("connect-src 'self';") && p.includes("script-src 'self' 'wasm-unsafe-eval';") && !p.includes("api.github.com") && !p.includes("cloudflareinsights")), url).toBe(true);
  }
});

// page.evaluate() itself runs outside the page's CSP checks (it is the automation channel), so eval
// inside it proves nothing. What an attacker could do, inject markup with a script, is checked
// instead; eval in the workers is checked through Python's run_js below.
test.describe("the page's policy", () => {
  // This test injects a script on purpose; each engine reports the refusal in its own words.
  test.use(
    tolerating(
      /^Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval'[^']*'/,
      /^Refused to execute (inline script|a script because)/,
      /blocked an inline script/,
    ),
  );
  test("an injected inline script never runs, and the policy forbids eval", async ({ page }) => {
    const response = await page.goto("/");
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
    const csp = response!.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
    // Besides the site itself, only Cloudflare's analytics beacon (the exact script and its versioned paths).
    expect(scriptSrc).toBe("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com/beacon.min.js https://static.cloudflareinsights.com/beacon.min.js/");
    const violations = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener("securitypolicyviolation", (e) => seen.push(e.violatedDirective));
      const s = document.createElement("script");
      s.textContent = "window.__injected = true";
      document.head.append(s);
      await new Promise((r) => setTimeout(r, 200));
      return { ran: (window as unknown as { __injected?: boolean }).__injected === true, seen };
    });
    expect(violations.ran).toBe(false);
    expect(violations.seen.some((d) => d.startsWith("script-src"))).toBe(true);
  });
});

// Cloudflare injects its analytics beacon at the edge as beacon.min.js/<version>; a source without a
// trailing slash matches one exact path, so this proves the versioned path loads (a stand-in script,
// served with the real beacon's CORP header, keeps the test off the network).
test.describe("the analytics beacon", () => {
  // The test asks for another script from the beacon's host on purpose; each engine reports the refusal.
  test.use(tolerating(/static\.cloudflareinsights\.com\/other\.js/));
  test("the page's policy lets Cloudflare's versioned analytics beacon load, and nothing else from its host", async ({ page }) => {
    await page.route("https://static.cloudflareinsights.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", headers: { "Cross-Origin-Resource-Policy": "cross-origin", "Access-Control-Allow-Origin": "*" }, body: "window.__beacon = (window.__beacon || 0) + 1;" }),
    );
    await page.goto("/");
    await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
    const result = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener("securitypolicyviolation", (e) => seen.push(e.blockedURI));
      const load = (src: string) =>
        new Promise<string>((resolve) => {
          const s = document.createElement("script");
          s.src = src;
          s.onload = () => resolve("loaded");
          s.onerror = () => resolve("blocked");
          document.head.append(s);
        });
      const versioned = await load("https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092");
      const other = await load("https://static.cloudflareinsights.com/other.js");
      await new Promise((r) => setTimeout(r, 200));
      return { versioned, other, ran: (window as unknown as { __beacon?: number }).__beacon ?? 0, seen };
    });
    expect(result.versioned).toBe("loaded");
    expect(result.other).toBe("blocked");
    expect(result.ran).toBe(1);
    expect(result.seen.some((u) => u.includes("other.js"))).toBe(true);
  });
});

test("Python code can't reach storage, the network, locks or other tabs, with a secret planted", async ({ page }) => {
  await openApp(page);
  await plantSecret(page);
  const names = ["indexedDB", "caches", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "BroadcastChannel"];
  const code = [
    "import js",
    `for name in ${JSON.stringify(names)}:`,
    "    print(name, 'present' if js.Reflect.has(js, name) else 'absent')",
    "for name in ['storage', 'serviceWorker', 'locks']:",
    "    print('navigator.' + name, 'present' if js.Reflect.has(js.WorkerNavigator.prototype, name) else 'absent')",
    "from pyodide.code import run_js",
    "for label, src in [('eval', '1 + 1'), ('Function', 'Function(\"return 1\")()')]:",
    "    try:",
    "        run_js(src)",
    "        print(label, 'allowed')",
    "    except Exception as e:",
    "        print(label, 'refused')",
  ].join("\n");
  await importFiles(page, [{ name: "probe.py", text: code }]);
  await openFromTree(page, "probe.py");
  const r = await run(page);
  expect(r.status, r.output).toBe("ok");
  const lines = r.output.trim().split("\n");
  expect(lines).toHaveLength(names.length + 3 + 2);
  for (const line of lines) expect(line).toMatch(/ (absent|refused)$/);
  expect(r.output).not.toContain(FAKE_TOKEN);
});

test("nothing is requested from any origin but this site (and GitHub's API, which nothing here calls)", async ({ page, context }) => {
  test.setTimeout(150_000);
  const origins = new Set<string>();
  context.on("request", (req) => origins.add(new URL(req.url()).origin));
  await openApp(page);
  await plantSecret(page);
  await importFiles(page, [{ name: "np.py", text: "import numpy as np\nprint(np.ones(3).sum())\n" }]);
  await openFromTree(page, "np.py");
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("ok");
  await page.locator("#settings-button").click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const site = new URL(page.url()).origin;
  const others = [...origins].filter((o) => o !== site && o !== "https://api.github.com" && !o.startsWith("data:") && o !== "null");
  expect(others).toEqual([]);
});

test("file names and program output are shown as text, never as markup", async ({ page }) => {
  await openApp(page);
  const name = "x<img src=x onerror=alert(1)>.py";
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await (await chooser).setFiles([{ name: "markup.py", mimeType: "text/plain", buffer: Buffer.from('print("<img src=x onerror=alert(1)><b>bold</b>")\n') }]);
  await openFromTree(page, "markup.py");
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const r = await run(page);
  expect(r.output).toContain("<img src=x onerror=alert(1)><b>bold</b>");
  expect(await page.locator("#console img, #console b").count()).toBe(0);
  // A typed file name with markup characters is refused or kept as text, never parsed.
  await page.locator("#new-file").click();
  const field = page.getByRole("textbox", { name: /Name of the new file/ });
  await field.fill(name);
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-invalid", "true"); // < > aren't allowed in names
  await page.keyboard.press("Escape");
  expect(await page.locator(".tree img").count()).toBe(0);
  expect(dialogs).toBe(0);
});
