// Bringing files in (a file picker or a whole folder) and taking the workspace out (a .zip). Files
// are read here, in this tab, and go through storage importFiles, which checks every name and byte.
import { MAX_FILE_BYTES } from "../core/safety";
import type { WorkspaceStore } from "../storage/workspace";
import { downloadBlob, h } from "./dom";

export interface SkippedFile {
  name: string;
  reason: string;
  /** "git": inside a .git folder; "limit": past the workspace's room (both are summarised, not named). */
  kind?: "git" | "limit";
}

export interface PickedFiles {
  files: { name: string; bytes: Uint8Array }[];
  /** Left out before reading (too big, inside a .git folder, or past the workspace's room). */
  skipped: SkippedFile[];
}

/**
 * Room left in the workspace. Files are read one by one only while they fit, so picking a huge
 * folder by mistake (a project with node_modules) never loads all of it into the tab first.
 * Storage checks the exact limits again when the files are imported.
 */
export interface ImportBudget {
  files: number;
  bytes: number;
  /** False for a name that replaces a file already there (it takes no new room). */
  isNew(name: string): boolean;
}

/** Opens the system file picker; resolves null if nothing was chosen. */
export function pickFiles(folder: boolean, budget?: ImportBudget): Promise<PickedFiles | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", multiple: true, hidden: true });
    if (folder) input.setAttribute("webkitdirectory", "");
    let settled = false;
    const done = (value: PickedFiles | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", async () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return done(null);
      done(await readPicked(list, folder, budget));
    });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input);
    input.click();
  });
}

/** Reads the chosen files that can be imported; the others are listed with the reason. */
export async function readPicked(list: readonly File[], folder: boolean, budget?: ImportBudget): Promise<PickedFiles> {
  const picked: PickedFiles = { files: [], skipped: [] };
  let files = budget?.files ?? Infinity;
  let bytes = budget?.bytes ?? Infinity;
  for (const file of list) {
    const name = (folder && file.webkitRelativePath) || file.name;
    if (/(^|\/)\.git(\/|$)/i.test(name)) {
      picked.skipped.push({ name, reason: "it is inside a .git folder", kind: "git" });
      continue;
    }
    // Checked before reading, so a huge file is never loaded into memory.
    if (file.size > MAX_FILE_BYTES) {
      picked.skipped.push({ name, reason: `it is ${Math.ceil(file.size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB` });
      continue;
    }
    if (!budget || budget.isNew(name)) {
      if (files < 1 || bytes < file.size) {
        picked.skipped.push({ name, reason: "the workspace would be over its limit", kind: "limit" });
        continue;
      }
      files -= 1;
      bytes -= file.size;
    }
    picked.files.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return picked;
}

/**
 * Every file and empty folder as a .zip Blob, without downloading it (opaque GitHub files are left
 * out and named). The export below saves it; the move to the new address sends it (address-move.ts).
 */
export async function workspaceZip(store: WorkspaceStore, ws: string): Promise<{ blob: Blob; count: number; skipped: string[] }> {
  const data = await store.loadExport(ws);
  const { writeZip } = await import("../storage/zip");
  const bytes = await writeZip(data.files, data.dirs);
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }), count: data.files.length, skipped: data.skipped };
}

/** Saves every file and empty folder as a .zip (opaque GitHub files are left out and named). */
export async function exportZip(store: WorkspaceStore, ws: string, name: string): Promise<{ count: number; skipped: string[] }> {
  const { blob, count, skipped } = await workspaceZip(store, ws);
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  downloadBlob(`${safe}.zip`, blob);
  return { count, skipped };
}
