// Command-line arguments (track R, batch 3; spec .claude/design/batch3/r.md): the Arguments field
// beside the Input text, kept per file, split like a shell's simple command but never expanded,
// and passed as sys.argv[1:] or argv[1..]. Tests wait on state attributes (data-state on the
// field's row, data-runs, data-run), never on wording; the expected sentences come from the code
// that words them.
import type { APIResponse, Page, Route } from "@playwright/test";
import { formatArgs, parseArgs } from "../src/runner/run-args";
import { expect, importFiles, installCpp, openApp, openFromTree, reloadApp, run, test, tolerating, treeItem } from "./helpers";
import { connectGitHub, routeGitHub, syncCount, syncNoise, syncStatus, waitSync } from "./sync-fake";

test.use({ serviceWorkers: "block" });
test.setTimeout(120_000);

const cp = (...points: number[]) => String.fromCodePoint(...points);
const HELLO = `h${cp(0xe9)}llo`;
const JAPANESE = cp(0x65e5, 0x672c, 0x8a9e);

/** Prints sys.argv as one line of JSON (ASCII only, so the console's text parses back exactly). */
const ARGV_PY = "import sys, json\nprint(json.dumps(sys.argv))\n";
/** sys.argv[0]: the script's path, as Python's runpy sets it (unchanged by this feature). */
const script = (entry: string) => `/workspace/${entry}`;
const field = (page: Page) => page.locator("#args-field");
const row = (page: Page) => page.locator("#args-row");
const runs = async (page: Page) => Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
const reasonOf = (text: string) => {
  const parsed = parseArgs(text);
  if (parsed.ok) throw new Error("expected arguments that can't be split");
  return parsed.reason;
};

