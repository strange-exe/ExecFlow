// EditorManager's state-level behaviour, run under Node through host.ts headlessHost(), which
// applies transactions like an EditorView (and throws like one during an update). What only a
// real view can show (scroll restore, focus, DOM rendering, keyboard) is in the browser-test list.

import { redo, undo, undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { diagnosticCount, forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { ToolDiagnostic } from "../core/types";
import { EditorManager, type EditorHooks, type EditorManagerOptions } from "./editor-manager";
import { workspaceIndex } from "./completion-context";
import { headlessHost } from "./host";
import { indexIn } from "./workspace-index";
import "./test-languages";

function setup(options: Omit<EditorManagerOptions, "host"> = {}) {
  const events: string[] = [];
  const hooks: EditorHooks = {
    onActiveChange: (id) => events.push(`active ${id}`),
    onDirtyChange: (id, dirty) => events.push(`dirty ${id} ${dirty}`),
    onDiagnosticsChange: () => events.push("diagnostics"),
    onDocChanged: (id) => events.push(`doc ${id}`),
    onEvict: (id) => events.push(`evict ${id}`),
    ...options.hooks,
  };
  const mgr = new EditorManager({ ...options, host: headlessHost(), hooks });
  return { mgr, events };
}

const insert = (from: number, text: string) => ({ changes: { from, insert: text } });
const clang = (path: string | null, line: number, col: number, message = "error here"): ToolDiagnostic => ({
  path, line, col, unit: "utf8-byte", base: 1, severity: "error", message, source: "clang",
});
const marked = (state: EditorState) => {
  const out: string[] = [];
  forEachDiagnostic(state, (d, from, to) => out.push(`${state.doc.sliceString(from, to)}|${d.message}`));
  return out;
};

const MAIN = "int helper(void);\nint main(void) {\n    return helper();\n}\n";
const UTIL = "int helper(void) {\n    return y;\n}\n";

describe("opening and switching files", () => {
  it("keeps one state per file under a stable id and shows the active one", () => {
    const { mgr, events } = setup();
    expect(mgr.activeId).toBeNull();
    expect(mgr.host.state.readOnly).toBe(true); // placeholder
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    expect(mgr.activeId).toBe("a");
    expect(mgr.state("a")).toBe(mgr.host.state);
    expect(mgr.text("b")).toBe(UTIL);
    expect(mgr.ids()).toEqual(["a", "b"]);
    expect(events).toEqual(["active a"]);
    expect(mgr.open("a", "main.c", "ignored")).toBe(false);
    expect(mgr.text("a")).toBe(MAIN);
  });

  it("says when the active file's cursor or text changes, inside the same dispatch, and never for files not shown", () => {
    // The status bar's Ln/Col is written from this hook in the editor's own update: a separate
    // frame per key for it doubled the page's paint work while typing (speed profile, 2026-10-19).
    const moves: string[] = [];
    const { mgr } = setup({ hooks: { onSelectionChange: (id, state) => moves.push(`${id} ${state.selection.main.head}`) } });
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    moves.length = 0; // opening shows the file; the workbench redraws then anyway (onActiveChange)
    mgr.apply("a", { selection: { anchor: 4 } });
    expect(moves, "a cursor move, before dispatch returns").toEqual(["a 4"]);
    mgr.apply("a", { changes: { from: 0, insert: "x" } });
    expect(moves, "an edit maps the cursor").toEqual(["a 4", "a 5"]);
    mgr.apply("a", { effects: [] });
    expect(moves, "a transaction that moves nothing").toEqual(["a 4", "a 5"]);
    mgr.apply("b", { selection: { anchor: 2 } });
    mgr.apply("b", insert(0, "y"));
    expect(moves, "a file not shown").toEqual(["a 4", "a 5"]);
  });

  it("says so when the shown file's text is replaced from outside (a pull, an import, a program's file), not for a file not shown", () => {
    // While a file stays shown, Ln/Col is written only from this hook. A replaced text keeps the
    // cursor's offset where it can (clamped to the new length), so its line and column change.
    const moves: string[] = [];
    const { mgr } = setup({ hooks: { onSelectionChange: (id, state) => moves.push(`${id} ${state.selection.main.head} line ${state.doc.lineAt(state.selection.main.head).number}`) } });
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.apply("a", { selection: { anchor: MAIN.length } });
    expect(moves).toEqual([`a ${MAIN.length} line 5`]);
    moves.length = 0;
    const next = "int main(void) { return 0; }\n";
    expect(mgr.replaceContent("a", next)).toBe(true);
    expect(moves, "the shown file's cursor, in its new text").toEqual([`a ${next.length} line 2`]);
    expect(mgr.replaceContent("b", "int helper(void) { return 1; }\n")).toBe(true);
    expect(moves, "a file not shown").toEqual([`a ${next.length} line 2`]);
  });

  it("refuses a second id for a path that is already open", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    expect(() => mgr.open("x", "main.c", MAIN)).toThrow(/already open/);
  });

  it("keeps selection and undo history per file across switches", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.apply("a", insert(0, "// a\n"));
    mgr.apply("a", { selection: { anchor: 7 } });
    mgr.activate("b");
    mgr.apply("b", { selection: { anchor: 2 } });
    mgr.activate("a");
    expect(mgr.host.state.selection.main.head).toBe(7);
    expect(undoDepth(mgr.host.state)).toBe(1);
    expect(mgr.state("b")!.selection.main.head).toBe(2);
    expect(undoDepth(mgr.state("b")!)).toBe(0);
  });

  it("defers activate() called during an update (setState would throw there)", async () => {
    let mgr!: EditorManager;
    let direct: unknown = null;
    ({ mgr } = setup({
      hooks: {
        onDocChanged: (id) => {
          if (id !== "a") return;
          try {
            mgr.host.setState(mgr.state("b")!);
          } catch (e) {
            direct = e;
          }
          mgr.activate("b");
        },
      },
    }));
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.apply("a", insert(0, "x"));
    expect(direct).toBeInstanceOf(Error); // what a direct switch inside the listener would do
    expect(mgr.activeId).toBe("a");
    await Promise.resolve();
    expect(mgr.activeId).toBe("b");
    expect(mgr.text("a")).toBe("x" + MAIN);
  });

  it("stays on the shown file when the view refuses a switch, so no file gets another's text", () => {
    let refuse = false;
    const base = headlessHost();
    const mgr = new EditorManager({
      host: (initial, onTransactions) => {
        const host = base(initial, onTransactions);
        return Object.assign(Object.create(host) as typeof host, {
          setState(state: EditorState) {
            if (refuse) throw new Error("Calls to EditorView.setState are not allowed while an update is in progress");
            host.setState(state);
          },
        });
      },
    });
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    refuse = true;
    expect(() => mgr.activate("b")).toThrow();
    expect(mgr.activeId).toBe("a");
    expect(mgr.text("b")).toBe(UTIL);
    expect(mgr.text("a")).toBe(MAIN);
  });

  it("reports doc changes with the id read from the state, for active and inactive files", () => {
    const { mgr, events } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    events.length = 0;
    mgr.apply("b", insert(0, "/* b */"));
    mgr.apply("a", insert(0, "/* a */"));
    mgr.apply("a", { selection: { anchor: 1 } });
    expect(events.filter((e) => e.startsWith("doc"))).toEqual(["doc b", "doc a"]);
  });

  it("reveal() activates the file and selects a clamped range", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    expect(mgr.reveal("b", 4, 10)).toBe(true);
    expect(mgr.activeId).toBe("b");
    expect([mgr.host.state.selection.main.from, mgr.host.state.selection.main.to]).toEqual([4, 10]);
    mgr.reveal("b", 5, 9999);
    expect(mgr.host.state.selection.main.to).toBe(UTIL.length);
    expect(mgr.reveal("nope", 0)).toBe(false);
  });
});

