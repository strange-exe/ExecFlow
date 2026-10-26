// The bottom panel's height when the Flowchart tab opens on desktop (owner, 2026-10-26): "grow the
// bottom panel taller if it's small, and keep my own size otherwise." 55 percent of the centre
// column shows a useful chart (at 900 px tall, about 420 px: a loop with a decision and its branches
// at full size) and still leaves the editor nearly half. The editor's row always keeps EDITOR_KEEP
// px (its head and about six lines of code), so in a short window the panel grows only as far.
export const CHART_PANEL = 55;
export const EDITOR_KEEP = 220;

/**
 * The panel's new size in percent, or null to leave it: never smaller than `current`, never above
 * CHART_PANEL or the splitter's `max`, and never so tall that a `columnPx` column (the editor's and
 * the panel's rows; 0 when not laid out yet) leaves the editor less than EDITOR_KEEP px.
 */
export function chartPanelSize(current: number, columnPx: number, max = 100): number | null {
  let target = Math.min(CHART_PANEL, max);
  if (columnPx > 0) target = Math.min(target, Math.floor(((columnPx - EDITOR_KEEP) / columnPx) * 100));
  return target > current ? target : null;
}