/** Opens the Input box (the toggle puts the caret in the Input text) and checks the field is there. */
async function openBox(page: Page) {
  const toggle = page.locator("#input-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(field(page)).toBeVisible();
}

/** The last console line that is a JSON list: what the program printed. */
async function printedArgv(page: Page): Promise<string[]> {
  const text = (await page.locator("#console").textContent()) ?? "";
  const line = text.split("\n").reverse().find((l) => l.startsWith("["));
  if (!line) throw new Error(`no argv line in ${JSON.stringify(text)}`);
  return JSON.parse(line) as string[];
}

/** The per-file Arguments texts as stored (the workspace records' ui.args, read from IndexedDB). */
function storedArgs(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all: { ui?: { args?: Record<string, string> } }[] = await new Promise((resolve, reject) => {
      const q = db.transaction("workspaces").objectStore("workspaces").getAll();
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    db.close();
    return Object.assign({}, ...all.map((w) => w.ui?.args ?? {})) as Record<string, string>;
  });
}

/** Writes `args` into every workspace record's ui.args, as an earlier visit's saves would have; returns how many records. */
function seedArgs(page: Page, args: Record<string, string>): Promise<number> {
  return page.evaluate(async (args) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const open = indexedDB.open("codeeditor");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const count: number = await new Promise((resolve, reject) => {
      const tx = db.transaction("workspaces", "readwrite");
      const store = tx.objectStore("workspaces");
      const q = store.getAll();
      let n = 0;
      q.onsuccess = () => {
        for (const rec of q.result as { ui: { args?: Record<string, string> } }[]) {
          store.put({ ...rec, ui: { ...rec.ui, args: { ...rec.ui.args, ...args } } });
          n++;
        }
      };
      tx.oncomplete = () => resolve(n);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return count;
  }, args);
}

/** Routes the Arguments field's chunk (found by its hint: its name is a hash) to `answer`. */
async function routeArgsChunk(page: Page, answer: (route: Route, response: APIResponse) => Promise<void>) {
  await page.route(/\/assets\/[\w-]+\.js$/, async (route) => {
    const response = await route.fetch();
    if ((await response.text()).includes("Split at spaces.")) return answer(route, response);
    return route.fulfill({ response });
  });
}

test("Python gets sys.argv = [script, *arguments]: spaces, quotes, empty quotes, other scripts and shell syntax arrive as typed", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
  await openFromTree(page, "show.py");
  await openBox(page);
  await expect(page.locator("#args-row label")).toHaveText("Arguments for show.py");
  // SECURITY.md section 2: markup in an argument stays text in the header (no dialog, no element).
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const typed = `3 "two words" '' "$(rm -rf /)" ; | > out.txt ${HELLO} '${JAPANESE} x' a"b c"d "<img src=x onerror=alert(1)>"`;
  const expected = ["3", "two words", "", "$(rm -rf /)", ";", "|", ">", "out.txt", HELLO, `${JAPANESE} x`, "ab cd", "<img src=x onerror=alert(1)>"];
  await field(page).fill(typed);
  await expect(row(page)).toHaveAttribute("data-state", "ok");
  const result = await run(page);
  expect(result.status).toBe("ok");
  expect(await printedArgv(page)).toEqual([script("show.py"), ...expected]);
  // The header shows the command line the run got, quoted where needed.
  await expect(page.locator("#run-args")).toHaveText(formatArgs(expected));
  await expect(page.locator("#runlog img, #args-row img")).toHaveCount(0);
  expect(dialogs).toEqual([]);
  // Nothing was written: ">" was an argument, not a redirection.
  await expect(treeItem(page, "out.txt")).toHaveCount(0);

  // Emptied: a run with no arguments, and no arguments in the header.
  await field(page).fill("");
  await expect(row(page)).toHaveAttribute("data-state", "empty");
  await run(page);
  expect(await printedArgv(page)).toEqual([script("show.py")]);
  await expect(page.locator("#run-args")).toHaveCount(0);
});

test("C and C++ get argv[0] as the program's name, then the arguments as typed", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  const C = '#include <stdio.h>\nint main(int argc, char **argv) {\n    printf("argc=%d\\n", argc);\n    for (int i = 0; i < argc; i++) printf("[%s]\\n", argv[i]);\n    return 0;\n}\n';
  const CPP = '#include <iostream>\nint main(int argc, char **argv) {\n    std::cout << "argc=" << argc << "\\n";\n    for (int i = 0; i < argc; i++) std::cout << "[" << argv[i] << "]\\n";\n}\n';
  await importFiles(page, [{ name: "prog.c", text: C }]);
  await openFromTree(page, "prog.c");
  await installCpp(page);
  await openBox(page);
  await field(page).fill(`"two words" '' $(rm -rf /) ";" ${HELLO} ${JAPANESE}`);
  const expected = ["two words", "", "$(rm", "-rf", "/)", ";", HELLO, JAPANESE];
  const lines = (n: number, name: string) => [`argc=${n}`, ...[name, ...expected].map((a) => `[${a}]`)];
  // The program's own lines (the log can also hold a note, e.g. "Skipped prog.c").
  const printed = (output: string) => output.split("\n").filter((l) => l.startsWith("argc=") || l.startsWith("["));
  let result = await run(page, { timeout: 120_000 });
  expect(result.status).toBe("ok");
  expect(printed(result.output)).toEqual(lines(expected.length + 1, "prog"));

  // C++, a file of its own: its own (empty) arguments until typed.
  await importFiles(page, [{ name: "prog2.cpp", text: CPP }]);
  await openFromTree(page, "prog2.cpp");
  await expect(field(page)).toHaveValue("");
  await field(page).fill(`"two words" '' $(rm -rf /) ";" ${HELLO} ${JAPANESE}`);
  result = await run(page, { timeout: 120_000 });
  expect(result.status).toBe("ok");
  expect(printed(result.output)).toEqual(lines(expected.length + 1, "prog2"));
});

test("100 arguments run; 101 is refused at the field, and Run explains instead of running", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "count.py", text: "import sys\nprint(len(sys.argv) - 1, sys.argv[1], sys.argv[-1])\n" }]);
  await openFromTree(page, "count.py");
  await openBox(page);
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
  await field(page).fill(words(100));
  const result = await run(page);
  expect(result.status).toBe("ok");
  expect(result.output).toContain("100 w1 w100");

  await field(page).fill(words(101));
  await field(page).blur();
  await expect(row(page)).toHaveAttribute("data-state", "invalid");
  await expect(page.locator("#args-error")).toHaveText(reasonOf(words(101)));
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(field(page)).toBeFocused();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
  expect(await runs(page)).toBe(before);
  // The next run is the only one since (a refused Run that ran anyway would count too).
  await field(page).fill("x");
  expect((await run(page)).output).toContain("1 x x");
  expect(await runs(page)).toBe(before + 1);
});

