import { describe, expect, it } from "vitest";
import { describeImport } from "./import-notice";

const git = (name: string) => ({ name: `proj/.git/${name}`, reason: "it is inside a .git folder", kind: "git" as const });

describe("describeImport", () => {
  it("names real refusals first and folds a .git folder into one item", () => {
    const refused = [
      ...["HEAD", "config", "description", "index", "hooks/pre-commit.sample", "refs/heads/main", "logs/HEAD", "objects/ab/cdef"].map(git),
      { name: "proj/big.txt", reason: "it is 1172 KB; the limit is 1024 KB" },
      { name: "proj/logo.png", reason: "it is a binary file" },
      { name: "proj/trojan.py", reason: "it contains text-direction characters" },
    ];
    const out = describeImport({ added: 4, refused, hidden: [] });
    expect(out.text).toBe(
      "Imported 4 files. Left out big.txt (it is 1172 KB; the limit is 1024 KB), logo.png (it is a binary file), trojan.py (it contains text-direction characters) and the .git folder (8 files).",
    );
    expect(out).toMatchObject({ tone: "warning", folded: true });
  });

  it("counts what is past the named few and past the workspace's room", () => {
    const named = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, reason: "it is a binary file" }));
    const limit = Array.from({ length: 3 }, (_, i) => ({ name: `big/${i}.py`, reason: "the workspace would be over its limit", kind: "limit" as const }));
    const out = describeImport({ added: 0, refused: [...named, ...limit], hidden: [] });
    expect(out.text).toBe(
      "Nothing was imported. Left out f0.bin (it is a binary file), f1.bin (it is a binary file), f2.bin (it is a binary file), 2 more and 3 files that would put the workspace over its limit.",
    );
    expect(out.folded).toBe(true);
  });

  it("a clean import is a success with nothing to show", () => {
    expect(describeImport({ added: 1, refused: [], hidden: [] })).toEqual({ text: "Imported 1 file.", tone: "success", folded: false });
    const one = describeImport({ added: 1, refused: [{ name: "a.png", reason: "it is a binary file" }], hidden: ["x.py"] });
    expect(one.text).toBe("Imported 1 file. Left out a.png (it is a binary file). x.py contains invisible characters (shown as red dots).");
    expect(one.folded).toBe(false);
  });
});
