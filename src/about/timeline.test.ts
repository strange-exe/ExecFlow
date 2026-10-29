// The About page's What's new as a release timeline (redesign6/whatsnew): what each release shows,
// in what order, and the words on its folds. Pure functions over the changelog data; page.ts draws them.
import { describe, expect, it } from "vitest";
import { CHANGELOG, type Release } from "./changelog";
import {
  ITEMS_SHOWN,
  OPEN_RELEASES,
  byKind,
  byMonth,
  countLine,
  longDate,
  olderLabel,
  olderRange,
  releaseId,
  shortDate,
  showAllLabel,
  splitReleases,
} from "./timeline";

const at = (version: string) => CHANGELOG.find((r) => r.version === version)!;
const release = (version: string, date: string): Release => ({ version, date, title: version, items: [{ kind: "fixed", text: "x" }] });

describe("the release timeline", () => {
  it("opens the latest 3 releases and folds at 6 changes", () => {
    expect(OPEN_RELEASES).toBe(3);
    expect(ITEMS_SHOWN).toBe(6);
  });

  it("splits the releases into the open ones and the older ones, nothing lost and nothing twice", () => {
    const { recent, older } = splitReleases(CHANGELOG);
    expect(recent.map((r) => r.version)).toEqual(CHANGELOG.slice(0, 3).map((r) => r.version));
    expect([...recent, ...older]).toEqual([...CHANGELOG]);
    expect(splitReleases(CHANGELOG.slice(0, 2)).older).toEqual([]);
  });

  it("orders a release's changes Added, Changed, Fixed, keeping their order within a kind", () => {
    const r = at("0.9.0");
    const sorted = byKind(r.items);
    expect(sorted).toHaveLength(r.items.length);
    expect(sorted.map((i) => i.kind)).toEqual([...Array(2).fill("added"), ...Array(2).fill("changed"), ...Array(10).fill("fixed")]);
    for (const kind of ["added", "changed", "fixed"] as const) {
      expect(sorted.filter((i) => i.kind === kind)).toEqual(r.items.filter((i) => i.kind === kind));
    }
  });

  it("counts a release's changes by kind, in that order, leaving out kinds it has none of", () => {
    expect(countLine(at("0.9.0").items)).toBe("2 added, 2 changed, 10 fixed");
    expect(countLine(at("0.9.1").items)).toBe("1 fixed");
    expect(countLine(at("0.8.0").items)).toBe("3 added, 1 changed, 1 fixed");
    expect(countLine(at("0.1.0").items)).toBe("2 added");
  });

  it("gives every release a fragment id that is unique and safe in a URL", () => {
    expect(releaseId("0.4.0")).toBe("v0-4-0");
    const ids = CHANGELOG.map((r) => releaseId(r.version));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^v\d+-\d+-\d+$/);
  });

  it("writes dates as the day they are, with no time zone shift", () => {
    expect(shortDate("2026-10-29")).toBe("29 Oct 2026");
    expect(shortDate("2026-10-01")).toBe("1 Oct 2026");
    expect(shortDate("2026-12-31")).toBe("31 Dec 2026");
    expect(longDate("2026-10-18")).toBe("18 October 2026");
  });

  it("names the fold's button by the number of changes it holds and hides", () => {
    expect(showAllLabel(14)).toBe("Show all 14 changes (8 more)");
    expect(showAllLabel(7)).toBe("Show all 7 changes (1 more)");
  });

  it("names the older releases' button by how many, and their range of versions and days", () => {
    const { older } = splitReleases(CHANGELOG);
    expect(olderLabel(14)).toBe("Show 14 older releases");
    expect(olderLabel(1)).toBe("Show 1 older release");
    // From the data, today and once the older releases reach into a later month (the expectation
    // must not assume October): 4 November releases put one of them in the older list.
    const later = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((d, n) => release(`9.9.${3 - n}`, d));
    for (const all of [CHANGELOG, [...later, ...CHANGELOG]]) {
      const old = splitReleases(all).older;
      const last = old[0].date;
      // 0.1.0 shipped on 18 Oct 2026: its month and year are named only when the last day's differ.
      const first = last.startsWith("2026-10") ? "18" : last.startsWith("2026") ? "18 Oct" : "18 Oct 2026";
      expect(olderRange(old)).toBe(`${old[0].version} to 0.1.0, ${first} to ${shortDate(last)}`);
    }
    expect(older[0].version).toBe(CHANGELOG[3].version);
    // Across months, and across years; one release, one day.
    expect(olderRange([release("0.3.0", "2026-11-02"), release("0.2.0", "2026-10-18")])).toBe("0.3.0 to 0.2.0, 18 Oct to 2 Nov 2026");
    expect(olderRange([release("1.0.0", "2027-01-05"), release("0.9.0", "2026-12-30")])).toBe("1.0.0 to 0.9.0, 30 Dec 2026 to 5 Jan 2027");
    expect(olderRange([release("0.2.0", "2026-10-18"), release("0.1.0", "2026-10-18")])).toBe("0.2.0 to 0.1.0, 18 Oct 2026");
    expect(olderRange([release("0.1.0", "2026-10-18")])).toBe("0.1.0, 18 Oct 2026");
  });

  it("groups the release index by month, newest first, every release once", () => {
    const groups = byMonth(CHANGELOG);
    expect(groups[0].month).toBe("October 2026");
    expect(groups.flatMap((g) => g.releases)).toEqual([...CHANGELOG]);
    expect(byMonth([release("0.3.0", "2026-11-02"), release("0.2.0", "2026-10-18"), release("0.1.0", "2026-10-01")]).map((g) => [g.month, g.releases.length])).toEqual([
      ["November 2026", 1],
      ["October 2026", 2],
    ]);
  });
});
