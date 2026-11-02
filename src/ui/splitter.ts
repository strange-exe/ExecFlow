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
  /**
   * The default size. A function is a default that follows the window (the boards' equal split):
   * until the user picks a size, and again after Enter or a double-click, nothing is stored and the
   * size follows it.
   */
  initial: number | (() => number);
  /**
   * The region the value sizes lies after the bar (right of a vertical one, below a horizontal one),
   * so the arrow that moves the bar towards it makes it bigger: ArrowLeft for a vertical bar,
   * ArrowUp for a horizontal one. Otherwise ArrowRight (vertical) grows it.
   */
  after?: boolean;
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

/** Stores a size (a number), or forgets it (null: the default applies again). */
function writeLayout(key: string, value: number | null): void {
  try {
    const next: Record<string, number> = { ...readLayout() };
    if (value === null) delete next[key];
    else next[key] = Math.round(value);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the size lasts for this visit
  }
}

/**
 * A remembered on/off choice of the layout (the chart board hidden, the output beside the code),
 * kept with the sizes as 1 or 0. Null: never chosen on this device.
 */
export function readLayoutFlag(key: string): boolean | null {
  const v = readLayout()[key];
  return v === 1 ? true : v === 0 ? false : null;
}

export function writeLayoutFlag(key: string, on: boolean): void {
  writeLayout(key, on ? 1 : 0);
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

/**
 * The size the user asked for and the size the window allows now, kept apart: a window too small
 * for the wanted size applies less, and the wanted size comes back once there is room again (a
 * phone-wide window used to overwrite a 248 px file list with its 200 px for good). A user's
 * choice (a key, a drag, a button) becomes the wanted size as far as the window allows it then.
 */
export function sizeModel(o: { min: number; max: () => number; wanted: number | (() => number) }) {
  const fit = (v: number) => clamp(Math.round(v), o.min, Math.max(o.min, o.max()));
  const start = o.wanted;
  // Null: no size chosen, so the default (a function of the window) is wanted.
  let chosen: number | null = typeof start === "number" ? Math.round(start) : null;
  const wanted = () => chosen ?? Math.round((start as () => number)());
  return {
    get wanted() {
      return wanted();
    },
    /** Whether the size follows a default that is a function (nothing chosen). */
    get following() {
      return chosen === null;
    },
    /** The size to apply now. */
    get value() {
      return fit(wanted());
    },
    set(next: number): number {
      chosen = fit(next);
      return chosen;
    },
    /** Back to the default: a following default follows again. */
    reset(): void {
      chosen = typeof start === "number" ? Math.round(start) : null;
    },
  };
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
  const size = sizeModel({ min: o.min, max: o.max, wanted: typeof saved === "number" && Number.isFinite(saved) ? saved : o.initial });
  const initial = () => Math.round(typeof o.initial === "function" ? o.initial() : o.initial);
  let value = size.value;

  /** Applies the wanted size as far as the window allows it now. */
  function show() {
    value = size.value;
    element.setAttribute("aria-valuenow", String(value));
    element.setAttribute("aria-valuemax", String(Math.round(Math.max(o.min, o.max()))));
    element.setAttribute("aria-valuetext", `${value} ${o.unit}`);
    o.apply(value);
  }

  function set(next: number, save = true) {
    size.set(next);
    show();
    if (save) writeLayout(o.key, size.wanted);
  }

  /** Enter and a double-click: the default size (one that follows the window is not stored). */
  function restore() {
    if (typeof o.initial !== "function") return set(o.initial);
    size.reset();
    show();
    writeLayout(o.key, null);
  }

  element.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 4 : 1;
    // A horizontal bar has always sized the region below it (the panel): ArrowUp grows it.
    const after = o.after ?? o.orientation === "horizontal";
    // The keys that move the bar towards the start (left, up) and towards the end (right, down).
    const [toStart, toEnd] = o.orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const back = after ? toEnd : toStart;
    const fwd = after ? toStart : toEnd;
    if (e.key === back) set(value - o.step * big);
    else if (e.key === fwd) set(value + o.step * big);
    else if (e.key === "Home") set(o.min);
    else if (e.key === "End") set(o.max());
    else if (e.key === "Enter") restore();
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
  element.addEventListener("dblclick", restore);

  return {
    element,
    get value() {
      return value;
    },
    min: o.min,
    max: o.max,
    get initial() {
      return initial();
    },
    set: (v) => set(v),
    /** Applies the wanted size again after the window or the surrounding region changed size. */
    refresh: show,
  };
}
