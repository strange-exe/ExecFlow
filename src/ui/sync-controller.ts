// The GitHub sync screens (the lazy sync chunk: it loads when a repository is connected or the
// Connect dialog opens). It owns one GitHub client per token, ONE sync store object for the whole
// visit, the scheduler, the top bar's status button, and what a sync means for the open files.
//
// Only the writer tab syncs. That tab already holds the Web Lock "codeeditor/ws/<id>" for as long
// as it is the writer (src/storage/tabs.ts), and asking for the same lock again from the same tab
// would wait forever, so "sync under the lock" means: sync only while tab.canWrite(), one sync at a
// time in this tab (the scheduler and the engine both serialise), and the store refuses the
// commit if the lock was lost meanwhile.
//
// The token lives only inside the client created for it (memory), or, with "Remember on this
// device" (off by default on both paths), encrypted in the codeeditor-secrets database. It never reaches the DOM, a message,
// the log or a URL; every sentence shown comes from explainError or fixed text.
import { nameOf } from "../core/paths";
import type { RemoteMeta, WsPath } from "../core/types";
import { StorageError } from "../storage/db";
import { createSyncStore } from "../storage/sync-store";
import type { AuthCallback } from "../sync/auth-callback";
import { SyncError, sync as runSync, type SyncReport } from "../sync/engine";
import { createClient, GitHubError, type GitHubClient } from "../sync/github";
import {
  checkCallback,
  clearPending,
  createAppTokenSource,
  exchange,
  fetchConfig,
  revokeToken,
  SignInError,
  startSignIn,
  takePending,
  type AppTokenSource,
  type ConfigState,
} from "../sync/github-app-auth";
import { listReachable } from "../sync/installations";
import { checkAccess, explainError, type AuthKind } from "../sync/repo-check";
import * as shareRules from "../sync/share";
import { forgetAppTokens, forgetToken, loadAppTokens, loadToken, rememberAppTokens, rememberToken } from "../sync/token-store";
import { confirmDialog } from "./dialogs";
import { openConnectDialog, type CheckResult, type ConnectInput, type PickRepo, type ReachResult, type SignInDeps } from "./sync-connect";
import type { ShareState } from "./share-dialog";
import type { SyncHost } from "./sync-entry";
import { askFirstConnect, FirstConnectCancelled, showConflicts } from "./sync-first-connect";
import { deviceName } from "./sync-form";
import { syncIcon } from "./sync-icons";
import { openMessageDialog } from "./sync-message";
import { summarizeReport, type ReportNotice } from "./sync-report";
import { isManual, MAX_FAILURES, SyncScheduler, type RunOutcome, type RunReason } from "./sync-scheduler";
import { describeStatus, renderStatus, type SyncPhase } from "./sync-status";
import "../styles/sync-dialogs.css";

export interface SyncController {
  /** Settles once the stored connection (and a remembered token) has been read. */
  ready: Promise<void>;
  /** The status button was pressed. */
  pressStatus(): void;
  openConnect(returnFocus?: HTMLElement | null): Promise<void>;
  disconnect(): Promise<void>;
  syncNow(reason: RunReason): Promise<void>;
  /** "Sync now with a message": asks for a commit subject, then syncs at once. */
  syncWithMessage(returnFocus?: HTMLElement | null): Promise<void>;
  onLocalChange(): void;
  connected(): boolean;
  describe(): string;
  signOut(): Promise<void>;
  /** GitHub sent the student back (src/sync/auth-callback.ts): finish signing in. */
  finishSignIn(callback: AuthCallback): Promise<void>;
  /** "Share link..." for `path` (src/ui/share-dialog.ts, its own lazy chunk). */
  share(path: WsPath, returnFocus: HTMLElement | null): Promise<void>;
}

/**
 * GitHub's Applications settings, whose Authorized GitHub Apps tab ends CodeEditor's sign-in
 * (docs: Settings, Integrations, Applications, Authorized GitHub Apps; the docs give no direct URL).
 * https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps
 */
const AUTHORIZED_APPS_URL = "https://github.com/settings/applications";
/** Revoking is best effort: Disconnect and sign-out never wait longer than this for it. */
const REVOKE_WAIT_MS = 5000;

const READ_ONLY_SYNC = "This tab is read-only, so it doesn't sync: the tab that edits this workspace does. Choose Edit here to sync from this tab.";
/** Said after a typed commit message its sync couldn't use (the dialog offers the text again). */
const MESSAGE_UNUSED = "Your commit message wasn't used; Sync with a message offers it again.";

const OFFLINE_SIGN_IN ="This device is offline, so signing in has to wait until you're online. Your files are saved here in the meantime.";

