// The site's move to a new address, in the page (release 0.12.0; the protocol and its guards are
// src/core/move-protocol.ts). At the old address a notice that stays until dismissed (for this
// session) offers "Move my files"; at the new address, a tab the old one opened takes the files,
// after asking. Any other address (a preview, a test server) does nothing. Both addresses keep
// working, and the files also stay at the old one.
//
// Why the hand-over happens at /move: the editor at / is cross-origin isolated (COOP same-origin,
// for SharedArrayBuffer: live input and stopping Python). A COOP same-origin page that opens another
// origin loses its reference to that tab (the browser puts the new tab in a new browsing context
// group, and window.opener there is null), so no message could pass between them. /move is the
// same editor served without COOP and COEP (vite.config.ts: "/move" detaches both, and move.html is
// never precached), at both addresses: the old address's / sends the student to its /move, whose
// button opens the new address's /move. There the editor runs without SharedArrayBuffer (input is
// typed before a run), so the new tab offers to go on in the isolated editor at / once it is done.
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy
import { MOVE_HASH, MOVE_PATH, moveRole, receiveFiles, sendFiles, type MoveEvent, type PeerWindow, type ReceiveDeps, type ReceiveResult, type SendResult } from "../core/move-protocol";
import { confirmDialog } from "./dialogs";
import { plural } from "./dom";
import type { Notice, NoticeOptions } from "./notice";

/** The largest zip the new address takes: the zip import's own total (src/storage/zip.ts ZIP_LIMITS, a unit test keeps them equal). */
export const MOVE_MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** Dismissing the notice hides it for this browser session (sessionStorage). */
export const DISMISSED_KEY = "codeeditor:move-notice-dismissed";

/** What the editor lends the move (src/ui/workbench.ts). */
export interface MoveApp {
  /** #app: data-move says where the move is (for the tests), data-move-ignored how many messages were ignored. */
  root: HTMLElement;
  notice: Notice;
  canWrite(): boolean;
  /** Why this tab can't write, in one sentence. */
  readOnlyText(): string;
  /** Saves every editor's pending text. */
  flush(): Promise<void>;
  /** The workspace as a .zip Blob (the export's own code, without the download). */
  buildZip(): Promise<{ blob: Blob; count: number }>;
  /** The normal export: the .zip download. */
  downloadZip(): void;
  /** Reads the zip with the import pipeline and returns its file count and the import itself. */
  prepareImport: ReceiveDeps["prepare"];
}

const hostOf = (origin: string) => new URL(origin).host;

