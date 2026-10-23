import {
  acceptCompletion, clearSnippet, closeCompletion, completionKeymap, deleteBracketPair, nextSnippetField, prevSnippetField, snippetKeymap, startCompletion,
} from "@codemirror/autocomplete";
import * as commands from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { nextDiagnostic, openLintPanel } from "@codemirror/lint";
import * as search from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { isMenuKey } from "../core/code-menu";
import { APP_KEYS, BASE, ESCAPE_KEY } from "../editor/extensions";
import { keyParts, paletteKey, shortcutGroups, shortcutKeys } from "./shortcuts";

const rows = (mac: boolean) => new Map(shortcutGroups(mac).flatMap((g) => g.rows.map(([keys, what]) => [what, keys] as const)));

describe("shortcutGroups", () => {
  it.each([false, true])("lists the suggestion keys (mac: %s)", (mac) => {
    const r = rows(mac);
    expect(r.get("Show suggestions")).toBe("Ctrl Space");
    // Nothing is picked when the list opens (selectOnOpen: false): an arrow key picks, then Enter.
    expect(r.get("Pick a suggestion")).toBe("Down or Up");
    expect(r.get("Accept the picked suggestion")).toBe("Enter");
    expect(r.has("Accept a suggestion")).toBe(false);
    // In Tab-moves-focus mode (Ctrl M) Tab leaves the editor even inside a snippet: the row says so
    // (research doc section 3; review RB-8).
    expect(r.get("Next or previous field in a snippet (not in Tab-moves-focus mode)")).toBe("Tab or Shift Tab");
    expect(r.get("Close the list, or end the snippet")).toBe("Esc");
    expect(r.get("Leave the editor (Tab alone indents; Esc again if it closed something)")).toBe("Esc then Tab");
    expect([...r.values()].includes("Alt `")).toBe(mac);
  });

  const CODE_MENU = "Menu for the selected code: Capture snippet (an image of the lines), Cut, Copy, Select all";
  const BROWSER_MENU = "The browser's own menu for the selected code";

  it("lists the code menu's keys: Shift F10 or Menu, and Shift F10 again for the browser's menu (not macOS)", () => {
    const editor = (mac: boolean) => shortcutGroups(mac).find((g) => g.title === "Editor")!.rows;
    expect(editor(false).slice(0, 3)).toEqual([
      ["Esc then Tab", "Leave the editor (Tab alone indents; Esc again if it closed something)"],
      ["Shift F10 or Menu", CODE_MENU],
      ["Shift F10 then Shift F10", BROWSER_MENU],
    ]);
    // macOS has no browser keyboard menu: one row, and no Menu key.
    expect(editor(true).slice(0, 2)).toEqual([["Esc then Tab", "Leave the editor (Tab alone indents; Esc again if it closed something)"], ["Shift F10", CODE_MENU]]);
    expect(editor(true).some(([, what]) => what === BROWSER_MENU)).toBe(false);
    // Shift F10 has three meanings: the Files row says where its own applies.
    for (const mac of [false, true]) {
      const files = shortcutGroups(mac).find((g) => g.title === "Files")!.rows;
      expect(files).toContainEqual(["Shift F10", "More actions for the chosen file (in the list)"]);
      expect(files.some(([, what]) => what === "More actions for the chosen file")).toBe(false);
    }
  });

  it("every key listed for the code menu really opens it (isMenuKey)", () => {
    const KEYS: Record<string, string> = { Menu: "ContextMenu" };
    const event = (caps: string[]) => ({
      key: KEYS[caps.at(-1)!] ?? caps.at(-1)!,
      shiftKey: caps.includes("Shift"), ctrlKey: caps.includes("Ctrl"), altKey: caps.includes("Alt"), metaKey: caps.includes("Cmd"), repeat: false,
    });
    for (const mac of [false, true]) {
      const rows = shortcutGroups(mac).flatMap((g) => g.rows).filter(([, what]) => what === CODE_MENU || what === BROWSER_MENU);
      expect(rows.length).toBe(mac ? 1 : 2);
      for (const [keys] of rows) {
        const combos = keyParts(keys).flatMap((p) => (p.caps ? [p.caps] : []));
        expect(combos.length, keys).toBeGreaterThan(0);
        for (const caps of combos) expect(isMenuKey(event(caps)), `${keys}: ${caps.join(" ")}`).toBe(true);
      }
    }
  });

  it("names the keys CodeMirror really binds (autocomplete 6.20.3)", () => {
    const start = completionKeymap.filter((b) => b.run === startCompletion);
    expect(start.map((b) => b.key ?? `mac ${b.mac}`)).toEqual(["Ctrl-Space", "mac Alt-`", "mac Alt-i"]);
    expect(completionKeymap.find((b) => b.key === "Enter")?.run).toBe(acceptCompletion);
    // Down and Up move the pick (moveCompletionSelection makes a new function per binding).
    expect(completionKeymap.filter((b) => b.key === "ArrowDown" || b.key === "ArrowUp")).toHaveLength(2);
    const snippets = EditorState.create({}).facet(snippetKeymap);
    expect(snippets.find((b) => b.key === "Tab")?.run).toBe(nextSnippetField);
    expect(snippets.find((b) => b.key === "Tab")?.shift).toBe(prevSnippetField);
    expect(snippets.find((b) => b.key === "Escape")?.run).toBe(clearSnippet);
    expect(completionKeymap.find((b) => b.key === "Escape")?.run).toBe(closeCompletion);
  });
});

