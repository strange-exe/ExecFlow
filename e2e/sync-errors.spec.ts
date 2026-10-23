// The Connect dialog's error state (DESIGN.md decision 13, reading order 4): every error the dialog
// can show leads that state, above Connect, and is announced once.
// - A field's error (its shape checked before anything is sent; or GitHub rejecting the token, or
//   the branch): the message right under the field and before its hint, aria-invalid, and
//   aria-describedby naming the message first (WCAG 3.3.1; ARIA21). Focus moves to the first field
//   in error (W3C WAI forms tutorial, "User Notifications"), which reads that description; when
//   focus is already in that field, the dialog's live region says it instead (WCAG 4.1.3).
// - An error that belongs to no field (offline, GitHub unreachable, a missing repository, a missing
//   permission, a rate limit, GitHub's own failures, this tab turning read-only): the result line
//   above Connect, said by the live region; focus stays where it was.
// The expected sentences come from the code that words them (explainError, validateTokenShape,
// the sync-form checks), so these tests are about where and how an error is shown, not its wording.
import type { Locator, Page } from "@playwright/test";
import { GitHubError, type GitHubErrorKind } from "../src/sync/github";
import { explainError } from "../src/sync/repo-check";
import { validateTokenShape } from "../src/sync/token-store";
import { branchProblem, ownerProblem, repoProblem } from "../src/ui/sync-form";
import { expect, openApp, test } from "./helpers";
import { answer, EMPTY_REPO, fillConnect, githubNoise, openConnect, routeGitHub, syncCount, syncNoise, syncStatus, waitSync } from "./sync-fake";

test.use({ serviceWorkers: "block" });

type Field = "owner" | "repo" | "branch" | "token";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dialogOf = (page: Page) => page.locator("#connect-dialog");
const reason = (token: string) => {
  const shape = validateTokenShape(token);
  if (shape.ok) throw new Error("expected a token shape problem");
  return shape.reason;
};
const github = (kind: GitHubErrorKind, status: number, retryAfterMs?: number) => explainError(new GitHubError(kind, status, "getRepo", "", retryAfterMs));

