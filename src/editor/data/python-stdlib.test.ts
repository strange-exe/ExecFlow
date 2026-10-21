/// <reference types="node" />
// The Python completion data (scripts/gen-python-completions.mjs writes it from Pyodide 314.0.7)
// against its contract: it parses with the header first, lists are sorted, names are public,
// signatures are short single lines on callables only, modules that can't work in the browser are
// absent, it stays near its size budget, and it is exactly what a fresh run of the generator writes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const FILE = "src/editor/data/python-stdlib.json";
const bytes = readFileSync(FILE);
const text = bytes.toString("utf8");

type Kind = "class" | "constant" | "function" | "namespace" | "variable";
interface PythonStdlib {
  header: { generator: string; pyodide: string; python: string; note: string };
  modules: string[];
  /** module -> kind -> name -> signature (null when there is none). */
  members: Record<string, Partial<Record<Kind, Record<string, string | null>>>>;
}

const data = JSON.parse(text) as PythonStdlib;
const KINDS: readonly string[] = ["class", "constant", "function", "namespace", "variable"];
const CALLABLE: readonly string[] = ["class", "function"];

/** Code-unit order, as the generator sorts (never localeCompare, which depends on the machine). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Strictly increasing, so sorted and free of duplicates. */
const isSorted = (list: readonly string[]) => list.every((value, i) => i === 0 || byCodeUnit(list[i - 1], value) < 0);

/** Every [module, kind, name, signature] in the file. */
const entries = Object.entries(data.members).flatMap(([module, groups]) =>
  Object.entries(groups).flatMap(([kind, group]) => Object.entries(group ?? {}).map(([name, signature]) => ({ module, kind, name, signature }))),
);

describe("src/editor/data/python-stdlib.json", () => {
  it("parses, with the header first", () => {
    expect(Object.keys(data)).toEqual(["header", "modules", "members"]);
  });

  it("names its generator and the Pyodide it came from, which is the one installed, and carries no date", () => {
    expect(data.header).toEqual({
      generator: "scripts/gen-python-completions.mjs",
      pyodide: "314.0.7",
      python: expect.stringMatching(/^3\.14\.\d+$/),
      note: "generated, do not edit",
    });
    const installed = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version;
    expect(data.header.pyodide).toBe(installed);
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it("is ASCII with LF line endings and a final newline", () => {
    expect([...bytes].filter((b) => b > 0x7e || (b < 0x20 && b !== 0x0a))).toEqual([]);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("offers math with sqrt and its signature", () => {
    expect(data.modules).toContain("math");
    expect(data.members.math?.function?.sqrt, "math.sqrt").toEqual(expect.stringMatching(/^\(x\b.*\)$/));
  });

  it("leaves out modules that can't work in the browser", () => {
    for (const name of ["tkinter", "turtle", "turtledemo", "idlelib", "ensurepip", "venv", "test", "subprocess", "threading", "multiprocessing", "socket", "webbrowser"]) {
      expect(data.modules, name).not.toContain(name);
    }
  });

  it("leaves out internal modules no program imports, and os's members, keeping os.path (design decision 17)", () => {
    expect(data.modules).not.toContain("nturl2path");
    expect(data.modules).toContain("os");
    expect(Object.keys(data.members)).not.toContain("os");
    expect(data.members["os.path"]?.function?.join, "os.path.join").toBeDefined();
  });

  it("has no name that starts with an underscore", () => {
    const names = [...data.modules, ...Object.keys(data.members).flatMap((m) => m.split(".")), ...entries.map((e) => e.name)];
    expect(names.length).toBeGreaterThan(500);
    expect(names.filter((n) => n.startsWith("_"))).toEqual([]);
  });

  it("keeps every list sorted, with only CodeMirror completion types as kinds", () => {
    expect(isSorted(data.modules)).toBe(true);
    expect(isSorted(Object.keys(data.members))).toBe(true);
    for (const [module, groups] of Object.entries(data.members)) {
      const kinds = Object.keys(groups);
      expect(isSorted(kinds), module).toBe(true);
      expect(kinds.filter((k) => !KINDS.includes(k)), module).toEqual([]);
      for (const [kind, group] of Object.entries(groups)) expect(isSorted(Object.keys(group ?? {})), `${module} ${kind}`).toBe(true);
    }
  });

  it("gives signatures only to callables, each one line of at most 120 characters with no object address", () => {
    const signed = entries.filter((e) => e.signature !== null);
    expect(signed.length).toBeGreaterThan(300);
    for (const { module, kind, name, signature } of signed) {
      const where = `${module}.${name}`;
      expect(CALLABLE, where).toContain(kind);
      expect(signature, where).toMatch(/^\(.*\)/);
      expect(signature, where).not.toMatch(/[\r\n]/);
      expect(signature!.length, where).toBeLessThanOrEqual(120);
      expect(signature, where).not.toMatch(/ at 0x[0-9a-fA-F]+>/);
    }
  });

  it("lists members only for modules it offers", () => {
    for (const module of Object.keys(data.members)) expect(data.modules, module).toContain(module.split(".")[0]);
  });

  it("stays near its 6 KB gzip budget", () => {
    // 6,070 B for Pyodide 314.0.7. Past this, cut a module in the generator (CUT) rather than raise the limit.
    expect(gzipSync(bytes, { level: 9 }).length).toBeLessThanOrEqual(6_500);
  });

  it("is exactly what a fresh run of the generator writes", { timeout: 120_000 }, () => {
    const run = spawnSync(process.execPath, ["scripts/gen-python-completions.mjs", "--check"], { encoding: "utf8", timeout: 110_000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`${FILE} is up to date`);
  });
});
