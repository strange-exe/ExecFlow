// The library names, your own names and the workspace index are in their own lazy chunk
// (completion-code.ts): the editor chunk reaches them only through import(), so they never make the
// editor chunk bigger (research doc section 3, "Bundle size"; the editor chunk grew from 197.50 to
// 205.58 kB gzip with Tier 1 before the split, 2026-10-19). Keywords and snippets
// (keyword-completion.ts) are the editor chunk's, as C and C++ keywords were before Tier 1, so they
// are offered even when that chunk can't load: they import nothing from it.
// This models the bundler from the source text; design.spec.ts checks the built chunks themselves.
// Rolldown puts a module in the chunk of every entry that imports it statically, so this follows
// the static imports from the editor chunk's entry (editor-manager.ts, which workbench.ts imports
// with import()) the way the bundler does: `import type` and import() don't count.
import { describe, expect, it } from "vitest";

const glob = import.meta.glob<string>(["../**/*.ts", "!../**/*.test.ts", "!../workers/**", "!../vendor/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Each module's source by its path under src/ ("editor/extensions.ts"); Vite's keys are relative to this file. */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(glob).map(([key, text]) => [key.startsWith("./") ? `editor/${key.slice(2)}` : key.replace(/^\.\.\//, ""), text]),
);

/** The module `spec` names, imported from `from` (both paths under src/), or null for a package. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a package: not ours
  const parts = from.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  const path = parts.join("/");
  for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) if (candidate in sources) return candidate;
  return null;
}

/** The modules `id` imports statically: value imports, side-effect imports and re-exports. */
function staticImports(id: string, text: string): string[] {
  const out: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^"]+)"|^\s*import\s+"([^"]+)"/gm;
  for (const m of text.matchAll(statement)) {
    if (m[2]) continue; // import type / export type: erased
    // `import { type A, type B } from` imports nothing at run time either.
    const names = m[3] ?? "";
    if (/^\{[\s\S]*\}$/.test(names) && names.slice(1, -1).split(",").every((n) => /^\s*(type\s+\S|$)/.test(n))) continue;
    const target = resolve(id, m[4] ?? m[5]);
    if (target) out.push(target);
  }
  return out;
}

/** The packages `text` imports statically for their values ("@codemirror/lang-cpp"). */
function packageImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^".][^"]*)"|^\s*import\s+"([^".][^"]*)"/gm)) {
    if (m[2]) continue;
    const names = m[3] ?? "";
    if (/^\{[\s\S]*\}$/.test(names) && names.slice(1, -1).split(",").every((n) => /^\s*(type\s+\S|$)/.test(n))) continue;
    out.push(m[4] ?? m[5]);
  }
  return out;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    todo.push(...staticImports(id, sources[id]));
  }
  return seen;
}

/** The editor chunk's entry: workbench.ts imports it with import(). */
const EDITOR = "editor/editor-manager.ts";

/** The modules that belong in the completion chunk only. */
const COMPLETION_ONLY = [
  "editor/completion-code.ts",
  "editor/library-completion.ts",
  "editor/library-data.ts",
  "editor/own-completion.ts",
  "editor/own-names.ts",
  "editor/workspace-index.ts",
];

/** The language chunks' entries (language-support.ts loads them with import()). */
const LANGUAGE_CHUNKS = ["editor/python-support.ts", "editor/c-support.ts"];

/** The grammar packages: the language chunks', never the editor chunk's. */
const GRAMMARS = ["@codemirror/lang-python", "@codemirror/lang-cpp", "@lezer/python", "@lezer/cpp"];

