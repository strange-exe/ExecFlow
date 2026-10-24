// The commit messages a sync writes: plain text, named after the files it changed.
//
//   Add lab3/q2.c, update main.py and 2 more        <- subject: at most 72 characters
//                                                  <- blank line
//   Added: lab3/q2.c                               <- one line per non-empty list, at most
//   Changed: main.py, notes.txt, util.h            <-   BODY_NAMES names, then "and N more"
//
//   From: Chrome on Windows (CodeEditor)
//
// A subject the student typed replaces the automatic one; the lists and the From line stay. The
// paths were validated by the sync already, but every name, the device and a typed subject still
// pass through printable(): control, format (bidi, zero-width) and line-separator characters can't
// reach GitHub, so a message is always one subject line, then the body, and reads as it shows.
import { HIDDEN } from "../core/safety";

/** Git's customary subject length (GitHub cuts longer ones in its lists). */
export const SUBJECT_MAX = 72;
/** Names listed per body line before "and N more". */
export const BODY_NAMES = 20;

export interface CommitChanges {
  added: readonly string[];
  changed: readonly string[];
  deleted: readonly string[];
}

// Cc: C0 and C1 controls (tab and newlines too); Zl/Zp: line and paragraph separators. Cf: bidi
// embeddings and isolates, zero-width characters, the BOM, soft hyphens. HIDDEN adds the blank
// Hangul fillers (letters, not format characters) that core/safety already strips from text.
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT = /\p{Cf}/gu;

/** One printable line: breaks become spaces, invisible characters go, spaces collapse. */
export function printable(text: string): string {
  return text.replace(BREAKS, " ").replace(FORMAT, "").replace(HIDDEN, "").replace(/\s+/g, " ").trim();
}

/** At most `max` characters (code points, so no emoji is cut in two). */
function clamp(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
}

const length = (text: string) => [...text].length;

/** A one-line, printable device name for the From line. */
export function deviceLabel(name: string): string {
  return clamp(printable(name), 60) || "a browser";
}

/** A typed subject as it is used: one printable line of at most SUBJECT_MAX characters ("" = automatic). */
export function cleanSubject(text: string): string {
  return clamp(printable(text), SUBJECT_MAX);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

interface Group {
  verb: string;
  names: string[];
}

function groups(changes: CommitChanges): Group[] {
  const clean = (paths: readonly string[]) => paths.map((p) => printable(p) || "a file").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    { verb: "add", names: clean(changes.added) },
    { verb: "update", names: clean(changes.changed) },
    { verb: "delete", names: clean(changes.deleted) },
  ].filter((g) => g.names.length > 0);
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The subject naming the first `shown` names (in Add, Update, Delete order), whole names only. */
function namedSubject(list: readonly Group[], total: number, shown: number): string {
  const parts: string[] = [];
  let left = shown;
  for (const g of list) {
    if (left === 0) break;
    const take = g.names.slice(0, left);
    left -= take.length;
    parts.push(`${g.verb} ${take[0]}`, ...take.slice(1));
  }
  const text = shown === total ? joinAnd(parts) : `${parts.join(", ")} and ${total - shown} more`;
  return sentence(text);
}

/** The automatic subject: as many whole names as fit in SUBJECT_MAX, else counts ("Update 3 files"). */
export function autoSubject(changes: CommitChanges): string {
  const list = groups(changes);
  const total = list.reduce((n, g) => n + g.names.length, 0);
  if (total === 0) return "Sync from CodeEditor";
  const all = namedSubject(list, total, total);
  if (length(all) <= SUBJECT_MAX) return all;
  // Each extra name adds at least ", x" while "and N more" loses at most a digit, so the length
  // grows with `shown`: the first that doesn't fit ends the search.
  let best: string | null = null;
  for (let shown = 1; shown < total; shown++) {
    const s = namedSubject(list, total, shown);
    if (length(s) > SUBJECT_MAX) break;
    best = s;
  }
  return best ?? sentence(joinAnd(list.map((g) => `${g.verb} ${plural(g.names.length, "file")}`)));
}

/** "a, b and c", or the first BODY_NAMES names "and N more". */
function bodyList(names: readonly string[]): string {
  if (names.length <= BODY_NAMES) return joinAnd(names);
  return `${names.slice(0, BODY_NAMES).join(", ")} and ${names.length - BODY_NAMES} more`;
}

/**
 * The whole message: the subject (typed, or automatic when `typed` is empty after cleaning), a blank
 * line, the Added/Changed/Deleted lines that aren't empty, a blank line, and the From line.
 */
export function commitMessage(changes: CommitChanges, device: string, typed = ""): string {
  const subject = cleanSubject(typed) || autoSubject(changes);
  const label: Record<string, string> = { add: "Added", update: "Changed", delete: "Deleted" };
  const lines = groups(changes).map((g) => `${label[g.verb]}: ${bodyList(g.names)}`);
  return [subject, "", ...lines, ...(lines.length ? [""] : []), `From: ${deviceLabel(device)} (CodeEditor)`].join("\n");
}
