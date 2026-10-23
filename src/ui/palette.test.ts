import { describe, expect, it, vi } from "vitest";
import { EXAMPLES, freeName } from "./examples";
import { buildCommands, FILES_IDLE, matchFile, matchText, results, type PaletteApi, type PaletteCommand } from "./palette-model";
import { keyParts, shortcutGroups, shortcutKeys } from "./shortcuts";
import { DEFAULT_SETTINGS } from "./settings";

function api(over: Partial<Omit<PaletteApi, "act">> & { act?: Partial<PaletteApi["act"]> } = {}): PaletteApi {
  let settings = { ...DEFAULT_SETTINGS };
  const act = new Proxy({} as PaletteApi["act"], { get: (_t, name: string) => over.act?.[name as keyof PaletteApi["act"]] ?? vi.fn() });
  return {
    mac: false,
    fileOpen: () => true,
    running: () => false,
    python: () => true,
    connected: () => false,
    canWrite: () => true,
    explainReadOnly: () => false,
    files: () => [],
    openPaths: () => [],
    activePath: () => null,
    view: () => null,
    settings: { get: () => ({ ...settings }), update: (p) => (settings = { ...settings, ...p }) },
    notice: { show: vi.fn() },
    widthItems: () => [],
    ...over,
    act,
  };
}

const ids = (list: readonly PaletteCommand[]) => list.map((c) => c.id);
/** Where a command was asked for from (unit tests run without a DOM). */
const OPENER = {} as HTMLElement;
/** Cut, Copy and Select all show the code menu's own keycaps (code-menu.ts): keys every text field has, not Shortcuts rows. */
const TEXT_FIELD_KEYS = new Set(["cut", "copy", "select-all"]);

describe("matchText", () => {
  it("ranks a start of the label, then a word start, then a substring, then initials", () => {
    expect(matchText("Run the open file", "run")!.score).toBe(420);
    expect(matchText("Run the open file", "ru")!.score).toBe(400);
    expect(matchText("Close the open file", "open")).toEqual({ score: 320, hits: [{ start: 10, end: 14 }] });
    expect(matchText("Close the open file", "ope")!.score).toBe(300);
    expect(matchText("Comment or uncomment the line", "omment")!.score).toBe(200);
    expect(matchText("New from example...", "nfe")).toEqual({ score: 100, hits: [{ start: 0, end: 1 }, { start: 4, end: 5 }, { start: 9, end: 10 }] });
  });

  it("matches every typed word anywhere, in any order, and ignores case and extra spaces", () => {
    expect(matchText("Close the open file", "  FILE   close ")!.hits).toEqual([{ start: 0, end: 5 }, { start: 15, end: 19 }]);
    expect(matchText("Close the open file", "file save")).toBeNull();
  });

  it("matches the extra words without drawing them, and nothing typed matches everything", () => {
    expect(matchText("Change the colour theme...", "color", "color dark light")).toEqual({ score: 50, hits: [] });
    expect(matchText("Change the colour theme...", "color")).toBeNull();
    expect(matchText("Anything", "")).toEqual({ score: 0, hits: [] });
    expect(matchText("Anything", "x")).toBeNull();
    // One letter is never read as initials.
    expect(matchText("New file", "f")!.score).toBe(300);
    // A whole word ranks above the start of a longer word.
    expect(matchText("Go to a line", "line")!.score).toBeGreaterThan(matchText("Capture snippet of the selected lines...", "line")!.score);
  });

  it("files: the name counts before the folders, and hits are drawn on the name only", () => {
    expect(matchFile("labs/week1/main.py", "main")).toEqual({ score: 430, hits: [{ start: 0, end: 4 }] });
    expect(matchFile("labs/week1/main.py", "week")).toEqual({ score: 290, hits: [] });
    expect(matchFile("labs/week1/main.py", "zzz")).toBeNull();
  });
});

