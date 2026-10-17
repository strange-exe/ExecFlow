// Compiler arguments and build decisions for one C/C++ translation unit. Pure: the compiler
// worker runs these, the tests check them.

import type { BuildOptions, WorkspaceFile, WsPath } from "../core/types";
import { quotedIncludes, stripComments } from "./cpp-scan";
import { memfsPath, quoteDir, type BuildUnit } from "./program";

/** -O2 matches most online judges; -Wall because warnings show next to the code. */
export const DEFAULT_BUILD: BuildOptions = { cStd: "gnu11", cxxStd: "c++17", opt: "2", warnings: ["-Wall"], defines: [] };

// clang 8 accepts these (LangStandards.def at llvmorg-8.0.1); "c++20" is spelled c++2a there.
const C_STDS = new Set(["c89", "c90", "c99", "c11", "c17", "c18", "gnu89", "gnu90", "gnu99", "gnu11", "gnu17", "gnu18"]);
const CXX_STDS = new Set(["c++98", "c++03", "c++11", "c++14", "c++17", "c++2a", "gnu++98", "gnu++03", "gnu++11", "gnu++14", "gnu++17", "gnu++2a"]);
const CXX_ALIASES: Record<string, string> = { "c++20": "c++2a", "gnu++20": "gnu++2a", "c++1z": "c++17", "c++1y": "c++14", "c++0x": "c++11" };
const WARNING = /^(?:-W[A-Za-z0-9][A-Za-z0-9=+,_-]*|-w|-pedantic|-pedantic-errors)$/;
const DEFINE = /^[A-Za-z_][A-Za-z0-9_]*(?:=[^\n\r]*)?$/;

/** Build options with anything clang 8 wouldn't accept replaced by the default, and why. */
export function checkBuildOptions(options: BuildOptions | undefined): { options: BuildOptions; problems: string[] } {
  if (!options) return { options: DEFAULT_BUILD, problems: [] };
  const problems: string[] = [];
  const cStd = options.cStd.trim().toLowerCase().replace(/^-std=/, "");
  const rawCxx = options.cxxStd.trim().toLowerCase().replace(/^-std=/, "");
  const cxxStd = CXX_ALIASES[rawCxx] ?? rawCxx;
  const opt = options.opt;
  const out: BuildOptions = {
    cStd: C_STDS.has(cStd) ? cStd : DEFAULT_BUILD.cStd,
    cxxStd: CXX_STDS.has(cxxStd) ? cxxStd : DEFAULT_BUILD.cxxStd,
    opt: opt === "0" || opt === "1" || opt === "2" ? opt : DEFAULT_BUILD.opt,
    warnings: options.warnings.filter((w) => WARNING.test(w)),
    defines: options.defines.map((d) => d.trim()).filter((d) => DEFINE.test(d)),
  };
  if (out.cStd !== cStd) problems.push(`the C standard "${options.cStd}" isn't available, so ${out.cStd} was used`);
  if (out.cxxStd !== cxxStd) problems.push(`the C++ standard "${options.cxxStd}" isn't available, so ${out.cxxStd} was used`);
  if (out.opt !== opt) problems.push(`optimisation level "${String(opt)}" isn't available, so -O${out.opt} was used`);
  for (const w of options.warnings) if (!WARNING.test(w)) problems.push(`the warning option "${w}" was left out`);
  for (const d of options.defines) if (!DEFINE.test(d.trim())) problems.push(`the define "${d}" was left out (use NAME or NAME=value)`);
  return { options: out, problems };
}

/** Plain diagnostic output: one parseable line per message, plus fix-its (see clang-diagnostics.ts). */
export const DIAG_FLAGS = [
  "-fno-color-diagnostics", "-fdiagnostics-print-source-range-info", "-fdiagnostics-show-option",
  "-fdiagnostics-parseable-fixits", "-fmessage-length", "0", "-ferror-limit", "50",
];

/** clang's C++ headers must not be on the C include path (they shadow <math.h> etc.). */
export function cOnly(args: readonly string[]): string[] {
  return args.filter((arg, i, all) => arg !== "/include/c++/v1" && !(arg === "-internal-isystem" && all[i + 1] === "/include/c++/v1"));
}

/** Flags that change what a header means (so they are part of the PCH key); warnings don't. */
export function semanticArgs(lang: "c" | "cpp", options: BuildOptions): string[] {
  return [`-std=${lang === "c" ? options.cStd : options.cxxStd}`, `-O${options.opt}`, ...options.defines.flatMap((d) => ["-D", d])];
}

export interface UnitArgs {
  unit: BuildUnit;
  root: WsPath;
  /** binji's clangCommonArgs, without -fcolor-diagnostics. */
  common: readonly string[];
  options: BuildOptions;
  /** Short id: /o/<id>.o and /d/<id>.d (flat, because clang can't create directories). */
  id: string;
  pch: string | null;
  mount?: string;
}

