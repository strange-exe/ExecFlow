// Design and accessibility helpers for a11y.spec.ts (from the design review, 2026-10-17): an
// in-page crawl of what is really painted, and what has keyboard focus. Read-only: nothing here
// changes the page.
import type { Page } from "@playwright/test";

export interface PaintedPair {
  kind: "text" | "placeholder" | "icon" | "field-border";
  sel: string;
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  size: number;
  weight: number;
  image: boolean;
}

export interface Target {
  sel: string;
  name: string;
  w: number;
  h: number;
  /** WCAG 2.5.8 spacing exception: a 24 px circle on its centre touches no other target. */
  spaced: boolean;
  /** The first target it touches, when not spaced. */
  by: string;
}

export interface Truncated {
  sel: string;
  text: string;
  shown: number;
  full: number;
  title: string;
}

export interface Audit {
  tokens: Record<string, string>;
  pairs: PaintedPair[];
  targets: Target[];
  truncated: Truncated[];
  overflow: { scrollWidth: number; clientWidth: number; wide: string[] };
  fontSizes: number[];
}

/** The colour tokens recorded with each view (src/theme/contrast.ts COLOR_VARS, contract v2). */
export const COLOR_VARS = [
  "bg", "surface", "surface-raised", "terminal-bg", "terminal-fg", "runlog-bg", "divider", "border", "border-strong",
  "text", "text-secondary", "text-muted", "gutter-text",
  "action", "action-hover", "on-action", "control-on",
  "focus", "selection", "list-selected", "active-line", "location",
  "danger", "warning", "success", "info",
  "error-band", "call-site", "input-echo",
  "link", "brand", "on-brand",
  "syn-keyword", "syn-string", "syn-number", "syn-comment", "syn-function", "syn-type", "syn-variable",
  "syn-operator", "syn-macro", "syn-punctuation",
];

