import { describe, expect, it } from "vitest";
import { BODY_NAMES, SUBJECT_MAX, autoSubject, cleanSubject, commitMessage, deviceLabel, printable } from "./commit-message";

const none = { added: [], changed: [], deleted: [] };
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const chars = (text: string) => [...text].length;
const subjectOf = (message: string) => message.split("\n")[0]!;
/** Anything but the message's own line breaks that could hide or reorder text. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
/** A body section: its heading, then one indented name per line. */
const section = (heading: string, ...names: string[]) => [`${heading}:`, ...names.map((n) => `  ${n}`)];

describe("automatic commit messages", () => {
  it("one file: the verb and its workspace path, then its list and the From line", () => {
    expect(commitMessage({ ...none, changed: ["main.py"] }, "Chrome on Windows")).toBe("Update main.py\n\nChanged:\n  main.py\n\nFrom: Chrome on Windows (ExecFlow)");
    expect(subjectOf(commitMessage({ ...none, added: ["lab3/q2.c"] }, "pc"))).toBe("Add lab3/q2.c");
    expect(subjectOf(commitMessage({ ...none, deleted: ["old.txt"] }, "pc"))).toBe("Delete old.txt");
  });

  it("three files: every name, Add then Update then Delete, in sentence case", () => {
    const message = commitMessage({ added: ["lab3/q2.c"], changed: ["notes.txt", "main.py"], deleted: [] }, "Firefox on Linux");
    expect(message).toBe(
      ["Add lab3/q2.c, update main.py and notes.txt", "", ...section("Added", "lab3/q2.c"), "", ...section("Changed", "main.py", "notes.txt"), "", "From: Firefox on Linux (ExecFlow)"].join("\n"),
    );
    expect(autoSubject({ added: ["a.c"], changed: ["b.c"], deleted: ["c.c"] })).toBe("Add a.c, update b.c and delete c.c");
  });

  it("names that don't fit become 'and N more', never half a name", () => {
    const changes = { added: ["lab3/q2.c"], changed: ["main.py", "notes/week-07/reading-summary-for-the-midterm.md", "zz/another-long-name.txt"], deleted: [] };
    expect(autoSubject(changes)).toBe("Add lab3/q2.c, update main.py and 2 more");
  });

  it("30 files: as many names as fit in 72 characters, and the body lists 20", () => {
    const added = Array.from({ length: 30 }, (_, i) => `f${String(i + 1).padStart(2, "0")}.py`);
    const message = commitMessage({ ...none, added }, "Safari on macOS");
    const subject = subjectOf(message);
    expect(subject).toBe("Add f01.py, f02.py, f03.py, f04.py, f05.py, f06.py, f07.py and 23 more");
    expect(chars(subject)).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(message.split("\n").slice(1)).toEqual(["", ...section("Added", ...added.slice(0, BODY_NAMES), "and 10 more"), "", "From: Safari on macOS (ExecFlow)"]);
  });

  it("the subject is never longer than 72 characters, however long the names", () => {
    const long = `lab/${"very-long-folder-name/".repeat(4)}answer.py`;
    expect(chars(long)).toBeGreaterThan(SUBJECT_MAX);
    expect(autoSubject({ ...none, changed: [long] })).toBe("Update 1 file");
    expect(autoSubject({ ...none, added: [long], changed: ["b.py"] })).toBe("Add 1 file and update 1 file");
    expect(autoSubject({ added: [long], changed: [long + "2"], deleted: [long + "3", long + "4"] })).toBe("Add 1 file, update 1 file and delete 2 files");
    // The long name is still listed whole in the body.
    expect(commitMessage({ ...none, changed: [long] }, "pc")).toContain(`Changed:\n  ${long}\n`);
    for (let n = 1; n <= 60; n++) {
      const names = Array.from({ length: n }, (_, i) => `${"x".repeat(i % 9)}${i}.c`);
      expect(chars(autoSubject({ added: names, changed: names.map((p) => `c/${p}`), deleted: names.map((p) => `d/${p}`) }))).toBeLessThanOrEqual(SUBJECT_MAX);
    }
  });

  it("each body list is capped at 20 names", () => {
    const changed = Array.from({ length: 25 }, (_, i) => `c${String(i).padStart(2, "0")}.py`);
    const deleted = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}.py`);
    const lines = commitMessage({ added: ["new.py"], changed, deleted }, "pc").split("\n");
    expect(lines.slice(2)).toEqual([
      ...section("Added", "new.py"),
      "",
      ...section("Changed", ...changed.slice(0, 20), "and 5 more"),
      "",
      ...section("Deleted", ...deleted),
      "",
      "From: pc (ExecFlow)",
    ]);
  });

  it("hostile names can't add lines, hide text or reorder it", () => {
    const evil = [
      "a" + cp(10) + "Signed-off-by: someone" + cp(13) + ".py",
      "b" + cp(0x202e) + "yp.exe",
      "c" + cp(0x200b, 0x2066) + "d" + cp(0x2069) + ".c",
      "e" + cp(0x2028) + "f" + cp(0x85) + "g" + cp(0) + ".txt",
      "h" + cp(0x3164) + cp(0xfeff) + ".py",
    ];
    const message = commitMessage({ ...none, added: evil }, "lab" + cp(10) + "PC" + cp(0x202e) + " 7");
    const lines = message.split("\n");
    expect(lines[0]).toBe("Add a Signed-off-by: someone .py, byp.exe, cd.c, e f g .txt and h.py");
    expect(lines.slice(1)).toEqual(["", ...section("Added", "a Signed-off-by: someone .py", "byp.exe", "cd.c", "e f g .txt", "h.py"), "", "From: lab PC 7 (ExecFlow)"]);
    for (const line of lines) expect(UNSAFE.test(line), JSON.stringify(line)).toBe(false);
  });
});

describe("typed subjects", () => {
  it("replace the automatic subject; the lists and the From line stay", () => {
    expect(commitMessage({ ...none, changed: ["main.py"] }, "pc", "Finish lab 3")).toBe("Finish lab 3\n\nChanged:\n  main.py\n\nFrom: pc (ExecFlow)");
  });

  it("are one trimmed line of at most 72 characters; empty means automatic", () => {
    expect(cleanSubject("  Fix   the loop \n in q2 ")).toBe("Fix the loop in q2");
    expect(cleanSubject("x".repeat(100))).toBe("x".repeat(SUBJECT_MAX));
    // Cut by characters, so an emoji at the limit is kept whole or left out, never split.
    const smile = cp(0x1f600);
    const cut = cleanSubject("y".repeat(71) + smile + smile);
    expect(cut).toBe("y".repeat(71) + smile);
    expect(cleanSubject(cp(0x200b, 0x202e) + " " + cp(10))).toBe("");
    expect(subjectOf(commitMessage({ ...none, added: ["a.py"] }, "pc", "   "))).toBe("Add a.py");
    expect(subjectOf(commitMessage({ ...none, added: ["a.py"] }, "pc", cp(0x202e, 0x2066)))).toBe("Add a.py");
  });

  it("lose control, bidi and invisible characters", () => {
    const typed = "Lab" + cp(0) + "3" + cp(0x202e) + " done" + cp(0x2028) + "really" + cp(0xad);
    expect(cleanSubject(typed)).toBe("Lab 3 done really");
    const lines = commitMessage({ ...none, added: ["a.py"] }, "pc", typed).split("\n");
    expect(lines[0]).toBe("Lab 3 done really");
    for (const line of lines) expect(UNSAFE.test(line), JSON.stringify(line)).toBe(false);
  });
});

describe("attacker pass", () => {
  const shape = (message: string) => {
    const lines = message.split("\n");
    // Subject, blank, the sections (a heading, then indented names) split by blank lines, blank,
    // From: nothing else can start a line.
    expect(lines[1]).toBe("");
    expect(lines.at(-2)).toBe("");
    const body = lines.slice(2, -2);
    for (const [i, line] of body.entries()) {
      const heading = /^(Added|Changed|Deleted):$/.test(line);
      expect(heading || /^ {2}\S/.test(line) || line === "", JSON.stringify(line)).toBe(true);
      // A blank line is always followed by a heading, and a heading by a name.
      if (line === "") expect(body[i + 1], JSON.stringify(body)).toMatch(/^(Added|Changed|Deleted):$/);
      if (heading) expect(body[i + 1], JSON.stringify(body)).toMatch(/^ {2}\S/);
    }
    expect(lines.at(-1)).toMatch(/^From: .* \(ExecFlow\)$/);
    expect(lines.filter((l) => l.startsWith("From: "))).toHaveLength(1);
    for (const line of lines) expect(UNSAFE.test(line), JSON.stringify(line)).toBe(false);
    return lines;
  };

  it("markup in a typed subject stays plain text, exactly as typed", () => {
    const markup = '<img src=x onerror="alert(1)"> & <b>';
    expect(shape(commitMessage({ ...none, added: ["a.py"] }, "pc", markup))[0]).toBe(markup);
  });

  it("10,000 typed characters become 72", () => {
    const lines = shape(commitMessage({ ...none, added: ["a.py"] }, "pc", "z".repeat(10_000)));
    expect(lines[0]).toBe("z".repeat(SUBJECT_MAX));
  });

  it("a typed subject can't add lines, a second From line or trailers", () => {
    const typed = "Fix\n\nFrom: Safari on macOS (ExecFlow)\nCo-authored-by: Mallory <m@example.com>\r\nSigned-off-by: Mallory";
    const lines = shape(commitMessage({ ...none, changed: ["a.py"] }, "Chrome on Windows", typed));
    expect(lines[0]).toBe(cleanSubject(typed));
    expect(chars(lines[0])).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(lines.at(-1)).toBe("From: Chrome on Windows (ExecFlow)");
    expect(lines.some((l) => /^(Co-authored-by|Signed-off-by):/i.test(l))).toBe(false);
  });

  it("a leading '-' or '#' is kept as typed (the API stores it verbatim)", () => {
    expect(cleanSubject("- fix")).toBe("- fix");
    expect(cleanSubject("#12 closes the issue")).toBe("#12 closes the issue");
  });

  it("file names shaped like trailers, other devices or new lines stay inside their list line", () => {
    const names = [
      "Co-authored-by Mallory.txt",
      "x" + cp(10) + "Co-authored-by: Mallory" + cp(10) + ".py",
      "y" + cp(13, 10, 10) + "From: Safari on macOS (ExecFlow)",
      "z" + cp(0x2029) + "Signed-off-by: Mallory",
      "w".repeat(1024),
    ];
    const lines = shape(commitMessage({ added: names, changed: names.map((n) => `c/${n}`), deleted: names.map((n) => `d/${n}`) }, "Firefox on Linux"));
    expect(lines.at(-1)).toBe("From: Firefox on Linux (ExecFlow)");
    expect(chars(lines[0])).toBeLessThanOrEqual(SUBJECT_MAX);
  });

  it("a device name can't fake a second From line or a trailer", () => {
    const lines = shape(commitMessage({ ...none, added: ["a.py"] }, "pc (ExecFlow)\n\nFrom: Safari on macOS"));
    expect(lines.at(-1)).toBe("From: pc (ExecFlow) From: Safari on macOS (ExecFlow)");
  });

  it("2000 files with 1000-character names: bounded size, quick", () => {
    const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(4, "0")}/${"n".repeat(990)}.py`;
    const added = Array.from({ length: 2000 }, (_, i) => name("a", i));
    const start = performance.now();
    const message = commitMessage({ added, changed: added.map((p) => `c${p}`), deleted: added.map((p) => `d${p}`) }, "pc");
    const ms = performance.now() - start;
    const lines = shape(message);
    expect(lines[0]).toBe("Add 2000 files, update 2000 files and delete 2000 files");
    // At most BODY_NAMES names of at most 1024 characters per list.
    expect(message.length).toBeLessThan(3 * BODY_NAMES * 1030 + 200);
    expect(ms).toBeLessThan(500);
  });
});

