// Editor tabs: WAI-ARIA APG tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) with automatic
// activation: arrows, Home and End move between files (one tab stop), Enter moves into the editor,
// Delete closes the focused tab, middle-click closes, Alt+W closes the active one (app shortcut).
// Unsaved files say so in their accessible name ("main.py, unsaved") and show a dot plus an italic
// name, never colour alone; so do files with errors (an icon plus ", has errors"). The close button
// sits outside the role="tab" element; it is a mouse affordance (aria-hidden, no tab stop) because
// Delete and Alt+W do the same from the keyboard, and the file's menu has "Close tab" (a screen
// reader on a phone, with no keyboard, uses that).
import { nameOf, parentOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { h, srOnly } from "./dom";
import { icon } from "./icons";
import { fileIcon } from "./tree";

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

export class TabStrip {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private tabs: TabInfo[] = [];
  private active: string | null = null;

  constructor(
    private readonly actions: TabActions,
    private readonly panelId: string,
  ) {
    this.list = h("div", { class: "tabs", role: "tablist", "aria-label": "Open files", "aria-describedby": "tabs-help" });
    this.element = h("div", { class: "tabstrip" }, this.list, h("span", { id: "tabs-help", hidden: true }, "Delete or Alt+W closes a file."));
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
          },
          icon(fileIcon(t.path), "tab-icon"),
          h("span", { class: "tab-name" }, name),
          folder ? h("span", { class: "tab-folder" }, folder) : null,
          t.readOnly ? h("span", { class: "tab-flag" }, icon("lock"), srOnly(", read-only")) : null,
          t.errors ? h("span", { class: "tab-flag error", "data-errors": "" }, icon("x-circle"), srOnly(", has errors")) : null,
          h("span", { class: "dirty-dot", "aria-hidden": "true" }),
          t.dirty ? unsavedLabel() : null,
        );
        // aria-hidden: a tablist may hold only tabs. Screen readers close a file with Delete, Alt+W
        // or the file's menu ("Close tab", in the tree and the More file actions button).
        const close = h(
          "button",
          { type: "button", class: "tab-close", tabindex: "-1", "aria-hidden": "true", title: `Close ${name} (Alt+W)` },
          icon("x"),
        );
        return h("div", { class: "tab", "data-tab-id": t.id, "data-active": String(selected), "data-dirty": String(t.dirty), "data-errors": String(Boolean(t.errors)) }, tab, close);
      }),
    );
    this.element.dataset.count = String(tabs.length);
    if (hadFocus) this.focusActive();
    this.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
