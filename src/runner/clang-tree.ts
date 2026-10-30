// The file trees the compiler worker hands to clang and wasm-ld (the YoWASP runtime's Tree: folder
// name -> file bytes or a sub-folder). Folders are null-prototype objects and every step checks its
// own keys, so a workspace name like "__proto__" or "constructor" is an ordinary file or folder: the
// security review of 0.17.0 (2026-10-30) found "__proto__/remove" wrote onto Object.prototype, after
// which every build in that worker failed.
import type { Tree } from "../vendor/yowasp-clang/bundle.js";

/** An empty folder. */
export const emptyTree = (): Tree => Object.create(null) as Tree;

const isFolder = (node: unknown): node is Tree => !!node && typeof node === "object" && !(node instanceof Uint8Array);

/** The bytes at an absolute path in a tree, or null when there is no file there. */
export function fileAt(tree: Tree, path: string): Uint8Array | null {
  let node: Tree | string | Uint8Array | undefined = tree;
  for (const part of path.split("/").filter(Boolean)) {
    if (!isFolder(node) || !Object.hasOwn(node, part)) return null;
    node = node[part];
  }
  return node instanceof Uint8Array ? node : typeof node === "string" ? new TextEncoder().encode(node) : null;
}

/** Puts `bytes` at an absolute path in a tree, creating its folders. */
export function putFile(tree: Tree, path: string, bytes: Uint8Array | string) {
  const parts = path.split("/").filter(Boolean);
  let dir = tree;
  for (const part of parts.slice(0, -1)) {
    const next = Object.hasOwn(dir, part) ? dir[part] : undefined;
    if (isFolder(next)) {
      dir = next;
    } else {
      const made = emptyTree();
      dir[part] = made;
      dir = made;
    }
  }
  dir[parts.at(-1)!] = bytes;
}
