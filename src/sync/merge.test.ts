import { describe, expect, it } from "vitest";
import { conflictName, isConflictCopy, parentOf, tryNormalizePath } from "../core/paths";
import { copyName, decide, planMerge, type Sha } from "./merge";

const map = (o: Record<string, string>) => new Map(Object.entries(o));

describe("decide (prototype)", () => {
  it("every version that differs from base survives (all 64 combinations)", () => {
    const v = [null, "x", "y", "z"];
    for (const b of v)
      for (const l of v)
        for (const r of v) {
          const d = decide(b, l, r);
          const kept = new Set([d.at === "l" ? l : d.at === "r" ? r : null, d.copy ? l : null]);
          if (l !== null && l !== b) expect(kept.has(l), `lost local ${JSON.stringify({ b, l, r, d })}`).toBe(true);
          if (r !== null && r !== b) expect(kept.has(r), `lost remote ${JSON.stringify({ b, l, r, d })}`).toBe(true);
        }
  });

  it("names each case", () => {
    expect(decide("x", "x", "x").kind).toBe("unchanged");
    expect(decide("x", "y", "y").kind).toBe("converged");
    expect(decide("x", null, null)).toEqual({ at: null, copy: false, kind: "converged" });
    expect(decide("x", "x", "y")).toEqual({ at: "r", copy: false, kind: "changed-remotely" });
    expect(decide("x", "x", null)).toEqual({ at: null, copy: false, kind: "deleted-remotely" });
    expect(decide("x", "y", "x")).toEqual({ at: "l", copy: false, kind: "changed-locally" });
    expect(decide("x", null, "x")).toEqual({ at: null, copy: false, kind: "deleted-locally" });
    expect(decide(null, "y", "z")).toEqual({ at: "r", copy: true, kind: "conflict-both-changed" });
    expect(decide("x", "y", null)).toEqual({ at: "l", copy: false, kind: "conflict-edit-vs-remote-delete" });
    expect(decide("x", null, "z")).toEqual({ at: "r", copy: false, kind: "conflict-local-delete-vs-remote-edit" });
  });
});

describe("conflict copy names", () => {
  it("prototype: keep the extension, handle dotfiles, names without extension and collisions", () => {
    const date = new Date(2026, 9, 16, 14, 30, 5);
    const none = () => false;
    expect(conflictName("src/main.py", date, none)).toBe("src/main.conflict-20261016-143005.py");
    expect(conflictName(".gitignore", date, none)).toBe(".gitignore.conflict-20261016-143005");
    expect(conflictName("Makefile", date, none)).toBe("Makefile.conflict-20261016-143005");
    expect(conflictName("a.c", date, (c) => c === "a.conflict-20261016-143005.c")).toBe("a.conflict-20261016-143005-2.c");
  });

  const takenSet = (paths: string[]) => {
    const keys = new Set(paths.map((p) => p.toLowerCase()));
    return { has: (p: string) => keys.has(p.toLowerCase()), add: (p: string) => void keys.add(p.toLowerCase()) };
  };
  const date = new Date(2026, 9, 16, 14, 30, 5);

  it("collide case-insensitively and count every name already used", () => {
    expect(copyName("main.py", date, takenSet(["MAIN.conflict-20261016-143005.py"]))).toBe("main.conflict-20261016-143005-2.py");
    const taken = takenSet([]);
    expect(copyName("main.py", date, taken)).toBe("main.conflict-20261016-143005.py");
    expect(copyName("main.py", date, taken)).toBe("main.conflict-20261016-143005-2.py");
  });

  it("a copy of a conflict copy is named after the original file", () => {
    const later = new Date(2026, 9, 17, 9, 0, 0);
    expect(copyName("src/main.conflict-20261016-143005.py", later, takenSet([]))).toBe("src/main.conflict-20261017-090000.py");
    expect(copyName("Makefile.conflict-20261016-143005-3", later, takenSet([]))).toBe("Makefile.conflict-20261017-090000");
  });

  it("shortens names that would be too long to store", () => {
    const long = "x".repeat(250) + ".py";
    const name = copyName(`dir/${long}`, date, takenSet([]));
    expect(tryNormalizePath(name)).toBe(name);
    expect(isConflictCopy(name)).toBe(true);
    expect(name.endsWith(".conflict-20261016-143005.py")).toBe(true);
  });

  it("an existing copy from another device at the same second gets -2 in a merge", () => {
    const { merged } = planMerge(
      map({ "main.py": "b" }),
      map({ "main.py": "l" }),
      map({ "main.py": "r", "main.conflict-20261016-143005.py": "other" }),
      date,
    );
    expect(merged.get("main.conflict-20261016-143005-2.py")).toEqual({ sha: "l", from: "l", copyOf: "main.py" });
    expect(merged.get("main.conflict-20261016-143005.py")).toEqual({ sha: "other", from: "r" });
  });
});

