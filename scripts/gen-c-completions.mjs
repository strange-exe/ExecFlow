// Builds src/editor/data/c-library.json: the C and C++ library names the editor suggests (header
// names, C functions with their prototypes, common constants, and std:: names), read from clang 8's
// sysroot (binji/wasm-clang, pinned in SOURCE below; 0.17.0 moved the compiler to LLVM 22, whose
// headers this script doesn't read yet). Run `npm run gen:completions:c`: it prints the counts and
// every filter it applied. `--stdout` prints the JSON instead of writing the file (the unit test
// compares the two).
//
// The archive is untrusted until checked (SECURITY.md section 3): its size and SHA-256 must match
// SOURCE before any entry is read; the entry count and every size are capped; absolute paths, "..",
// links and anything but plain files and folders are refused. Nothing is extracted to disk.
//
// The C headers are read with a small preprocessor of our own (includes, include guards, #if
// expressions), once per -std value the settings offer, so a declaration counts only where clang
// would see it: memcpy, strcmp and malloc are declared in wasi-libc's private __header_string.h,
// __functions_malloc.h and __header_stdlib.h, which a plain read of string.h misses. Anything the
// preprocessor doesn't handle stops the script instead of being guessed.
//
// The output holds names, prototypes and constant values from the headers, plus our own words. No
// comment text from the headers is copied.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "editor", "data", "c-library.json");

/** Archive caps. The real sysroot is a 1.8 MB gzip of a 9.3 MB tar with 445 entries. */
export const LIMITS = { gzipBytes: 8 * 2 ** 20, tarBytes: 32 * 2 ** 20, entries: 2000, entryBytes: 4 * 2 ** 20 };

/** The -std values the data is read in (clang 8's; the editor maps today's settings onto them, the test checks). */
export const C_MODES = ["c99", "c11", "c17", "gnu11", "gnu17"];
export const CXX_MODES = ["c++11", "c++14", "c++17", "c++2a"];
export const MODES = [...C_MODES, ...CXX_MODES];
/** DEFAULT_BUILD.cStd in src/runner/cpp-build.ts: prototypes and macro values are read in this mode. */
const DEFAULT_MODE = "gnu11";

/** The C headers whose functions are listed, in the order they are attributed. */
const FUNCTION_HEADERS = ["stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "time.h"];

/** Never offered: none of them links in this C library (also checked against defined-symbols.txt). */
export const NEVER = ["gets", "tmpfile", "popen", "system"];

// ---------------------------------------------------------------- archive

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Where the names are read from. 0.17.0 moved the compiler to LLVM 22 and wasi-sdk-33, whose headers
 * this generator doesn't read yet (another layout, another libc++); until it does, the data stays the
 * one read from clang 8's sysroot (binji/wasm-clang), pinned here by commit and SHA-256, and the
 * editor reads the newer -std settings as the newest this data has (library-completion.ts DATA_MODE).
 */
export const SOURCE = {
  pack: "648c4a89",
  source: "binji/wasm-clang@648c4a89997a351eef75cdaec3ef5b89d4937dec",
  url: "https://raw.githubusercontent.com/binji/wasm-clang/648c4a89997a351eef75cdaec3ef5b89d4937dec/sysroot.tar",
  sha256: "2435a7b549af30c2be7ec249c405bc2e911ab0c6003012f0909ec3c131bff867",
  rawBytes: 9297920,
  /** Where scripts/fetch-clang.mjs kept it before 0.17.0, and where a download is kept now. */
  cache: join(ROOT, "node_modules", ".cache", "wasm-clang", "648c4a89997a351eef75cdaec3ef5b89d4937dec", "sysroot.tar"),
};

/** Reads (or downloads), size-checks and SHA-256-checks the pinned sysroot, then reads its entries into memory. */
export async function readSysroot() {
  let tar = existsSync(SOURCE.cache) ? readFileSync(SOURCE.cache) : null;
  if (!tar || tar.length !== SOURCE.rawBytes || sha256(tar) !== SOURCE.sha256) {
    const res = await fetch(SOURCE.url);
    if (!res.ok) throw new Error(`could not download the pinned sysroot: HTTP ${res.status}`);
    tar = Buffer.from(await res.arrayBuffer());
    if (tar.length !== SOURCE.rawBytes || sha256(tar) !== SOURCE.sha256) throw new Error("the downloaded sysroot.tar doesn't match its pinned size and SHA-256; not reading it");
    mkdirSync(dirname(SOURCE.cache), { recursive: true });
    writeFileSync(SOURCE.cache, tar);
  }
  if (tar.length > LIMITS.tarBytes) throw new Error(`sysroot.tar is over the ${LIMITS.tarBytes} cap`);
  return { files: readTar(tar), sha256: SOURCE.sha256, pack: SOURCE.pack, source: SOURCE.source };
}

const SAFE_PATH = /^[A-Za-z0-9._+/-]+$/;

function tarString(h, at, len) {
  const end = h.indexOf(0, at);
  return h.toString("latin1", at, end >= at && end < at + len ? end : at + len);
}

function tarOctal(h, at, len, what) {
  const text = tarString(h, at, len).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`sysroot.tar: bad ${what} field "${text}"`);
  const n = parseInt(text, 8);
  if (!Number.isSafeInteger(n)) throw new Error(`sysroot.tar: ${what} out of range`);
  return n;
}

/** A plain-file map from an in-memory ustar archive. Refuses links, special entries and unsafe paths. */
export function readTar(tar) {
  const files = new Map();
  let total = 0;
  let count = 0;
  for (let off = 0; ; ) {
    if (off + 512 > tar.length) throw new Error("sysroot.tar: ends inside a header");
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // the end-of-archive block
    if (++count > LIMITS.entries) throw new Error(`sysroot.tar: more than ${LIMITS.entries} entries`);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== tarOctal(h, 148, 8, "checksum")) throw new Error(`sysroot.tar: header checksum mismatch at offset ${off}`);
    const ustar = tarString(h, 257, 6) === "ustar";
    const name = tarString(h, 0, 100);
    const prefix = ustar ? tarString(h, 345, 155) : "";
    const raw = prefix ? `${prefix}/${name}` : name;
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const size = tarOctal(h, 124, 12, "size");
    if (size > LIMITS.entryBytes) throw new Error(`sysroot.tar: ${raw} is ${size} bytes, over the ${LIMITS.entryBytes} cap`);
    total += size;
    if (total > LIMITS.tarBytes) throw new Error(`sysroot.tar: entries pass ${LIMITS.tarBytes} bytes in total`);
    const start = off + 512;
    if (start + size > tar.length) throw new Error(`sysroot.tar: ${raw} runs past the end`);
    const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!path || !SAFE_PATH.test(path) || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "." || p === "")) {
      throw new Error(`sysroot.tar: refused path ${JSON.stringify(raw)}`);
    }
    if (type === "5") {
      if (size !== 0) throw new Error(`sysroot.tar: folder ${path} has data`);
    } else if (type === "0") {
      if (files.has(path)) throw new Error(`sysroot.tar: ${path} appears twice`);
      files.set(path, Buffer.from(tar.subarray(start, start + size)));
    } else {
      throw new Error(`sysroot.tar: ${path} is entry type "${type}", not a plain file or folder`);
    }
    off = start + size + ((512 - (size % 512)) % 512);
  }
  return files;
}

// ---------------------------------------------------------------- source text

