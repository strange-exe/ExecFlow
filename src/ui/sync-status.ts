// The sync status in the top bar: one button with an icon AND words for every state (status is
// never colour alone), whose action fits the state ("Sync now", "Connect GitHub").
// Shared by the shell (sync-entry.ts, before src/sync has loaded) and the sync screens.
import { plural } from "./dom";

export type SyncPhase =
  | "not-connected"
  | "needs-token"
  | "synced"
  | "unsynced"
  | "syncing"
  | "failed"
  | "waiting"
  | "offline"
  | "needs-choice";

export type StatusIcon =
  | "cloud-slash"
  | "cloud-check"
  | "cloud-arrow-up"
  | "arrow-clockwise"
  | "warning-circle"
  | "key"
  | "clock-countdown"
  | "wifi-slash"
  | "git-merge";

/** The icon's colour role (sync.css): "info" is unsynced work, an icon-only mark. */
export type StatusTone = "muted" | "success" | "info" | "warning" | "danger";

export interface StatusInput {
  phase: SyncPhase;
  /** Files changed, added or deleted here since the last sync. */
  unsynced: number;
  lastSyncAt: number | null;
  /** failed, waiting, needs-token: one plain sentence (explainError). */
  error?: string | null;
  /** waiting: when the next try starts. */
  retryAt?: number | null;
  now: number;
  /** needs-token: "app" connections sign in again instead of pasting a token. */
  auth?: "pat" | "app";
}

export interface StatusView {
  phase: SyncPhase;
  icon: StatusIcon;
  words: string;
  /** What pressing the status button does. */
  action: string;
  tone: StatusTone;
  /** A sentence for the name and tooltip only (the save state: sync status is shown once, here). */
  note?: string;
}

/** "just now", "4 min ago", "2 hours ago", "3 days ago". */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, now - then) / 1000;
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

/** "45 s", "2 min". */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

export function describeStatus(s: StatusInput): StatusView {
  const view = (icon: StatusIcon, words: string, action: string, tone: StatusTone): StatusView => ({ phase: s.phase, icon, words, action, tone });
  switch (s.phase) {
    case "not-connected":
      return { ...view("cloud-slash", "Not connected", "Connect GitHub", "muted"), note: "Your files are saved on this computer." };
    case "needs-token":
      if (s.auth === "app") return view("key", "Sign in again", "Sign in with GitHub to sync", "warning");
      return view("key", s.error ? "Token not accepted: enter a new one" : "Enter token to sync", "Enter your GitHub token", "warning");
    case "synced":
      return view("cloud-check", s.lastSyncAt === null ? "Not synced yet" : `Synced ${ago(s.lastSyncAt, s.now)}`, "Sync now", "success");
    case "unsynced":
      return view("cloud-arrow-up", plural(s.unsynced, "unsynced change"), "Sync now", "info");
    case "syncing":
      return view("arrow-clockwise", "Syncing...", "Syncing", "muted");
    case "failed":
      return view("warning-circle", `Sync failed: ${s.error ?? "try again."}`, "Try again", "danger");
    case "waiting":
      return view("clock-countdown", `Sync failed: retrying in ${countdown((s.retryAt ?? s.now) - s.now)}`, "Try now", "warning");
    case "offline":
      return view("wifi-slash", "Offline: changes are saved here and will sync later", "Try now", "warning");
    case "needs-choice":
      return view("git-merge", "Choose how to sync", "Choose how to combine the files", "warning");
  }
}

/**
 * Draws a view into the status button. The accessible name starts with the visible words (label in
 * name) and then says what the button does; the same text is the tooltip, so words cut short by
 * the narrow top bar can still be read in full.
 */
export function renderStatus(button: HTMLButtonElement, view: StatusView, iconFor: (name: StatusIcon) => SVGElement): void {
  button.dataset.syncState = view.phase;
  button.dataset.tone = view.tone;
  const label = `${view.words}${/[.:]$/.test(view.words) ? "" : "."} ${view.note ? `${view.note} ` : ""}${view.action}`;
  button.setAttribute("aria-label", label);
  button.title = view.phase === "syncing" ? view.words : label;
  // Unchanged content isn't redrawn (the status re-renders on a timer and when the screens load).
  const drawn = `${view.icon}|${view.words}`;
  if (button.dataset.drawn === drawn) return;
  button.dataset.drawn = drawn;
  // "Sync failed: <why>": narrow top bars show only the part before the colon (the start of the
  // accessible name, so the visible label is still in it); the rest is in the name and the tooltip.
  const words = document.createElement("span");
  words.className = "sync-words";
  const cut = view.words.indexOf(": ");
  const head = document.createElement("span");
  head.className = "sync-head";
  head.textContent = cut < 0 ? view.words : view.words.slice(0, cut);
  words.append(head);
  if (cut >= 0) {
    const tail = document.createElement("span");
    tail.className = "sync-tail";
    tail.textContent = view.words.slice(cut);
    words.append(tail);
  }
  button.replaceChildren(iconFor(view.icon), words);
}
