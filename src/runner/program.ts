// Which files make up the C/C++ program the user pressed Run on. Pure, so it is unit-tested and
// the page can show what will be built before anything is compiled.
//
// Rules (the entry is the file the user runs; its folder is the program's root):
// - Translation units are the C/C++ sources in the root folder and its sub-folders, except
//   dot-folders (".git", ".vscode"...) and conflict copies.
// - A sub-folder holding a source that defines main() is a separate program (an exercises folder,
//   a tests folder), so it is left out as a whole.
// - In the root folder itself, other sources that define their own main() are left out and
//   listed in `skipped` ("ex2.c, ex3.c have their own main()"); the entry is always built.
// - Every C/C++ source and header the request carries is mounted for the compiler, so
//   `#include "../common/util.h"` works; only the units above are compiled.
// - A unit is "needed" when the entry reaches it through quoted includes: it includes a header the
//   entry (or another needed unit) includes, or it is a header's namesake (util.h and util.c).
//   The other units are still built, so a prototype in main.c with its body in ops.c works, but
//   they are `optional`: when every error of a build is in an optional unit or a header only
//   optional units include, leaveOutUnused() drops those units and the program is built again
//   (an unrelated broken file in the folder no longer stops the program).

import { isConflictCopy, isInside, nameOf, parentOf, splitExtension } from "../core/paths";
import { detectLanguage, isHeader } from "../core/languages";
import type { ToolDiagnostic, WorkspaceFile, WsPath } from "../core/types";
import { includeClosure } from "./cpp-build";
import { definesMain } from "./cpp-scan";

export type CLang = "c" | "cpp";

export interface BuildUnit {
  path: WsPath;
  lang: CLang;
}

export interface ProgramPlan {
  entry: WsPath;
  /** Folder of the entry ("" for the workspace root). */
  root: WsPath;
  /** Compiled one by one, entry first (so its errors arrive first), then by path. */
  units: BuildUnit[];
  /** Sources in the root folder left out because they define their own main(). */
  skipped: WsPath[];
  /** Everything the compiler can see: units, other C/C++ sources and headers. */
  mounted: WorkspaceFile[];
  /** Units the entry doesn't reach through its includes (built, but left out if only they fail). */
  optional: WsPath[];
  /** The entry, the needed units and every file they include: an error here always stops the build. */
  needed: WsPath[];
}

export type PlanResult = { ok: true; plan: ProgramPlan } | { ok: false; reason: string };

/** "c" or "cpp" for a translation unit, null for anything else (headers included). */
export function unitLanguage(path: string): CLang | null {
  const id = detectLanguage(nameOf(path))?.id;
  return id === "c" || id === "cpp" ? id : null;
}

/** Whether `path` lies in a folder whose name starts with "." somewhere below `root`. */
function inDotFolder(path: string, root: string): boolean {
  const rel = root === "" ? path : path.slice(root.length + 1);
  const folders = rel.split("/").slice(0, -1);
  return folders.some((f) => f.startsWith("."));
}

