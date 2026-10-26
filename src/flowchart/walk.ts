// Helpers the adapters share for reading tree-sitter trees. Everything that walks below a
// statement is iterative with a visit cap, so a deeply nested expression can't overflow the stack
// or take long.
import type { Node } from "web-tree-sitter";

/** 1-based first and last source lines of a node. */
export const lineOf = (n: Node) => n.startPosition.row + 1;
export const endLineOf = (n: Node) => n.endPosition.row + 1;

/** The node's text up to its first line break. */
export const firstLine = (text: string) => text.split("\n", 1)[0].trimEnd();

/** Statement text without its closing semicolon. */
export const withoutSemicolon = (text: string) => text.replace(/\s*;\s*$/, "");

/** Named children that are code (comments left out). */
export const codeChildren = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment");

/** The innermost text inside one pair of parentheses around a condition. */
export function unparen(text: string): string {
  const t = text.trim();
  return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).trim() : t;
}

/**
 * Visits `root` and its descendants depth-first, in source order, at most `cap` nodes. `visit`
 * returns false to skip a node's children.
 */
export function forEachDescendant(root: Node, visit: (n: Node) => boolean | void, cap = 4000): void {
  const cursor = root.walk();
  let seen = 0;
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (++seen > cap) return;
      const descend = visit(node) !== false;
      if (descend && cursor.gotoFirstChild()) continue;
      // Next sibling, or up until there is one (never above root).
      for (;;) {
        if (cursor.currentNode.id === root.id) return;
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

/** The 1-based line of the first syntax error (an ERROR node or a missing token), if any. */
export function firstErrorLine(root: Node): number | undefined {
  if (!root.hasError) return undefined;
  let line: number | undefined;
  forEachDescendant(
    root,
    (n) => {
      if (line !== undefined) return false;
      if (n.isError || n.isMissing) {
        line = lineOf(n);
        return false;
      }
      return n.hasError;
    },
    Number.POSITIVE_INFINITY,
  );
  return line;
}
