/// <reference types="node" />
// Loading failures come back as typed errors, and a retry really loads again. Its own file, so the
// runtime (a module-level singleton; Vitest gives each test file its own modules) starts unloaded
// here, and the runtime test runs first. The runtime checksum test is in engine-runtime.test.ts.
import { describe, expect, it } from "vitest";
import { FlowEngine } from "./engine";
import { diskLoader, failure, flaky, withPack } from "./fixtures/harness";

const test = withPack ? it : it.skip;

describe("flowchart engine loading failures", () => {
  test("runtime 404: a typed error, then a retry fetches it again and works", async () => {
    const { load, calls } = flaky("web-tree-sitter.wasm", "missing");
    const e = new FlowEngine(load);
    const err = await failure(e.prepare("c"));
    expect(err.failure).toMatchObject({ part: "runtime", reason: "missing" });
    await e.prepare("c");
    expect(calls.filter((c) => c === "web-tree-sitter.wasm").length).toBe(2);
    expect(e.chart("c", "int main(void) { return 0; }").type).toBe("charts");
  });

  test("grammar 404 and grammar checksum mismatch: typed errors, and a retry works", async () => {
    const missing = flaky("tree-sitter-python.wasm", "missing");
    const e1 = new FlowEngine(missing.load);
    expect((await failure(e1.prepare("python"))).failure).toMatchObject({ part: "grammar", reason: "missing" });
    await e1.prepare("python");
    expect(missing.calls.filter((c) => c === "tree-sitter-python.wasm").length).toBe(2);

    const garbage = flaky("tree-sitter-cpp.wasm", "garbage");
    const e2 = new FlowEngine(garbage.load);
    expect((await failure(e2.prepare("cpp"))).failure).toMatchObject({ part: "grammar", reason: "checksum" });
    await e2.prepare("cpp");
    expect(e2.chart("cpp", "int main() { return 0; }").type).toBe("charts");
  });

  test("a grammar whose ABI the runtime doesn't accept is a typed error", async () => {
    // C++'s grammar is ABI 14; pretend the runtime accepts only 15.
    const e = new FlowEngine(diskLoader, { abi: { min: 15, max: 15 } });
    const err = await failure(e.prepare("cpp"));
    expect(err.failure).toMatchObject({ part: "grammar", reason: "abi" });
    expect(err.failure.detail).toMatch(/ABI 14/);
  });
});
