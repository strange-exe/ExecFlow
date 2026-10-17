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
// computer", encrypted in the codeeditor-secrets database. It never reaches the DOM, a message,
// the log or a URL; every sentence shown comes from explainError or fixed text.
import { nameOf } from "../core/paths";
import type { RemoteMeta, WsPath } from "../core/types";
import { StorageError } from "../storage/db";
import { createSyncStore } from "../storage/sync-store";
import { SyncError, sync as runSync, type SyncReport } from "../sync/engine";
import { createClient, GitHubError, type GitHubClient } from "../sync/github";
import { checkAccess, explainError } from "../sync/repo-check";
import { forgetToken, loadToken, rememberToken } from "../sync/token-store";
import { confirmDialog } from "./dialogs";
import { openConnectDialog, type CheckResult, type ConnectInput } from "./sync-connect";
import type { SyncHost } from "./sync-entry";
import { askFirstConnect, FirstConnectCancelled, showConflicts } from "./sync-first-connect";
import { deviceName } from "./sync-form";
import { syncIcon } from "./sync-icons";
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
  onLocalChange(): void;
  connected(): boolean;
  describe(): string;
  signOut(): Promise<void>;
}

/** An automatic sync reached the first-connect question: only the user starts that sync. */
class ChoiceNeeded extends Error {}

/** GitHub (or the network) may answer differently in a while. */
function retryable(error: unknown): boolean {
  if (error instanceof GitHubError) return error.kind === "rate-limit" || error.kind === "server" || error.kind === "network" || error.kind === "conflict";
  return error instanceof SyncError && error.kind === "remote-moving";
}

function sentenceFor(error: unknown): string {
  if (error instanceof StorageError) {
    return error.code === "read-only"
      ? "this tab became read-only (another tab is editing), so it didn't save what it synced; nothing was lost."
      : error.message;
  }
  return explainError(error);
}

const sameRepo = (a: RemoteMeta | null, owner: string, repo: string, branch: string) =>
  a !== null && a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase() && a.branch === branch;