/** Everything painted in the open dialog (or the whole page when none is open). */
export function audit(page: Page): Promise<Audit> {
  return page.evaluate((vars: string[]) => {
    type RGBA = [number, number, number, number];
    const rootStyle = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const v of vars) tokens[v] = rootStyle.getPropertyValue(`--${v}`).trim().toLowerCase();

    const parse = (input: string): RGBA | null => {
      const c = input.trim();
      if (c === "transparent") return [0, 0, 0, 0];
      let m = c.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x)));
        return [p[0], p[1], p[2], p[3] ?? 1];
      }
      m = c.match(/^color\(srgb\s+([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
      }
      return null;
    };
    const over = (top: RGBA, base: RGBA): RGBA => {
      const a = top[3] + base[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const ch = (i: number) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const hex = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
    const bgOf = (el: Element | null): { c: RGBA; image: boolean } => {
      const layers: RGBA[] = [];
      let image = false;
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== "none") image = true;
        const c = parse(s.backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let acc: RGBA = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return { c: acc, image };
    };
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
      const role = el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "";
      const parent = el.parentElement;
      const pcls = parent && typeof parent.className === "string" && parent.className ? `${parent.tagName.toLowerCase()}.${parent.className.trim().split(/\s+/)[0]} > ` : "";
      return `${pcls}${el.tagName.toLowerCase()}${id}${cls}${role}`;
    };
    const clippedAway = (el: Element) => {
      for (let e = el.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
          const pr = e.getBoundingClientRect();
          if (pr.width < 1 || pr.height < 1) return true;
        }
      }
      return false;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      if (s.visibility !== "visible" || s.display === "none") return false;
      if (el.closest(".visually-hidden, [hidden]")) return false;
      return !clippedAway(el);
    };
    // A control a scrolling ancestor has scrolled wholly out of its box can't be pointed at there.
    // Targets only: text pairs keep counting what is laid out (visible()).
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      for (let e = el.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const pr = e.getBoundingClientRect();
        if (r.bottom <= pr.top || r.top >= pr.bottom || r.right <= pr.left || r.left >= pr.right) return false;
      }
      return true;
    };
    const opacityOf = (el: Element) => {
      let op = 1;
      for (let e: Element | null = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity) || 1;
      return op;
    };
    const disabled = (el: Element) => Boolean(el.closest(":disabled, [aria-disabled='true']"));

    const scope: Element = document.querySelector("dialog[open]") ?? document.body;
    const pairs: PaintedPair[] = [];
    const perKey = new Map<string, number>();
    const push = (p: PaintedPair) => {
      const key = `${p.kind}|${p.fg}|${p.bg}|${p.min}`;
      const n = perKey.get(key) ?? 0;
      perKey.set(key, n + 1);
      if (n < 3) pairs.push(p);
    };
    const sizes = new Set<number>();

    for (const el of scope.querySelectorAll("*")) {
      if (el.closest("svg")) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      if (!own.length || !visible(el) || disabled(el)) continue;
      const s = getComputedStyle(el);
      const fg0 = parse(s.color);
      if (!fg0) continue;
      const { c: bg, image } = bgOf(el);
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacityOf(el)], bg);
      const size = parseFloat(s.fontSize);
      const weight = parseInt(s.fontWeight, 10) || 400;
      sizes.add(Math.round(size * 10) / 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      push({
        kind: "text", sel: describe(el), text: own.map((n) => n.textContent).join("").trim().slice(0, 48),
        fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, min: large ? 3 : 4.5, size, weight, image,
      });
    }

    // Placeholders (painted by the browser's own style unless the app sets one).
    for (const el of scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[placeholder], textarea[placeholder]")) {
      if (!visible(el) || el.value) continue;
      const ps = getComputedStyle(el, "::placeholder");
      const fg0 = parse(ps.color);
      if (!fg0) continue;
      const { c: bg, image } = bgOf(el);
      const op = (parseFloat(ps.opacity) || 1) * opacityOf(el);
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
      push({
        kind: "placeholder", sel: describe(el), text: el.placeholder.slice(0, 48),
        fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, min: 4.5, size: parseFloat(ps.fontSize), weight: parseInt(ps.fontWeight, 10) || 400, image,
      });
    }

    // Icons (currentColor) against what is behind them: 3:1 when they carry meaning.
    for (const svgEl of scope.querySelectorAll("svg")) {
      if (!visible(svgEl) || disabled(svgEl)) continue;
      const s = getComputedStyle(svgEl);
      const fg0 = parse(s.color);
      if (!fg0) continue;
      const { c: bg, image } = bgOf(svgEl.parentElement);
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacityOf(svgEl)], bg);
      const control = svgEl.closest("button, a, [role=tab], [role=treeitem]");
      const iconOnly = Boolean(control && !(control.textContent ?? "").trim());
      push({
        kind: "icon", sel: `${iconOnly ? "icon-only " : ""}${describe(svgEl.parentElement ?? svgEl)} svg.${(svgEl.getAttribute("class") ?? "").split(/\s+/).join(".")}`,
        text: control?.getAttribute("aria-label") ?? "", fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, min: 3, size: 0, weight: 0, image,
      });
    }

    // Text field boundaries: against the surface around them (1.4.11, 3:1).
    for (const el of scope.querySelectorAll<HTMLElement>("input[type=text], input[type=number], input[type=password], input:not([type]), textarea, select")) {
      if (!visible(el) || disabled(el)) continue;
      const s = getComputedStyle(el);
      if (s.borderTopStyle === "none") continue;
      const b0 = parse(s.borderTopColor);
      if (!b0) continue;
      const { c: outside, image } = bgOf(el.parentElement);
      const border = over(b0, outside);
      push({
        kind: "field-border", sel: describe(el), text: el.getAttribute("aria-label") ?? el.id,
        fg: hex(border), bg: hex(outside), ratio: Math.round(ratio(border, outside) * 100) / 100, min: 3, size: 0, weight: 0, image,
      });
    }

    // Pointer targets (2.5.8): every control drawn, with the spacing exception worked out.
    const targetSel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=tab], [role=menuitem], [role=option], [role=treeitem] > .tree-row, [role=separator], [tabindex]:not([tabindex='-1'])";
    const controls = [...scope.querySelectorAll<HTMLElement>(targetSel)].filter((el) => !el.closest(".cm-content, .cm-scroller") && visible(el) && inView(el) && !(el.getAttribute("role") === "treeitem"));
    const rects = controls.map((el) => {
      let r = el.getBoundingClientRect();
      // A splitter's grab area is its ::after (inset 0 -5px or -5px 0).
      if (el.getAttribute("role") === "separator") {
        const a = getComputedStyle(el, "::after");
        const l = -parseFloat(a.left || "0") || 0;
        const t = -parseFloat(a.top || "0") || 0;
        r = new DOMRect(r.left - l, r.top - t, r.width + 2 * l, r.height + 2 * t);
      }
      return r;
    });
    const targets: Target[] = [];
    controls.forEach((el, i) => {
      const r = rects[i];
      if (r.width >= 24 && r.height >= 24) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const touching = rects.findIndex((o, j) => {
        if (j === i) return false;
        if (controls[j].contains(el) || el.contains(controls[j])) return false;
        const nx = Math.max(o.left, Math.min(cx, o.right));
        const ny = Math.max(o.top, Math.min(cy, o.bottom));
        const undersized = o.width < 24 || o.height < 24;
        const d = Math.hypot(nx - cx, ny - cy);
        if (d < 12) return true;
        if (undersized) return Math.hypot(o.left + o.width / 2 - cx, o.top + o.height / 2 - cy) < 24;
        return false;
      });
      // Inline links in a sentence are exempt; mark them so the report can say so.
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      targets.push({
        sel: `${inline ? "inline " : ""}${describe(el)}`,
        name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40),
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, spaced: touching < 0,
        by: touching < 0 ? "" : `${describe(controls[touching])} ${Math.round(rects[touching].width)}x${Math.round(rects[touching].height)}`,
      });
    });

    // Text cut off with an ellipsis (or clipped) and no other way to read it here.
    const truncated: Truncated[] = [];
    for (const el of scope.querySelectorAll<HTMLElement>("*")) {
      if (!visible(el) || el.closest(".cm-editor")) continue;
      const s = getComputedStyle(el);
      if (s.overflowX === "visible" && s.textOverflow !== "ellipsis") continue;
      if (el.scrollWidth <= el.clientWidth + 1 || !(el.textContent ?? "").trim()) continue;
      if (s.overflowX === "auto" || s.overflowX === "scroll") continue; // scrolls: nothing lost
      truncated.push({
        sel: describe(el), text: (el.textContent ?? "").trim().slice(0, 80), shown: el.clientWidth, full: el.scrollWidth,
        title: el.closest("[title]")?.getAttribute("title") ?? "",
      });
    }

    const w = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > w + 0.5 && visible(el))
      .slice(0, 8)
      .map((el) => `${describe(el)} right=${Math.round(el.getBoundingClientRect().right)}`);
    return {
      tokens, pairs, targets, truncated,
      overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: w, wide },
      fontSizes: [...sizes].sort((a, b) => a - b),
    };
  }, COLOR_VARS);
}

