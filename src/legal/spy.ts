/**
 * Which numbered section of a legal page is being read (src/legal/page.ts's scroll spy).
 *
 * `tops` are the headings' distances from the window's top, in page order; `line` is the reading
 * line (the top fifth of the window, at most 160 px). The section being read is the last heading
 * at or above that line; -1 means none yet (the title and the short version).
 *
 * A section chosen from a list or an old link (`pinned`) stays current while its heading is in the
 * window and the reading line hasn't reached it: the last sections are too short to scroll up to
 * the line, and choosing one must still mark it. Scrolling it out of the window releases it.
 */
export function readingIndex(tops: readonly number[], line: number, pinned = -1, viewport = Infinity): number {
  let at = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= line) at = i;
  if (pinned < 0 || pinned >= tops.length) return at;
  const visible = tops[pinned] >= 0 && tops[pinned] < viewport;
  return visible && at < pinned ? pinned : at;
}

/**
 * True when scrolling can bring a heading up to the reading line: `pageTop` is its distance from
 * the top of the page, `maxScroll` the page's scroll range. Only a heading that can't (the short
 * sections at the end) needs a pin; any other one reaches the line, and the spy finds it there.
 */
export function reachesLine(pageTop: number, line: number, maxScroll: number): boolean {
  return pageTop - line <= maxScroll + 1;
}

/** True when the pinned heading has left the window, so the pin should be dropped. */
export function pinReleased(top: number, viewport: number): boolean {
  return top < 0 || top >= viewport;
}
