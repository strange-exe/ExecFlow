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
 * everything under it), each once and in the export's order, with paths relative to `base`. With
 * `shown` (the files a checklist listed), a folder covers only those: never a file the list hid.
 */
export function pickExport(data: ExportData, picks: readonly string[], base = "", shown?: ReadonlySet<string>): ExportData {
  const covered = (path: string) => picks.some((p) => isInside(path, p));
  return {
    files: data.files.filter((f) => covered(f.path) && (!shown || shown.has(f.path))).map((f) => ({ ...f, path: under(f.path, base) })),
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

/**
 * The fewest picks that cover the ticked files: a folder all of whose files are ticked stands for
 * them (so its .zip unpacks as that folder), else each ticked file. `all` is every file there is;
 * the workspace itself ("") is never a pick, its folders and files are.
 */
export function coverPicks(ticked: readonly string[], all: readonly string[]): string[] {
  const on = new Set(ticked);
  const full = (dir: string) => all.every((p) => !isInside(p, dir) || on.has(p));
  const picks = new Set<string>();
  for (const path of ticked) {
    // The outermost folder of this file that is fully ticked, or the file itself.
    const parts = path.split("/");
    let pick = path;
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (full(dir)) {
        pick = dir;
        break;
      }
    }
    picks.add(pick);
  }
  return [...picks].sort();
}

/** What a folder link carries for these picks: one folder's name and the files relative to it. */
export function linkFolder(picks: readonly string[], files: readonly { path: string; text: string }[]): { name: string; files: { name: string; text: string }[] } {
  const covered = files.filter((f) => picks.some((p) => isInside(f.path, p)));
  // One folder picked: the link is that folder. Otherwise the folder holding the pick, or one named
  // "shared-files" (it reads as a name in "Open the folder shared-files?", where "shared" didn't).
  const isFolder = picks.length === 1 && covered.some((f) => f.path !== picks[0]);
  const base = isFolder ? picks[0] : zipBase(picks);
  return { name: base ? nameOf(base) : "shared-files", files: covered.map((f) => ({ name: under(f.path, base), text: f.text })) };
}

/** The .zip's file name: the one folder picked, the folder holding the pick, or the workspace's name. */
export function zipName(picks: readonly string[], workspace: string): string {
  const base = zipBase(picks);
  const name = picks.length === 1 ? nameOf(picks[0]) : base ? nameOf(base) : workspace;
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "files";
  return `${safe}.zip`;
}
