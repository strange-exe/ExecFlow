// The commit messages a sync writes: plain text, named after the files it changed.
//
//   Add lab3/q2.c, update main.py and 2 more        <- subject: at most 72 characters
//                                                  <- blank line
//   Added:                                         <- one section per non-empty list: a heading,
//     lab3/q2.c                                    <-   then one name per line, at most BODY_NAMES,
//                                                  <-   then "and N more"; blank lines between
//   Changed:
//     main.py
//     notes.txt
//     util.h
//
//   From: Chrome on Windows (ExecFlow)
//
// A subject the student typed replaces the automatic one; the lists and the From line stay. The
// paths were validated by the sync already, but every name, the device and a typed subject still
// pass through printable(): control, format (bidi, zero-width), default-ignorable (variation
// selectors, tag characters, fillers) and line-separator characters can't reach GitHub, so a
// message is always one subject line, then the body, and reads as it shows. A name that would read
// as more of the subject's sentence (", ", " and ", "and N more", a quote) is quoted there; one
// with a double quote can't be quoted unambiguously, so it is counted instead of named.
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
// embeddings and isolates, zero-width characters, the BOM, soft hyphens. Default_Ignorable_Code_Point
// (Unicode's list of characters that render as nothing): variation selectors U+FE00..U+FE0F and
// U+E0100..U+E01EF, the combining grapheme joiner U+034F, Mongolian selectors U+180B..U+180F, the
// Hangul and Khmer fillers U+115F, U+1160, U+17B4, U+17B5, U+3164, U+FFA0, and the tags block
// U+E0000..U+E0FFF. HIDDEN is core/safety's own list (all of it is in these classes too).
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// The zero-width non-joiner and joiner (U+200C, U+200D) shape Hindi and other Indic names: kept,
// as core/safety keeps them (its HIDDEN list leaves them out wherever they are).
const JOINERS = new Set([0x200c, 0x200d].map((c) => String.fromCodePoint(c)));

/** One printable line: breaks become spaces, invisible characters go, spaces collapse. */
export function printable(text: string): string {
  return text
    .replace(BREAKS, " ")
    .replace(INVISIBLE, (c) => (JOINERS.has(c) ? c : ""))
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim();
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

/** A character class of these code points (built from numbers, so the source stays ASCII). */
const anyOf = (...codes: number[]) => new RegExp(`[${String.fromCodePoint(...codes)}]`, "u");
// Double quotes (ASCII, the curly pair, the low and reversed ones, fullwidth): a name holding one
// can't be wrapped in quotes without seeming to end early, so it is never named in a subject.
const DOUBLE_QUOTE = anyOf(0x22, 0x201c, 0x201d, 0x201e, 0x201f, 0xff02);
// Other quote marks: the ASCII apostrophe and backtick, the single low quote and the fullwidth
// apostrophe; INITIAL_FINAL adds the curly single quotes and the guillemets.
const QUOTE = anyOf(0x27, 0x60, 0x201a, 0xff07);
const INITIAL_FINAL = /[\p{Pi}\p{Pf}]/u;
// What the subject's own sentence is made of: ", " between names, " and " before the last, and a
// closing "and N more".
const LIST_WORDS = /, | and |(?:^|\s)and \d+ more$/;
/** A body line that only the cap line may be. */
const CAP_LINE = /^and \d+ more$/;

/** A name as the subject shows it: as it is, in double quotes, or null (only a count can stand for it). */
function subjectName(name: string): string | null {
  if (DOUBLE_QUOTE.test(name)) return null;
  return LIST_WORDS.test(name) || QUOTE.test(name) || INITIAL_FINAL.test(name) ? `"${name}"` : name;
}

/** The subject naming the first `shown` names (in Add, Update, Delete order), whole names only; null when one can't be named. */
function namedSubject(list: readonly Group[], total: number, shown: number): string | null {
  const parts: string[] = [];
  let left = shown;
  for (const g of list) {
    if (left === 0) break;
    const take = g.names.slice(0, left).map(subjectName);
    if (take.some((n) => n === null)) return null;
    left -= take.length;
    parts.push(`${g.verb} ${take[0]}`, ...(take.slice(1) as string[]));
  }
  const text = shown === total ? joinAnd(parts) : `${parts.join(", ")} and ${total - shown} more`;
  return sentence(text);
}

/** The automatic subject: as many whole names as fit in SUBJECT_MAX, else counts ("Update 3 files"). */
export function autoSubject(changes: CommitChanges): string {
  const list = groups(changes);
  const total = list.reduce((n, g) => n + g.names.length, 0);
  if (total === 0) return "Sync from ExecFlow";
  const all = namedSubject(list, total, total);
  if (all !== null && length(all) <= SUBJECT_MAX) return all;
  // Each extra name adds at least ", x" while "and N more" loses at most a digit, so the length
  // grows with `shown`: the first that doesn't fit (or can't be named) ends the search.
  let best: string | null = null;
  for (let shown = 1; shown < total; shown++) {
    const s = namedSubject(list, total, shown);
    if (s === null || length(s) > SUBJECT_MAX) break;
    best = s;
  }
  return best ?? sentence(joinAnd(list.map((g) => `${g.verb} ${plural(g.names.length, "file")}`)));
}

/** A section of the body: the heading, then one indented name per line, the first BODY_NAMES and "and N more". */
function bodySection(heading: string, names: readonly string[]): string[] {
  const lines = names.slice(0, BODY_NAMES).map((n) => `  ${CAP_LINE.test(n) ? `"${n}"` : n}`);
  if (names.length > BODY_NAMES) lines.push(`  and ${names.length - BODY_NAMES} more`);
  return [`${heading}:`, ...lines];
}

/**
 * The whole message: the subject (typed, or automatic when `typed` is empty after cleaning), a blank
 * line, the Added/Changed/Deleted sections that aren't empty (blank lines between), a blank line,
 * and the From line.
 */
export function commitMessage(changes: CommitChanges, device: string, typed = ""): string {
  const subject = cleanSubject(typed) || autoSubject(changes);
  const label: Record<string, string> = { add: "Added", update: "Changed", delete: "Deleted" };
  const lines = groups(changes).flatMap((g, i) => [...(i > 0 ? [""] : []), ...bodySection(label[g.verb], g.names)]);
  return [subject, "", ...lines, ...(lines.length ? [""] : []), `From: ${deviceLabel(device)} (ExecFlow)`].join("\n");
}
