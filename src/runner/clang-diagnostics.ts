// Turns clang 8 and wasm-ld 8 output into ToolDiagnostics on workspace paths. Pure.
//
// clang runs as `clang -cc1` with -fno-color-diagnostics -fdiagnostics-print-source-range-info
// -fdiagnostics-show-option -fdiagnostics-parseable-fixits -fmessage-length 0 -ferror-limit 50.
// Carets stay on because clang prints parseable fix-its only together with the caret snippet,
// so after each located header line the parser skips the snippet and caret lines. Real output of
// every shape handled here is kept in __fixtures__/ (captured from the shipped toolchain).
//
// Line shapes (TextDiagnostic.cpp at llvmorg-8.0.1):
//   <file>:<line>:<col>:[{l:c-l:c}...:] <level>: <message>[ [-Wflag]]
//   In file included from <file>:<line>:          (outermost first; printed only when it changes)
//   <level>: <message>                            (no location)
//   fix-it:"<file>":{l:c-l:c}:"<text>"            (escaped with raw_ostream::write_escaped)
// Columns are 1-based UTF-8 byte columns and range ends are exclusive, so locations are emitted
// with unit "utf8-byte" and base 1; editor/positions.ts converts them for CodeMirror.

import type { DiagSeverity, ToolDiagnostic, ToolLocation, WsPath } from "../core/types";
import { normalizeMemfsPath } from "./cpp-depfile";
import { isIdentChar, stripCommentsAndStrings } from "./cpp-scan";

type Level = "fatal error" | "error" | "warning" | "note" | "remark";

interface Range { l1: number; c1: number; l2: number; c2: number }
interface FixIt extends Range { file: string; insert: string }
interface RawDiag {
  file: string | null;
  line: number;
  col?: number;
  ranges: Range[];
  level: Level;
  message: string;
  flag?: string;
  includes: { file: string; line: number }[];
  fixits: FixIt[];
}

