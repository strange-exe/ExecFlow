// Reads the symbol table of a WebAssembly object file (the "linking" custom section, tool-conventions
// Linking.md), to answer one question before linking: does any of the program's files define main?
//
// 0.17.0 (LLVM 22, wasi-libc from wasi-sdk-33): clang renames main for WASI, to __main_void for
// main(void) and to __main_argc_argv for main(int, char **), and wasi-libc's start-up code reaches
// them through weak symbols. A program with no main therefore links without a word and traps when it
// starts. clang 8's wasm-ld said "undefined symbol: main"; the worker now says it itself when no unit
// defines either name. Pure: the worker calls it, the tests read real objects (__fixtures__/main-objects.json).

/** The names a program's main is compiled to (clang, wasm32-wasip1). */
export const ENTRY_NAMES = ["__main_void", "__main_argc_argv"] as const;

const SYMTAB = 8;
const UNDEFINED = 0x10;
const EXPLICIT_NAME = 0x40;
const KIND = { function: 0, data: 1, global: 2, section: 3, tag: 4, table: 5 } as const;

class Reader {
  constructor(private bytes: Uint8Array, public at = 0, private end = bytes.length) {}
  get done(): boolean {
    return this.at >= this.end;
  }
  byte(): number {
    if (this.at >= this.end) throw new Error("wasm object: unexpected end");
    return this.bytes[this.at++];
  }
  /** Unsigned LEB128, up to 32 bits. */
  u32(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
    }
    throw new Error("wasm object: bad number");
  }
  string(): string {
    const n = this.u32();
    if (this.at + n > this.end) throw new Error("wasm object: string past the end");
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }
  sub(n: number): Reader {
    if (this.at + n > this.end) throw new Error("wasm object: section past the end");
    const r = new Reader(this.bytes, this.at, this.at + n);
    this.at += n;
    return r;
  }
}

/** The names of the functions an object defines (from its symbol table; empty when it has none). */
export function definedFunctions(object: Uint8Array): string[] {
  // "\0asm", then the 4-byte version.
  if (object.length < 8 || object[0] !== 0 || object[1] !== 0x61 || object[2] !== 0x73 || object[3] !== 0x6d) throw new Error("not a WebAssembly object");
  const r = new Reader(object, 8);
  const names: string[] = [];
  while (!r.done) {
    const id = r.byte();
    const section = r.sub(r.u32());
    if (id !== 0 || section.string() !== "linking") continue;
    section.u32(); // version
    while (!section.done) {
      const type = section.byte();
      const payload = section.sub(section.u32());
      if (type !== SYMTAB) continue;
      for (let count = payload.u32(); count > 0; count--) {
        const kind = payload.byte();
        const flags = payload.u32();
        const defined = !(flags & UNDEFINED);
        if (kind === KIND.data) {
          payload.string();
          if (defined) {
            payload.u32();
            payload.u32();
            payload.u32();
          }
        } else if (kind === KIND.section) {
          payload.u32();
        } else {
          payload.u32(); // the function, global, tag or table index
          const named = defined || !!(flags & EXPLICIT_NAME);
          const name = named ? payload.string() : "";
          if (kind === KIND.function && defined) names.push(name);
        }
      }
    }
  }
  return names;
}

/** Whether any of the objects defines the program's main (under either of its WASI names). */
export function definesMain(objects: Iterable<Uint8Array>): boolean {
  for (const object of objects) {
    const names = definedFunctions(object);
    if (ENTRY_NAMES.some((n) => names.includes(n))) return true;
  }
  return false;
}
