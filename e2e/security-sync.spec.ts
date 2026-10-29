// Security review (SECURITY.md sections 0 and 2): what a hostile repository can put on the page, where
// the GitHub token can be found after Connect, and whether "Sign out and clear this computer" really
// deletes both databases.
import type { Page } from "@playwright/test";
import { expect, importFiles, openApp, test, treeItem, waitReady } from "./helpers";
import { answer, connectGitHub, fillConnect, githubNoise, openConnect, routeGitHub, saveKey, secrets, syncCount, syncNoise, syncStatus, waitSync } from "./sync-fake";

test.use({ serviceWorkers: "block" });
test.use(syncNoise());
test.setTimeout(120_000);

const RLO = String.fromCodePoint(0x202e);
const IMG = "<img src=x onerror=alert(1)>";

/** Elements or attributes that only exist if some text was parsed as HTML. */
async function injected(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) found.push(`${tag}[${a.name}]`);
      if (tag === "img" && !el.classList.contains("cm-widgetBuffer")) found.push("img");
      // The page's own structured data (index.html: a JSON-LD data block in <head>, never run) is not one.
      const ownData = el.parentElement === document.head && (el as HTMLScriptElement).type === "application/ld+json";
      if (tag === "script" && !(el as HTMLScriptElement).src && !ownData) found.push("inline script");
    }
    return found;
  });
}

test("a hostile repository's names never reach the page: markup, direction and unsafe paths are left out, odd but valid names are text", async ({ page }) => {
  const gh = await routeGitHub(page);
  const odd = "ok'onmouseover=alert(1)'.py";
  await gh.fake.remoteCommit({
    "main.py": "print('hi')\n",
    [odd]: `print("${IMG}")\n`,
    [`${IMG}.py`]: "print(1)\n",
    [`evil${RLO}yp.txt`]: "x\n",
    ".git/hooks/post-checkout": "#!/bin/sh\necho owned\n",
    "con.py": "x = 1\n",
    "dir/../escape.py": "x = 1\n",
  });
  await openApp(page);
  const n = await syncCount(page);
  await connectGitHub(page);
  await waitSync(page, n, "synced");
  const paths = await page.locator(".tree [role=treeitem]").evaluateAll((items) => items.map((i) => i.getAttribute("data-path")).sort());
  expect(paths).toEqual(["main.py", odd]);
  await expect(page.locator(".notice")).toContainText("names this computer can't use");
  const pageText = await page.evaluate(() => document.documentElement.outerHTML);
  expect(pageText).not.toContain(RLO);
  expect(pageText).not.toContain("onerror=alert");
  await treeItem(page, odd).locator(":scope > .tree-row").click();
  await expect(page.locator(".cm-content")).toContainText(`print("${IMG}")`);
  expect(await injected(page)).toEqual([]);
});

test.describe("a hostile default branch", () => {
  test.use(syncNoise(/^HTTP 404: https:\/\/api\.github\.com\/repos\/me\/workspace\/git\/ref\/heads\/%3Cimg/, ...githubNoise(404).slice(1)));

  test("its name is shown as text and never changes where requests go", async ({ page }) => {
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
    let branch = IMG;
    gh.fake.interceptors.push((req) =>
      req.method === "GET" && req.path === ""
        ? new Response(JSON.stringify({ full_name: IMG, private: true, default_branch: branch }), { status: 200, headers: { "content-type": "application/json" } })
        : undefined,
    );
    await openApp(page);
    const dialog = await openConnect(page);
    await fillConnect(page, {});
    await page.locator("#connect-submit").click();
    await expect(dialog).toHaveAttribute("data-state", "failed");
    await expect(page.locator("#connect-branch-error")).toContainText(`no branch called ${IMG}`);
    branch = "../../../user";
    await page.locator("#connect-submit").click();
    await expect(page.locator("#connect-branch-error")).toContainText("isn't a valid branch name");
    for (const r of gh.seen) expect(r.url.startsWith("https://api.github.com/repos/me/workspace")).toBe(true);
    expect(gh.seen.map((r) => new URL(r.url).pathname)).not.toContain("/user");
    expect(await injected(page)).toEqual([]);
  });
});