const HEADER = /^([^:]+?)(?: \(in PCH\))?:(?:(\d+):)?(?:(\d+):)?((?:\{\d+:\d+-\d+:\d+\})+:)? (fatal error|error|warning|note|remark): (.*)$/;
const RANGE = /\{(\d+):(\d+)-(\d+):(\d+)\}/g;
const INCLUDE = /^In file included from (.+):(\d+):$/;
const NO_LOCATION = /^(fatal error|error|warning|note|remark): (.*)$/;
const FIXIT = /^fix-it:"((?:[^"\\]|\\.)*)":\{(\d+):(\d+)-(\d+):(\d+)\}:"((?:[^"\\]|\\.)*)"$/;
const SUMMARY = /^\d+ (?:warning|error)s? (?:and \d+ (?:warning|error)s? )?generated\.$/;
const CARET = /^[ ~^]*\^[ ~^]*$/;
const FLAG = / \[(-W[^\]]*|-ferror-limit=)\]$/;

/** Maps a memfs path ("/w/src/a.c", any spelling) to the workspace file it holds, or null. */
export type PathMap = (memfs: string) => WsPath | null;

/** The PathMap for a build that mounted `paths` under `mount` ("/w"). */
export function workspaceMap(paths: Iterable<WsPath>, mount = "/w"): PathMap {
  const known = new Set(paths);
  const prefix = mount + "/";
  return (memfs) => {
    const norm = normalizeMemfsPath(memfs);
    if (!norm.startsWith(prefix)) return null;
    const ws = norm.slice(prefix.length);
    return known.has(ws) ? ws : null;
  };
}

/**
 * "<vector>" for the C++ library's vector, "<stdio.h>" for the C library's or clang's own stdio.h
 * (0.17.0 layout: wasi-sdk's exceptions build under /sysroot, clang's resource headers under /usr,
 * ExecFlow's bits/stdc++.h under /ce/include).
 */
export function systemHeaderName(memfs: string): string {
  const norm = normalizeMemfsPath(memfs);
  for (const dir of [
    "/sysroot/include/wasm32-wasip1/eh/c++/v1/", "/sysroot/include/wasm32-wasip1/eh/", "/sysroot/include/wasm32-wasip1/",
    "/sysroot/include/", "/usr/include/", "/ce/include/",
  ]) {
    if (!norm.startsWith(dir)) continue;
    const rel = norm.slice(dir.length);
    const header = libcxxHeaderOf(rel);
    // libc++ keeps most of its code in internal parts no one includes: name the header a student
    // wrote, and the part (a line number belongs to the part's file).
    return header ? `<${header}> (${rel})` : `<${rel}>`;
  }
  return norm;
}

/** The standard headers whose code libc++ (22) splits into an internal "__<name>/" folder. */
const LIBCXX_PARTS = new Set([
  "algorithm", "atomic", "bit", "charconv", "chrono", "compare", "concepts", "coroutine", "exception", "expected",
  "filesystem", "format", "functional", "ios", "iterator", "mdspan", "memory", "memory_resource", "mutex", "numeric",
  "ostream", "random", "ranges", "string", "system_error", "thread", "tuple", "type_traits", "utility", "variant", "vector",
]);

/** "algorithm" for libc++'s "__algorithm/comp.h" (also "cmath" for "__math/...", "locale" for "__locale_dir/..."). */
function libcxxHeaderOf(rel: string): string | null {
  const m = /^__([a-z_]+)\//.exec(rel);
  if (!m) return null;
  const name = m[1] === "math" ? "cmath" : m[1] === "locale_dir" ? "locale" : m[1];
  return name === "cmath" || name === "locale" || LIBCXX_PARTS.has(name) ? name : null;
}

/** Undoes raw_ostream::write_escaped: \\ \" \n \t and 3-digit octal bytes, then decodes UTF-8. */
export function unescapeClang(text: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\\") {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++;
      bytes.push(...enc.encode(String.fromCodePoint(cp)));
      continue;
    }
    const next = text[i + 1];
    if (next === "n") { bytes.push(10); i++; }
    else if (next === "t") { bytes.push(9); i++; }
    else if (next === "\\" || next === '"') { bytes.push(next.charCodeAt(0)); i++; }
    else if (/^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) { bytes.push(parseInt(text.slice(i + 1, i + 4), 8) & 0xff); i += 3; }
    else bytes.push(92);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const severityOf = (level: Level): DiagSeverity =>
  level === "warning" ? "warning" : level === "remark" ? "info" : level === "note" ? "info" : "error";

/** Removes the toolchain's own wrapper noise; reports a crash of clang or wasm-ld itself. */
export function cleanToolOutput(raw: string): { text: string; internalError: string | null } {
  let internalError: string | null = null;
  // shared.js App.run: "\x1b[91mError: <message>[\n<JS stack>]\x1b[0m\n".
  const text = raw.replace(/\x1b\[91mError: ([\s\S]*?)\x1b\[0m\n?/g, (_all, body: string) => {
    if (!/^process exited with code \d+\.$/.test(body.trim())) internalError ??= body.split("\n")[0].trim() || "unknown error";
    return "";
  });
  return { text: text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x7f/g, ""), internalError };
}

export interface ClangParse {
  diagnostics: ToolDiagnostic[];
  /** Lines that matched no known shape (kept so nothing the compiler says is lost). */
  unparsed: string[];
}

/** Parses the output of one clang -cc1 run that compiled `mainFile` (a memfs path). */
export function parseClangOutput(output: string, map: PathMap, mainFile?: string): ClangParse {
  const lines = output.split("\n");
  const raws: RawDiag[] = [];
  const unparsed: string[] = [];
  let pendingIncludes: { file: string; line: number }[] = [];
  let lastIncludes: { file: string; line: number }[] = [];
  const main = mainFile ? normalizeMemfsPath(mainFile) : undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const inc = INCLUDE.exec(line);
    if (inc) {
      pendingIncludes.push({ file: normalizeMemfsPath(inc[1]), line: Number(inc[2]) });
      continue;
    }
    const head = HEADER.exec(line) ?? NO_LOCATION.exec(line);
    if (head) {
      const located = head.length > 3;
      const level = (located ? head[5] : head[1]) as Level;
      let message = located ? head[6] : head[2];
      let flag: string | undefined;
      const f = FLAG.exec(message);
      if (f) {
        flag = f[1];
        message = message.slice(0, f.index);
      }
      const file = located ? normalizeMemfsPath(head[1]) : null;
      const raw: RawDiag = {
        file,
        line: located && head[2] ? Number(head[2]) : 0,
        col: located && head[3] ? Number(head[3]) : undefined,
        ranges: located && head[4] ? [...head[4].matchAll(RANGE)].map((m) => ({ l1: +m[1], c1: +m[2], l2: +m[3], c2: +m[4] })) : [],
        level,
        message,
        flag,
        includes: [],
        fixits: [],
      };
      // The include stack is printed only when it changes, and never for notes.
      if (level !== "note") {
        if (pendingIncludes.length) lastIncludes = pendingIncludes;
        else if (!file || file === main) lastIncludes = [];
        raw.includes = file && file !== main ? lastIncludes : [];
      }
      pendingIncludes = [];
      raws.push(raw);
      // Snippet + caret (+ one fix-it insertion line) follow a located diagnostic, unless clang
      // skipped them for a repeated location: recognise them by the caret line two lines down.
      if (raw.line > 0 && i + 2 < lines.length && CARET.test(lines[i + 2])) {
        i += 2;
        const hint = lines[i + 1];
        if (hint !== undefined && hint.trim() !== "" && !isKnownLine(hint)) i++;
      }
      continue;
    }
    const fix = FIXIT.exec(line);
    if (fix && raws.length) {
      raws[raws.length - 1].fixits.push({
        file: normalizeMemfsPath(unescapeClang(fix[1])),
        l1: +fix[2], c1: +fix[3], l2: +fix[4], c2: +fix[5],
        insert: unescapeClang(fix[6]),
      });
      continue;
    }
    if (line.trim() === "" || SUMMARY.test(line.trim())) continue;
    // "fatal error: error in backend: ...\nIn function: main": a location-less message's continuation.
    const last = raws[raws.length - 1];
    if (last && last.line === 0 && lines[i - 1] !== undefined && lines[i - 1].trim() !== "" && !last.fixits.length) {
      last.message += `\n${line}`;
      continue;
    }
    unparsed.push(line);
  }
  return { diagnostics: groupDiagnostics(raws, map), unparsed };
}

function isKnownLine(line: string): boolean {
  return INCLUDE.test(line) || HEADER.test(line) || NO_LOCATION.test(line) || FIXIT.test(line) || SUMMARY.test(line.trim());
}

const MAX_NOTES = 12;

function locate(raw: { file: string | null; line: number; col?: number; ranges?: Range[] }, map: PathMap): ToolLocation | null {
  const path = raw.file ? map(raw.file) : null;
  if (!path) return null;
  const loc: ToolLocation = { path, line: Math.max(1, raw.line), unit: "utf8-byte", base: 1 };
  if (raw.col) loc.col = raw.col;
  // The highlighted span: from the caret to the end of the last range at or after it.
  const ends = (raw.ranges ?? []).filter((r) => r.l2 > loc.line || (r.l2 === loc.line && r.c2 > (loc.col ?? 0)));
  if (loc.col && ends.length) {
    const last = ends.reduce((a, b) => (b.l2 > a.l2 || (b.l2 === a.l2 && b.c2 > a.c2) ? b : a));
    loc.endLine = last.l2;
    loc.endCol = last.c2;
  }
  return loc;
}

function groupDiagnostics(raws: RawDiag[], map: PathMap): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = [];
  // A diagnostic inside a system header is shown at the user's code that led there.
  let lastUserContext: ToolLocation | null = null;
  const relocated = new Map<string, { diag: ToolDiagnostic; more: number }>();

  for (let i = 0; i < raws.length; i++) {
    const head = raws[i];
    if (head.level === "note") continue; // orphan note: its parent was dropped by the error limit
    const notes: RawDiag[] = [];
    while (i + 1 < raws.length && raws[i + 1].level === "note") notes.push(raws[++i]);

    const severity = severityOf(head.level);
    let where = locate(head, map);
    const extraNotes: (ToolLocation & { message: string })[] = [];
    let moved = false;
    if (!where && head.file) {
      // In a system header: the first note in the user's code ("in instantiation of ... requested
      // here", "expanded from macro"), else the place an earlier one led to, else the include line.
      const userNote = notes.map((n) => locate(n, map)).find((l): l is ToolLocation => l !== null);
      const viaInclude = [...head.includes].map((f) => locate({ file: f.file, line: f.line }, map)).find((l) => l);
      where = userNote ?? lastUserContext ?? viaInclude ?? null;
      if (where) {
        moved = true;
        lastUserContext = where;
      }
      extraNotes.push({ path: null, line: 1, unit: "utf8-byte", base: 1, message: `reported inside ${systemHeaderName(head.file)}, line ${head.line}` });
    }

    const diag: ToolDiagnostic = {
      ...(where ?? { path: null, line: 1, unit: "utf8-byte" as const, base: 1 as const }),
      severity,
      message: head.message,
      source: "clang",
    };
    if (head.flag) diag.code = head.flag;
    // Where a header was included from (innermost first), then clang's own notes.
    for (const frame of [...head.includes].reverse()) {
      const loc = locate({ file: frame.file, line: frame.line }, map);
      if (loc && where && !moved) extraNotes.push({ ...loc, message: "included from here" });
    }
    for (const note of notes) {
      const loc = locate(note, map);
      if (loc) extraNotes.push({ ...loc, message: note.message });
      else if (note.file) extraNotes.push({ path: null, line: 1, unit: "utf8-byte", base: 1, message: `${systemHeaderName(note.file)}:${note.line}: ${note.message}` });
      else extraNotes.push({ path: null, line: 1, unit: "utf8-byte", base: 1, message: note.message });
    }
    if (extraNotes.length > MAX_NOTES) {
      const rest = extraNotes.length - MAX_NOTES;
      extraNotes.length = MAX_NOTES;
      extraNotes.push({ path: null, line: 1, unit: "utf8-byte", base: 1, message: `(${rest} more notes)` });
    }
    if (extraNotes.length) diag.notes = extraNotes;
    // Fix-its of the diagnostic itself are applied together; notes' fix-its are alternatives.
    const fixes = head.fixits
      .map((f) => ({ loc: locate({ file: f.file, line: f.l1, col: f.c1 }, map), f }))
      .filter((x): x is { loc: ToolLocation; f: FixIt } => x.loc !== null)
      .map(({ loc, f }) => ({ ...loc, endLine: f.l2, endCol: f.c2, insert: f.insert }));
    if (fixes.length) diag.fixes = fixes;

    if (moved) {
      // One marker per user location: a template error inside the library is often a cascade.
      const key = `${diag.path}|${diag.line}|${diag.col}|${severity}`;
      const seen = relocated.get(key);
      if (seen) {
        seen.more++;
        continue;
      }
      relocated.set(key, { diag, more: 0 });
    }
    out.push(diag);
  }
  for (const { diag, more } of relocated.values()) {
    if (more) diag.message += ` (and ${more} more ${diag.severity === "warning" ? "warning" : "error"}${more === 1 ? "" : "s"} inside the standard library)`;
  }
  return out;
}

/** Drops repeats (a broken header reports once per translation unit that includes it). */
export function dedupeDiagnostics(list: ToolDiagnostic[]): ToolDiagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.source}|${d.path}|${d.line}|${d.col}|${d.severity}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- wasm-ld