/** One sentence per way signing in can fail; `openToken` opens the token form beside it. */
function signInFailure(error: unknown): { ok: false; message: string; openToken?: boolean } {
  const kind = error instanceof SignInError ? error.kind : "unavailable";
  switch (kind) {
    case "bad_verification_code":
      return { ok: false, message: "The sign-in from GitHub expired or was already used, so sign in again." };
    case "unverified_user_email":
      return { ok: false, message: "GitHub lets apps sign in only for accounts with a verified email address: verify yours in GitHub's email settings, then sign in again." };
    case "access_denied":
      return { ok: false, message: "Signing in was cancelled on GitHub, so CodeEditor isn't connected. Sign in again when you're ready." };
    case "network":
      return { ok: false, message: "CodeEditor couldn't reach its sign-in service, so check the internet connection and sign in again." };
    default:
      return { ok: false, message: "Signing in with GitHub isn't working on this site right now, so use a token instead.", openToken: true };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** An automatic sync reached the first-connect question: only the user starts that sync. */
class ChoiceNeeded extends Error {}

/** GitHub (or the network) may answer differently in a while. */
function retryable(error: unknown): boolean {
  if (error instanceof GitHubError) return error.kind === "rate-limit" || error.kind === "server" || error.kind === "network" || error.kind === "conflict";
  return error instanceof SyncError && error.kind === "remote-moving";
}

function sentenceFor(error: unknown, auth: AuthKind): string {
  if (error instanceof StorageError) {
    return error.code === "read-only"
      ? "this tab became read-only (another tab is editing), so it didn't save what it synced; nothing was lost."
      : error.message;
  }
  return explainError(error, auth);
}

const sameRepo = (a: RemoteMeta | null, owner: string, repo: string, branch: string) =>
  a !== null && a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase() && a.branch === branch;

export function createSyncController(host: SyncHost, button: HTMLButtonElement): SyncController {
  const store = createSyncStore(host.db, host.ws, { canWrite: () => host.tab.canWrite() });
  const device = deviceName(navigator.userAgent, navigator.platform ?? "");
  let remote: RemoteMeta | null = null;
  let client: GitHubClient | null = null;
  /** The sign-in behind `client`, for an "app" connection (revoked on Disconnect). */
  let appSource: AppTokenSource | null = null;
  /** Signed in, repository not chosen yet: revoked if the dialog closes without connecting. */
  let signedIn: AppTokenSource | null = null;
  /** /api/auth/config, read once per visit ("unreachable" is asked again next time). */
  let authConfig: ConfigState | null = null;
  let remembered = false;
  const authKind = (): AuthKind => remote?.auth ?? "pat";
  let phase: SyncPhase = "not-connected";
  /** The failure shown with "failed" (and "Token not accepted" for needs-token). */
  let error: string | null = null;
  let unsynced = 0;
  let syncs = 0;
  /**
   * A subject typed in "Sync with a message", for the next sync that starts (and only that one:
   * runOnce takes it). Never kept for a retry or an automatic sync: a sync that can't use it says
   * so, and `unusedSubject` fills the dialog with it the next time it opens (this tab only).
   */
  let typedSubject: string | null = null;
  let unusedSubject = "";
  /**
   * The message dialog is open: an automatic sync that falls due meanwhile would upload the very
   * changes being described, so it waits (`held`) and runs when the dialog closes without syncing.
   * The status button's data-sync-held names it meanwhile (tests wait on it).
   */
  let asking = false;
  let held: RunReason | null = null;

  const scheduler = new SyncScheduler({
    run: runOnce,
    autoSync: () => host.settings.get().autoSync,
    visible: () => document.visibilityState === "visible",
    online: () => navigator.onLine,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    onChange: () => render(),
  });

  const repoName = () => (remote ? `${remote.owner}/${remote.repo}` : "");
  const idlePhase = (): SyncPhase => (!remote ? "not-connected" : !client ? "needs-token" : unsynced > 0 ? "unsynced" : "synced");

  // ---------------------------------------------------------------- conflict copies not looked at yet
  /**
   * Conflict copies the last syncs made (copy -> original) that haven't been opened, dismissed,
   * renamed or deleted. While there are any, the idle status is the warning "N conflicts" instead
   * of "Synced" (the editor shows GitHub's version, so the student must be told where theirs went),
   * and the report's notice stays pinned. Kept for this visit (the tree keeps flagging the copies).
   */
  const conflicts = new Map<WsPath, WsPath>();
  const CONFLICT_NOTICE = "sync-conflicts";
  const shownPhase = (): SyncPhase =>
    phase === "failed" && scheduler.retryAt !== null ? "waiting" : (phase === "synced" || phase === "unsynced") && conflicts.size ? "conflict" : phase;

  function settled(copies: Iterable<WsPath>) {
    let changed = false;
    for (const copy of copies) changed = conflicts.delete(copy) || changed;
    if (!changed) return;
    if (!conflicts.size) host.notice.unpin(CONFLICT_NOTICE);
    render();
  }

  function forgetConflicts() {
    conflicts.clear();
    host.notice.unpin(CONFLICT_NOTICE);
  }

  /** The status button in the conflict state: the copy itself, or the list of them. */
  function openConflicts() {
    const list = [...conflicts].map(([copy, path]) => ({ path, copy }));
    const open = (copy: WsPath) => {
      void host.openFile(copy);
      settled([copy]);
    };
    if (list.length === 1) open(list[0].copy);
    else if (list.length > 1) showConflicts(list, open, button);
  }

  // ---------------------------------------------------------------- the status button
  let tickMs = 0;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  function tick(ms: number) {
    if (ms === tickMs) return;
    clearInterval(tickTimer);
    tickMs = ms;
    if (ms) tickTimer = setInterval(onTick, ms);
  }
  function onTick() {
    // Some engines miss the "online" event after a long sleep: look again while offline.
    if (phase === "offline" && navigator.onLine) return backOnline();
    render();
  }

  function render() {
    const shown = shownPhase();
    const view = describeStatus({ phase: shown, unsynced, lastSyncAt: remote?.lastSyncAt ?? null, error, retryAt: scheduler.retryAt, now: Date.now(), auth: authKind(), conflicts: conflicts.size });
    renderStatus(button, view, syncIcon);
    button.dataset.syncs = String(syncs);
    button.dataset.unsynced = String(unsynced);
    tick(shown === "waiting" ? 1000 : shown === "offline" ? 2000 : remote ? 30_000 : 0);
  }

  let countTimer: ReturnType<typeof setTimeout> | undefined;
  const activeDirty = () => {
    const editors = host.editors();
    return editors.activeId !== null && editors.isDirty(editors.activeId);
  };
  async function refreshCounts() {
    clearTimeout(countTimer);
    try {
      const stats = await host.store.workspaceStats(host.ws);
      unsynced = stats.changed + stats.added + stats.deleted;
      // Typing the autosave hasn't stored yet is a change too (onLocalChange shows it at once).
      if (unsynced === 0 && activeDirty()) unsynced = 1;
    } catch {
      // storage busy or gone: keep the last count
    }
    if (phase === "synced" || phase === "unsynced") phase = idlePhase();
    render();
  }

  // ---------------------------------------------------------------- one sync
  /** A typed subject its sync didn't use: offered again by the dialog; `why` (if any) is said. */
  function unused(subject: string | null, why?: string) {
    if (!subject) return;
    unusedSubject = subject;
    if (why) host.notice.show(`${why} ${MESSAGE_UNUSED}`, { tone: "info" });
  }

  async function runOnce(reason: RunReason): Promise<RunOutcome> {
    if (asking && !isManual(reason)) {
      held = reason;
      button.dataset.syncHeld = reason;
      return { kind: "idle" };
    }
    const r = remote;
    const c = client;
    // Used by this run only, whatever happens to it.
    const subject = typedSubject;
    typedSubject = null;
    if (!r) {
      unused(subject);
      return { kind: "idle" };
    }
    if (!c) {
      unused(subject);
      phase = "needs-token";
      render();
      return { kind: "stop" };
    }
    if (!host.tab.canWrite()) {
      unused(subject, "This tab became read-only, so it didn't sync.");
      return { kind: "idle" };
    }
    if (!navigator.onLine) {
      unused(subject, "This device is offline, so nothing was synced.");
      phase = "offline";
      render();
      return { kind: "offline" };
    }
    if (reason === "edit") {
      await refreshCounts();
      if (unsynced === 0) return { kind: "idle" };
    }
    const manual = isManual(reason);
    const repo = `${r.owner}/${r.repo}`;
    phase = "syncing";
    render();
    const rev = async () => (await host.store.getWorkspace(host.ws).catch(() => null))?.rev ?? 0;
    host.tab.notifySync("start", await rev());
    try {
      await host.flushSaves();
      const report = await runSync(store, c, {
        deviceName: device,
        subject: subject ?? undefined,
        now: () => new Date(),
        branch: r.branch,
        onProgress: (step) => (button.dataset.syncStep = step),
        firstConnect: manual ? () => askFirstConnect(repo, button) : () => Promise.reject(new ChoiceNeeded()),
      });
      const again = await afterSync(report, repo, manual, subject);
      host.tab.notifySync("done", await rev());
      return { kind: "ok", again };
    } catch (e) {
      if (subject) unusedSubject = subject;
      host.tab.notifySync("error", await rev());
      return await failed(e, reason, repo, subject ? ` ${MESSAGE_UNUSED}` : "");
    } finally {
      syncs++;
      delete button.dataset.syncStep;
      render();
    }
  }

  async function afterSync(report: SyncReport, repo: string, manual: boolean, subject: string | null): Promise<boolean> {
    const rec = await host.store.getWorkspace(host.ws).catch(() => null);
    if (rec) remote = rec.remote;
    error = null;
    const localDeleted = report.deleted.filter((d) => d.where === "local").map((d) => d.path);
    const editors = host.editors();
    const openClean = (path: WsPath) => {
      const id = editors.idForPath(path);
      return id !== null && !editors.isDirty(id);
    };
    const closed = localDeleted.filter(openClean);
    const changed = new Set<WsPath>([...report.pulled, ...localDeleted, ...report.conflicts.map((c) => c.copy)]);
    // Open files with unsaved typing: a pulled file keeps both versions (a conflict copy of the
    // typing); the others are left alone and only matter here if this sync touched them.
    const reloaded = changed.size ? await host.reload([...changed]) : { kept: [], copies: [] };
    const kept = reloaded.kept.filter((p) => changed.has(p));
    await host.refreshWorkspaceInfo();
    await refreshCounts();
    phase = idlePhase();
    const summary = summarizeReport({ ...report, conflicts: [...report.conflicts, ...reloaded.copies] }, { repo, closed, kept });
    // A typed message with nothing to upload: no empty commit is made, and the notice says so.
    const noCommit = subject !== null && report.commits === 0;
    if (noCommit) unusedSubject = subject;
    const nothing = `Nothing here needed uploading, so no commit was made. ${MESSAGE_UNUSED}`;
    if (summary) showReport(noCommit ? { ...summary, text: `${summary.text} ${nothing}` } : summary);
    else if (noCommit) host.notice.show(`Synced with ${repo}. ${nothing}`, { tone: "info" });
    else if (manual) host.announce(`Synced with ${repo}. Nothing needed to change.`);
    return summary?.again ?? false;
  }

  function showReport(summary: ReportNotice) {
    const [first] = summary.conflicts;
    const open = (copy: WsPath) => {
      void host.openFile(copy);
      settled([copy]);
    };
    const action =
      summary.conflicts.length === 1
        ? { label: `Open ${nameOf(first.copy)}`, run: () => open(first.copy) }
        : summary.conflicts.length > 1
          ? { label: "Show conflict copies", run: () => showConflicts(summary.conflicts, open, button) }
          : undefined;
    if (!summary.conflicts.length) {
      host.notice.show(summary.text, { tone: summary.tone, action });
      return;
    }
    // The editor now shows GitHub's version: the report stays until the student opens a copy or dismisses it.
    for (const c of summary.conflicts) conflicts.set(c.copy, c.path);
    host.notice.show(summary.text, { tone: summary.tone, action, pin: { key: CONFLICT_NOTICE, onDismiss: () => (conflicts.clear(), render()) } });
  }

  /** `lost`: " <MESSAGE_UNUSED>" when this sync had a typed message, else "". */
  async function failed(e: unknown, reason: RunReason, repo: string, lost: string): Promise<RunOutcome> {
    const manual = isManual(reason);
    if (e instanceof ChoiceNeeded || e instanceof FirstConnectCancelled) {
      phase = "needs-choice";
      error = null;
      if (e instanceof FirstConnectCancelled) {
        host.notice.show(`Nothing was synced. Choose the sync status when you're ready to combine the files.${lost}`, { tone: "info" });
      } else {
        host.notice.show(`Some files differ between this computer and ${repo}. Choose how to combine them to start syncing.`, {
          tone: "warning",
          action: { label: "Choose", run: () => void syncNow("button") },
        });
      }
      return { kind: "stop" };
    }
    if (e instanceof GitHubError && e.kind === "network" && !navigator.onLine) {
      phase = "offline";
      if (lost) host.notice.show(`This device went offline, so the sync stopped.${lost}`, { tone: "info" });
      return { kind: "offline" };
    }
    const sentence = sentenceFor(e, authKind());
    void recordError(sentence);
    if (e instanceof GitHubError && e.kind === "auth") {
      // A rejected token is never tried again (repeated bad credentials lock the account out for a while).
      client = null;
      appSource = null;
      const app = authKind() === "app";
      if (remembered) {
        remembered = false;
        void (app ? forgetAppTokens() : forgetToken()).catch(() => {});
      }
      phase = "needs-token";
      error = sentence;
      host.notice.show(`Sync failed: ${sentence}${lost}`, { action: { label: app ? "Sign in again" : "Enter a new token", run: () => void openConnect(button) } });
      return { kind: "stop" };
    }
    phase = "failed";
    error = sentence;
    const tryAgain = { label: "Try again", run: () => void syncNow("button") };
    if (retryable(e)) {
      const last = scheduler.failures + 1 >= MAX_FAILURES;
      // A retry by itself writes an automatic message: the typed one belonged to this attempt.
      if (manual || scheduler.failures === 0) host.notice.show(`Sync failed: ${sentence}${last ? "" : " CodeEditor tries again by itself."}${lost}`, { action: tryAgain });
      else if (last) host.notice.show(`Sync failed: ${sentence} CodeEditor stopped trying after ${MAX_FAILURES} attempts.`, { action: tryAgain });
      return { kind: "retry", retryAfterMs: e instanceof GitHubError ? e.retryAfterMs : undefined };
    }
    host.notice.show(`Sync failed: ${sentence}${lost}`, { action: tryAgain });
    return { kind: "stop" };
  }

  /** RemoteMeta.lastError: a later visit shows the failure until a sync succeeds. */
  async function recordError(sentence: string) {
    if (!host.tab.canWrite()) return;
    try {
      const rec = await host.store.getWorkspace(host.ws);
      if (!rec?.remote) return;
      const next = { ...rec.remote, lastError: sentence };
      await host.store.setRemote(host.ws, next);
      remote = next;
    } catch {
      // not recorded: the status still shows it for this visit
    }
  }

  // ---------------------------------------------------------------- connecting
  async function check(input: ConnectInput): Promise<{ result: CheckResult; client: GitHubClient | null }> {
    const fail = (message: string, field?: "owner" | "repo" | "branch" | "token", clearToken = false) => ({ result: { ok: false as const, message, field, clearToken }, client: null });
    let c: GitHubClient;
    try {
      c = createClient({ token: input.token, owner: input.owner, repo: input.repo });
    } catch {
      return fail("This token can't be used: check that exactly the token was copied.", "token");
    }
    if (!navigator.onLine) return fail("This computer is offline, so GitHub can't check the token now. Connect again once you're online.");
    return verify(c, input.owner, input.repo, input.branch, "pat");
  }

  /** Reads the repository and the branch with a new client (a pasted token or a sign-in). */
  async function verify(c: GitHubClient, owner: string, name: string, wanted: string, auth: AuthKind): Promise<{ result: CheckResult; client: GitHubClient | null }> {
    const fail = (message: string, field?: "branch" | "token", clearToken = false) => ({ result: { ok: false as const, message, field, clearToken }, client: null });
    const access = await checkAccess(c, auth);
    if (!access.ok) return c.tokenRejected && auth === "pat" ? fail(access.reason, "token", true) : fail(access.reason);
    const branch = wanted || access.defaultBranch;
    const repo = `${owner}/${name}`;
    try {
      const ref = await c.getRef(branch);
      if (ref.state === "empty" && branch !== access.defaultBranch) {
        return fail(`${repo} is empty, so it can only start on its default branch, ${access.defaultBranch}. Leave the branch empty.`, "branch");
      }
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not-found") return fail(`${repo} has no branch called ${branch}. Leave the field empty for the default branch, ${access.defaultBranch}.`, "branch");
      if (e instanceof TypeError) return fail("This isn't a valid branch name. Leave it empty to use the repository's default branch.", "branch");
      return fail(explainError(e, auth));
    }
    return { result: { ok: true, private: access.private, branch }, client: c };
  }

  /**
   * Writes the connection; the same repository and branch keep their sync position (signing in again).
   * `isPrivate` is the visibility the check just read (null: not known), kept for Share link.
   */
  async function keepRemote(owner: string, repo: string, branch: string, auth: AuthKind, isPrivate: boolean | null, repoId?: number): Promise<string | null> {
    try {
      const rec = await host.store.getWorkspace(host.ws);
      const prev = rec?.remote ?? null;
      const base: RemoteMeta = sameRepo(prev, owner, repo, branch)
        ? { ...prev!, lastError: null, deviceName: device }
        : { provider: "github", owner, repo, branch, baseCommit: null, baseTree: null, refEtag: null, lastSyncAt: null, lastError: null, deviceName: device };
      const next: RemoteMeta = { ...base, auth };
      if (repoId !== undefined) next.repoId = repoId;
      else delete next.repoId;
      if (isPrivate !== null) next.private = isPrivate;
      else delete next.private;
      await host.store.setRemote(host.ws, next);
      remote = next;
      return null;
    } catch (e) {
      return e instanceof StorageError ? e.message : "The connection couldn't be saved on this computer.";
    }
  }

  async function connected(c: GitHubClient, keep: boolean, warning: string) {
    client = c;
    remembered = keep && !warning;
    error = null;
    phase = idlePhase();
    await host.refreshWorkspaceInfo();
    await refreshCounts();
    if (warning) host.notice.show(warning, { tone: "warning" });
  }

  async function save(input: ConnectInput, c: GitHubClient, isPrivate: boolean | null): Promise<string | null> {
    if (!host.tab.canWrite()) return "This tab became read-only (another tab is editing), so it can't connect.";
    let warning = "";
    try {
      if (input.remember) await rememberToken(input.token);
      else await forgetToken();
    } catch {
      if (input.remember) warning = "The token couldn't be stored on this device, so it is kept for this tab only.";
    }
    const problem = await keepRemote(input.owner, input.repo, input.branch, "pat", isPrivate);
    if (problem) {
      // Not connected after all: a token remembered a moment ago would be kept for nothing.
      if (input.remember) await forgetToken().catch(() => {});
      return problem;
    }
    // A sign-in this one replaces: end it, and drop its sealed tokens.
    const old = appSource;
    appSource = null;
    if (old) void revokeToken(old.tokens().access);
    void forgetAppTokens().catch(() => {});
    await connected(c, input.remember, warning);
    return null;
  }

  // ---------------------------------------------------------------- signing in with GitHub
  async function readConfig(): Promise<ConfigState> {
    if (authConfig && authConfig.state !== "unreachable") return authConfig;
    authConfig = await fetchConfig();
    return authConfig;
  }

  const installUrl = () => (authConfig?.state === "available" ? `https://github.com/apps/${authConfig.config.appSlug}/installations/new` : "https://github.com/settings/installations");

  async function reachFor(source: AppTokenSource): Promise<ReachResult> {
    if (!navigator.onLine) return { ok: false, message: OFFLINE_SIGN_IN };
    try {
      const found = await listReachable(await source.current());
      const repos: PickRepo[] = found.repos.map((r) => ({ id: r.id, owner: r.owner, name: r.name, private: r.private }));
      return { ok: true, reach: { login: found.login, repos, settingsUrl: found.installations.length === 1 ? found.installations[0].settingsUrl : null, installUrl: installUrl() } };
    } catch (e) {
      return { ok: false, message: explainError(e, "app") };
    }
  }

  async function startRedirect(remember: boolean): Promise<{ message: string; openToken?: boolean }> {
    if (!navigator.onLine) return { message: OFFLINE_SIGN_IN };
    const config = await readConfig();
    if (config.state === "absent") return { message: "Signing in with GitHub isn't set up on this site, so use a token instead.", openToken: true };
    if (config.state === "unreachable") return { message: "CodeEditor couldn't reach its sign-in service, so check the internet connection and try again, or use a token instead." };
    // Everything typed is saved before the page leaves for GitHub (the workspace is in IndexedDB).
    await host.flushSaves().catch(() => {});
    let url: string;
    try {
      url = await startSignIn({ config: config.config, origin: location.origin, ws: host.ws, remember, repoId: remote?.auth === "app" ? remote.repoId : undefined });
    } catch {
      return { message: "This browser blocks the storage signing in needs (a private window can do this), so use a token instead.", openToken: true };
    }
    location.assign(url);
    // The page is leaving: nothing more to say.
    return new Promise(() => {});
  }

  function abandonSignIn() {
    const s = signedIn;
    signedIn = null;
    if (s) void revokeToken(s.tokens().access);
  }

  async function signInDeps(callback: (() => Promise<ReachResult>) | null, message?: string): Promise<SignInDeps | undefined> {
    const config = await readConfig();
    const offline = !navigator.onLine;
    if (!callback && !message && config.state !== "available" && !(config.state === "unreachable" && offline)) return undefined;
    let pending: GitHubClient | null = null;
    let pendingPrivate: boolean | null = null;
    return {
      message,
      offline,
      // A connection made with a pasted token asks for one again, in the form it was made with.
      openToken: !callback && !message && remote !== null && authKind() === "pat",
      start: startRedirect,
      resume: callback,
      reach: () => (signedIn ? reachFor(signedIn) : Promise.resolve({ ok: false, message: "The sign-in has ended, so sign in again." })),
      async check(repo, branch) {
        pending = null;
        if (!signedIn) return { ok: false, message: "The sign-in has ended, so sign in again." };
        if (!navigator.onLine) return { ok: false, message: "This device is offline, so GitHub can't check the repository now. Connect again once you're online." };
        const { result, client: c } = await verify(createClient({ source: signedIn, owner: repo.owner, repo: repo.name }), repo.owner, repo.name, branch, "app");
        pending = c;
        pendingPrivate = result.ok ? result.private : null;
        return result;
      },
      async save(repo, branch) {
        const source = signedIn;
        if (!pending || !source) return "Choose the repository again, then connect.";
        if (!host.tab.canWrite()) return "This tab became read-only (another tab is editing), so it can't connect.";
        let warning = "";
        try {
          if (source.remembered) await rememberAppTokens(source.tokens());
          else await forgetAppTokens();
        } catch {
          if (source.remembered) warning = "The sign-in couldn't be stored on this device, so it is kept for this tab only.";
        }
        const problem = await keepRemote(repo.owner, repo.name, branch, "app", pendingPrivate, repo.id);
        if (problem) {
          if (source.remembered) await forgetAppTokens().catch(() => {});
          return problem;
        }
        await forgetToken().catch(() => {});
        const old = appSource;
        signedIn = null;
        appSource = source;
        if (old && old !== source) void revokeToken(old.tokens().access);
        await connected(pending, source.remembered, warning);
        return null;
      },
      current: remote ? { owner: remote.owner, repo: remote.repo } : null,
      abandon: abandonSignIn,
    };
  }

  async function openConnect(returnFocus?: HTMLElement | null, signIn?: { resume: (() => Promise<ReachResult>) | null; message?: string }) {
    if (!host.tab.canWrite()) {
      host.notice.show("This tab is read-only: connect GitHub from the tab that edits this workspace, or choose Edit here first.", { tone: "info" });
      return;
    }
    // A sign-in that ended (8 h token, refresh refused): the dialog says so above Sign in.
    if (!signIn && remote && !client && authKind() === "app") {
      signIn = { resume: null, message: "Your GitHub sign-in on this device has ended, so sign in again. Your files here are kept and sync once you're back." };
    }
    let pending: GitHubClient | null = null;
    let pendingPrivate: boolean | null = null;
    const ok = await openConnectDialog({
      initial: remote ? { owner: remote.owner, repo: remote.repo, branch: remote.branch } : null,
      returnFocus: returnFocus?.isConnected ? returnFocus : button,
      check: async (input) => {
        const { result, client: c } = await check(input);
        pending = c;
        pendingPrivate = result.ok ? result.private : null;
        return result;
      },
      save: (input) => (pending ? save(input, pending, pendingPrivate) : Promise.resolve("Check the repository again, then connect.")),
      signIn: await signInDeps(signIn?.resume ?? null, signIn?.message),
    });
    // The opener (an empty-state button) may be gone once files arrive: keep focus in the top bar.
    if (!document.activeElement || document.activeElement === document.body) button.focus();
    if (!ok || !remote) return;
    host.notice.show(`Connected to ${repoName()}. Syncing now.`, { tone: "info" });
    await scheduler.request("connect");
  }

  /** GitHub sent the student back: the record of this tab must match before anything is sent. */
  async function finishSignIn(cb: AuthCallback) {
    const checked = checkCallback(cb, takePending(), host.ws);
    if (!checked.ok) {
      const message =
        checked.reason === "state"
          ? "This sign-in wasn't started in this tab (or took longer than 10 minutes), so it was ignored. Sign in again."
          : checked.reason === "denied"
            ? signInFailure(new SignInError("access_denied")).message
            : "GitHub couldn't finish signing in, so sign in again.";
      await openConnect(button, { resume: null, message });
      return;
    }
    const { code, pending } = checked;
    await openConnect(button, {
      resume: async () => {
        if (!navigator.onLine) return { ok: false, message: OFFLINE_SIGN_IN };
        let source: AppTokenSource;
        try {
          source = createAppTokenSource({ tokens: await exchange(code, pending.verifier, pending.repoId), remember: pending.remember });
        } catch (e) {
          return signInFailure(e);
        }
        signedIn = source;
        return reachFor(source);
      },
    });
  }

  /** Ends this device's sign-in on GitHub (this one token only), at most REVOKE_WAIT_MS. */
  async function revokeCurrent(): Promise<boolean | null> {
    const source = appSource ?? signedIn;
    appSource = null;
    signedIn = null;
    if (!source) return null;
    return withTimeout(revokeToken(source.tokens().access), REVOKE_WAIT_MS, false);
  }

  async function disconnect() {
    if (!remote) return;
    const repo = repoName();
    const app = authKind() === "app";
    const ok = await confirmDialog({
      title: `Disconnect ${repo}?`,
      body: [
        "This computer stops syncing with the repository. Your files stay here and on GitHub.",
        app
          ? "The GitHub sign-in on this device ends: CodeEditor asks GitHub to revoke its token and deletes it here."
          : remembered
            ? "The token remembered on this device is deleted."
            : "The token is forgotten.",
      ],
      confirm: "Disconnect",
    });
    if (!ok) return;
    if (!host.tab.canWrite()) {
      host.notice.show("This tab is read-only: disconnect from the tab that edits this workspace.", { tone: "info" });
      return;
    }
    // A sync that is running would write its connection back: let it finish first.
    await scheduler.idle();
    try {
      await host.store.setRemote(host.ws, null);
    } catch (e) {
      host.notice.show(`Disconnecting didn't work: ${e instanceof Error ? e.message : "try again."}`);
      return;
    }
    const revoked = await revokeCurrent();
    await forgetToken().catch(() => {});
    await forgetAppTokens().catch(() => {});
    remote = null;
    client = null;
    remembered = false;
    error = null;
    phase = "not-connected";
    forgetConflicts();
    scheduler.reset();
    await host.refreshWorkspaceInfo();
    render();
    if (revoked === false) {
      // Offline, or the sign-in service didn't answer: the token is gone from here, not from GitHub yet.
      host.notice.show(
        `Disconnected from ${repo}. GitHub couldn't be reached to end the sign-in, so it stops working by itself within 8 hours; to end it now, revoke CodeEditor in GitHub's settings (Applications, Authorized GitHub Apps).`,
        { tone: "warning", action: { label: "Open GitHub settings", run: () => void open(AUTHORIZED_APPS_URL, "_blank", "noopener,noreferrer") } },
      );
      return;
    }
    host.notice.show(`Disconnected from ${repo}. Your files stay on this computer and in the repository.`, { tone: "info" });
  }

  // ---------------------------------------------------------------- Share link
  /** GitHub refused the token outside a sync (sharing): the same end as a sync's 401. */
  function tokenRefused(e: unknown) {
    if (!(e instanceof GitHubError) || e.kind !== "auth" || !client) return;
    client = null;
    appSource = null;
    if (remembered) {
      remembered = false;
      void (authKind() === "app" ? forgetAppTokens() : forgetToken()).catch(() => {});
    }
    phase = "needs-token";
    error = explainError(e, authKind());
    render();
  }

  async function shareState(path: WsPath): Promise<ShareState> {
    if (!remote) return { kind: "not-connected" };
    const snap = await store.snapshot();
    const local = snap.local.get(path);
    const r = snap.remote ?? remote;
    if (!local) return { kind: "missing" };
    const link = shareRules.repoLinkState({ owner: r.owner, repo: r.repo, commit: r.baseCommit, path, localSha: local.sha, baseSha: snap.base.get(path)?.sha ?? null });
    // A stored value that isn't a boolean (an older or damaged record) is unknown, never private.
    const stored = typeof r.private === "boolean" ? r.private : null;
    return { kind: "connected", repo: `${r.owner}/${r.repo}`, link, opaque: Boolean(local.opaque), private: stored };
  }

  /** Keeps GitHub's live answer for the next Share link that can't ask (only when it changed). */
  async function rememberVisibility(isPrivate: boolean) {
    if (!host.tab.canWrite()) return;
    try {
      const rec = await host.store.getWorkspace(host.ws);
      const now = rec?.remote;
      if (!now || !remote || !sameRepo(now, remote.owner, remote.repo, remote.branch) || now.private === isPrivate) return;
      const next = { ...now, private: isPrivate };
      await host.store.setRemote(host.ws, next);
      remote = next;
    } catch {
      // not recorded: this opening still shows the live answer
    }
  }

  const READ_ONLY_SHARE = "This tab became read-only (another tab is editing), so it doesn't sync or share from here: share from the tab that edits.";

  /** "Sync now" in the share dialog: the sentence to show when it couldn't bring the file up to date. */
  async function syncForShare(): Promise<string | null> {
    if (!remote) return "This workspace isn't connected to GitHub any more.";
    if (!host.tab.canWrite()) return READ_ONLY_SHARE;
    if (!client) {
      return authKind() === "app"
        ? "Your GitHub sign-in has ended on this device, so sign in again (the sync status), then share."
        : "This tab has no GitHub token, so enter it again (the sync status), then share.";
    }
    if (!navigator.onLine) return "This device is offline, so it can't sync now. Try again once you're online.";
    await host.flushSaves().catch(() => {});
    await scheduler.request("button");
    if (phase === "offline") return "This device is offline, so it can't sync now. Try again once you're online.";
    if (phase === "needs-choice") return "Some files differ between this computer and the repository: choose how to combine them (the sync status), then share.";
    if (phase === "failed" || phase === "needs-token") return `The sync failed: ${error ?? "try again."}`;
    return null;
  }

  async function share(path: WsPath, returnFocus: HTMLElement | null) {
    // A read-only tab neither syncs nor holds the sync's state: the editing tab shares.
    if (!host.tab.canWrite()) {
      host.notice.show("This tab is read-only, so it doesn't share from GitHub: the tab that edits this workspace does. Choose Edit here to share from this tab.", { tone: "info" });
      return;
    }
    // Typing not saved yet counts as a change: the link must show what the student sees.
    await host.flushSaves().catch(() => {});
    let m: typeof import("./share-dialog");
    try {
      m = await import("./share-dialog");
    } catch {
      host.notice.show("Share link couldn't open. Check the connection, then try again.");
      return;
    }
    const c = client;
    await m.openShareDialog({
      path,
      rules: shareRules,
      externalIcon: () => syncIcon("arrow-square-out", "ext-icon"),
      state: () => shareState(path),
      async repoPrivate() {
        if (!client || !navigator.onLine) return null;
        let isPrivate: boolean;
        try {
          isPrivate = (await client.getRepo()).private;
        } catch (e) {
          tokenRefused(e);
          return null;
        }
        await rememberVisibility(isPrivate);
        return isPrivate;
      },
      syncNow: syncForShare,
      async readText() {
        await host.flushSaves().catch(() => {});
        const entry = await host.store.getEntry(host.ws, path);
        if (!entry || entry.kind !== "file") return "missing";
        if (entry.opaque) return "opaque";
        return { text: await host.store.readFile(host.ws, path) };
      },
      codeLink: async (text) => (await import("../core/code-link")).makeCodeLink(location.origin, nameOf(path), text),
      readOnly: () => (host.tab.canWrite() ? null : READ_ONLY_SHARE),
      notice: host.notice,
      createGist: c
        ? async (body, signal) => {
            const now = client;
            if (!now) throw new GitHubError("auth", 401, "createGist", "Creating the gist wasn't tried: there is no token in this tab");
            try {
              return await now.createGist(body, signal);
            } catch (e) {
              tokenRefused(e);
              throw e;
            }
          }
        : null,
      auth: authKind(),
      online: () => navigator.onLine,
      connect: () => void openConnect(button),
      returnTo: returnFocus?.isConnected ? returnFocus : button,
      mac: /Mac|iPhone|iPad/.test(navigator.platform ?? ""),
    });
  }

  // ---------------------------------------------------------------- what the workbench calls
  function syncNow(reason: RunReason): Promise<void> {
    if (!remote) return Promise.resolve();
    if (!client) {
      if (reason === "button") return openConnect(button);
      if (reason === "key") {
        const app = authKind() === "app";
        host.notice.show(app ? "Saved on this computer. Sign in with GitHub again to sync it too." : "Saved on this computer. Enter your GitHub token to sync it too.", {
          tone: "info",
          action: { label: app ? "Sign in" : "Enter token", run: () => void openConnect(button) },
        });
      }
      return Promise.resolve();
    }
    if (!host.tab.canWrite()) return Promise.resolve();
    return scheduler.request(reason);
  }

  /**
   * The dialog asks only when a sync could start from here (connected, a token, the writer tab);
   * otherwise this says why, as the status button does. Sync starts at once, like "Sync now"; the
   * typed subject is used by that run alone (runOnce takes it) and an empty one is "Sync now".
   */
  async function syncWithMessage(returnFocus?: HTMLElement | null) {
    if (!remote) return;
    if (!host.tab.canWrite()) {
      host.notice.show(READ_ONLY_SYNC, { tone: "info" });
      return;
    }
    if (!client) return openConnect(returnFocus ?? button);
    // The count the dialog shows includes what was typed a moment ago.
    await host.flushSaves().catch(() => {});
    await refreshCounts();
    asking = true;
    held = null;
    openMessageDialog({
      repo: repoName(),
      unsynced,
      initial: unusedSubject,
      returnFocus: returnFocus?.isConnected ? returnFocus : button,
      start(subject) {
        if (!remote || !client) return "This workspace isn't connected to GitHub any more, so it can't sync.";
        if (!host.tab.canWrite()) return "This tab became read-only (another tab is editing), so it can't sync. Your message is kept here.";
        if (!navigator.onLine) return "This device is offline, so nothing can sync now. Your message is kept here: choose Sync once you're online.";
        unusedSubject = "";
        if (!subject) {
          void syncNow("button");
          return null;
        }
        typedSubject = subject;
        void scheduler.request("message").then(() => {
          // The scheduler was stopped (signed out) before a run took it: never left for a later sync.
          if (typedSubject === subject) {
            typedSubject = null;
            unusedSubject = subject;
          }
        });
        return null;
      },
      closed(started) {
        asking = false;
        const due = held;
        held = null;
        delete button.dataset.syncHeld;
        // Closed without syncing: the automatic sync that waited for the dialog runs now.
        if (!started && due !== null) void scheduler.request(due);
      },
    });
  }

  function backOnline() {
    if (phase === "offline") phase = idlePhase();
    render();
    if (remote && client && unsynced > 0 && !scheduler.busy) void scheduler.request("online");
    else scheduler.wake();
  }

  addEventListener("online", backOnline);
  addEventListener("offline", () => {
    if (remote && client && phase !== "syncing") {
      phase = "offline";
      render();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduler.wake();
  });
  // Another tab synced or edited: its record (last sync, last error) is the one to show here.
  host.tab.onStale(() => {
    void host.store.getWorkspace(host.ws).then((rec) => {
      if (rec && !host.tab.canWrite()) {
        remote = rec.remote;
        error = rec.remote?.lastError ?? null;
      }
      return refreshCounts();
    }).catch(() => {});
  });
  host.settings.onChange((now, before) => {
    if (now.autoSync && !before.autoSync) scheduler.localChange();
  });
  // Every edit this tab commits counts, not only saves: new, renamed, deleted and imported files too.
  const LOCAL_EDITS: ReadonlySet<string> = new Set(["save", "create", "rename", "delete", "import"]);
  host.store.onChange((event) => {
    if (event.ws === host.ws && LOCAL_EDITS.has(event.reason)) onLocalChange();
    if (event.ws !== host.ws || !conflicts.size) return;
    // A copy opened in a tab (from the list, a tab, search...), renamed or deleted has been dealt with.
    if (event.reason === "ui") {
      const editors = host.editors();
      settled([...conflicts.keys()].filter((copy) => editors.idForPath(copy) !== null));
    } else if (event.reason === "delete" || event.reason === "rename") {
      settled([...conflicts.keys()].filter((copy) => event.paths.some((p) => copy === p || copy.startsWith(`${p}/`))));
    }
  });

  function onLocalChange() {
    if (!remote) return;
    // Shown at once (the count is read again below, once the autosave has stored the edit).
    if (phase === "synced") {
      phase = "unsynced";
      unsynced = Math.max(unsynced, 1);
      render();
    }
    clearTimeout(countTimer);
    countTimer = setTimeout(() => void refreshCounts(), 500);
    scheduler.localChange();
  }

  async function init() {
    const rec = await host.store.getWorkspace(host.ws).catch(() => null);
    remote = rec?.remote ?? null;
    if (remote?.auth === "app") {
      const tokens = await loadAppTokens().catch(() => null);
      if (tokens) {
        try {
          appSource = createAppTokenSource({ tokens, remember: true });
          client = createClient({ source: appSource, owner: remote.owner, repo: remote.repo });
          remembered = true;
        } catch {
          client = null;
          appSource = null;
        }
      }
    } else if (remote) {
      let saved: string | null = null;
      try {
        saved = await loadToken();
      } catch {
        saved = null;
      }
      if (saved) {
        try {
          client = createClient({ token: saved, owner: remote.owner, repo: remote.repo });
          remembered = true;
        } catch {
          client = null;
        }
      }
    }
    await refreshCounts();
    error = client ? (remote?.lastError ?? null) : null;
    phase = remote && client && error ? "failed" : idlePhase();
    render();
    // Bring in what changed on GitHub (or another computer) since the last visit.
    if (remote && client) void scheduler.request("startup");
  }
  const ready = init();

  return {
    ready,
    pressStatus() {
      if (!host.tab.canWrite() && remote) {
        host.notice.show(READ_ONLY_SYNC, { tone: "info" });
        return;
      }
      if (phase === "not-connected" || phase === "needs-token") void openConnect(button);
      else if (shownPhase() === "conflict") openConflicts();
      else if (phase !== "syncing") void syncNow("button");
    },
    openConnect,
    disconnect,
    syncNow,
    syncWithMessage,
    onLocalChange,
    connected: () => remote !== null,
    describe() {
      if (!remote) return "Not connected. Files are saved only on this computer.";
      const token =
        authKind() === "app"
          ? remembered
            ? "Signed in with GitHub; the sign-in is remembered on this device (encrypted)."
            : client
              ? "Signed in with GitHub in this tab only."
              : "Sign in with GitHub again to sync."
          : remembered
            ? "The token is remembered on this device (encrypted)."
            : client
              ? "The token is kept in this tab only."
              : "Enter the token again to sync.";
      return `Connected to ${repoName()}, branch ${remote.branch}. ${token}`;
    },
    async signOut() {
      scheduler.stop();
      // A sync in flight can take a while to give up; clearing this computer doesn't wait for long.
      await Promise.race([scheduler.idle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      clearPending();
      await revokeCurrent();
      client = null;
      remembered = false;
      forgetConflicts();
    },
    finishSignIn,
    share,
  };
}
