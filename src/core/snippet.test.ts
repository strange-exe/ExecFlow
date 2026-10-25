import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  canCopyImages, fitName, labelUnits, lineWords, MAX_LINES, menuLabel, pickLines, refusalMessage, shown,
  type CaptureMessage, type Entry, type LineSpan, type PaintInfo,
} from "./snippet";
import {
  captureMessage, checkColors, cleanImageOptions, colorChoices, DEFAULT_IMAGE_OPTIONS, dialogTitle, downloadName, highlightExample, highlightHint,
  IMAGE_OPTIONS_KEY, IMAGE_TOKENS, NO_PREVIEW, optionsWord, PADDING, parseHighlight, previewLabel, rangesOf, readImageOptions, sameOptions, sizeLine,
  writeImageOptions, type ImageOptions,
} from "./snippet-dialog";
import { shown as domShown } from "../ui/dom";

// Special characters are built from their code points: this file stays ASCII.
const ELL = String.fromCodePoint(0x2026);
const RLO = String.fromCodePoint(0x202e);

// Line 1 "a" 0-1, line 2 "bb" 2-4, line 3 blank at 5, line 4 "ccc" 6-9, line 5 blank at 10.
const DOC = "a\nbb\n\nccc\n";

function stateWith(doc: string, ranges: [number, number][]) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
    extensions: EditorState.allowMultipleSelections.of(true),
  });
}

const plan = (first: number, last: number, gaps = false): LineSpan => ({ ok: true, first, last, gaps });
/** The round-2 defaults with no line highlighted. */
const DEFAULTS: ImageOptions = { ...DEFAULT_IMAGE_OPTIONS, highlight: [] };
/** Round 2's default look, as the label says it, with batch 4's "Made with CodeEditor" line (on by default). */
const LOOK = 'Plain frame, medium background, "Made with CodeEditor" under the card';

describe("pickLines", () => {
  it.each([
    ["0 to 6: line 4 at column 0 dropped, then blank line 3 trimmed", [[0, 6]], plan(1, 2)],
    ["3 to 7", [[3, 7]], plan(2, 4)],
    ["a cursor at 5", [[5, 5]], { ok: false, reason: "empty" }],
    ["0 to 1 and 7 to 8: lines 2 and 3 touched by no range", [[0, 1], [7, 8]], plan(1, 4, true)],
    ["4 to 6", [[4, 6]], plan(2, 2)],
    ["5 to 6: only the blank line", [[5, 6]], { ok: false, reason: "blank" }],
    ["a cursor at 1 and 2 to 4: the cursor ignored", [[1, 1], [2, 4]], plan(2, 2)],
    ["one range per line on lines 1 to 2", [[0, 1], [2, 4]], plan(1, 2)],
  ] as [string, [number, number][], unknown][])("%s", (_, ranges, expected) => {
    expect(pickLines(stateWith(DOC, ranges))).toEqual(expected);
  });

  it("takes all of 300 lines and refuses 301 with the count", () => {
    expect(MAX_LINES).toBe(300);
    const doc300 = "x\n".repeat(300);
    expect(pickLines(stateWith(doc300, [[0, doc300.length]]))).toEqual(plan(1, 300));
    const doc301 = "x\n".repeat(301);
    expect(pickLines(stateWith(doc301, [[0, doc301.length]]))).toEqual({ ok: false, reason: "cap", count: 301, first: 1, last: 301 });
  });

  it("a backwards range is the same lines", () => {
    expect(pickLines(stateWith(DOC, [[7, 3]]))).toEqual(plan(2, 4));
  });

  it("counts a line of spaces and tabs as blank, but never a line holding an invisible character", () => {
    expect(pickLines(stateWith("  \t\nx", [[0, 3]]))).toEqual({ ok: false, reason: "blank" });
    const hidden = `${String.fromCodePoint(0x200b)}\n`;
    expect(pickLines(stateWith(hidden, [[0, 1]]))).toEqual(plan(1, 1));
  });
});

