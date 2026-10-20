// The workspace index (workspace-index.ts): each file is read and parsed once per version, again
// after it changes, in slices that stop when the scheduler says so; an open file's own text wins.
import { Text } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idleScheduler, SLICE_MS, WorkspaceIndex, type IndexHost, type Scheduler, type Slice } from "./workspace-index";

/** A stored workspace: path -> text, with a count of reads per path. */
function storage(files: Record<string, string>) {
  const reads: string[] = [];
  const host: IndexHost & { files: Record<string, string>; reads: string[]; open: Map<string, Text> } = {
    files,
    reads,
    open: new Map(),
    read: (path) => {
      reads.push(path);
      return Object.hasOwn(host.files, path) ? Promise.resolve(host.files[path]) : Promise.reject(new Error(`no ${path}`));
    },
    live: (path) => host.open.get(path) ?? null,
  };
  return host;
}

/** Runs every slice in a later task with no time limit (the tests that count slices use their own). */
const soon: Scheduler = (slice) => void setTimeout(() => slice(() => true), 0);

/** Waits until the index has nothing left to read or parse. */
async function settled(index: WorkspaceIndex) {
  for (let i = 0; i < 1000 && index.busy; i++) await new Promise((r) => setTimeout(r, 0));
  expect(index.busy, "the index finished").toBe(false);
}

const labels = (index: WorkspaceIndex, path: string) => index.get(path)?.names.map((n) => n.label) ?? null;

describe("WorkspaceIndex", () => {
  it("reads and parses a file once per version, only when asked, and says what it declares", async () => {
    const host = storage({ "util.h": '#include "more.h"\nint add(int a, int b);\n', "other.h": "int unrelated;\n" });
    const index = new WorkspaceIndex(host, soon);
    const updates = vi.fn();
    index.onUpdate(updates);
    expect(host.reads).toEqual([]);
    expect(index.get("util.h")).toBeNull(); // asked for now, known later
    await settled(index);
    expect(labels(index, "util.h")).toEqual(["add"]);
    expect(index.get("util.h")?.includes).toEqual(["more.h"]);
    expect(index.get("util.h")).toBe(index.get("util.h"));
    expect(updates).toHaveBeenCalledTimes(1);
    // Asking again, and asking twice while it is read, reads nothing more.
    index.get("util.h");
    expect(index.busy).toBe(false);
    expect(host.reads).toEqual(["util.h"]);
    expect(index.parsed).toBe(1);
    // A file nobody asked for is never read.
    expect(host.reads).not.toContain("other.h");
  });

  it("reads a file again after it changed, and only that file", async () => {
    const host = storage({ "a.h": "int one;\n", "b.h": "int two;\n" });
    const index = new WorkspaceIndex(host, soon);
    index.get("a.h");
    index.get("b.h");
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["one"]);
    host.files["a.h"] = "int one;\nint three;\n";
    const updates = vi.fn();
    index.onUpdate(updates);
    index.changed(["a.h"]);
    expect(updates).toHaveBeenCalledTimes(1); // the sources and the loader look again
    expect(index.get("a.h")).toBeNull();
    expect(labels(index, "b.h")).toEqual(["two"]);
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["one", "three"]);
    expect(host.reads).toEqual(["a.h", "b.h", "a.h"]);

    // Every file (another tab changed storage).
    host.files["b.h"] = "int four;\n";
    index.changed();
    expect(index.get("b.h")).toBeNull();
    await settled(index);
    expect(labels(index, "b.h")).toEqual(["four"]);
  });

  it("drops a result whose file changed while it was being read", async () => {
    const host = storage({ "a.h": "int old;\n" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = host.read;
    host.read = async (path) => {
      const text = await read(path);
      await gate;
      return text;
    };
    const index = new WorkspaceIndex(host, soon);
    index.get("a.h");
    await new Promise((r) => setTimeout(r, 0));
    host.files["a.h"] = "int fresh;\n";
    index.changed(["a.h"]);
    release();
    await settled(index);
    expect(index.parsed).toBe(0); // the old text never became the answer
    expect(index.get("a.h")).toBeNull();
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["fresh"]);
  });

  it("uses an open file's own text (no read), parses it again when it changes, and keeps it through a save", async () => {
    const host = storage({ "a.h": "int stored;\n" });
    const index = new WorkspaceIndex(host, soon);
    const typed = Text.of(["int typed;", ""]);
    host.open.set("a.h", typed);
    index.get("a.h");
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["typed"]);
    expect(host.reads).toEqual([]);
    // The save of that text: still the same text, so nothing is parsed again.
    index.changed(["a.h"]);
    expect(labels(index, "a.h")).toEqual(["typed"]);
    host.open.set("a.h", Text.of(["int typed, more;", ""]));
    expect(index.get("a.h")).toBeNull();
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["typed", "more"]);
    // Closed: the stored text counts again.
    host.open.delete("a.h");
    expect(index.get("a.h")).toBeNull();
    await settled(index);
    expect(labels(index, "a.h")).toEqual(["stored"]);
    expect(index.parsed).toBe(3);
  });

  it("answers nothing, quietly, for a file it can't read or has no grammar for, until it changes", async () => {
    const host = storage({ "notes.txt": "int x;\n" });
    const index = new WorkspaceIndex(host, soon);
    index.get("gone.h");
    index.get("notes.txt");
    await settled(index);
    expect(index.get("gone.h")).toEqual({ names: [], includes: [] });
    expect(index.get("notes.txt")).toEqual({ names: [], includes: [] });
    expect(host.reads).toEqual(["gone.h"]); // a text file with no grammar isn't even read
    host.files["gone.h"] = "int back;\n";
    index.changed(["gone.h"]);
    index.get("gone.h");
    await settled(index);
    expect(labels(index, "gone.h")).toEqual(["back"]);
  });

  it("parses Python modules: top-level defs, classes and assignments", async () => {
    const host = storage({ "helpers.py": "def greet(name):\n    return name\n\nclass Point:\n    pass\n\nLIMIT = 3\n" });
    const index = new WorkspaceIndex(host, soon);
    index.get("helpers.py");
    await settled(index);
    expect(index.get("helpers.py")?.names.map((n) => `${n.label} ${n.type}`)).toEqual(["greet function", "Point class", "LIMIT variable"]);
  });

  it("parses a long file over many slices, each ending when the scheduler's time is up, with the same result", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `int value${i} = ${i};\nint twice${i}(int x) { return x * 2; }\n`).join("");
    const slices: number[] = [];
    // Each slice may do one round of steps: `more` says no at its first look at the clock.
    const tight: Scheduler = (slice: Slice) =>
      void setTimeout(() => {
        let looks = 0;
        slice(() => ++looks < 1);
        slices.push(looks);
      }, 0);
    const sliced = new WorkspaceIndex(storage({ "big.h": text }), tight);
    sliced.get("big.h");
    await settled(sliced);
    const whole = new WorkspaceIndex(storage({ "big.h": text }), soon);
    whole.get("big.h");
    await settled(whole);
    expect(sliced.get("big.h")?.names.length).toBe(80);
    expect(sliced.get("big.h")).toEqual(whole.get("big.h"));
    expect(slices.length, "slices").toBeGreaterThan(20);
    expect(Math.max(...slices), "looks at the clock per slice").toBeLessThanOrEqual(1);
  });
});

