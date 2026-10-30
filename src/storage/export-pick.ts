// Downloading part of the workspace (0.18.0, owner's picks 2026-10-30): a file, a folder, or the
// files and folders ticked in "Choose files...". Pure: the store's export (every file's bytes as
// saved) goes in, the part that was picked comes out, with paths starting at the folder that holds
// the pick so the .zip unpacks to one folder.
import { isInside, nameOf, parentOf } from "../core/paths";
import type { ExportData } from "./workspace";

/** A path made relative to `base` ("" leaves it as it is). */
const under = (path: string, base: string) => (base === "" ? path : path.slice(base.length + 1));

/**
 * The files, empty folders and left-out read-only files that the picks cover (a folder covers
 * everything under it), each once and in the export's order, with paths relative to `base`.
 */
export function pickExport(data: ExportData, picks: readonly string[], base = ""): ExportData {
  const covered = (path: string) => picks.some((p) => isInside(path, p));
  return {
    files: data.files.filter((f) => covered(f.path)).map((f) => ({ ...f, path: under(f.path, base) })),
    dirs: data.dirs.filter(covered).map((d) => under(d, base)),
    // Named as in the workspace: the notice says which files were left out.
    skipped: data.skipped.filter(covered),
  };
}

/** The deepest folder that holds every pick ("" for the top), where the .zip's paths start. */
export function zipBase(picks: readonly string[]): string {
  if (!picks.length) return "";
  let base = parentOf(picks[0]);
  for (const p of picks.slice(1)) while (base !== "" && !isInside(parentOf(p), base)) base = parentOf(base);
  return base;
}

/** The .zip's file name: the one folder picked, the folder holding the pick, or the workspace's name. */
export function zipName(picks: readonly string[], workspace: string): string {
  const base = zipBase(picks);
  const name = picks.length === 1 ? nameOf(picks[0]) : base ? nameOf(base) : workspace;
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "files";
  return `${safe}.zip`;
}
