// Capture snippet's entry (final-v3 sections 2.1, 5.6 and 7.2), in the shell: the file menu's item,
// and open() for every entry point (that item, the editor head's button, the code menu). It decides
// on the spot, with no CodeMirror at run time, whether the selection can be captured; a refusal
// goes to the page's notice 50 ms later (cleared first, so the same sentence twice is read twice).
// Only a capturable selection loads the dialog's chunk (snippet-dialog.ts), once, guarded against a
// second press while it loads.
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nameOf } from "../core/paths";
import { canCopyImages, menuLabel, pickLines, readImageOptions, refusalMessage, type Entry, type LinePlan, type ShellMessage } from "../core/snippet";
import type { MenuItem } from "./menu";
import type { Notice } from "./notice";
import type { SnippetDialogArgs } from "./snippet-dialog";

export type { Entry };

interface Shown {
  readonly isConnected: boolean;
  getClientRects(): { readonly length: number };
}

export interface CaptureDeps {
  /** #app: the state attributes tests wait on (data-capture, data-capture-reason, data-captures). */
  readonly root: HTMLElement;
  readonly notice: Pick<Notice, "show" | "clear">;
  readonly editors: () => { readonly activeId: string | null; state(id: string): EditorState | null };
  readonly view: () => EditorView | null;
  readonly fileOf: (id: string | null) => { readonly path: string } | null;
  readonly narrow: () => boolean;
  /** Below 900 px the item lives in the drawer: it closes first (focus to Files, the code no longer inert). */
  readonly closeDrawer: () => void;
  /** Where focus goes on phones when the dialog closes. */
  readonly filesButton: HTMLElement;
  /** More file actions: where focus goes when the opener is gone or hidden. */
  readonly fileActions: HTMLElement;
  readonly coarse?: () => boolean;
  readonly dialogOpen?: () => boolean;
  readonly storage?: () => Pick<Storage, "getItem" | "setItem"> | null;
  readonly canCopy?: () => boolean;
  readonly load?: () => Promise<{ openSnippetDialog(args: SnippetDialogArgs): void }>;
}

export interface SnippetCapture {
  /** The file menu's item: shown whenever a file is open, never disabled (it explains on click). */
  menuItems(): MenuItem[];
  open(opener: HTMLElement, entry: Entry): void;
}

/** The element is in the page and laid out (a window that crossed 900 px may have hidden it). */
const isShown = (el: Shown) => el.isConnected && el.getClientRects().length > 0;

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createSnippetCapture(deps: CaptureDeps): SnippetCapture {
  const coarse = deps.coarse ?? (() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  const dialogOpen = deps.dialogOpen ?? (() => document.querySelector("#snippet-dialog[open]") !== null);
  const storage = deps.storage ?? safeStorage;
  const canCopy = deps.canCopy ?? (() => canCopyImages(globalThis));
  const load = deps.load ?? (() => import("./snippet-dialog"));
  let opening: Promise<void> | null = null;

  /** The active file's path and its live state, or null. */
  function active(): { path: string; state: EditorState } | null {
    const editors = deps.editors();
    const id = editors.activeId;
    const state = id ? editors.state(id) : null;
    const path = deps.fileOf(id)?.path;
    return id && state && path && deps.view() ? { path, state } : null;
  }

  function refuse(m: ShellMessage & { kind: "refused" }, entry: Entry) {
    const { text, tone } = refusalMessage(m, { coarse: coarse(), entry, open: false });
    setTimeout(() => {
      deps.notice.show(text, { tone });
      deps.root.dataset.capture = "refused";
      deps.root.dataset.captureReason = m.reason;
      // One counter for the refusals here and the dialog's exports: it rises when each one ends.
      deps.root.dataset.captures = String((Number(deps.root.dataset.captures) || 0) + 1);
    }, 50);
  }

  function refusalOf(plan: Exclude<LinePlan, { ok: true }>): ShellMessage & { kind: "refused" } {
    return plan.reason === "cap" ? { kind: "refused", reason: "cap", count: plan.count } : { kind: "refused", reason: plan.reason };
  }

  /** Where focus goes when the dialog closes, decided then (5.6). */
  function returnTo(opener: HTMLElement, entry: Entry): () => HTMLElement | null {
    const fallback = () => (deps.narrow() ? deps.filesButton : deps.fileActions);
    if (entry === "context") {
      return () => {
        const view = deps.view();
        // view.focus(), never a raw focus() on the code: WebKit scrolls to the selection on that.
        if (view && isShown(view.contentDOM)) {
          view.focus();
          return null;
        }
        return fallback();
      };
    }
    return () => (deps.narrow() ? deps.filesButton : isShown(opener) ? opener : deps.fileActions);
  }

  function open(opener: HTMLElement, entry: Entry): void {
    if (opening || dialogOpen()) return;
    deps.closeDrawer();
    deps.notice.clear();
    const file = active();
    const view = deps.view();
    if (!file || !view) {
      refuse({ kind: "refused", reason: "no-file" }, entry);
      return;
    }
    const plan = pickLines(file.state);
    if (!plan.ok) {
      refuse(refusalOf(plan), entry);
      return;
    }
    const args: SnippetDialogArgs = {
      state: file.state, view, plan, path: file.path, options: readImageOptions(storage()), canCopy: canCopy(),
      returnTo: returnTo(opener, entry), root: deps.root, notice: deps.notice, storage: storage(),
    };
    opening = load()
      .then(
        (m) => m.openSnippetDialog(args),
        (e: unknown) => {
          const detail = e instanceof Error && e.message ? e.message : "something went wrong";
          const { text, tone } = refusalMessage({ kind: "chunk-failed", detail }, { coarse: false, entry, open: false });
          deps.notice.show(text, { tone });
        },
      )
      .finally(() => (opening = null));
  }

  return {
    menuItems(): MenuItem[] {
      const file = active();
      if (!file) return [];
      return [
        {
          label: menuLabel(pickLines(file.state), nameOf(file.path)),
          icon: "image",
          separatorBefore: true,
          run: () => open(deps.fileActions, "menu"),
        },
      ];
    },
    open,
  };
}
