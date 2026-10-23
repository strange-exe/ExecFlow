// The Problems list: every diagnostic of every file as one button that opens the file and puts the
// cursor on it. A row reads left to right: icon, severity word, message, then path:line:col and the
// tool right after the message (not pushed to the far edge). Problems with the program as a whole
// (no file) are listed first, as plain rows. Under the first row of each kind the error help
// explains it (a lazy chunk: see useHelp), as the row's description.
import type { HelpSubject } from "../core/error-help";
import type { DiagSeverity } from "../core/types";
import type { Problem } from "../editor/editor-manager";
import { h, plural } from "./dom";
import { icon, type IconName } from "./icons";

/** The same words the editor's lint panel uses (editor/diagnostics.ts SEVERITY_WORD), kept here so
 * the shell doesn't load CodeMirror's lint code before the editor chunk arrives. */
export const SEVERITY_WORD: Readonly<Record<DiagSeverity, string>> = { error: "Error", warning: "Warning", info: "Info", hint: "Hint" };

const SEVERITY_ICON: Record<Problem["severity"], IconName> = { error: "x-circle", warning: "warning", info: "info", hint: "info" };

/** Everything a row shows or opens: two lists with the same keys draw the same rows. */
const rowKey = (p: Problem) => JSON.stringify([p.severity, p.path, p.line, p.col ?? null, p.message, p.source]);

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

/** Draws the help for a diagnostic (ui/error-help-view.ts renderHelp). */
export type RenderHelp = (d: HelpSubject, id: string) => { kind: string; element: HTMLElement; describedBy: string } | null;

export class ProblemsView {
  readonly element: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLElement;
  /** The rows' keys, in order (null before the first list). */
  private keys: string[] | null = null;
  /** The rows' problems, in order. */
  private rows: readonly Problem[] = [];
  private renderHelp: RenderHelp | null = null;
  onOpen: ((p: Problem) => void) | null = null;

  constructor() {
    this.list = h("ul", { class: "problems", "aria-label": "Problems" });
    this.empty = h("p", { class: "panel-empty" }, "No problems in the files that ran or were checked.");
    this.element = h("div", { class: "problems-view" }, this.empty, this.list);
  }

  set(problems: readonly Problem[]): void {
    const keys = problems.map(rowKey);
    const old = this.keys;
    // Every check result calls this, mostly with the same list: keep those rows as they are.
    if (old && keys.length === old.length && keys.every((k, i) => k === old[i])) return;
    // New rows would drop the keyboard focus on an old one to the page. It moves to the same problem,
    // else the row now in its place, else the panel (measured: a check landing mid-Tab lost it).
    const focusedAt = [...this.list.children].findIndex((row) => row.contains(document.activeElement));
    this.keys = keys;
    this.rows = problems;
    this.empty.hidden = problems.length > 0;
    this.list.hidden = problems.length === 0;
    this.list.replaceChildren(
      ...problems.map((p) => {
        const where = p.path ? `${p.path}:${p.line}${p.col !== undefined ? `:${p.col}` : ""}` : "Whole program";
        const message = p.message.split("\n")[0];
        const parts = [
          icon(SEVERITY_ICON[p.severity], "problem-icon"),
          h("span", { class: "problem-severity" }, SEVERITY_WORD[p.severity]),
          // Cut short with an ellipsis on wide screens: the tooltip has all of it.
          h("span", { class: "problem-message", title: message }, message),
          h("span", { class: "problem-where" }, where),
          p.source ? h("span", { class: "problem-source" }, p.source) : null,
        ];
        if (!p.path) return h("li", null, h("div", { class: "problem static", "data-severity": p.severity }, ...parts));
        const button = h("button", { type: "button", class: "problem", "data-severity": p.severity, "data-path": p.path, "data-line": p.line }, ...parts);
        button.addEventListener("click", () => this.onOpen?.(p));
        return h("li", null, button);
      }),
    );
    this.addHelp();
    if (focusedAt < 0 || !old) return;
    const same = keys.indexOf(old[focusedAt]!);
    const row = this.list.children[same >= 0 ? same : Math.min(focusedAt, keys.length - 1)];
    const target = row?.querySelector("button") ?? this.list.querySelector("button");
    (target ?? this.element.closest<HTMLElement>("[tabindex]"))?.focus();
  }

  /** Whether any row could have help (an error or a warning from a tool), so the chunk is worth loading. */
  get wantsHelp(): boolean {
    return !this.renderHelp && this.rows.some((p) => p.diag && (p.severity === "error" || p.severity === "warning"));
  }

  /**
   * The error help arrived: rows get their help without being rebuilt, so the focus stays put.
   * Each kind of error is explained once, under its first row (ten "undeclared identifier" rows
   * get one explanation); the row's button names it as its description.
   */
  useHelp(render: RenderHelp): void {
    this.renderHelp = render;
    this.addHelp();
  }

  private addHelp(): void {
    const render = this.renderHelp;
    if (!render) return;
    const seen = new Set<string>();
    [...this.list.children].forEach((row, i) => {
      row.querySelector(":scope > .err-help")?.remove();
      const d = this.rows[i]?.diag;
      const view = d ? render(d, `problem-help-${i}`) : null;
      if (!view || seen.has(view.kind)) return;
      seen.add(view.kind);
      row.append(view.element);
      row.querySelector("button.problem")?.setAttribute("aria-describedby", view.describedBy);
    });
  }

  focusFirst(): boolean {
    const first = this.list.querySelector<HTMLElement>("button");
    first?.focus();
    return Boolean(first);
  }
}
