// The seam between the workbench and the GitHub sync screens. The workbench calls mountSync() once
// it is ready and uses only the returned hooks. This file stays in the first-visit shell and is
// small: it draws the top bar's sync status from the stored connection, and loads the sync
// screens (src/ui/sync-controller.ts with src/sync) only when a repository is connected or the
// Connect dialog opens, so a first visit doesn't download them.
import "../styles/sync.css";
import type { RemoteMeta, WsPath } from "../core/types";
import { takeCallback } from "../sync/auth-callback";
import type { WorkspaceDb } from "../storage/db";
import type { TabCoordinator } from "../storage/tabs";
import type { WorkspaceStore } from "../storage/workspace";
import { h } from "./dom";
import type { Editors } from "./editors";
import { icon, type IconName } from "./icons";
import type { Notice } from "./notice";
import type { SettingsStore } from "./settings";
import type { SyncController } from "./sync-controller";
import { describeStatus, renderStatus, type SyncPhase } from "./sync-status";

/** What the workbench gives the sync screens. */
export interface SyncHost {
  db: WorkspaceDb;
  /** Created with this tab's canWrite guard; reuse it (and createSyncStore(db, ws, { canWrite })). */
  store: WorkspaceStore;
  /** The workspace id (navigator.locks name: lockName(ws)). */
  ws: string;
  tab: TabCoordinator;
  /**
   * The editor as it is now. CodeMirror loads with the first opened file, so ask each time: before
   * that this is a stand-in with nothing open (editors.ts).
   */
  editors(): Editors;
  settings: SettingsStore;
  notice: Notice;
  /** Reads a sentence out (aria-live polite). */
  announce(text: string): void;
  /** The top bar's sync status slot: put an icon AND words here ("Synced 2 min ago"). */
  statusSlot: HTMLElement;
  /** Finishes pending autosaves (call before a sync snapshot). */
  flushSaves(): Promise<void>;
  /**
   * Re-reads the tree and open files after a pull: clean open files whose text changed get it
   * (EditorManager.replaceContent); tabs whose file is gone close. An open file with unsaved typing
   * whose text the pull changed keeps both versions: the pulled text keeps the name and the typing
   * becomes a conflict copy (`copies`). `kept`: open files with unsaved typing the pull didn't touch.
   */
  reload(changed?: readonly WsPath[]): Promise<{ kept: WsPath[]; copies: { path: WsPath; copy: WsPath }[] }>;
  /** Opens a file in the editor (links to conflict copies in a sync report). */
  openFile(path: WsPath): Promise<void>;
  /** Re-reads the workspace record (top bar: workspace and repository names). */
  refreshWorkspaceInfo(): Promise<void>;
}

/** What the sync screens give back. */
export interface SyncHooks {
  /** "Connect GitHub" (empty workspace, Settings). */
  connect(): void;
  /** "Disconnect GitHub" (Settings). */
  disconnect(): void;
  /** Ctrl+S calls this right after saving (and the top bar's Sync button, once there is one). */
  syncNow(): Promise<void>;
  /** "Sync now with a message" (palette, Settings): a dialog asks for the commit subject. */
  syncWithMessage(opener?: HTMLElement | null): void;
  /** A file was saved here: start or restart the 60 s auto-sync timer. */
  onLocalChange(): void;
  /** True while a repository is connected (Settings shows Disconnect instead of Connect). */
  connected(): boolean;
  /** One sentence for Settings ("Not connected", "Connected to me/code, branch main"). */
  describe(): string;
  /** "Sign out and clear this computer": stop syncing and forget the token in memory. */
  signOut(): Promise<void>;
}

/** Before the sync screens load, the status comes from the stored connection alone. */
function storedPhase(remote: RemoteMeta | null, unsynced: number): SyncPhase {
  if (!remote) return "not-connected";
  if (remote.lastError) return "failed";
  return unsynced > 0 ? "unsynced" : "synced";
}

export function mountSync(host: SyncHost): SyncHooks {
  const button = h("button", { type: "button", class: "sync-status", id: "sync-status", "data-syncs": "0" });
  host.statusSlot.replaceChildren(button);
  let remote: RemoteMeta | null = null;
  let controller: SyncController | null = null;
  let loading: Promise<SyncController> | null = null;

  const draw = (phase: SyncPhase, unsynced = 0) =>
    renderStatus(button, describeStatus({ phase, unsynced, lastSyncAt: remote?.lastSyncAt ?? null, error: remote?.lastError, now: Date.now() }), (name) => icon(name as IconName));
  draw("not-connected");

  function load(): Promise<SyncController> {
    loading ??= import("./sync-controller").then(
      async ({ createSyncController }) => {
        const created = createSyncController(host, button);
        await created.ready;
        controller = created;
        return created;
      },
      (e: unknown) => {
        loading = null; // a later press tries again
        throw e;
      },
    );
    return loading;
  }
  function withController(run: (c: SyncController) => unknown) {
    load().then(run, () => host.notice.show("The GitHub screens couldn't load. Check the connection, then try again."));
  }
  // Heading for the status or a Connect button is a good sign the screens are needed next.
  const prefetch = () => void load().catch(() => {});
  button.addEventListener("pointerover", prefetch, { once: true });
  button.addEventListener("click", () => withController((c) => c.pressStatus()));

  // GitHub sent the student back from "Sign in with GitHub" (main.ts took the code off the URL).
  const callback = takeCallback();
  if (callback) withController((c) => c.finishSignIn(callback));

  void (async () => {
    const rec = await host.store.getWorkspace(host.ws).catch(() => null);
    remote = rec?.remote ?? null;
    if (!remote || loading) return;
    const stats = await host.store.workspaceStats(host.ws).catch(() => null);
    if (!loading) draw(storedPhase(remote, stats ? stats.changed + stats.added + stats.deleted : 0), stats ? stats.changed + stats.added + stats.deleted : 0);
    // A connected workspace syncs on its own: load the screens now.
    prefetch();
  })();

  return {
    connect() {
      // Focus goes back to the button that asked (WebKit doesn't focus buttons on click: then the status).
      const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      withController((c) => c.openConnect(opener));
    },
    disconnect: () => withController((c) => c.disconnect()),
    async syncNow() {
      // Not loaded and not connected: nothing to sync (Ctrl+S just saved).
      if (!controller && !loading && !remote) return;
      const c = controller ?? (await load().catch(() => null));
      await c?.syncNow("key");
    },
    syncWithMessage(opener) {
      if (!controller && !loading && !remote) return;
      withController((c) => c.syncWithMessage(opener));
    },
    onLocalChange: () => controller?.onLocalChange(),
    connected: () => (controller ? controller.connected() : remote !== null),
    describe: () =>
      controller
        ? controller.describe()
        : remote
          ? `Connected to ${remote.owner}/${remote.repo}, branch ${remote.branch}.`
          : "Not connected. Files are saved only on this computer.",
    async signOut() {
      await controller?.signOut();
    },
  };
}
