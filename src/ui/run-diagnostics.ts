// What a run's diagnostics add in the editor beyond the tool's own: a Python error raised in one
// file and reached from another marks the calls that led there, so the file that ran shows the line
// that needs attention, not only the module where it ended.
import { nameOf } from "../core/paths";
import type { ToolDiagnostic } from "../core/types";

/** At most this many call marks per run (a deep recursion has one frame per call). */
export const MAX_CALL_MARKS = 20;

/**
 * For every error with a call stack, an "info" mark on each workspace frame that led to it (not
 * the error's own line), one per file and line. The frames are the tool's, so they are trusted as
 * much as the error itself: same paths, same checks downstream. Each mark has the role
 * "call-site", so the editor draws it as a call site (dashed outline, gutter arrow) rather than an
 * info square; its severity and message stay, so the Problems row and screen readers say the same.
 */
export function callSiteMarks(list: readonly ToolDiagnostic[]): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = [];
  const seen = new Set<string>();
  for (const d of list) {
    if (d.severity !== "error" || !d.path || !d.stack?.length) continue;
    const what = d.code ?? "an error";
    for (const frame of d.stack) {
      if (!frame.path || (frame.path === d.path && frame.line === d.line)) continue;
      const key = `${frame.line} ${frame.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: frame.path,
        line: frame.line,
        unit: frame.unit,
        base: frame.base,
        severity: "info",
        source: d.source,
        code: d.code,
        message: `This call led to ${what} in ${nameOf(d.path)}, line ${d.line}.`,
        role: "call-site",
      });
      if (out.length >= MAX_CALL_MARKS) return out;
    }
  }
  return out;
}
