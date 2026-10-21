// The editor context menu's pure parts (final-v3 section 2.3): when a right-click or Shift+F10 gets
// the app's code menu instead of the browser's, which events count as what, the items, the hint that
// teaches the way back, the result texts, and the check every item runs at its click. A page can't
// add an item to the browser's own menu (the contextmenu attribute is obsolete), so the code menu
// replaces it, and only on the selection. Type-only CodeMirror imports: this module is in the shell.
import type { EditorSelection, Text } from "@codemirror/state";

export type MenuVia = "pointer" | "keyboard";
/** Where a pointer request landed: the code text, a line-number cell, or anything else (lint marks, panels, tooltips). */
export type MenuPlace = "content" | "line-number" | "other";

export interface MenuRequest {
  /** The active editor view exists. */
  readonly hasView: boolean;
  readonly via: MenuVia;
  /** The event's own pointer type, else the press record's ("" from a key). */
  readonly pointerType: string;
  readonly shift: boolean;
  /** A second request while the code menu is open: the way back to the browser's menu. */
  readonly again: boolean;
  readonly place: MenuPlace;
  /** The pointer is on the selection: inside a non-empty range, or on a covered line number. */
  readonly inside: boolean;
  /** Some range in the active view is non-empty. */
  readonly anySelected: boolean;
  /** Keyboard: focus is on the active view's content. */
  readonly focusInContent: boolean;
}

/** "app": the code menu replaces the browser's; "browser": the event is left alone (final-v3 2.3.2, in order). */
export function menuDecision(r: MenuRequest): "app" | "browser" {
  if (!r.hasView || r.again) return "browser";
  // Touch and pen keep the system's text tools, whatever the request came through (rule 2).
  if (r.pointerType === "touch" || r.pointerType === "pen") return "browser";
  if (r.via === "pointer" && r.shift) return "browser";
  if (!r.anySelected) return "browser";
  if (r.via === "pointer") return r.place !== "other" && r.inside ? "app" : "browser";
  return r.focusInContent ? "app" : "browser";
}

/** The right button, or Ctrl+left-click on macOS (Shift or not: the press guard covers both). */
export function isSecondaryPress(e: { readonly button: number; readonly ctrlKey: boolean }, mac: boolean): boolean {
  return e.button === 2 || (mac && e.button === 0 && e.ctrlKey);
}

interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/** Shift+F10, or the Menu key alone; never a repeat, never with Ctrl, Alt or Meta. */
export function isMenuKey(e: KeyLike): boolean {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return false;
  return (e.key === "F10" && e.shiftKey) || (e.key === "ContextMenu" && !e.shiftKey);
}

const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn"]);

/**
 * A keydown ends the press record unless it is a modifier: on Windows the mouse's contextmenu
 * follows the release, and a held Shift's autorepeat lands between press and release.
 */
export function clearsPressRecord(e: { readonly key: string }): boolean {
  return !MODIFIERS.has(e.key);
}

interface RangeLike {
  readonly from: number;
  readonly to: number;
  readonly empty: boolean;
}

/** `pos` lies in some non-empty range, ends included. */
export function insideAny(pos: number, ranges: readonly RangeLike[]): boolean {
  return ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
}

/** Some non-empty range covers part of the line; a range ending at its column 0 doesn't (the pickLines rule). */
export function coversLine(line: { readonly from: number; readonly to: number }, ranges: readonly RangeLike[]): boolean {
  return ranges.some((r) => !r.empty && r.from <= line.to && r.to > line.from);
}

// ---------------------------------------------------------------- items

export type CodeMenuKind = "capture" | "cut" | "copy" | "paste" | "select-all";
export type CodeMenuIcon = "image" | "scissors" | "copy" | "clipboard-text" | "selection-all";
export interface CodeMenuItem {
  readonly kind: CodeMenuKind;
  readonly label: string;
  readonly icon: CodeMenuIcon;
  /** Shown on the right, like the app's other menus ("Ctrl X"). */
  readonly keycap?: string;
  readonly separatorBefore?: boolean;
}