export function createSyncController(host: SyncHost, button: HTMLButtonElement): SyncController {
  const store = createSyncStore(host.db, host.ws, { canWrite: () => host.tab.canWrite() });
  const device = deviceName(navigator.userAgent, navigator.platform ?? "");
  let remote: RemoteMeta | null = null;
  let client: GitHubClient | null = null;
  let remembered = false;
  let phase: SyncPhase = "not-connected";
  /** The failure shown with "failed" (and "Token not accepted" for needs-token). */
  let error: string | null = null;
  let unsynced = 0;
  let syncs = 0;

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
    const shown: SyncPhase = phase === "failed" && scheduler.retryAt !== null ? "waiting" : phase;
    const view = describeStatus({ phase: shown, unsynced, lastSyncAt: remote?.lastSyncAt ?? null, error, retryAt: scheduler.retryAt, now: Date.now() });
    renderStatus(button, view, syncIcon);
    button.dataset.syncs = String(syncs);
    button.dataset.unsynced = String(unsynced);
    tick(shown === "waiting" ? 1000 : shown === "offline" ? 2000 : remote ? 30_000 : 0);
  }

  let countTimer: ReturnType<typeof setTimeout> | undefined;
  async function refreshCounts() {
    clearTimeout(countTimer);
    try {
      const stats = await host.store.workspaceStats(host.ws);
      unsynced = stats.changed + stats.added + stats.deleted;
    } catch {
      // storage busy or gone: keep the last count
    }
    if (phase === "synced" || phase === "unsynced") phase = idlePhase();
    render();
  }

  // ---------------------------------------------------------------- one sync
  async function runOnce(reason: RunReason): Promise<RunOutcome> {
    const r = remote;
    const c = client;
    if (!r) return { kind: "idle" };
    if (!c) {
      phase = "needs-token";
      render();
      return { kind: "stop" };
    }
    if (!host.tab.canWrite()) return { kind: "idle" };
    if (!navigator.onLine) {
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
        now: () => new Date(),
        branch: r.branch,
        onProgress: (step) => (button.dataset.syncStep = step),
        firstConnect: manual ? () => askFirstConnect(repo, button) : () => Promise.reject(new ChoiceNeeded()),
      });
      const again = await afterSync(report, repo, manual);
      host.tab.notifySync("done", await rev());
      return { kind: "ok", again };
    } catch (e) {
      host.tab.notifySync("error", await rev());
      return await failed(e, reason, repo);
    } finally {
      syncs++;
      delete button.dataset.syncStep;
      render();
    }
  }

  async function afterSync(report: SyncReport, repo: string, manual: boolean): Promise<boolean> {
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
    if (summary) showReport(summary);
    else if (manual) host.announce(`Synced with ${repo}. Nothing needed to change.`);
    return summary?.again ?? false;
  }

  function showReport(summary: ReportNotice) {
    const [first] = summary.conflicts;
    const action =
      summary.conflicts.length === 1
        ? { label: `Open ${nameOf(first.copy)}`, run: () => void host.openFile(first.copy) }
        : summary.conflicts.length > 1
          ? { label: "Show conflict copies", run: () => showConflicts(summary.conflicts, (p) => void host.openFile(p), button) }
          : undefined;
    host.notice.show(summary.text, { tone: summary.tone, action });
  }

  async function failed(e: unknown, reason: RunReason, repo: string): Promise<RunOutcome> {
    const manual = isManual(reason);
    if (e instanceof ChoiceNeeded || e instanceof FirstConnectCancelled) {
      phase = "needs-choice";
      error = null;
      if (e instanceof FirstConnectCancelled) {
        host.notice.show("Nothing was synced. Choose Sync in the top bar when you're ready to combine the files.", { tone: "info" });
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
      return { kind: "offline" };
    }
    const sentence = sentenceFor(e);
    void recordError(sentence);
    if (e instanceof GitHubError && e.kind === "auth") {
      // A rejected token is never tried again (repeated bad credentials lock the account out for a while).
      client = null;
      if (remembered) {
        remembered = false;
        void forgetToken().catch(() => {});
      }
      phase = "needs-token";
      error = sentence;
      host.notice.show(`Sync failed: ${sentence}`, { action: { label: "Enter a new token", run: () => void openConnect(button) } });
      return { kind: "stop" };
    }
    phase = "failed";
    error = sentence;
    const tryAgain = { label: "Try again", run: () => void syncNow("button") };
    if (retryable(e)) {
      const last = scheduler.failures + 1 >= MAX_FAILURES;
      if (manual || scheduler.failures === 0) host.notice.show(`Sync failed: ${sentence}${last ? "" : " CodeEditor tries again by itself."}`, { action: tryAgain });
      else if (last) host.notice.show(`Sync failed: ${sentence} CodeEditor stopped trying after ${MAX_FAILURES} attempts.`, { action: tryAgain });
      return { kind: "retry", retryAfterMs: e instanceof GitHubError ? e.retryAfterMs : undefined };
    }
    host.notice.show(`Sync failed: ${sentence}`, { action: tryAgain });
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
    const access = await checkAccess(c);
    if (!access.ok) return c.tokenRejected ? fail(access.reason, "token", true) : fail(access.reason);
    const branch = input.branch || access.defaultBranch;
    const repo = `${input.owner}/${input.repo}`;
    try {
      const ref = await c.getRef(branch);
      if (ref.state === "empty" && branch !== access.defaultBranch) {
        return fail(`${repo} is empty, so it can only start on its default branch, ${access.defaultBranch}. Leave the branch empty.`, "branch");
      }
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not-found") return fail(`${repo} has no branch called ${branch}. Leave the field empty for the default branch, ${access.defaultBranch}.`, "branch");
      if (e instanceof TypeError) return fail("This isn't a valid branch name. Leave it empty to use the repository's default branch.", "branch");
      return fail(explainError(e));
    }
    return { result: { ok: true, private: access.private, branch }, client: c };
  }

  async function save(input: ConnectInput, c: GitHubClient): Promise<string | null> {
    if (!host.tab.canWrite()) return "This tab became read-only (another tab is editing), so it can't connect.";
    let warning = "";
    try {
      if (input.remember) await rememberToken(input.token);
      else await forgetToken();
    } catch {
      if (input.remember) warning = "The token couldn't be stored on this computer, so it is kept for this tab only.";
    }
    try {
      const rec = await host.store.getWorkspace(host.ws);
      const prev = rec?.remote ?? null;
      // The same repository and branch keep their sync position (a token entered again).
      const next: RemoteMeta = sameRepo(prev, input.owner, input.repo, input.branch)
        ? { ...prev!, lastError: null, deviceName: device }
        : { provider: "github", owner: input.owner, repo: input.repo, branch: input.branch, baseCommit: null, baseTree: null, refEtag: null, lastSyncAt: null, lastError: null, deviceName: device };
      await host.store.setRemote(host.ws, next);
      remote = next;
    } catch (e) {
      // Not connected after all: a token remembered a moment ago would be kept for nothing.
      if (input.remember) await forgetToken().catch(() => {});
      return e instanceof StorageError ? e.message : "The connection couldn't be saved on this computer.";
    }
    client = c;
    remembered = input.remember && !warning;
    error = null;
    phase = idlePhase();
    await host.refreshWorkspaceInfo();
    await refreshCounts();
    if (warning) host.notice.show(warning, { tone: "warning" });
    return null;
  }

  async function openConnect(returnFocus?: HTMLElement | null) {
    if (!host.tab.canWrite()) {
      host.notice.show("This tab is read-only: connect GitHub from the tab that edits this workspace, or choose Edit here first.", { tone: "info" });
      return;
    }
    let pending: GitHubClient | null = null;
    const ok = await openConnectDialog({
      initial: remote ? { owner: remote.owner, repo: remote.repo, branch: remote.branch } : null,
      returnFocus: returnFocus?.isConnected ? returnFocus : button,
      check: async (input) => {
        const { result, client: c } = await check(input);
        pending = c;
        return result;
      },
      save: (input) => (pending ? save(input, pending) : Promise.resolve("Check the repository again, then connect.")),
    });
    // The opener (an empty-state button) may be gone once files arrive: keep focus in the top bar.
    if (!document.activeElement || document.activeElement === document.body) button.focus();
    if (!ok || !remote) return;
    host.notice.show(`Connected to ${repoName()}. Syncing now.`, { tone: "info" });
    await scheduler.request("connect");
  }

  async function disconnect() {
    if (!remote) return;
    const repo = repoName();
    const ok = await confirmDialog({
      title: `Disconnect ${repo}?`,
      body: [
        "This computer stops syncing with the repository. Your files stay here and on GitHub.",
        remembered ? "The token remembered on this computer is deleted." : "The token is forgotten.",
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
    await forgetToken().catch(() => {});
    remote = null;
    client = null;
    remembered = false;
    error = null;
    phase = "not-connected";
    scheduler.reset();
    await host.refreshWorkspaceInfo();
    render();
    host.notice.show(`Disconnected from ${repo}. Your files stay on this computer and in the repository.`, { tone: "info" });
  }

  // ---------------------------------------------------------------- what the workbench calls
  function syncNow(reason: RunReason): Promise<void> {
    if (!remote) return Promise.resolve();
    if (!client) {
      if (reason === "button") return openConnect(button);
      if (reason === "key") {
        host.notice.show("Saved on this computer. Enter your GitHub token to sync it too.", { tone: "info", action: { label: "Enter token", run: () => void openConnect(button) } });
      }
      return Promise.resolve();
    }
    if (!host.tab.canWrite()) return Promise.resolve();
    return scheduler.request(reason);
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
  });

  function onLocalChange() {
    if (!remote) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(() => void refreshCounts(), 500);
    scheduler.localChange();
  }

  async function init() {
    const rec = await host.store.getWorkspace(host.ws).catch(() => null);
    remote = rec?.remote ?? null;
    if (remote) {
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
        host.notice.show("This tab is read-only, so it doesn't sync: the tab that edits this workspace does. Choose Edit here to sync from this tab.", { tone: "info" });
        return;
      }
      if (phase === "not-connected" || phase === "needs-token") void openConnect(button);
      else if (phase !== "syncing") void syncNow("button");
    },
    openConnect,
    disconnect,
    syncNow,
    onLocalChange,
    connected: () => remote !== null,
    describe() {
      if (!remote) return "Not connected. Files are saved only on this computer.";
      const token = remembered ? "The token is remembered on this computer (encrypted)." : client ? "The token is kept in this tab only." : "Enter the token again to sync.";
      return `Connected to ${repoName()}, branch ${remote.branch}. ${token}`;
    },
    async signOut() {
      scheduler.stop();
      // A sync in flight can take a while to give up; clearing this computer doesn't wait for long.
      await Promise.race([scheduler.idle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      client = null;
      remembered = false;
    },
  };
}