/** Every string the page keeps where a script or a person could read it later. */
async function storedText(page: Page): Promise<{ where: string; text: string }[]> {
  return page.evaluate(async () => {
    const out: { where: string; text: string }[] = [];
    const latin1 = new TextDecoder("latin1");
    const walk = (v: unknown, seen = new Set<unknown>()): string => {
      if (v === null || v === undefined) return "";
      if (typeof v === "string") return v + "\n";
      if (typeof v !== "object") return String(v) + "\n";
      if (seen.has(v)) return "";
      seen.add(v);
      if (v instanceof ArrayBuffer) return latin1.decode(new Uint8Array(v)) + "\n";
      if (ArrayBuffer.isView(v)) return latin1.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) + "\n";
      if (typeof CryptoKey !== "undefined" && v instanceof CryptoKey) return "[CryptoKey]\n";
      if (v instanceof Date) return v.toISOString() + "\n";
      let s = "";
      for (const [k, x] of v instanceof Map ? v.entries() : Object.entries(v as object)) s += String(k) + "\n" + walk(x, seen);
      return s;
    };
    const names = (await indexedDB.databases()).map((d) => d.name!).filter(Boolean);
    for (const name of names) {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const [values, keys] = await Promise.all(
          ["getAll", "getAllKeys"].map(
            (m) =>
              new Promise<unknown>((resolve, reject) => {
                const r = (db.transaction(store).objectStore(store) as unknown as Record<string, () => IDBRequest>)[m]();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
              }),
          ),
        );
        out.push({ where: `indexedDB ${name}/${store}`, text: walk(values) + walk(keys) });
      }
      db.close();
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        let body = "";
        const size = Number(res?.headers.get("content-length") ?? 0);
        if (res && size < 8 * 1024 * 1024) body = latin1.decode(new Uint8Array(await res.arrayBuffer()));
        out.push({ where: `cache ${name} ${req.url}`, text: req.url + "\n" + JSON.stringify([...(res?.headers ?? [])]) + "\n" + body });
      }
    }
    out.push({ where: "localStorage", text: JSON.stringify({ ...localStorage }) });
    out.push({ where: "sessionStorage", text: JSON.stringify({ ...sessionStorage }) });
    out.push({ where: "cookie", text: document.cookie });
    out.push({ where: "DOM", text: document.documentElement.outerHTML });
    out.push({ where: "field values", text: [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n") });
    out.push({ where: "URL and history", text: location.href + JSON.stringify(history.state) });
    out.push({ where: "resource timing", text: performance.getEntries().map((e) => e.name).join("\n") });
    return out;
  });
}

test.describe("the token", () => {
  test.use(syncNoise(...githubNoise(422, "/git/trees")));

  test("is found only in the Authorization header: not in any other request, the console, the page, Cache Storage or IndexedDB (encrypted there)", async ({ page, context }) => {
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
    const consoleText: string[] = [];
    page.on("console", (m) => consoleText.push(m.text()));
    page.on("pageerror", (e) => consoleText.push(e.message));
    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    context.on("request", (r) => {
      void r.allHeaders().then((headers) => requests.push({ url: r.url(), headers, body: r.postData() ?? "" }));
    });
    await openApp(page);
    await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
    let n = await syncCount(page);
    await connectGitHub(page, { remember: true });
    await waitSync(page, n, "synced");
    // GitHub (or something pretending to be it) echoes the token in an error message.
    const echo = (req: { method: string; path: string }) => (req.method === "POST" && req.path === "/git/trees" ? answer(422, `tree rejected for ${gh.token}`) : undefined);
    gh.fake.interceptors.push(echo);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("# edit\n");
    n = await syncCount(page);
    await saveKey(page);
    await waitSync(page, n, "failed");
    await expect(page.locator(".notice")).toContainText("Sync failed");

    const stored = await storedText(page);
    expect(stored.filter((s) => s.text.includes(gh.token)).map((s) => s.where)).toEqual([]);
    expect(stored.some((s) => s.where.startsWith("indexedDB codeeditor-secrets/"))).toBe(true);
    expect(await secrets(page, gh.token)).toEqual({ hasKey: true, extractable: false, hasToken: true, clear: false });
    expect(consoleText.filter((t) => t.includes(gh.token))).toEqual([]);
    const leaks = requests.filter(
      (r) => r.url.includes(gh.token) || r.body.includes(gh.token) || Object.entries(r.headers).some(([k, v]) => v.includes(gh.token) && !(k === "authorization" && r.url.startsWith("https://api.github.com/"))),
    );
    expect(leaks.map((r) => r.url)).toEqual([]);
    const sentTo = new Set(requests.filter((r) => r.headers.authorization).map((r) => new URL(r.url).origin));
    expect([...sentTo]).toEqual(["https://api.github.com"]);
  });
});

