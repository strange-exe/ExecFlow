// The keyboard shortcuts dialog (? or Ctrl+/ outside the code and text fields: workbench.ts). It
// also explains how to leave the editor, since Tab there indents (CodeMirror's escape hatch: Esc
// then Tab, or Ctrl+M). The keys are spelled once, in shortcutKeys(), which the command palette
// shows too, so the two lists can't drift apart.
import { h, isMac } from "./dom";
import { dialogShell, openModal } from "./dialogs";

/** "Snippet" also names completion templates here, so the row says what Capture snippet makes. */
const CODE_MENU = "Menu for the selected code: Capture snippet (an image of the lines), Cut, Copy, Select all";

/**
 * Every key the app documents, for this platform. The editor's keys are CodeMirror's own bindings
 * (shortcuts.test.ts reads the installed keymaps and fails when a labelled command has no row or
 * other keys): commands 6.11.1, search 6.7.2, language 6.13.1, lint 6.9.7.
 */
export function shortcutKeys(mac = isMac()) {
  const mod = mac ? "Cmd" : "Ctrl";
  return {
    search: `${mod} P`,
    commands: `F1 or ${mod} Shift P`,
    run: `${mod} Enter`,
    stop: `${mod} .`,
    save: `${mod} S`,
    close: "Alt W",
    fileList: `${mod} Shift E`,
    rename: "F2",
    tabFocus: mac ? "Shift Alt M" : "Ctrl M",
    find: `${mod} F`,
    findNext: `F3 or ${mod} G`,
    gotoLine: `${mod} Alt G`,
    selectNext: `${mod} D`,
    selectAllMatches: `${mod} Shift L`,
    addCursor: `${mod} Alt Up or ${mod} Alt Down`,
    clickCursor: `${mod} Click`,
    moveLine: "Alt Up or Alt Down",
    comment: `${mod} /`,
    fold: mac ? "Cmd Alt [ or Cmd Alt ]" : "Ctrl Shift [ or Ctrl Shift ]",
    foldAll: "Ctrl Alt [ or Ctrl Alt ]",
    nextProblem: "F8",
    undo: `${mod} Z`,
    redo: mac ? "Cmd Shift Z" : "Ctrl Y",
    cut: `${mod} X`,
    copy: `${mod} C`,
    selectAll: `${mod} A`,
    output: `${mod} \``,
    shortcuts: `? or ${mod} /`,
  };
}

export function shortcutGroups(mac = isMac()): { title: string; rows: [string, string][] }[] {
  const k = shortcutKeys(mac);
  return [
    {
      title: "Search",
      rows: [
        [k.search, "Search the files and commands"],
        // Firefox keeps Ctrl+Shift+P for a private window: F1 first (code.visualstudio.com/docs/setup/vscode-web).
        [k.commands, "Search the commands only"],
      ],
    },
    {
      title: "Run",
      rows: [
        [k.run, "Run the open file"],
        [k.stop, "Stop the program"],
        ["Ctrl D", "End of input, while the program waits for input"],
      ],
    },
    {
      title: "Files",
      rows: [
        [k.save, "Save now (and sync, once GitHub is connected)"],
        [k.close, "Close the open file"],
        [k.fileList, "Go to the file list"],
        [k.rename, "Rename the chosen file or folder (in the list)"],
        ["Delete", "Delete it (asks first); on a tab, close the file"],
        ["Shift F10", "More actions for the chosen file (in the list)"],
      ],
    },
    {
      title: "Editor",
      rows: [
        ["Esc then Tab", "Leave the editor (Tab alone indents; Esc again if it closed something)"],
        // The code menu (code-menu.ts). macOS has no browser keyboard menu, so no "again" row there.
        ...(mac
          ? [["Shift F10", CODE_MENU] as [string, string]]
          : [["Shift F10 or Menu", CODE_MENU] as [string, string], ["Shift F10 then Shift F10", "The browser's own menu for the selected code"] as [string, string]]),
        [k.tabFocus, "Turn Tab-moves-focus on or off"],
        // CodeMirror's search panel holds the replace field too: it has no key of its own.
        [k.find, "Find or replace in the file"],
        [k.findNext, "Next match (with Shift, the previous one)"],
        [k.gotoLine, "Go to a line"],
        [k.selectNext, "Select the next match of the selection too"],
        [k.selectAllMatches, "Select every match of the selection"],
        [k.addCursor, "Add a cursor on the line above or below"],
        [k.clickCursor, "Add a cursor where you click"],
        [k.moveLine, "Move the line up or down"],
        [k.comment, "Comment or uncomment the line"],
        [k.fold, "Fold or unfold the block at the cursor"],
        [k.foldAll, "Fold or unfold every block"],
        [k.nextProblem, "Go to the next problem in the file"],
        [k.undo, "Undo"],
        [k.redo, "Redo"],
      ],
    },
    {
      title: "Suggestions",
      rows: [
        ["Ctrl Space", "Show suggestions"],
        // macOS often keeps Ctrl Space for switching input sources; CodeMirror adds Alt ` there.
        ...(mac ? [["Alt `", "Show suggestions, when Ctrl Space switches the keyboard"] as [string, string]] : []),
        // Nothing is picked when the list opens (extensions.ts, selectOnOpen: false), so Enter
        // makes a new line until an arrow key picks an option.
        ["Down or Up", "Pick a suggestion"],
        ["Enter", "Accept the picked suggestion"],
        // In Tab-moves-focus mode (Ctrl M) Tab leaves the editor, inside a snippet too.
        ["Tab or Shift Tab", "Next or previous field in a snippet (not in Tab-moves-focus mode)"],
        ["Esc", "Close the list, or end the snippet"],
      ],
    },
    {
      title: "Panels",
      rows: [
        [k.output, "Go to the output (or the input field, while a program waits)"],
        [k.shortcuts, "Show these shortcuts (outside the code and text fields)"],
      ],
    },
  ];
}

/** The palette's keys live in palette-keys.ts (the window's key handler needs them on a first visit). */
export { paletteKey } from "./palette-keys";

/**
 * "Ctrl Shift E" as three keycaps; " then " and " or " stay words between keycaps. The split keeps
 * the joining words (a capture group), so they come out at the odd indexes.
 */
export function keyParts(keys: string): { word?: string; caps?: string[] }[] {
  return keys.split(/ (then|or) /).map((part, i) => (i % 2 ? { word: ` ${part} ` } : { caps: part.split(" ") }));
}

function keysToNodes(keys: string): (Node | string)[] {
  return keyParts(keys).flatMap((p): (Node | string)[] => (p.word ? [p.word] : p.caps!.map((k) => h("kbd", { class: "keycap" }, k))));
}

export function createShortcutsDialog(): { open(opener?: HTMLElement): void } {
  const { dialog, body } = dialogShell("shortcuts", "Keyboard shortcuts");
  // One grid for every group (each list is a subgrid of it), so every description starts at the
  // same x, however wide one group's keys are.
  const grid = h("div", { class: "shortcut-grid" });
  for (const group of shortcutGroups()) {
    grid.append(
      h("h3", { class: "section-title" }, group.title),
      h(
        "dl",
        { class: "shortcut-list" },
        ...group.rows.flatMap(([keys, what]) => [
          // "Esc then Tab" is a sequence and "Down or Up" a choice: keycaps with the word between them.
          h("dt", null, ...keysToNodes(keys)),
          h("dd", null, what),
        ]),
      ),
    );
  }
  body.append(grid);
  return { open: (opener) => openModal(dialog, dialog.querySelector<HTMLElement>(".icon-btn"), opener) };
}
