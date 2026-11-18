// The run trace's wire form: what the Python helper's __ce_trace returns becomes a RunTrace, and
// anything a program could have bent (sizes, types, an odd-length event list) is refused.
import { describe, expect, it } from "vitest";
import { checkTrace, MAX_NAME, MAX_TRACE_CALLS, MAX_TRACE_CODES, MAX_TRACE_INTS, MAX_VALUE_DELTAS, MAX_VALUE_NAMES, MAX_VALUE_TEXTS, traceFromPython, VALUE_TEXT } from "./run-trace";

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

describe("variable values on the wire", () => {
  const meta = JSON.stringify({ codes: [["<module>", 1]], partial: false });
  const values = (v: object) => JSON.stringify({ names: ["total", "n"], texts: ["0", "1", "'a\\n'"], cut: null, ...v });
  // Events: line 1, line 2, line 3, return.
  const events = bytes(0, 1, 0, 2, 0, 3, 0, -1);

  it("reads [meta, calls, events, values JSON, deltas]; a trace without values still reads", () => {
    const t = traceFromPython([meta, bytes(0), events, values({}), bytes(1, 0, 0, 2, 1, 1, 3, 1, -1)]);
    expect(t?.values).toEqual({ names: ["total", "n"], texts: ["0", "1", "'a\\n'"], deltas: Int32Array.from([1, 0, 0, 2, 1, 1, 3, 1, -1]), cut: null });
    expect(traceFromPython([meta, bytes(0), events])?.values).toBeUndefined();
    expect(traceFromPython([meta, bytes(0), events, values({ cut: 2 }), bytes(1, 0, 0)])?.values?.cut).toBe(2);
    // A checked trace passes the check again unchanged (the runner checks the worker's copy).
    expect(checkTrace(t)).toEqual(t);
  });

  it("refuses values that are off: the whole trace goes", () => {
    const bad: [string, unknown, unknown][] = [
      ["names not strings", values({ names: [1] }), bytes()],
      ["texts not a list", values({ texts: "x" }), bytes()],
      ["deltas not triples", values({}), bytes(1, 0)],
      ["event past the end", values({}), bytes(4, 0, 0)],
      ["negative event", values({}), bytes(-1, 0, 0)],
      ["events out of order", values({}), bytes(2, 0, 0, 1, 0, 1)],
      ["name index out of range", values({}), bytes(1, 2, 0)],
      ["text index out of range", values({}), bytes(1, 0, 3)],
      ["text index below -1", values({}), bytes(1, 0, -2)],
      ["a text too long", values({ texts: ["x".repeat(2 * VALUE_TEXT + 1)] }), bytes()],
      ["a text with a line break", values({ texts: ["a\nb"] }), bytes()],
      ["a text with a bidi control", values({ texts: [`a${String.fromCodePoint(0x202e)}b`] }), bytes()],
      ["a name with a control character", values({ names: [`a${String.fromCodePoint(0)}`] }), bytes()],
      ["an empty name", values({ names: [""] }), bytes()],
      ["a name too long", values({ names: ["n".repeat(MAX_NAME + 1)] }), bytes()],
      ["too many names", values({ names: Array.from({ length: MAX_VALUE_NAMES + 1 }, (_, i) => `v${i}`) }), bytes()],
      ["too many texts", values({ texts: Array.from({ length: MAX_VALUE_TEXTS + 1 }, () => "1") }), bytes()],
      ["cut out of range", values({ cut: 5 }), bytes()],
      ["cut not a whole number", values({ cut: 1.5 }), bytes()],
      ["values JSON broken", "{", bytes()],
      ["deltas not bytes", values({}), [1, 0, 0]],
    ];
    for (const [why, v, d] of bad) expect(traceFromPython([meta, bytes(0), events, v, d]), why).toBeUndefined();
    const ok = traceFromPython([meta, bytes(0), events, values({}), bytes()])!;
    expect(checkTrace({ ...ok, values: { ...ok.values!, deltas: new Int32Array(3 * MAX_VALUE_DELTAS + 3) } })).toBeUndefined();
    expect(checkTrace({ ...ok, values: "x" })).toBeUndefined();
    // Four parts is neither form.
    expect(traceFromPython([meta, bytes(0), events, values({})])).toBeUndefined();
  });

  it("allows texts up to the limit, astral characters included", () => {
    const smile = String.fromCodePoint(0x1f600);
    const t = traceFromPython([meta, bytes(0), events, values({ texts: [smile.repeat(VALUE_TEXT)] }), bytes(1, 0, 0)]);
    expect(t?.values?.texts[0]).toBe(smile.repeat(VALUE_TEXT));
  });
});
