import {
  acceptCompletion, clearSnippet, closeCompletion, completionKeymap, nextSnippetField, prevSnippetField, snippetKeymap, startCompletion,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
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