describe("the commands", () => {
  it("Save as PDF... is there with or without a file open, found by print and pdf, and hands its opener on", () => {
    const savePdf = vi.fn();
    for (const fileOpen of [true, false]) {
      const list = buildCommands(api({ fileOpen: () => fileOpen, act: { savePdf } }));
      const command = list.find((c) => c.id === "save-pdf")!;
      expect(command, `file open: ${fileOpen}`).toMatchObject({ label: "Save as PDF...", group: "Files" });
      command.run(OPENER);
    }
    expect(savePdf).toHaveBeenCalledTimes(2);
    expect(savePdf).toHaveBeenCalledWith(OPENER);
    const commands = buildCommands(api());
    for (const query of ["pdf", "print", "save as"]) {
      const first = results(`>${query}`, [], [], null, commands).groups[0].options[0];
      expect(first.kind === "command" && first.command.id, query).toBe("save-pdf");
    }
  });

  it("lists editor commands only with a file shown, and Stop instead of Run while a program runs", () => {
    const none = ids(buildCommands(api({ fileOpen: () => false })));
    expect(none).not.toContain("gotoLine");
    expect(none).not.toContain("capture");
    expect(none).toContain("run");
    expect(none).toContain("examples");
    const file = ids(buildCommands(api()));
    for (const id of ["gotoLine", "find", "replace", "selectNext", "selectAllMatches", "addCursorAbove", "fold", "unfoldAll", "comment", "cut", "copy", "select-all", "capture"]) {
      expect(file, id).toContain(id);
    }
    const running = ids(buildCommands(api({ running: () => true })));
    expect(running).toContain("stop");
    expect(running).not.toContain("run");
    expect(running).not.toContain("restart-python");
  });

  it("offers Connect or Sync now by the connection, and the settings toggles name what they will do", () => {
    expect(ids(buildCommands(api()))).toContain("connect");
    expect(ids(buildCommands(api({ connected: () => true })))).toEqual(expect.arrayContaining(["sync", "auto-sync"]));
    const a = api();
    const wrap = () => buildCommands(a).find((c) => c.id === "wrap")!;
    expect(wrap().label).toBe("Turn line wrapping on");
    wrap().run(OPENER);
    expect(a.settings.get().lineWrapping).toBe(true);
    expect(wrap().label).toBe("Turn line wrapping off");
    expect(a.notice.show).toHaveBeenCalledWith("Line wrapping is on.", { tone: "info" });
  });

  it("a read-only tab explains instead of changing the text, as the menus do", () => {
    const explain = vi.fn(() => true);
    const view = { focus: vi.fn(), dispatch: vi.fn(), state: { replaceSelection: vi.fn() } };
    const a = api({ explainReadOnly: explain, canWrite: () => false, view: () => view as unknown as ReturnType<PaletteApi["view"]> });
    for (const id of ["comment", "moveLineUp", "undo", "cut"]) {
      explain.mockClear();
      buildCommands(a).find((c) => c.id === id)!.run(OPENER);
      expect(explain, id).toHaveBeenCalledTimes(1);
    }
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("shows the keys of the Shortcuts list: every key a command shows is a row's key", () => {
    for (const mac of [false, true]) {
      const combos = new Set(shortcutGroups(mac).flatMap((g) => g.rows.flatMap(([keys]) => keyParts(keys).flatMap((p) => (p.caps ? [p.caps.join(" ")] : [])))));
      for (const c of buildCommands(api({ mac }))) {
        if (!c.keys || TEXT_FIELD_KEYS.has(c.id)) continue;
        for (const p of keyParts(c.keys)) if (p.caps) expect(combos.has(p.caps.join(" ")), `${c.label}: ${c.keys}`).toBe(true);
      }
    }
    expect(buildCommands(api()).find((c) => c.id === "gotoLine")!.keys).toBe(shortcutKeys(false).gotoLine);
  });

  it("every command id is unique", () => {
    const list = ids(buildCommands(api({ connected: () => true, running: () => false })));
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("results", () => {
  const files = ["main.py", "calc.py", "labs/week1/main.c", "labs/notes.txt"].map((path) => ({ path, opaque: false }));
  const commands = buildCommands(api());

  it("nothing typed: the open files first, then the rest, then every command by group", () => {
    const r = results("", files, ["calc.py"], "calc.py", commands);
    expect(r.commandsOnly).toBe(false);
    expect(r.groups.map((g) => g.title)).toEqual(["Files", "Commands"]);
    expect(r.groups[0].options.map((o) => (o.kind === "file" ? `${o.path}${o.current ? "*" : ""}` : ""))).toEqual(["calc.py*", "main.py", "labs/week1/main.c", "labs/notes.txt"]);
    expect(r.groups[1].options).toHaveLength(commands.length);
  });

  it("caps the idle file list and says how many more there are", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.py`, opaque: false }));
    const r = results("", many, [], null, []);
    expect(r.groups[0].options).toHaveLength(FILES_IDLE);
    expect(r.moreFiles).toBe(25 - FILES_IDLE);
  });

  it("a leading > keeps to the commands, grouped while nothing more is typed", () => {
    const r = results(">", files, [], null, commands);
    expect(r.commandsOnly).toBe(true);
    expect(r.groups.map((g) => g.title)).toEqual(["Run", "Files", "Code", "View", "Settings", "GitHub", "Help"]);
    const typed = results(">line", files, [], null, commands);
    expect(typed.groups.map((g) => g.title)).toEqual(["Commands"]);
    expect(typed.groups[0].options[0].kind === "command" && typed.groups[0].options[0].command.id).toBe("gotoLine");
  });

  it("typing finds files by name first, then matching commands", () => {
    const r = results("main", files, [], null, commands);
    expect(r.groups[0].options.map((o) => (o.kind === "file" ? o.path : ""))).toEqual(["main.py", "labs/week1/main.c"]);
    expect(results("zzzz", files, [], null, commands).count).toBe(0);
  });
});

describe("the examples", () => {
  it("three short programs per language, each named for its language, with a one-line description", () => {
    const by = (lang: string) => EXAMPLES.filter((e) => e.lang === lang);
    expect([by("python").length, by("c").length, by("cpp").length]).toEqual([3, 3, 3]);
    const ext = { python: ".py", c: ".c", cpp: ".cpp" } as const;
    for (const e of EXAMPLES) {
      expect(e.name.endsWith(ext[e.lang]), e.name).toBe(true);
      expect(e.about.length, e.name).toBeLessThan(90);
      expect(e.code.endsWith("\n"), e.name).toBe(true);
      // ASCII only, so nothing invisible or direction-changing hides in an example.
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(e.code), e.name).toBe(true);
      expect(e.code.split("\n").length, e.name).toBeLessThan(45);
    }
    expect(new Set(EXAMPLES.map((e) => e.name)).size).toBe(EXAMPLES.length);
    // C keeps its own backslashes (String.raw): "\n" is two characters in the program.
    expect(EXAMPLES.find((e) => e.name === "arrays.c")!.code).toContain(String.raw`printf("Sum: %d\n", sum);`);
  });

  it("takes a free name: the example's own, else name-2, name-3 (as storage compares names)", () => {
    const taken = new Set(["arrays.c", "arrays-2.c", "readme"]);
    expect(freeName("structs.c", (p) => taken.has(p.toLowerCase()))).toBe("structs.c");
    expect(freeName("Arrays.c", (p) => taken.has(p.toLowerCase()))).toBe("Arrays-3.c");
    expect(freeName("readme", (p) => taken.has(p))).toBe("readme-2");
  });
});
