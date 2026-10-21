/// <reference types="node" />
// The generated C and C++ library data (scripts/gen-c-completions.mjs): its shape, the names that
// must and must never appear, sorting, the sysroot it came from, and that a fresh run of the
// generator gives the same bytes. The pack (public/clang/, fetched by `npm run build`'s prebuild)
// is only needed for the checks against its manifest and the regeneration; the rest read the
// committed file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C_STANDARDS, CXX_STANDARDS } from "../../ui/settings";

interface CFunction { name: string; header: string; proto: string; modes?: string[] }
interface CMacro { name: string; header: string; kind: string; value?: string; modes?: string[] }
interface StdName { name: string; kind: string; header: string; since: string }
interface Library {
  header: { generator: string; pack: string; sysrootSha256: string; modes: { c: string[]; cpp: string[] }; licence: Record<string, string> };
  headers: { c: string[]; cpp: string[]; since?: Record<string, string> };
  functions: CFunction[];
  macros: CMacro[];
  std: StdName[];
}

const FILE = "src/editor/data/c-library.json";
const bytes = readFileSync(FILE);
const data = JSON.parse(bytes.toString("utf8")) as Library;
const packDir = existsSync("public/clang") ? readdirSync("public/clang").find((d) => existsSync(`public/clang/${d}/manifest.json`)) : undefined;
/**
 * The tests that need the pack. Locally it may not be fetched yet, and they are skipped; CI fetches
 * it before the unit tests (.github/workflows/ci.yml), so there a missing pack fails them instead of
 * passing a hand-edited c-library.json unchecked (review finding F5, 2026-10-19).
 */