/** Database names, or null where the engine can't list them. */
const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());

async function clearThisComputer(page: Page) {
  await page.locator("#settings-button").click();
  await page.locator("#sign-out-clear").click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  const reloaded = page.waitForEvent("framenavigated", { timeout: 30_000 });
  await confirm.getByRole("button", { name: "Clear this computer" }).click();
  await reloaded;
  await waitReady(page);
}

test("Sign out and clear this computer deletes the workspace and the secrets databases and every codeeditor key", async ({ page }) => {
  const gh = await routeGitHub(page);
  await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }, { name: "local-only.py", text: "x = 1\n" }]);
  const n = await syncCount(page);
  await connectGitHub(page, { remember: true });
  await waitSync(page, n, "synced");
  expect((await secrets(page, gh.token)).hasToken).toBe(true);
  expect(await databases(page)).toEqual(["codeeditor", "codeeditor-secrets"]);
  const before = Date.now();
  const sent = gh.seen.length;

  await clearThisComputer(page);
  expect(await databases(page)).not.toContain("codeeditor-secrets");
  // The workspace database the new visit opened is a new one: made after the clear, holding nothing old.
  const fresh = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = indexedDB.open("codeeditor");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const get = (store: string, m: "getAll" | "get", key?: string) =>
      new Promise<unknown>((resolve, reject) => {
        const s = db.transaction(store).objectStore(store);
        const r = m === "get" ? s.get(key!) : s.getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const result = {
      schema: (await get("meta", "get", "schema")) as { migratedAt?: number } | undefined,
      entries: ((await get("entries", "getAll")) as { path: string }[]).map((e) => e.path),
      remotes: ((await get("workspaces", "getAll")) as { remote: unknown }[]).map((w) => w.remote ?? null),
    };
    db.close();
    return result;
  });
  expect(fresh.schema?.migratedAt ?? 0).toBeGreaterThanOrEqual(before);
  expect(fresh.entries).toEqual([]);
  expect(fresh.remotes).toEqual([null]);
  await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
  expect(gh.seen.length).toBe(sent);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("codeeditor:")));
  // Only what the fresh start after the reload writes again: the theme's first paint, and the version
  // seen (so the next update can say what's new; the Privacy page lists it). Nothing of the old session.
  expect(keys.filter((k) => !["codeeditor:theme-paint", "codeeditor:last-seen-version"].includes(k))).toEqual([]);
});

test("Sign out and clear with a second tab open still deletes both databases, and the other tab doesn't bring anything back", async ({ page, context }) => {
  test.setTimeout(150_000);
  const gh = await routeGitHub(page);
  await gh.fake.remoteCommit({ "main.py": "print('hi')\n" });
  await openApp(page);
  await importFiles(page, [{ name: "main.py", text: "print('hi')\n" }]);
  const n = await syncCount(page);
  await connectGitHub(page, { remember: true });
  await waitSync(page, n, "synced");

  const second = await context.newPage();
  const otherCalls: string[] = [];
  await second.route("https://api.github.com/**", (route) => {
    otherCalls.push(route.request().url());
    return route.fulfill({ status: 503, body: "" });
  });
  await openApp(second);
  await expect(second.locator("#app")).toHaveAttribute("data-role", "reader");

  await clearThisComputer(page);
  // Give the other tab time to react (it is told to close its connection) and to try anything it would.
  await expect(second.locator(".notice")).toHaveAttribute("data-tone", "warning", { timeout: 15_000 });
  await second.waitForTimeout(3000);
  expect(await databases(page)).not.toContain("codeeditor-secrets");
  const entries = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = indexedDB.open("codeeditor");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = await new Promise<{ path: string }[]>((resolve, reject) => {
      const r = db.transaction("entries").objectStore("entries").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return all.map((e) => e.path);
  });
  expect(entries).toEqual([]);
  expect(otherCalls).toEqual([]);
  // The tab that cleared is the one the user works in next.
  await expect(page.locator("#app")).toHaveAttribute("data-role", "writer", { timeout: 10_000 });
  await second.close();
});