describe("dirty tracking", () => {
  it("marks the active file dirty on an edit and clean again when undo restores the saved text", () => {
    const { mgr, events } = setup();
    mgr.open("a", "main.c", MAIN);
    events.length = 0;
    mgr.apply("a", insert(0, "// hi\n"));
    expect(mgr.isDirty("a")).toBe(true);
    expect(mgr.command("a", undo)).toBe(true);
    expect(mgr.text("a")).toBe(MAIN);
    expect(mgr.isDirty("a")).toBe(false);
    mgr.command("a", redo);
    expect(mgr.isDirty("a")).toBe(true);
    expect(events.filter((e) => e.startsWith("dirty"))).toEqual(["dirty a true", "dirty a false", "dirty a true"]);
  });

  it("tracks a file that isn't on screen the same way", () => {
    const { mgr, events } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.apply("b", insert(0, "#include <stdio.h>\n"));
    expect(mgr.isDirty("b")).toBe(true);
    mgr.command("b", undo);
    expect(mgr.isDirty("b")).toBe(false);
    expect(events.filter((e) => e.startsWith("dirty"))).toEqual(["dirty b true", "dirty b false"]);
    expect(mgr.activeId).toBe("a");
  });

  it("an edit typed back to the saved text by hand is clean too", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", "abc");
    mgr.apply("a", insert(3, "d"));
    mgr.apply("a", { changes: { from: 3, to: 4 } });
    expect(mgr.isDirty("a")).toBe(false);
  });

  it("markSaved uses the doc from when the save started, so edits during the save stay dirty", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.apply("a", insert(0, "// v2\n"));
    const atSaveStart = mgr.state("a")!.doc;
    mgr.apply("a", insert(0, "// typed while saving\n"));
    mgr.markSaved("a", atSaveStart);
    expect(mgr.isDirty("a")).toBe(true);
    mgr.markSaved("a", mgr.state("a")!.doc);
    expect(mgr.isDirty("a")).toBe(false);
    mgr.command("a", undo);
    expect(mgr.isDirty("a")).toBe(true);
  });
});

