// A runtime file whose sha256 is wrong is refused before the runtime starts. Its own file, so the
// runtime (a module-level singleton) has not loaded yet; then a retry with the right file works.
import { describe, expect, it } from "vitest";
import { FlowEngine } from "./engine";
import { failure, flaky, withPack } from "./fixtures/harness";

const test = withPack ? it : it.skip;

describe("runtime checksum mismatch", () => {
  test("is a typed error, and a retry loads the right file", async () => {
    const { load, calls } = flaky("web-tree-sitter.wasm", "garbage");
    const e = new FlowEngine(load);
    const err = await failure(e.prepare("c"));
    expect(err.failure).toMatchObject({ part: "runtime", reason: "checksum" });
    await e.prepare("c");
    expect(calls.filter((c) => c === "web-tree-sitter.wasm").length).toBe(2);
    expect(e.chart("c", "int main(void) { return 0; }").type).toBe("charts");
  });
});
