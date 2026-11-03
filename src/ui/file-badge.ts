// The file-type badge as drawn: one element for the file list and the tabs. Its look comes from
// core/file-badge.ts (BADGE_LOOK, the one line to change for another look); app.css draws each look.
import { BADGE_LOOK, badgeKind, badgeWord } from "../core/file-badge";
import { h } from "./dom";

/** span.file-badge: decoration (aria-hidden), empty for a file of no known type (its room is kept). */
export function fileBadge(path: string, extraClass = ""): HTMLSpanElement {
  const kind = badgeKind(path);
  return h(
    "span",
    { class: `file-badge${extraClass ? ` ${extraClass}` : ""}`, "aria-hidden": "true", "data-look": BADGE_LOOK, "data-kind": kind },
    badgeWord(path),
  );
}