describe("builds and diagnostics", () => {
  const utilError = clang("util.c", 2, 12, "use of undeclared identifier 'y'"); // the y in "return y;"

  it("applies diagnostics to a file that isn't active, mapped through edits made during the build", () => {
    const { mgr, events } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    const ticket = mgr.beginBuild(["a", "b"]);
    expect(ticket.sources).toEqual([{ path: "main.c", text: MAIN }, { path: "util.c", text: UTIL }]);
    mgr.apply("b", insert(0, "// typed during the build\n"));
    events.length = 0;
    expect(mgr.endBuild(ticket, [utilError])).toBe(true);
    expect(mgr.activeId).toBe("a");
    expect(marked(mgr.state("b")!)).toEqual(["y|use of undeclared identifier 'y'"]);
    expect(diagnosticCount(mgr.state("a")!)).toBe(0);
    expect(events).toEqual(["diagnostics"]);
    mgr.activate("b");
    expect(marked(mgr.host.state)).toEqual(["y|use of undeclared identifier 'y'"]);
  });

  it("maps the active file's diagnostics through typing done during the build", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    const ticket = mgr.beginBuild(["b"]);
    mgr.apply("b", insert(0, "#include <stdio.h>\n"));
    mgr.apply("b", insert(mgr.state("b")!.doc.length, "int extra;\n"));
    mgr.endBuild(ticket, [utilError]);
    expect(marked(mgr.host.state)).toEqual(["y|use of undeclared identifier 'y'"]);
  });

  it("drops a diagnostic whose text was deleted during the build", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    const ticket = mgr.beginBuild(["b"]);
    const at = UTIL.indexOf("y;");
    mgr.apply("b", { changes: { from: at, to: at + 1 } });
    mgr.endBuild(ticket, [utilError]);
    expect(marked(mgr.host.state)).toEqual([]);
  });

  it("keeps a diagnostic on a token retyped during the build, as the lint state maps its own marks", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    const ticket = mgr.beginBuild(["b"]);
    const at = UTIL.indexOf("y;");
    mgr.apply("b", { changes: { from: at, to: at + 1, insert: "0" } });
    mgr.endBuild(ticket, [utilError]);
    expect(marked(mgr.host.state)).toEqual(["0|use of undeclared identifier 'y'"]);
  });

  it("replaces the channel's diagnostics on the next build, including clearing fixed files", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    mgr.endBuild(mgr.beginBuild(["b"]), [utilError]);
    expect(marked(mgr.host.state)).toHaveLength(1);
    mgr.endBuild(mgr.beginBuild(["b"]), []);
    expect(marked(mgr.host.state)).toEqual([]);
  });

  it("keeps another channel's diagnostics when a build ends", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    mgr.endBuild(mgr.beginBuild(["b"], { channel: "run" }), [clang("util.c", 1, 5, "from the run")]);
    mgr.endBuild(mgr.beginBuild(["b"]), [utilError]);
    expect(marked(mgr.host.state)).toEqual(["helper|from the run", "y|use of undeclared identifier 'y'"]);
  });

  it("ignores a build that a newer one superseded, and a cancelled one", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    const first = mgr.beginBuild(["b"]);
    const second = mgr.beginBuild(["b"]);
    expect(mgr.endBuild(first, [utilError])).toBe(false);
    expect(marked(mgr.host.state)).toEqual([]);
    expect(mgr.endBuild(second, [utilError])).toBe(true);
    const third = mgr.beginBuild(["b"]);
    mgr.cancelBuild(third);
    expect(mgr.endBuild(third, [])).toBe(false);
    expect(marked(mgr.host.state)).toHaveLength(1);
  });

  it("stores diagnostics for closed files and applies them when the file opens", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    const ticket = mgr.beginBuild(["a"], { paths: ["main.c", "util.c"] });
    mgr.endBuild(ticket, [utilError, clang(null, 1, 1, "undefined symbol: main")]);
    expect(mgr.problems().map((p) => [p.id, p.path, p.line, p.message])).toEqual([
      [null, null, 1, "undefined symbol: main"],
      [null, "util.c", 2, "use of undeclared identifier 'y'"],
    ]);
    mgr.open("b", "util.c", UTIL, { activate: false });
    expect(marked(mgr.state("b")!)).toEqual(["y|use of undeclared identifier 'y'"]);
    const row = mgr.problems().find((p) => p.path === "util.c")!;
    expect([row.id, row.line, row.col, row.from, row.to]).toEqual(["b", 2, 12, UTIL.indexOf("y;"), UTIL.indexOf("y;") + 1]);
    expect(mgr.problems().filter((p) => p.path === "util.c")).toHaveLength(1); // no longer pending as well
  });

  it("clears a closed file's stored diagnostics when a later build of it reports none", () => {
    const { mgr } = setup();
    mgr.endBuild(mgr.beginBuild([], { paths: ["util.c"] }), [utilError]);
    expect(mgr.problems()).toHaveLength(1);
    mgr.endBuild(mgr.beginBuild([], { paths: ["util.c"] }), []);
    expect(mgr.problems()).toEqual([]);
  });

  it("keeps a closed file's diagnostics at their current position, and reapplies them on open", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.endBuild(mgr.beginBuild(["b"]), [utilError]);
    expect(mgr.close("b").closed).toBe(true);
    expect(mgr.problems().map((p) => [p.id, p.path, p.line])).toEqual([[null, "util.c", 2]]);
    mgr.open("b2", "util.c", UTIL, { activate: false });
    expect(marked(mgr.state("b2")!)).toEqual(["y|use of undeclared identifier 'y'"]);
  });

  it("moves or forgets a closed file's diagnostics with movePending", () => {
    const { mgr } = setup();
    mgr.endBuild(mgr.beginBuild([], { paths: ["util.c"] }), [utilError]);
    mgr.movePending("util.c", "lib/util.c");
    expect(mgr.problems().map((p) => p.path)).toEqual(["lib/util.c"]);
    mgr.open("u", "lib/util.c", UTIL);
    expect(marked(mgr.host.state)).toHaveLength(1);
    mgr.endBuild(mgr.beginBuild([], { paths: ["x.c"] }), [clang("x.c", 1, 1)]);
    mgr.movePending("x.c", null);
    expect(mgr.problems().map((p) => p.path)).toEqual(["lib/util.c"]);
  });

  it("drops a build's diagnostics for a file whose content was replaced during the build", () => {
    const { mgr } = setup();
    mgr.open("b", "util.c", UTIL);
    const ticket = mgr.beginBuild(["b"]);
    expect(mgr.replaceContent("b", "int helper(void) { return 1; }\n")).toBe(true);
    mgr.endBuild(ticket, [utilError]);
    expect(marked(mgr.host.state)).toEqual([]);
  });

  it("tells the UI when an edit moves existing diagnostics", () => {
    const { mgr, events } = setup();
    mgr.open("b", "util.c", UTIL);
    mgr.endBuild(mgr.beginBuild(["b"]), [utilError]);
    events.length = 0;
    mgr.apply("b", insert(0, "\n"));
    expect(events).toContain("diagnostics");
  });
});

