// The file tree: WAI-ARIA APG treeview (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/).
// role tree/treeitem/group, aria-expanded on folders, aria-selected (selection follows focus),
// one tab stop (roving tabindex), arrows/Home/End/type-ahead, Enter opens, F2 renames in place,
// Delete asks first, Shift+F10 or the context-menu key opens the item's menu. The open file is
// marked with aria-current, a 2 px accent bar and weight 600.
import { detectLanguage, isHeader } from "../core/languages";
import type { EntryMeta, WsPath } from "../core/types";
import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { ancestors, buildTree, checkName, targetFolder, typeAhead, visibleRows, type TreeNode } from "./tree-model";

export interface TreeActions {
  /** A file was chosen (Enter, click). `focusEditor` is false for Space (keep browsing). */
  open(path: WsPath, focusEditor: boolean): void;
  /** Returns an error sentence to show in the name field, or null when done. */
  create(kind: "file" | "dir", path: WsPath): Promise<string | null>;
  rename(from: WsPath, to: WsPath): Promise<string | null>;
  /** Delete (asks first). */
  remove(node: TreeNode): void;
  /** The item's menu: right-click, Shift+F10, the context-menu key. */
  menu(node: TreeNode | null, at: HTMLElement | { x: number; y: number }): void;
  expandedChanged(expanded: WsPath[]): void;
  selectionChanged?(node: TreeNode | null): void;
}

export function fileIcon(path: string): IconName {
  const lang = detectLanguage(path)?.id;
  if (lang === "python") return "file-py";
  if (lang === "c") return "file-c";
  if (lang === "cpp") return "file-cpp";
  if (isHeader(path)) return "file-text";
  return /\.(txt|md|csv|json|in|out|dat)$/i.test(path) ? "file-text" : "file";
}

const TYPE_AHEAD_MS = 600;

export class FileTree {
  readonly element: HTMLUListElement;
  /** Descriptions read with an item ("read-only (binary or special file)"). */
  readonly descriptions: HTMLElement;
  private roots: TreeNode[] = [];
  private byPath = new Map<WsPath, TreeNode>();
  private expanded = new Set<WsPath>();
  private selected: WsPath | null = null;
  private active: WsPath | null = null;
  private editing: { cancel(): void } | null = null;
  private typed = "";
  private typedAt = 0;
  private seq = 0;
  private errorPaths = new Set<WsPath>();
  readOnly = false;

  constructor(private readonly actions: TreeActions, labelledBy: string) {
    this.element = h("ul", { class: "tree", role: "tree", "aria-labelledby": labelledBy, "aria-describedby": "tree-help" });
    this.descriptions = h(
      "div",
      { hidden: true },
      h("span", { id: "tree-help" }, "Enter opens a file. F2 renames, Delete deletes, Shift+F10 shows more actions."),
      h("span", { id: "tree-desc-opaque" }, "read-only (binary or special file)"),
      h("span", { id: "tree-desc-conflict" }, "conflict copy: both versions changed, so this one was kept beside the original"),
      h("span", { id: "tree-desc-errors" }, "has errors (see Problems)"),
    );
    this.element.addEventListener("keydown", (e) => this.onKey(e));
    this.element.addEventListener("click", (e) => this.onClick(e));
    this.element.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.element.addEventListener("focusin", (e) => {
      const li = (e.target as Element).closest<HTMLElement>("[role=treeitem]");
      if (li?.dataset.path && li.dataset.path !== this.selected) this.select(li.dataset.path, false);
    });
  }

  // ------------------------------------------------------------------ data in

  setEntries(entries: readonly EntryMeta[]): void {
    this.roots = buildTree(entries);
    this.byPath.clear();
    const walk = (list: TreeNode[]) => {
      for (const n of list) {
        this.byPath.set(n.path, n);
        walk(n.children);
      }
    };
    walk(this.roots);
    for (const p of [...this.expanded]) if (this.byPath.get(p)?.kind !== "dir") this.expanded.delete(p);
    if (this.selected && !this.byPath.has(this.selected)) this.selected = null;
    this.render();
  }

  setExpanded(paths: readonly WsPath[]): void {
    this.expanded = new Set(paths);
    this.render();
  }

  /** Files with error diagnostics: marked with an icon and a description, not colour alone. */
  setErrors(paths: ReadonlySet<WsPath>): void {
    if (paths.size === this.errorPaths.size && [...paths].every((p) => this.errorPaths.has(p))) return;
    this.errorPaths = new Set(paths);
    this.render();
  }

