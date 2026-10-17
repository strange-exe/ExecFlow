// The one notice line after an import. Files the user would want back (a picture, a big file, a
// file with hidden text-direction characters) are named first, with the reason; a .git folder's
// internals and files past the workspace's room are counted, not named, so they never crowd the
// real refusals out of the sentence. "Show all" lists everything (showRefusals).
import { nameOf } from "../core/paths";
import type { WsPath } from "../core/types";
import { dialogShell, openModal } from "./dialogs";
import { h, listNames, plural, shown } from "./dom";
import type { SkippedFile } from "./import-export";

/** Refused files named in the sentence itself; the rest are "N more". */
export const NAMED_REFUSALS = 3;

export interface ImportOutcome {
  added: number;
  refused: readonly SkippedFile[];
  /** Files imported with invisible characters in them. */
  hidden: readonly WsPath[];
}

export function describeImport(o: ImportOutcome): { text: string; tone: "success" | "warning"; folded: boolean } {
  const parts = [o.added ? `Imported ${plural(o.added, "file")}.` : "Nothing was imported."];
  const named = o.refused.filter((r) => !r.kind);
  const git = o.refused.filter((r) => r.kind === "git").length;
  const limit = o.refused.filter((r) => r.kind === "limit").length;
  const items = named.slice(0, NAMED_REFUSALS).map((r) => `${nameOf(r.name)} (${r.reason})`);
  const more = named.length - items.length;
  if (more) items.push(`${more} more`);
  if (git) items.push(`the .git folder (${plural(git, "file")})`);
  if (limit) items.push(`${plural(limit, "file")} that would put the workspace over its limit`);
  if (items.length) parts.push(`Left out ${listNames(items, items.length)}.`);
  if (o.hidden.length) parts.push(`${listNames(o.hidden.map(nameOf))} ${o.hidden.length === 1 ? "contains" : "contain"} invisible characters (shown as red dots).`);
  return { text: parts.join(" "), tone: o.refused.length ? "warning" : "success", folded: more > 0 || git > 0 || limit > 0 };
}

/** Every refused file with its reason, in a dialog (the notice's "Show all"). */
export function showRefusals(refused: readonly SkippedFile[], returnFocus?: HTMLElement | null): void {
  document.getElementById("import-refusals")?.remove();
  const { dialog, body } = dialogShell("import-refusals", `Left out of the import (${refused.length})`, { wide: true });
  body.append(
    h("p", null, "These files weren't imported. Everything else was."),
    h("ul", { class: "refusal-list" }, ...refused.slice(0, 2000).map((r) => h("li", null, h("span", { class: "refusal-name" }, shown(r.name)), h("span", { class: "refusal-reason" }, shown(r.reason))))),
  );
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  openModal(dialog, null, returnFocus);
}
