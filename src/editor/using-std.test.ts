// std names without the std:: prefix after `using namespace std;` (design decision 17, review RB-7).
// Where the directive counts follows the C++ standard: a using-directive may appear at namespace
// scope or block scope, never class scope, and the namespace's names can be used in the scope where
// it appears, after it ([namespace.udir]/2-3, https://eel.is/c++draft/namespace.udir). A namespace's
// scope is every body of that namespace ([basic.scope.namespace]/1, https://eel.is/c++draft/basic.scope.namespace),
// the file's is the global namespace's, and a block is a compound statement ([basic.scope.block]/1).
// "|" in each sample marks the cursor. Options are read from every source the file has there.
import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { libraryContext } from "./completion-context";
import { loadCompletionCode } from "./completion-loader";
import { fileConf, fileExtensions } from "./extensions";
import { loadLibrary } from "./library-data";
import "./test-languages";

beforeAll(async () => {
  expect(await loadCompletionCode()).toBe(true);
  expect(await loadLibrary("c")).toBe(true);
});

/** Every option offered at the "|" in `sample` (Ctrl-Space by default, or typing). */
async function optionsAt(sample: string, { path = "main.cpp", cpp = "c++17", explicit = true } = {}): Promise<Completion[]> {
  const pos = sample.indexOf("|");
  if (pos < 0 || sample.indexOf("|", pos + 1) >= 0) throw new Error("one | marks the cursor");
  const doc = sample.slice(0, pos) + sample.slice(pos + 1);
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [fileConf.of(fileExtensions(path)), libraryContext.of({ files: () => [path], standards: () => ({ c: "gnu11", cpp }) })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const sources = state.languageDataAt<CompletionSource>("autocomplete", pos);
  const results = await Promise.all(sources.map((source) => source(new CompletionContext(state, pos, explicit))));
  return results.filter((r): r is CompletionResult => r != null).flatMap((r) => r.options);
}

/** The std names offered without the prefix (their info says std::). */
const unprefixed = (options: readonly Completion[]) => options.filter((o) => typeof o.info === "string" && o.info.startsWith("std::")).map((o) => o.label);

const offers = async (sample: string, options?: Parameters<typeof optionsAt>[1]) => unprefixed(await optionsAt(sample, options)).includes("vector");

describe("std names without the prefix", () => {
  it("are offered after a top-level using namespace std;, with the header they come from, and never without it", async () => {
    const options = await optionsAt("#include <vector>\nusing namespace std;\nint main() {\n    vec|\n}\n");
    const vector = options.find((o) => o.label === "vector" && unprefixed([o]).length);
    expect(vector).toMatchObject({ type: "class", info: "std::vector, declared in <vector>" });
    // No section: they rank with the other names by how well they match (review finding RB-2).
    expect(vector?.section).toBeUndefined();
    expect(await offers("#include <vector>\nint main() {\n    vec|\n}\n"), "no directive").toBe(false);
    expect(await offers("using namespace ::std;\nint main() {\n    vec|\n}\n"), "::std").toBe(true);
  });

  it("count only after the directive: not before it, and not from one after the cursor", async () => {
    expect(await offers("int main() {\n    vec|\n}\nusing namespace std;\n")).toBe(false);
    expect(await offers("vec|\nusing namespace std;\n")).toBe(false);
    expect(await offers("using namespace std;\nvec|")).toBe(true);
  });

  it("from a directive in a block: in that block after it, in blocks inside it, and nowhere else", async () => {
    const f = (body: string, after = "") => `int f() {\n    ${body}\n}\nint g() {\n    ${after}\n}\n`;
    expect(await offers(f("using namespace std;\n    vec|")), "after it, in the same block").toBe(true);
    expect(await offers(f("vec|\n    using namespace std;")), "before it in the same block").toBe(false);
    // Here the statement holding the cursor is finished, so the directive is the block's own
    // statement after it (in the row above, the parser folds it into the unfinished statement).
    expect(await offers(f("int x = vec|;\n    using namespace std;")), "before it in the same block, the statement finished").toBe(false);
    expect(await offers(f("using namespace std;\n    if (1) {\n        vec|\n    }")), "in a block inside it").toBe(true);
    expect(await offers(f("using namespace std;", "vec|")), "in a later function").toBe(false);
    expect(await offers(f("{ using namespace std; }\n    vec|")), "after the inner block it was in").toBe(false);
    expect(await offers("int f() {\n    using namespace std;\n}|"), "right after the block's closing brace").toBe(false);
    expect(await offers("int f() {\n    auto g = [] {\n        using namespace std;\n        vec|\n    };\n}\n"), "in a lambda's body").toBe(true);
  });

  it("from a directive in a namespace: in every later body of that namespace and the ones inside it, not outside", async () => {
    const ns = "namespace app {\nusing namespace std;\n}\n";
    expect(await offers(`namespace app {\nusing namespace std;\nint f() { vec| }\n}\n`), "in the same body").toBe(true);
    expect(await offers(`${ns}namespace app {\nint f() { vec| }\n}\n`), "in the namespace opened again").toBe(true);
    expect(await offers(`${ns}namespace app {\nnamespace inner {\nvec|\n}\n}\n`), "in a namespace inside it").toBe(true);
    expect(await offers(`${ns}int f() { vec| }\n`), "at file level after it").toBe(false);
    expect(await offers(`${ns}namespace other {\nvec|\n}\n`), "in another namespace").toBe(false);
    expect(await offers(`namespace outer {\nnamespace app {\nusing namespace std;\n}\n}\nnamespace app {\nvec|\n}\n`), "app inside outer is another namespace").toBe(false);
    expect(await offers("namespace a::b {\nusing namespace std;\n}\nnamespace a {\nnamespace b {\nvec|\n}\n}\n"), "a::b written both ways").toBe(true);
    // The unnamed namespace and an inline namespace are used from the one around them as if by a
    // using-directive ([namespace.unnamed]/1, https://eel.is/c++draft/namespace.unnamed;
    // [namespace.def.general]/6, https://eel.is/c++draft/namespace.def.general), and using-directives
    // are transitive for unqualified lookup ([namespace.udir], Note 4), so a directive in either one
    // counts in the namespace around it.
    expect(await offers("namespace {\nusing namespace std;\n}\nvec|\n"), "from the unnamed namespace, at file level").toBe(true);
    expect(await offers("inline namespace v1 {\nusing namespace std;\n}\nvec|\n"), "from an inline namespace, at file level").toBe(true);
    const unnamedInApp = "namespace app {\nnamespace {\nusing namespace std;\n}\n}\n";
    expect(await offers(`${unnamedInApp}namespace app {\nvec|\n}\n`), "from the unnamed namespace in app, in app").toBe(true);
    expect(await offers(`${unnamedInApp}vec|\n`), "from the unnamed namespace in app, at file level").toBe(false);
    const inlineInA = "namespace a::inline b {\nusing namespace std;\n}\n";
    expect(await offers(`${inlineInA}namespace a {\nvec|\n}\n`), "from a::inline b, in a").toBe(true);
    expect(await offers(`${inlineInA}vec|\n`), "from a::inline b, at file level (b is inline in a, not in the file)").toBe(false);
    expect(await offers('extern "C++" {\nusing namespace std;\n}\nvec|\n'), "a linkage block is no scope").toBe(true);
  });

  it("never from a directive in a class (not allowed there), a comment, a string, an unfinished line or another namespace", async () => {
    expect(await offers("struct S {\n    using namespace std;\n};\nvec|\n")).toBe(false);
    expect(await offers("// using namespace std;\nvec|\n")).toBe(false);
    expect(await offers('const char *s = "using namespace std;";\nvec|\n')).toBe(false);
    expect(await offers("using namespace std\nint main() {\n    vec|\n}\n")).toBe(false);
    expect(await offers("using namespace std::chrono;\nvec|\n")).toBe(false);
  });

  it("go only where a name goes, and not in C", async () => {
    const using = "#include <vector>\nusing namespace std;\n";
    expect(await offers(`${using}int main() {\n    std::vec|\n}\n`), "after std:: (that list has them)").toBe(false);
    expect(await offers(`${using}int main() {\n    v.vec|\n}\n`), "after a dot").toBe(false);
    expect(await offers(`${using}// vec|\n`), "in a comment").toBe(false);
    expect(await offers(`${using}#define X vec|\n`), "on a preprocessor line").toBe(false);
    expect(await offers(`${using}const char *s = "vec|";\n`), "in a string").toBe(false);
    expect(await offers(`${using}int main(void) {\n    vec|\n}\n`, { path: "main.c" }), "in a C file").toBe(false);
    expect(await offers(`${using}int main() {\n    vec|\n}\n`, { explicit: false }), "while typing").toBe(true);
    expect(await offers(`${using}int main() {\n    |\n}\n`, { explicit: false }), "with no word typed").toBe(false);
  });

  it("follow the C++ standard setting, and leave out the C functions the C list already offers", async () => {
    const at = (cpp: string) => optionsAt("using namespace std;\nint main() {\n    |\n}\n", { cpp });
    expect(unprefixed(await at("c++17"))).toEqual(expect.arrayContaining(["vector", "cout", "clamp", "gcd", "getline"]));
    expect(unprefixed(await at("c++11")), "clamp and gcd are C++17").not.toEqual(expect.arrayContaining(["clamp"]));
    expect(unprefixed(await at("c++11"))).not.toContain("gcd");
    const options = await at("c++17");
    // sqrt and abs from <cmath> are the C library's functions: offered once, as the C list has them.
    for (const name of ["sqrt", "abs", "pow"]) expect(options.filter((o) => o.label === name).map((o) => o.info), name).toHaveLength(1);
    // std::getline (<string>) is not C's getline (<stdio.h>): both are offered.
    expect(options.filter((o) => o.label === "getline").map((o) => o.info).sort()).toEqual(["Declared in <stdio.h>", "std::getline, declared in <string>"]);
  });

  it("rank below the file's own names that match as well, and below the C names; cout first of the std names", async () => {
    const options = await optionsAt("using namespace std;\nint sort_total;\nint main() {\n    |\n}\n");
    const boost = (label: string, std: boolean) => options.find((o) => o.label === label && unprefixed([o]).length === (std ? 1 : 0))?.boost ?? 0;
    expect(boost("sort_total", false), "an own name").toBe(0);
    expect(boost("sort", true)).toBeLessThan(0);
    expect(boost("cout", true)).toBeGreaterThan(boost("sort", true));
    expect(boost("vector", true)).toBeGreaterThan(boost("deque", true));
    expect(boost("puts", false), "a C library name").toBeGreaterThan(boost("cout", true));
    expect(Math.min(...options.filter((o) => unprefixed([o]).length).map((o) => o.boost ?? 0)), "a better match still wins").toBeGreaterThan(-100);
  });
});