describe("labels", () => {
  it("lineWords", () => {
    expect(lineWords(7, 7)).toBe("line 7");
    expect(lineWords(4, 12)).toBe("lines 4 to 12");
  });

  it("menuLabel with a name (the file menu)", () => {
    expect(menuLabel(plan(4, 12), "main.py")).toBe("Capture snippet of main.py, lines 4 to 12...");
    expect(menuLabel(plan(7, 7), "main.py")).toBe("Capture snippet of main.py, line 7...");
    expect(menuLabel({ ok: false, reason: "empty" }, "main.py")).toBe("Capture snippet of the selected lines...");
    expect(menuLabel({ ok: false, reason: "blank" }, "main.py")).toBe("Capture snippet of the selected lines...");
    expect(menuLabel({ ok: false, reason: "cap", count: 412, first: 1, last: 412 }, "main.py")).toBe("Capture snippet of main.py, lines 1 to 412...");
    expect(menuLabel(plan(4, 12), "assignment_3_final_version_2.py")).toBe(`Capture snippet of assignment_3_fin${ELL}on_2.py, lines 4 to 12...`);
  });

  it("menuLabel shows a direction character as a tag and never splits the tag", () => {
    expect(menuLabel(plan(1, 1), `a${RLO}b.py`)).toBe("Capture snippet of a[U+202E]b.py, line 1...");
    const long = `${"x".repeat(10)}${RLO}${"y".repeat(20)}.py`;
    const label = menuLabel(plan(1, 1), long);
    expect(label).not.toContain(RLO);
    // The tag is either whole or cut away whole, never split.
    expect(label.replace("[U+202E]", "")).not.toMatch(/\[U\+|U\+202E|202E\]/);
    expect(label).toContain(ELL);
  });

  it("menuLabel without a name (the code menu)", () => {
    expect(menuLabel(plan(4, 12), null)).toBe("Capture snippet of lines 4 to 12...");
    expect(menuLabel(plan(7, 7), null)).toBe("Capture snippet of line 7...");
    expect(menuLabel({ ok: false, reason: "blank" }, null)).toBe("Capture snippet of the selected lines...");
    expect(menuLabel({ ok: false, reason: "empty" }, null)).toBe("Capture snippet of the selected lines...");
    expect(menuLabel({ ok: false, reason: "cap", count: 412, first: 1, last: 412 }, null)).toBe("Capture snippet of lines 1 to 412...");
  });

  it("dialogTitle", () => {
    expect(dialogTitle(plan(4, 12))).toBe("Capture snippet of lines 4 to 12");
    expect(dialogTitle(plan(7, 7))).toBe("Capture snippet of line 7");
  });

  it("shown() tags exactly what ui/dom.ts shown() tags (this module can't import the DOM helpers)", () => {
    let text = "";
    for (let c = 0; c <= 0x3200; c++) if (c < 0xd800 || c > 0xdfff) text += String.fromCodePoint(c);
    text += [0xffa0, 0xfeff, 0xfffc, 0x1f600].map((c) => String.fromCodePoint(c)).join("");
    expect(shown(text)).toBe(domShown(text));
    expect(shown(`a${RLO}b`)).toBe("a[U+202E]b");
  });
});

describe("colorChoices", () => {
  const labels = (p: PaintInfo) => colorChoices(p).map((c) => [c.value, c.label]);
  it("own palettes name the scheme", () => {
    expect(labels({ family: "signal", scheme: "light", themeName: "CodeEditor Signal (match device)" })).toEqual([
      ["match", "Match the editor (light)"], ["light", "Light"], ["dark", "Dark"],
    ]);
    expect(labels({ family: "deep-field", scheme: "dark", themeName: "CodeEditor Deep Field Dark" })).toEqual([
      ["match", "Match the editor (dark)"], ["light", "Light"], ["dark", "Dark"],
    ]);
    expect(labels({ family: "slate", scheme: "light", themeName: "CodeEditor Slate Light" })).toEqual([
      ["match", "Match the editor (light)"], ["light", "Light"], ["dark", "Dark"],
    ]);
  });

  it("palette themes name the theme and offer Deep Field's two schemes", () => {
    expect(labels({ family: "palette", scheme: "dark", themeName: "High contrast" })).toEqual([
      ["match", "Match the editor (High contrast)"], ["light", "CodeEditor Deep Field Light"], ["dark", "CodeEditor Deep Field Dark"],
    ]);
    expect(colorChoices({ family: "palette", scheme: "light", themeName: `Mine${RLO}` })[0].label).toBe("Match the editor (Mine[U+202E])");
    expect(colorChoices({ family: "palette", scheme: "light", themeName: null })[0].label).toBe("Match the editor");
  });
});

