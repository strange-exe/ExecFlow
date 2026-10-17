// The Problems list: every diagnostic of every file as one button (severity word, path:line:col,
// message) that opens the file and puts the cursor on it. Problems with the program as a whole
// (no file) are listed first, as plain rows.
import type { DiagSeverity } from "../core/types";
import type { Problem } from "../editor/editor-manager";
import { h, plural } from "./dom";
import { icon, type IconName } from "./icons";

/** The same words the editor's lint panel uses (editor/diagnostics.ts SEVERITY_WORD), kept here so
 * the shell doesn't load CodeMirror's lint code before the editor chunk arrives. */
export const SEVERITY_WORD: Readonly<Record<DiagSeverity, string>> = { error: "Error", warning: "Warning", info: "Info", hint: "Hint" };

const SEVERITY_ICON: Record<Problem["severity"], IconName> = { error: "x-circle", warning: "warning", info: "info", hint: "info" };

export interface ProblemCounts {
  errors: number;
  warnings: number;
  total: number;
}

export function countProblems(list: readonly Problem[]): ProblemCounts {
  return {
    errors: list.filter((p) => p.severity === "error").length,
    warnings: list.filter((p) => p.severity === "warning").length,
    total: list.length,
  };
}

/** "2 errors, 1 warning" (empty when there are none). */
export function describeCounts(c: ProblemCounts): string {
  const parts = [c.errors ? plural(c.errors, "error") : "", c.warnings ? plural(c.warnings, "warning") : ""].filter(Boolean);
  const other = c.total - c.errors - c.warnings;
  if (other) parts.push(plural(other, "note"));
  return parts.join(", ");
}

export class ProblemsView {
  readonly element: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLElement;
  onOpen: ((p: Problem) => void) | null = null;

  constructor() {
    this.list = h("ul", { class: "problems", "aria-label": "Problems" });
    this.empty = h("p", { class: "panel-empty" }, "No problems in the files that ran or were checked.");
    this.element = h("div", { class: "problems-view" }, this.empty, this.list);
  }

  set(problems: readonly Problem[]): void {
    this.empty.hidden = problems.length > 0;
    this.list.hidden = problems.length === 0;
    this.list.replaceChildren(
      ...problems.map((p) => {
        const where = p.path ? `${p.path}:${p.line}${p.col !== undefined ? `:${p.col}` : ""}` : "Whole program";
        const message = p.message.split("\n")[0];
        const parts = [
          icon(SEVERITY_ICON[p.severity], "problem-icon"),
          h("span", { class: "problem-severity" }, SEVERITY_WORD[p.severity]),
          h("span", { class: "problem-where" }, where),
          // Cut short with an ellipsis on wide screens: the tooltip has all of it.
          h("span", { class: "problem-message", title: message }, message),
          p.source ? h("span", { class: "problem-source" }, p.source) : null,
        ];
        if (!p.path) return h("li", null, h("div", { class: "problem static", "data-severity": p.severity }, ...parts));
        const button = h("button", { type: "button", class: "problem", "data-severity": p.severity, "data-path": p.path, "data-line": p.line }, ...parts);
        button.addEventListener("click", () => this.onOpen?.(p));
        return h("li", null, button);
      }),
    );
  }

  focusFirst(): boolean {
    const first = this.list.querySelector<HTMLElement>("button");
    first?.focus();
    return Boolean(first);
  }
}
