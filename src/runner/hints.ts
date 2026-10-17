// Gentle hints for classic beginner mistakes in C and C++ programs (adapted from Pocket Run, same
// author, MIT), plus hints for multi-file programs. They explain messages that are accurate but
// unhelpful to a student (a linker error for gets, "undefined symbol: add(int, int)"), or
// behaviour that is the same in any terminal (scanf("%c") skipping a prompt). They are shown as
// information next to the code; they never block or change anything.

import { nameOf } from "../core/paths";
import type { RunStatus, ToolDiagnostic, ToolLocation, WorkspaceFile, WsPath } from "../core/types";
import { locationAt, symbolOccurrences, symbolSearchName } from "./clang-diagnostics";
import { stripComments, stripCommentsAndStrings } from "./cpp-scan";
import { unitLanguage } from "./program";

export interface HintInput {
  /** Every C/C++ file of the program: its units and the headers it can include. */
  sources: readonly WorkspaceFile[];
  /** The translation units that were compiled. */
  units: readonly WsPath[];
  diagnostics: readonly ToolDiagnostic[];
  status: RunStatus;
}

const PROGRAM: ToolLocation = { path: null, line: 1, unit: "utf16", base: 0 };

interface Found { loc: ToolLocation }

/** The first match of `re` in any of the files, searched in code with comments removed. */
function findIn(files: readonly WorkspaceFile[], re: RegExp, keepStrings = false): Found | null {
  for (const f of files) {
    const code = keepStrings ? stripComments(f.text) : stripCommentsAndStrings(f.text);
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(code);
    if (m) return { loc: locationAt(f.path, f.text, m.index, m[0].trimEnd().length) };
  }
  return null;
}

const fromTool = (d: ToolDiagnostic): ToolLocation => ({ path: d.path, line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol, unit: d.unit, base: d.base });

/** Whether any C (.c) unit defines a function called `name`. */
function definedInC(input: HintInput, name: string): WsPath | null {
  for (const f of input.sources) {
    if (!input.units.includes(f.path) || unitLanguage(f.path) !== "c") continue;
    if (symbolOccurrences(stripCommentsAndStrings(f.text), name).some((o) => o.defines)) return f.path;
  }
  return null;
}

/** First declaration of `name` in the program's files, headers first. */
function declarationOf(input: HintInput, name: string): ToolLocation | null {
  const ordered = [...input.sources].sort((a, b) => Number(unitLanguage(a.path) !== null) - Number(unitLanguage(b.path) !== null));
  for (const f of ordered) {
    const occ = symbolOccurrences(stripCommentsAndStrings(f.text), name).find((o) => o.declares && !o.defines);
    if (occ) return locationAt(f.path, f.text, occ.at, name.length);
  }
  return null;
}

function definedAnywhere(input: HintInput, name: string): boolean {
  return input.sources.some((f) => symbolOccurrences(stripCommentsAndStrings(f.text), name).some((o) => o.defines));
}

type Rule = (input: HintInput) => (Found & { text: string }) | null | undefined;

const isLink = (d: ToolDiagnostic) => d.source === "wasm-ld";
const isClang = (d: ToolDiagnostic) => d.source === "clang";

