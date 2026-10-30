// What the browser's WebAssembly must support to run C and C++ (0.17.0). Programs are built with C++
// exceptions as WebAssembly's standard exception instructions (try_table, exnref: wasi-sdk-33's
// libraries use them), so a browser without them can't load a single C or C++ program. The owner chose
// an update message for those browsers over keeping the old compiler (2026-10-30).

/**
 * The smallest module that uses try_table: one function `() -> ()` whose body is
 * `try_table (catch none) end`. Only an engine with standard exception handling validates it.
 */
export const TRY_TABLE_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // "\0asm", version 1
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: one type, () -> ()
  0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x1f, 0x40, 0x00, 0x0b, 0x0b, // code: no locals; try_table (empty) 0 catches end; end
]);

/** Whether C and C++ programs can run here: WebAssembly with the standard exception instructions. */
export function wasmExceptionsSupported(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(TRY_TABLE_MODULE);
  } catch {
    return false;
  }
}

/** The versions that first shipped them (webassembly.org feature data, "Exception Handling with exnref"). */
export const UPDATE_FOR_CPP = "C and C++ need a newer browser: Chrome or Edge 137, Firefox 131, or Safari 18.4, or newer. Python works in this one.";
