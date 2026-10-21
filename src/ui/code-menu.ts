// The editor context menu (final-v3 sections 2.3 and 7.8): a right-click (Ctrl+click on macOS) on
// selected code or on the line numbers of selected lines, or Shift+F10 / the Menu key with code
// selected, opens "Actions for the selected code": Capture snippet of lines 4 to 12..., Cut, Copy,
// Select all. Everywhere else the browser's menu stays, and on the selection it is one
// Shift+right-click away. Listeners on the editor host and the window, not a CodeMirror extension:
// the decision and its preventDefault() happen inside the event, with the view instance only (no
// CodeMirror value import), so this stays in the shell. The app never reads the clipboard here.
import type { EditorView } from "@codemirror/view";
import {
  actionGate, clearsPressRecord, codeMenuHint, codeMenuItems, codeMenuMessage, coversLine, insideAny, isMenuKey, isSecondaryPress, menuDecision,
  type CodeMenuItem, type CodeMenuKind, type CodeMenuResult, type MenuPlace, type MenuVia, type OpenedRecord,
} from "../core/code-menu";
import { menuLabel, pickLines } from "../core/snippet";
import { closeMenus, openMenu, type MenuAnchor, type MenuItem } from "./menu";
import type { AnchorRect } from "./menu-place";
import type { Notice } from "./notice";

export interface CodeMenuDeps {
  readonly view: () => EditorView | null;
  readonly activeId: () => string | null;
  /** Capture snippet: snippet-image.ts open(opener, "context"). */
  readonly capture: (opener: HTMLElement) => void;
  readonly notice: Pick<Notice, "show" | "clear">;
  readonly explainReadOnly: () => boolean;
  readonly canWrite: () => boolean;
  readonly mac: boolean;
  /** #app, for the state attributes (data-code-menu, data-code-menus, data-code-menu-result, data-code-menu-results). */
  readonly root?: HTMLElement;
}

const MENU_ID = "code-menu";
const LABEL = "Actions for the selected code";

/** A point (a right-click: the menu at the pointer) or a rect (the caret's line: 4 px below it, or above near the bottom). */
type Anchor = Exclude<MenuAnchor, HTMLElement>;

interface PressRecord {
  readonly type: string;
  readonly secondary: boolean;
  readonly primary: boolean;
  /** The code menu was open at this press's pointerdown. */
  readonly menuOpen: boolean;
  readonly t: number;
}