test("an unclosed quote: no error while typing, the error on leaving the field, Run explains and doesn't run, and fixing it clears the error at once", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
  await openFromTree(page, "show.py");
  await openBox(page);
  await field(page).click();
  await page.keyboard.type('1 "two');
  // The guard: a new error never appears mid-typing (the quote is about to be closed).
  await expect(row(page)).toHaveAttribute("data-state", "ok");
  await expect(page.locator("#args-error")).toBeHidden();
  await expect(field(page)).not.toHaveAttribute("aria-invalid", /.*/);

  // Leaving the field shows it: under the field, before the hint, and first in the description.
  // Shift+Tab, back into the page: since the 0.7.0 shell (no desktop status bar) the field is the
  // page's last stop, and Tab from it leaves the document, where Playwright's Firefox fires no blur.
  await page.keyboard.press("Shift+Tab");
  await expect(field(page)).not.toBeFocused();
  await expect(row(page)).toHaveAttribute("data-state", "invalid");
  await expect(field(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#args-error")).toHaveText(reasonOf('1 "two'));
  await expect(field(page)).toHaveAttribute("aria-describedby", "args-error args-note");
  const order = await page.evaluate(() => [...document.querySelectorAll("#args-row > *")].map((el) => el.id || el.tagName.toLowerCase()));
  expect(order).toEqual(["label", "args-field", "args-error", "args-note"]);

  // Run (with focus in the code) explains and doesn't run: focus moves to the field, which reads it.
  await page.locator(".cm-content").click();
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(field(page)).toBeFocused();
  await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
  expect(await runs(page)).toBe(before);
  await expect(page.locator("#console")).not.toContainText("two");

  // Ctrl+Enter in the field itself: still no run, and the message is said (focus can't move there).
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect(page.locator("[data-announcer]")).toHaveText(reasonOf('1 "two'));
  await expect(field(page)).toBeFocused();
  expect(await runs(page)).toBe(before);

  // Closing the quote clears the error at once (while typing), and the run goes.
  await page.keyboard.press("End");
  await page.keyboard.type('"');
  await expect(row(page)).toHaveAttribute("data-state", "ok");
  await expect(field(page)).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(field(page)).toHaveAttribute("aria-describedby", "args-note");
  await run(page);
  expect(await printedArgv(page)).toEqual([script("show.py"), "1", "two"]);
  // That run is the only one since the refused ones (one that ran anyway would count too).
  expect(await runs(page)).toBe(before + 1);
});

test("on a phone, Run with an unclosed quote from the Code view shows the Output view with the field focused", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
  await openFromTree(page, "show.py");
  await page.locator("#view-output").click();
  await openBox(page);
  await field(page).fill('"open');
  await page.locator("#view-code").click();
  await expect(field(page)).toBeHidden();
  const before = await runs(page);
  await page.locator("#run-button").click();
  await expect(page.locator("#view-output")).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toBeInViewport();
  await expect(row(page)).toHaveAttribute("data-state", "invalid");
  expect(await runs(page)).toBe(before);
});

test("the arguments belong to their file: switching shows each file's own, and they survive a reload, follow a rename and go with a delete", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [
    { name: "a.py", text: ARGV_PY },
    { name: "b.py", text: ARGV_PY },
    { name: "notes.txt", text: "not a program\n" },
  ]);
  await openFromTree(page, "a.py");
  await openBox(page);
  await field(page).fill('1 "a b"');
  await openFromTree(page, "b.py");
  await expect(page.locator("#args-row label")).toHaveText("Arguments for b.py");
  await expect(field(page)).toHaveValue("");
  await field(page).fill("x");
  await openFromTree(page, "a.py");
  await expect(field(page)).toHaveValue('1 "a b"');
  // A file that can't run has no arguments to give.
  await openFromTree(page, "notes.txt");
  await expect(row(page)).toBeHidden();
  await openFromTree(page, "a.py");
  await expect(row(page)).toBeVisible();

  // A reload brings them back (kept with the workspace's UI state).
  await reloadApp(page);
  await openBox(page);
  await expect(page.locator("#args-row label")).toHaveText("Arguments for a.py");
  await expect(field(page)).toHaveValue('1 "a b"');
  await run(page);
  expect(await printedArgv(page)).toEqual([script("a.py"), "1", "a b"]);

  // Renamed: the text follows (and the label names the new file at once).
  await treeItem(page, "a.py").focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("textbox", { name: "New name for a.py" });
  await rename.fill("c.py");
  await rename.press("Enter");
  await expect(treeItem(page, "c.py")).toBeFocused();
  await expect(page.locator("#args-row label")).toHaveText("Arguments for c.py");
  await expect(field(page)).toHaveValue('1 "a b"');
  await reloadApp(page);
  await openBox(page);
  await expect(page.locator("#args-row label")).toHaveText("Arguments for c.py");
  await expect(field(page)).toHaveValue('1 "a b"');

  // Deleted: they go; a new file with the same name starts empty.
  await treeItem(page, "c.py").focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(treeItem(page, "c.py")).toHaveCount(0);
  await importFiles(page, [{ name: "c.py", text: ARGV_PY }]);
  await openFromTree(page, "c.py");
  await openBox(page);
  await expect(field(page)).toHaveValue("");
  // b.py kept its own all along.
  await openFromTree(page, "b.py");
  await expect(field(page)).toHaveValue("x");
});