  /**
   * A file or folder moved (before the tree is re-read): expanded folders, the selection and the
   * open-file mark follow it, so renaming an expanded folder keeps it, and its open files, in view.
   */
  moved(from: WsPath, to: WsPath): void {
    const map = (p: WsPath) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    this.expanded = new Set([...this.expanded].map(map));
    if (this.selected) this.selected = map(this.selected);
    if (this.active) this.active = map(this.active);
    this.actions.expandedChanged([...this.expanded]);
  }

  setActive(path: WsPath | null): void {
    this.active = path;
    if (path) for (const a of ancestors(path)) this.expanded.add(a);
    if (path && this.byPath.has(path) && !this.isFocused()) this.selected = path;
    this.render();
  }

  get isEmpty(): boolean {
    return this.roots.length === 0;
  }

  node(path: WsPath): TreeNode | null {
    return this.byPath.get(path) ?? null;
  }

  selectedNode(): TreeNode | null {
    return this.selected ? (this.byPath.get(this.selected) ?? null) : null;
  }

  paths(): WsPath[] {
    return [...this.byPath.keys()];
  }

  expandedPaths(): WsPath[] {
    return [...this.expanded];
  }

  /** A click on the empty space below the files: nothing chosen, so New file goes to the top level. */
  clearSelection(): void {
    if (this.editing || !this.selected) return;
    this.selected = null;
    for (const li of this.element.querySelectorAll<HTMLElement>("[role=treeitem][aria-selected='true']")) li.setAttribute("aria-selected", "false");
    this.actions.selectionChanged?.(null);
  }

  /** Moves keyboard focus into the tree (Ctrl+Shift+E). */
  focus(): void {
    const target = this.itemFor(this.selected) ?? this.element.querySelector<HTMLElement>("[role=treeitem]");
    if (target) target.focus();
    else this.element.focus();
  }

  isFocused(): boolean {
    return this.element.contains(document.activeElement);
  }

  // ------------------------------------------------------------------ drawing

  private itemFor(path: WsPath | null): HTMLElement | null {
    if (!path) return null;
    for (const li of this.element.querySelectorAll<HTMLElement>("[role=treeitem]")) if (li.dataset.path === path) return li;
    return null;
  }