export function unitArgs(a: UnitArgs): string[] {
  const c = a.unit.lang === "c";
  return [
    "-cc1", "-emit-obj",
    // -fno-common: LLVM 8's wasm backend can't emit common symbols, so a C tentative definition
    // ("int count;" at file scope) crashed clang. The clang driver passes it for wasm; cc1 doesn't.
    ...(c ? [...cOnly(a.common), "-fno-common"] : a.common),
    ...DIAG_FLAGS,
    ...semanticArgs(a.unit.lang, a.options),
    ...a.options.warnings,
    // -iquote, not -I: a user's time.h or string.h must not hijack the library's own <...> includes.
    "-iquote", quoteDir(a.root, a.mount),
    ...(a.pch && !c ? ["-include-pch", a.pch] : []),
    "-dependency-file", `/d/${a.id}.d`, "-MT", "obj",
    "-o", `/o/${a.id}.o`,
    "-x", c ? "c" : "c++",
    memfsPath(a.unit.path, a.mount),
  ];
}

/** Workspace-relative join of an include spelling with a folder, or null if it climbs out. */
function resolveInclude(dir: WsPath, spelling: string): WsPath | null {
  const parts = dir === "" ? [] : dir.split("/");
  for (const p of spelling.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join("/");
}

/**
 * User files reachable from `start` through quoted includes, resolved the way clang does here:
 * next to the including file first, then in the program's root folder (-iquote).
 */
export function includeClosure(start: WsPath, files: ReadonlyMap<WsPath, WorkspaceFile>, root: WsPath): WsPath[] {
  const seen = new Set<WsPath>([start]);
  const queue = [start];
  const out: WsPath[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    const file = files.get(path);
    if (!file) continue;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (const spelling of quotedIncludes(file.text)) {
      const hit = [resolveInclude(dir, spelling), resolveInclude(root, spelling)].find((p): p is WsPath => !!p && files.has(p));
      if (hit && !seen.has(hit)) {
        seen.add(hit);
        out.push(hit);
        queue.push(hit);
      }
    }
  }
  return out;
}

const DIRECTIVE = /^[ \t]*#[ \t]*(\w*)[ \t]*(.*)$/;
const BITS_INCLUDE = /^<bits\/stdc\+\+\.h>/;

/**
 * Walks `path` in order, into its quoted includes, until `#include <bits/stdc++.h>`: "bits" when it
 * is reached unconditionally with no macro defined before it, "unsafe" when a #define, #undef or
 * #pragma (other than a header's include guard or #pragma once) comes first or the include is
 * conditional, "clean" when neither occurs.
 */
function walkToBits(path: WsPath, files: ReadonlyMap<WsPath, WorkspaceFile>, root: WsPath, seen: Set<WsPath>, isUnit: boolean): "bits" | "unsafe" | "clean" {
  const file = files.get(path);
  if (!file || seen.has(path)) return "clean";
  seen.add(path);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const directives = stripComments(file.text).split("\n").map((line) => DIRECTIVE.exec(line)).filter((m) => m !== null);
  // A header's include guard (#ifndef X / #define X first) is neither a condition nor a macro that matters.
  const guarded = !isUnit && directives[0]?.[1] === "ifndef" && directives[1]?.[1] === "define" &&
    directives[1][2].trim() === directives[0][2].trim();
  let depth = 0; // open #if/#ifdef/#ifndef blocks, not counting the guard
  for (const [i, [, name, rest]] of directives.entries()) {
    if (guarded && i < 2) continue;
    if (name === "include") {
      if (BITS_INCLUDE.test(rest)) return depth === 0 ? "bits" : "unsafe";
      const quoted = /^"([^"\n]+)"/.exec(rest);
      if (!quoted) continue; // another library header: it can't change what the PCH's headers mean
      const hit = [resolveInclude(dir, quoted[1]), resolveInclude(root, quoted[1])].find((p): p is WsPath => !!p && files.has(p));
      const inner = hit ? walkToBits(hit, files, root, seen, false) : "clean";
      if (inner !== "clean") return inner === "bits" && depth > 0 ? "unsafe" : inner;
    } else if (name === "if" || name === "ifdef" || name === "ifndef") {
      depth++;
    } else if (name === "endif") {
      depth = Math.max(0, depth - 1); // the guard's own #endif finds depth 0
    } else if (!(name === "" || name === "else" || name === "elif" || (name === "pragma" && rest.trim() === "once"))) {
      return "unsafe"; // #define, #undef, #pragma pack, ...: the headers would mean something else
    }
  }
  return "clean";
}

/**
 * A C++ unit gets the precompiled <bits/stdc++.h> only if it, or a user header it includes, has
 * `#include <bits/stdc++.h>`: applied elsewhere it would make every std name visible. The PCH is
 * loaded before the unit's first line, so it is also left out when a macro is defined before that
 * include ("#define NDEBUG" first must still turn assert() off).
 */
export function wantsPch(unit: BuildUnit, files: ReadonlyMap<WsPath, WorkspaceFile>, root: WsPath): boolean {
  if (unit.lang !== "cpp") return false;
  return walkToBits(unit.path, files, root, new Set(), true) === "bits";
}