export interface LinkContext {
  /** The unit compiled into an object file, by the path passed to wasm-ld ("/o/1a2b.o"). */
  unitOfObject(obj: string): WsPath | null;
  /** LF text of a workspace file. */
  text(path: WsPath): string | undefined;
  /** User files a unit includes (from its depfile), searched after the unit itself. */
  includesOf(unit: WsPath): WsPath[];
}

interface LldEntry { level: "error" | "warning"; message: string; details: string[] }

function lldEntries(output: string): { entries: LldEntry[]; unparsed: string[] } {
  const entries: LldEntry[] = [];
  const unparsed: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^wasm-ld: (error|warning): (.*)$/.exec(line);
    if (m) entries.push({ level: m[1] as "error" | "warning", message: m[2], details: [] });
    else if (line.startsWith(">>> ") && entries.length) entries[entries.length - 1].details.push(line.slice(4));
    else if (line.trim()) unparsed.push(line);
  }
  return { entries, unparsed };
}

/** The name to look for in source code for a demangled linker symbol. */
export function symbolSearchName(symbol: string): { name: string; kind: "function" | "class" | "plain" } {
  const special = /^(?:vtable|typeinfo|typeinfo name|VTT|construction vtable) for (.+)$/.exec(symbol);
  if (special) return { name: lastComponent(stripTemplateArgs(special[1].trim())), kind: "class" };
  let s = symbol.trim();
  if (!s.endsWith(")") && !/\)\s*(?:const|volatile|&|&&|noexcept)\s*$/.test(s)) return { name: lastComponent(s), kind: "plain" };
  s = s.replace(/(?:\s*(?:const|volatile|&&|&|noexcept))+$/, "");
  // Remove the parameter list: the last balanced (...) group.
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ")") depth++;
    else if (s[i] === "(" && --depth === 0) {
      s = s.slice(0, i);
      break;
    }
  }
  return { name: lastComponent(stripTemplateArgs(s.trim())), kind: "function" };
}

