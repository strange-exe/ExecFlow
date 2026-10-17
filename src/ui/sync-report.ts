// What a sync did, as the one notice line after it (only when something changed, or something
// needs the user's attention). Conflict copies are returned too: the notice's action opens them.
import { nameOf } from "../core/paths";
import type { WsPath } from "../core/types";
import type { SyncReport } from "../sync/engine";
import { listNames, plural } from "./dom";

export interface ReportContext {
  /** "owner/repo" */
  repo: string;
  /** Open tabs that closed because the sync deleted their file. */
  closed: readonly WsPath[];
  /** Open files with unsaved typing that the reload left alone. */
  kept: readonly WsPath[];
}

export interface ReportNotice {
  text: string;
  tone: "success" | "warning";
  conflicts: { path: WsPath; copy: WsPath }[];
  /** A file was left for the next sync (typed in meanwhile): sync again soon. */
  again: boolean;
}

const names = (paths: readonly string[]) => listNames(paths.map(nameOf));
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function summarizeReport(report: SyncReport, ctx: ReportContext): ReportNotice | null {
  const parts: string[] = [];
  let warn = false;

  const localDeleted = report.deleted.filter((d) => d.where === "local").length;
  const remoteDeleted = report.deleted.filter((d) => d.where === "remote").length;
  const counts = [
    report.pulled.length ? `${plural(report.pulled.length, "file")} downloaded` : "",
    report.pushed.length ? `${plural(report.pushed.length, "file")} uploaded` : "",
    localDeleted ? `${plural(localDeleted, "file")} deleted here` : "",
    remoteDeleted ? `${plural(remoteDeleted, "file")} deleted on GitHub` : "",
  ].filter(Boolean);
  if (counts.length) parts.push(`Synced with ${ctx.repo}: ${listNames(counts, 4)}.`);

  const conflicts = report.conflicts.map((c) => ({ path: c.path, copy: c.copy }));
  if (conflicts.length === 1) {
    const [c] = conflicts;
    parts.push(`${nameOf(c.path)} changed on both sides: GitHub's version keeps the name, yours is in ${nameOf(c.copy)}.`);
  } else if (conflicts.length > 1) {
    parts.push(`${conflicts.length} files changed on both sides: GitHub's versions keep the names, yours are in conflict copies.`);
  }
  if (conflicts.length) warn = true;

  if (ctx.closed.length) parts.push(`Closed ${names(ctx.closed)}: deleted on GitHub.`);

  const later = [...new Set([...report.skipped, ...ctx.kept])];
  if (later.length) {
    parts.push(`You were typing in ${names(later)}, so ${verb(later.length, "it syncs", "they sync")} again in a moment.`);
    warn = true;
  }
  if (report.notPushed.length) {
    parts.push(`Not uploaded: ${names(report.notPushed)} (files in .github/workflows need a token with the Workflows permission).`);
    warn = true;
  }
  if (report.opaque.length) {
    const n = report.opaque.length;
    parts.push(`${names(report.opaque.map((o) => o.path))} ${verb(n, "is", "are")} kept read-only here (binary or special ${verb(n, "file", "files")}).`);
  }
  if (report.ignoredRemotePaths.length) {
    const n = report.ignoredRemotePaths.length;
    parts.push(`${plural(n, "file")} in the repository ${verb(n, "has a name", "have names")} this computer can't use, so ${verb(n, "it was", "they were")} left out.`);
    warn = true;
  }
  if (report.historyRewritten) {
    parts.push("The repository's history was rewritten, so files deleted there were kept here.");
    warn = true;
  }
  if (!parts.length) return null;
  return { text: parts.join(" "), tone: warn ? "warning" : "success", conflicts, again: later.length > 0 };
}
