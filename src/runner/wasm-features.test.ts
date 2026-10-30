import { describe, expect, it } from "vitest";
import { TRY_TABLE_MODULE, wasmExceptionsSupported } from "./wasm-features";

describe("the browser check for C and C++", () => {
  it("passes where WebAssembly has standard exception handling (Node 24, like Chrome 137+)", () => {
    expect(wasmExceptionsSupported()).toBe(true);
  });
  it("tests try_table itself: the same module with another opcode there is not valid", () => {
    expect(WebAssembly.validate(TRY_TABLE_MODULE)).toBe(true);
    const broken = TRY_TABLE_MODULE.slice();
    broken[broken.indexOf(0x1f)] = 0xfe; // not an instruction
    expect(WebAssembly.validate(broken)).toBe(false);
  });
  it("says no rather than throwing when WebAssembly itself is missing or broken", () => {
    const real = globalThis.WebAssembly;
    try {
      Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true, writable: true });
      expect(wasmExceptionsSupported()).toBe(false);
      Object.defineProperty(globalThis, "WebAssembly", { value: { validate: () => { throw new Error("x"); } }, configurable: true, writable: true });
      expect(wasmExceptionsSupported()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "WebAssembly", { value: real, configurable: true, writable: true });
    }
  });
});