  private render(): void {
    // While a name is being typed, redrawing would throw the field away; finishing redraws.
    if (this.editing) return;
    const hadFocus = this.isFocused();
    const rows = visibleRows(this.roots, this.expanded);
    const tabStop = rows.find((r) => r.path === this.selected)?.path ?? rows.find((r) => r.path === this.active)?.path ?? rows[0]?.path ?? null;
    const draw = (list: TreeNode[]): HTMLElement[] =>
      list.map((n, i) => {
        const nameId = `tn-${++this.seq}`;
        const isDir = n.kind === "dir";
        const open = isDir && this.expanded.has(n.path);
        const errors = !isDir && this.errorPaths.has(n.path);
        const describedBy = [n.opaque ? "tree-desc-opaque" : "", n.conflict ? "tree-desc-conflict" : "", errors ? "tree-desc-errors" : ""].filter(Boolean).join(" ");
        const badge = n.opaque
          ? h("span", { class: "tree-badge", title: "Read-only (binary or special file)" }, icon("lock"))
          : n.conflict
            ? h("span", { class: "tree-badge warn", title: "Conflict copy: both versions changed, so this one was kept beside the original" }, icon("warning"))
            : null;
        const errorBadge = errors ? h("span", { class: "tree-badge error", title: "Has errors (see Problems)", "data-errors": "" }, icon("x-circle")) : null;
        const row = h(
          "div",
          { class: "tree-row", style: `--level: ${n.level - 1}` },
          h("span", { class: "twisty" }, isDir ? icon(open ? "caret-down" : "caret-right") : null),
          icon(isDir ? (open ? "folder-open" : "folder") : fileIcon(n.path), "tree-icon"),
          h("span", { class: "tree-name", id: nameId }, n.name),
          errorBadge,
          badge,
        );
        const li = h("li", {
          role: "treeitem",
          "aria-labelledby": nameId,
          "aria-describedby": describedBy || null,
          "aria-level": n.level,
          "aria-setsize": list.length,
          "aria-posinset": i + 1,
          "aria-selected": n.path === this.selected ? "true" : "false",
          "aria-expanded": isDir ? String(open) : null,
          "aria-current": n.path === this.active ? "true" : null,
          tabindex: n.path === tabStop ? "0" : "-1",
          "data-path": n.path,
          "data-kind": n.kind,
          "data-opaque": n.opaque ? "true" : null,
        }, row);
        if (open && n.children.length) li.append(h("ul", { role: "group" }, ...draw(n.children)));
        return li;
      });
    this.element.replaceChildren(...draw(this.roots));
    this.element.dataset.empty = String(this.roots.length === 0);
    if (hadFocus) (this.itemFor(this.selected) ?? this.itemFor(tabStop))?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ selection, folders

  private select(path: WsPath, focus = true): void {
    this.selected = path;
    for (const li of this.element.querySelectorAll<HTMLElement>("[role=treeitem]")) {
      const on = li.dataset.path === path;
      li.setAttribute("aria-selected", String(on));
      li.tabIndex = on ? 0 : -1;
    }
    const li = this.itemFor(path);
    if (focus) li?.focus();
    li?.scrollIntoView({ block: "nearest" });
    this.actions.selectionChanged?.(this.byPath.get(path) ?? null);
  }

  private setOpen(path: WsPath, open: boolean): void {
    if (open === this.expanded.has(path)) return;
    if (open) this.expanded.add(path);
    else this.expanded.delete(path);
    this.render();
    this.actions.expandedChanged([...this.expanded]);
  }

  expand(path: WsPath): void {
    this.setOpen(path, true);
  }

  /** Expands the folders above `path` and selects it. */
  reveal(path: WsPath, focus = false): void {
    let changed = false;
    for (const a of ancestors(path)) if (!this.expanded.has(a)) (this.expanded.add(a), (changed = true));
    if (changed) {
      this.render();
      this.actions.expandedChanged([...this.expanded]);
    }
    this.select(path, focus);
  }

  // ------------------------------------------------------------------ input

  private rows(): TreeNode[] {
    return visibleRows(this.roots, this.expanded);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing || e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = this.rows();
    const i = rows.findIndex((r) => r.path === this.selected);
    const node = i >= 0 ? rows[i] : null;
    const go = (index: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (r) this.select(r.path);
    };
    switch (e.key) {
      case "ArrowDown":
        go(i + 1);
        break;
      case "ArrowUp":
        go(i < 0 ? 0 : i - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (node?.kind === "dir") {
          if (!this.expanded.has(node.path)) this.setOpen(node.path, true);
          else if (node.children.length) this.select(node.children[0].path);
        }
        break;
      case "ArrowLeft":
        if (node?.kind === "dir" && this.expanded.has(node.path)) this.setOpen(node.path, false);
        else if (node && node.level > 1) this.select(node.path.slice(0, node.path.lastIndexOf("/")));
        break;
      case "Enter":
      case " ":
        if (!node) break;
        if (node.kind === "dir") this.setOpen(node.path, !this.expanded.has(node.path));
        else this.actions.open(node.path, e.key === "Enter");
        break;
      case "F2":
        if (node) this.startRename(node.path);
        break;
      case "F10":
      case "ContextMenu": {
        // Shift+F10 or the menu key: not every engine turns them into a contextmenu event.
        if (e.key === "F10" && !e.shiftKey) return;
        const li = this.itemFor(node?.path ?? null);
        this.actions.menu(node, li?.querySelector<HTMLElement>(":scope > .tree-row") ?? this.element);
        break;
      }
      case "Delete":
        if (node && !this.readOnly) this.actions.remove(node);
        break;
      case "*": {
        const siblings = node ? (node.level === 1 ? this.roots : (this.byPath.get(node.path.slice(0, node.path.lastIndexOf("/")))?.children ?? [])) : this.roots;
        let changed = false;
        for (const s of siblings) if (s.kind === "dir" && !this.expanded.has(s.path)) (this.expanded.add(s.path), (changed = true));
        if (changed) {
          this.render();
          this.actions.expandedChanged([...this.expanded]);
        }
        break;
      }
      default: {
        if (e.key.length !== 1 || e.key === " ") return;
        const now = performance.now();
        this.typed = now - this.typedAt > TYPE_AHEAD_MS ? e.key : this.typed + e.key;
        this.typedAt = now;
        const hit = typeAhead(rows, i, this.typed);
        if (hit >= 0) go(hit);
        break;
      }
    }
    e.preventDefault();
  }

  private onClick(e: MouseEvent): void {
    if (this.editing) return;
    const li = (e.target as Element).closest<HTMLElement>("[role=treeitem]");
    if (!li?.dataset.path) return;
    const node = this.byPath.get(li.dataset.path);
    if (!node) return;
    e.stopPropagation();
    this.select(node.path);
    if (node.kind === "dir") this.setOpen(node.path, !this.expanded.has(node.path));
    else this.actions.open(node.path, true);
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.editing) return;
    const li = (e.target as Element).closest<HTMLElement>("[role=treeitem]");
    const node = li?.dataset.path ? (this.byPath.get(li.dataset.path) ?? null) : null;
    e.preventDefault();
    if (node) this.select(node.path);
    // A keyboard-opened menu (Shift+F10) reports the pointer at 0,0: anchor it to the item instead.
    const fromKeyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
    this.actions.menu(node, fromKeyboard && li ? li.querySelector<HTMLElement>(".tree-row") ?? li : { x: e.clientX, y: e.clientY });
  }

  // ------------------------------------------------------------------ naming in place

  /** New file or folder: a name field at the top of `dir` (default: next to the selection). */
  startCreate(kind: "file" | "dir", dir: WsPath = targetFolder(this.selectedNode())): void {
    if (this.readOnly) return;
    this.cancelEdit();
    if (dir) {
      for (const a of [...ancestors(dir), dir]) this.expanded.add(a);
      this.render();
      this.actions.expandedChanged([...this.expanded]);
    }
    const where = dir ? `in ${dir}` : "at the top level";
    const level = dir ? dir.split("/").length + 1 : 1;
    const holder = h("li", { class: "tree-new", role: "none" });
    const parentItem = this.itemFor(dir);
    let group = parentItem?.querySelector<HTMLElement>(":scope > [role=group]") ?? null;
    if (parentItem && !group) parentItem.append((group = h("ul", { role: "group" })));
    (group ?? this.element).prepend(holder);
    this.editName(holder, {
      level,
      iconName: kind === "dir" ? "folder" : "file",
      value: "",
      label: `Name of the new ${kind === "dir" ? "folder" : "file"} ${where}`,
      commit: async (typed) => {
        const check = checkName(dir, typed, this.paths());
        if (!check.ok) return check.error;
        const error = await this.actions.create(kind, check.path);
        if (!error) this.selected = check.path;
        return error;
      },
      done: () => holder.remove(),
    });
  }

  startRename(path: WsPath | undefined = this.selected ?? undefined): void {
    if (this.readOnly || !path) return;
    const node = this.byPath.get(path);
    const li = this.itemFor(path);
    if (!node || !li) return;
    this.cancelEdit();
    const row = li.querySelector<HTMLElement>(":scope > .tree-row")!;
    row.hidden = true;
    const holder = h("div", { class: "tree-edit-holder" });
    row.after(holder);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.editName(holder, {
      level: node.level,
      iconName: node.kind === "dir" ? "folder" : fileIcon(path),
      value: node.name,
      label: `New name for ${node.name}`,
      commit: async (typed) => {
        const check = checkName(dir, typed, this.paths(), path);
        if (!check.ok) return check.error;
        if (check.path === path) return null;
        const error = await this.actions.rename(path, check.path);
        if (!error) this.selected = check.path;
        return error;
      },
      done: () => {
        holder.remove();
        row.hidden = false;
      },
    });
  }

  cancelEdit(): void {
    this.editing?.cancel();
  }

  private editName(
    holder: HTMLElement,
    o: { level: number; iconName: IconName; value: string; label: string; commit(typed: string): Promise<string | null>; done(): void },
  ): void {
    const errorId = `tree-error-${++this.seq}`;
    const input = h("input", {
      class: "tree-input",
      type: "text",
      "aria-label": o.label,
      "aria-describedby": errorId,
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "off",
    });
    input.value = o.value;
    const error = h("p", { class: "tree-error", id: errorId, hidden: true });
    holder.append(h("div", { class: "tree-row editing", style: `--level: ${o.level - 1}` }, h("span", { class: "twisty" }), icon(o.iconName, "tree-icon"), input), error);
    holder.dataset.editing = "true";
    let busy = false;
    let finished = false;

    const finish = (focusSelection: boolean) => {
      if (finished) return;
      finished = true;
      // Back to the list only if focus is still here: a new file has already put it in the editor.
      const active = document.activeElement;
      const refocus = focusSelection && (this.element.contains(active) || active === document.body || active === null);
      this.editing = null;
      o.done();
      // Redraw now: changes that arrived during the edit were held back.
      this.render();
      if (refocus) (this.itemFor(this.selected) ?? this.element.querySelector<HTMLElement>("[role=treeitem]"))?.focus();
    };
    const showError = (text: string) => {
      error.textContent = text;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    };
    const submit = async (fromBlur: boolean) => {
      if (busy || finished) return;
      const typed = input.value;
      if (!typed.trim() || typed === o.value) return finish(!fromBlur);
      busy = true;
      const problem = await o.commit(typed).catch((e: unknown) => (e instanceof Error ? e.message : "That didn't work."));
      busy = false;
      if (problem === null) return finish(true);
      // Leaving the field with a name that can't be used drops the edit (nothing was changed).
      if (fromBlur && document.activeElement !== input) return finish(false);
      showError(problem);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void submit(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("input", () => {
      error.hidden = true;
      input.removeAttribute("aria-invalid");
    });
    input.addEventListener("blur", () => void submit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    this.editing = { cancel: () => finish(false) };
    input.focus();
    // Select the name without its extension, so typing replaces "main" in "main.py".
    const dot = o.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : o.value.length);
  }
}
