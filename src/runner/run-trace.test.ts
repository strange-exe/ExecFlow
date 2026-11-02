// The run trace's wire form: what the Python helper's __ce_trace returns becomes a RunTrace, and
// anything a program could have bent (sizes, types, an odd-length event list) is refused.
import { describe, expect, it } from "vitest";
import { checkTrace, MAX_NAME, MAX_TRACE_CALLS, MAX_TRACE_CODES, MAX_TRACE_INTS, traceFromPython } from "./run-trace";

const bytes = (...n: number[]) => new Uint8Array(Int32Array.from(n).buffer);

describe("run trace wire form", () => {
  it("reads the helper's [meta JSON, calls, events] (little-endian int32 bytes)", () => {
    const t = traceFromPython([JSON.stringify({ codes: [["<module>", 1], ["area", 4]], partial: true }), bytes(0, 1), bytes(0, 1, 1, 5, 1, -1, 0, -2)]);
    expect(t).toEqual({ codes: [{ name: "<module>", line: 1 }, { name: "area", line: 4 }], calls: Int32Array.from([0, 1]), events: Int32Array.from([0, 1, 1, 5, 1, -1, 0, -2]), partial: true });
    // Bytes at an odd offset in a bigger buffer still read as whole numbers (a copy is taken).
    const shifted = new Uint8Array(9);
    shifted.set(bytes(7, 8), 1);
    expect(traceFromPython(["{\"codes\": []}", shifted.subarray(1), bytes()])?.calls).toEqual(Int32Array.from([7, 8]));
  });

  it("carries a generator's untraced mark, and only a real true", () => {
    const t = traceFromPython([JSON.stringify({ codes: [["<module>", 1, false], ["gen", 3, true], ["odd", 5, 1]] }), bytes(0), bytes(0, 1)]);
    expect(t?.codes).toEqual([{ name: "<module>", line: 1 }, { name: "gen", line: 3, untraced: true }, { name: "odd", line: 5 }]);
    expect(checkTrace({ codes: [{ name: "gen", line: 3, untraced: true }], calls: new Int32Array(), events: new Int32Array(), partial: false })?.codes[0].untraced).toBe(true);
  });

  it("refuses what isn't a trace", () => {
    for (const raw of [null, "x", [], ["{", bytes(), bytes()], ["[]", bytes(), bytes()], ["{\"codes\": 3}", bytes(), bytes()], ["{\"codes\": []}", new Uint8Array(3), bytes()], ["{\"codes\": []}", bytes(), [1, 2]]]) {
      expect(traceFromPython(raw), JSON.stringify(raw)).toBeUndefined();
    }
    const ok = { codes: [{ name: "<module>", line: 1 }], calls: Int32Array.from([0]), events: Int32Array.from([0, 1]), partial: false };
    expect(checkTrace(ok)).toEqual(ok);
    expect(checkTrace({ ...ok, events: Int32Array.from([0]) })).toBeUndefined();
    expect(checkTrace({ ...ok, events: new Int32Array(MAX_TRACE_INTS + 2) })).toBeUndefined();
    expect(checkTrace({ ...ok, calls: new Int32Array(MAX_TRACE_CALLS + 1) })).toBeUndefined();
    expect(checkTrace({ ...ok, codes: Array.from({ length: MAX_TRACE_CODES + 1 }, () => ({ name: "f", line: 1 })) })).toBeUndefined();
    expect(checkTrace({ ...ok, codes: [{ name: "f", line: 1.5 }] })).toBeUndefined();
    expect(checkTrace({ ...ok, partial: "yes" })?.partial).toBe(false);
    expect(checkTrace({ ...ok, codes: [{ name: "f".repeat(MAX_NAME + 50), line: 1 }] })?.codes[0].name).toHaveLength(MAX_NAME);
  });
});
