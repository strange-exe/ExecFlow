import { EditorSelection, EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnippetDialogArgs } from "./snippet-dialog";
import { createSnippetCapture, type CaptureDeps, type Entry } from "./snippet-image";

// final-v3 sections 2.1, 5.6, 6.2 and 7.2, with fakes (no DOM in the unit runner).

interface FakeEl { isConnected: boolean; shown: boolean; getClientRects(): { length: number } }
const el = (shown = true): FakeEl => ({ isConnected: true, shown, getClientRects() { return { length: this.shown ? 1 : 0 }; } });

function stateWith(doc: string, ranges: [number, number][]) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b))),
    extensions: EditorState.allowMultipleSelections.of(true),
  });
}
const FIXTURE = "# total of two numbers\ndef add(a, b):\n    return a + b\n\nprint(add(2, 3))\n";
const LINES_2_TO_3 = stateWith(FIXTURE, [[23, 54]]);

function setup(over: { state?: EditorState | null; narrow?: boolean; coarse?: boolean; failImport?: boolean; path?: string | null } = {}) {
  const calls: string[] = [];
  const root = { dataset: {} as Record<string, string | undefined> };
  const notice = { show: vi.fn((text: string) => calls.push(`notice ${text}`)), clear: vi.fn(() => calls.push("notice clear")) };
  const opened: SnippetDialogArgs[] = [];
  let resolveImport: () => void = () => {};
  const load = vi.fn(
    () =>
      new Promise<{ openSnippetDialog(args: SnippetDialogArgs): void }>((resolve, reject) => {
        resolveImport = () => (over.failImport ? reject(new Error("Failed to fetch")) : resolve({ openSnippetDialog: (args) => void opened.push(args) }));
      }),
  );
  const content = el();
  const view = { contentDOM: content, focus: vi.fn(() => calls.push("view focus")) };
  const filesButton = el();
  const fileActions = el();
  const state = over.state === undefined ? LINES_2_TO_3 : over.state;
  const deps: CaptureDeps = {
    root: root as unknown as HTMLElement,
    notice,
    editors: () => ({ activeId: state ? "f1" : null, state: () => state }),
    view: () => (state ? (view as unknown as NonNullable<ReturnType<CaptureDeps["view"]>>) : null),
    fileOf: (id) => (id && over.path !== null ? { path: over.path ?? "src/main.py" } : null),
    narrow: () => over.narrow ?? false,
    closeDrawer: () => calls.push("closeDrawer"),
    filesButton: filesButton as unknown as HTMLElement,
    fileActions: fileActions as unknown as HTMLElement,
    coarse: () => over.coarse ?? false,
    dialogOpen: () => opened.length > 0,
    storage: () => null,
    canCopy: () => true,
    load,
  };
  const capture = createSnippetCapture(deps);
  return { capture, calls, root, notice, opened, load, view, content, filesButton, fileActions, finishImport: () => resolveImport() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSnippetCapture.open (7.2)", () => {
  it("closes the drawer first, then clears the notice", () => {
    const s = setup();
    s.capture.open(el() as unknown as HTMLElement, "menu");
    expect(s.calls.slice(0, 2)).toEqual(["closeDrawer", "notice clear"]);
  });

  it("a refusal never imports the dialog and says why 50 ms later, with its state attributes in the same step", async () => {
    const s = setup({ state: stateWith(FIXTURE, [[3, 3]]) });
    s.capture.open(el() as unknown as HTMLElement, "menu");
    await vi.advanceTimersByTimeAsync(49);
    expect(s.notice.show).not.toHaveBeenCalled();
    expect(s.root.dataset.capture).toBeUndefined();
    expect(s.root.dataset.captures).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.notice.show).toHaveBeenCalledWith("Select the lines first, then right-click them or press Shift+F10.", { tone: "info" });
    expect(s.root.dataset).toMatchObject({ capture: "refused", captureReason: "empty", captures: "1" });
    expect(s.load).not.toHaveBeenCalled();
    s.capture.open(el() as unknown as HTMLElement, "menu");
    await vi.advanceTimersByTimeAsync(50);
    expect(s.root.dataset.captures).toBe("2");
  });

  it.each([
    ["head-pointer", false, "Select the lines first."],
    ["head-key", false, "Select the lines in the code, then press Shift+F10 there."],
    ["menu", true, "Select the lines to capture first."],
    ["head-pointer", true, "Select the lines to capture first."],
  ] as [Entry, boolean, string][])("the text follows the entry: %s (coarse %s)", async (entry, coarse, text) => {
    const s = setup({ state: stateWith(FIXTURE, [[3, 3]]), coarse });
    s.capture.open(el() as unknown as HTMLElement, entry);
    await vi.advanceTimersByTimeAsync(50);
    expect(s.notice.show).toHaveBeenCalledWith(text, { tone: "info" });
  });

  it("blank lines, the cap and no file each refuse with their reason", async () => {
    // 55 to 56: the blank line 4, ending at column 0 of line 5.
    const blank = setup({ state: stateWith(FIXTURE, [[55, 56]]) });
    blank.capture.open(el() as unknown as HTMLElement, "context");
    await vi.advanceTimersByTimeAsync(50);
    expect(blank.notice.show).toHaveBeenCalledWith("The selected lines are blank. Select some code first.", { tone: "info" });
    expect(blank.root.dataset.captureReason).toBe("blank");

    const doc = "x\n".repeat(301);
    const cap = setup({ state: stateWith(doc, [[0, doc.length]]) });
    cap.capture.open(el() as unknown as HTMLElement, "context");
    await vi.advanceTimersByTimeAsync(50);
    expect(cap.notice.show).toHaveBeenCalledWith("That's 301 lines. An image can show up to 300, so select fewer lines.", { tone: "info" });
    expect(cap.root.dataset.captureReason).toBe("cap");

    const none = setup({ state: null });
    none.capture.open(el() as unknown as HTMLElement, "menu");
    await vi.advanceTimersByTimeAsync(50);
    expect(none.notice.show).toHaveBeenCalledWith("Open a file and select some code first.", { tone: "info" });
    expect(none.root.dataset.captureReason).toBe("no-file");
  });

  it("a valid plan imports once; a second open while the import is pending does nothing", async () => {
    const s = setup();
    const opener = el() as unknown as HTMLElement;
    s.capture.open(opener, "head-pointer");
    s.capture.open(opener, "head-pointer");
    expect(s.load).toHaveBeenCalledTimes(1);
    s.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]).toMatchObject({ path: "src/main.py", plan: { ok: true, first: 2, last: 3, gaps: false }, canCopy: true, options: { colors: "match", numbers: true, name: true } });
    // Open now: another press does nothing either.
    s.capture.open(opener, "head-pointer");
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.root.dataset.capture).toBeUndefined();
  });

  it("returnTo for the file menu and the head: Files when narrow, the opener when shown, else More file actions", async () => {
    const wide = setup();
    const opener = el();
    wide.capture.open(opener as unknown as HTMLElement, "head-pointer");
    wide.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    const returnTo = wide.opened[0].returnTo;
    expect(returnTo()).toBe(opener);
    opener.shown = false;
    expect(returnTo()).toBe(wide.fileActions);
    opener.shown = true;
    opener.isConnected = false;
    expect(returnTo()).toBe(wide.fileActions);

    const narrow = setup({ narrow: true });
    narrow.capture.open(el() as unknown as HTMLElement, "menu");
    narrow.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    expect(narrow.opened[0].returnTo()).toBe(narrow.filesButton);
  });

  it("returnTo for the code menu: the view's own focus() and null while the code is shown, else the file-menu fallback", async () => {
    const s = setup();
    s.capture.open(s.content as unknown as HTMLElement, "context");
    s.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    const returnTo = s.opened[0].returnTo;
    expect(returnTo()).toBeNull();
    expect(s.view.focus).toHaveBeenCalledTimes(1);
    s.content.shown = false;
    expect(returnTo()).toBe(s.fileActions);
    expect(s.view.focus).toHaveBeenCalledTimes(1);

    const narrow = setup({ narrow: true });
    narrow.capture.open(narrow.content as unknown as HTMLElement, "context");
    narrow.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    narrow.content.shown = false;
    expect(narrow.opened[0].returnTo()).toBe(narrow.filesButton);
  });

  it("an import failure becomes a notice, and a later open tries again", async () => {
    const s = setup({ failImport: true });
    s.capture.open(el() as unknown as HTMLElement, "menu");
    s.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.notice.show).toHaveBeenCalledWith("The image tool couldn't open: Failed to fetch.", { tone: "error" });
    expect(s.root.dataset.capture).toBeUndefined();
    s.capture.open(el() as unknown as HTMLElement, "menu");
    expect(s.load).toHaveBeenCalledTimes(2);
  });
});

describe("createSnippetCapture.menuItems (2.1)", () => {
  it("one item in its own group, named after the active file and the whole lines it will draw; it opens the dialog", async () => {
    const s = setup();
    const items = s.capture.menuItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "Capture snippet of main.py, lines 2 to 3...", icon: "image", separatorBefore: true });
    items[0].run();
    expect(s.load).toHaveBeenCalledTimes(1);
    s.finishImport();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.opened[0].returnTo()).toBe(s.fileActions);
  });

  it("explains instead of hiding when nothing is selected; absent when no file is open", () => {
    expect(setup({ state: stateWith(FIXTURE, [[3, 3]]) }).capture.menuItems()[0].label).toBe("Capture snippet of the selected lines...");
    expect(setup({ state: null }).capture.menuItems()).toEqual([]);
  });
});
