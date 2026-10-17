// Output a C/C++ program has written but its worker hasn't posted yet. The runner worker batches
// output (c-runner.worker.ts) and can only post while the program calls into it, so a program
// that printed a burst and then looped forever kept that burst in the worker, and the page's
// timeout or Stop terminated the worker with it (seen: 10 of 100 lines shown). The worker mirrors
// its unposted output here, in shared memory, and the page reads it before terminating the worker.
// Needs cross-origin isolation (SharedArrayBuffer), like live input; without it nothing changes.
//
// Layout: Int32 seq (odd while the worker writes) | Int32 bytes used | records of
// u8 stream (1 stdout, 2 stderr) | u32 byte length (LE) | UTF-8 text.

const HEADER = 8;
const RECORD_HEAD = 5;
/** Room for the worker's unposted batch, which it posts once it reaches 8 KiB. */
export const TAIL_BYTES = 64 * 1024;

export type TailStream = "stdout" | "stderr";

export function createOutputTail(): SharedArrayBuffer | null {
  return self.crossOriginIsolated ? new SharedArrayBuffer(HEADER + TAIL_BYTES) : null;
}

/** Worker side: appends what was written since the last post; clear() when it is posted. */
export class TailWriter {
  private readonly ctl: Int32Array;
  private readonly data: Uint8Array;
  private readonly enc = new TextEncoder();
  private used = 0;

  constructor(buffer: SharedArrayBuffer) {
    this.ctl = new Int32Array(buffer, 0, 2);
    this.data = new Uint8Array(buffer, HEADER, TAIL_BYTES);
  }

  append(stream: TailStream, text: string) {
    if (!text) return;
    const bytes = this.enc.encode(text);
    if (this.used + RECORD_HEAD + bytes.length > TAIL_BYTES) return; // posted right after anyway (8 KiB rule)
    Atomics.add(this.ctl, 0, 1);
    const at = this.used;
    this.data[at] = stream === "stdout" ? 1 : 2;
    for (let i = 0; i < 4; i++) this.data[at + 1 + i] = (bytes.length >>> (8 * i)) & 0xff;
    this.data.set(bytes, at + RECORD_HEAD);
    this.used = at + RECORD_HEAD + bytes.length;
    Atomics.store(this.ctl, 1, this.used);
    Atomics.add(this.ctl, 0, 1);
  }

  clear() {
    if (!this.used) return;
    Atomics.add(this.ctl, 0, 1);
    this.used = 0;
    Atomics.store(this.ctl, 1, 0);
    Atomics.add(this.ctl, 0, 1);
  }
}

/**
 * Page side, just before terminating the worker: the unposted output, or [] if the worker was
 * busy writing it (then it isn't stuck, and most of it was posted). Treated as untrusted bytes.
 */
export function readOutputTail(buffer: SharedArrayBuffer): { stream: TailStream; text: string }[] {
  const ctl = new Int32Array(buffer, 0, 2);
  for (let attempt = 0; attempt < 8; attempt++) {
    const seq = Atomics.load(ctl, 0);
    if (seq % 2) continue;
    const used = Math.max(0, Math.min(Atomics.load(ctl, 1), TAIL_BYTES));
    const copy = new Uint8Array(buffer, HEADER, used).slice(); // TextDecoder refuses shared memory
    if (Atomics.load(ctl, 0) !== seq) continue;
    return parseRecords(copy);
  }
  return [];
}

function parseRecords(bytes: Uint8Array): { stream: TailStream; text: string }[] {
  const out: { stream: TailStream; text: string }[] = [];
  const dec = new TextDecoder();
  for (let at = 0; at + RECORD_HEAD <= bytes.length;) {
    const kind = bytes[at];
    const len = (bytes[at + 1] | (bytes[at + 2] << 8) | (bytes[at + 3] << 16) | (bytes[at + 4] << 24)) >>> 0;
    const end = at + RECORD_HEAD + len;
    if ((kind !== 1 && kind !== 2) || end > bytes.length) break;
    const stream: TailStream = kind === 1 ? "stdout" : "stderr";
    const text = dec.decode(bytes.subarray(at + RECORD_HEAD, end));
    const last = out[out.length - 1];
    if (last?.stream === stream) last.text += text;
    else out.push({ stream, text });
    at = end;
  }
  return out;
}