describe("closing, renaming, replacing", () => {
  it("won't close a dirty file without force, then activates the most recently used one", () => {
    const { mgr, events } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL);
    mgr.apply("b", insert(0, "x"));
    expect(mgr.close("b")).toEqual({ closed: false, dirty: true });
    expect(mgr.has("b")).toBe(true);
    expect(mgr.close("b", { force: true })).toEqual({ closed: true, dirty: true });
    expect(mgr.activeId).toBe("a");
    events.length = 0;
    mgr.close("a");
    expect(mgr.activeId).toBeNull();
    expect(events).toEqual(["active null"]);
    expect(mgr.host.state.readOnly).toBe(true);
    expect(mgr.host.state.doc.length).toBe(0);
  });

  it("rename keeps the id, history and diagnostics and switches the grammar", () => {
    const { mgr } = setup();
    mgr.open("a", "script.py", "x = 1\n");
    mgr.apply("a", insert(0, "# c\n"));
    expect(mgr.state("a")!.facet(language)?.name).toBe("python");
    expect(mgr.rename("a", "script.c")).toBe(true);
    expect(mgr.path("a")).toBe("script.c");
    expect(mgr.state("a")!.facet(language)?.name).toBe("cpp");
    expect(undoDepth(mgr.state("a")!)).toBe(1);
    expect(mgr.state("a")!.facet(EditorView.contentAttributes)).toContainEqual({ "aria-label": "Code editor, script.c" });
  });

  it("replaceContent refreshes a clean file (fresh history, still clean) and refuses a dirty one", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.apply("a", insert(0, "// local\n"));
    expect(mgr.replaceContent("a", "int main(void) { return 0; }\n")).toBe(false);
    expect(mgr.text("a")).toBe("// local\n" + MAIN);
    mgr.command("a", undo);
    expect(mgr.replaceContent("a", "int main(void) { return 0; }\n")).toBe(true);
    expect(mgr.text("a")).toBe("int main(void) { return 0; }\n");
    expect(mgr.isDirty("a")).toBe(false);
    expect(undoDepth(mgr.host.state)).toBe(0);
  });
});