describe("previewLabel", () => {
  const own: PaintInfo = { family: "deep-field", scheme: "light", themeName: "CodeEditor Deep Field Light" };
  const pal: PaintInfo = { family: "palette", scheme: "dark", themeName: "Dracula" };
  const phrase = {
    own: { match: "in the editor's colours", light: "in light colours", dark: "in dark colours" },
    palette: { match: "in the editor's colours", light: "in CodeEditor Deep Field Light colours", dark: "in CodeEditor Deep Field Dark colours" },
  } as const;

  it("pins five labels exactly", () => {
    expect(previewLabel(plan(4, 12), "main.py", DEFAULTS, own, false)).toBe(
      `Preview of main.py, lines 4 to 12, in the editor's colours; line numbers shown; file name shown. ${LOOK}.`,
    );
    expect(previewLabel(plan(7, 7), "main.py", { ...DEFAULTS, colors: "light", numbers: false, name: false }, pal, false)).toBe(
      `Preview of main.py, line 7, in CodeEditor Deep Field Light colours; line numbers hidden; file name hidden. ${LOOK}.`,
    );
    expect(previewLabel(plan(4, 12), "main.py", DEFAULTS, own, true)).toBe(
      `Preview of main.py, lines 4 to 12, in the editor's colours; line numbers shown; file name shown. ${LOOK}. Some colours are missing.`,
    );
    expect(previewLabel(plan(2, 9), "main.py", { ...DEFAULTS, frame: "window", background: false, highlight: [3, 5, 6, 7] }, own, false)).toBe(
      `Preview of main.py, lines 2 to 9, in the editor's colours; line numbers shown; file name shown. Window frame, no background, highlighted: line 3, lines 5 to 7, "Made with CodeEditor" at the card's foot.`,
    );
    expect(previewLabel(plan(2, 9), "main.py", { ...DEFAULTS, padding: "large", scale: 3 }, own, false)).toBe(
      `Preview of main.py, lines 2 to 9, in the editor's colours; line numbers shown; file name shown. Plain frame, large background, "Made with CodeEditor" under the card.`,
    );
    // With the line off, round 2's label exactly.
    expect(previewLabel(plan(2, 9), "main.py", { ...DEFAULTS, mark: false }, own, false)).toBe(
      "Preview of main.py, lines 2 to 9, in the editor's colours; line numbers shown; file name shown. Plain frame, medium background.",
    );
  });

  it("covers all 24 colour and toggle combinations, partial and not, string for string", () => {
    let n = 0;
    for (const [family, paint] of [["own", own], ["palette", pal]] as const) {
      for (const colors of ["match", "light", "dark"] as const) {
        for (const numbers of [true, false]) {
          for (const name of [true, false]) {
            const base = `Preview of main.py, lines 2 to 3, ${phrase[family][colors]}; line numbers ${numbers ? "shown" : "hidden"}; file name ${name ? "shown" : "hidden"}. ${LOOK}.`;
            const o: ImageOptions = { ...DEFAULTS, colors, numbers, name };
            expect(previewLabel(plan(2, 3), "main.py", o, paint, false)).toBe(base);
            expect(previewLabel(plan(2, 3), "main.py", o, paint, true)).toBe(`${base} Some colours are missing.`);
            n++;
          }
        }
      }
    }
    expect(n).toBe(24);
  });

  it("shows a direction character in the name as a tag; the no-preview names are fixed", () => {
    expect(previewLabel(plan(1, 1), `${RLO}evil.py`, DEFAULTS, own, false)).toMatch(/^Preview of \[U\+202E\]evil\.py, line 1,/);
    expect(NO_PREVIEW["too-big"]).toBe("No preview: that selection is too big for one image.");
    expect(NO_PREVIEW.failed).toBe("No preview: the image couldn't be made.");
  });
});

describe("downloadName", () => {
  it.each([
    [["src/main.py", 4, 12, { name: true }], "main-py-lines-4-12.png"],
    [["my calc.py", 1, 1, { name: true }], "my-calc-py-line-1.png"],
    [[`${RLO}evil.py`, 2, 3, { name: true }], "evil-py-lines-2-3.png"],
    [["+++", 1, 2, { name: true }], "code-lines-1-2.png"],
    [["src/main.py", 4, 12, { name: false }], "code-lines-4-12.png"],
    [["main.py", 7, 7, { name: false }], "code-line-7.png"],
  ] as [[string, number, number, { name: boolean }], string][])("%j gives %s", (args, expected) => {
    expect(downloadName(...args)).toBe(expected);
  });

  it("cuts an 80-character stem to 60", () => {
    const name = downloadName(`${"a".repeat(80)}.py`, 1, 2, { name: true });
    expect(name).toBe(`${"a".repeat(60)}-py-lines-1-2.png`);
  });
});

