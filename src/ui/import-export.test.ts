import { describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../core/safety";
import { readPicked } from "./import-export";

const file = (name: string, size = 4) => new File([new Uint8Array(size)], name);

describe("readPicked", () => {
  it("stops reading once the workspace's room is used up, and says why for the rest", async () => {
    const list = [file("a.py"), file("b.py"), file("c.py"), file("d.py")];
    const reads = list.map((f) => vi.spyOn(f, "arrayBuffer"));
    const picked = await readPicked(list, false, { files: 2, bytes: 1_000, isNew: () => true });
    expect(picked.files.map((f) => f.name)).toEqual(["a.py", "b.py"]);
    expect(picked.skipped).toEqual([
      { name: "c.py", reason: "the workspace would be over its limit", kind: "limit" },
      { name: "d.py", reason: "the workspace would be over its limit", kind: "limit" },
    ]);
    // The files left out were never read into memory.
    expect(reads.map((r) => r.mock.calls.length)).toEqual([1, 1, 0, 0]);
  });

  it("counts bytes too, and a file that replaces one already there takes no new room", async () => {
    const list = [file("big.py", 600), file("main.py", 600), file("more.py", 600)];
    const picked = await readPicked(list, false, { files: 10, bytes: 1_000, isNew: (n) => n !== "main.py" });
    expect(picked.files.map((f) => f.name)).toEqual(["big.py", "main.py"]);
    expect(picked.skipped.map((s) => [s.name, s.kind])).toEqual([["more.py", "limit"]]);
  });

  it("refuses .git internals and files over 1 MiB before reading them", async () => {
    const huge = file("huge.txt", MAX_FILE_BYTES + 1);
    const read = vi.spyOn(huge, "arrayBuffer");
    const picked = await readPicked([file(".git/config"), huge, file("ok.py")], false);
    expect(picked.files.map((f) => f.name)).toEqual(["ok.py"]);
    expect(picked.skipped.map((s) => [s.name, s.kind ?? null])).toEqual([[".git/config", "git"], ["huge.txt", null]]);
    expect(read).not.toHaveBeenCalled();
  });
});
