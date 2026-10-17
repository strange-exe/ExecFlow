import { describe, expect, it } from "vitest";
import { INPUT_BYTES, sendInput } from "./input-channel";

const HEADER = 8;

/** What a waiting program would receive after sendInput. */
function received(text: string): Uint8Array {
  const channel = new SharedArrayBuffer(HEADER + INPUT_BYTES);
  const ctl = new Int32Array(channel, 0, 2);
  Atomics.store(ctl, 0, 1); // the program is waiting
  sendInput(channel, text);
  expect(Atomics.load(ctl, 0)).toBe(2); // ready
  return new Uint8Array(channel, HEADER, Atomics.load(ctl, 1)).slice();
}

const strictDecode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

describe("sendInput", () => {
  it("passes ordinary lines through unchanged", () => {
    const line = "Abhinesh " + String.fromCodePoint(0x928, 0x92e, 0x938, 0x94d, 0x924, 0x947) + "\n";
    expect(strictDecode(received(line))).toBe(line);
  });

  it.each([
    ["2-byte", 0xe9],
    ["3-byte", 0x20ac],
    ["4-byte", 0x1f600],
  ])("cuts an over-long line on a character boundary (%s characters)", (_, code) => {
    const text = "x" + String.fromCodePoint(code).repeat(INPUT_BYTES);
    const bytes = received(text);
    expect(bytes.length).toBeLessThanOrEqual(INPUT_BYTES);
    expect(bytes.length).toBeGreaterThan(INPUT_BYTES - 4);
    // Decoding fails (fatal) if the last character was split.
    const decoded = strictDecode(bytes);
    expect(text.startsWith(decoded)).toBe(true);
  });

  it("keeps exactly INPUT_BYTES when the cut falls between characters", () => {
    const bytes = received("a".repeat(INPUT_BYTES + 10));
    expect(bytes.length).toBe(INPUT_BYTES);
  });
});
