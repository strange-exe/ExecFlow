// The command palette's keys, on their own so the window's key handler (workbench.ts) can read them on
// a first visit without loading the Shortcuts list, which is a chunk of its own (shortcuts.ts, opened
// on demand; it re-exports this for the palette and its tests).
import { isMac } from "./dom";

/**
 * The command palette's keys (vscode.dev's): F1 and Mod+Shift+P on the commands, Mod+P on files and
 * commands; null for any other key. P is the letter the layout types, so Dvorak's Ctrl+L (typed on
 * the P position) stays the browser's; only a key that types no Latin letter (a Russian layout)
 * falls back to the physical P position.
 */
export function paletteKey(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  mac = isMac(),
): "all" | "commands" | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (e.key === "F1") return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey ? "commands" : null;
  if (!mod || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const p = key === "p" || (!/^[a-z]$/.test(key) && e.code === "KeyP");
  return p ? (e.shiftKey ? "commands" : "all") : null;
}
