/// <reference types="node" />
// The driver's job lines (captured from the real LLVM 22 driver for PROBES, __fixtures__/clang22-driver.json)
// turned into the compile and link templates the worker uses.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cc1Template, linkArgs, linkTemplate, parseDriverJobs, PROBE, PROBES } from "./clang-jobs";

const fixture = JSON.parse(readFileSync("src/runner/__fixtures__/clang22-driver.json", "utf8")) as {
  llvm: string;
  probes: Record<"c" | "cpp" | "link", { args: string[]; output: string }>;
};
const jobs = (kind: "c" | "cpp" | "link") => parseDriverJobs(fixture.probes[kind].output);

describe("the captured driver output", () => {
  it("was captured for today's probes, with clang 22", () => {
    expect(fixture.llvm).toMatch(/^clang version 22\./);
    for (const kind of ["c", "cpp", "link"] as const) expect(fixture.probes[kind].args).toEqual(PROBES[kind]);
  });
});

describe("parseDriverJobs", () => {
  it("reads one job per quoted line, dropping the runtime's empty program path", () => {
    const [job] = jobs("cpp");
    expect(job.slice(0, 2)).toEqual(["clang++", "-cc1"]);
    expect(job.at(-1)).toBe(PROBE.cpp);
  });
  it("unquotes escaped quotes, backslashes and dollar signs", () => {
    expect(parseDriverJobs(' "clang" "-cc1" "-DX=\\"a b\\"" "-DY=\\\\" "-DZ=\\$"\n')).toEqual([["clang", "-cc1", '-DX="a b"', "-DY=\\", "-DZ=$"]]);
  });
  it("throws with the driver's last words when it planned nothing", () => {
    expect(() => parseDriverJobs("clang version 22.1.0\nclang: error: unknown argument: '-bad'\n")).toThrow(/unknown argument/);
  });
});

describe("cc1Template", () => {
  const cpp = cc1Template(jobs("cpp"), PROBE.cpp);
  const c = cc1Template(jobs("c"), PROBE.c);

  it("keeps everything the driver adds for exceptions in C++", () => {
    expect(cpp).toContain("-fcxx-exceptions");
    expect(cpp).toContain("-fexceptions");
    expect(cpp).toContain("-exception-model=wasm");
    expect(cpp).toContain("+exception-handling");
    expect(cpp).toContain("-wasm-use-legacy-eh=false");
    // The exceptions build of libc++ comes before the C library's headers.
    expect(cpp.indexOf("/sysroot/include/wasm32-wasip1/eh/c++/v1")).toBeLessThan(cpp.indexOf("/sysroot/include/wasm32-wasip1"));
  });
  it("leaves C++ out of C", () => {
    expect(c).not.toContain("-fcxx-exceptions");
    expect(c.some((a) => a.includes("c++/v1"))).toBe(false);
    expect(c).toContain("/ce/include");
  });
  it("takes out what each unit sets (the file, the output, the language, the optimisation) and keeps the diagnostics flags", () => {
    for (const t of [c, cpp]) {
      for (const gone of ["-o", "-x", "-main-file-name", "-emit-obj", "-cc1", PROBE.c, PROBE.cpp, PROBE.object]) expect(t).not.toContain(gone);
      expect(t[t.indexOf("-ferror-limit") + 1]).toBe("50");
      expect(t).toContain("-fdiagnostics-parseable-fixits");
      expect(t.some((a) => /^-O/.test(a))).toBe(false);
      expect(t.slice(0, 2)).toEqual(["-triple", "wasm32-unknown-wasip1"]);
    }
  });
  it("refuses jobs with no compile step", () => {
    expect(() => cc1Template(jobs("link"), PROBE.cpp)).toThrow(/no compile step/);
  });
});

describe("linkTemplate and linkArgs", () => {
  const template = linkTemplate(jobs("link"));

  it("keeps the driver's libraries in its order, with the exceptions build first on the search path", () => {
    expect(template[0]).toBe("wasm-ld");
    const libs = template.filter((a) => a.startsWith("-l"));
    expect(libs).toEqual(["-lunwind", "-lc++", "-lc++abi", "-lc"]);
    expect(template.indexOf("-L/sysroot/lib/wasm32-wasip1/eh")).toBeLessThan(template.indexOf("-L/sysroot/lib/wasm32-wasip1"));
    expect(template).toContain("/sysroot/lib/wasm32-wasip1/crt1-command.o");
    expect(template.some((a) => a.endsWith("libclang_rt.builtins.a"))).toBe(true);
  });
  it("puts the objects where the probe was, the output after -o, and extra flags right after the program", () => {
    const args = linkArgs(template, ["/rt/init.o", "/o/a.o", "/o/b.o"], "/out/main.wasm", ["--stack-first"]);
    expect(args.slice(0, 2)).toEqual(["wasm-ld", "--stack-first"]);
    const at = args.indexOf("/rt/init.o");
    expect(args.slice(at, at + 3)).toEqual(["/rt/init.o", "/o/a.o", "/o/b.o"]);
    expect(args[at - 1]).toBe("/sysroot/lib/wasm32-wasip1/crt1-command.o");
    expect(args[args.indexOf("-o") + 1]).toBe("/out/main.wasm");
    expect(args).not.toContain("{objects}");
    expect(args).not.toContain(PROBE.object);
  });
  it("refuses jobs with no link step", () => {
    expect(() => linkTemplate(jobs("cpp"))).toThrow(/no link step/);
  });
});