describe("planMerge", () => {
  const date = new Date(2026, 9, 16, 9, 0, 0);

  it("prototype: file vs folder clash: the local file moves aside", () => {
    const { merged } = planMerge(new Map(), map({ notes: "l1" }), map({ "notes/a.py": "r1" }), date);
    expect([...merged.keys()].sort()).toEqual(["notes.conflict-20261016-090000", "notes/a.py"]);
  });

  it("folder vs file clash: local files move out of a folder the repository has as a file", () => {
    const { merged, items } = planMerge(new Map(), map({ "notes/a.py": "l1", "notes/b.py": "l2" }), map({ notes: "r1" }), date);
    expect([...merged.keys()].sort()).toEqual(["notes", "notes.conflict-20261016-090000/a.py", "notes.conflict-20261016-090000/b.py"]);
    expect(merged.get("notes")).toEqual({ sha: "r1", from: "r" });
    expect(items.filter((i) => i.kind === "conflict-file-vs-folder").map((i) => i.of)).toEqual(["notes/a.py", "notes/b.py"]);
  });

  it("a local file clashing with an ignored repository path moves aside too", () => {
    const { merged } = planMerge(new Map(), map({ a: "l1" }), new Map(), date, { fixedRemote: ["a/CON"] });
    expect([...merged.keys()]).toEqual(["a.conflict-20261016-090000"]);
  });

  it("history rewritten: remote deletions are kept", () => {
    const { merged, items } = planMerge(map({ "a.py": "x" }), map({ "a.py": "x" }), new Map(), date, { historyRewritten: true });
    expect(merged.get("a.py")).toEqual({ sha: "x", from: "l" });
    expect(items).toEqual([{ path: "a.py", kind: "kept-after-history-rewrite" }]);
  });

  it("no conflict copy when this computer's version is already kept in the repository", () => {
    // E.g. the copy was pushed by a sync whose answer never arrived.
    const { merged, items } = planMerge(
      map({ "main.py": "b" }),
      map({ "main.py": "l" }),
      map({ "main.py": "r", "main.conflict-20261016-085959.py": "l" }),
      date,
    );
    expect([...merged.keys()].sort()).toEqual(["main.conflict-20261016-085959.py", "main.py"]);
    expect(items.find((i) => i.path === "main.py")?.kind).toBe("already-on-remote");
  });

  it("still copies when the matching repository file is deleted by this merge", () => {
    // Local moved q.py over p.py while the repository edited p.py: q.py's content must survive.
    const { merged } = planMerge(map({ "p.py": "b", "q.py": "Q" }), map({ "p.py": "Q" }), map({ "p.py": "r", "q.py": "Q" }), date);
    expect([...merged.values()].some((m) => m.sha === "Q")).toBe(true);
  });

  describe("opaque entries", () => {
    it("a local pointer follows the repository and is never copied", () => {
      const lo = new Set(["img.png", "gone.bin", "only-here.bin"]);
      const { merged } = planMerge(
        map({ "img.png": "b1", "gone.bin": "g" }),
        map({ "img.png": "b1", "gone.bin": "g", "only-here.bin": "o" }),
        map({ "img.png": "r1" }),
        date,
        { localOpaque: lo },
      );
      expect(merged.get("img.png")).toEqual({ sha: "r1", from: "r" });
      expect(merged.has("gone.bin")).toBe(false);
      expect(merged.get("only-here.bin")).toEqual({ sha: "o", from: "l", opaque: true });
    });

    it("a repository opaque file is never deleted or overwritten", () => {
      const ro = new Set(["link", "img.png"]);
      const { merged, items } = planMerge(map({ link: "s", "img.png": "i" }), map({ link: "text" }), map({ link: "s", "img.png": "i" }), date, { remoteOpaque: ro });
      expect(merged.get("img.png")).toEqual({ sha: "i", from: "r", opaque: true });
      expect(merged.get("link")).toEqual({ sha: "s", from: "r", opaque: true });
      expect(merged.get("link.conflict-20261016-090000")).toEqual({ sha: "text", from: "l", copyOf: "link" });
      expect(items.filter((i) => i.kind === "kept-opaque").map((i) => i.path)).toEqual(["img.png", "link"]);
    });
  });

  it("keeps every version and never makes a file/folder clash (seeded random cases)", () => {
    const universe = ["a", "a/b", "a/c.py", "b", "b/x/y.c", "c.txt", "c.conflict-20261016-090000.txt", "D/e.py", "d/E.py"];
    const shas = ["s1", "s2", "s3"];
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const validTree = (paths: string[]) => paths.every((p) => paths.every((q) => !q.startsWith(p + "/")));
    const side = (): Map<string, Sha> => {
      for (;;) {
        const m = new Map<string, Sha>();
        for (const p of universe) if (rand() < 0.4) m.set(p, pick(shas));
        if (validTree([...m.keys()])) return m;
      }
    };
    for (let n = 0; n < 3000; n++) {
      const base = side();
      const local = side();
      const remote = side();
      const remoteOpaque = new Set([...remote.keys()].filter(() => rand() < 0.2));
      const localOpaque = new Set([...local.keys()].filter(() => rand() < 0.2));
      const fixed = rand() < 0.3 ? ["z/CON"].filter(() => validTree([...remote.keys(), "z/CON"])) : [];
      const historyRewritten = rand() < 0.2;
      const { merged } = planMerge(base, local, remote, new Date(2026, 9, 16, 9, 0, 0), { localOpaque, remoteOpaque, fixedRemote: fixed, historyRewritten });
      const context = JSON.stringify({ base: [...base], local: [...local], remote: [...remote], lo: [...localOpaque], ro: [...remoteOpaque], fixed, historyRewritten });
      const kept = new Set([...merged.values()].map((m) => m.sha));
      for (const [p, l] of local) if (!localOpaque.has(p) && l !== base.get(p)) expect(kept.has(l), `lost local ${p} ${context}`).toBe(true);
      for (const [p, r] of remote) if (r !== base.get(p)) expect(kept.has(r), `lost remote ${p} ${context}`).toBe(true);
      for (const p of remoteOpaque) expect(merged.get(p), `opaque ${p} moved ${context}`).toEqual({ sha: remote.get(p), from: "r", opaque: true });
      const all = [...merged.keys(), ...fixed];
      expect(validTree(all), `file/folder clash ${context}`).toBe(true);
      for (const [p, m] of merged) {
        expect(tryNormalizePath(p), context).toBe(p);
        if (m.from === "r") expect(remote.get(p), `remote entry moved ${context}`).toBe(m.sha);
        if (!base.has(p) && !local.has(p) && !remote.has(p)) {
          expect(m.copyOf, `new path without origin ${p} ${context}`).toBeDefined();
          expect(isConflictCopy(p) || isConflictCopy(parentOf(p)) || p.split("/").some((s) => isConflictCopy(s)), `${p} ${context}`).toBe(true);
        }
        if (m.from === "l" && localOpaque.has(p) && m.copyOf === undefined) {
          expect(remote.has(p), `pointer kept over a repository file ${context}`).toBe(false);
        }
      }
    }
  });
});
