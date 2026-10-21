import { describe, expect, it } from "vitest";
import { placeMenu, pointAnchor } from "./menu-place";

const VIEW = { width: 1440, height: 900 };
const SIZE = { width: 220, height: 150 };
const button = (left: number, top: number, w = 28, h = 28) => ({ left, top, right: left + w, bottom: top + h });

/** menu.ts before this change: below the element (4 px) or at the point, clamped 4 px inside. */
function today(anchor: { x: number; y: number }, size = SIZE, view = VIEW) {
  return {
    left: Math.max(4, Math.min(anchor.x, view.width - size.width - 4)),
    top: Math.max(4, Math.min(anchor.y, view.height - size.height - 4)),
  };
}

describe("placeMenu", () => {
  it("with room, gives today's result for an element and for a point", () => {
    const el = button(100, 50);
    expect(placeMenu(el, SIZE, VIEW, 4)).toEqual(today({ x: el.left, y: el.bottom + 4 }));
    expect(placeMenu(el, SIZE, VIEW, 4)).toEqual({ left: 100, top: 82 });
    expect(placeMenu(pointAnchor(300, 400), SIZE, VIEW, 0)).toEqual(today({ x: 300, y: 400 }));
    expect(placeMenu(pointAnchor(300, 400), SIZE, VIEW, 0)).toEqual({ left: 300, top: 400 });
  });

  it("flips left at the right edge: the menu's right edge at the anchor's right", () => {
    expect(placeMenu(pointAnchor(1400, 100), SIZE, VIEW, 0)).toEqual({ left: 1180, top: 100 });
    expect(placeMenu(button(1402, 100), SIZE, VIEW, 4)).toEqual({ left: 1430 - 220, top: 132 });
  });

  it("flips above at the bottom: the menu's bottom at the anchor's top minus the gap", () => {
    expect(placeMenu(pointAnchor(100, 850), SIZE, VIEW, 0)).toEqual({ left: 100, top: 700 });
    expect(placeMenu(button(100, 820), SIZE, VIEW, 4)).toEqual({ left: 100, top: 820 - 4 - 150 });
  });

  it("flips both ways in the bottom-right corner", () => {
    expect(placeMenu(pointAnchor(1400, 850), SIZE, VIEW, 0)).toEqual({ left: 1180, top: 700 });
  });

  it("a menu taller than the viewport starts 4 px from the top (the rest scrolls)", () => {
    expect(placeMenu(pointAnchor(100, 400), { width: 220, height: 1000 }, VIEW, 0)).toEqual({ left: 100, top: 4 });
  });

  it("a caret-line rect: 4 px below the line, or 4 px above it near the bottom", () => {
    expect(placeMenu({ left: 200, top: 300, right: 200, bottom: 322 }, SIZE, VIEW, 4)).toEqual({ left: 200, top: 326 });
    expect(placeMenu({ left: 200, top: 800, right: 200, bottom: 822 }, SIZE, VIEW, 4)).toEqual({ left: 200, top: 646 });
  });

  it("stays 4 px inside a 320 x 256 viewport", () => {
    const small = { width: 320, height: 256 };
    const size = { width: 220, height: 180 };
    expect(placeMenu(pointAnchor(200, 100), size, small, 0)).toEqual({ left: 4, top: 4 });
    expect(placeMenu(pointAnchor(10, 10), size, small, 0)).toEqual({ left: 10, top: 10 });
    const p = placeMenu(pointAnchor(300, 240), size, small, 0);
    expect(p.left).toBeGreaterThanOrEqual(4);
    expect(p.left + size.width).toBeLessThanOrEqual(small.width - 4);
    expect(p.top + size.height).toBeLessThanOrEqual(small.height - 4);
  });
});
