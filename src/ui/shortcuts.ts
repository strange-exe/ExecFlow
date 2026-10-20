// The keyboard shortcuts dialog (? or Ctrl+/ outside the editor). It also explains how to leave
// the editor, since Tab there indents (CodeMirror's escape hatch: Esc then Tab, or Ctrl+M).
import { h, isMac } from "./dom";
import { dialogShell, openModal } from "./dialogs";

export function shortcutGroups(mac = isMac()): { title: string; rows: [string, string][] }[] {
  const mod = mac ? "Cmd" : "Ctrl";
  return [
    {
      title: "Run",
      rows: [
        [`${mod} Enter`, "Run the open file"],
        [`${mod} .`, "Stop the program"],
        ["Ctrl D", "End of input, while the program waits for input"],
      ],
    },
    {
      title: "Files",
      rows: [
        [`${mod} S`, "Save now (and sync, once GitHub is connected)"],
        ["Alt W", "Close the open file"],
        [`${mod} Shift E`, "Go to the file list"],
        ["F2", "Rename the chosen file or folder (in the list)"],
        ["Delete", "Delete it (asks first); on a tab, close the file"],
        ["Shift F10", "More actions for the chosen file"],
      ],
    },
    {
      title: "Editor",
      rows: [
        ["Esc then Tab", "Leave the editor (Tab alone indents)"],
        [mac ? "Shift Alt M" : "Ctrl M", "Turn Tab-moves-focus on or off"],
        [`${mod} F`, "Find in the file"],
        [`${mod} /`, "Comment or uncomment the line"],
        [`${mod} Z`, "Undo"],
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
        [`${mod} \``, "Go to the output (or the input field, while a program waits)"],
        ["?", "Show these shortcuts"],
      ],
    },
  ];
}

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