describe("canCopyImages", () => {
  const write = () => Promise.resolve();
  const item = (supports?: (t: string) => boolean) => {
    const C = function ClipboardItem() {} as unknown as { supports?: (t: string) => boolean };
    if (supports) C.supports = supports;
    return C;
  };
  it("needs a secure context, ClipboardItem, clipboard.write and PNG support", () => {
    expect(canCopyImages({ isSecureContext: false, ClipboardItem: item(), navigator: { clipboard: { write } } })).toBe(false);
    expect(canCopyImages({ isSecureContext: true, navigator: { clipboard: { write } } })).toBe(false);
    expect(canCopyImages({ isSecureContext: true, ClipboardItem: item(), navigator: { clipboard: {} } })).toBe(false);
    expect(canCopyImages({ isSecureContext: true, ClipboardItem: item(() => false), navigator: { clipboard: { write } } })).toBe(false);
    expect(canCopyImages({ isSecureContext: true, ClipboardItem: item(), navigator: { clipboard: { write } } })).toBe(true);
    expect(canCopyImages({ isSecureContext: true, ClipboardItem: item((t) => t === "image/png"), navigator: { clipboard: { write } } })).toBe(true);
  });
  it("a throwing supports() counts as no support", () => {
    const C = item(() => {
      throw new Error("x");
    });
    expect(canCopyImages({ isSecureContext: true, ClipboardItem: C, navigator: { clipboard: { write } } })).toBe(false);
  });
});

describe("checkColors", () => {
  const all = (v: string) => Object.fromEntries(IMAGE_TOKENS.map((t) => [t, v]));
  it("has the 20 tokens the image draws", () => {
    expect(IMAGE_TOKENS).toHaveLength(20);
    expect([...IMAGE_TOKENS].sort()).toEqual([
      "action", "bg", "border", "danger", "divider", "focus", "gutter-text", "surface", "syn-comment", "syn-function", "syn-keyword", "syn-macro",
      "syn-number", "syn-operator", "syn-punctuation", "syn-string", "syn-type", "syn-variable", "text", "text-secondary",
    ]);
  });
  it("passes #rrggbb (trimmed) and fails anything else", () => {
    expect(checkColors(all("#713882"))?.bg).toBe("#713882");
    expect(checkColors(all(" #713882 "))?.["syn-keyword"]).toBe("#713882");
    for (const bad of ["var(--x)", "#7138", "rgb(1 2 3)", "", "#88440080", "#8408"]) expect(checkColors(all(bad)), bad).toBeNull();
    // The production build's minifier writes Slate's --syn-number #884400 as #840: the same colour, spelled out.
    expect(checkColors(all("#840"))?.["syn-number"]).toBe("#884400");
    expect(checkColors({ ...all("#713882"), "syn-number": " #840 " })?.["syn-number"]).toBe("#884400");
    const oneMissing = all("#713882");
    delete oneMissing.border;
    expect(checkColors(oneMissing)).toBeNull();
  });
});

