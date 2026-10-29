// What the About page's release timeline shows (redesign6/whatsnew): the latest releases open, the
// older ones behind one button that names their range, a release's changes ordered by kind and
// folded after the first few, and an index by month. No DOM code here: page.ts draws it.
import { KINDS, type Kind, type Release } from "./changelog";

/** Releases shown open; the rest wait behind "Show N older releases" (still in the page). */
export const OPEN_RELEASES = 3;
/** Changes shown per release before "Show all N changes". */
export const ITEMS_SHOWN = 6;

export const KIND_WORD: Record<Kind, string> = { added: "Added", changed: "Changed", fixed: "Fixed" };

type Item = Release["items"][number];

/** The fragment id of a release's title: "v0-4-0" for 0.4.0 (so /about#v0-4-0 opens it). */
export const releaseId = (version: string): string => `v${version.replaceAll(".", "-")}`;

export function splitReleases(all: readonly Release[]): { recent: readonly Release[]; older: readonly Release[] } {
  return { recent: all.slice(0, OPEN_RELEASES), older: all.slice(OPEN_RELEASES) };
}

/** Added, then Changed, then Fixed; the data's order within each kind. */
export function byKind(items: readonly Item[]): Item[] {
  return KINDS.flatMap((k) => items.filter((i) => i.kind === k));
}

/** "2 added, 2 changed, 10 fixed": only the kinds the release has. */
export function countLine(items: readonly Item[]): string {
  return KINDS.map((k) => [k, items.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

// The dates are days, not instants: read and written in UTC so no time zone moves them.
function day(iso: string, opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
/** "29 Oct 2026" */
export const shortDate = (iso: string): string => day(iso, { day: "numeric", month: "short", year: "numeric" });
/** "18 October 2026" */
export const longDate = (iso: string): string => day(iso, { day: "numeric", month: "long", year: "numeric" });
/** "October 2026" */
const monthOf = (iso: string): string => day(iso, { month: "long", year: "numeric" });

/** "18 to 27 Oct 2026", "18 Oct to 2 Nov 2026", "30 Dec 2026 to 5 Jan 2027": first day to last. */
function dayRange(first: string, last: string): string {
  if (first === last) return shortDate(last);
  const from =
    first.slice(0, 7) === last.slice(0, 7)
      ? day(first, { day: "numeric" })
      : first.slice(0, 4) === last.slice(0, 4)
        ? day(first, { day: "numeric", month: "short" })
        : shortDate(first);
  return `${from} to ${shortDate(last)}`;
}

/** "0.7.0 to 0.1.0, 18 to 27 Oct 2026" for releases newest first. */
export function olderRange(older: readonly Release[]): string {
  const newest = older[0];
  const oldest = older[older.length - 1];
  const versions = newest === oldest ? newest.version : `${newest.version} to ${oldest.version}`;
  return `${versions}, ${dayRange(oldest.date, newest.date)}`;
}

export const showAllLabel = (total: number): string => `Show all ${total} changes (${total - ITEMS_SHOWN} more)`;

export const olderLabel = (n: number): string => `Show ${n} older release${n === 1 ? "" : "s"}`;

/** The index's groups: one per month, newest first, in the data's order. */
export function byMonth(releases: readonly Release[]): { month: string; releases: Release[] }[] {
  const groups: { month: string; releases: Release[] }[] = [];
  for (const r of releases) {
    const month = monthOf(r.date);
    if (groups.at(-1)?.month !== month) groups.push({ month, releases: [] });
    groups[groups.length - 1].releases.push(r);
  }
  return groups;
}
