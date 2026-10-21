import {
  acceptCompletion, clearSnippet, closeCompletion, completionKeymap, nextSnippetField, prevSnippetField, snippetKeymap, startCompletion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { isMenuKey } from "../core/code-menu";
import { keyParts, shortcutGroups } from "./shortcuts";

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
    expect(r.get("Leave the editor (Tab alone indents)")).toBe("Esc then Tab");
    expect([...r.values()].includes("Alt `")).toBe(mac);
  });

  const CODE_MENU = "Menu for the selected code: Capture snippet (an image of the lines), Cut, Copy, Select all";
  const BROWSER_MENU = "The browser's own menu for the selected code";

  it("lists the code menu's keys: Shift F10 or Menu, and Shift F10 again for the browser's menu (not macOS)", () => {
    const editor = (mac: boolean) => shortcutGroups(mac).find((g) => g.title === "Editor")!.rows;
    expect(editor(false).slice(0, 3)).toEqual([
      ["Esc then Tab", "Leave the editor (Tab alone indents)"],
      ["Shift F10 or Menu", CODE_MENU],
      ["Shift F10 then Shift F10", BROWSER_MENU],
    ]);
    // macOS has no browser keyboard menu: one row, and no Menu key.
    expect(editor(true).slice(0, 2)).toEqual([["Esc then Tab", "Leave the editor (Tab alone indents)"], ["Shift F10", CODE_MENU]]);
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
