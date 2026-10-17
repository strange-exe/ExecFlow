import { describe, expect, it } from "vitest";
import { noEditor } from "./editors";

describe("noEditor (the stand-in before CodeMirror loads)", () => {
  it("has nothing open and changes nothing", () => {
    const e = noEditor();
    expect(e.activeId).toBeNull();
    expect(e.has("f1")).toBe(false);
    expect(e.isDirty("f1")).toBe(false);
    expect(e.idForPath("main.py")).toBeNull();
    expect(e.text("f1")).toBeNull();
    expect(e.replaceContent("f1", "x")).toBe(false);
    expect(e.close("f1")).toEqual({ closed: true, dirty: false });
    expect(e.problems()).toEqual([]);
  });

  it("remembers the run lock for the editor that replaces it, but not a per-file lock", () => {
    const e = noEditor();
    expect(e.readOnly).toBe(true); // a tab starts read-only until it holds the writer lock
    e.setReadOnly(false);
    expect(e.readOnly).toBe(false);
    expect(e.isReadOnly()).toBe(false);
    e.setReadOnly(true, "f1");
    expect(e.readOnly).toBe(false);
  });
});