test.describe("the Arguments field's chunk can't load", () => {
  // The 404 below is the point of the test; each engine reports it in its own words (recorded
  // 2026-10-22: Chromium and WebKit log the console line; the request fails as ERR_ABORTED in
  // Chromium, NS_ERROR_CORRUPTED_CONTENT in Firefox, "Load request cancelled" in WebKit).
  test.use(
    tolerating(
      /^HTTP 404: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js$/,
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
      /^request failed: http:\/\/127\.0\.0\.1:\d+\/assets\/[\w-]+\.js (net::ERR_ABORTED|NS_ERROR_CORRUPTED_CONTENT|Load request cancelled)$/,
    ),
  );

  test("Run says so and runs nothing; once the chunk loads again, Run works and the field shows", async ({ page, browserName }) => {
    await openApp(page);
    // The chunk is found by its content (its name is a hash): only it has the field's hint. (An
    // import opens show.py, which fetches the chunk: the route comes first.)
    let refused = 0;
    await routeArgsChunk(page, async (route) => {
      refused++;
      await route.fulfill({ status: 404, body: "" });
    });
    await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
    await openFromTree(page, "show.py");
    await expect.poll(() => refused).toBeGreaterThan(0);
    const before = await runs(page);
    const notice = page.locator(".notice");
    await expect(notice).not.toHaveAttribute("data-tone", "error"); // the import's own notice, or none
    await page.locator("#run-button").click();
    await expect(notice).toHaveAttribute("data-tone", "error");
    await expect(notice).toHaveAttribute("data-empty", "false");
    await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
    expect(await runs(page)).toBe(before);
    await expect(row(page)).toBeHidden();
    await page.unrouteAll({ behavior: "wait" });
    if (browserName === "webkit") {
      // Playwright's WebKit keeps a failed dynamic import() failed for the whole context, reloads
      // included (lessons.md 2026-10-21; measured here too): Run keeps saying so, and never hangs.
      await page.getByRole("button", { name: "Dismiss notice" }).click();
      await expect(notice).toHaveAttribute("data-empty", "true");
      await page.locator("#run-button").click();
      await expect(notice).toHaveAttribute("data-empty", "false");
      await expect(notice).toHaveAttribute("data-tone", "error");
      await expect(page.locator("#app")).toHaveAttribute("data-run", "idle");
      expect(await runs(page)).toBe(before);
      test.info().annotations.push({ type: "webkit", description: "recovery not checked: a failed import stays failed in the context" });
      return;
    }
    // Chromium and Firefox fetch the chunk again: Run works, and the field shows.
    const result = await run(page);
    expect(result.status).toBe("ok");
    expect(await printedArgv(page)).toEqual([script("show.py")]);
    await openBox(page);
    await expect(page.locator("#args-row label")).toHaveText("Arguments for show.py");
  });

  test("saved arguments reach a Run that is what loads the chunk (it failed when the file reopened)", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "a failed import() stays failed for the context in Playwright's WebKit; the held-chunk test covers WebKit");
    await openApp(page);
    await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
    await openFromTree(page, "show.py");
    await openBox(page);
    await field(page).fill('1 "two words"');
    await expect.poll(() => storedArgs(page)).toEqual({ "show.py": '1 "two words"' });
    let refused = 0;
    await routeArgsChunk(page, async (route) => {
      refused++;
      await route.fulfill({ status: 404, body: "" });
    });
    await reloadApp(page);
    await expect.poll(() => refused).toBeGreaterThan(0);
    await page.unrouteAll({ behavior: "wait" });
    // The guard (args-field.ts argsFor): the run reads the saved texts before it reads one.
    const result = await run(page);
    expect(result.status).toBe("ok");
    expect(await printedArgv(page)).toEqual([script("show.py"), "1", "two words"]);
    await expect(page.locator("#run-args")).toHaveText('1 "two words"');
  });
});