const RULES: [string, Rule][] = [
  ["turbo-c", (input) => {
    // Turbo C habits: conio.h isn't standard C, so it doesn't exist here (or in GCC or Clang).
    const found = findIn(input.sources, /^[ \t]*#[ \t]*include[ \t]*<conio\.h>/m, true) ?? findIn(input.sources, /\b(?:getch|getche|clrscr)\s*\(/);
    return found && {
      ...found,
      text: "Tip: conio.h (getch, clrscr) comes from Turbo C and isn't standard C, so it isn't available here. " +
        "Remove it: drop clrscr(), and use getchar() instead of getch().",
    };
  }],
  ["gets", (input) => {
    // gets() was removed from C in C11 (it can't be used safely); the linker reports "undefined symbol: gets".
    const found = findIn(input.sources, /\bgets\s*\(/);
    return found && {
      ...found,
      text: "Tip: gets() was removed from C because it can overflow its array. " +
        'Use fgets(s, sizeof s, stdin) for a whole line, or scanf("%49s", s) for one word.',
    };
  }],
  ["void-main", (input) => {
    // void main(): C++ refuses it; C runs it but the exit code is garbage, so a working program looks failed.
    const found = findIn(input.sources, /\bvoid\s+main\s*\(/);
    return found && {
      ...found,
      text: "Tip: main must return int: write int main() and end it with return 0; " +
        "(with void main the program's exit code is random, so it may look like it failed).",
    };
  }],
  ["scanf-char", (input) => {
    // scanf("%c") right after reading a number also reads the Enter typed after it, so a "Y/N" prompt seems
    // skipped. A space before %c skips that Enter. Only worth saying once the program compiled and ran.
    if (input.status === "build-failed") return null;
    const found = findIn(input.sources, /\bscanf\s*\(\s*"%c/, true);
    return found && {
      ...found,
      text: 'Tip: scanf("%c") also reads the Enter left from the previous answer, so it may not wait for you. ' +
        'Write scanf(" %c", ...) with a space before %c to skip it.',
    };
  }],
  ["exceptions", (input) => {
    const d = input.diagnostics.find((x) => isClang(x) && /with exceptions disabled/.test(x.message));
    return d && {
      loc: fromTool(d),
      text: "Note: C++ exceptions (try / throw / catch) aren't supported by this in-browser compiler. " +
        "Report problems with return values (or std::optional) instead.",
    };
  }],
  ["backend", (input) => {
    const d = input.diagnostics.find((x) => isClang(x) && /error in backend/.test(x.message));
    return d && {
      loc: fromTool(d),
      text: "Note: the compiler couldn't turn this code into WebAssembly. thread_local variables and some " +
        "low-level features aren't supported in the browser.",
    };
  }],
  ["cpp-header-in-c", (input) => {
    const d = input.diagnostics.find((x) => isClang(x) && x.path !== null && unitLanguage(x.path) === "c" &&
      /^'(?:bits\/stdc\+\+\.h|iostream|vector|string|algorithm|map|set|queue|stack|fstream|sstream|iomanip|cmath)' file not found$/.test(x.message));
    return d && {
      loc: fromTool(d),
      text: `Tip: ${nameOf(d.path!)} is a C file, so C++ headers aren't available in it. ` +
        "Rename it to .cpp to write C++, or use the C headers (stdio.h, stdlib.h, string.h, math.h).",
    };
  }],
  ["no-main", (input) => {
    const d = input.diagnostics.find((x) => isLink(x) && /^undefined symbol: main\b/.test(x.message));
    return d && { loc: PROGRAM, text: "Note: the program needs an int main() function, where it starts running." };
  }],
  ["extern-c", (input) => {
    // C++ looks for a "mangled" name (add(int, int)); the C file defines plain add.
    for (const d of input.diagnostics) {
      const m = isLink(d) ? /^undefined symbol: ([A-Za-z_]\w*)\(/.exec(d.message) : null;
      const cFile = m ? definedInC(input, m[1]) : null;
      if (!m || !cFile) continue;
      return {
        loc: declarationOf(input, m[1]) ?? fromTool(d),
        text: `Tip: ${m[1]}() is written in C (${nameOf(cFile)}) but called from C++, which looks for a C++ name. ` +
          'Wrap its declaration in the header in extern "C" { ... } inside #ifdef __cplusplus ... #endif.',
      };
    }
    return null;
  }],
  ["vtable", (input) => {
    const d = input.diagnostics.find((x) => isLink(x) && /^undefined symbol: (?:vtable|typeinfo) for /.test(x.message));
    if (!d) return null;
    const cls = symbolSearchName(d.message.replace(/^undefined symbol: /, "")).name;
    return {
      loc: fromTool(d),
      text: `Tip: a virtual function of ${cls} is declared but never defined (often the destructor or the first virtual ` +
        "function). Give each one a body, or make it pure virtual with = 0.",
    };
  }],
  ["never-defined", (input) => {
    for (const d of input.diagnostics) {
      const m = isLink(d) ? /^undefined symbol: (.+?)(?: \(used in .*\))?$/.exec(d.message) : null;
      if (!m || /^(?:main|vtable for|typeinfo for)\b/.test(m[1]) || /\bgets\b/.test(m[1])) continue;
      const name = symbolSearchName(m[1]).name;
      if (definedAnywhere(input, name)) continue;
      const decl = declarationOf(input, name);
      if (!decl) continue;
      return {
        loc: decl,
        text: `Tip: ${name} is declared but never defined. Write its body in one of the program's .c or .cpp files, ` +
          "with exactly the same name and parameter types as the declaration.",
      };
    }
    return null;
  }],
  ["two-mains", (input) => {
    const d = input.diagnostics.find((x) => isLink(x) && /^duplicate symbol: main\b/.test(x.message));
    return d && {
      loc: d.path ? fromTool(d) : PROGRAM,
      text: "Tip: two files of this program define main(), and a program has exactly one. " +
        "Keep each program in its own folder, or rename the extra main.",
    };
  }],
  ["include-source", (input) => {
    if (!input.diagnostics.some((x) => isLink(x) && /^duplicate symbol: /.test(x.message))) return null;
    const found = findIn(input.sources, /^[ \t]*#[ \t]*include[ \t]*"[^"\n]+\.(?:c|cc|cpp|cxx|c\+\+)"/m, true);
    return found && {
      ...found,
      text: "Tip: a .c or .cpp file is #included here, so its code is compiled twice (it is also built on its own). " +
        "Include its header (.h) instead.",
    };
  }],
  ["defined-in-header", (input) => {
    const d = input.diagnostics.find((x) => isLink(x) && /^duplicate symbol: /.test(x.message) && x.path !== null && unitLanguage(x.path) === null);
    if (!d) return null;
    const name = symbolSearchName(d.message.replace(/^duplicate symbol: /, "").replace(/ \(defined in .*\)$/, "")).name;
    return {
      loc: fromTool(d),
      text: `Tip: ${name} is defined in a header that several files include, so it exists twice. In the header only ` +
        `declare it (a prototype, or extern for a variable) and define it in one .c or .cpp file, or mark it static or inline.`,
    };
  }],
];

const MAX_HINTS = 4;

/** Hints that fit a C or C++ program after a build or run (at most one of each kind). */
export function cppHints(input: HintInput): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = [];
  for (const [code, rule] of RULES) {
    if (out.length >= MAX_HINTS) break;
    const hit = rule(input);
    if (hit) out.push({ ...hit.loc, severity: "info", message: hit.text, source: "hint", code });
  }
  return out;
}