function listen(handler: (event: MoveEvent) => void): () => void {
  const onMessage = (e: MessageEvent) => handler({ origin: e.origin, source: e.source, data: e.data });
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

function sessionFlag(key: string, set = false): boolean {
  try {
    if (set) sessionStorage.setItem(key, "1");
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false; // storage blocked: the notice shows on every load
  }
}

/** Starts the part this address plays; `from` and `to` are the build's constants. */
export function startAddressMove(app: MoveApp, from: string = __MOVE_FROM__, to: string = __MOVE_TO__): void {
  const role = moveRole(location.origin, from, to);
  if (role === "from") offerMove(app, to);
  else if (role === "to") takeMove(app, from);
}

// ---------------------------------------------------------------- the old address

function offerMove(app: MoveApp, to: string): void {
  if (sessionFlag(DISMISSED_KEY)) return;
  const host = hostOf(to);
  const link = { label: `Open ${host}`, href: `${to}/` };
  const say = (text: string, options: NoticeOptions) => app.notice.show(text, { link, ...options });
  const again = { label: "Try again", run: () => void move() };
  const download = { label: "Download .zip", run: () => app.downloadZip() };
  // Here (at /move) the button opens the new address; at / it first comes here (see the top).
  const isolated = globalThis.crossOriginIsolated === true;
  say(isolated ? `ExecFlow has a new address: ${host}. Move your files there.` : `ExecFlow has a new address: ${host}. Press Move my files to copy your files there in a new tab.`, {
    tone: "info",
    action: { label: "Move my files", run: () => void move() },
    pin: { key: "address-move", onDismiss: () => sessionFlag(DISMISSED_KEY, true) },
  });

  async function move() {
    if (globalThis.crossOriginIsolated === true) {
      app.root.dataset.move = "leaving";
      await app.flush().catch(() => {});
      location.assign(MOVE_PATH);
      return;
    }
    app.root.dataset.move = "opening";
    const result = await sendFiles({
      to,
      // Not "noopener": with it, window.open returns null and the new tab has no window.opener, so
      // neither side could post to the other. The new tab is this site's own fixed address (a
      // build-time constant, never input), and each side takes messages only from that exact origin
      // AND that exact window (move-protocol.ts fromPeer).
      open: (url) => window.open(url, "_blank") as PeerWindow | null,
      listen,
      buildZip: async () => {
        await app.flush();
        return app.buildZip();
      },
      onState: (s) => (app.root.dataset.move = s),
    });
    report(result);
  }

  function report(result: SendResult) {
    app.root.dataset.move = result.kind === "refused" ? `refused-${result.reason}` : result.kind;
    switch (result.kind) {
      case "done":
        return say(
          `Your files are at ${host} now: ${plural(result.added, "file")} added${result.skipped ? `, ${result.skipped} left out (a file with that name was already there, or it couldn't be added)` : ""}. They stay here too.`,
          { tone: "success" },
        );
      case "blocked":
        return say(`The browser blocked the new tab. Allow pop-ups for this site and try again, or download your files as a .zip and import them at ${host}.`, { tone: "warning", action: download });
      case "closed":
        return say("The new tab closed before your files arrived. Nothing was moved.", { tone: "warning", action: again });
      case "timeout":
        return say(`${host} didn't answer in time. If your files aren't there, try again, or download them as a .zip and import them there.`, { tone: "warning", action: download });
      case "failed":
        return say(`Your files couldn't be packed (${result.reason}). Nothing was moved.`, { tone: "error", action: download });
      case "refused":
        if (result.reason === "declined") return say("Nothing was moved: the new tab was told not to add the files.", { tone: "info", action: again });
        if (result.reason === "read-only")
          return say(`Nothing was moved: ExecFlow is open for editing in another tab at ${host}. Use that tab: close it (or choose Edit here in the new tab), then press Try again.`, { tone: "warning", action: again });
        return say(`${host} couldn't read the files, so nothing was moved. Download them as a .zip instead.`, { tone: "error", action: download });
    }
  }
}

// ---------------------------------------------------------------- the new address

function takeMove(app: MoveApp, from: string): void {
  // Without an opener (a bookmark, a typed address, a link with noopener) there is no one to take
  // files from: nothing happens at all.
  const opener = window.opener as PeerWindow | null;
  if (location.hash !== MOVE_HASH || !opener) return;
  // The marker leaves the address bar: a reload or a bookmark never asks for files again.
  history.replaceState(history.state, "", location.pathname + location.search);
  const oldHost = hostOf(from);
  const home = { label: "Open the editor", run: () => location.assign("/") };
  void receiveFiles({
    from,
    opener,
    listen,
    canWrite: () => app.canWrite(),
    maxBytes: MOVE_MAX_ZIP_BYTES,
    prepare: (zip) => app.prepareImport(zip),
    confirm: (count) =>
      confirmDialog({
        title: `Add ${plural(count, "file")} from your old ExecFlow?`,
        body: [`They come from ${oldHost}, ExecFlow's old address, and stay there too. A file whose name is already used here is left out; nothing here is replaced.`],
        confirm: "Add files",
        cancel: "Not now",
      }),
    onState: (s) => (app.root.dataset.move = s),
    onIgnored: (n) => (app.root.dataset.moveIgnored = String(n)),
  })
    // However it ended, this tab lets go of the old one: the student may keep working here, and a
    // site visited later in this tab must not be able to navigate the old tab (reverse tabnabbing).
    .finally(() => {
      window.opener = null;
    })
    .then((result: ReceiveResult) => {
    app.root.dataset.move = result.kind === "refused" ? `refused-${result.reason}` : result.kind;
    switch (result.kind) {
      case "done":
        return app.notice.show(`Added ${plural(result.added, "file")} from ${oldHost}.${result.skipped ? ` Left out ${result.skipped}: a file with that name was already here, or it couldn't be added.` : ""}`, { tone: "success", action: home });
      case "refused":
        if (result.reason === "read-only") return app.notice.show(`${app.readOnlyText()} Your files weren't added here: use the editing tab (close it, or choose Edit here), then press Try again at ${oldHost}.`, { tone: "warning" });
        if (result.reason === "declined") return app.notice.show("Nothing was added.", { tone: "info", action: home });
        return app.notice.show(`The files from ${oldHost} couldn't be read, so nothing was added.`, { tone: "error" });
      case "timeout":
        return app.notice.show(`No files arrived from ${oldHost}.`, { tone: "info", action: home });
      case "failed":
        return app.notice.show(`The files from ${oldHost} couldn't be added (${result.reason}).`, { tone: "error" });
    }
  });
}