describe("image options", () => {
  const ROUND2 = { scale: 2, background: true, padding: "medium", frame: "plain", mark: true } as const;

  it("cleans stored values field by field", () => {
    expect(DEFAULT_IMAGE_OPTIONS).toEqual({ colors: "match", numbers: true, name: true, ...ROUND2 });
    expect(PADDING).toEqual({ small: 16, medium: 32, large: 64 });
    expect(cleanImageOptions({})).toEqual(DEFAULT_IMAGE_OPTIONS);
    const cleaned = cleanImageOptions({ colors: "neon", numbers: "yes", name: false, x: 1, scale: 4, background: "on", padding: "huge", frame: "mac" });
    expect(cleaned).toEqual({ colors: "match", numbers: true, name: false, ...ROUND2 });
    expect(cleaned).not.toHaveProperty("x");
    for (const odd of [null, [], "text"]) expect(cleanImageOptions(odd), JSON.stringify(odd)).toEqual(DEFAULT_IMAGE_OPTIONS);
    expect(cleanImageOptions({ colors: "dark", numbers: false })).toEqual({ colors: "dark", numbers: false, name: true, ...ROUND2 });
    // Every value of every new field survives; "2" (a string) is not a scale.
    for (const scale of [1, 2, 3] as const) expect(cleanImageOptions({ scale }).scale).toBe(scale);
    expect(cleanImageOptions({ scale: "3" }).scale).toBe(2);
    expect(cleanImageOptions({ scale: 1.5 }).scale).toBe(2);
    for (const padding of ["small", "medium", "large"] as const) expect(cleanImageOptions({ padding }).padding).toBe(padding);
    expect(cleanImageOptions({ background: false }).background).toBe(false);
    expect(cleanImageOptions({ frame: "window" }).frame).toBe("window");
    expect(cleanImageOptions({ mark: false }).mark).toBe(false);
    expect(cleanImageOptions({ mark: "off" }).mark, "only a boolean turns the line off").toBe(true);
    // The highlighted lines are this opening's, never stored or read back.
    expect(cleanImageOptions({ highlight: [3] })).not.toHaveProperty("highlight");
  });

  it("migrates a round-1 value: its three fields kept, the new ones at their defaults", () => {
    const data = new Map([[IMAGE_OPTIONS_KEY, '{"colors":"light","numbers":false,"name":false}']]);
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const read = readImageOptions(storage);
    expect(read).toEqual({ colors: "light", numbers: false, name: false, ...ROUND2 });
    writeImageOptions(storage, { ...read, frame: "window" });
    expect(JSON.parse(data.get(IMAGE_OPTIONS_KEY)!)).toEqual({ colors: "light", numbers: false, name: false, ...ROUND2, frame: "window" });
  });

  it("migrates a round-2 value (no mark field): every stored field kept, the line on", () => {
    const round2 = { colors: "dark", numbers: true, name: false, scale: 3, background: false, padding: "large", frame: "window" };
    const data = new Map([[IMAGE_OPTIONS_KEY, JSON.stringify(round2)]]);
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(readImageOptions(storage)).toEqual({ ...round2, mark: true });
    writeImageOptions(storage, { ...readImageOptions(storage), mark: false });
    expect(readImageOptions(storage).mark).toBe(false);
  });

  it("reads and writes through storage that may throw or hold junk", () => {
    expect(IMAGE_OPTIONS_KEY).toBe("codeeditor:snippet-image");
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const light = { ...DEFAULT_IMAGE_OPTIONS, colors: "light", numbers: false, name: false, scale: 3, background: false, padding: "small", frame: "window" } as const;
    writeImageOptions(storage, { ...light, highlight: [2] } as typeof light);
    expect(JSON.parse(data.get(IMAGE_OPTIONS_KEY)!)).toEqual(light);
    expect(readImageOptions(storage)).toEqual(light);
    data.set(IMAGE_OPTIONS_KEY, "{not json");
    expect(readImageOptions(storage)).toEqual(DEFAULT_IMAGE_OPTIONS);
    // Stored JSON is cleaned on the way in, never used as it is.
    data.set(IMAGE_OPTIONS_KEY, JSON.stringify({ colors: "neon", numbers: "yes", name: false, x: 1 }));
    expect(readImageOptions(storage)).toEqual({ colors: "match", numbers: true, name: false, ...ROUND2 });
    data.set(IMAGE_OPTIONS_KEY, "[1, 2]");
    expect(readImageOptions(storage)).toEqual(DEFAULT_IMAGE_OPTIONS);
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readImageOptions(throwing)).toEqual(DEFAULT_IMAGE_OPTIONS);
    expect(() => writeImageOptions(throwing, DEFAULT_IMAGE_OPTIONS)).not.toThrow();
    expect(readImageOptions(null)).toEqual(DEFAULT_IMAGE_OPTIONS);
    expect(() => writeImageOptions(null, DEFAULT_IMAGE_OPTIONS)).not.toThrow();
  });

  it("names the image in data-preview-options and compares every field and the highlighted lines", () => {
    expect(optionsWord(DEFAULTS)).toBe("match numbers name 2x medium plain");
    expect(optionsWord({ ...DEFAULTS, colors: "dark", numbers: false, name: false, scale: 3, background: false, frame: "window" })).toBe(
      "dark no-numbers no-name 3x none window",
    );
    expect(optionsWord({ ...DEFAULTS, padding: "small", highlight: [3, 5, 6, 7] })).toBe("match numbers name 2x small plain hl:3,5-7");
    expect(optionsWord({ ...DEFAULTS, mark: false, highlight: [2] })).toBe("match numbers name 2x medium plain no-mark hl:2");
    expect(sameOptions(DEFAULTS, { ...DEFAULTS })).toBe(true);
    for (const change of [{ scale: 1 }, { background: false }, { padding: "large" }, { frame: "window" }, { highlight: [2] }, { colors: "dark" }, { mark: false }] as const) {
      expect(sameOptions(DEFAULTS, { ...DEFAULTS, ...change } as ImageOptions), JSON.stringify(change)).toBe(false);
    }
    expect(sameOptions({ ...DEFAULTS, highlight: [2, 3] }, { ...DEFAULTS, highlight: [2, 4] })).toBe(false);
    expect(sameOptions({ ...DEFAULTS, highlight: [2, 3] }, { ...DEFAULTS, highlight: [2, 3] })).toBe(true);
  });
});