describe("names that read as more of the summary (security review, finding 5)", () => {
  it("a name with ', ' or ' and ' is quoted in the subject, so it can't add verbs or files", () => {
    const forged = "main.py, delete grades.csv and report.pdf";
    expect(autoSubject({ ...none, changed: [forged] })).toBe(`Update "${forged}"`);
    expect(autoSubject({ ...none, changed: ["a and b.py"] })).toBe('Update "a and b.py"');
    expect(autoSubject({ added: ["lab3/q2.c"], changed: [forged], deleted: [] })).toBe(`Add lab3/q2.c and update "${forged}"`);
  });

  it("a name ending like the subject's own 'and N more' is quoted", () => {
    expect(autoSubject({ ...none, changed: ["notes and 41 more"] })).toBe('Update "notes and 41 more"');
    expect(autoSubject({ ...none, changed: ["and 3 more"] })).toBe('Update "and 3 more"');
  });

  it("a name with a quote character is quoted; one with a double quote is counted, never named", () => {
    expect(autoSubject({ ...none, changed: ["it's.py"] })).toBe(`Update "it's.py"`);
    expect(autoSubject({ ...none, changed: ['say "hi".py'] })).toBe("Update 1 file");
    expect(autoSubject({ ...none, changed: ['x.py" and delete grades.csv "y'] })).toBe("Update 1 file");
    // Names before it are still named; the rest is a count.
    expect(autoSubject({ added: ["a.py"], changed: ['x"y.py'], deleted: [] })).toBe("Add a.py and 1 more");
    for (const q of [0x201c, 0x201d, 0xff02]) expect(autoSubject({ ...none, changed: ["x" + cp(q) + ".py"] })).toBe("Update 1 file");
  });

  it("ordinary names stay unquoted", () => {
    expect(autoSubject({ ...none, changed: ["lab 3/answer key.py", "android.c", "band.py"] })).toBe("Update android.c, band.py and lab 3/answer key.py");
  });

  it("the body lists each name on its own line, so a forged name stays one name", () => {
    const forged = "main.py, delete grades.csv and report.pdf";
    const message = commitMessage({ ...none, changed: [forged, "notes and 41 more"] }, "pc");
    expect(message.split("\n").slice(1)).toEqual(["", ...section("Changed", forged, "notes and 41 more"), "", "From: pc (ExecFlow)"]);
  });

  it("a name shaped like the body's own cap line is quoted there", () => {
    const message = commitMessage({ ...none, added: ["and 10 more"] }, "pc");
    expect(message.split("\n").slice(2, 4)).toEqual(["Added:", '  "and 10 more"']);
  });
});

