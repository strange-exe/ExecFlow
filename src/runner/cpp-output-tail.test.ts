import { describe, expect, it } from "vitest";
import { readOutputTail, TAIL_BYTES, TailWriter } from "./cpp-output-tail";

const tail = () => new SharedArrayBuffer(8 + TAIL_BYTES);
/** "h" + e-acute + " " + euro: multi-byte UTF-8. */
const TEXT = `h${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x20ac)}`;

describe("the unposted output tail", () => {
  it("hands the page what was written since the last post, in order, merged per stream", () => {
    const buffer = tail();
    const w = new TailWriter(buffer);
    w.append("stdout", "line 1\n");
    w.append("stdout", `${TEXT}\n`);
    w.append("stderr", "oops\n");
    w.append("stdout", "");
    w.append("stdout", "last");
    expect(readOutputTail(buffer)).toEqual([
      { stream: "stdout", text: `line 1\n${TEXT}\n` },
      { stream: "stderr", text: "oops\n" },
      { stream: "stdout", text: "last" },
    ]);
    w.clear(); // posted: the page must not show it again
    expect(readOutputTail(buffer)).toEqual([]);
    w.append("stderr", "again");
    expect(readOutputTail(buffer)).toEqual([{ stream: "stderr", text: "again" }]);
  });

  it("gives up rather than read a record the worker is writing", () => {
    const buffer = tail();
    new TailWriter(buffer).append("stdout", "x");
    Atomics.add(new Int32Array(buffer, 0, 2), 0, 1); // seq odd: a write in progress
    expect(readOutputTail(buffer)).toEqual([]);
  });

  it("reads untrusted bytes safely: a bad stream byte or a length past the end stops the list", () => {
    const buffer = tail();
    new TailWriter(buffer).append("stdout", "ok");
    const ctl = new Int32Array(buffer, 0, 2);
    const data = new Uint8Array(buffer, 8);
    data.set([9, 1, 0, 0, 0, 65], 7); // a record with stream 9
    Atomics.store(ctl, 1, 13);
    expect(readOutputTail(buffer)).toEqual([{ stream: "stdout", text: "ok" }]);
    data.set([1, 255, 255, 255, 127], 7); // a length far past the end
    expect(readOutputTail(buffer)).toEqual([{ stream: "stdout", text: "ok" }]);
    Atomics.store(ctl, 1, -5);
    expect(readOutputTail(buffer)).toEqual([]);
    Atomics.store(ctl, 1, TAIL_BYTES * 2);
    expect(() => readOutputTail(buffer)).not.toThrow();
  });

  it("skips a write that doesn't fit instead of overrunning the buffer", () => {
    const buffer = tail();
    const w = new TailWriter(buffer);
    w.append("stdout", "a");
    w.append("stdout", "x".repeat(TAIL_BYTES));
    w.append("stdout", "b");
    expect(readOutputTail(buffer)).toEqual([{ stream: "stdout", text: "ab" }]);
  });
});