/** Capture snippet first (the reason the menu exists), then the clipboard group. Every item enabled: each explains on click. */
export function codeMenuItems(o: { mac: boolean; label: string; paste: boolean }): CodeMenuItem[] {
  const mod = o.mac ? "Cmd" : "Ctrl";
  return [
    { kind: "capture", label: o.label, icon: "image" },
    { kind: "cut", label: "Cut", icon: "scissors", keycap: `${mod} X`, separatorBefore: true },
    { kind: "copy", label: "Copy", icon: "copy", keycap: `${mod} C` },
    ...(o.paste ? [{ kind: "paste", label: "Paste", icon: "clipboard-text", keycap: `${mod} V` } as const] : []),
    { kind: "select-all", label: "Select all", icon: "selection-all", keycap: `${mod} A` },
  ];
}

/** The menu's last line: how to reach the browser's own menu (none for the keyboard on macOS, which has no such menu). */
export function codeMenuHint(via: MenuVia, mac: boolean): string | null {
  if (via === "pointer") return "Shift+right-click for the browser's menu";
  return mac ? null : "Press Shift+F10 again for the browser's menu";
}

// ---------------------------------------------------------------- results (final-v3 6.3 and 2.3.10)

export type CodeMenuResult =
  | "read-only-tab" | "read-only-file" | "stale" | "copy-failed" | "cut-failed" | "copied" | "cut" | "selected" | "capture"
  | "paste-unavailable" | "paste-blocked" | "paste-waiting" | "paste-refused" | "paste-empty" | "paste-stale" | "pasted";

/** The notice text of a result, or null (success says nothing, like Ctrl+C; read-only-tab shows explainReadOnly()'s own text). */
export function codeMenuMessage(result: CodeMenuResult, o: { mac: boolean }): string | null {
  const mod = o.mac ? "Cmd" : "Ctrl";
  switch (result) {
    case "read-only-file":
      return "This file can't be changed right now.";
    case "stale":
      return "The code changed while the menu was open, so nothing was done.";
    case "copy-failed":
      return `Couldn't copy from the menu. Press ${mod}+C to copy.`;
    case "cut-failed":
      return `Couldn't cut from the menu. Press ${mod}+X to cut.`;
    case "paste-unavailable":
      return `Press ${mod}+V to paste here.`;
    case "paste-blocked":
      return `This browser blocks pasting from menus on this site. Press ${mod}+V to paste here, or allow Clipboard in the site settings.`;
    case "paste-waiting":
      return `If the browser asks, choose Paste or Allow (its Paste menu may open by the mouse pointer). Or press ${mod}+V to paste here.`;
    case "paste-refused":
      return `The browser didn't share the clipboard. Press ${mod}+V to paste here.`;
    case "paste-empty":
      return "The clipboard has no text to paste.";
    case "paste-stale":
      return `The code changed before the clipboard was read, so nothing was pasted. Press ${mod}+V to paste here.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the check at each click

/** What the menu saw when it opened. */
export interface OpenedRecord {
  readonly view: object;
  readonly fileId: string | null;
  readonly doc: Text;
  readonly selection: EditorSelection;
}
/** What is there at the click. */
export interface GateNow {
  readonly view: object | null;
  readonly fileId: string | null;
  readonly state: { readonly doc: Text; readonly selection: EditorSelection; readonly readOnly: boolean } | null;
}
export type GateResult = "ok" | "stale" | "read-only-tab" | "read-only-file" | "empty";

/**
 * Run by every item at its click (2.3.9): stale when the view, the file, the doc or the selection
 * changed while the menu was open (a sync, a role change); for Cut (and Paste) the read-only checks,
 * at the click; for Copy and Cut, empty when every range is empty (CodeMirror would act on whole
 * lines then).
 */
export function actionGate(opened: OpenedRecord, now: GateNow, kind: CodeMenuKind, canWrite: boolean): GateResult {
  const s = now.state;
  if (!s || now.view !== opened.view || now.fileId !== opened.fileId || !s.doc.eq(opened.doc) || !s.selection.eq(opened.selection)) return "stale";
  if (kind === "cut" || kind === "paste") {
    if (!canWrite) return "read-only-tab";
    if (s.readOnly) return "read-only-file";
  }
  if ((kind === "cut" || kind === "copy") && s.selection.ranges.every((r) => r.empty)) return "empty";
  return "ok";
}
