// "What's new" after an update (0.7.0 versions unit): a quiet notice once, never on a first visit,
// never for a rollback, and nothing at all when the browser's storage refuses.
import { describe, expect, it } from "vitest";
import { LAST_SEEN_KEY, newerThan, whatsNew } from "./whats-new";

function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("whatsNew", () => {
  it("a first-ever visit (the workspace is new): no notice, and this version is remembered", () => {
    // Other keys don't make a visit a returning one: the theme writes its paint on every start.
    const s = memory({ "codeeditor:theme-paint": "{}" });
    expect(whatsNew(s, "0.7.0", false)).toBeNull();
    expect(s.map.get(LAST_SEEN_KEY)).toBe("0.7.0");
  });

  it("someone whose workspace is older than this visit, from before versions were remembered: told once", () => {
    const s = memory();
    expect(whatsNew(s, "0.7.0", true)).toBe("0.7.0");
    expect(s.map.get(LAST_SEEN_KEY)).toBe("0.7.0");
    expect(whatsNew(s, "0.7.0", true)).toBeNull();
  });

  it("an update from an older version: told once; the same version again: nothing", () => {
    const s = memory({ [LAST_SEEN_KEY]: "0.6.2" });
    expect(whatsNew(s, "0.7.0", true)).toBe("0.7.0");
    expect(whatsNew(s, "0.7.0", true)).toBeNull();
  });

  it("a rollback to an older version: nothing, and the version now running is remembered", () => {
    const s = memory({ [LAST_SEEN_KEY]: "0.8.0" });
    expect(whatsNew(s, "0.7.0", true)).toBeNull();
    expect(s.map.get(LAST_SEEN_KEY)).toBe("0.7.0");
  });

  it("a stored value that isn't a version is treated as an older one", () => {
    const s = memory({ [LAST_SEEN_KEY]: "nonsense" });
    expect(whatsNew(s, "0.7.0", true)).toBe("0.7.0");
  });

  it("storage that throws, or none at all: nothing, and no error", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(whatsNew(broken, "0.7.0", true)).toBeNull();
    expect(whatsNew(null, "0.7.0", true)).toBeNull();
  });

  it("newerThan compares versions as numbers, not text", () => {
    expect(newerThan("0.10.0", "0.9.9")).toBe(true);
    expect(newerThan("0.7.0", "0.7.0")).toBe(false);
    expect(newerThan("0.6.2", "0.7.0")).toBe(false);
    expect(newerThan("1.0.0", "0.99.99")).toBe(true);
  });
});