/** Joins backslash-continued lines and blanks comments (keeping line breaks), skipping literals. */
function cleanSource(src) {
  const s = src.replace(/\r\n?/g, "\n").replace(/\\\n/g, "");
  const out = [];
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) throw new Unsupported("unterminated comment");
      out.push(" ", s.slice(i, end + 2).replace(/[^\n]/g, ""));
      i = end + 2;
    } else if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
      out.push(" ");
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
      out.push(s.slice(i, j + 1));
      i = j + 1;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

/** The sysroot's files, with text and cleaned lines read once. */
export class Sysroot {
  constructor(files) {
    this.files = files;
    this.cache = new Map();
  }
  has(path) {
    return this.files.has(path);
  }
  paths() {
    return [...this.files.keys()];
  }
  text(path) {
    const buf = this.files.get(path);
    if (!buf) throw new Error(`sysroot: no ${path}`);
    return buf.toString("latin1");
  }
  lines(path) {
    let lines = this.cache.get(path);
    if (!lines) this.cache.set(path, (lines = cleanSource(this.text(path)).split("\n")));
    return lines;
  }
}

// ---------------------------------------------------------------- preprocessor

/** A construct the preprocessor below doesn't handle: the script must be extended, not trusted. */
export class Unsupported extends Error {}
/** The header itself fails in this mode (#error, a missing include): clang would stop too. */
export class HeaderError extends Error {}

const IDENT = /^[A-Za-z_]\w*$/;
const isIdent = (t) => IDENT.test(t);
// String and character literals (with prefixes), identifiers, pp-numbers, punctuators.
const TOKEN = /(?:L|u8|u|U)?"(?:[^"\\\n]|\\.)*"|(?:L|u8|u|U)?'(?:[^'\\\n]|\\.)*'|[A-Za-z_]\w*|\.\.\.|\.?\d(?:[eEpP][+-]|[\w.])*|::|->\*?|<<=|>>=|<<|>>|&&|\|\||\+\+|--|[-+*/%&|^<>=!]=|\S/g;
export const tokenize = (text) => text.match(TOKEN) ?? [];

/**
 * clang 8.0.1's predefined macros that matter to these headers, per -std value (the worker runs
 * clang -cc1 for wasm32-wasi with binji's arguments plus -std). Every other identifier an #if tests
 * counts as undefined; the summary lists those, and they were checked against clang's own -dM list.
 */
export function builtins(mode) {
  const m = {
    __STDC__: "1", __STDC_HOSTED__: "1", __GNUC__: "4", __GNUC_MINOR__: "2", __GNUC_PATCHLEVEL__: "1",
    __clang__: "1", __clang_major__: "8", __clang_minor__: "0", __clang_patchlevel__: "1",
    __wasm__: "1", __wasm32__: "1", __wasi__: "1", __CHAR_BIT__: "8", __SIZEOF_POINTER__: "4", __SIZEOF_LONG__: "4",
    __BYTE_ORDER__: "__ORDER_LITTLE_ENDIAN__", __ORDER_LITTLE_ENDIAN__: "1234", __ORDER_BIG_ENDIAN__: "4321",
  };
  if (CXX_MODES.includes(mode)) {
    m.__cplusplus = { "c++11": "201103L", "c++14": "201402L", "c++17": "201703L", "c++2a": "201707L" }[mode];
    m.__GNUG__ = "4";
    // clang defines it for C++ on this target, so the C headers declare their POSIX and GNU extras there.
    m._GNU_SOURCE = "1";
  } else {
    m.__STDC_VERSION__ = { c99: "199901L", c11: "201112L", c17: "201710L", gnu11: "201112L", gnu17: "201710L" }[mode];
  }
  if (!mode.startsWith("gnu")) m.__STRICT_ANSI__ = "1";
  if (Object.values(m).includes(undefined)) throw new Error(`unknown mode ${mode}`);
  return m;
}

/** __has_feature answers for the features these headers ask about (clang -cc1 without -fmodules). */
const HAS_FEATURE = { modules: 0n };

export class Preprocessor {
  constructor(sysroot, mode) {
    this.sysroot = sysroot;
    this.mode = mode;
    this.cxx = CXX_MODES.includes(mode);
    // The worker's search order for both languages, minus libc++'s folder (see run()).
    this.dirs = ["include", "lib/clang/8.0.1/include"];
    this.macros = new Map(Object.entries(builtins(mode)).map(([name, body]) => [name, { params: null, body, file: "<built-in>" }]));
    this.once = new Set();
    this.out = [];
    this.undefinedTested = new Set();
    this.depth = 0;
  }

  /**
   * Preprocesses `#include <header>` and returns the active non-directive lines, each with the file
   * it came from. For C++ modes the C header is read directly with __cplusplus defined: libc++'s
   * wrapper of the same name only includes it (checked against real clang output).
   */
  run(header) {
    const hit = this.resolve(header, true, null, false);
    if (!hit) throw new HeaderError(`<${header}> not found`);
    this.file(hit.path, hit.dir);
    return this.out;
  }

  resolve(spelling, angled, from, next) {
    if (!SAFE_PATH.test(spelling) || spelling.split("/").includes("..")) throw new Unsupported(`include spelling ${spelling}`);
    if (!angled && from && !next) {
      const here = `${from.path.slice(0, from.path.lastIndexOf("/"))}/${spelling}`;
      if (this.sysroot.has(here)) return { path: here, dir: from.dir };
    }
    for (let i = next ? from.dir + 1 : 0; i < this.dirs.length; i++) {
      const path = `${this.dirs[i]}/${spelling}`;
      if (this.sysroot.has(path)) return { path, dir: i };
    }
    return null;
  }

