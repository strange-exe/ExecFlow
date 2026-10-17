// Parsing clang's dependency files (Makefile syntax, from `-dependency-file F -MT T`) and the
// path normalisation shared by the depfile and diagnostics parsers.

/** POSIX-normalises an absolute memfs path: "/w/p/src/../inc//a.h" becomes "/w/p/inc/a.h". */
export function normalizeMemfsPath(path: string): string {
  const out: string[] = [];
  for (const part of (path.startsWith("/") ? path : `/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/**
 * The prerequisites listed in a depfile ("obj: a.c b.h \\\n c.h"), normalised. Handles
 * backslash-newline continuations, "\ " for spaces inside names and "$$" for "$".
 */
export function parseDepfile(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, " ");
  const colon = findTargetColon(joined);
  if (colon < 0) return [];
  const body = joined.slice(colon + 1);
  const deps: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && (body[i + 1] === " " || body[i + 1] === "#")) {
      current += body[++i];
    } else if (c === "$" && body[i + 1] === "$") {
      current += "$";
      i++;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (current) deps.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current) deps.push(current);
  return deps.map(normalizeMemfsPath);
}

// The first ": " that ends the target list (targets may contain escaped spaces).
function findTargetColon(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}