describe("idleScheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("works in idle callbacks for at most SLICE_MS, or the idle time left when that is shorter", () => {
    const calls: { timeout?: number }[] = [];
    const pending: ((deadline: IdleDeadline) => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: (deadline: IdleDeadline) => void, options?: { timeout?: number }) => {
      calls.push({ timeout: options?.timeout });
      pending.push(cb);
      return 1;
    });
    let clock = 1000;
    const schedule = idleScheduler(SLICE_MS, () => clock);
    const budgets: number[] = [];
    const measure: Slice = (more) => {
      const start = clock;
      while (more()) clock += 0.5;
      budgets.push(clock - start);
    };
    schedule(measure);
    pending.shift()!({ didTimeout: false, timeRemaining: () => 3 });
    schedule(measure);
    pending.shift()!({ didTimeout: false, timeRemaining: () => 49 });
    schedule(measure);
    pending.shift()!({ didTimeout: true, timeRemaining: () => 0 });
    expect(budgets).toEqual([3, SLICE_MS, SLICE_MS]);
    expect(calls).toEqual([{ timeout: 200 }, { timeout: 200 }, { timeout: 200 }]);
  });

  it("falls back to a timer where there is no requestIdleCallback (WebKit)", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    let clock = 0;
    const schedule = idleScheduler(SLICE_MS, () => clock);
    const budget = await new Promise<number>((resolve) =>
      schedule((more) => {
        while (more()) clock += 1;
        resolve(clock);
      }),
    );
    expect(budget).toBe(SLICE_MS);
  });
});