export function planProgram(entry: WsPath, files: readonly WorkspaceFile[]): PlanResult {
  const entryLang = unitLanguage(entry);
  if (!entryLang) {
    return {
      ok: false,
      reason: isHeader(nameOf(entry))
        ? `${nameOf(entry)} is a header, so it can't run on its own: run the .c or .cpp file that has main().`
        : `${nameOf(entry)} isn't a C or C++ source file.`,
    };
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  if (!byPath.has(entry)) return { ok: false, reason: `${nameOf(entry)} isn't in the files sent to the compiler.` };
  const root = parentOf(entry);

  const mounted = files.filter((f) => !isConflictCopy(f.path) && (unitLanguage(f.path) !== null || isHeader(nameOf(f.path))));
  const candidates = mounted.filter(
    (f) => f.path !== entry && unitLanguage(f.path) && isInside(f.path, root) && !inDotFolder(f.path, root),
  );

  // Sub-folders (below root) that hold their own program.
  const hasMain = new Map(candidates.map((f) => [f.path, definesMain(f.text)]));
  const programFolders = new Set<string>();
  for (const f of candidates) if (hasMain.get(f.path) && parentOf(f.path) !== root) programFolders.add(parentOf(f.path));
  const inProgramFolder = (path: string) => [...programFolders].some((dir) => isInside(path, dir));

  const units: BuildUnit[] = [{ path: entry, lang: entryLang }];
  const skipped: WsPath[] = [];
  for (const f of [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (inProgramFolder(f.path)) continue;
    if (hasMain.get(f.path)) {
      skipped.push(f.path);
      continue;
    }
    units.push({ path: f.path, lang: unitLanguage(f.path)! });
  }
  // A conflict copy can be run on purpose (to try the other version); it is then the only copy built.
  if (isConflictCopy(entry) && !mounted.some((f) => f.path === entry)) mounted.push(byPath.get(entry)!);
  const { optional, needed } = neededUnits(entry, units, mounted, byPath, root);
  return { ok: true, plan: { entry, root, units, skipped, mounted, optional, needed } };
}

const stemOf = (path: WsPath) => splitExtension(nameOf(path)).stem;

/** Splits the units into ones the entry reaches through quoted includes and the optional rest. */
function neededUnits(
  entry: WsPath, units: readonly BuildUnit[], mounted: readonly WorkspaceFile[], byPath: ReadonlyMap<WsPath, WorkspaceFile>, root: WsPath,
): { optional: WsPath[]; needed: WsPath[] } {
  const files = new Map<WsPath, WorkspaceFile>(mounted.map((f) => [f.path, f]));
  if (!files.has(entry)) files.set(entry, byPath.get(entry)!);
  const reach = new Map(units.map((u) => [u.path, includeClosure(u.path, files, root)]));
  const needed = new Set<WsPath>([entry, ...reach.get(entry)!]);
  const used = new Set<WsPath>([entry]);
  for (let grew = true; grew; ) {
    grew = false;
    const stems = new Set([...needed].filter((p) => isHeader(nameOf(p))).map(stemOf));
    for (const u of units) {
      if (used.has(u.path)) continue;
      const own = reach.get(u.path)!;
      if (!stems.has(stemOf(u.path)) && !own.some((p) => needed.has(p) && isHeader(nameOf(p)))) continue;
      used.add(u.path);
      needed.add(u.path);
      for (const p of own) needed.add(p);
      grew = true;
    }
  }
  return { optional: units.map((u) => u.path).filter((p) => !used.has(p)), needed: [...needed] };
}

/**
 * When every error of a failed build is in optional units or in files only they include, the plan
 * without those units, and which they were; null when an error touches what the program needs (or
 * names no file), so the build failure stands as it is.
 */
export function leaveOutUnused(plan: ProgramPlan, diagnostics: readonly ToolDiagnostic[]): { plan: ProgramPlan; leftOut: WsPath[] } | null {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (!errors.length || plan.optional.length === 0) return null;
  const needed = new Set(plan.needed);
  const paths = new Set<WsPath>();
  for (const e of errors) {
    if (!e.path || needed.has(e.path)) return null;
    paths.add(e.path);
  }
  const files = new Map(plan.mounted.map((f) => [f.path, f]));
  const leftOut = plan.optional.filter((u) => paths.has(u) || includeClosure(u, files, plan.root).some((p) => paths.has(p)));
  if (!leftOut.length) return null;
  const out = new Set(leftOut);
  return {
    leftOut,
    plan: { ...plan, units: plan.units.filter((u) => !out.has(u.path)), optional: plan.optional.filter((p) => !out.has(p)) },
  };
}

/** Where the compiler sees the workspace (a fresh mount, "/w2", replaces it if names collide). */
export const MOUNT = "/w";

/** The compiler's view of a workspace path. */
export function memfsPath(path: WsPath, mount = MOUNT): string {
  return `${mount}/${path}`;
}

/** Directory the program's quoted includes are also searched in (clang -iquote). */
export function quoteDir(root: WsPath, mount = MOUNT): string {
  return root === "" ? mount : `${mount}/${root}`;
}
