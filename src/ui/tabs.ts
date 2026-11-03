// Editor tabs: WAI-ARIA APG tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) with automatic
// activation: arrows, Home and End move between files (one tab stop), Enter moves into the editor,
// Delete closes the focused tab, middle-click closes, Alt+W closes the active one (app shortcut).
// Unsaved files say so in their accessible name ("main.py, unsaved") and show a dot in the close
// button's place (the x comes back under the pointer), never colour alone; so do files with errors
// (an icon plus ", has errors"). The close button sits outside the role="tab" element; it is a mouse
// affordance (aria-hidden, no tab stop) because Delete and Alt+W do the same from the keyboard, and
// the file's menu has "Close tab" (a screen reader on a phone, with no keyboard, uses that).
// Flow rail (redesign 8): each tab leads with its file-type badge; a long name loses the end of its
// stem, never its extension; tabs that don't fit fade at the strip's edge, and "N more" lists the
// ones out of view as a menu (choosing one opens it and scrolls it in).
import { nameOf, parentOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { h, srOnly } from "./dom";
import { fileBadge } from "./file-badge";
import { icon } from "./icons";
import { menuButton, type MenuItem } from "./menu";

export interface TabInfo {
  id: string;
  path: WsPath;
  dirty: boolean;
  readOnly: boolean;
  /** The file has error diagnostics. */
  errors?: boolean;
}

/** ", unsaved" in a tab's accessible name. */
function unsavedLabel(): HTMLSpanElement {
  const label = srOnly(", unsaved");
  label.dataset.unsaved = "";
  return label;
}

export interface TabActions {
  activate(id: string): void;
  close(id: string): void;
  focusEditor(): void;
}

/**
 * A tab's name, said in one string ("main.py, unsaved"): its drawn parts (badge, stem, extension,
 * flags) are boxes, and Chromium puts a space after a box when it builds a name from them
 * ("main.py , unsaved", measured 2026-11-03).
 */
function tabName(t: TabInfo, name: string, folder: string): string {
  return [name, folder, t.readOnly ? "read-only" : "", t.errors ? "has errors" : "", t.dirty ? "unsaved" : ""].filter(Boolean).join(", ");
}

/** A name as its stem and its extension ("finding_t...", ".py"); a dot file or a name without one is all stem. */
function stemAndExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

export class TabStrip {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  /** "N more": the tabs out of the strip's view, as a menu. Hidden while every tab shows. */
  private readonly more: HTMLButtonElement;
  private tabs: TabInfo[] = [];
  private active: string | null = null;
  private measuring = 0;

  constructor(
    private readonly actions: TabActions,
    private readonly panelId: string,
  ) {
    this.list = h("div", { class: "tabs", role: "tablist", "aria-label": "Open files", "aria-describedby": "tabs-help" });
    this.more = h("button", { type: "button", class: "tabs-more", hidden: true });
    menuButton(this.more, "More open files", () => this.hiddenItems());
    this.element = h("div", { class: "tabstrip" }, this.list, this.more, h("span", { id: "tabs-help", hidden: true }, "Delete or Alt+W closes a file."));
    // Measured in the next frame, never inside the observer's own delivery (WebKit reports a
    // ResizeObserver loop otherwise: layout.ts syncBoards, 311826a).
    this.list.addEventListener("scroll", () => this.measureSoon(), { passive: true });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.measureSoon()).observe(this.list);
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("click", (e) => {
      const tab = (e.target as Element).closest<HTMLElement>("[data-tab-id]");
      if (!tab) return;
      const id = tab.dataset.tabId!;
      if ((e.target as Element).closest(".tab-close")) this.actions.close(id);
      else this.actions.activate(id);
    });
    this.list.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const tab = (e.target as Element).closest<HTMLElement>("[data-tab-id]");
      if (!tab) return;
      e.preventDefault();
      this.actions.close(tab.dataset.tabId!);
    });
    // Middle-click would otherwise start autoscroll in some browsers.
    this.list.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
  }

  set(tabs: TabInfo[], active: string | null): void {
    const hadFocus = this.list.contains(document.activeElement);
    this.tabs = tabs;
    this.active = active;
    const names = new Map<string, number>();
    for (const t of tabs) names.set(nameOf(t.path), (names.get(nameOf(t.path)) ?? 0) + 1);
    this.list.replaceChildren(
      ...tabs.map((t) => {
        const selected = t.id === active;
        const name = nameOf(t.path);
        // Two open files with the same name get their folder beside the name.
        const folder = (names.get(name) ?? 0) > 1 ? parentOf(t.path) || "top level" : "";
        const tab = h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `tab-${t.id}`,
            class: "tab-button",
            "aria-selected": String(selected),
            "aria-controls": this.panelId,
            tabindex: selected ? "0" : "-1",
            title: t.path,
            "aria-label": tabName(t, name, folder),
          },
          fileBadge(t.path, "tab-badge"),
          h("span", { class: "tab-name" }, ...stemAndExt(name).filter(Boolean).map((part, i) => h("span", { class: i === 0 ? "tab-stem" : "tab-ext" }, part))),
          folder ? h("span", { class: "tab-folder" }, folder) : null,
          t.readOnly ? h("span", { class: "tab-flag" }, icon("lock"), srOnly(", read-only")) : null,
          t.errors ? h("span", { class: "tab-flag error", "data-errors": "" }, icon("x-circle"), srOnly(", has errors")) : null,
          t.dirty ? unsavedLabel() : null,
        );
        // aria-hidden: a tablist may hold only tabs. Screen readers close a file with Delete, Alt+W
        // or the file's menu ("Close tab", in the tree and the More file actions button). An unsaved
        // file's dot sits in it, in the x's place (app.css shows the x under the pointer).
        const close = h(
          "button",
          { type: "button", class: "tab-close", tabindex: "-1", "aria-hidden": "true", title: `Close ${name} (Alt+W)` },
          h("span", { class: "dirty-dot" }),
          icon("x"),
        );
        return h("div", { class: "tab", "data-tab-id": t.id, "data-active": String(selected), "data-dirty": String(t.dirty), "data-errors": String(Boolean(t.errors)) }, tab, close);
      }),
    );
    this.element.dataset.count = String(tabs.length);
    if (hadFocus) this.focusActive();
    this.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.measureSoon();
  }

  /** The tabs not wholly inside the strip's view (none while the strip is not drawn: phones). */
  private outOfView(): HTMLElement[] {
    const box = this.list.getBoundingClientRect();
    if (box.width === 0) return [];
    return [...this.list.querySelectorAll<HTMLElement>(".tab")].filter((tab) => {
      const r = tab.getBoundingClientRect();
      return r.left < box.left - 1 || r.right > box.right + 1;
    });
  }

  private measureSoon(): void {
    if (this.measuring) return;
    this.measuring = requestAnimationFrame(() => {
      this.measuring = 0;
      this.measure();
    });
  }

  /** The edge fades (data-overflow: start, end or both) and the "N more" button's count. */
  private measure(): void {
    const l = this.list;
    const start = l.scrollLeft > 1;
    const end = l.scrollLeft + l.clientWidth < l.scrollWidth - 1;
    const overflow = start && end ? "both" : start ? "start" : end ? "end" : "none";
    if (l.dataset.overflow !== overflow) l.dataset.overflow = overflow;
    const n = this.outOfView().length;
    const open = this.more.getAttribute("aria-expanded") === "true";
    // An open menu keeps its button (choosing scrolls the strip, which may bring the count to 0).
    if (!open) this.more.hidden = n === 0;
    if (n > 0) {
      const words = `${n} more`;
      if (this.more.textContent !== words) {
        this.more.replaceChildren(words, icon("caret-down"));
        this.more.setAttribute("aria-label", `${n} more open files`);
      }
    }
  }

  /** The "More open files" menu: the tabs out of view, in strip order; choosing one opens it. */
  private hiddenItems(): MenuItem[] {
    const ids = new Set(this.outOfView().map((t) => t.dataset.tabId));
    return this.tabs
      .filter((t) => ids.has(t.id))
      .map((t) => ({
        label: nameOf(t.path),
        ...(parentOf(t.path) ? { sub: parentOf(t.path) } : {}),
        icon: "file" as const,
        run: () => this.actions.activate(t.id),
      }));
  }

  /**
   * Typing and each autosave flip this: it changes the one tab in place. Redrawing every tab here
   * would replace the element under a click that is in progress, and the click would be lost.
   */
  setDirty(id: string, dirty: boolean): void {
    const t = this.tabs.find((x) => x.id === id);
    if (!t || t.dirty === dirty) return;
    t.dirty = dirty;
    const tab = this.list.querySelector<HTMLElement>(`.tab[data-tab-id="${CSS.escape(id)}"]`);
    const button = tab?.querySelector<HTMLElement>("[role=tab]");
    if (!tab || !button) return this.set(this.tabs, this.active);
    tab.dataset.dirty = String(dirty);
    button.querySelector("[data-unsaved]")?.remove();
    if (dirty) button.append(unsavedLabel());
    button.setAttribute("aria-label", tabName(t, nameOf(t.path), button.querySelector(".tab-folder")?.textContent ?? ""));
  }

  focusActive(): void {
    this.list.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const tabEl = (e.target as Element).closest<HTMLElement>("[data-tab-id]");
    if (!tabEl || e.altKey || e.ctrlKey || e.metaKey) return;
    const ids = this.tabs.map((t) => t.id);
    const i = ids.indexOf(tabEl.dataset.tabId!);
    const go = (index: number) => {
      const id = ids[(index + ids.length) % ids.length];
      this.actions.activate(id);
      this.list.querySelector<HTMLElement>(`#tab-${CSS.escape(id)}`)?.focus();
    };
    switch (e.key) {
      case "ArrowRight":
        go(i + 1);
        break;
      case "ArrowLeft":
        go(i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(ids.length - 1);
        break;
      case "Delete":
        this.actions.close(ids[i]);
        break;
      case "Enter":
      case " ":
        this.actions.activate(ids[i]);
        this.actions.focusEditor();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
