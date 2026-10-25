import { describe, expect, it } from "vitest";
import { shown } from "./dom";

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("shown (untrusted names in sentences)", () => {
  it("tags every invisible, line-breaking and direction character, so a cut name can't look like another", () => {
    // Found by the attack review (2026-10-24): names took these, and the tree, notices and the Run
    // offer drew them invisibly (mai + U+2062 + n.c looked like main.c).
    const cases = [0x85, 0x9b, 0x34f, 0x61c, 0x17b4, 0x180b, 0x2028, 0x2029, 0x2062, 0x206a, 0xfe00, 0xfff9, 0x1d173, 0xe0001];
    for (const c of cases) {
      const text = shown(`mai${cp(c)}n.c`);
      expect(text, c.toString(16)).toBe(`mai[U+${c.toString(16).toUpperCase().padStart(4, "0")}]n.c`);
    }
  });

  it("keeps the old tags, and the joiners Indic scripts need", () => {
    expect(shown(`a${cp(0x202e)}b`)).toBe("a[U+202E]b");
    expect(shown(`a${cp(0x200b)}b`)).toBe("a[U+200B]b");
    expect(shown(`a${cp(1)}b`)).toBe("a[U+0001]b");
    // ZWNJ and ZWJ shape Hindi and other scripts: never tagged.
    const hindi = `${cp(0x915, 0x94d, 0x200d, 0x937)}.py`;
    expect(shown(hindi)).toBe(hindi);
    expect(shown(`a${cp(0x200c)}b`)).toBe(`a${cp(0x200c)}b`);
    expect(shown("lab1/main.c")).toBe("lab1/main.c");
  });
});
