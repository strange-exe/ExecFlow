import { describe, expect, it } from "vitest";
import { ago, countdown, describeStatus, type StatusInput, type SyncPhase } from "./sync-status";

const base = { unsynced: 0, lastSyncAt: null, now: 1_000_000_000 } satisfies Omit<StatusInput, "phase">;
const PHASES: SyncPhase[] = ["not-connected", "needs-token", "synced", "unsynced", "syncing", "failed", "waiting", "offline", "needs-choice"];

describe("sync status words", () => {
  it("every state has an icon, words and an action (never colour alone)", () => {
    const icons = new Set<string>();
    for (const phase of PHASES) {
      const v = describeStatus({ ...base, phase, error: "GitHub had a problem.", retryAt: base.now + 5000 });
      expect(v.words.length, phase).toBeGreaterThan(3);
      expect(v.action.length, phase).toBeGreaterThan(3);
      icons.add(v.icon);
    }
    // Each state draws its own shape, so the icon tells them apart without colour.
    expect(icons.size).toBe(PHASES.length);
  });

  it("uses the words of the brief", () => {
    expect(describeStatus({ ...base, phase: "synced", lastSyncAt: base.now - 2 * 60_000 }).words).toBe("Synced 2 min ago");
    expect(describeStatus({ ...base, phase: "unsynced", unsynced: 3 }).words).toBe("3 unsynced changes");
    expect(describeStatus({ ...base, phase: "unsynced", unsynced: 1 }).words).toBe("1 unsynced change");
    expect(describeStatus({ ...base, phase: "syncing" }).words).toBe("Syncing...");
    expect(describeStatus({ ...base, phase: "failed", error: "GitHub had a problem answering." }).words).toBe("Sync failed: GitHub had a problem answering.");
    expect(describeStatus({ ...base, phase: "not-connected" }).words).toBe("Not connected");
    expect(describeStatus({ ...base, phase: "offline" }).words).toBe("Offline: changes are saved here and will sync later");
    expect(describeStatus({ ...base, phase: "waiting", retryAt: base.now + 44_200 }).words).toBe("Sync failed: retrying in 45 s");
    expect(describeStatus({ ...base, phase: "synced" }).words).toBe("Not synced yet");
  });

  it("while not connected, says where the files are kept (sync and save state are shown only here)", () => {
    const view = describeStatus({ ...base, phase: "not-connected" });
    expect(view.note).toBe("Your files are saved on this computer.");
    // Only that state carries a note: the others say it in their words.
    for (const phase of PHASES.filter((p) => p !== "not-connected")) expect(describeStatus({ ...base, phase }).note, phase).toBeUndefined();
  });

  it("says how long ago, in plain units", () => {
    const now = 10_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now + 5000, now)).toBe("just now"); // a clock a little ahead
    expect(ago(now - 60_000, now)).toBe("1 min ago");
    expect(ago(now - 59 * 60_000, now)).toBe("59 min ago");
    expect(ago(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(ago(now - 5 * 3600_000, now)).toBe("5 hours ago");
    expect(ago(now - 26 * 3600_000, now)).toBe("1 day ago");
    expect(ago(now - 72 * 3600_000, now)).toBe("3 days ago");
  });

  it("counts down in seconds, then minutes", () => {
    expect(countdown(0)).toBe("0 s");
    expect(countdown(-50)).toBe("0 s");
    expect(countdown(1)).toBe("1 s");
    expect(countdown(89_000)).toBe("89 s");
    expect(countdown(120_000)).toBe("2 min");
  });
});