function stripTemplateArgs(s: string): string {
  if (!s.endsWith(">") || /operator\s*(?:<<|>>|<=|>=|->|<|>)$/.test(s)) return s;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ">") depth++;
    else if (s[i] === "<" && --depth === 0) return s.slice(0, i);
  }
  return s;
}

function lastComponent(s: string): string {
  // Top-level "::" and spaces (a return type before a template function: "int ns::g<int>").
  const op = /(?:^|::|\s)(operator\s*(?:\(\)|\[\]|new(?:\[\])?|delete(?:\[\])?|[^\sA-Za-z0-9_]+|\s+[A-Za-z_][\w\s:*&<>]*))$/.exec(s);
  if (op) return op[1].trim();
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (depth === 0 && c === ":" && s[i + 1] === ":") cut = i + 2;
    else if (depth === 0 && c === " ") cut = i + 1;
  }
  return s.slice(cut);
}

const USE_KEYWORDS = new Set(["return", "case", "else", "do", "throw", "new", "delete", "sizeof", "co_return", "co_await", "co_yield", "not", "and", "or", "goto", "typeof", "alignof", "decltype"]);

export type Occurrence = { at: number; declares: boolean; defines: boolean };

/**
 * Occurrences of `name` in `code` (comments and strings already removed), each classified as a
 * declaration (a type comes before the name) and, if so, whether it is also a definition.
 */
