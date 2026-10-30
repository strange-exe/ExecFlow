import { describe, expect, it } from "vitest";
import {
  choiceProblem, cleanPrintOptions, cssText, DEFAULT_PRINT_OPTIONS, fallbackFooter, MADE_WITH, NEXT_STEP, pageName, pageRules, PRINT_LINE_CAP,
  PRINT_OPTIONS_KEY, printMessage, printTitle, readPrintOptions, writePrintOptions,
} from "./print";

const cp = (n: number) => String.fromCodePoint(n);
/** Reads a cssText() result back the way a CSS parser does (hex escape plus one space). */
const unescape = (text: string) => text.replace(/\\([0-9a-f]{1,6}) /g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));

describe("print options", () => {
  it("default to the print-safe ink with line numbers and the footer on", () => {
    expect(DEFAULT_PRINT_OPTIONS).toEqual({ colours: "print", numbers: true, footer: true });
    expect(PRINT_OPTIONS_KEY).toBe("codeeditor:print");
  });

  it("are cleaned field by field (the migration too): odd values fall back, unknown keys go", () => {
    expect(cleanPrintOptions({})).toEqual(DEFAULT_PRINT_OPTIONS);
    expect(cleanPrintOptions({ colours: "neon", numbers: "no", footer: 0, x: 1 })).toEqual(DEFAULT_PRINT_OPTIONS);
    expect(cleanPrintOptions({ colours: "theme", numbers: false, footer: false })).toEqual({ colours: "theme", numbers: false, footer: false });
    for (const odd of [null, [], "text", 3]) expect(cleanPrintOptions(odd)).toEqual(DEFAULT_PRINT_OPTIONS);
  });

  it("read and write through storage that may throw or hold junk", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    writePrintOptions(storage, { colours: "theme", numbers: false, footer: true });
    expect(JSON.parse(data.get(PRINT_OPTIONS_KEY)!)).toEqual({ colours: "theme", numbers: false, footer: true });
    expect(readPrintOptions(storage)).toEqual({ colours: "theme", numbers: false, footer: true });
    data.set(PRINT_OPTIONS_KEY, "{not json");
    expect(readPrintOptions(storage)).toEqual(DEFAULT_PRINT_OPTIONS);
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
    expect(readPrintOptions(throwing)).toEqual(DEFAULT_PRINT_OPTIONS);
    expect(() => writePrintOptions(throwing, DEFAULT_PRINT_OPTIONS)).not.toThrow();
    expect(readPrintOptions(null)).toEqual(DEFAULT_PRINT_OPTIONS);
  });
});

describe("cssText: file text inside a CSS string", () => {
  it.each([
    ["main.py"],
    ['a"; } body { display: none } @page { x: "'],
    ["back\\slash/and'quote"],
    ["new\nline\rand\ftab\t"],
    ["</style><script>alert(1)</script>"],
    [`emoji ${cp(0x1f600)} and ${cp(0xe9)}`],
    [`${cp(0x202e)}evil.py`],
  ])("%j keeps only letters, digits, spaces and escapes, and reads back", (text) => {
    const out = cssText(text);
    // Nothing that could end a string, a rule or a sheet: no quotes, braces, semicolons, newlines or angle brackets.
    expect(out).toMatch(/^(?:[A-Za-z0-9 ]|\\[0-9a-f]{1,6} )*$/);
    // Direction and invisible characters become visible tags first (snippet.ts shown()), everything else reads back as written.
    expect(unescape(out)).toBe(text.includes(cp(0x202e)) ? "[U+202E]evil.py" : text);
  });
});

describe("page rules", () => {
  const spec = { paths: ["main.py", 'labs/a"b.c'], date: "23 Oct 2026", ink: "#4b524d", font: '"Source Sans 3", sans-serif' };

  it("set the margins, and with the footer one named page per file whose margin boxes name it, count pages and say the date and mark", () => {
    const css = pageRules(spec);
    expect(css).toContain("@page { margin: 14mm 14mm 16mm 14mm; }");
    expect(pageName(1)).toBe("ce-file-1");
    expect(css).toContain(`@page ce-file-0 {`);
    expect(css).toContain(`@page ce-file-1 {`);
    expect(css).toContain(`@bottom-left { content: "${cssText("main.py, 23 Oct 2026")}";`);
    expect(css).toContain(`@bottom-left { content: "${cssText('labs/a"b.c, 23 Oct 2026')}";`);
    expect(css).toContain('@bottom-center { content: "Page " counter(page) " of " counter(pages);');
    expect(css).toContain(`@bottom-right { content: "${cssText(MADE_WITH)}";`);
    // The browser's own header stays off the pages (an empty top box), as its footer does (the bottom boxes).
    expect(css.match(/@top-center \{ content: ""; \}/g)).toHaveLength(2);
    expect(css).toContain("color: #4b524d;");
    expect(css.match(/\{/g)!.length, "every block opened is closed").toBe(css.match(/\}/g)!.length);
  });

  it("drop an ink that isn't #rrggbb and anything odd in the font list", () => {
    const css = pageRules({ ...spec, ink: "red; } * { color: red", font: "x; } * { display: none" });
    expect(css).not.toContain("color:");
    expect(css).not.toMatch(/\* \{/);
  });

  it("without the footer: the margins, and empty boxes that keep the browser's own header and footer off", () => {
    expect(pageRules(null)).toBe('@page { margin: 14mm 14mm 16mm 14mm; }\n@page { @top-center { content: ""; } @bottom-center { content: ""; } }');
  });
});

describe("the rest", () => {
  it("the title browsers name the PDF after", () => {
    expect(printTitle(["labs/main.py"])).toBe("main.py");
    expect(printTitle(["a.py", "b.c"])).toBe("a.py and 1 more file");
    expect(printTitle(["a.py", "b.c", "c.cpp"])).toBe("a.py and 2 more files");
    expect(printTitle([`${cp(0x202e)}x.py`])).toBe("[U+202E]x.py");
    expect(printTitle([])).toBe("ExecFlow");
  });

  it("what can be printed and what can't", () => {
    expect(choiceProblem([])).toBe("Choose at least one file.");
    expect(choiceProblem([10, 20])).toBeNull();
    expect(choiceProblem([PRINT_LINE_CAP])).toBeNull();
    expect(choiceProblem([PRINT_LINE_CAP, 1])).toBe("That's 20,001 lines. One PDF can hold up to 20,000, so choose fewer files.");
  });

  it("the words: the next step, the footer without margin boxes, the messages", () => {
    expect(NEXT_STEP).toBe('Your browser\'s print dialog opens next. Choose "Save as PDF" as the printer.');
    expect(fallbackFooter("labs/main.py", "23 Oct 2026")).toBe("labs/main.py, 23 Oct 2026. Made with ExecFlow");
    expect(MADE_WITH).toBe("Made with ExecFlow");
    expect(printMessage({ kind: "read-failed", path: "a.py" })).toEqual({ text: "Couldn't read a.py. Try again.", tone: "error" });
    expect(printMessage({ kind: "partial", paths: ["labs/a.py", "b.py"] }).text).toBe("Some colours are missing in a.py, b.py: the file was still being read.");
    expect(printMessage({ kind: "print-failed" }).tone).toBe("error");
    expect(printMessage({ kind: "prepare-failed" })).toEqual({ text: "Couldn't prepare the pages. Check the connection, then try again.", tone: "error" });
  });
});
