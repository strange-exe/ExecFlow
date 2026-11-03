// Menus (WAI-ARIA APG menu and menu button patterns, https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/):
// role="menu" with role="menuitem" buttons, focus on the first item when opened, Up/Down/Home/End
// and first-letter keys move, Enter/Space choose, Escape or Tab close, and focus returns to what
// opened it. Groups are split by role="separator" lines, which are not focusable: the arrow keys
// move between the items only. Used for the file tree's context menu, its "More actions" button
// and the editor's code menu (code-menu.ts). Every menu flips above or left of its anchor near a
// window edge, ignores a context menu asked for inside it, and moves focus to the item under the
// pointer, so one row looks chosen and Enter acts on it, as native menus do.
// Flow rail (redesign 8, .claude/design/redesign8/menus/options.html option C): a group can be named
// (role="group" labelled by its caption and a mono detail, "Selection lines 2 to 3"); the chosen row
// carries a 3 px bar (app.css); an unavailable item stays in the arrow order, says why on a line of
// its own (its description) and explains on a click instead of acting.
import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { placeMenu, pointAnchor, type AnchorRect } from "./menu-place";

export interface MenuGroup {
  /** The group's caption ("Selection", "Clipboard"). */
  caption: string;
  /** A technical fact after it, in mono ("lines 2 to 3", "main.py"). */
  detail?: string;
}

export interface MenuItem {
  /** The item's name; also its words on the row unless `short` is given. */
  label: string;
  /** The row's words when the name says more (the rest is in the caption or the sub-line). */
  short?: string;
  /** A quiet second line under the words (decoration: the name already says it). */
  sub?: string;
  icon?: IconName;
  /** Shown on the right as quiet words, in the notices' notation ("F2", "Ctrl+Enter"). */
  shortcut?: string;
  danger?: boolean;
  /** The menu's main item: its icon in the location colour, its words at the label weight. */
  lead?: boolean;
  /** Starts a new group: a separator line above it (none above the first item). */
  separatorBefore?: boolean;
  /** Starts a new named group (a separator above it too). */
  group?: MenuGroup;
  /** One of a choice (role menuitemradio): true marks the chosen one with a check and aria-checked. */
  checked?: boolean;
  /**
   * Why the item can't act now ("Read-only in this tab"): aria-disabled, still focusable and in the
   * arrow order, the reason on its sub-line and as its description. Choosing it keeps the menu open
   * and calls `explain` instead of `run`.
   */
  unavailable?: string;
  explain?(): void;
  run(): void;
}

let current: { close(restore: boolean): void } | null = null;

/**
 * The pointer's latest two positions. Engines also send a pointermove when content scrolls or moves
 * under a still pointer (WebKit does when the arrow keys scroll a menu); such a move repeats the
 * last point, so it is not taken as the student's hand. (movementX can't tell: WebKit reports 0 for
 * real moves too.)
 */
let pointer: { x: number; y: number; px: number; py: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("pointermove", (e) => (pointer = { x: e.clientX, y: e.clientY, px: pointer?.x ?? Number.NaN, py: pointer?.y ?? Number.NaN }), true);
}
const pointerMoved = () => !pointer || pointer.x !== pointer.px || pointer.y !== pointer.py;

/** Closes the open menu; `restore` puts focus back where the menu would on Escape. */
export function closeMenus(restore = false): void {
  current?.close(restore);
}

export interface MenuOptions {
  label: string;
  /** Where focus goes when the menu closes without choosing (and before an item runs). */
  returnFocus: HTMLElement;
  /** Puts focus back instead of `returnFocus.focus()` (the code menu: view.focus(), since WebKit scrolls on a raw focus() there). */
  restoreFocus?: () => void;
  /** The menu button, if any: its aria-expanded follows the menu. */
  button?: HTMLElement;
  /** The menu element's id (tests and the code menu's "is it open" check). */
  id?: string;
  /** A quiet last line under a rule, the menu's description (aria-hidden: heard through aria-describedby, not as an item). */
  hint?: string;
  /** Which item has focus when the menu opens (a menu button's ArrowUp: the last). */
  focus?: "first" | "last";
}