describe("read-only lock and preferences", () => {
  it("locks the active file now and others when they are shown", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    mgr.open("b", "util.c", UTIL, { activate: false });
    mgr.setReadOnly(true);
    expect(mgr.host.state.readOnly).toBe(true);
    expect(mgr.state("b")!.readOnly).toBe(false); // reconciled lazily
    mgr.activate("b");
    expect(mgr.host.state.readOnly).toBe(true);
    mgr.setReadOnly(false);
    expect(mgr.host.state.readOnly).toBe(false);
    mgr.activate("a");
    expect(mgr.host.state.readOnly).toBe(false);
  });

  it("keeps a read-only file read-only when the global lock lifts", () => {
    const { mgr } = setup();
    mgr.open("o", "data.c", "opaque", { readOnly: true });
    expect(mgr.host.state.readOnly).toBe(true);
    mgr.setReadOnly(true);
    mgr.setReadOnly(false);
    expect(mgr.host.state.readOnly).toBe(true);
    mgr.setReadOnly(false, "o");
    expect(mgr.host.state.readOnly).toBe(false);
  });

  it("applies line wrapping through the prefs compartment", () => {
    const { mgr } = setup();
    mgr.open("a", "main.c", MAIN);
    const wraps = () => mgr.host.state.facet(EditorView.contentAttributes).some((a) => typeof a === "object" && a.class === "cm-lineWrapping");
    expect(wraps()).toBe(false);
    mgr.setPrefs({ lineWrapping: true });
    expect(wraps()).toBe(true);
    expect(mgr.getPrefs()).toEqual({ lineWrapping: true, suggestOnTyping: true, enterAcceptsTop: true });
  });
});