  file(path, dir) {
    if (this.once.has(path)) return;
    if (++this.depth > 64) throw new Unsupported(`include depth at ${path}`);
    const stack = [];
    let active = true;
    for (const line of this.sysroot.lines(path)) {
      const m = /^\s*#\s*([A-Za-z_]\w*)?(.*)$/.exec(line);
      if (!m) {
        if (active && line.trim()) this.out.push({ file: path, text: line });
        continue;
      }
      const name = m[1] ?? "";
      const rest = m[2];
      if (name === "if" || name === "ifdef" || name === "ifndef") {
        const cond = active && (name === "if" ? this.evaluate(rest, path) : this.isDefined(rest) === (name === "ifdef"));
        stack.push({ parent: active, taken: cond, sawElse: false });
        active = cond;
        continue;
      }
      if (name === "elif" || name === "else" || name === "endif") {
        const top = stack.at(-1);
        if (!top || (top.sawElse && name !== "endif")) throw new Unsupported(`${path}: stray #${name}`);
        if (name === "endif") {
          stack.pop();
          active = top.parent;
        } else if (name === "else") {
          top.sawElse = true;
          active = top.parent && !top.taken;
          top.taken = true;
        } else {
          active = top.parent && !top.taken && this.evaluate(rest, path);
          if (active) top.taken = true;
        }
        continue;
      }
      if (!active) continue;
      switch (name) {
        case "include":
        case "include_next": {
          const im = /^\s*(?:<([^>]+)>|"([^"]+)")\s*$/.exec(rest);
          if (!im) throw new Unsupported(`${path}: computed #include ${rest.trim()}`);
          const hit = this.resolve(im[1] ?? im[2], im[1] !== undefined, { path, dir }, name === "include_next");
          if (!hit) throw new HeaderError(`${path}: #${name} ${rest.trim()} not found`);
          this.file(hit.path, hit.dir);
          break;
        }
        case "define": {
          const dm = /^\s+([A-Za-z_]\w*)(\([^)]*\))?(.*)$/.exec(rest);
          if (!dm) throw new Unsupported(`${path}: #define${rest}`);
          const params = dm[2] ? dm[2].slice(1, -1).split(",").map((p) => p.trim()).filter(Boolean) : null;
          this.macros.set(dm[1], { params, body: dm[3].trim().replace(/\s+/g, " "), file: path });
          break;
        }
        case "undef":
          this.macros.delete(rest.trim());
          break;
        case "pragma":
          if (rest.trim() === "once") this.once.add(path);
          else if (/push_macro|pop_macro/.test(rest)) throw new Unsupported(`${path}: #pragma${rest}`);
          break;
        case "error":
          throw new HeaderError(`${path}: #error${rest}`);
        case "warning":
        case "line":
        case "ident":
        case "":
          break;
        default:
          throw new Unsupported(`${path}: #${name}`);
      }
    }
    if (stack.length) throw new Unsupported(`${path}: unterminated #if`);
    this.depth--;
  }

  isDefined(rest) {
    const name = rest.trim();
    if (!isIdent(name)) throw new Unsupported(`#ifdef ${name}`);
    const yes = this.macros.has(name);
    if (!yes) this.undefinedTested.add(name);
    return yes;
  }

  /** The value of an #if or #elif expression. */
  evaluate(text, path) {
    const tokens = tokenize(text);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "defined") {
        const paren = tokens[i + 1] === "(";
        const name = tokens[i + (paren ? 2 : 1)];
        if (!name || !isIdent(name) || (paren && tokens[i + 3] !== ")")) throw new Unsupported(`${path}: #if ${text}`);
        out.push(this.isDefined(name) ? "1" : "0");
        i += paren ? 3 : 1;
      } else if (t === "__has_include" || t === "__has_include_next") {
        const close = tokens.indexOf(")", i);
        const inner = tokens.slice(i + 2, close);
        if (tokens[i + 1] !== "(" || inner[0] !== "<" || inner.at(-1) !== ">") throw new Unsupported(`${path}: #if ${text}`);
        const hit = this.resolve(inner.slice(1, -1).join(""), true, { path, dir: this.dirs.findIndex((d) => path.startsWith(`${d}/`)) }, t.endsWith("next"));
        out.push(hit ? "1" : "0");
        i = close;
      } else if (t === "__has_feature") {
        const name = tokens[i + 2];
        if (tokens[i + 1] !== "(" || tokens[i + 3] !== ")" || !Object.hasOwn(HAS_FEATURE, name)) throw new Unsupported(`${path}: #if ${text}`);
        out.push(String(HAS_FEATURE[name]));
        i += 3;
      } else if (/^__has_/.test(t)) {
        throw new Unsupported(`${path}: #if ${text}`);
      } else {
        out.push(t);
      }
    }
    const expanded = this.expand(out, new Set(), path);
    const values = expanded.map((t) => {
      if (!isIdent(t)) return t;
      if (this.cxx && (t === "true" || t === "false")) return t === "true" ? "1" : "0";
      this.undefinedTested.add(t);
      return "0";
    });
    return evaluateTokens(values, `${path}: #if ${text}`) !== 0n;
  }

  /** Object-like macro expansion for #if; a function-like macro call there is not supported. */
  expand(tokens, hide, path) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const mac = isIdent(t) && !hide.has(t) ? this.macros.get(t) : undefined;
      if (!mac) {
        out.push(t);
      } else if (mac.params) {
        if (tokens[i + 1] === "(") throw new Unsupported(`${path}: function-like macro ${t} in #if`);
        out.push(t);
      } else {
        const body = this.expand(tokenize(mac.body), new Set([...hide, t]), path);
        if (body.includes("defined")) throw new Unsupported(`${path}: ${t} expands to defined`);
        out.push(...body);
      }
    }
    return out;
  }
}

const BINARY = { "*": 10, "/": 10, "%": 10, "+": 9, "-": 9, "<<": 8, ">>": 8, "<": 7, ">": 7, "<=": 7, ">=": 7, "==": 6, "!=": 6, "&": 5, "^": 4, "|": 3, "&&": 2, "||": 1 };
const ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63 };

function charValue(token, where) {
  const m = /^(L|u8|u|U)?'(.*)'$/.exec(token);
  const body = m[2];
  let code;
  if (body.length === 1) code = body.charCodeAt(0);
  else if (body[0] === "\\" && /^x[0-9a-fA-F]+$/.test(body.slice(1))) code = parseInt(body.slice(2), 16);
  else if (body[0] === "\\" && /^[0-7]{1,3}$/.test(body.slice(1))) code = parseInt(body.slice(1), 8);
  else if (body.length === 2 && body[0] === "\\" && Object.hasOwn(ESCAPES, body[1])) code = ESCAPES[body[1]];
  else throw new Unsupported(`${where}: character literal ${token}`);
  // Plain char is signed on wasm32, and wchar_t is int: both sign-extend; u and U are unsigned.
  if (!m[1] && code > 127) code -= 256;
  return { v: BigInt(code), u: m[1] === "u" || m[1] === "U" || m[1] === "u8" };
}

function numberValue(token, where) {
  const m = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$/.exec(token);
  if (!m) throw new Unsupported(`${where}: number ${token}`);
  const digits = m[1].length > 1 && m[1][0] === "0" && !/[xX]/.test(m[1]) ? `0o${m[1].slice(1)}` : m[1];
  return { v: BigInt(digits), u: /u/i.test(m[2]) };
}