describe("the editor chunk and the completion chunk", () => {
  it("finds the modules (the glob and the resolver work)", () => {
    expect(Object.keys(sources)).toContain(EDITOR);
    expect(closure(EDITOR)).toContain("editor/extensions.ts");
    expect(closure(EDITOR)).toContain("editor/language-support.ts");
    expect(closure(EDITOR)).toContain("core/languages.ts");
  });

  it("the editor chunk imports none of the completion code statically", () => {
    const editor = closure(EDITOR);
    expect(COMPLETION_ONLY.filter((id) => editor.has(id))).toEqual([]);
  });

  it("keywords and snippets come with the language chunks, and reach none of the completion code", () => {
    const reached = closure("editor/keyword-completion.ts");
    expect(COMPLETION_ONLY.filter((id) => reached.has(id))).toEqual([]);
    // The language chunks place them themselves, not through the completion chunk (lazySource).
    for (const id of LANGUAGE_CHUNKS) expect(staticImports(id, sources[id]), id).toContain("editor/keyword-completion.ts");
  });

  it("the grammars and the language chunks are not in the editor chunk (0.18.1: it was 195 of its 200 kB gzip)", () => {
    const editor = closure(EDITOR);
    expect([...LANGUAGE_CHUNKS, "editor/language-sources.ts", "editor/keyword-completion.ts"].filter((id) => editor.has(id))).toEqual([]);
    const grammars = [...editor].flatMap((id) => packageImports(sources[id]).filter((p) => GRAMMARS.includes(p)).map((p) => `${id}: ${p}`));
    expect(grammars).toEqual([]);
  });

  it("the language chunks are loaded with import(), from language-support.ts only", () => {
    const loaders = Object.keys(sources).filter((id) => /import\(\s*"\.\/(python|c)-support"\s*\)/.test(sources[id]));
    expect(loaders).toEqual(["editor/language-support.ts"]);
    for (const id of LANGUAGE_CHUNKS) {
      const importers = Object.keys(sources).filter((other) => staticImports(other, sources[other]).includes(id));
      expect(importers, id).toEqual([]);
    }
  });

  it("language-support.ts imports no CodeMirror code, so the shell can start a language's load with the editor's", () => {
    const text = sources["editor/language-support.ts"];
    expect(packageImports(text)).toEqual([]);
    expect(staticImports("editor/language-support.ts", text).every((id) => id.startsWith("core/"))).toBe(true);
  });

  it("packageImports sees value imports of packages and skips type-only ones", () => {
    expect(packageImports('import type { A } from "@lezer/cpp";\nimport { type B } from "@codemirror/lang-cpp";')).toEqual([]);
    expect(packageImports('import { cpp } from "@codemirror/lang-cpp";\nimport { x } from "./y";')).toEqual(["@codemirror/lang-cpp"]);
  });

  it("the completion code is loaded with import() from the editor chunk, in one place", () => {
    const loaders = [...closure(EDITOR)].filter((id) => /import\(\s*"\.\/completion-code"\s*\)/.test(sources[id]));
    expect(loaders).toEqual(["editor/completion-loader.ts"]);
  });

  it("nothing outside the editor imports the completion code statically (the first-visit chunks stay without it)", () => {
    const outside = Object.keys(sources).filter((id) => !id.startsWith("editor/"));
    const reached = new Set(outside.flatMap((id) => staticImports(id, sources[id])));
    expect(COMPLETION_ONLY.filter((id) => reached.has(id))).toEqual([]);
  });

  it("the completion chunk imports the editor chunk's entry, so the modules both use stay in the editor chunk", () => {
    // completion-code.ts explains why: without it Rolldown makes a common chunk of them.
    expect(staticImports("editor/completion-code.ts", sources["editor/completion-code.ts"])).toContain(EDITOR);
    // Everything the completion code reaches is the editor's or its own.
    const completion = closure("editor/completion-code.ts");
    const editor = closure(EDITOR);
    // (keyword-completion.ts is shared with the language chunks: a common chunk of its own.)
    const own = [...completion].filter((id) => !editor.has(id) && !id.startsWith("core/") && !id.startsWith("runner/"));
    expect(own.sort()).toEqual([...COMPLETION_ONLY, "editor/keyword-completion.ts"].sort());
  });

  it("type-only imports don't count, value imports and re-exports do", () => {
    expect(staticImports("editor/x.ts", 'import type { A } from "./own-names";\nimport { type B } from "./workspace-index";')).toEqual([]);
    expect(staticImports("editor/x.ts", 'import { a, type B } from "./own-names";')).toEqual(["editor/own-names.ts"]);
    expect(staticImports("editor/x.ts", 'export { a } from "./own-names";\nimport "./late-data";')).toEqual(["editor/own-names.ts", "editor/late-data.ts"]);
    expect(staticImports("editor/x.ts", 'import {\n  a,\n  b,\n} from "../core/paths";')).toEqual(["core/paths.ts"]);
    expect(staticImports("editor/x.ts", 'const code = () => import("./own-names");')).toEqual([]);
  });
});