export interface FocusStop {
  tag: string;
  id: string;
  cls: string;
  role: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  outline: string;
  shadow: string;
  /** The editor's gutter-edge focus bar (the ::after of .cm-gutters), when the editor has focus. */
  bar: string;
  indicator: boolean;
  ringContrast: number | null;
  visible: boolean;
  clipped: string[];
  inDialog: boolean;
  inViewport: boolean;
}

/** What has focus now, and whether a sighted keyboard user can see where it is. */
export function focusStop(page: Page): Promise<FocusStop> {
  return page.evaluate(async () => {
    // Let two frames pass before looking. CodeMirror sets .cm-focused (which draws the editor's
    // focus bar) from a 10 ms timer after the focus event (view 6.43.14 updateForFocusChange), and
    // headless Firefox can run two frames sooner (measured 2026-10-19: the class came 11 ms after
    // focus every time, two frames had passed first in 10 of 12 tries). So for the editor, wait for
    // that state too, at most 500 ms: if it never comes, the stop is still reported without an indicator.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const focusedEditor = document.activeElement?.classList.contains("cm-content") ? document.activeElement.closest(".cm-editor") : null;
    for (const until = performance.now() + 500; focusedEditor && !focusedEditor.classList.contains("cm-focused") && performance.now() < until; ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    type RGBA = [number, number, number, number];
    const parse = (input: string): RGBA | null => {
      const c = input.trim();
      if (c === "transparent") return [0, 0, 0, 0];
      let m = c.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        return [p[0], p[1], p[2], p[3] ?? 1];
      }
      m = c.match(/^color\(srgb\s+([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
      }
      return null;
    };
    const over = (top: RGBA, base: RGBA): RGBA => {
      const a = top[3] + base[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const ch = (i: number) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const bgOf = (el: Element | null): RGBA => {
      const layers: RGBA[] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let acc: RGBA = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    const el = document.activeElement as HTMLElement | null;
    const empty = { tag: el?.tagName.toLowerCase() ?? "none", id: "", cls: "", role: "", name: "", rect: { x: 0, y: 0, w: 0, h: 0 }, outline: "", shadow: "", bar: "", indicator: false, ringContrast: null, visible: false, clipped: [], inDialog: false, inViewport: false };
    if (!el || el === document.body) return empty;
    let ind: Element = el;
    if (el.getAttribute("role") === "treeitem") ind = el.querySelector(":scope > .tree-row") ?? el;
    // The output log's ring is drawn on its scroller, inset, so scrolling never cuts it (app.css).
    if (el.id === "console") ind = el.closest(".console-scroll") ?? el;
    // The editor's indicator is a 2 px --focus bar on the gutter's right edge, drawn as the
    // ::after of .cm-gutters (editor/highlight.ts). It counts only when it is really drawn: generated
    // (content not none), at least 2 px wide and opaque; its contrast is then measured against the
    // gutter's own ground, like a ring's. Without it, the editor's own outline is what counts.
    let bar: { c: RGBA; on: RGBA; text: string } | null = null;
    if (el.classList.contains("cm-content")) {
      const editor = el.closest(".cm-editor");
      ind = editor ?? el;
      const gutters = editor?.querySelector(":scope > .cm-scroller > .cm-gutters");
      if (gutters) {
        const a = getComputedStyle(gutters, "::after");
        const c = parse(a.backgroundColor);
        const width = parseFloat(a.width) || 0;
        const drawn = !/^(none|normal)$/.test(a.content) && a.display !== "none" && a.visibility === "visible";
        if (drawn && width >= 2 && c && c[3] >= 1 && gutters.getBoundingClientRect().height >= 1) {
          bar = { c, on: bgOf(gutters), text: `${a.width} ${a.backgroundColor}` };
          ind = gutters;
        }
      }
    }
    const s = getComputedStyle(ind);
    const ow = s.outlineStyle !== "none" ? parseFloat(s.outlineWidth) || 0 : 0;
    const off = parseFloat(s.outlineOffset) || 0;
    const shadow = s.boxShadow !== "none" ? s.boxShadow : "";
    const ir = ind.getBoundingClientRect();
    const grow = ow > 0 ? off + ow : 0;
    const ring = { l: ir.left - grow, t: ir.top - grow, r: ir.right + grow, b: ir.bottom + grow };
    const clipped: string[] = [];
    let hidden = false;
    for (let e = ind.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const pr = e.getBoundingClientRect();
      // A clipping box with no area hides everything inside it (the empty notice line is 0 px tall).
      if (pr.width < 1 || pr.height < 1) hidden = true;
      if (ring.r <= pr.left || ring.l >= pr.right || ring.b <= pr.top || ring.t >= pr.bottom) hidden = true;
      const tag = `${e.tagName.toLowerCase()}.${(typeof e.className === "string" ? e.className : "").split(/\s+/)[0]}`;
      if (ring.l < pr.left - 0.5) clipped.push(`left by ${tag}`);
      if (ring.r > pr.right + 0.5) clipped.push(`right by ${tag}`);
      if (ring.t < pr.top - 0.5) clipped.push(`top by ${tag}`);
      if (ring.b > pr.bottom + 0.5) clipped.push(`bottom by ${tag}`);
    }
    const r = el.getBoundingClientRect();
    const inViewport = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const style = getComputedStyle(el);
    const visible = r.width >= 1 && r.height >= 1 && style.visibility === "visible" && !hidden && !el.closest(".visually-hidden");
    let ringContrast: number | null = null;
    const contrast = (fg: RGBA, behind: RGBA) => {
      const [x, y] = [lum(over(fg, behind)), lum(behind)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    const oc = parse(s.outlineColor);
    if (bar) ringContrast = contrast(bar.c, bar.on);
    else if (ow > 0 && oc) ringContrast = contrast(oc, off >= 0 ? bgOf(ind.parentElement) : bgOf(ind));
    return {
      tag: el.tagName.toLowerCase(), id: el.id, cls: typeof el.className === "string" ? el.className : "", role: el.getAttribute("role") ?? "",
      name: (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} offset ${s.outlineOffset}`, shadow, bar: bar?.text ?? "",
      indicator: Boolean(bar) || ow >= 1 || Boolean(shadow), ringContrast, visible, clipped, inDialog: Boolean(el.closest("dialog")), inViewport,
    };
  });
}