/** Records each sentence the dialog's live region says (each time it fills), from now on. */
async function listen(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById("connect-announce");
    if (!el) throw new Error("the dialog has no live region");
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    let last = el.textContent ?? "";
    new MutationObserver(() => {
      const text = el.textContent ?? "";
      if (text && text !== last) w.__said.push(text);
      last = text;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const live = page.locator("#connect-announce");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveAttribute("aria-atomic", "true");
}
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said.splice(0));

/** Presses Connect (a click, or Enter where focus is) and waits until that attempt has finished. */
async function attempt(page: Page, how: "click" | Locator) {
  const dialog = dialogOf(page);
  const n = Number((await dialog.getAttribute("data-attempts")) ?? 0);
  if (how === "click") await page.locator("#connect-submit").click();
  else {
    await how.focus();
    await page.keyboard.press("Enter");
  }
  await expect(dialog).toHaveAttribute("data-attempts", String(n + 1), { timeout: 15_000 });
}

/** Heard once: through the moved focus (the description) and not the live region, or the live region once. */
async function heardOnce(page: Page, via: "focus" | "live", message: string) {
  await expect(dialogOf(page)).toHaveAttribute("data-announce", via);
  if (via === "live") {
    await expect.poll(() => page.evaluate(() => (window as unknown as { __said: string[] }).__said.length)).toBe(1);
    expect(await said(page)).toEqual([message]);
  } else {
    // Nothing was handed to the live region (data-announce is set in the same step that would have);
    // its clear-then-say delay is 50 ms, so a stray sentence would be there by now.
    await page.waitForTimeout(150);
    expect(await said(page)).toEqual([]);
  }
}

/** Where the field's error sits: under the field, before its hint, above Connect, in view; in the DOM in that order too. */
async function placement(page: Page, field: Field) {
  return page.evaluate((id) => {
    const get = (x: string) => document.getElementById(x)!;
    const [input, error, note, connect] = [get(id), get(`${id}-error`), get(`${id}-note`), get("connect-submit")];
    const body = document.querySelector("#connect-dialog .dialog-body")!.getBoundingClientRect();
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const r = (e: Element) => e.getBoundingClientRect();
    const problems: string[] = [];
    if (!follows(input, error)) problems.push("DOM: the message is not after its field");
    if (!note.hidden && !follows(error, note)) problems.push("DOM: the hint comes before the message");
    if (!follows(error, connect)) problems.push("DOM: Connect comes before the message");
    if (r(error).top < r(input).bottom - 0.5) problems.push("screen: the message is not below its field");
    if (!note.hidden && r(error).bottom > r(note).top + 0.5) problems.push("screen: the hint is drawn above the message");
    if (r(error).bottom > r(connect).top + 0.5) problems.push("screen: the message is not above Connect");
    if (r(error).top < body.top - 0.5 || r(error).bottom > body.bottom + 0.5) problems.push("screen: the message is scrolled out of view");
    if (r(input).top < body.top - 0.5) problems.push("screen: the field is scrolled out of view");
    return problems;
  }, `connect-${field}`);
}

/** A field's error leads: shown at the field, invalid, described by its message first, focused, heard once. */
async function expectFieldError(page: Page, field: Field, message: string, via: "focus" | "live") {
  const input = page.locator(`#connect-${field}`);
  const error = page.locator(`#connect-${field}-error`);
  await expect(error).toBeVisible();
  await expect(error).toHaveText(message);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", new RegExp(`^connect-${field}-error( connect-${field}-note)?$`));
  await expect(input).toHaveAccessibleDescription(new RegExp(`^${esc(message)}`));
  await expect(input).toBeFocused();
  expect(await placement(page, field)).toEqual([]);
  await expect(page.locator("#connect-result")).not.toHaveAttribute("data-tone");
  await heardOnce(page, via, message);
}

/** An error of no field: the result line above Connect, no field marked invalid, focus not moved, heard once. */
async function expectResult(page: Page, message: string, tone: "error" | "warning", focused: Locator) {
  const result = page.locator("#connect-result");
  await expect(result).toHaveAttribute("data-tone", tone);
  await expect(result).toHaveText(message);
  await expect(page.locator("#connect-dialog input[aria-invalid]")).toHaveCount(0);
  await expect(focused).toBeFocused();
  const problems = await page.evaluate(() => {
    const result = document.getElementById("connect-result")!;
    const connect = document.getElementById("connect-submit")!;
    const body = document.querySelector("#connect-dialog .dialog-body")!.getBoundingClientRect();
    const r = result.getBoundingClientRect();
    const out: string[] = [];
    if (!(result.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING)) out.push("DOM: Connect comes before the result");
    if (r.bottom > connect.getBoundingClientRect().top + 0.5) out.push("screen: the result is not above Connect");
    if (r.top < body.top - 0.5 || r.bottom > body.bottom + 0.5) out.push("screen: the result is scrolled out of view");
    return out;
  });
  expect(problems).toEqual([]);
  await heardOnce(page, "live", message);
}

test.describe("checked before anything is sent", () => {
  test("every field's mistake is shown at that field, the first one gets focus, and each is heard once", async ({ page }) => {
    const gh = await routeGitHub(page);
    await openApp(page);
    await openConnect(page);
    await listen(page);

    // Nothing filled in: owner, repository and token are all marked; focus goes to the first, Owner.
    await attempt(page, "click");
    await expect(dialogOf(page)).toHaveAttribute("data-state", "invalid");
    await expectFieldError(page, "owner", ownerProblem("")!, "focus");
    await expect(page.locator("#connect-repo-error")).toHaveText(repoProblem("")!);
    await expect(page.locator("#connect-token-error")).toHaveText(reason(""));
    await expect(page.locator("#connect-repo")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#connect-token")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#connect-branch")).not.toHaveAttribute("aria-invalid");

    // Typing in a field clears its message (and only its own).
    await page.locator("#connect-owner").fill("me");
    await expect(page.locator("#connect-owner")).not.toHaveAttribute("aria-invalid");
    await expect(page.locator("#connect-owner-error")).toBeHidden();
    await expect(page.locator("#connect-owner")).not.toHaveAttribute("aria-describedby");
    await expect(page.locator("#connect-repo")).toHaveAttribute("aria-invalid", "true");

    // Each field's own rule, one at a time, with focus coming from Connect.
    const cases: { set: Partial<Record<Field, string>>; field: Field; message: string }[] = [
      { set: { owner: "bad owner", repo: "workspace" }, field: "owner", message: ownerProblem("bad owner")! },
      { set: { owner: "me", repo: "bad repo!" }, field: "repo", message: repoProblem("bad repo!")! },
      { set: { repo: "workspace", branch: "a..b" }, field: "branch", message: branchProblem("a..b")! },
      { set: { branch: "", token: "" }, field: "token", message: reason("") },
      { set: { token: "github_pat_has spaces in it" }, field: "token", message: reason("github_pat_has spaces in it") },
      { set: { token: `github_pat_${"a".repeat(250)}` }, field: "token", message: reason(`github_pat_${"a".repeat(250)}`) },
      { set: { token: "github_pat_short" }, field: "token", message: reason("github_pat_short") },
      { set: { token: "a".repeat(45) }, field: "token", message: reason("a".repeat(45)) },
    ];
    for (const c of cases) {
      for (const [name, value] of Object.entries(c.set)) await page.locator(`#connect-${name}`).fill(value);
      await attempt(page, "click");
      await expectFieldError(page, c.field, c.message, "focus");
    }

    // Enter in the field that is wrong: focus is already there, so the live region says it.
    await attempt(page, page.locator("#connect-token"));
    await expectFieldError(page, "token", reason("a".repeat(45)), "live");
    // ... and the same mistake again is heard again.
    await attempt(page, page.locator("#connect-token"));
    await expectFieldError(page, "token", reason("a".repeat(45)), "live");
    // The live region never keeps an old sentence, so reading on through the dialog meets no stale
    // error (emptying it is not announced). A new attempt empties it first: here the error is heard
    // through focus, and the region stays empty.
    const live = page.locator("#connect-announce");
    await attempt(page, "click");
    await expectFieldError(page, "token", reason("a".repeat(45)), "focus");
    await expect(live).toHaveText("");
    // ... and an edit empties it: the mistake it said is being fixed.
    await attempt(page, page.locator("#connect-token"));
    await expectFieldError(page, "token", reason("a".repeat(45)), "live");
    await page.locator("#connect-token").fill("github_pat_");
    await expect(page.locator("#connect-token")).not.toHaveAttribute("aria-invalid");
    await expect(live).toHaveText("");
    expect(gh.seen, "nothing was sent to GitHub").toEqual([]);
  });

  // The guard: proved to fail with the message and the hint in the old order (hint first).
  for (const vp of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`${vp.name}: the field error leads its reading order: right under the field, before the hint, above Connect, first in the description`, async ({ page }) => {
      await page.setViewportSize(vp);
      await routeGitHub(page);
      await openApp(page);
      await openConnect(page);
      await listen(page);
      await fillConnect(page, { token: "not a token" });
      await attempt(page, "click");
      await expectFieldError(page, "token", reason("not a token"), "focus");
      // The message is the first thing the field says after its name and state.
      const description = await page.locator("#connect-token").evaluate((el) =>
        (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? ""),
      );
      expect(description).toEqual([reason("not a token"), "Fine-grained tokens start with github_pat_."]);
    });
  }
});

test.describe("GitHub's answer to the repository read", () => {
  // Each answer below is given once, on purpose.
  test.use(syncNoise(...[401, 403, 404, 409, 422, 429, 500].flatMap((s) => githubNoise(s))));

  test("a rejected token is the token field's error, cleared; every other answer is the result line above Connect", async ({ page }) => {
    const gh = await routeGitHub(page);
    await openApp(page);
    await openConnect(page);
    await listen(page);
    const connect = page.locator("#connect-submit");
    const repoRead = (status: number, message: string, headers: Record<string, string> = {}) => {
      gh.fake.interceptors.length = 0;
      gh.fake.interceptors.push((req) => (req.method === "GET" && req.path === "" ? answer(status, message, headers) : undefined));
    };

    // 401: the token's own error; the field is emptied (it must not be sent again) and focused.
    await fillConnect(page, {});
    repoRead(401, "Bad credentials");
    await attempt(page, "click");
    await expect(dialogOf(page)).toHaveAttribute("data-state", "failed");
    await expectFieldError(page, "token", github("auth", 401), "focus");
    await expect(page.locator("#connect-token")).toHaveValue("");

    const answers: { status: number; body: string; headers?: Record<string, string>; message: string }[] = [
      { status: 404, body: "Not Found", message: github("not-found", 404) },
      { status: 403, body: "Resource not accessible by personal access token", message: github("forbidden", 403) },
      { status: 429, body: "API rate limit exceeded", headers: { "retry-after": "120" }, message: github("rate-limit", 429, 120_000) },
      { status: 500, body: "Server Error", message: github("server", 500) },
      { status: 409, body: "Conflict", message: github("conflict", 409) },
      { status: 422, body: "Validation Failed", message: github("validation", 422) },
    ];
    for (const a of answers) {
      await fillConnect(page, {});
      repoRead(a.status, a.body, a.headers);
      await attempt(page, connect);
      await expect(dialogOf(page)).toHaveAttribute("data-state", "failed");
      await expectResult(page, a.message, "error", connect);
      await expect(connect, "Connect stays the primary action").toHaveClass(/\bprimary\b/);
      await expect(connect).toHaveText("Connect");
    }
    // The same answer twice in a row is heard twice.
    await attempt(page, connect);
    await expectResult(page, answers.at(-1)!.message, "error", connect);
    // A 422 to this read is worded as a read: nothing was being saved (plan-v2 P5).
    await expect(page.locator("#connect-result")).toContainText("check the owner, repository and branch");
    await expect(page.locator("#connect-result")).not.toContainText("saved");
    // An edit empties the live region (the result line still shows what the last attempt found).
    await page.locator("#connect-branch").fill("dev");
    await expect(page.locator("#connect-announce")).toHaveText("");
    await expect(page.locator("#connect-result")).toHaveText(answers.at(-1)!.message);
  });
});

test.describe("the branch", () => {
  test.use(syncNoise(...githubNoise(404, "/git/ref/heads/dev"), ...githubNoise(409, "/git/ref/heads/dev"), ...githubNoise(500, "/git/ref/heads/main")));

  test("a missing branch, or one an empty repository can't start on, is the branch field's error; a failed read is the result line", async ({ page }) => {
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": "print('repo')\n" });
    await openApp(page);
    await openConnect(page);
    await listen(page);

    await fillConnect(page, { branch: "dev" });
    await attempt(page, "click");
    await expectFieldError(page, "branch", "me/workspace has no branch called dev. Leave the field empty for the default branch, main.", "focus");

    // The branch read fails on GitHub's side: no field to blame.
    gh.fake.interceptors.push((req) => (req.method === "GET" && req.path === "/git/ref/heads/main" ? answer(500, "Server Error") : undefined));
    await page.locator("#connect-branch").fill("");
    await attempt(page, page.locator("#connect-submit"));
    await expectResult(page, explainError(new GitHubError("server", 500, "getRef", "")), "error", page.locator("#connect-submit"));
  });

  test.describe("in an empty repository", () => {
    test("a branch other than the default can't start it: the branch field's error", async ({ page }) => {
      await routeGitHub(page);
      await openApp(page);
      await openConnect(page);
      await listen(page);
      await fillConnect(page, { branch: "dev" });
      await attempt(page, page.locator("#connect-branch"));
      await expectFieldError(page, "branch", "me/workspace is empty, so it can only start on its default branch, main. Leave the branch empty.", "live");
    });
  });
});

test.describe("the network", () => {
  test("offline: the result line says so before anything is sent, and focus stays on Connect", async ({ page, context }) => {
    const gh = await routeGitHub(page);
    await openApp(page);
    await openConnect(page);
    await listen(page);
    await fillConnect(page, {});
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    const connect = page.locator("#connect-submit");
    await attempt(page, connect);
    await expectResult(page, "This computer is offline, so GitHub can't check the token now. Connect again once you're online.", "error", connect);
    expect(gh.seen).toEqual([]);
    await context.setOffline(false);
  });

  test.describe("GitHub can't be reached", () => {
    // The aborted read is this test's own doing: any engine's wording, this URL only.
    // Each engine's console line for it, measured 2026-10-21: Chromium "Failed to load resource:
    // net::ERR_INTERNET_DISCONNECTED"; Firefox reports the failed CORS request for this URL.
    test.use(
      syncNoise(
        /^request failed: https:\/\/api\.github\.com\/repos\/me\/workspace \S.*$/,
        /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
        /^\[JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https:\/\/api\.github\.com\/repos\/me\/workspace\. \(Reason: CORS request did not succeed\)\. Status code: \(null\)\."\]$/,
      ),
    );

    test("the result line says so, and focus stays on Connect", async ({ page }) => {
      await routeGitHub(page);
      await page.route("https://api.github.com/repos/me/workspace", (route) => route.abort("internetdisconnected"));
      await openApp(page);
      await openConnect(page);
      await listen(page);
      await fillConnect(page, {});
      const connect = page.locator("#connect-submit");
      await attempt(page, connect);
      await expectResult(page, github("network", 0), "error", connect);
    });
  });
});

test.describe("a public repository", () => {
  // The fake repository is empty: reading its branch answers 409, which the check expects.
  test.use(syncNoise(...EMPTY_REPO));

  test("the warning is the result line above Connect, heard once (what is heard is what is shown), and Connect anyway connects", async ({ page }) => {
    await routeGitHub(page, { private: false });
    await openApp(page);
    await openConnect(page);
    await listen(page);
    await fillConnect(page, {});
    const connect = page.locator("#connect-submit");
    await attempt(page, connect);
    await expect(dialogOf(page)).toHaveAttribute("data-state", "public");
    await expect(page.locator("#connect-result")).toContainText("This repository is public");
    await expectResult(page, await page.locator("#connect-result").innerText(), "warning", connect);
    await expect(connect).toHaveText("Connect anyway");
    const n = await syncCount(page);
    await page.keyboard.press("Enter");
    await expect(dialogOf(page)).toHaveCount(0);
    await waitSync(page, n, "synced");
  });
});

test.describe("this tab turning read-only while it connects", () => {
  test.use(syncNoise());

  test("is the result line, and nothing is kept", async ({ page, context }) => {
    const gh = await routeGitHub(page);
    await gh.fake.remoteCommit({ "main.py": "print('repo')\n" });
    await openApp(page);
    await openConnect(page);
    await listen(page);
    await fillConnect(page, {});
    // Hold the repository read while a second tab takes over editing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    gh.fake.interceptors.push(async (req) => {
      if (req.method === "GET" && req.path === "") await held;
      return undefined;
    });
    const connect = page.locator("#connect-submit");
    await connect.focus();
    await page.keyboard.press("Enter");
    await expect(dialogOf(page)).toHaveAttribute("data-state", "checking");
    const second = await context.newPage();
    await openApp(second);
    await second.locator("#read-only-banner").getByRole("button", { name: "Edit here" }).click();
    await expect(page.locator("#read-only-banner")).toBeVisible();
    release();
    await expect(dialogOf(page)).toHaveAttribute("data-attempts", "1", { timeout: 15_000 });
    await expectResult(page, "This tab became read-only (another tab is editing), so it can't connect.", "error", connect);
    await page.keyboard.press("Escape");
    await expect(syncStatus(page)).toHaveAttribute("data-sync-state", "not-connected");
    await second.close();
  });
});
