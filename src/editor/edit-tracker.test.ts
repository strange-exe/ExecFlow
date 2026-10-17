import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { toCm } from "./diagnostics";
import { EditTracker } from "./edit-tracker";

const doc = (text: string) => Text.of(text.split("\n"));
const insert = (length: number, at: number, text: string) => ChangeSet.of({ from: at, insert: text }, length);
const remove = (length: number, from: number, to: number) => ChangeSet.of({ from, to }, length);

// "y" is undeclared at line 2, column 9 (1-based bytes): the snapshot range is [19, 20).
const SNAPSHOT = "int x = 1;\nint z = y;\n";

function trackedDiagnostic() {
  const tracker = new EditTracker(doc(SNAPSHOT));
  const d = toCm(tracker.doc, { path: "main.c", line: 2, col: 9, unit: "utf8-byte", base: 1, severity: "error", message: "use of undeclared identifier 'y'", source: "clang" });
  expect(tracker.doc.sliceString(d.from, d.to)).toBe("y");
  return { tracker, d };
}

describe("EditTracker", () => {
  it("shifts a diagnostic when text is inserted before it", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(insert(SNAPSHOT.length, 0, "// header\n"));
    const now = tracker.changes.apply(tracker.doc);
    const at = tracker.mapRange(d.from, d.to)!;
    expect(at).toEqual({ from: d.from + 10, to: d.to + 10 });
    expect(now.sliceString(at.from, at.to)).toBe("y");
  });

  it("leaves a diagnostic alone when text is inserted after it", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(insert(SNAPSHOT.length, SNAPSHOT.length, "int w;\n"));
    expect(tracker.mapRange(d.from, d.to)).toEqual({ from: d.from, to: d.to });
  });

  it("keeps text typed at either edge outside the range", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(insert(SNAPSHOT.length, d.to, "yy")); // right after "y"
    const length = tracker.changes.newLength;
    tracker.add(insert(length, d.from, "(")); // right before "y"
    const at = tracker.mapRange(d.from, d.to)!;
    expect(tracker.changes.apply(tracker.doc).sliceString(at.from, at.to)).toBe("y");
  });

  it("widens a range when text is typed inside it", () => {
    const tracker = new EditTracker(doc("value = undefined_name + 1"));
    const from = 8;
    const to = 22; // "undefined_name"
    tracker.add(insert(tracker.doc.length, 13, "XX")); // inside the name
    const at = tracker.mapRange(from, to)!;
    expect(at).toEqual({ from, to: to + 2 });
    expect(tracker.changes.apply(tracker.doc).sliceString(at.from, at.to)).toBe("undefXXined_name");
  });

  it("composes several edits in order", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(insert(SNAPSHOT.length, 0, "#include <stdio.h>\n")); // +19
    tracker.add(remove(tracker.changes.newLength, 0, 9)); // -9
    const at = tracker.mapRange(d.from, d.to)!;
    expect(at.from).toBe(d.from + 10);
    expect(tracker.changes.apply(tracker.doc).sliceString(at.from, at.to)).toBe("y");
  });

  it("returns null when the whole range was deleted, and keeps a partly deleted one", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(remove(SNAPSHOT.length, d.from - 2, d.to + 1)); // "= y;" gone
    expect(tracker.mapRange(d.from, d.to)).toBeNull();

    const partly = new EditTracker(doc("abcdef"));
    partly.add(remove(6, 3, 6));
    expect(partly.mapRange(1, 5)).toEqual({ from: 1, to: 3 });
  });

  it("moves a range onto text that replaced it", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(ChangeSet.of({ from: d.from, to: d.to, insert: "value" }, SNAPSHOT.length));
    const at = tracker.mapRange(d.from, d.to)!;
    expect(tracker.changes.apply(tracker.doc).sliceString(at.from, at.to)).toBe("value");
  });

  it("maps a zero-width diagnostic, and drops it when a deletion spans it", () => {
    const tracker = new EditTracker(doc("abc;"));
    tracker.add(insert(4, 0, ">>"));
    expect(tracker.mapRange(3, 3)).toEqual({ from: 5, to: 5 });
    const spanned = new EditTracker(doc("abc;"));
    spanned.add(remove(4, 1, 4));
    expect(spanned.mapRange(3, 3)).toBeNull();
  });

  it("goes stale (and maps nothing) when a change doesn't fit the tracked text", () => {
    const { tracker, d } = trackedDiagnostic();
    tracker.add(insert(5, 0, "x")); // made for a 5-character document
    expect(tracker.stale).toBe(true);
    expect(tracker.mapRange(d.from, d.to)).toBeNull();
  });
});