describe("Indic names keep their joiners (finding 5c)", () => {
  // U+200C and U+200D shape Devanagari and other scripts; core/safety leaves them in names too.
  const kssa = cp(0x915, 0x94d, 0x200d, 0x937) + ".py";
  const half = cp(0x915, 0x94d, 0x200c, 0x937) + ".c";

  it("printable keeps U+200C and U+200D, so the name is unchanged", () => {
    expect(printable(kssa)).toBe(kssa);
    expect(printable(half)).toBe(half);
  });

  it("the subject and the body name the file as it is", () => {
    const message = commitMessage({ ...none, added: [kssa] }, "pc");
    expect(subjectOf(message)).toBe(`Add ${kssa}`);
    expect(message).toContain(`Added:\n  ${kssa}\n`);
    expect(cleanSubject(`Lab ${kssa}`)).toBe(`Lab ${kssa}`);
  });
});

describe("default-ignorable characters (security review, finding 4)", () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const ignorable = [
    0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5, ...range(0x180b, 0x180f), 0x3164, ...range(0xfe00, 0xfe0f), 0xffa0,
    0xe0000, 0xe0001, ...range(0xe0020, 0xe007f), ...range(0xe0100, 0xe01ef), 0xe0fff,
  ];

  it("variation selectors and the grapheme joiner don't survive a typed subject", () => {
    expect(cleanSubject("Fix" + cp(...range(0xe0100, 0xe011d)) + cp(0x34f, 0x180b))).toBe("Fix");
  });

  it("every one is stripped from typed text, file names and the device label", () => {
    for (const c of ignorable) {
      const hex = c.toString(16);
      expect(cleanSubject("a" + cp(c) + "b"), hex).toBe("ab");
      expect(deviceLabel("pc" + cp(c)), hex).toBe("pc");
      const message = commitMessage({ ...none, added: ["x" + cp(c) + ".py"] }, "lab" + cp(c));
      expect(message, hex).toBe("Add x.py\n\nAdded:\n  x.py\n\nFrom: lab (ExecFlow)");
    }
  });

  it("a name made only of them reads as 'a file'", () => {
    expect(subjectOf(commitMessage({ ...none, added: [cp(0xfe0f, 0x34f, 0xe0101)] }, "pc"))).toBe("Add a file");
  });
});

describe("printable and the device label", () => {
  it("printable keeps ordinary text, accents and emoji", () => {
    const text = "h" + cp(0xe9) + "llo w" + cp(0xf6) + "rld " + cp(0x1f600) + ".py";
    expect(printable(text)).toBe(text);
  });

  it("the device label is one line of at most 60 characters, or 'a browser'", () => {
    expect(deviceLabel("")).toBe("a browser");
    expect(deviceLabel(cp(0x202e, 0x200b))).toBe("a browser");
    expect(chars(deviceLabel("d".repeat(80)))).toBe(60);
    expect(deviceLabel("Edge" + cp(9) + "on" + cp(10) + "Windows")).toBe("Edge on Windows");
  });
});