// ---------------------------------------------------------------- the editor's keymaps against the list

/** A key as the list spells it: modifiers (any order) and the key. */
function combo(mods: string[], key: string): string {
  return `${[...new Set(mods)].sort().join("+")}|${key}`;
}

const BASE_NAMES: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc", " ": "Space" };

/** CodeMirror's "Mod-Alt-g" as the list spells it on this platform ("Ctrl Alt G"); split as CodeMirror does (view 6.43.14 normalizeKeyName). */
function fromCodeMirror(name: string, mac: boolean): string {
  const parts = name.split(/-(?!$)/);
  const last = parts.pop()!;
  const MODS: Record<string, string> = { Mod: mac ? "Cmd" : "Ctrl", Cmd: "Cmd", Meta: "Cmd", Ctrl: "Ctrl", Control: "Ctrl", Alt: "Alt", Shift: "Shift" };
  const key = BASE_NAMES[last] ?? (last.length === 1 ? last.toUpperCase() : last);
  return combo(parts.map((p) => MODS[p] ?? p), key);
}

/** Every key combination a row's keys name ("F3 or Ctrl G" is two; "Esc then Tab" two steps). */
function rowCombos(keys: string): string[] {
  const MOD_WORDS = new Set(["Ctrl", "Cmd", "Alt", "Shift"]);
  return keyParts(keys).flatMap((p) => (p.caps ? [combo(p.caps.filter((c) => MOD_WORDS.has(c)), p.caps.filter((c) => !MOD_WORDS.has(c)).join(" "))] : []));
}

/** Every binding the editor's keymaps hold on this platform (the shift variants as their own binding). */
function editorBindings(mac: boolean): { key: string; run: Command }[] {
  const out: { key: string; run: Command }[] = [];
  for (const group of EditorState.create({ extensions: BASE }).facet(keymap)) {
    for (const b of group) {
      const key = mac ? (b.mac ?? b.key) : (b.win ?? b.key);
      if (!key) continue;
      if (b.run) out.push({ key, run: b.run });
      if (b.shift) out.push({ key: `Shift-${key}`, run: b.shift });
    }
  }
  return out;
}

const fn = (name: string) => {
  const f = (commands as unknown as Record<string, Command>)[name] ?? (search as unknown as Record<string, Command>)[name];
  if (!f) throw new Error(`no command ${name}`);
  return f;
};
const completionMove = (key: string) => completionKeymap.find((b) => b.key === key)!.run!;

/**
 * Each command the list names, with its row's description. A binding with Shift whose row says
 * "with Shift" in words (findPrevious) is matched without the Shift.
 */
