import { describe, expect, it } from "vitest";
import { formatArgs, MAX_ARGS, MAX_ARGS_CHARS, parseArgs, RunArgsMemory, type RunArgsStore } from "./run-args";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ok = (text: string) => {
  const r = parseArgs(text);
  if (!r.ok) throw new Error(`expected arguments from ${JSON.stringify(text)}: ${r.reason}`);
  return r.args;
};
const reason = (text: string) => {
  const r = parseArgs(text);
  if (r.ok) throw new Error(`expected an error for ${JSON.stringify(text)}`);
  return r.reason;
};

describe("parseArgs", () => {
  it("splits at spaces, tabs and line breaks, and ignores spaces around the words", () => {
    expect(ok("")).toEqual([]);
    expect(ok("   ")).toEqual([]);
    expect(ok("a b  c")).toEqual(["a", "b", "c"]);
    expect(ok("  3\t4\n5\r\n6  ")).toEqual(["3", "4", "5", "6"]);
  });

  it("keeps spaces inside double or single quotes, and drops the quotes", () => {
    expect(ok('"two words" 3')).toEqual(["two words", "3"]);
    expect(ok("'two  words' x")).toEqual(["two  words", "x"]);
    expect(ok(`"it's" 'say "hi"'`)).toEqual(["it's", 'say "hi"']);
  });

  it("joins quoted text to the text beside it, as a shell does", () => {
    expect(ok('a"b c"d')).toEqual(["ab cd"]);
    expect(ok(`--name="Ada Lovelace"`)).toEqual(["--name=Ada Lovelace"]);
    expect(ok(`'a'"b"c`)).toEqual(["abc"]);
  });

  it("gives an empty argument for empty quotes, wherever they are", () => {
    expect(ok('""')).toEqual([""]);
    expect(ok("a '' b")).toEqual(["a", "", "b"]);
    expect(ok('"" ""')).toEqual(["", ""]);
  });

  it("passes everything else through as text: no escapes, no expansion", () => {
    expect(ok("$(rm -rf /) ; | > out.txt && `id` $HOME *.c ~")).toEqual(["$(rm", "-rf", "/)", ";", "|", ">", "out.txt", "&&", "`id`", "$HOME", "*.c", "~"]);
    expect(ok('"$(rm -rf /)"')).toEqual(["$(rm -rf /)"]);
    const bs = cp(92); // a backslash is a character like any other
    expect(ok(`a${bs} b C:${bs}temp`)).toEqual([`a${bs}`, "b", `C:${bs}temp`]);
    expect(ok(`"a${bs}"`)).toEqual([`a${bs}`]);
  });

  it("keeps text in any script, and a no-break space inside its word (only ASCII whitespace splits)", () => {
    const hello = `h${cp(0xe9)}llo`;
    const japanese = cp(0x65e5, 0x672c);
    const emoji = cp(0x1f600);
    expect(ok(`${hello} ${japanese} "${emoji} x"`)).toEqual([hello, japanese, `${emoji} x`]);
    expect(ok(`a${cp(0xa0)}b c`)).toEqual([`a${cp(0xa0)}b`, "c"]);
    // Curly quotes are text, not quotes.
    expect(ok(`${cp(0x201c)}a b${cp(0x201d)}`)).toEqual([`${cp(0x201c)}a`, `b${cp(0x201d)}`]);
  });

  it("refuses an unclosed quote, naming the quote and where it is (in characters the student sees)", () => {
    // A no-break space ties each quote mark to the word before it, so a wrapped line never starts with one.
    const nb = cp(0xa0);
    expect(reason('a "b c')).toBe(`The quote mark${nb}" at character 3 is never closed, so add another${nb}" or remove it.`);
    expect(reason("it's")).toBe(`The quote mark${nb}' at character 3 is never closed, so add another${nb}' or remove it.`);
    // A quote of the other kind doesn't close it.
    expect(reason(`"a'`)).toBe(`The quote mark${nb}" at character 1 is never closed, so add another${nb}" or remove it.`);
    // An emoji before it counts as one character.
    expect(reason(`${cp(0x1f600)} "x`)).toMatch(/at character 3 /);
  });

  it("allows 100 arguments and refuses 101, saying the limit", () => {
    expect(MAX_ARGS).toBe(100);
    const many = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`).join(" ");
    expect(ok(many(MAX_ARGS))).toHaveLength(MAX_ARGS);
    expect(reason(many(MAX_ARGS + 1))).toBe("That is 101 arguments; the limit is 100, so remove some.");
    expect(ok('"" '.repeat(MAX_ARGS))).toHaveLength(MAX_ARGS);
  });

  it("allows 4,096 characters and refuses 4,097, saying the limit", () => {
    expect(MAX_ARGS_CHARS).toBe(4096);
    expect(ok("x".repeat(MAX_ARGS_CHARS))).toEqual(["x".repeat(MAX_ARGS_CHARS)]);
    expect(reason("x".repeat(MAX_ARGS_CHARS + 1))).toBe("The arguments are 4,097 characters long; the limit is 4,096, so shorten them.");
    // Characters the student sees (code points), as the quote position counts: an emoji is one.
    const emoji = cp(0x1f600);
    expect(ok(emoji.repeat(MAX_ARGS_CHARS))).toEqual([emoji.repeat(MAX_ARGS_CHARS)]);
    expect(reason(emoji.repeat(MAX_ARGS_CHARS + 1))).toBe("The arguments are 4,097 characters long; the limit is 4,096, so shorten them.");
  });
});

describe("formatArgs", () => {
  it("writes plain words plainly and quotes only what needs it", () => {
    expect(formatArgs([])).toBe("");
    expect(formatArgs(["3", "data.txt"])).toBe("3 data.txt");
    expect(formatArgs(["two words", "", "it's", 'say "hi"'])).toBe(`"two words" "" "it's" 'say "hi"'`);
  });

  it("gives back the same arguments when parsed again (round trip)", () => {
    const cases: string[][] = [
      ["a", "b c", "", "it's", 'say "hi"', `both ' and "`, `"`, `'`, `'"`, `"'`, `''""`, "$(rm -rf /)", ";", "|", `x${cp(0xa0)}y`, `${cp(0x65e5)} ${cp(0x1f600)}`, "tab\there", "line\nbreak"],
    ];
    for (const args of cases) {
      for (const one of args) expect(ok(formatArgs([one])), JSON.stringify(one)).toEqual([one]);
      expect(ok(formatArgs(args))).toEqual(args);
    }
  });
});

describe("RunArgsMemory", () => {
  function fakeStore(initial: Record<string, string> = {}) {
    const saved: Record<string, string> = { ...initial };
    const calls: string[] = [];
    let hold: Promise<void> | null = null;
    const store: RunArgsStore & { saved: typeof saved; calls: string[]; holdSaves(p: Promise<void>): void } = {
      saved,
      calls,
      holdSaves(p) { hold = p; },
      load: async () => ({ ...saved }),
      async save(path, text) {
        calls.push(`${path}=${text}`);
        if (hold) await hold;
        if (text) saved[path] = text;
        else delete saved[path];
      },
    };
    return store;
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("keeps one text per file, saves each change, and removes a file's entry when emptied", async () => {
    const store = fakeStore();
    const memory = new RunArgsMemory(store);
    memory.set("a.py", "1 2");
    memory.set("b.c", '"x y"');
    memory.set("a.py", "1 2"); // no change, no save
    expect(memory.get("a.py")).toBe("1 2");
    expect(memory.get("b.c")).toBe('"x y"');
    expect(memory.get("none.py")).toBe("");
    memory.set("a.py", "");
    await settle();
    expect(store.calls).toEqual(["a.py=1 2", 'b.c="x y"', "a.py="]);
    expect(store.saved).toEqual({ "b.c": '"x y"' });
  });

  it("moves a file's text with a rename of the file or its folder, and drops it on delete", () => {
    const memory = new RunArgsMemory(null);
    memory.set("lab/a.c", "1");
    memory.set("lab/sub/b.c", "2");
    memory.set("lab2/c.c", "3");
    memory.set("x.py", "4");
    memory.moved("lab", "week1");
    expect([memory.get("week1/a.c"), memory.get("week1/sub/b.c"), memory.get("lab2/c.c"), memory.get("lab/a.c")]).toEqual(["1", "2", "3", ""]);
    memory.moved("x.py", "y.py");
    expect([memory.get("x.py"), memory.get("y.py")]).toEqual(["", "4"]);
    memory.moved("week1", null);
    expect([memory.get("week1/a.c"), memory.get("week1/sub/b.c"), memory.get("lab2/c.c")]).toEqual(["", "", "3"]);
  });

  it("loads what was saved, tells listeners only when something changed, and never undoes a save still on its way", async () => {
    const store = fakeStore({ "a.py": "saved", "b.py": "old" });
    const memory = new RunArgsMemory(store);
    let told = 0;
    memory.onLoad(() => told++);
    await memory.load();
    expect([memory.get("a.py"), memory.get("b.py"), told]).toEqual(["saved", "old", 1]);
    await memory.load();
    expect(told).toBe(1);
    let release!: () => void;
    store.holdSaves(new Promise<void>((r) => (release = r)));
    memory.set("b.py", "new");
    memory.set("a.py", "");
    await memory.load(); // the store still has the old texts
    expect([memory.get("a.py"), memory.get("b.py")]).toEqual(["", "new"]);
    release();
    await settle();
    await memory.load();
    expect([memory.get("a.py"), memory.get("b.py")]).toEqual(["", "new"]);
    expect(store.saved).toEqual({ "b.py": "new" });
  });

  it("keeps working for this visit when saving fails (a read-only tab) or loading fails", async () => {
    const memory = new RunArgsMemory({ load: () => Promise.reject(new Error("blocked")), save: () => Promise.reject(new Error("read-only")) });
    memory.set("a.py", "1");
    await memory.load();
    await settle();
    expect(memory.get("a.py")).toBe("1");
  });
});