/** Wires the code menu to the editor host. Runs once; the listeners live as long as the page. */
export function attachCodeMenu(host: HTMLElement, deps: CodeMenuDeps): void {
  const root = deps.root ?? host.closest<HTMLElement>("#app") ?? document.documentElement;
  const now = () => performance.now();
  const codeMenuOpen = () => document.getElementById(MENU_ID) !== null;
  /** The app's own record of the last press: pointer or keyboard is decided from it, never from event fields. */
  let rec: PressRecord | null = null;
  /** Shift+F10 again while the code menu was open: the next keyboard contextmenu is the browser's. */
  let againUntil = 0;
  let opened: (OpenedRecord & { readonly view: EditorView; readonly scroll: { top: number; left: number } }) | null = null;

  const anySelected = (v: EditorView) => v.state.selection.ranges.some((r) => !r.empty);
  const lineNumberCell = (v: EditorView, target: Node) => {
    const cell = (target instanceof Element ? target : target.parentElement)?.closest(".cm-lineNumbers .cm-gutterElement");
    return !!cell && v.dom.contains(cell);
  };
  function placeOf(v: EditorView, target: EventTarget | null): MenuPlace {
    if (!(target instanceof Node)) return "other";
    if (v.contentDOM.contains(target)) return "content";
    return lineNumberCell(v, target) ? "line-number" : "other";
  }
  /** On the selection: the code text inside a non-empty range (ends included), or the line number of a covered line. */
  function onSelection(v: EditorView, e: MouseEvent): boolean {
    const place = placeOf(v, e.target);
    const ranges = v.state.selection.ranges;
    if (place === "content") return insideAny(v.posAtCoords({ x: e.clientX, y: e.clientY }, false), ranges);
    if (place === "line-number") return coversLine(v.state.doc.lineAt(v.lineBlockAtHeight(e.clientY - v.documentTop).from), ranges);
    return false;
  }

  function mark(d: "app" | "browser") {
    root.dataset.codeMenu = d;
    root.dataset.codeMenus = String((Number(root.dataset.codeMenus) || 0) + 1);
  }

  /** An item's result: its attributes when final, and its text through the notice (cleared, then set 50 ms later). */
  function result(r: CodeMenuResult) {
    const done = () => {
      root.dataset.codeMenuResult = r;
      root.dataset.codeMenuResults = String((Number(root.dataset.codeMenuResults) || 0) + 1);
    };
    const text = r === "read-only-tab" ? null : codeMenuMessage(r, { mac: deps.mac });
    if (r !== "read-only-tab" && text === null) {
      done();
      return;
    }
    deps.notice.clear();
    setTimeout(() => {
      if (text === null) deps.explainReadOnly();
      else deps.notice.show(text, { tone: "info" });
      done();
    }, 50);
  }

  /**
   * Copies the selected ranges through CodeMirror's own copy handler (it needs the view focused):
   * success only when the copy event fired and was cancelled (CodeMirror filled the clipboard).
   * execCommand's return value proves nothing.
   */
  function copyThroughEditor(v: EditorView): boolean {
    v.focus();
    let fired = false;
    let cancelled = false;
    const listener = (e: ClipboardEvent) => {
      fired = true;
      cancelled = e.defaultPrevented;
    };
    addEventListener("copy", listener);
    try {
      document.execCommand("copy");
    } catch {
      // judged by its effect below
    } finally {
      removeEventListener("copy", listener);
    }
    return fired && cancelled;
  }

  function act(kind: CodeMenuKind, record: OpenedRecord) {
    const v = deps.view();
    const gate = actionGate(record, { view: v, fileId: deps.activeId(), state: v?.state ?? null }, kind, deps.canWrite());
    if (gate === "empty") return result(kind === "cut" ? "cut-failed" : "copy-failed");
    if (gate !== "ok") return result(gate);
    if (!v) return result("stale");
    switch (kind) {
      case "capture":
        deps.capture(v.contentDOM);
        return result("capture");
      case "copy":
        return result(copyThroughEditor(v) ? "copied" : "copy-failed");
      case "cut":
        // A copy judged by its effect, then the editor's own delete: one transaction, one undo step.
        if (!copyThroughEditor(v)) return result("cut-failed");
        v.dispatch(v.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
        return result("cut");
      case "select-all":
        v.dispatch({ selection: { anchor: 0, head: v.state.doc.length }, userEvent: "select" });
        return result("selected");
      case "paste":
        // Not built: Paste is left out (the user's choice), so the app never reads the clipboard.
        return result("paste-unavailable");
    }
  }

  function toMenuItem(item: CodeMenuItem, record: OpenedRecord): MenuItem {
    return {
      label: item.label,
      // clipboard-text belongs to the Paste variant, which is not built (the user left Paste out), so icons.ts doesn't carry it.
      icon: item.icon === "clipboard-text" ? undefined : item.icon,
      shortcut: item.keycap,
      separatorBefore: item.separatorBefore,
      run: () => act(item.kind, record),
    };
  }

  function open(v: EditorView, anchor: Anchor, via: MenuVia) {
    const record = {
      view: v, fileId: deps.activeId(), doc: v.state.doc, selection: v.state.selection,
      scroll: { top: v.scrollDOM.scrollTop, left: v.scrollDOM.scrollLeft },
    };
    opened = record;
    const items = codeMenuItems({ mac: deps.mac, label: menuLabel(pickLines(v.state), null), paste: false }).map((item) => toMenuItem(item, record));
    openMenu(items, anchor, {
      id: MENU_ID, label: LABEL, returnFocus: v.contentDOM,
      // Never a raw focus() on the code: WebKit scrolls to the selection on that (view.focus() saves the scroll).
      restoreFocus: () => v.focus(),
      hint: codeMenuHint(via, deps.mac) ?? undefined,
    });
  }

  /** The keyboard menu opens at the main range's head (a visible caret), scrolled into view first when it isn't. */
  function openAtHead(v: EditorView) {
    const main = v.state.selection.main;
    const side = main.head === main.from ? 1 : -1;
    const rectOf = (c: { left: number; top: number; right: number; bottom: number }): AnchorRect => ({ left: c.left, top: c.top, right: c.right, bottom: c.bottom });
    const c = v.coordsAtPos(main.head, side);
    const box = v.scrollDOM.getBoundingClientRect();
    if (c && c.top >= box.top && c.bottom <= box.bottom && c.left >= box.left && c.right <= box.right) {
      open(v, rectOf(c), "keyboard");
      return;
    }
    v.dispatch({ scrollIntoView: true });
    // CodeMirror applies that scroll after the measure requests of its next cycle (view 6.43.14,
    // measure()), so a request made now would read the old position, open the menu there and record
    // that scroll, and the scroll that follows would close it. A frame later the scroll has happened
    // (its event comes before this frame's callbacks, while no menu is open yet): measure then.
    requestAnimationFrame(() =>
      v.requestMeasure({
        read: (view) => view.coordsAtPos(main.head, side),
        write: (rect) => {
          if (rect) open(v, rectOf(rect), "keyboard");
        },
      }),
    );
  }

  // ---------------------------------------------------------------- window listeners

  // Capture: before menu.ts's own outside-press listener (document, capture) closes the menu.
  addEventListener(
    "pointerdown",
    (e) => {
      const wasOpen = codeMenuOpen();
      const secondary = isSecondaryPress(e, deps.mac);
      rec = { type: e.pointerType, secondary, primary: e.button === 0 && !secondary, menuOpen: wasOpen, t: now() };
      // A second right-click: the menu goes at once, so the contextmenu that follows reaches what is under the pointer.
      if (wasOpen && secondary) closeMenus(false);
    },
    true,
  );
  addEventListener(
    "keydown",
    (e) => {
      if (clearsPressRecord(e)) rec = null;
      // Shift+F10 (or the Menu key) again: close and let the browser's keyboard menu come. The key is not cancelled.
      if (codeMenuOpen() && isMenuKey(e)) {
        againUntil = now() + 1000;
        closeMenus(false);
        deps.view()?.focus();
      }
    },
    true,
  );
  addEventListener(
    "keyup",
    (e) => {
      if (againUntil > now() && (e.key === "F10" || e.key === "ContextMenu")) againUntil = now() + 1000;
    },
    true,
  );
  // A record never outlives its gesture (a right-click on the tree, say).
  addEventListener("contextmenu", () => (rec = null));
  addEventListener("blur", () => {
    if (codeMenuOpen()) closeMenus(true);
  });

  // ---------------------------------------------------------------- host listeners

  // Scroll events don't bubble: a capture listener sees the scroller's. Only a real move closes the menu
  // (the keyboard path's own scroll into view can report a frame later).
  host.addEventListener(
    "scroll",
    (e) => {
      if (!codeMenuOpen() || !opened || e.target !== opened.view.scrollDOM) return;
      const s = opened.view.scrollDOM;
      if (s.scrollTop !== opened.scroll.top || s.scrollLeft !== opened.scroll.left) closeMenus(true);
    },
    true,
  );

  // The press guard and the dismiss guard (2.3.3), before CodeMirror sees the press.
  host.addEventListener(
    "mousedown",
    (e) => {
      const v = deps.view();
      if (!v || !onSelection(v, e)) return;
      // A secondary press on the selection keeps it in every engine; a primary press that only dismisses
      // the open menu keeps it too (the student pressed to close the menu, as with Escape).
      if (isSecondaryPress(e, deps.mac) || (rec?.menuOpen && rec.primary)) {
        e.preventDefault();
        if (!v.hasFocus) v.focus();
      }
      // Never cancel a right-button mouseup here: Firefox on Windows takes its menu from it (F36).
    },
    true,
  );

  // Shift+F10 or the Menu key in the code, after CodeMirror: cancelled, so neither Chromium nor Firefox starts its own menu.
  host.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !isMenuKey(e)) return;
    const v = deps.view();
    if (!v || e.target !== v.contentDOM || !anySelected(v)) return;
    e.preventDefault();
    mark("app");
    openAtHead(v);
  });

  host.addEventListener("contextmenu", (e) => {
    const v = deps.view();
    const p = rec;
    rec = null;
    const via: MenuVia = p && (p.secondary || ((p.type === "touch" || p.type === "pen") && now() - p.t < 2000)) ? "pointer" : "keyboard";
    const pointerType = (e as MouseEvent & { pointerType?: string }).pointerType || p?.type || "";
    const d = menuDecision({
      hasView: v !== null,
      via,
      pointerType,
      shift: e.shiftKey,
      again: via === "pointer" ? !!p?.menuOpen : againUntil > now(),
      place: v ? placeOf(v, e.target) : "other",
      inside: via === "pointer" && v !== null && onSelection(v, e),
      anySelected: v !== null && anySelected(v),
      focusInContent: v !== null && document.activeElement === v.contentDOM,
    });
    againUntil = 0;
    mark(d);
    if (d === "browser" || !v) return;
    e.preventDefault();
    if (via === "pointer") open(v, { x: e.clientX, y: e.clientY }, "pointer");
    else openAtHead(v);
  });
}
