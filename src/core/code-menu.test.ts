import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  actionGate, clearsPressRecord, codeMenuHint, codeMenuItems, codeMenuMessage, coversLine, insideAny, isMenuKey, isSecondaryPress, menuDecision,
  type CodeMenuResult, type MenuRequest,
} from "./code-menu";

const range = (from: number, to: number) => ({ from, to, empty: from === to });

describe("menuDecision (final-v3 section 2.3.2)", () => {
  // A pointer request on the code text inside a non-empty range: the code menu.
  const base: MenuRequest = {
    hasView: true, via: "pointer", pointerType: "mouse", shift: false, again: false, place: "content", inside: true, anySelected: true, focusInContent: true,
  };
  const keyboard: MenuRequest = { ...base, via: "keyboard", pointerType: "", place: "other", inside: false };
  it.each([
    ["pointer mouse inside a range on the code", base, "app"],
    ["outside every range (one past an end)", { ...base, inside: false }, "browser"],
    ["on a covered line number", { ...base, place: "line-number" }, "app"],
    ["on an uncovered line number", { ...base, place: "line-number", inside: false }, "browser"],
    ["place other (the lint gutter)", { ...base, place: "other" }, "browser"],
    ["no non-empty range", { ...base, anySelected: false }, "browser"],
    ["touch", { ...base, pointerType: "touch" }, "browser"],
    ["pen", { ...base, pointerType: "pen" }, "browser"],
    ["keyboard via with pointerType touch (rule 2 whatever via is)", { ...keyboard, pointerType: "touch" }, "browser"],
    ["Shift with a pointer", { ...base, shift: true }, "browser"],
    ["Shift with the keyboard (Shift+F10)", { ...keyboard, shift: true }, "app"],
    ["again (pointer)", { ...base, again: true }, "browser"],
    ["again (keyboard)", { ...keyboard, again: true }, "browser"],
    ["keyboard, a non-empty range, focus in the content", keyboard, "app"],
    ["keyboard, no range", { ...keyboard, anySelected: false }, "browser"],
    ["keyboard, focus elsewhere", { ...keyboard, focusInContent: false }, "browser"],
    ["no view", { ...base, hasView: false }, "browser"],
  ] as [string, MenuRequest, string][])("%s: %s", (_, request, expected) => {
    expect(menuDecision(request)).toBe(expected);
  });
});

describe("insideAny and coversLine", () => {
  it("insideAny: ends inclusive, empty ranges never count, any range counts", () => {
    const ranges = [range(2, 4), range(7, 7), range(9, 12)];
    expect(insideAny(2, ranges)).toBe(true);
    expect(insideAny(4, ranges)).toBe(true);
    expect(insideAny(5, ranges)).toBe(false);
    expect(insideAny(1, ranges)).toBe(false);
    expect(insideAny(7, ranges)).toBe(false);
    expect(insideAny(10, ranges)).toBe(true);
    expect(insideAny(13, ranges)).toBe(false);
  });

  it("coversLine over the pickLines doc", () => {
    const doc = EditorState.create({ doc: "a\nbb\n\nccc\n" }).doc;
    const line = (n: number) => doc.line(n);
    expect([1, 2, 3, 4].map((n) => coversLine(line(n), [range(0, 6)]))).toEqual([true, true, true, false]);
    expect([1, 2, 3, 4].map((n) => coversLine(line(n), [range(3, 7)]))).toEqual([false, true, true, true]);
    expect([1, 2, 3, 4, 5].map((n) => coversLine(line(n), [range(5, 5)]))).toEqual([false, false, false, false, false]);
    // The blank line 3 inside 3 to 7 is covered.
    expect(coversLine(line(3), [range(3, 7)])).toBe(true);
  });
});

describe("event tests", () => {
  const press = (button: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({ button, ctrlKey: false, shiftKey: false, ...mods });
  it("isSecondaryPress", () => {
    for (const mac of [false, true]) {
      expect(isSecondaryPress(press(2), mac)).toBe(true);
      expect(isSecondaryPress(press(2, { shiftKey: true }), mac), "the press guard covers Shift").toBe(true);
      expect(isSecondaryPress(press(0), mac)).toBe(false);
      expect(isSecondaryPress(press(1), mac)).toBe(false);
    }
    expect(isSecondaryPress(press(0, { ctrlKey: true }), true)).toBe(true);
    expect(isSecondaryPress(press(0, { ctrlKey: true }), false)).toBe(false);
  });

  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({
    key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
  });
  it("isMenuKey", () => {
    expect(isMenuKey(key("F10", { shiftKey: true }))).toBe(true);
    expect(isMenuKey(key("ContextMenu"))).toBe(true);
    expect(isMenuKey(key("F10"))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, altKey: true }))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, metaKey: true }))).toBe(false);
    expect(isMenuKey(key("ContextMenu", { shiftKey: true }))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, repeat: true }))).toBe(false);
    expect(isMenuKey(key("ContextMenu", { repeat: true }))).toBe(false);
  });

  it("clearsPressRecord: modifier keydowns keep the record", () => {
    for (const k of ["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn"]) expect(clearsPressRecord({ key: k }), k).toBe(false);
    for (const k of ["F10", "ContextMenu", "a", "Enter"]) expect(clearsPressRecord({ key: k }), k).toBe(true);
  });
});

