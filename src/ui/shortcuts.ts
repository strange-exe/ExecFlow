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
      title: "Panels",
      rows: [
        [`${mod} \``, "Go to the output (or the input field, while a program waits)"],
        ["?", "Show these shortcuts"],
      ],
    },
  ];
}

export function createShortcutsDialog(): { open(opener?: HTMLElement): void } {
  const { dialog, body } = dialogShell("shortcuts", "Keyboard shortcuts");
  for (const group of shortcutGroups()) {
    body.append(
      h("h3", { class: "section-title" }, group.title),
      h(
        "dl",
        { class: "shortcut-list" },
        ...group.rows.flatMap(([keys, what]) => [
          // "Esc then Tab" is a sequence: keycaps with the word "then" between them.
          h("dt", null, ...keys.split(" then ").flatMap((part, i) => [i ? " then " : "", ...part.split(" ").map((k) => h("kbd", { class: "keycap" }, k))])),
          h("dd", null, what),
        ]),
      ),
    );
  }
  return { open: (opener) => openModal(dialog, dialog.querySelector<HTMLElement>(".icon-btn"), opener) };
}
