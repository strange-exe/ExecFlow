// Draws the plain-language help (core/error-help.ts) under an error: a lightbulb, what the message
// means, then what to check. A lazy chunk with its table, loaded after a failed run or a problem,
// so a first visit never carries either. Every piece of text goes in as a text node (h() never
// parses markup): the fill-ins come from the error message, which a program can write.
import lightbulb from "@phosphor-icons/core/assets/regular/lightbulb.svg?raw";
import { helpFor, helpForLimit, type ErrorHelp, type HelpPart, type HelpSubject } from "../core/error-help";
import type { RunStatus } from "../core/types";
import { h, svg } from "./dom";
import { pathData } from "./icons";

export interface HelpView {
  /** The table entry it explains (the Problems list shows each kind once). */
  kind: string;
  element: HTMLElement;
  /**
   * The id for the error's aria-describedby: the words' own element, not the note, whose name
   * ("What this error means") would be read as the whole description (accname: aria-label wins).
   */
  describedBy: string;
}

/** The icon's Phosphor source (tests check it holds path data only). */
export const LIGHTBULB_SOURCE: string = lightbulb;

const parts = (list: readonly HelpPart[]) => list.map((p) => ("code" in p ? h("code", null, p.code) : p.text));

/**
 * The help for `d` as a note (role=note, named "What this error means") with the DOM id `id`, its
 * words in `${id}-text`; null when the table has nothing for it.
 */
export function renderHelp(d: HelpSubject, id: string): HelpView | null {
  const help = helpFor(d);
  return help ? draw(help, id, "What this error means") : null;
}

/** The help for a run stopped at its time or output limit (core/error-help.ts helpForLimit), drawn the same way. */
export function renderLimitHelp(status: RunStatus, limits: { seconds: number; chars: number }, id: string): HelpView | null {
  const help = helpForLimit(status, limits);
  return help ? draw(help, id, "Why the program was stopped") : null;
}

function draw(help: ErrorHelp, id: string, name: string): HelpView {
  const describedBy = `${id}-text`;
  const element = h(
    "div",
    { class: "err-help", id, role: "note", "aria-label": name, "data-help": help.id },
    svg("svg", { class: "icon err-help-icon", viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": "true", focusable: "false" },
      ...pathData(lightbulb).map((path) => svg("path", { d: path }))),
    h("div", { class: "err-help-text", id: describedBy }, h("p", { class: "err-help-means" }, ...parts(help.means)), h("p", { class: "err-help-tips" }, ...parts(help.tips))),
  );
  return { kind: help.id, element, describedBy };
}
