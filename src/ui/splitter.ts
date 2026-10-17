// Resizable regions: a focusable role="separator" (WAI-ARIA window splitter pattern,
// https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) with aria-valuenow/min/max, arrow keys
// (Shift for big steps), Home/End, Enter to restore the default, and pointer dragging. Dragging is
// never the only pointer way: the workbench offers buttons that call set() (WCAG 2.2 SC 2.5.7,
// Maximise panel and the file list's Wider / Narrower menu items). Sizes are kept on this device
// (localStorage "codeeditor:layout").
import { h } from "./dom";

export const LAYOUT_KEY = "codeeditor:layout";

export interface SplitterOptions {
  /** "vertical": a vertical bar between columns (resizes a width). */
  orientation: "vertical" | "horizontal";
  label: string;
  controls: string;
  min: number;
  max: () => number;
  initial: number;
  /** Step for one arrow press; Shift multiplies by 4. */
  step: number;
  /** Units shown to assistive technology. */
  unit: string;
  key: string;
  /** Turns a pointer position into a value. */
  fromPointer(e: PointerEvent): number;
  apply(value: number): void;
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function readLayout(): Record<string, number> {
  try {
    const data = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as unknown;
    return typeof data === "object" && data !== null ? (data as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeLayout(key: string, value: number): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readLayout(), [key]: Math.round(value) }));
  } catch {
    // storage blocked: the size lasts for this visit
  }
}

export interface Splitter {
  element: HTMLElement;
  /** The current size, in the splitter's unit. */
  readonly value: number;
  readonly min: number;
  max(): number;
  readonly initial: number;
  /** Sets (and remembers) a size: also how buttons resize without dragging (WCAG 2.5.7). */
  set(value: number): void;
  refresh(): void;
}

export function createSplitter(o: SplitterOptions): Splitter {
  const element = h("div", {
    class: `splitter ${o.orientation}`,
    role: "separator",
    tabindex: "0",
    "aria-orientation": o.orientation,
    "aria-label": o.label,
    "aria-controls": o.controls,
    "aria-valuemin": o.min,
  });
  const saved = readLayout()[o.key];
  let value = typeof saved === "number" && Number.isFinite(saved) ? saved : o.initial;

  function set(next: number, save = true) {
    value = clamp(Math.round(next), o.min, Math.max(o.min, o.max()));
    element.setAttribute("aria-valuenow", String(value));
    element.setAttribute("aria-valuemax", String(Math.round(Math.max(o.min, o.max()))));
    element.setAttribute("aria-valuetext", `${value} ${o.unit}`);
    o.apply(value);
    if (save) writeLayout(o.key, value);
  }

  element.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 4 : 1;
    const back = o.orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
    const fwd = o.orientation === "vertical" ? "ArrowRight" : "ArrowUp";
    if (e.key === back) set(value - o.step * big);
    else if (e.key === fwd) set(value + o.step * big);
    else if (e.key === "Home") set(o.min);
    else if (e.key === "End") set(o.max());
    else if (e.key === "Enter") set(o.initial);
    else return;
    e.preventDefault();
  });

  element.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    element.setPointerCapture(e.pointerId);
    element.dataset.dragging = "true";
    const move = (ev: PointerEvent) => set(o.fromPointer(ev), false);
    const up = (ev: PointerEvent) => {
      element.releasePointerCapture(ev.pointerId);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      delete element.dataset.dragging;
      set(value);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  });
  element.addEventListener("dblclick", () => set(o.initial));

  return {
    element,
    get value() {
      return value;
    },
    min: o.min,
    max: o.max,
    initial: o.initial,
    set: (v) => set(v),
    /** Re-clamps after the window or the surrounding region changed size. */
    refresh: () => set(value, false),
  };
}