const withPack = packDir || process.env.CI ? it : it.skip;
const pack = () => {
  expect(packDir, "the C/C++ pack in public/clang/ (node scripts/fetch-clang.mjs)").toBeDefined();
  return packDir!;
};
const NEVER = ["gets", "tmpfile", "popen", "system"];
const sorted = (list: string[]) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("c-library.json", () => {
  it("parses and names its generator, sysroot and licences", () => {
    expect(data.header.generator).toContain("scripts/gen-c-completions.mjs");
    expect(data.header.sysrootSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(data.header.licence).join("\n")).toContain("libc++");
    expect(Object.values(data.header.licence).join("\n")).toContain("Unverified");
    // The notice libc++'s headers point to is kept in the repository, and the note names it (review F1).
    for (const file of ["licenses/libcxx-8-LICENSE.TXT", "licenses/libcxxabi-8-LICENSE.TXT"]) {
      expect(Object.values(data.header.licence).join("\n"), file).toContain(file);
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain("dual licensed under both the University of Illinois");
      expect(text, file).toContain("Permission is hereby granted, free of charge");
    }
  });

  it("records the sysroot SHA-256 that scripts/fetch-clang.mjs pins", () => {
    const pinned = /"sysroot\.tar":\s*\{\s*sha256:\s*"([0-9a-f]{64})"/.exec(readFileSync("scripts/fetch-clang.mjs", "utf8"))?.[1];
    expect(pinned).toBeDefined();
    expect(data.header.sysrootSha256).toBe(pinned);
  });

  withPack("records the same SHA-256 as the pack's manifest.json", () => {
    const manifest = JSON.parse(readFileSync(`public/clang/${pack()}/manifest.json`, "utf8"));
    expect(data.header.sysrootSha256).toBe(manifest.files["sysroot.tar"].sha256);
    expect(data.header.pack).toBe(manifest.version);
  });

  it("knows the same -std settings as the settings dialog", () => {
    expect(data.header.modes.c).toEqual([...C_STANDARDS]);
    expect(data.header.modes.cpp).toEqual([...CXX_STANDARDS]);
    const all = new Set([...C_STANDARDS, ...CXX_STANDARDS] as string[]);
    for (const entry of [...data.functions, ...data.macros]) for (const m of entry.modes ?? []) expect(all.has(m), `${entry.name}: ${m}`).toBe(true);
  });

  it("never offers a function that doesn't link in this C library", () => {
    const names = new Set([...data.functions.map((f) => f.name), ...data.macros.map((m) => m.name), ...data.std.map((s) => s.name)]);
    for (const name of NEVER) expect(names.has(name), name).toBe(false);
  });

  it("offers printf, memcpy, strcmp and malloc with their headers and prototypes", () => {
    const fn = (name: string) => data.functions.find((f) => f.name === name);
    expect(fn("printf")?.header).toBe("stdio.h");
    expect(fn("printf")?.proto.startsWith("int printf(")).toBe(true);
    expect(fn("memcpy")?.header).toBe("string.h");
    expect(fn("strcmp")?.header).toBe("string.h");
    expect(fn("malloc")?.header).toBe("stdlib.h");
    for (const f of data.functions) {
      expect(["stdio.h", "stdlib.h", "string.h", "math.h", "ctype.h", "time.h"]).toContain(f.header);
      expect(f.proto, f.name).toMatch(new RegExp(`\\b${f.name}\\(`));
      expect(f.proto, f.name).not.toMatch(/__attribute|\b__\w/);
    }
  });

  it("lists include names for C and C++, without the ones that don't link", () => {
    expect(data.headers.c).toContain("stdio.h");
    expect(data.headers.cpp).toContain("vector");
    expect(data.headers.cpp).not.toContain("filesystem");
    expect(data.std.some((s) => s.name === "filesystem" || s.header === "filesystem")).toBe(false);
    // These build with clang 8 here but don't link, crash the compiler or abort when used.
    for (const h of ["thread", "future", "atomic", "regex"]) expect(data.headers.cpp).not.toContain(h);
    for (const name of ["shared_ptr", "make_shared", "thread"]) expect(data.std.some((s) => s.name === name)).toBe(false);
    for (const h of data.headers.cpp) expect(h, h).not.toMatch(/^__|\/|\./);
  });

  it("offers C++17 and C++2a headers only from their standard on, and none with nothing public (review F3)", () => {
    // libc++ 8 guards all of <span> and <compare> with _LIBCPP_STD_VER > 17, and <any>, <optional>
    // and <variant> with > 14: the #include compiles before that, and every use fails.
    expect(data.headers.since).toEqual({ any: "c++17", compare: "c++2a", optional: "c++17", span: "c++2a", variant: "c++17" });
    for (const h of Object.keys(data.headers.since ?? {})) expect(data.headers.cpp, h).toContain(h);
    for (const s of Object.values(data.headers.since ?? {})) expect(data.header.modes.cpp, s).toContain(s);
    // <bit> has an empty synopsis in libc++ 8: only internals.
    expect(data.headers.cpp).not.toContain("bit");
  });

  it("keeps no C header whose own functions don't link, though private headers it reaches do (review F2)", () => {
    expect(data.headers.c).not.toContain("ifaddrs.h");
    expect(data.headers.c).toEqual(expect.arrayContaining(["stdio.h", "stdlib.h", "string.h", "math.h", "sys/socket.h"]));
  });

  it("leaves out headers a beginner never includes, with their names (design decision 17)", () => {
    for (const h of ["stdc-predef.h", "stdio_ext.h", "libintl.h"]) {
      expect(data.headers.c, h).not.toContain(h);
      expect(data.functions.filter((f) => f.header === h).map((f) => f.name), h).toEqual([]);
      expect(data.macros.filter((m) => m.header === h).map((m) => m.name), h).toEqual([]);
    }
  });

  it("gives every std:: name a kind, a listed header and a first standard", () => {
    expect(data.std.length).toBeGreaterThan(0);
    for (const s of data.std) {
      expect(["c++11", "c++14", "c++17"], s.name).toContain(s.since);
      expect(["class", "function", "variable", "namespace"], s.name).toContain(s.kind);
      expect(data.headers.cpp, s.name).toContain(s.header);
    }
    expect(data.std.find((s) => s.name === "make_unique")?.since).toBe("c++14");
    expect(data.std.find((s) => s.name === "gcd")?.since).toBe("c++17");
    for (const m of data.macros) expect(data.headers.c, m.name).toContain(m.header);
  });

  it("keeps every list sorted and free of duplicates", () => {
    for (const list of [data.headers.c, data.headers.cpp, data.functions.map((f) => f.name), data.macros.map((m) => m.name), data.std.map((s) => s.name)]) {
      expect(list).toEqual(sorted(list));
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("is ASCII with LF line ends and a final newline", () => {
    expect(bytes.every((b) => b < 128)).toBe(true);
    expect(bytes.includes(13)).toBe(false);
    expect(bytes.at(-1)).toBe(10);
    expect(bytes.includes(Buffer.from([92, 117]))).toBe(false); // no backslash-u escapes
  });

  withPack("is exactly what the generator writes now", () => {
    pack();
    const fresh = execFileSync(process.execPath, ["scripts/gen-c-completions.mjs", "--stdout"], { timeout: 60_000, maxBuffer: 16 * 2 ** 20 });
    expect(Buffer.compare(fresh, bytes)).toBe(0);
  }, 60_000);
});
