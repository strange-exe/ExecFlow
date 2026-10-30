// The time before a language's chunk arrives (language-support.ts, 0.18.1): no test-languages.ts
// here, so each file starts with no language loaded. A file opened before its chunk is plain text;
// once the chunk is here EditorManager gives every open file of that language its grammar and
// completion, the file on screen and the ones in the background alike, and nothing else changes.
import { undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { EditorManager } from "./editor-manager";
import { headlessHost } from "./host";
import { languageLoaded, languageSupport, loadLanguage } from "./language-support";

const grammar = (state: EditorState | null) => state?.facet(language)?.name ?? null;

describe("a language's chunk arriving after its files opened", () => {
  it("gives every open file of the language its grammar, and leaves the text, history and selection alone", async () => {
    expect(languageLoaded("python")).toBe(false);
    expect(languageSupport("python")).toEqual([]);
    const docs: string[] = [];
    const mgr = new EditorManager({ host: headlessHost(), hooks: { onDocChanged: (id) => docs.push(id) } });
    mgr.open("a", "main.py", "def f():\n    pass\n");
    mgr.apply("a", { changes: { from: 0, insert: "# c\n" }, selection: { anchor: 2 } });
    mgr.open("b", "util.py", "x = 1\n", { activate: false });
    mgr.open("t", "notes.txt", "plain\n", { activate: false });
    expect(grammar(mgr.state("a"))).toBeNull();
    expect(grammar(mgr.state("b"))).toBeNull();
    docs.length = 0;

    await loadLanguage("python");
    expect(grammar(mgr.state("a"))).toBe("python");
    expect(grammar(mgr.state("b"))).toBe("python");
    expect(grammar(mgr.state("t"))).toBeNull();
    // A new configuration, not an edit: no change reported, nothing dirty, history and cursor kept.
    expect(docs).toEqual([]);
    expect(mgr.text("a")).toBe("# c\ndef f():\n    pass\n");
    expect(undoDepth(mgr.state("a")!)).toBe(1);
    expect(mgr.state("a")!.selection.main.head).toBe(2);
    expect(mgr.state("a")!.facet(EditorView.contentAttributes)).toContainEqual({ "aria-label": "Code editor, main.py" });
    expect(languageLoaded("c")).toBe(false); // only what was asked for
  });

  it("a rename to another language loads that language and switches the grammar when it arrives", async () => {
    await loadLanguage("python");
    const mgr = new EditorManager({ host: headlessHost() });
    mgr.open("a", "main.py", "x = 1\n");
    expect(grammar(mgr.state("a"))).toBe("python");
    mgr.rename("a", "main.cpp");
    expect(grammar(mgr.state("a"))).toBeNull();
    await loadLanguage("cpp");
    expect(grammar(mgr.state("a"))).toBe("cpp");
  });

  it("a file opened once the chunk is here has its grammar at once", async () => {
    await loadLanguage("c");
    const mgr = new EditorManager({ host: headlessHost() });
    mgr.open("a", "main.c", "int x;\n");
    expect(grammar(mgr.state("a"))).toBe("cpp");
  });
});