describe("highlighted lines (round 2)", () => {
  const span = plan(2, 9);
  const ok = (text: string, p: LineSpan = span) => {
    const r = parseHighlight(text, p);
    if (!r.ok) throw new Error(r.message);
    return r.lines;
  };
  const refused = (text: string, p: LineSpan = span) => {
    const r = parseHighlight(text, p);
    if (r.ok) throw new Error(`accepted ${JSON.stringify(r.lines)}`);
    return r.message;
  };

  it("reads numbers and ranges, leniently, sorted and without repeats", () => {
    expect(ok("")).toEqual([]);
    expect(ok("   ")).toEqual([]);
    expect(ok("3")).toEqual([3]);
    expect(ok("3-5, 8")).toEqual([3, 4, 5, 8]);
    expect(ok("8 3 - 5")).toEqual([3, 4, 5, 8]);
    expect(ok("5-3")).toEqual([3, 4, 5]);
    expect(ok("3,,3, 3-4")).toEqual([3, 4]);
    expect(ok("02-03")).toEqual([2, 3]);
    expect(ok("2-9")).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("refuses what isn't inside the captured lines, saying what the image shows", () => {
    expect(refused("10")).toBe("Line 10 isn't in the image: it shows lines 2 to 9.");
    expect(refused("1")).toBe("Line 1 isn't in the image: it shows lines 2 to 9.");
    expect(refused("0")).toBe("Line 0 isn't in the image: it shows lines 2 to 9.");
    expect(refused("1-4")).toBe("Lines 1 to 4 aren't all in the image: it shows lines 2 to 9.");
    expect(refused("9-12")).toBe("Lines 9 to 12 aren't all in the image: it shows lines 2 to 9.");
    expect(refused("8", plan(7, 7))).toBe("Line 8 isn't in the image: it shows line 7.");
    // The first problem is the one said.
    expect(refused("3, 40, x")).toBe("Line 40 isn't in the image: it shows lines 2 to 9.");
  });

  it("refuses anything else with an example that works here", () => {
    expect(refused("x")).toBe('"x" isn\'t a line number or a range such as 2-4.');
    expect(refused("3-")).toBe('"3-" isn\'t a line number or a range such as 2-4.');
    expect(refused("3-5-7")).toBe('"3-5-7" isn\'t a line number or a range such as 2-4.');
    expect(refused("3.5")).toBe('"3.5" isn\'t a line number or a range such as 2-4.');
    expect(refused("-3")).toBe('"-3" isn\'t a line number or a range such as 2-4.');
    expect(refused("12345678")).toBe('"12345678" isn\'t a line number or a range such as 2-4.');
    expect(refused("x", plan(7, 7))).toBe('"x" isn\'t a line number or a range such as 7.');
    // The student's text is quoted short and with its invisible characters tagged.
    expect(refused(`${"a".repeat(30)}`)).toBe(`"${"a".repeat(16)}..." isn't a line number or a range such as 2-4.`);
    expect(refused(`3${RLO}`)).toBe('"3[U+202E]" isn\'t a line number or a range such as 2-4.');
  });

  it("gives an example and a hint from the captured lines", () => {
    expect(highlightExample(plan(2, 3))).toBe("2-3");
    expect(highlightExample(plan(2, 9))).toBe("2-4");
    expect(highlightExample(plan(7, 7))).toBe("7");
    expect(highlightHint(plan(2, 3))).toBe("Numbers or ranges from 2 to 3, separated by commas, such as 2-3.");
    expect(highlightHint(plan(7, 7))).toBe("Type 7 to highlight line 7.");
    expect(rangesOf([])).toEqual([]);
    expect(rangesOf([1, 2, 3, 5, 7, 8])).toEqual(["1-3", "5", "7-8"]);
  });

  it("the size line says the PNG's size, and the step when the chosen scale can't fit", () => {
    expect(sizeLine(822, 357, 2, 2)).toBe("822 x 357 pixels.");
    expect(sizeLine(1466, 6855, 3, 1.5)).toBe("1466 x 6855 pixels. 3x is too big for this image, so it is 1.5x.");
  });
});

describe("captureMessage (final-v3 section 6.2, string for string)", () => {
  const open = (m: CaptureMessage, entry: Entry = "menu", coarse = false) => captureMessage(m, { coarse, entry, open: true });
  const closed = (m: CaptureMessage) => captureMessage(m, { coarse: false, entry: "menu", open: false });

  it("refusals before the dialog opens, per entry and pointer", () => {
    expect(open({ kind: "refused", reason: "no-file" })).toEqual({ text: "Open a file and select some code first.", tone: "info" });
    expect(open({ kind: "refused", reason: "empty" }, "menu")).toEqual({ text: "Select the lines first, then right-click them or press Shift+F10.", tone: "info" });
    expect(open({ kind: "refused", reason: "empty" }, "head-pointer")).toEqual({ text: "Select the lines first.", tone: "info" });
    expect(open({ kind: "refused", reason: "empty" }, "head-key")).toEqual({ text: "Select the lines in the code, then press Shift+F10 there.", tone: "info" });
    for (const entry of ["menu", "head-pointer", "head-key", "context"] as const) {
      expect(open({ kind: "refused", reason: "empty" }, entry, true)).toEqual({ text: "Select the lines to capture first.", tone: "info" });
    }
    for (const entry of ["menu", "head-pointer", "head-key", "context"] as const) {
      expect(open({ kind: "refused", reason: "blank" }, entry)).toEqual({ text: "The selected lines are blank. Select some code first.", tone: "info" });
      expect(open({ kind: "refused", reason: "cap", count: 412 }, entry)).toEqual({ text: "That's 412 lines. An image can show up to 300, so select fewer lines.", tone: "info" });
    }
    expect(open({ kind: "chunk-failed", detail: "Failed to fetch" })).toEqual({ text: "The image tool couldn't open: Failed to fetch.", tone: "error" });
  });

  it("the dialog's own states", () => {
    expect(open({ kind: "making-preview" })).toEqual({ text: "Making the preview...", tone: "info" });
    expect(open({ kind: "updating-preview" })).toEqual({ text: "Updating the preview...", tone: "info" });
    expect(open({ kind: "refused", reason: "too-big" })).toEqual({ text: "That selection is too big for one image. Close this and select fewer or shorter lines.", tone: "info" });
    expect(open({ kind: "preview-failed" })).toEqual({ text: "Couldn't make the image. Close this and try again.", tone: "error" });
    expect(open({ kind: "failed", reason: "device" })).toEqual({ text: "Couldn't make an image this big on this device. Close this and select fewer lines.", tone: "error" });
    expect(open({ kind: "partial" })).toEqual({ text: "Some colours are missing: the file was still being read.", tone: "info" });
    expect(open({ kind: "gaps" })).toEqual({ text: "The image includes the lines between your selections.", tone: "info" });
    expect(open({ kind: "making-png" })).toEqual({ text: "Making the PNG...", tone: "info" });
    expect(open({ kind: "copied", what: "main.py, lines 4 to 12" })).toEqual({ text: "Copied the image.", tone: "success" });
    expect(open({ kind: "downloaded", file: "main-py-lines-4-12.png" })).toEqual({ text: "Downloading main-py-lines-4-12.png.", tone: "success" });
    expect(open({ kind: "denied" })).toEqual({ text: "Couldn't copy the image. Use Download instead.", tone: "error" });
    expect(open({ kind: "failed", reason: "privacy" })).toEqual({
      text: "This browser's privacy settings blocked the image. If the address bar offers to allow it, allow it and try again.", tone: "error",
    });
    expect(open({ kind: "failed", reason: "updating", action: "copy" })).toEqual({ text: "The preview was still updating. Press Copy again.", tone: "info" });
    expect(open({ kind: "failed", reason: "updating", action: "download" })).toEqual({ text: "The preview was still updating. Press Download again.", tone: "info" });
    expect(open({ kind: "failed", reason: "other" })).toEqual({ text: "Couldn't make the image. Try again.", tone: "error" });
  });

  it("an export that settles after the dialog closed", () => {
    expect(closed({ kind: "copied", what: "main.py, lines 4 to 12" })).toEqual({ text: "Copied an image of main.py, lines 4 to 12.", tone: "success" });
    expect(closed({ kind: "downloaded", file: "main-py-lines-4-12.png" })).toEqual({ text: "Downloading main-py-lines-4-12.png.", tone: "success" });
    expect(closed({ kind: "denied" })).toEqual({ text: "Couldn't copy the image.", tone: "error" });
    expect(closed({ kind: "failed", reason: "device" })).toEqual({ text: "Couldn't make an image this big on this device. Select fewer lines.", tone: "error" });
    expect(closed({ kind: "failed", reason: "privacy" }).text).toBe(open({ kind: "failed", reason: "privacy" }).text);
    expect(closed({ kind: "failed", reason: "other" })).toEqual({ text: "Couldn't make the image. Try again.", tone: "error" });
    expect(closed({ kind: "failed", reason: "updating", action: "copy" })).toEqual({ text: "The preview was still updating, so nothing was copied. Try again.", tone: "info" });
    expect(closed({ kind: "failed", reason: "updating", action: "download" })).toEqual({ text: "The preview was still updating, so nothing was downloaded. Try again.", tone: "info" });
    for (const m of [{ kind: "failed", reason: "device" }, { kind: "preview-failed" }, { kind: "refused", reason: "too-big" }] as CaptureMessage[]) {
      expect(closed(m).text, JSON.stringify(m)).not.toContain("Close this");
    }
  });

  it("the shell's refusalMessage (first visit) gives the same texts as the dialog's captureMessage", () => {
    const shell = [
      { kind: "refused", reason: "no-file" }, { kind: "refused", reason: "empty" }, { kind: "refused", reason: "blank" },
      { kind: "refused", reason: "cap", count: 412 }, { kind: "refused", reason: "too-big" }, { kind: "chunk-failed", detail: "Failed to fetch." },
    ] as const;
    for (const m of shell) {
      for (const at of [{ coarse: false, entry: "menu", open: false }, { coarse: true, entry: "head-key", open: true }, { coarse: false, entry: "head-pointer", open: false }] as const) {
        expect(refusalMessage(m, at), JSON.stringify([m, at])).toEqual(captureMessage(m, at));
      }
    }
  });
});

describe("fitName (unit width 1)", () => {
  const units = (s: string) => labelUnits(s);
  const fit = (s: string, max: number) => fitName(units(s), () => 1, max);
  it.each([
    ["abcdefghijklmnop_v2.py", 14, `abcdef${ELL}p_v2.py`],
    ["Makefile", 6, `M${ELL}file`],
    [".bashrc", 6, `.${ELL}shrc`],
    [".bashrc", 4, `.${ELL}rc`],
    ["assignment_3_final_version_2.py", 24, `assignment_3_fin${ELL}on_2.py`],
    ["main.py", 24, "main.py"],
  ] as [string, number, string][])("%s at %d", (name, max, expected) => {
    expect(fit(name, max)).toBe(expected);
  });

  it("never splits a placeholder unit", () => {
    const u = ["a", "b", "c", "[U+202E]", "d", "e", "f", "g", "h", ".", "p", "y"];
    for (let max = 3; max <= u.length; max++) {
      const out = fitName(u, () => 1, max);
      expect(out.replace("[U+202E]", ""), `max ${max}`).not.toMatch(/\[|\]|U\+/);
    }
  });

  it("measures with the given widths", () => {
    // Wide units: "W" is 3, the ellipsis 1, the rest 1. The start shrinks to one unit (11 wide),
    // then the stem's tail gives up a unit: W, the ellipsis, "bcd.py" is 10.
    const w = (s: string) => (s === "W" ? 3 : 1);
    expect(fitName(units("WWWWabcd.py"), w, 10)).toBe(`W${ELL}bcd.py`);
  });

  it("labelUnits keeps a [U+XXXX] tag as one unit", () => {
    expect(labelUnits("a[U+202E]b")).toEqual(["a", "[U+202E]", "b"]);
    expect(labelUnits("ab")).toEqual(["a", "b"]);
  });
});
