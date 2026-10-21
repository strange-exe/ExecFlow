// Where a menu goes (final-v3 section 7.9 item 3): below and right of its anchor when it fits, else
// above or left of it, then kept 4 px inside the viewport. When the menu fits, the result is what
// menu.ts always gave (below an element by 4 px, or at the pointer); near the bottom or right edge
// a menu flips instead of covering what it was opened from, as native menus do.

/** An element's box, a caret line, or a point (a zero-size box). */
export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The menu's distance from the viewport's edges. */
export const EDGE = 4;

export const pointAnchor = (x: number, y: number): AnchorRect => ({ left: x, top: y, right: x, bottom: y });

export function placeMenu(
  anchor: AnchorRect,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  gap: number,
): { left: number; top: number } {
  let left = anchor.left;
  if (left + size.width > viewport.width - EDGE) left = anchor.right - size.width;
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height - EDGE) top = anchor.top - gap - size.height;
  return {
    left: Math.max(EDGE, Math.min(left, viewport.width - size.width - EDGE)),
    top: Math.max(EDGE, Math.min(top, viewport.height - size.height - EDGE)),
  };
}
