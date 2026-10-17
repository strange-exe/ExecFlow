import { describe, expect, it } from "vitest";
import type { SyncReport } from "../sync/engine";
import { summarizeReport } from "./sync-report";

const empty: SyncReport = {
  pulled: [],
  pushed: [],
  deleted: [],
  conflicts: [],
  skipped: [],
  ignoredRemotePaths: [],
  opaque: [],
  notPushed: [],
  details: [],
  commit: "a".repeat(40),
  historyRewritten: false,
};
const ctx = { repo: "me/code", closed: [], kept: [] };

describe("sync report notice", () => {
  it("says nothing when nothing changed", () => {
    expect(summarizeReport(empty, ctx)).toBeNull();
  });

  it("counts what moved each way", () => {
    const r = summarizeReport({ ...empty, pulled: ["a.py", "b.py"], pushed: ["c.py"], deleted: [{ path: "d.py", where: "remote" }] }, ctx)!;
    expect(r.text).toBe("Synced with me/code: 2 files downloaded, 1 file uploaded and 1 file deleted on GitHub.");
    expect(r.tone).toBe("success");
    expect(r.again).toBe(false);
  });

  it("names one conflict copy and returns it for the notice's action", () => {
    const copy = "src/main.conflict-20261017-101500.py";
    const r = summarizeReport({ ...empty, pulled: ["src/main.py"], pushed: [copy], conflicts: [{ path: "src/main.py", copy }] }, ctx)!;
    expect(r.text).toContain("main.py changed on both sides: GitHub's version keeps the name, yours is in main.conflict-20261017-101500.py.");
    expect(r.tone).toBe("warning");
    expect(r.conflicts).toEqual([{ path: "src/main.py", copy }]);
  });

  it("summarises several conflicts", () => {
    const conflicts = [1, 2, 3].map((n) => ({ path: `f${n}.c`, copy: `f${n}.conflict-20261017-101500.c` }));
    const r = summarizeReport({ ...empty, conflicts }, ctx)!;
    expect(r.text).toBe("3 files changed on both sides: GitHub's versions keep the names, yours are in conflict copies.");
    expect(r.conflicts).toHaveLength(3);
  });

  it("explains closed tabs, typing during the sync, held-back workflows and unusable names", () => {
    const r = summarizeReport(
      { ...empty, deleted: [{ path: "old.py", where: "local" }], skipped: ["notes.py"], notPushed: [".github/workflows/ci.yml"], ignoredRemotePaths: ["bad/CON.txt", "x:y"], historyRewritten: true },
      { ...ctx, closed: ["old.py"], kept: ["notes.py", "main.py"] },
    )!;
    expect(r.text).toContain("Synced with me/code: 1 file deleted here.");
    expect(r.text).toContain("Closed old.py: deleted on GitHub.");
    expect(r.text).toContain("You were typing in notes.py and main.py, so they sync again in a moment.");
    expect(r.text).toContain("Not uploaded: ci.yml");
    expect(r.text).toContain("2 files in the repository have names this computer can't use, so they were left out.");
    expect(r.text).toContain("history was rewritten");
    expect(r.again).toBe(true);
    expect(r.tone).toBe("warning");
  });

  it("mentions files kept read-only", () => {
    const r = summarizeReport({ ...empty, pulled: ["logo.png"], opaque: [{ path: "logo.png", reason: "it is binary" }] }, ctx)!;
    expect(r.text).toBe("Synced with me/code: 1 file downloaded. logo.png is kept read-only here (binary or special file).");
  });
});