const LABELLED = new Map<Command, { row: string; shiftInWords?: boolean }>([
  [APP_KEYS[0].run!, { row: "Run the open file" }],
  [APP_KEYS[1].run!, { row: "Save now (and sync, once GitHub is connected)" }],
  [fn("openSearchPanel"), { row: "Find or replace in the file" }],
  [fn("findNext"), { row: "Next match (with Shift, the previous one)" }],
  [fn("findPrevious"), { row: "Next match (with Shift, the previous one)", shiftInWords: true }],
  [fn("gotoLine"), { row: "Go to a line" }],
  [fn("selectNextOccurrence"), { row: "Select the next match of the selection too" }],
  [fn("selectSelectionMatches"), { row: "Select every match of the selection" }],
  [fn("addCursorAbove"), { row: "Add a cursor on the line above or below" }],
  [fn("addCursorBelow"), { row: "Add a cursor on the line above or below" }],
  [fn("moveLineUp"), { row: "Move the line up or down" }],
  [fn("moveLineDown"), { row: "Move the line up or down" }],
  [fn("toggleComment"), { row: "Comment or uncomment the line" }],
  [foldCode, { row: "Fold or unfold the block at the cursor" }],
  [unfoldCode, { row: "Fold or unfold the block at the cursor" }],
  [foldAll, { row: "Fold or unfold every block" }],
  [unfoldAll, { row: "Fold or unfold every block" }],
  [nextDiagnostic, { row: "Go to the next problem in the file" }],
  [fn("undo"), { row: "Undo" }],
  [fn("redo"), { row: "Redo" }],
  [fn("toggleTabFocusMode"), { row: "Turn Tab-moves-focus on or off" }],
  [startCompletion, { row: "Show suggestions" }],
  [acceptCompletion, { row: "Accept the picked suggestion" }],
  [completionMove("ArrowDown"), { row: "Pick a suggestion" }],
  [completionMove("ArrowUp"), { row: "Pick a suggestion" }],
  [closeCompletion, { row: "Close the list, or end the snippet" }],
  [ESCAPE_KEY.run!, { row: "Close the list, or end the snippet" }],
]);

/** Bindings the list leaves out on purpose, each with its reason. */
const UNLISTED = new Map<Command, string>([
  // The keys every text field has: moving, selecting, deleting, a new line.
  ...[
    "cursorCharLeft", "selectCharLeft", "cursorCharRight", "selectCharRight", "cursorGroupLeft", "selectGroupLeft", "cursorGroupRight", "selectGroupRight",
    "cursorLineBoundaryLeft", "selectLineBoundaryLeft", "cursorLineBoundaryRight", "selectLineBoundaryRight", "cursorLineUp", "selectLineUp", "cursorLineDown",
    "selectLineDown", "cursorDocStart", "selectDocStart", "cursorDocEnd", "selectDocEnd", "cursorPageUp", "selectPageUp", "cursorPageDown", "selectPageDown",
    "cursorLineBoundaryBackward", "selectLineBoundaryBackward", "cursorLineBoundaryForward", "selectLineBoundaryForward", "insertNewlineAndIndent", "selectAll",
    "deleteCharBackward", "deleteCharForward", "deleteGroupBackward", "deleteGroupForward", "deleteLineBoundaryBackward", "deleteLineBoundaryForward",
    "cursorLineStart", "selectLineStart", "cursorLineEnd", "selectLineEnd", "deleteToLineEnd", "splitLine", "transposeChars", "simplifySelection",
  ].map((n) => [fn(n), "a key every text field has"] as const),
  // Past a first course: still there, not taught here (Hick's law: the list stays short).
  ...[
    "undoSelection", "redoSelection", "cursorSyntaxLeft", "selectSyntaxLeft", "cursorSyntaxRight", "selectSyntaxRight", "copyLineUp", "copyLineDown",
    "selectLine", "selectParentSyntax", "indentLess", "indentMore", "indentSelection", "deleteLine", "cursorMatchingBracket", "toggleBlockComment",
  ].map((n) => [fn(n), "a more advanced editing key"] as const),
  [fn("insertBlankLine"), "Mod-Enter is Run (APP_KEYS, higher precedence)"],
  [fn("closeSearchPanel"), "Escape closes the find panel, as it closes everything"],
  [openLintPanel, "the editor's own copy of the Problems list; the app's Problems panel is the one taught"],
  [completionMove("PageDown"), "moves the pick a page: a list key"],
  [completionMove("PageUp"), "moves the pick a page: a list key"],
  [deleteBracketPair, "Backspace: a key every text field has"],
]);

/** One binding of a listed command left out on purpose: macOS's second spelling of Show suggestions. */
const UNLISTED_KEYS = new Set(["mac:Alt-i"]);