export function symbolOccurrences(code: string, name: string): Occurrence[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const re = new RegExp((isIdentChar(name[0]) ? "\\b" : "") + escaped + (isIdentChar(name[name.length - 1]) ? "\\b" : ""), "g");
  const found: Occurrence[] = [];
  for (const m of code.matchAll(re)) {
    const at = m.index;
    const after = skipSpace(code, at + m[0].length);
    // The token before the name, past any qualifiers ("ns::A::", "~", "::").
    let j = at - 1;
    for (;;) {
      j = skipSpaceBack(code, j);
      if (code[j] === "~") { j--; continue; }
      if (code[j] === ":" && code[j - 1] === ":") {
        j = skipSpaceBack(code, j - 2);
        while (j >= 0 && (isIdentChar(code[j]) || code[j] === ">")) {
          if (code[j] === ">") j = matchBack(code, j, "<", ">") - 1;
          else j--;
        }
        continue;
      }
      break;
    }
    const prev = prevToken(code, j);
    let typeBefore = prev.kind === "ident" ? !USE_KEYWORDS.has(prev.text) : prev.kind === "close-angle";
    if (prev.kind === "ptr") {
      const before = prevToken(code, skipSpaceBack(code, prev.start - 1));
      typeBefore = (before.kind === "ident" && !USE_KEYWORDS.has(before.text)) || before.kind === "close-angle" || before.kind === "ptr";
    }
    let defines = false;
    if (code[after] === "(") {
      const close = matchForward(code, after, "(", ")");
      let k = skipSpace(code, close + 1);
      while (/^(?:const|volatile|noexcept|override|final)\b/.test(code.slice(k, k + 9))) k = skipSpace(code, k + (/^\w+/.exec(code.slice(k))![0].length));
      defines = typeBefore && (code[k] === "{" || code[k] === ":");
    } else {
      defines = typeBefore && (code[after] === "=" || code[after] === "[" || code[after] === ";") && !/\bextern\b[^;{}]*$/.test(code.slice(Math.max(0, at - 200), at));
    }
    found.push({ at, declares: typeBefore, defines });
  }
  return found;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}
