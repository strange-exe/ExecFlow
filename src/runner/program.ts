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

import { isConflictCopy, isInside, nameOf, parentOf } from "../core/paths";
import { detectLanguage, isHeader } from "../core/languages";
import type { WorkspaceFile, WsPath } from "../core/types";
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
  return { ok: true, plan: { entry, root, units, skipped, mounted } };
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