describe("the names index", () => {
  const soon = (slice: (more: () => boolean) => void) => void setTimeout(() => slice(() => true), 0);
  async function settled(mgr: EditorManager) {
    for (let i = 0; i < 1000 && mgr.index?.busy; i++) await new Promise((r) => setTimeout(r, 0));
    expect(mgr.index?.busy).toBe(false);
  }

  it("is made only when the app can read files, and every file's state carries it", () => {
    expect(setup().mgr.index).toBeNull();
    const { mgr } = setup({ readFile: () => Promise.resolve(""), indexScheduler: soon });
    mgr.open("a", "main.c", MAIN);
    expect(mgr.index).not.toBeNull();
    expect(mgr.host.state.facet(workspaceIndex)).toBe(mgr.index);
  });

  it("reads an open file's current text (no storage read), stored files from storage, and forwards changes", async () => {
    const stored: Record<string, string> = { "util.h": "int stored_name;\n", "lib.h": "int lib_name;\n" };
    const reads: string[] = [];
    const { mgr } = setup({ readFile: (path) => (reads.push(path), Promise.resolve(stored[path])), indexScheduler: soon });
    mgr.open("u", "util.h", "int open_name;\n", { activate: false });
    mgr.open("a", "main.c", MAIN);
    // The slot's index, made here as the first suggestion would make it (in the completion chunk).
    const names = (path: string) => indexIn(mgr.index!).get(path)?.names.map((n) => n.label) ?? null;
    names("util.h");
    names("lib.h");
    await settled(mgr);
    expect(names("util.h")).toEqual(["open_name"]);
    expect(names("lib.h")).toEqual(["lib_name"]);
    expect(reads).toEqual(["lib.h"]);
    // Typing in the open header (here through apply) is what the index reads next.
    mgr.apply("u", (state) => ({ changes: { from: state.doc.length, insert: "int typed_name;\n" } }));
    expect(names("util.h")).toBeNull();
    await settled(mgr);
    expect(names("util.h")).toEqual(["open_name", "typed_name"]);
    stored["lib.h"] = "int new_lib_name;\n";
    mgr.indexChanged(["lib.h"]);
    expect(names("lib.h")).toBeNull();
    await settled(mgr);
    expect(names("lib.h")).toEqual(["new_lib_name"]);
  });
});

describe("session limit", () => {
  it("evicts the least recently used clean file, never a dirty or the active one, and keeps its diagnostics", () => {
    const { mgr, events } = setup({ maxSessions: 3 });
    mgr.open("f1", "f1.c", "int a;");
    mgr.open("f2", "f2.c", "int b;", { activate: false });
    mgr.open("f3", "util.c", UTIL, { activate: false });
    mgr.apply("f2", insert(0, "x")); // dirty
    mgr.endBuild(mgr.beginBuild(["f3"]), [clang("util.c", 2, 12)]);
    mgr.open("f4", "f4.c", "int d;", { activate: false });
    expect(events).toContain("evict f3");
    expect(mgr.ids().sort()).toEqual(["f1", "f2", "f4"]);
    expect(mgr.problems().map((p) => [p.id, p.path])).toEqual([[null, "util.c"]]);

    for (let i = 5; i < 12; i++) mgr.open(`f${i}`, `f${i}.c`, "", { activate: false });
    expect(mgr.has("f1")).toBe(true); // active
    expect(mgr.has("f2")).toBe(true); // dirty
    expect(mgr.ids()).toHaveLength(3);
    mgr.open("f3", "util.c", UTIL, { activate: false });
    expect(marked(mgr.state("f3")!)).toHaveLength(1);
  });

  it("goes over the limit rather than drop unsaved work", () => {
    const { mgr } = setup({ maxSessions: 1 });
    mgr.open("a", "a.c", "1");
    mgr.apply("a", insert(0, "x"));
    mgr.open("b", "b.c", "2");
    mgr.open("c", "c.c", "3", { activate: false }); // a is now inactive and still dirty
    expect(mgr.ids()).toEqual(["a", "b", "c"]);
    expect(mgr.text("a")).toBe("x1");
  });
});