function skipSpaceBack(s: string, i: number): number {
  while (i >= 0 && /\s/.test(s[i])) i--;
  return i;
}
function matchForward(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === open) depth++;
    else if (s[k] === close && --depth === 0) return k;
  }
  return s.length - 1;
}
function matchBack(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    if (s[k] === close) depth++;
    else if (s[k] === open && --depth === 0) return k;
  }
  return 0;
}
function prevToken(s: string, j: number): { kind: "ident" | "ptr" | "close-angle" | "other" | "none"; text: string; start: number } {
  if (j < 0) return { kind: "none", text: "", start: 0 };
  if (isIdentChar(s[j])) {
    let k = j;
    while (k > 0 && isIdentChar(s[k - 1])) k--;
    return { kind: "ident", text: s.slice(k, j + 1), start: k };
  }
  if (s[j] === "*" || s[j] === "&") {
    let k = j;
    while (k > 0 && (s[k - 1] === "*" || s[k - 1] === "&")) k--;
    return { kind: "ptr", text: s.slice(k, j + 1), start: k };
  }
  if (s[j] === ">") return { kind: "close-angle", text: ">", start: j };
  return { kind: "other", text: s[j], start: j };
}

/** A UTF-16 location (base 0) covering `length` code units at offset `at` of `text`. */
export function locationAt(path: WsPath, text: string, at: number, length: number): ToolLocation {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { path, line, col: at - start, endLine: line, endCol: at - start + length, unit: "utf16", base: 0 };
}

type Want = "use" | "definition" | "class";

/** Finds `name` in the unit, then in the user headers it includes. */
function findSymbol(ctx: LinkContext, unit: WsPath, name: string, want: Want): { loc: ToolLocation; declarationOnly: boolean } | null {
  const files = [unit, ...ctx.includesOf(unit).filter((p) => p !== unit)];
  let declaration: ToolLocation | null = null;
  for (const path of files) {
    const text = ctx.text(path);
    if (text === undefined) continue;
    const code = stripCommentsAndStrings(text);
    if (want === "class") {
      const re = new RegExp(`\\b(?:class|struct)\\s+${name.replace(/[^\w]/g, "")}\\b(?!\\s*;)`, "g");
      const m = re.exec(code);
      if (m) return { loc: locationAt(path, text, m.index, m[0].length), declarationOnly: false };
      continue;
    }
    for (const occ of symbolOccurrences(code, name)) {
      const loc = locationAt(path, text, occ.at, name.length);
      if (want === "use" && !occ.declares) return { loc, declarationOnly: false };
      if (want === "definition" && occ.defines) return { loc, declarationOnly: false };
      if (occ.declares) declaration ??= loc;
    }
  }
  return declaration && want === "use" ? { loc: declaration, declarationOnly: true } : null;
}

