// The file tree as data: nesting, display order, the visible rows the keyboard moves through,
// type-ahead and name checks. Pure functions (unit-tested); tree.ts draws them.
import { detectLanguage, extensionOf, isHeader, type LanguageId } from "../core/languages";
import { foldKey, isConflictCopy, joinPath, nameOf, normalizePath, parentOf, PathError } from "../core/paths";
import type { EntryMeta, WsPath } from "../core/types";

export interface TreeNode {
  path: WsPath;
  name: string;
  kind: "file" | "dir";
  /** 1 for top-level entries (aria-level). */
  level: number;
  /** Kept from GitHub but not editable as text (binary, symlink, mixed line endings). */
  opaque: boolean;
  conflict: boolean;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by name the way people sort ("file2" before "file10"). */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Builds the nested tree. Entries whose parent folder is missing are attached to the root. */
export function buildTree(entries: readonly EntryMeta[]): TreeNode[] {
  const nodes = new Map<WsPath, TreeNode>();
  for (const e of entries) {
    nodes.set(e.path, {
      path: e.path,
      name: nameOf(e.path),
      kind: e.kind,
      level: e.path.split("/").length,
      opaque: Boolean(e.opaque),
      conflict: e.kind === "file" && isConflictCopy(e.path),
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentOf(node.path));
    if (parent && parent.kind === "dir") parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort(compareNodes);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** The rows a keyboard user moves through: everything inside expanded folders. */
export function visibleRows(roots: readonly TreeNode[], expanded: ReadonlySet<WsPath>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.kind === "dir" && expanded.has(n.path)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** The next row after `from` whose name starts with `prefix` (wrapping), or -1. */
export function typeAhead(rows: readonly TreeNode[], from: number, prefix: string): number {
  const p = prefix.toLocaleLowerCase();
  if (!p || !rows.length) return -1;
  // A repeated single letter cycles through the matches; a longer prefix stays on a match.
  const start = p.length > 1 ? Math.max(0, from) : from + 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[(start + i) % rows.length];
    if (row.name.toLocaleLowerCase().startsWith(p)) return (start + i) % rows.length;
  }
  return -1;
}

/** Every folder above `path`, outermost first ("a/b/c.py" gives ["a", "a/b"]). */
export function ancestors(path: WsPath): WsPath[] {
  const out: WsPath[] = [];
  for (let p = parentOf(path); p !== ""; p = parentOf(p)) out.unshift(p);
  return out;
}

/** Where "New file" puts its file when `selected` is chosen in the tree. */
export function targetFolder(selected: Pick<TreeNode, "path" | "kind"> | null): WsPath {
  if (!selected) return "";
  return selected.kind === "dir" ? selected.path : parentOf(selected.path);
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

export type NameCheck = { ok: true; path: WsPath } | { ok: false; error: string };

/**
 * Checks a name typed into the tree. `dir` is the folder it goes in; the name may contain "/" to
 * create folders on the way ("src/util.c"). For a rename, `renaming` is the entry's own path, so a
 * change of letter case alone is allowed.
 */
export function checkName(dir: WsPath, typed: string, existing: Iterable<WsPath>, renaming?: WsPath): NameCheck {
  const name = typed.trim();
  if (!name) return { ok: false, error: "Type a name." };
  let path: WsPath;
  try {
    path = normalizePath(joinPath(dir, name));
  } catch (e) {
    if (e instanceof PathError) return { ok: false, error: sentence(e.message) };
    throw e;
  }
  if (renaming !== undefined && path === renaming) return { ok: true, path };
  const key = foldKey(path);
  for (const p of existing) {
    if (p === renaming) continue;
    if (foldKey(p) === key) {
      return { ok: false, error: p === path ? `Something here is already called "${nameOf(p)}".` : `"${nameOf(p)}" already exists here (names that differ only in capitals clash on Windows and macOS).` };
    }
  }
  if (renaming !== undefined && (path + "/").startsWith(renaming + "/")) return { ok: false, error: "A folder can't be moved inside itself." };
  return { ok: true, path };
}

// The time part of the stamp conflictName adds (core/paths.ts), with any "-2" and the extension.
const CONFLICT_TAIL = /(\.conflict-\d{8}-)(\d{6}(?:-\d+)?(?:\.[^.]*)?)$/;
const MAX_TAIL = 20;

/**
 * A conflict copy's name in two parts for the tree: the stem may be cut with an ellipsis, the tail
 * (the time the copy was made and the extension) never is, so two copies of one file stay apart at
 * the list's default width. Null for every other name.
 */
export function conflictNameParts(path: string): { stem: string; tail: string } | null {
  const name = nameOf(path);
  if (!isConflictCopy(name)) return null;
  const m = CONFLICT_TAIL.exec(name);
  // The tail's width is reserved in ch of the mono face: only a short, printable ASCII tail is one ch
  // a character, and a long one would leave the stem no room (the name is then cut at its end).
  if (!m || m[2].length > MAX_TAIL || !/^[\x21-\x7e]+$/.test(m[2])) return null;
  return { stem: name.slice(0, m.index + m[1].length), tail: m[2] };
}

export interface NewFileNote {
  /** Shown under the name field while typing (and read with it). */
  text: string;
  /** No extension at all: Enter asks once more (the likely slip is "main" for "main.py"). */
  bare: boolean;
  /** Said after the first Enter on a bare name. */
  confirm: string;
}

/** What to say about a new file's typed name before it is created; null for a file that runs. */
export function newFileNote(typed: string): NewFileNote | null {
  // Trailing slashes are cut with a loop: the regex /\/+$/ is quadratic on a pasted run of them.
  let end = typed.trimEnd().length;
  while (end > 0 && typed[end - 1] === "/") end--;
  const name = nameOf(typed.slice(0, end).trim());
  if (!name || detectLanguage(name)) return null;
  if (extensionOf(name) === "") {
    return {
      text: "This name has no extension, so the file would be plain text and won't run. Add .py, .c or .cpp to make it a program.",
      bare: true,
      confirm: "No extension, so it won't run: add .py, .c or .cpp, or press Enter again to create it as it is.",
    };
  }
  const text = isHeader(name)
    ? "A header: it won't run on its own, the .c or .cpp files that include it do."
    : "This file won't run: only .py, .c and .cpp files do. Fine for data or notes.";
  return { text, bare: false, confirm: text };
}

/** C and C++ sources in one folder build into one program (runner/program.ts); Python files don't mix with them. */
const family = (lang: LanguageId) => (lang === "python" ? "python" : "c");

/**
 * The first text of a new, empty file: the empty-state starter of its language, so a new program
 * runs at once. A file in or below a folder that holds another source of the same family (a C
 * helper next to or under main.c's folder, a Python module next to or under main.py) starts empty
 * instead: a second main() would split the helper off its program (planProgram builds a sub-folder's
 * C files into the program above them), and a module's input() would run on import. `existing` are
 * file paths (a folder named x.py is no source). Conflict copies don't count.
 */
export function starterText(path: WsPath, existing: Iterable<WsPath>): string {
  const name = nameOf(path);
  const lang = detectLanguage(name);
  // __init__.py and the other dunder files are a package's plumbing: __init__.py runs on import.
  if (!lang || /^__\w+__\./.test(name)) return "";
  const dir = parentOf(path);
  const inOrBelow = (folder: string) => folder === dir || folder === "" || dir.startsWith(folder + "/");
  for (const p of existing) {
    if (p === path || !inOrBelow(parentOf(p)) || isConflictCopy(p)) continue;
    const other = detectLanguage(nameOf(p));
    if (other && family(other.id) === family(lang.id)) return "";
  }
  return lang.sample;
}