describe("the Shortcuts list and the editor's keymaps (CodeMirror's installed bindings)", () => {
  it.each([false, true])("every bound command is listed under its own keys, or left out with a reason (mac: %s)", (mac) => {
    const rows = shortcutGroups(mac).flatMap((g) => g.rows);
    const problems: string[] = [];
    for (const { key, run } of editorBindings(mac)) {
      const label = LABELLED.get(run);
      if (!label) {
        if (!UNLISTED.has(run) && !UNLISTED_KEYS.has(`${mac ? "mac" : "win"}:${key}`)) problems.push(`${key}: not classified`);
        continue;
      }
      if (UNLISTED_KEYS.has(`${mac ? "mac" : "win"}:${key}`)) continue;
      const matching = rows.filter(([, what]) => what === label.row || (label.row === "Show suggestions" && what.startsWith("Show suggestions")));
      if (!matching.length) {
        problems.push(`${key}: no row "${label.row}"`);
        continue;
      }
      const wanted = fromCodeMirror(label.shiftInWords ? key.replace(/^Shift-/, "") : key, mac);
      if (!matching.some(([keys]) => rowCombos(keys).includes(wanted))) problems.push(`${key}: the row "${label.row}" says ${matching.map(([k]) => k).join(" / ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("names the keys the palette shows in a row of their own", () => {
    for (const mac of [false, true]) {
      const k = shortcutKeys(mac);
      const keys = shortcutGroups(mac).flatMap((g) => g.rows.map(([keys]) => keys));
      expect(keys).toContain(k.search);
      expect(keys).toContain(k.commands);
      expect(keys).toContain(k.shortcuts);
    }
    expect(shortcutKeys(false).commands).toBe("F1 or Ctrl Shift P");
    expect(shortcutKeys(true).search).toBe("Cmd P");
  });
});

describe("paletteKey", () => {
  const key = (k: string, code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
  });

  it("opens on files and commands with Mod+P, on the commands with Mod+Shift+P and F1", () => {
    expect(paletteKey(key("p", "KeyP", { ctrlKey: true }), false)).toBe("all");
    expect(paletteKey(key("P", "KeyP", { ctrlKey: true, shiftKey: true }), false)).toBe("commands");
    expect(paletteKey(key("p", "KeyP", { metaKey: true }), true)).toBe("all");
    expect(paletteKey(key("F1", "F1"), false)).toBe("commands");
    // Colemak types P on another position: the letter counts, not the place.
    expect(paletteKey(key("p", "KeyR", { ctrlKey: true }), false)).toBe("all");
  });

  it("keeps the browser's keys: Dvorak's Ctrl+L on the P position, other modifiers, F1 with one", () => {
    expect(paletteKey(key("l", "KeyP", { ctrlKey: true }), false)).toBeNull();
    expect(paletteKey(key("p", "KeyP", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(paletteKey(key("p", "KeyP", { metaKey: true }), false)).toBeNull();
    expect(paletteKey(key("p", "KeyP", { ctrlKey: true }), true)).toBeNull();
    expect(paletteKey(key("p", "KeyP")), "no modifier").toBeNull();
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) expect(paletteKey(key("F1", "F1", { [mod]: true }), false), mod).toBeNull();
  });

  it("falls back to the P position only for a key that types no Latin letter (a Russian layout)", () => {
    const ze = String.fromCodePoint(0x437);
    expect(paletteKey(key(ze, "KeyP", { ctrlKey: true }), false)).toBe("all");
    expect(paletteKey(key(ze.toUpperCase(), "KeyP", { ctrlKey: true, shiftKey: true }), false)).toBe("commands");
    expect(paletteKey(key(ze, "KeyL", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("keyParts", () => {
  it("draws keys as keycaps and keeps 'then' and 'or' as words between them", () => {
    expect(keyParts("Ctrl Shift E")).toEqual([{ caps: ["Ctrl", "Shift", "E"] }]);
    expect(keyParts("Esc then Tab")).toEqual([{ caps: ["Esc"] }, { word: " then " }, { caps: ["Tab"] }]);
    expect(keyParts("Down or Up")).toEqual([{ caps: ["Down"] }, { word: " or " }, { caps: ["Up"] }]);
  });

  it("every row's keys are keycaps and joining words only", () => {
    for (const mac of [false, true]) {
      for (const g of shortcutGroups(mac)) {
        for (const [keys] of g.rows) {
          const caps = keyParts(keys).flatMap((p) => p.caps ?? []);
          expect(caps.length, keys).toBeGreaterThan(0);
          expect(caps.filter((k) => k === "" || k === "then" || k === "or"), keys).toEqual([]);
        }
      }
    }
  });
});