const NO_PLACE: ToolLocation = { path: null, line: 1, unit: "utf16", base: 0 };

/** Parses one wasm-ld run; locations are found by searching the sources (heuristic: true). */
export function parseLldOutput(output: string, ctx: LinkContext): ClangParse {
  const { entries, unparsed } = lldEntries(output);
  const out: ToolDiagnostic[] = [];
  const nameOf = (obj: string) => ctx.unitOfObject(obj) ?? obj.replace(/^\/lib\/wasm32-wasi\//, "");
  for (const e of entries) {
    const severity: DiagSeverity = e.level;
    const undefinedSym = /^(.+?): undefined symbol: (.+)$/.exec(e.message);
    if (undefinedSym) {
      const unit = ctx.unitOfObject(undefinedSym[1]);
      const symbol = undefinedSym[2];
      const target = symbolSearchName(symbol);
      const found = unit && target.name !== "main" ? findSymbol(ctx, unit, target.name, target.kind === "class" ? "class" : "use") : null;
      const diag: ToolDiagnostic = { ...(found?.loc ?? NO_PLACE), severity, message: `undefined symbol: ${symbol}`, source: "wasm-ld" };
      if (found) diag.heuristic = true;
      if (!found && unit) diag.message += ` (used in ${unit})`;
      out.push(diag);
      continue;
    }
    const duplicate = /^duplicate symbol: (.+)$/.exec(e.message);
    if (duplicate) {
      const symbol = duplicate[1];
      if (symbol === "__original_main") continue; // reported again as "main"
      const objects = e.details.map((d) => /^defined in (.+)$/.exec(d)?.[1]).filter((o): o is string => !!o);
      const names = objects.map(nameOf);
      const target = symbolSearchName(symbol);
      const places: ToolLocation[] = [];
      for (const obj of objects) {
        const unit = ctx.unitOfObject(obj);
        const found = unit ? findSymbol(ctx, unit, target.name, "definition") : null;
        if (found && !places.some((p) => p.path === found.loc.path && p.line === found.loc.line && p.col === found.loc.col)) places.push(found.loc);
      }
      const message = `duplicate symbol: ${symbol} (defined in ${names.join(" and ")})`;
      if (!places.length) out.push({ ...NO_PLACE, severity, message, source: "wasm-ld" });
      for (const loc of places) out.push({ ...loc, severity, message, source: "wasm-ld", heuristic: true });
      continue;
    }
    const mismatch = /^function signature mismatch: (.+)$/.exec(e.message);
    if (mismatch) {
      const defs = e.details.map((d) => /^defined as (.+) in (.+)$/.exec(d)).filter((m): m is RegExpExecArray => !!m);
      const message = `function signature mismatch: ${mismatch[1]} (${defs.map((m) => `${m[1]} in ${nameOf(m[2])}`).join(", ")})`;
      const unit = defs.map((m) => ctx.unitOfObject(m[2])).find((u) => u);
      const found = unit ? findSymbol(ctx, unit, symbolSearchName(mismatch[1]).name, "use") : null;
      out.push({ ...(found?.loc ?? NO_PLACE), severity, message, source: "wasm-ld", ...(found ? { heuristic: true } : {}) });
      continue;
    }
    out.push({ ...NO_PLACE, severity, message: [e.message, ...e.details].join("; "), source: "wasm-ld" });
  }
  return { diagnostics: out, unparsed };
}
