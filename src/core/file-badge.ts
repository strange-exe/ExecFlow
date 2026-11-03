// File-type badges (redesign 8, menus "Flow rail", 2026-11-03): the mark beside a file's name in the
// file list and the tabs. Three looks were drawn for the owner to choose from
// (.claude/design/redesign8/menus/badges.html); BADGE_LOOK is the one the app shows, and switching
// it is the whole change (app.css styles every look by its data-look). The badge is decoration: the
// name already ends with the extension, so the word is a second cue, never the only one.
import { detectLanguage, isHeader } from "./languages";

/** A: a folded page with the extension; B: the extension in its language's syntax colour; C: a solid chip. */
export type BadgeLook = "sheet" | "hue" | "tile";

/** The look the app shows (the owner's pick goes here). */
export const BADGE_LOOK: BadgeLook = "sheet";

export type BadgeKind = "python" | "c" | "cpp" | "header" | "text";

const TEXT = /\.(txt|md|csv|json|in|out|dat)$/i;

/** The file's type for its badge, or null (no badge: only its room is kept). */
export function badgeKind(path: string): BadgeKind | null {
  const lang = detectLanguage(path)?.id;
  if (lang) return lang;
  if (isHeader(path)) return "header";
  return TEXT.test(path) ? "text" : null;
}

/** Each look's word per type. */
export const BADGE_WORDS: Readonly<Record<BadgeLook, Readonly<Record<BadgeKind, string>>>> = {
  sheet: { python: "py", c: "c", cpp: "cpp", header: "h", text: "txt" },
  hue: { python: "py", c: "c", cpp: "c++", header: "h", text: "txt" },
  tile: { python: "Py", c: "C", cpp: "C++", header: "H", text: "Txt" },
};

/** The word a file's badge shows ("" for a file of no known type). */
export function badgeWord(path: string, look: BadgeLook = BADGE_LOOK): string {
  const kind = badgeKind(path);
  return kind ? BADGE_WORDS[look][kind] : "";
}