/** Where a menu opens: below an element (4 px gap), at a point (a right-click, no gap), or below a box such as the caret's line (4 px gap). */
export type MenuAnchor = HTMLElement | { x: number; y: number } | AnchorRect;

let menus = 0;

/** The hint's words, its key in mono after a colon ("Browser menu: Shift+right-click"). */
function hintParts(hint: string): (HTMLElement | string)[] {
  const at = hint.indexOf(": ");
  return at < 0 ? [hint] : [hint.slice(0, at + 2), h("span", { class: "menu-hint-key" }, hint.slice(at + 2))];
}

/** Opens a menu below `anchor`, or above or left of it where there is no room (menu-place.ts). */
export function openMenu(items: readonly MenuItem[], anchor: MenuAnchor, options: MenuOptions): void {
  closeMenus();
  if (!items.length) return;
  const key = options.id ?? `menu-${++menus}`;
  const buttons = items.map((item, i) => {
    const subId = item.unavailable ? `${key}-why-${i}` : null;
    const kind = item.checked === undefined ? "menuitem" : "menuitemradio";
    return h(
      "button",
      {
        type: "button",
        role: kind,
        "aria-checked": kind === "menuitemradio" ? String(item.checked) : null,
        tabindex: "-1",
        class: `menu-item${item.danger ? " danger" : ""}${item.lead ? " lead" : ""}`,
        // Named by the full words where the row shows fewer, or a reason under them (its description).
        "aria-label": item.short || item.unavailable || item.sub ? item.label : null,
        "aria-disabled": item.unavailable ? "true" : null,
        "aria-describedby": subId,
      },
      item.checked ? icon("check-circle") : item.icon ? icon(item.icon) : h("span", { class: "icon" }),
      h(
        "span",
        { class: "menu-text" },
        h("span", { class: "menu-label" }, item.short ?? item.label),
        item.unavailable ? h("span", { class: "menu-sub", id: subId }, item.unavailable) : item.sub ? h("span", { class: "menu-sub" }, item.sub) : null,
      ),
      item.shortcut ? h("span", { class: "menu-key" }, item.shortcut) : null,
    );
  });
  // Sections: a new one at every group or separator; a named one is a role="group" with its caption.
  const sections: { group?: MenuGroup; rows: HTMLElement[] }[] = [];
  items.forEach((item, i) => {
    if (i === 0 || item.group || item.separatorBefore) sections.push({ group: item.group, rows: [] });
    sections[sections.length - 1].rows.push(buttons[i]);
  });
  const body = sections.flatMap((s, k) => {
    const sep = k > 0 ? [h("div", { class: "menu-sep", role: "separator" })] : [];
    if (!s.group) return [...sep, ...s.rows];
    const capId = `${key}-g${k}`;
    const detailId = s.group.detail ? `${capId}-d` : null;
    // The caption is heard as the group's name (aria-labelledby), not as text inside the menu.
    const caption = h(
      "div",
      { class: "menu-cap", "aria-hidden": "true" },
      h("span", { class: "menu-cap-name", id: capId }, s.group.caption),
      detailId ? h("span", { class: "menu-cap-detail", id: detailId }, s.group.detail!) : null,
    );
    return [...sep, h("div", { class: "menu-group", role: "group", "aria-labelledby": detailId ? `${capId} ${detailId}` : capId }, caption, ...s.rows)];
  });
  const hintId = options.hint ? `${key}-hint` : null;
  const menu = h(
    "div",
    { class: "menu", role: "menu", "aria-label": options.label, id: options.id, "aria-describedby": hintId },
    ...body,
    hintId ? h("div", { class: "menu-hint", id: hintId, "aria-hidden": "true" }, ...hintParts(options.hint!)) : null,
  );
  // Inside an open modal dialog the page behind is inert: a menu opened from it lives in the dialog.
  ((anchor instanceof Element && anchor.closest("dialog[open]")) || document.body).append(menu);

  // Position: below and right of the anchor when it fits, else above or left of it; 4 px inside the viewport.
  const [rect, gap]: [AnchorRect, number] =
    anchor instanceof HTMLElement ? [anchor.getBoundingClientRect(), 4] : "x" in anchor ? [pointAnchor(anchor.x, anchor.y), 0] : [anchor, 4];
  const at = placeMenu(rect, menu.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, gap);
  menu.style.left = `${at.left}px`;
  menu.style.top = `${at.top}px`;

  const focusAt = (i: number) => buttons[(i + buttons.length) % buttons.length].focus();
  const index = () => buttons.indexOf(document.activeElement as HTMLButtonElement);

  function close(restore: boolean) {
    if (current !== handle) return;
    current = null;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    options.button?.setAttribute("aria-expanded", "false");
    if (restore && options.returnFocus.isConnected) {
      if (options.restoreFocus) options.restoreFocus();
      else options.returnFocus.focus({ preventScroll: true });
    }
  }
  const handle = { close };
  current = handle;

  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== options.button) close(false);
  };
  document.addEventListener("pointerdown", outside, true);

  buttons.forEach((b, i) => {
    b.addEventListener("click", () => {
      // Unavailable: the menu stays, focus stays on the row, and the item says why instead of acting.
      if (items[i].unavailable) {
        if (document.activeElement !== b) b.focus({ preventScroll: true });
        items[i].explain?.();
        return;
      }
      close(true);
      items[i].run();
    });
    // Hover moves focus: one row looks chosen (only focus fills a row, app.css), and Enter acts on it.
    // Only a pointer that really moved (see `pointer`): otherwise the arrow keys' scroll would hand the
    // focus to whatever item slid under a still pointer.
    b.addEventListener("pointermove", () => {
      if (pointerMoved() && document.activeElement !== b) b.focus({ preventScroll: true });
    });
  });
  // A context menu asked for inside a menu does nothing: the Windows Menu key's keyup in Chromium and
  // Firefox (aimed at the focused item by then), a right-click on an item.
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  menu.addEventListener("keydown", (e) => {
    const i = index();
    switch (e.key) {
      case "ArrowDown":
        focusAt(i + 1);
        break;
      case "ArrowUp":
        focusAt(i - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(buttons.length - 1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        close(true);
        break;
      case "Enter":
      case " ":
        // A chord (Ctrl+Enter is Run) is a shortcut, not a choice: the item doesn't activate (Firefox
        // clicks a focused button on Ctrl+Enter). Alone, the key chooses the item as usual.
        if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
        break;
      default: {
        // Letters only without Ctrl, Alt and Meta: Ctrl+S or Alt+W are shortcuts, not a jump to "S" or "W".
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const k = e.key.toLowerCase();
          const order = [...buttons.slice(i + 1), ...buttons.slice(0, i + 1)];
          const hit = order.find((b) => (b.textContent ?? "").trim().toLowerCase().startsWith(k));
          hit?.focus();
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  });
  // Roving tabindex (APG): the focused row is the menu's one tab stop, so a menu that scrolls inside a
  // short window still holds keyboard-reachable content (axe scrollable-region-focusable). Tab closes
  // the menu either way (above).
  menu.addEventListener("focusin", (e) => {
    for (const b of buttons) b.tabIndex = b === e.target ? 0 : -1;
  });
  menu.addEventListener("focusout", (e) => {
    if (!menu.contains(e.relatedTarget as Node | null) && e.relatedTarget !== null) close(false);
  });
  options.button?.setAttribute("aria-expanded", "true");
  focusAt(options.focus === "last" ? buttons.length - 1 : 0);
}

/** Makes `button` an APG menu button for the items `getItems()` returns when it opens. */
export function menuButton(button: HTMLButtonElement, label: string, getItems: () => MenuItem[]): void {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const open = (focusLast = false) => openMenu(getItems(), button, { label, returnFocus: button, button, focus: focusLast ? "last" : "first" });
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") closeMenus();
    else open();
  });
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open(e.key === "ArrowUp");
    }
  });
}
