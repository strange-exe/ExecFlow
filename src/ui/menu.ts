// Menus (WAI-ARIA APG menu and menu button patterns, https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/):
// role="menu" with role="menuitem" buttons, focus on the first item when opened, Up/Down/Home/End
// and first-letter keys move, Enter/Space choose, Escape or Tab close, and focus returns to what
// opened it. Used for the file tree's context menu and its "More actions" button.
import { h } from "./dom";
import { icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Shown on the right, e.g. "F2". */
  shortcut?: string;
  danger?: boolean;
  run(): void;
}

let current: { close(restore: boolean): void } | null = null;

export function closeMenus(): void {
  current?.close(false);
}

export interface MenuOptions {
  label: string;
  /** Where focus goes when the menu closes without choosing (and before an item runs). */
  returnFocus: HTMLElement;
  /** The menu button, if any: its aria-expanded follows the menu. */
  button?: HTMLElement;
}

/** Opens a menu below `anchor` (an element) or at a point (a right-click). */
export function openMenu(items: readonly MenuItem[], anchor: HTMLElement | { x: number; y: number }, options: MenuOptions): void {
  closeMenus();
  if (!items.length) return;
  const buttons = items.map((item) =>
    h(
      "button",
      { type: "button", role: "menuitem", tabindex: "-1", class: `menu-item${item.danger ? " danger" : ""}` },
      item.icon ? icon(item.icon) : h("span", { class: "icon" }),
      h("span", { class: "menu-label" }, item.label),
      item.shortcut ? h("kbd", { class: "keycap" }, item.shortcut) : null,
    ),
  );
  const menu = h("div", { class: "menu", role: "menu", "aria-label": options.label }, ...buttons);
  document.body.append(menu);

  // Position: below the anchor, or at the pointer, kept inside the viewport.
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : null;
  const x = r ? r.left : anchor instanceof HTMLElement ? 0 : anchor.x;
  const y = r ? r.bottom + 4 : anchor instanceof HTMLElement ? 0 : anchor.y;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;

  const focusAt = (i: number) => buttons[(i + buttons.length) % buttons.length].focus();
  const index = () => buttons.indexOf(document.activeElement as HTMLButtonElement);

  function close(restore: boolean) {
    if (current !== handle) return;
    current = null;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    options.button?.setAttribute("aria-expanded", "false");
    if (restore && options.returnFocus.isConnected) options.returnFocus.focus({ preventScroll: true });
  }
  const handle = { close };
  current = handle;

  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== options.button) close(false);
  };
  document.addEventListener("pointerdown", outside, true);

  buttons.forEach((b, i) =>
    b.addEventListener("click", () => {
      close(true);
      items[i].run();
    }),
  );
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
      default: {
        if (e.key.length === 1 && /\S/.test(e.key)) {
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
  menu.addEventListener("focusout", (e) => {
    if (!menu.contains(e.relatedTarget as Node | null) && e.relatedTarget !== null) close(false);
  });
  options.button?.setAttribute("aria-expanded", "true");
  focusAt(0);
}

/** Makes `button` an APG menu button for the items `getItems()` returns when it opens. */
export function menuButton(button: HTMLButtonElement, label: string, getItems: () => MenuItem[]): void {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const open = (focusLast = false) => {
    openMenu(getItems(), button, { label, returnFocus: button, button });
    if (focusLast) document.querySelector<HTMLElement>(".menu [role=menuitem]:last-child")?.focus();
  };
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