/** C preprocessor arithmetic on intmax_t / uintmax_t (64 bits), with the usual conversions. */
function evaluateTokens(tokens, where) {
  let pos = 0;
  const fit = (v, u) => ({ v: u ? BigInt.asUintN(64, v) : BigInt.asIntN(64, v), u });
  const bool = (b) => ({ v: b ? 1n : 0n, u: false });
  const fail = () => {
    throw new Unsupported(`${where}: cannot evaluate`);
  };
  function unary() {
    const t = tokens[pos++];
    if (t === undefined) fail();
    if (t === "(") {
      const v = ternary();
      if (tokens[pos++] !== ")") fail();
      return v;
    }
    if (t === "!") return bool(unary().v === 0n);
    if (t === "-") {
      const a = unary();
      return fit(-a.v, a.u);
    }
    if (t === "+") return unary();
    if (t === "~") {
      const a = unary();
      return fit(~a.v, a.u);
    }
    if (/^(?:L|u8|u|U)?'/.test(t)) return charValue(t, where);
    if (/^\.?\d/.test(t)) return numberValue(t, where);
    return fail();
  }
  function apply(op, a, b) {
    if (op === "&&") return bool(a.v !== 0n && b.v !== 0n);
    if (op === "||") return bool(a.v !== 0n || b.v !== 0n);
    if (op === "<<" || op === ">>") return fit(op === "<<" ? a.v << b.v : a.v >> b.v, a.u);
    const u = a.u || b.u;
    const x = fit(a.v, u).v;
    const y = fit(b.v, u).v;
    switch (op) {
      case "*": return fit(x * y, u);
      case "/": case "%":
        if (y === 0n) throw new Unsupported(`${where}: division by zero`);
        return fit(op === "/" ? x / y : x % y, u);
      case "+": return fit(x + y, u);
      case "-": return fit(x - y, u);
      case "<": return bool(x < y);
      case ">": return bool(x > y);
      case "<=": return bool(x <= y);
      case ">=": return bool(x >= y);
      case "==": return bool(x === y);
      case "!=": return bool(x !== y);
      case "&": return fit(x & y, u);
      case "^": return fit(x ^ y, u);
      case "|": return fit(x | y, u);
      default: return fail();
    }
  }
  function binary(min) {
    let left = unary();
    for (;;) {
      const op = tokens[pos];
      const prec = BINARY[op];
      if (!prec || prec < min) return left;
      pos++;
      left = apply(op, left, binary(prec + 1));
    }
  }
  function ternary() {
    const cond = binary(1);
    if (tokens[pos] !== "?") return cond;
    pos++;
    const a = ternary();
    if (tokens[pos++] !== ":") fail();
    const b = ternary();
    return cond.v !== 0n ? a : b;
  }
  const result = ternary();
  if (pos !== tokens.length) fail();
  return result.v;
}

// ---------------------------------------------------------------- declarations

/** Attribute-like constructs that take a parenthesised argument and are dropped from prototypes. */
const ATTRIBUTES = new Set(["__attribute__", "__attribute", "__asm__", "__asm", "asm", "__declspec"]);
/** Words dropped from prototypes: qualifiers and specifiers that only add noise for a reader. */
const NOISE = new Set(["_Noreturn", "__restrict", "__restrict__", "restrict", "__inline", "__inline__", "inline", "__extension__", "extern"]);
const NOT_A_NAME = new Set([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "_Bool", "bool", "const", "volatile",
  "struct", "union", "enum", "sizeof", "_Alignof", "__typeof__", "typeof", "decltype", "operator", "return",
]);

function closingParen(words, open) {
  let depth = 0;
  for (let i = open; i < words.length; i++) {
    if (words[i] === "(") depth++;
    else if (words[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** One line per prototype: single spaces, "type *name", no space inside parentheses or before commas. */
function formatPrototype(ws, at) {
  let s = "";
  for (let i = 0; i < ws.length; i++) {
    const a = ws[i - 1];
    const b = ws[i];
    const tight = i === 0 || b === "," || b === ")" || b === "[" || b === "]" || a === "(" || a === "[" ||
      (b === "(" && (i === at + 1 || a === ")")) || (a === "*" && (isIdent(b) || b === "*" || b === ")"));
    s += (tight ? "" : " ") + b;
  }
  return s;
}

/** A function declaration from one statement's tokens, or null; `unparsed` when it looks like one but isn't plain. */
function classify(stmt) {
  const words = [];
  let deprecated = false;
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i].t;
    if (ATTRIBUTES.has(t)) {
      const close = closingParen(stmt.map((x) => x.t), i + 1);
      if (stmt[i + 1]?.t !== "(" || close < 0) throw new Unsupported(`${stmt[i].file}: ${t} without (...)`);
      if (stmt.slice(i, close).some((x) => /deprecated/.test(x.t))) deprecated = true;
      i = close;
    } else if (!NOISE.has(t)) {
      words.push(stmt[i]);
    }
  }
  if (words[0] && /^"/.test(words[0].t)) words.shift(); // extern "C" on one declaration
  // The public names of musl's internal types: va_list, and locale_t for "struct __locale_struct *".
  for (let i = 0; i < words.length; i++) {
    if (words[i].t === "__isoc_va_list") words[i] = { ...words[i], t: "va_list" };
    if (words[i].t === "struct" && words[i + 1]?.t === "__locale_struct" && words[i + 2]?.t === "*") words.splice(i, 3, { ...words[i], t: "locale_t" });
  }
  const w = words.map((x) => x.t);
  if (!w.includes("(") || w.some((x) => ["typedef", "static", "template", "friend", "using", "{"].includes(x))) return null;
  let depth = 0;
  let at = -1;
  for (let i = 0; i < w.length && at < 0; i++) {
    if (w[i] === "(") {
      if (depth === 0 && i > 0 && isIdent(w[i - 1])) at = i - 1;
      depth++;
    } else if (w[i] === ")") depth--;
  }
  if (at < 0 || NOT_A_NAME.has(w[at])) return null; // a variable, a function pointer, or a type
  const head = w.slice(0, at);
  if (!head.length || head.some((x) => x === "(" || x === ")" || x === "=") || closingParen(w, at + 1) !== w.length - 1) {
    return { unparsed: true, name: w[at], file: words[at].file };
  }
  return { name: w[at], file: words[at].file, proto: formatPrototype(w, at), deprecated };
}

/** The words after any leading `template <...>` heads (whose "class" names a parameter, not a type). */
function withoutTemplateHeads(words) {
  let w = words;
  while (w[0] === "template" && w[1] === "<") {
    let depth = 0;
    let i = 1;
    for (; i < w.length; i++) {
      depth += w[i] === "<" ? 1 : w[i] === ">" ? -1 : w[i] === ">>" ? -2 : 0;
      if (depth <= 0) break;
    }
    w = w.slice(i + 1);
  }
  return w;
}

/**
 * Function declarations in preprocessed lines ({ file, text }, in order). Linkage blocks and
 * namespaces are transparent; function bodies are skipped; struct, union and enum bodies stay part
 * of their statement. Returns the declarations and the names of ones too unusual to keep.
 */
export function parseDeclarations(lines) {
  const toks = [];
  for (const { file, text } of lines) for (const t of tokenize(text)) toks.push({ t, file });
  const decls = [];
  const unparsed = [];
  let stmt = [];
  let scopes = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].t;
    if (t === "{") {
      const w = stmt.map((x) => x.t);
      if ((w[0] === "extern" && /^"/.test(w[1] ?? "") && w.length === 2) || w.includes("namespace")) {
        scopes++;
        stmt = [];
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < toks.length && depth; j++) depth += toks[j].t === "{" ? 1 : toks[j].t === "}" ? -1 : 0;
      if (depth) throw new Unsupported(`${toks[i].file}: unbalanced {`);
      const last = w.at(-1);
      // An operator's own symbol (operator=, operator|=) is not an initialiser.
      const head = withoutTemplateHeads(w).filter((_, k, all) => all[k - 1] !== "operator");
      const isBody = !head.some((x) => ["struct", "union", "enum", "class", "="].includes(x)) &&
        (last === ")" || ["const", "noexcept", "override", "final"].includes(last));
      if (isBody) stmt = []; // a function definition: nothing to list
      else stmt.push(...toks.slice(i, j));
      i = j - 1;
    } else if (t === "}") {
      if (stmt.length || scopes === 0) {
        throw new Unsupported(`${toks[i].file}: unexpected } after "${toks.slice(Math.max(0, i - 12), i).map((x) => x.t).join(" ")}"`);
      }
      scopes--;
    } else if (t === ";") {
      const d = stmt.length ? classify(stmt) : null;
      if (d?.unparsed) unparsed.push(d);
      else if (d) decls.push(d);
      stmt = [];
    } else {
      stmt.push(toks[i]);
    }
  }
  if (stmt.length) throw new Unsupported(`${stmt[0].file}: declaration without ;`);
  return { decls, unparsed };
}

/**
 * A header's own declarations: in the header itself, or in a private C library header it reaches
 * (__*.h, bits/). Never libc++'s files.
 */
export function owned(file, header) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (file === `include/${header}`) return true;
  return file.startsWith("include/") && !file.startsWith("include/c++/") && (base.startsWith("__") || file.startsWith("include/bits/"));
}

// ---------------------------------------------------------------- the data

/** Constants a beginner uses, with the header that defines them (checked per mode). */
const MACROS = [
  ["EOF", "stdio.h"], ["NULL", "stdio.h"], ["BUFSIZ", "stdio.h"], ["SEEK_SET", "stdio.h"], ["SEEK_CUR", "stdio.h"], ["SEEK_END", "stdio.h"],
  ["RAND_MAX", "stdlib.h"], ["EXIT_SUCCESS", "stdlib.h"], ["EXIT_FAILURE", "stdlib.h"],
  ["CHAR_BIT", "limits.h"], ["CHAR_MIN", "limits.h"], ["CHAR_MAX", "limits.h"], ["SCHAR_MIN", "limits.h"], ["SCHAR_MAX", "limits.h"],
  ["UCHAR_MAX", "limits.h"], ["SHRT_MIN", "limits.h"], ["SHRT_MAX", "limits.h"], ["USHRT_MAX", "limits.h"], ["INT_MIN", "limits.h"],
  ["INT_MAX", "limits.h"], ["UINT_MAX", "limits.h"], ["LONG_MIN", "limits.h"], ["LONG_MAX", "limits.h"], ["ULONG_MAX", "limits.h"],
  ["LLONG_MIN", "limits.h"], ["LLONG_MAX", "limits.h"], ["ULLONG_MAX", "limits.h"],
  ["SIZE_MAX", "stdint.h"], ["INT32_MIN", "stdint.h"], ["INT32_MAX", "stdint.h"], ["UINT32_MAX", "stdint.h"], ["INT64_MIN", "stdint.h"],
  ["INT64_MAX", "stdint.h"], ["UINT64_MAX", "stdint.h"],
  ["FLT_MIN", "float.h"], ["FLT_MAX", "float.h"], ["FLT_EPSILON", "float.h"], ["DBL_MIN", "float.h"], ["DBL_MAX", "float.h"], ["DBL_EPSILON", "float.h"],
  ["M_PI", "math.h"], ["M_E", "math.h"], ["M_SQRT2", "math.h"], ["HUGE_VAL", "math.h"], ["INFINITY", "math.h"], ["NAN", "math.h"],
  ["CLOCKS_PER_SEC", "time.h"],
  ["bool", "stdbool.h", "type"], ["true", "stdbool.h"], ["false", "stdbool.h"],
];

/**
 * Macros whose value predefined-macros.txt can't confirm: that list was made with __GNUC__ and
 * __clang__ undefined (none appears in it), so math.h took its non-GNU branch there. clang 8
 * defines __GNUC__ 4 and __GNUC_MINOR__ 2, so these are compiler built-ins here.
 */
const GNUC_DEPENDENT = ["INFINITY", "NAN"];

/**
 * std:: names a beginner uses: [name, kind, header, since, synopsis file if not the header, why
 * the hand check differs from libc++ 8's synopsis comment]. "since" is the first -std value the
 * settings offer that has the name, so "c++11" also covers C++98 names. Checked with the pack's
 * clang: every name compiles and links at its "since" standard, and the c++14 and c++17 ones are
 * refused by the standard before.
 */
const STD = [
  ["cout", "variable", "iostream", "c++11"], ["cin", "variable", "iostream", "c++11"], ["cerr", "variable", "iostream", "c++11"],
  ["endl", "function", "iostream", "c++11", "ostream"], ["fixed", "function", "iostream", "c++11", "ios"],
  ["setw", "function", "iomanip", "c++11"], ["setprecision", "function", "iomanip", "c++11"], ["setfill", "function", "iomanip", "c++11"],
  ["string", "class", "string", "c++11"], ["getline", "function", "string", "c++11"], ["to_string", "function", "string", "c++11"],
  ["stoi", "function", "string", "c++11"], ["stod", "function", "string", "c++11"],
  ["vector", "class", "vector", "c++11"], ["map", "class", "map", "c++11"], ["set", "class", "set", "c++11"],
  ["unordered_map", "class", "unordered_map", "c++11"], ["unordered_set", "class", "unordered_set", "c++11"],
  ["array", "class", "array", "c++11"], ["deque", "class", "deque", "c++11"], ["list", "class", "list", "c++11"],
  ["stack", "class", "stack", "c++11"], ["queue", "class", "queue", "c++11"], ["priority_queue", "class", "queue", "c++11"],
  ["sort", "function", "algorithm", "c++11"], ["find", "function", "algorithm", "c++11"], ["max", "function", "algorithm", "c++11"],
  ["min", "function", "algorithm", "c++11"], ["reverse", "function", "algorithm", "c++11"], ["count", "function", "algorithm", "c++11"],
  ["min_element", "function", "algorithm", "c++11"], ["max_element", "function", "algorithm", "c++11"],
  ["binary_search", "function", "algorithm", "c++11"], ["lower_bound", "function", "algorithm", "c++11"],
  ["upper_bound", "function", "algorithm", "c++11"], ["fill", "function", "algorithm", "c++11"], ["clamp", "function", "algorithm", "c++17"],
  ["swap", "function", "utility", "c++11"], ["pair", "class", "utility", "c++11"], ["make_pair", "function", "utility", "c++11"],
  ["accumulate", "function", "numeric", "c++11"], ["iota", "function", "numeric", "c++11"], ["gcd", "function", "numeric", "c++17"],
  ["lcm", "function", "numeric", "c++17"],
  ["sqrt", "function", "cmath", "c++11"], ["pow", "function", "cmath", "c++11"], ["abs", "function", "cmath", "c++11"],
  ["fabs", "function", "cmath", "c++11"], ["floor", "function", "cmath", "c++11"], ["ceil", "function", "cmath", "c++11"],
  ["round", "function", "cmath", "c++11"], ["sin", "function", "cmath", "c++11"], ["cos", "function", "cmath", "c++11"],
  ["tan", "function", "cmath", "c++11"], ["log", "function", "cmath", "c++11"], ["exp", "function", "cmath", "c++11"],
  ["hypot", "function", "cmath", "c++11"],
  ["unique_ptr", "class", "memory", "c++11"], ["make_unique", "function", "memory", "c++14"],
  ["stringstream", "class", "sstream", "c++11"], ["istringstream", "class", "sstream", "c++11"], ["ostringstream", "class", "sstream", "c++11"],
  ["numeric_limits", "class", "limits", "c++11"],
];
const STD_ORDER = ["c++11", "c++14", "c++17"];

/**
 * std:: names a beginner might expect that this toolchain can't build, so they stay out of STD:
 * clang 8 stops with "error in backend: Cannot select: AtomicLoadAdd" (an atomic it can't emit for
 * wasm32) on any use of them, at -O0 and -O2 alike (checked with the pack's clang).
 */
const STD_BROKEN = {
  shared_ptr: "clang 8 stops with an internal error (Cannot select) on its atomic reference count",
  make_shared: "clang 8 stops with an internal error (Cannot select) on its atomic reference count",
};

/**
 * libc++ headers left out of the list although they exist, and why: a typical use was compiled at
 * -O0 and -O2 and linked with the pack's clang and wasm-ld and the worker's flags, then run.
 * <mutex>, <condition_variable> and <shared_mutex> stay: they link, and lock and notify run in a
 * single thread.
 */
const CPP_LEFT_OUT = {
  filesystem: "no libc++fs.a in the sysroot: std::filesystem calls fail to link",
  thread: "links, but starting a std::thread aborts at run time: there are no threads here",
  future: "clang 8 stops with an internal error (Cannot select) on std::promise and std::future",
  atomic: "clang 8 stops with an internal error (Cannot select) on std::atomic operations, even load()",
  regex: "clang 8 stops with an internal error (Cannot select) on any std::regex",
  bit: "libc++ 8's <bit> declares nothing public: its synopsis is an empty namespace std, the rest is internals (__popcount and the like)",
};

/**
 * libc++ headers whose whole content is behind one `#if _LIBCPP_STD_VER > N` (14: C++17, 17:
 * C++2a): under an earlier -std the #include line compiles and every use fails. Each is offered
 * from that standard on (headers.since). Checked below: the header has exactly that one guard.
 */
const CPP_SINCE = { any: "c++17", compare: "c++2a", optional: "c++17", span: "c++2a", variant: "c++17" };
const GUARD_VERSION = { "c++17": "14", "c++2a": "17" };

/** C header folders a student would use: sys/ only (see the summary for what the others are). */
const C_FOLDERS = ["sys"];

/**
 * C headers left out of the list although they build here, because a beginner never includes them
 * (design decision 17, 2026-10-19: Hick's law, fewer choices in the list). Each must exist.
 */
const C_LEFT_OUT = {
  "stdc-predef.h": "only predefines __STDC_ISO_10646__ and __STDC_IEC_559__ for the compiler; GCC includes it on its own, a program never does",
  "stdio_ext.h": "glibc's extensions for looking inside a FILE's buffer, such as __fpending and __freadahead",
  "libintl.h": "message translation with gettext and its family, of which one function links here: review finding F2",
};

/** The first standard libc++ 8's synopsis comment gives a name: a bare "// C++14" or "// C++17" marks an addition. */
function synopsisSince(text, name, kind) {
  const start = text.indexOf("/*");
  const block = text.slice(start, text.indexOf("*/", start)).split("\n");
  const pattern = kind === "class"
    ? new RegExp(`\\b(?:class|struct)\\s+${name}\\b|\\btypedef\\b.*\\b${name}\\s*;`)
    : kind === "variable" ? new RegExp(`\\b${name}\\s*;`) : new RegExp(`\\b${name}\\s*\\(`);
  const marks = [];
  for (let i = 0; i < block.length; i++) {
    if (!pattern.test(block[i])) continue;
    let mark = null;
    for (let j = i; j < Math.min(block.length, i + 4); j++) {
      const comment = /\/\/(.*)$/.exec(block[j])?.[1] ?? "";
      const added = /^\s*\**\s*C\+\+(1[147])\b/.exec(comment);
      if (added) mark = `c++${added[1]}`;
      if (/[;{]/.test(block[j].replace(/\/\/.*$/, ""))) break;
    }
    marks.push(mark);
  }
  if (!marks.length) return null;
  if (marks.some((m) => m === null)) return "c++11";
  return marks.sort((a, b) => STD_ORDER.indexOf(a) - STD_ORDER.indexOf(b))[0];
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.header < b.header ? -1 : a.header > b.header ? 1 : 0);
const sortStrings = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Declared function names per header per mode, and everything the summary reports. */
export function collect(sysroot) {
  const symbols = new Set(sysroot.text("share/wasm32-wasi/defined-symbols.txt").split("\n").map((s) => s.trim()).filter(Boolean));
  const predefined = new Map();
  for (const line of sysroot.text("share/wasm32-wasi/predefined-macros.txt").split("\n")) {
    const m = /^#define (\w+)(?:\s+(.*))?$/.exec(line);
    if (m) predefined.set(m[1], (m[2] ?? "").trim().replace(/\s+/g, " "));
  }
  const undefinedTested = new Set();
  const run = (header, mode) => {
    const pp = new Preprocessor(sysroot, mode);
    try {
      return { pp, lines: pp.run(header) };
    } finally {
      for (const n of pp.undefinedTested) undefinedTested.add(n);
    }
  };

  // C headers: top-level include/*.h and include/sys/*.h, minus private ones, the ones a beginner
  // never includes (C_LEFT_OUT), ones that fail in the default mode, and ones that declare
  // functions of which none links.
  const cCandidates = sysroot.paths().filter((p) => /^include\/[^/]+\.h$/.test(p) || C_FOLDERS.some((d) => p.startsWith(`include/${d}/`) && /\.h$/.test(p) && p.split("/").length === 3));
  for (const h of Object.keys(C_LEFT_OUT)) if (!cCandidates.includes(`include/${h}`)) throw new Error(`C_LEFT_OUT names <${h}>, which the C library doesn't have`);
  const cFilter = { private: [], leftOut: [], fails: [], nothingLinks: [], kept: [], ownLinking: [] };
  for (const path of sortStrings(cCandidates)) {
    const header = path.slice("include/".length);
    if (header.split("/").at(-1).startsWith("__")) {
      cFilter.private.push(header);
      continue;
    }
    if (Object.hasOwn(C_LEFT_OUT, header)) {
      cFilter.leftOut.push(`${header} (${C_LEFT_OUT[header]})`);
      continue;
    }
    let lines;
    let pp;
    try {
      ({ lines, pp } = run(header, DEFAULT_MODE));
    } catch (e) {
      if (!(e instanceof HeaderError)) throw e;
      cFilter.fails.push(`${header} (${e.message.trim()})`);
      continue;
    }
    // A header that declares functions in its own file is judged by those, counting the ones too
    // unusual to read (libintl.h's gettext family) as declared: ifaddrs.h was kept for the
    // linking functions of <sys/socket.h>'s private headers it reaches, while its own two don't
    // link (review finding F2, 2026-10-19). One whose own file declares none (string.h keeps its
    // functions in __header_string.h) is judged by the private headers it reaches.
    const parsed = parseDeclarations(lines);
    const ownFile = `include/${header}`;
    const inOwnFile = [...parsed.decls, ...parsed.unparsed].filter((d) => d.file === ownFile).map((d) => d.name);
    const names = inOwnFile.length ? inOwnFile : parsed.decls.filter((d) => owned(d.file, header)).map((d) => d.name);
    // A name the header redirects to a compiler built-in (alloca -> __builtin_alloca) needs no library.
    const works = (name) => symbols.has(name) || /^__builtin_/.test(pp.macros.get(name)?.body ?? "");
    if (names.length && !names.some(works)) cFilter.nothingLinks.push(`${header} (${names.length} declared${inOwnFile.length ? " in it" : ""})`);
    else {
      cFilter.kept.push(header);
      if (inOwnFile.length) cFilter.ownLinking.push(`${header}: ${inOwnFile.filter(works).length}/${inOwnFile.length}`);
    }
  }
  // Every kept header that declares functions in its own file has one that links (checked above):
  // the few kept with most of their own functions not linking are named in the summary.
  const otherFolders = sortStrings(new Set(sysroot.paths().filter((p) => /^include\/[^/]+\/[^/]+\.h$/.test(p)).map((p) => p.split("/")[1]))).filter((d) => !C_FOLDERS.includes(d) && d !== "c++");

  // C++ headers: libc++'s extension-less headers, minus internal ones, the C wrappers whose C
  // header isn't offered, and the ones that don't build or run (CPP_LEFT_OUT).
  const cxxFilter = { internal: [], cWrapperLeftOut: [], leftOut: [], kept: [] };
  if (sysroot.has("lib/wasm32-wasi/libc++fs.a")) throw new Error("the sysroot now has libc++fs.a: review CPP_LEFT_OUT.filesystem");
  if (!sysroot.has("lib/wasm32-wasi/libc++.a")) throw new Error("the sysroot has no libc++.a");
  for (const path of sortStrings(sysroot.paths().filter((p) => /^include\/c\+\+\/v1\/[^/.]+$/.test(p)))) {
    const header = path.slice("include/c++/v1/".length);
    // <cstdio> and the like wrap a C header (libc++ has a wrapper of that name, or only the C library has it).
    const wrapped = `${header.slice(1)}.h`;
    const isWrapper = /^c[a-z]+$/.test(header) && (sysroot.has(`include/c++/v1/${wrapped}`) || sysroot.has(`include/${wrapped}`));
    if (header.startsWith("__")) cxxFilter.internal.push(header);
    else if (Object.hasOwn(CPP_LEFT_OUT, header)) cxxFilter.leftOut.push(`${header} (${CPP_LEFT_OUT[header]})`);
    else if (isWrapper && !cFilter.kept.includes(wrapped)) {
      cxxFilter.cWrapperLeftOut.push(`${header} (<${wrapped}> ${sysroot.has(`include/${wrapped}`) ? "is left out of the C list" : "is not in the C library"})`);
    } else cxxFilter.kept.push(header);
  }
  for (const h of Object.keys(CPP_LEFT_OUT)) if (!sysroot.has(`include/c++/v1/${h}`)) throw new Error(`CPP_LEFT_OUT names <${h}>, which libc++ doesn't have`);
  const cxxSince = {};
  for (const [h, since] of Object.entries(CPP_SINCE)) {
    if (!cxxFilter.kept.includes(h)) throw new Error(`CPP_SINCE names <${h}>, which is not in the C++ header list`);
    const guards = sysroot.text(`include/c++/v1/${h}`).match(/^#if _LIBCPP_STD_VER > \d+/gm) ?? [];
    if (guards.length !== 1 || guards[0] !== `#if _LIBCPP_STD_VER > ${GUARD_VERSION[since]}`) {
      throw new Error(`<${h}>: expected one guard "#if _LIBCPP_STD_VER > ${GUARD_VERSION[since]}", found ${JSON.stringify(guards)}`);
    }
    cxxSince[h] = since;
  }

  // Functions, per header and mode.
  const perMode = new Map(); // `${header}|${mode}` -> Map(name -> decl)
  const unparsed = new Map();
  for (const header of FUNCTION_HEADERS) {
    for (const mode of MODES) {
      const { decls, unparsed: odd } = parseDeclarations(run(header, mode).lines);
      const own = new Map();
      for (const d of decls) if (owned(d.file, header) && !own.has(d.name)) own.set(d.name, d);
      perMode.set(`${header}|${mode}`, own);
      for (const d of odd) if (owned(d.file, header)) unparsed.set(`${header}: ${d.name}`, d);
    }
  }
  const functions = [];
  const notLinking = new Map(); // header -> names
  const reserved = [];
  const seen = new Map();
  for (const header of FUNCTION_HEADERS) {
    const names = new Set(MODES.flatMap((mode) => [...perMode.get(`${header}|${mode}`).keys()]));
    for (const name of sortStrings(names)) {
      const modes = MODES.filter((mode) => perMode.get(`${header}|${mode}`).has(name));
      const protos = new Set(modes.map((mode) => perMode.get(`${header}|${mode}`).get(name).proto));
      const decl = perMode.get(`${header}|${modes.includes(DEFAULT_MODE) ? DEFAULT_MODE : modes[0]}`).get(name);
      if (name.startsWith("__")) {
        reserved.push(name);
        continue;
      }
      if (!symbols.has(name)) {
        notLinking.set(header, [...(notLinking.get(header) ?? []), name]);
        continue;
      }
      if (decl.deprecated) throw new Error(`${name} is declared deprecated but links: review it`);
      if (protos.size !== 1) throw new Error(`${name}: prototypes differ between modes: ${[...protos].join(" | ")}`);
      if (/\b__\w*/.test(decl.proto)) throw new Error(`${name}: reserved name left in the prototype "${decl.proto}"`);
      if (seen.has(name)) throw new Error(`${name} is declared by both ${seen.get(name)} and ${header}`);
      seen.set(name, header);
      functions.push({ name, header, proto: decl.proto, ...(modes.length === MODES.length ? {} : { modes }) });
    }
  }
  for (const name of NEVER) if (functions.some((f) => f.name === name)) throw new Error(`${name} must never be offered`);
  for (const name of ["printf", "memcpy", "strcmp", "malloc"]) if (!functions.some((f) => f.name === name)) throw new Error(`${name} is missing`);

  // Macros, per mode, with values as the default mode defines them.
  const macroState = new Map();
  for (const header of new Set(MACROS.map(([, h]) => h))) {
    for (const mode of MODES) macroState.set(`${header}|${mode}`, run(header, mode).pp.macros);
  }
  const macros = [];
  for (const [name, header, kind = "constant"] of MACROS) {
    const modes = MODES.filter((mode) => macroState.get(`${header}|${mode}`).has(name));
    const table = macroState.get(`${header}|${DEFAULT_MODE}`);
    const mac = table.get(name);
    if (!mac) throw new Error(`${name} is not defined by <${header}> in ${DEFAULT_MODE}`);
    if (mac.params) throw new Error(`${name} is a function-like macro`);
    if (!cFilter.kept.includes(header)) throw new Error(`${name}: <${header}> is not in the C header list`);
    if (predefined.has(name) && predefined.get(name) !== mac.body && !GNUC_DEPENDENT.includes(name)) {
      throw new Error(`${name}: <${header}> defines "${mac.body}" but predefined-macros.txt says "${predefined.get(name)}"`);
    }
    // Follow a chain of plain names (SIZE_MAX -> UINT32_MAX -> (0xffffffffu)).
    let value = mac.body;
    for (let hops = 0; isIdent(value) && table.get(value)?.params === null && hops < 8; hops++) value = table.get(value).body;
    const plain = !/\b__/.test(value) && !/[A-Za-z_]\w*\s*\(/.test(value.replace(/^\(+\s*(?:void|double|float|int|long|unsigned|char)\s*\*?\s*\)/, ""));
    macros.push({ name, header, kind, ...(plain ? { value } : {}), ...(modes.length === MODES.length ? {} : { modes }) });
  }

  // std:: names, with libc++ 8's synopsis comments as a check on the hand-made table.
  const synopsis = [];
  const std = [];
  for (const [name, kind, header, since, from = header, why] of STD) {
    if (Object.hasOwn(STD_BROKEN, name)) throw new Error(`std::${name}: ${STD_BROKEN[name]}`);
    if (!cxxFilter.kept.includes(header)) throw new Error(`std::${name}: <${header}> is not in the C++ header list`);
    if (!STD_ORDER.includes(since)) throw new Error(`std::${name}: since ${since}`);
    const found = synopsisSince(sysroot.text(`include/c++/v1/${from}`), name, kind);
    if (found === null) throw new Error(`std::${name}: not found in <${from}>'s synopsis`);
    if (found !== since && !why) throw new Error(`std::${name}: synopsis says ${found}, table says ${since}, and no reason is recorded`);
    synopsis.push(`${name}: synopsis ${found}, table ${since}${why ? ` (${why})` : ""}`);
    std.push({ name, kind, header, since });
  }

  return {
    symbols, perMode, undefinedTested, unparsed, notLinking, reserved, cFilter, cxxFilter, otherFolders, synopsis,
    data: {
      headers: { c: cFilter.kept, cpp: cxxFilter.kept, since: cxxSince },
      functions: functions.sort(byName),
      macros: macros.sort(byName),
      std: std.sort(byName),
    },
  };
}

const LICENCE = {
  "include/c++/v1 (libc++ 8)":
    "Each header says it is dual licensed under the MIT and the University of Illinois Open Source Licenses and points to libc++'s LICENSE.TXT, which is not in the sysroot. That file (upstream llvm-project release/8.x libcxx/LICENSE.TXT: Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT, under the University of Illinois/NCSA Open Source License or the MIT License) is in this repository as licenses/libcxx-8-LICENSE.TXT, and libc++abi's (cxxabi.h, __cxxabi_config.h) as licenses/libcxxabi-8-LICENSE.TXT. public/clang/<pack>/LICENSE.llvm.txt is the LLVM project's top-level licence (Apache-2.0 with LLVM Exceptions, and the legacy University of Illinois/NCSA licence, Copyright (c) 2007-2019 University of Illinois at Urbana-Champaign); it does not contain libc++'s MIT text.",
  "lib/clang/8.0.1/include (clang's own headers)": "Each file carries its own MIT-style permission notice and copyright line.",
  "include/ outside c++/v1 (the C library: wasi-libc, built from musl and cloudlibc)":
    "Unverified. The sysroot has no licence file for it and these headers carry no notice. Upstream wasi-libc's LICENSE today offers Apache-2.0 WITH LLVM-exception, Apache-2.0 or MIT, with musl under MIT and cloudlibc under BSD-2-Clause; whether that covers this 2019 build was not checked.",
  "this file": "Names, prototypes and constant values read from those headers, plus our own words. No comment text from the headers is copied.",
};

const FIELDS = {
  "headers": "names for #include <...>: c from include/ and include/sys/, cpp from libc++ (include/c++/v1); since: the first -std setting a libc++ header has any content in (absent: all of them)",
  "functions": "proto: the declaration as clang sees it in gnu11, attributes removed; every name is in share/wasm32-wasi/defined-symbols.txt",
  "macros": "value: as the header defines it in gnu11 (left out when it is a compiler built-in); kind: constant or type",
  "modes": "the -std settings an entry is declared in; absent means all of them",
  "std": "since: the first -std setting that has the name (c++11 also covers older names)",
};

/** The JSON text: deterministic, LF, one entry per line, final newline. */
export function serialize(data) {
  const list = (items, pad) => (items.length ? `[\n${items.map((x) => `${pad}  ${JSON.stringify(x)}`).join(",\n")}\n${pad}]` : "[]");
  const text = [
    "{",
    `  "header": ${JSON.stringify(data.header, null, 2).replace(/\n/g, "\n  ")},`,
    "  \"headers\": {",
    `    "c": ${list(data.headers.c, "    ")},`,
    `    "cpp": ${list(data.headers.cpp, "    ")},`,
    `    "since": ${JSON.stringify(data.headers.since)}`,
    "  },",
    `  "functions": ${list(data.functions, "  ")},`,
    `  "macros": ${list(data.macros, "  ")},`,
    `  "std": ${list(data.std, "  ")}`,
    "}",
    "",
  ].join("\n");
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(data)) throw new Error("serialize: round trip differs");
  return text;
}

/** The whole file's text, and the collected details for the summary. */
export async function generate() {
  const { files, sha256: digest, pack, source } = await readSysroot();
  const result = collect(new Sysroot(files));
  const data = {
    header: {
      generator: "scripts/gen-c-completions.mjs (npm run gen:completions:c)",
      pack,
      source,
      sysrootSha256: digest,
      modes: { c: C_MODES, cpp: CXX_MODES },
      fields: FIELDS,
      licence: LICENCE,
    },
    ...result.data,
  };
  return { text: serialize(data), data, result };
}

function summary({ text, data, result }) {
  const gz = gzipSync(Buffer.from(text), { level: 9 }).length;
  const minified = JSON.stringify(data);
  const gzMin = gzipSync(Buffer.from(minified), { level: 9 }).length;
  const r = result;
  const lines = [
    `wrote src/editor/data/c-library.json from pack ${data.header.pack}, sysroot.tar sha256 ${data.header.sysrootSha256}`,
    `size: ${Buffer.byteLength(text)} B raw, ${gz} B gzip -9; minified JSON ${Buffer.byteLength(minified)} B, ${gzMin} B gzip -9`,
    "",
    `headers.c: ${data.headers.c.length} kept`,
    `  left out, private (__*.h): ${r.cFilter.private.length}`,
    `  left out, a beginner never includes them: ${r.cFilter.leftOut.join("; ")}`,
    `  left out, fails in ${DEFAULT_MODE}: ${r.cFilter.fails.length}: ${r.cFilter.fails.join("; ")}`,
    `  left out, declares functions but none links: ${r.cFilter.nothingLinks.length}: ${r.cFilter.nothingLinks.join("; ")}`,
    `  kept with fewer than half of their own functions linking: ${r.cFilter.ownLinking.filter((s) => { const [a, b] = s.split(": ")[1].split("/").map(Number); return a * 2 < b; }).join("; ") || "none"}`,
    `  folders not offered: ${r.otherFolders.join(", ")}`,
    `headers.cpp: ${data.headers.cpp.length} kept`,
    `  left out, internal (__*): ${r.cxxFilter.internal.length}`,
    `  left out, C wrapper without its C header: ${r.cxxFilter.cWrapperLeftOut.join("; ")}`,
    `  left out, does not build or run: ${r.cxxFilter.leftOut.join("; ")}`,
    `  offered from a later standard only: ${Object.entries(data.headers.since).map(([h, s]) => `${h} (${s})`).join(", ")}`,
    "",
    `functions: ${data.functions.length}`,
    ...FUNCTION_HEADERS.map((h) => `  ${h}: ${data.functions.filter((f) => f.header === h).length} (${data.functions.filter((f) => f.header === h && f.modes).length} not in every mode); not in defined-symbols.txt: ${(r.notLinking.get(h) ?? []).join(" ") || "none"}`),
    `  reserved names skipped: ${r.reserved.join(" ") || "none"}`,
    `  declarations too unusual to read: ${[...r.unparsed.keys()].join("; ") || "none"}`,
    `  mode patterns: ${[...new Set(data.functions.filter((f) => f.modes).map((f) => f.modes.join(",")))].join(" | ")}`,
    `macros: ${data.macros.length}; not in every mode: ${data.macros.filter((m) => m.modes).map((m) => `${m.name} [${m.modes.join(",")}]`).join(", ")}; no value: ${data.macros.filter((m) => m.value === undefined).map((m) => m.name).join(", ")}`,
    `std: ${data.std.length} (${STD_ORDER.map((s) => `${s}: ${data.std.filter((e) => e.since === s).length}`).join(", ")})`,
    `  left out: ${Object.entries(STD_BROKEN).map(([name, why]) => `${name} (${why})`).join("; ")}`,
    ...r.synopsis.map((s) => `  ${s}`),
    "",
    `identifiers #if treated as undefined (${r.undefinedTested.size}): ${sortStrings(r.undefinedTested).join(" ")}`,
  ];
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = await generate();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(out.text);
  } else {
    writeFileSync(OUT, out.text);
    console.log(summary(out));
  }
}