describe("codeMenuItems", () => {
  it.each([false, true])("labels, icons, order, one separator, keycaps, nothing disabled (mac: %s)", (mac) => {
    const items = codeMenuItems({ mac, label: "Capture snippet of lines 2 to 3...", paste: false });
    const mod = mac ? "Cmd" : "Ctrl";
    expect(items.map((i) => [i.kind, i.label, i.icon, i.keycap ?? null])).toEqual([
      ["capture", "Capture snippet of lines 2 to 3...", "image", null],
      ["cut", "Cut", "scissors", `${mod} X`],
      ["copy", "Copy", "copy", `${mod} C`],
      ["select-all", "Select all", "selection-all", `${mod} A`],
    ]);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.kind)).toEqual(["cut"]);
    for (const item of items) expect(item).not.toHaveProperty("disabled");
  });

  it("with Paste kept: between Copy and Select all", () => {
    const items = codeMenuItems({ mac: false, label: "Capture snippet of line 7...", paste: true });
    expect(items.map((i) => i.kind)).toEqual(["capture", "cut", "copy", "paste", "select-all"]);
    expect(items[3]).toMatchObject({ label: "Paste", icon: "clipboard-text", keycap: "Ctrl V" });
  });
});

describe("codeMenuHint", () => {
  it("teaches the way back to the browser's menu", () => {
    for (const mac of [false, true]) expect(codeMenuHint("pointer", mac)).toBe("Shift+right-click for the browser's menu");
    expect(codeMenuHint("keyboard", false)).toBe("Press Shift+F10 again for the browser's menu");
    expect(codeMenuHint("keyboard", true)).toBeNull();
  });
});

describe("codeMenuMessage (final-v3 sections 6.3 and 2.3.10, string for string)", () => {
  it.each([false, true])("mac: %s", (mac) => {
    const mod = mac ? "Cmd" : "Ctrl";
    const expected: Record<CodeMenuResult, string | null> = {
      "read-only-tab": null,
      "read-only-file": "This file can't be changed right now.",
      stale: "The code changed while the menu was open, so nothing was done.",
      "copy-failed": `Couldn't copy from the menu. Press ${mod}+C to copy.`,
      "cut-failed": `Couldn't cut from the menu. Press ${mod}+X to cut.`,
      copied: null,
      cut: null,
      selected: null,
      capture: null,
      "paste-unavailable": `Press ${mod}+V to paste here.`,
      "paste-blocked": `This browser blocks pasting from menus on this site. Press ${mod}+V to paste here, or allow Clipboard in the site settings.`,
      "paste-waiting": `If the browser asks, choose Paste or Allow (its Paste menu may open by the mouse pointer). Or press ${mod}+V to paste here.`,
      "paste-refused": `The browser didn't share the clipboard. Press ${mod}+V to paste here.`,
      "paste-empty": "The clipboard has no text to paste.",
      "paste-stale": `The code changed before the clipboard was read, so nothing was pasted. Press ${mod}+V to paste here.`,
      pasted: null,
    };
    for (const [result, text] of Object.entries(expected)) expect(codeMenuMessage(result as CodeMenuResult, { mac }), result).toBe(text);
  });
});

describe("actionGate", () => {
  const view = {};
  const otherView = {};
  const make = (doc: string, ranges: [number, number][], readOnly = false) =>
    EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b))),
      extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
    });
  const state = make("one\ntwo\n", [[0, 3]]);
  const opened = { view, fileId: "f1", doc: state.doc, selection: state.selection };
  const now = (s: EditorState | null, over: Partial<{ view: object; fileId: string | null }> = {}) => ({ view, fileId: "f1", state: s, ...over });

  it("is stale when the view, the file, the doc or the selection differ (each alone)", () => {
    expect(actionGate(opened, now(state, { view: otherView }), "copy", true)).toBe("stale");
    expect(actionGate(opened, now(state, { fileId: "f2" }), "copy", true)).toBe("stale");
    expect(actionGate(opened, now(state.update({ changes: { from: 0, insert: "x" } }).state), "copy", true)).toBe("stale");
    expect(actionGate(opened, now(state.update({ selection: EditorSelection.single(0, 2) }).state), "copy", true)).toBe("stale");
    expect(actionGate(opened, now(null), "copy", true)).toBe("stale");
    expect(actionGate(opened, now(state), "copy", true)).toBe("ok");
  });

  it("checks read-only for Cut only, at the click", () => {
    expect(actionGate(opened, now(state), "cut", false)).toBe("read-only-tab");
    const locked = make("one\ntwo\n", [[0, 3]], true);
    const openedLocked = { ...opened, doc: locked.doc, selection: locked.selection };
    expect(actionGate(openedLocked, now(locked), "cut", true)).toBe("read-only-file");
    for (const kind of ["copy", "select-all", "capture"] as const) {
      expect(actionGate(opened, now(state), kind, false), kind).toBe("ok");
      expect(actionGate(openedLocked, now(locked), kind, true), kind).toBe("ok");
    }
    expect(actionGate(opened, now(state), "paste", false)).toBe("read-only-tab");
  });

  it("gives empty for Copy and Cut when every range is empty", () => {
    const caret = make("one\n", [[1, 1]]);
    const openedCaret = { view, fileId: "f1", doc: caret.doc, selection: caret.selection };
    expect(actionGate(openedCaret, now(caret), "copy", true)).toBe("empty");
    expect(actionGate(openedCaret, now(caret), "cut", true)).toBe("empty");
    expect(actionGate(openedCaret, now(caret), "select-all", true)).toBe("ok");
    expect(actionGate(opened, now(state), "cut", true)).toBe("ok");
  });
});
