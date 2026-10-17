// Live program input. A running program (Python or C/C++) lives in a worker and reads stdin
// synchronously, so it can't wait for an event. Instead it marks the channel "waiting", asks the
// page for a line, and sleeps with Atomics.wait until the page writes the line into shared memory.
// Needs cross-origin isolation (SharedArrayBuffer); without it, programs only get the Input box.
//
// Layout: Int32 state | Int32 byte length | up to INPUT_BYTES of UTF-8 text.

const IDLE = 0, WAITING = 1, READY = 2, EOF = 3;
const HEADER = 8;
export const INPUT_BYTES = 64 * 1024;

export function createInputChannel(): SharedArrayBuffer | null {
  return self.crossOriginIsolated ? new SharedArrayBuffer(HEADER + INPUT_BYTES) : null;
}

/**
 * Worker side: blocks until the page sends a line (returned with its "\n") or ends input (null).
 * `ask` runs after the channel is marked waiting, so the page's reply can never be missed.
 */
export function waitForInput(channel: SharedArrayBuffer, ask: () => void): Uint8Array | null {
  const ctl = new Int32Array(channel, 0, 2);
  Atomics.store(ctl, 0, WAITING);
  ask();
  while (Atomics.load(ctl, 0) === WAITING) Atomics.wait(ctl, 0, WAITING);
  const state = Atomics.load(ctl, 0);
  const bytes = state === READY ? new Uint8Array(channel, HEADER, Atomics.load(ctl, 1)).slice() : null;
  Atomics.store(ctl, 0, IDLE);
  return bytes;
}

/** Page side: answers a waiting program with a line of text, or null for end of input. */
export function sendInput(channel: SharedArrayBuffer, text: string | null) {
  const ctl = new Int32Array(channel, 0, 2);
  if (text === null) {
    Atomics.store(ctl, 0, EOF);
  } else {
    let bytes = new TextEncoder().encode(text);
    if (bytes.length > INPUT_BYTES) {
      // Cut on a character boundary: never keep the first half of a multi-byte UTF-8 character.
      // (A continuation byte is 10xxxxxx; the cut moves back to the start of its character.)
      let end = INPUT_BYTES;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      bytes = bytes.slice(0, end);
    }
    new Uint8Array(channel, HEADER, bytes.length).set(bytes);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, READY);
  }
  Atomics.notify(ctl, 0);
}