test("saved arguments reach a Run pressed while the field's chunk is still loading", async ({ page }) => {
  // Saved in an earlier visit, before this page ever loaded the field's chunk. (Not by a reload:
  // Playwright's WebKit then takes the chunk from its memory cache, past page.route; measured
  // 2026-10-22, .claude/verify/batch3/fix-r/probe-chunk-webkit.log.)
  await openApp(page);
  await expect.poll(() => seedArgs(page, { "show.py": '1 "two words"' })).toBe(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await routeArgsChunk(page, async (route, response) => {
    held++;
    await gate;
    await route.fulfill({ response });
  });
  await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
  await openFromTree(page, "show.py");
  await expect.poll(() => held).toBeGreaterThan(0);
  await expect(page.locator("#app")).toHaveAttribute("data-runnable", "true");
  const before = await runs(page);
  await page.locator("#run-button").click();
  // A Python run reaches its wait for the chunk with no other wait before it: it waits there now.
  await expect(page.locator("#app")).toHaveAttribute("data-run", "running");
  release();
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(before + 1), { timeout: 45_000 });
  await page.unrouteAll({ behavior: "wait" });
  // The guard (args-field.ts argsFor): the run reads the saved texts before it reads one.
  expect(await printedArgv(page)).toEqual([script("show.py"), "1", "two words"]);
  await expect(page.locator("#run-args")).toHaveText('1 "two words"');
  await openBox(page);
  await expect(field(page)).toHaveValue('1 "two words"');
});

test.describe("a file a sync removes", () => {
  test.use(syncNoise());

  test("takes its arguments with it in this tab too: a new file with that name never shows them", async ({ page }) => {
    const activeTab = page.locator('.tabs [role=tab][aria-selected="true"][title="util.py"]');
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "util.py": ARGV_PY });
    await openApp(page);
    await importFiles(page, [{ name: "util.py", text: ARGV_PY }]);
    await expect(activeTab).toBeVisible();
    let n = await syncCount(page);
    await connectGitHub(page);
    await waitSync(page, n, "synced");
    await openBox(page);
    await field(page).fill("u args");
    await expect.poll(() => storedArgs(page)).toEqual({ "util.py": "u args" });
    // GitHub removes util.py: the sync closes its tab, and no file that can run is open.
    await gh.fake.remoteCommit({ "util.py": null });
    n = await syncCount(page);
    await syncStatus(page).click();
    await waitSync(page, n, "synced");
    await expect(treeItem(page, "util.py")).toHaveCount(0);
    await expect(row(page)).toBeHidden();
    await expect.poll(() => storedArgs(page)).toEqual({});
    // Every text the field is given from here on is recorded: the end state alone can't tell, since
    // a read of the saved texts corrects the field a moment later.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("#args-field")!;
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      const given: string[] = [];
      (window as unknown as { argsGiven: string[] }).argsGiven = given;
      Object.defineProperty(el, "value", {
        configurable: true,
        get() {
          return native.get!.call(this);
        },
        set(v: string) {
          given.push(v);
          native.set!.call(this, v);
        },
      });
    });
    await importFiles(page, [{ name: "util.py", text: ARGV_PY }]);
    await expect(activeTab).toBeVisible();
    await openBox(page);
    await expect(field(page)).toHaveValue("");
    // The guard (args-field.ts show): this tab's copy is read again when no runnable file is left
    // open, so the new util.py is never shown the removed one's text, even for a moment.
    const given = await page.evaluate(() => (window as unknown as { argsGiven: string[] }).argsGiven);
    expect(given).not.toContain("u args");
    const result = await run(page);
    expect(result.status).toBe("ok");
    expect(await printedArgv(page)).toEqual([script("util.py")]);
  });
});

test("keyboard: Tab goes from the Input text to the Arguments field; Escape closes the box and gives focus back to the toggle", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "show.py", text: ARGV_PY }]);
  await openFromTree(page, "show.py");
  const toggle = page.locator("#input-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#stdin")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("7 8");
  await page.keyboard.press("Escape");
  await expect(page.locator("#stdin-box")).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(field(page)).toHaveValue("7 8");
});
