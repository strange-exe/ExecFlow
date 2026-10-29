// The one-click move between the old and the new address (move-protocol.ts): who plays which part,
// which messages count, and both halves of the hand-over driven with fake windows and fake events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_TIMEOUT_MS,
  MOVE_HASH,
  MOVE_PATH,
  MOVE_TIMEOUT_MS,
  checkOffer,
  fromPeer,
  isDone,
  isReady,
  moveRole,
  receiveFiles,
  sendFiles,
  type MoveEvent,
  type PeerWindow,
  type ReceiveDeps,
  type SendDeps,
} from "./move-protocol";

const FROM = "https://old.example.test";
const TO = "https://new.example.test";
const EVIL = "https://evil.example.test";
const READY = { type: "codeeditor-move-ready", v: 1 };
const zipBlob = (size = 64) => new Blob([new Uint8Array(size)], { type: "application/zip" });

/** A fake window: records what is posted to it, with the target origin. */
function fakeWindow(): PeerWindow & { posted: { data: unknown; origin: string }[]; closed: boolean } {
  const posted: { data: unknown; origin: string }[] = [];
  return {
    posted,
    closed: false,
    postMessage(data: unknown, origin: string) {
      posted.push({ data, origin });
    },
    close() {
      this.closed = true;
    },
  };
}

/** A message channel: listeners added by the code under test, events sent by the test. */
function channel() {
  const listeners = new Set<(e: MoveEvent) => void>();
  return {
    listen: (handler: (e: MoveEvent) => void) => {
      listeners.add(handler);
      return () => void listeners.delete(handler);
    },
    send: (e: MoveEvent) => {
      for (const l of [...listeners]) l(e);
    },
    get count() {
      return listeners.size;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("moveRole", () => {
  it("the old address sends, the new one receives, any other address does nothing", () => {
    expect(moveRole(FROM, FROM, TO)).toBe("from");
    expect(moveRole(TO, FROM, TO)).toBe("to");
    for (const other of [EVIL, `${FROM}/`, "http://old.example.test", "https://old.example.test:8443", "null", "", "https://sub.old.example.test"]) expect(moveRole(other, FROM, TO), other).toBeNull();
  });
});

describe("the messages", () => {
  it("ready and done have exactly the expected shape", () => {
    expect(isReady(READY)).toBe(true);
    for (const bad of [null, "codeeditor-move-ready", { type: "codeeditor-move-ready" }, { type: "codeeditor-move-ready", v: 2 }, { type: "codeeditor-move", v: 1 }, [READY]]) expect(isReady(bad), JSON.stringify(bad)).toBe(false);
    expect(isDone({ type: "codeeditor-move-done", v: 1, added: 3, skipped: 0 })).toBe(true);
    expect(isDone({ type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "declined" })).toBe(true);
    for (const bad of [
      { type: "codeeditor-move-done", v: 1, added: -1, skipped: 0 },
      { type: "codeeditor-move-done", v: 1, added: 1.5, skipped: 0 },
      { type: "codeeditor-move-done", v: 1, added: "3", skipped: 0 },
      { type: "codeeditor-move-done", v: 1, added: 1 },
      { type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "<img src=x onerror=alert(1)>" },
      { type: "codeeditor-move-done", v: 2, added: 1, skipped: 0 },
    ])
      expect(isDone(bad), JSON.stringify(bad)).toBe(false);
  });

  it("an offer needs v 1 and a zip that is a Blob within the size limit", () => {
    expect(checkOffer({ type: "codeeditor-move", v: 1, zip: zipBlob(), count: 3 }, 1000)).toEqual({ ok: true, zip: expect.any(Blob) });
    expect(checkOffer({ type: "codeeditor-move", v: 1, zip: zipBlob(1000) }, 1000).ok).toBe(true);
    const refused = [
      null,
      { type: "codeeditor-move", v: 2, zip: zipBlob() },
      { type: "codeeditor-move", v: 1 },
      { type: "codeeditor-move", v: 1, zip: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
      { type: "codeeditor-move", v: 1, zip: new Uint8Array(22) },
      { type: "codeeditor-move", v: 1, zip: { size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) } },
      { type: "codeeditor-move", v: 1, zip: zipBlob(1001) },
      { type: "codeeditor-move", v: 1, zip: zipBlob(0) },
      { type: "codeeditor-move-ready", v: 1, zip: zipBlob() },
    ];
    for (const bad of refused) expect(checkOffer(bad, 1000).ok, String((bad as { zip?: unknown } | null)?.zip)).toBe(false);
  });

  it("fromPeer needs the exact origin AND the exact window", () => {
    const peer = fakeWindow();
    const other = fakeWindow();
    expect(fromPeer({ origin: TO, source: peer, data: null }, TO, peer)).toBe(true);
    expect(fromPeer({ origin: EVIL, source: peer, data: null }, TO, peer)).toBe(false);
    expect(fromPeer({ origin: `${TO}/`, source: peer, data: null }, TO, peer)).toBe(false);
    expect(fromPeer({ origin: TO, source: other, data: null }, TO, peer)).toBe(false);
    expect(fromPeer({ origin: TO, source: null, data: null }, TO, peer)).toBe(false);
  });
});

describe("sendFiles (the old address)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sender(overrides: Partial<SendDeps> = {}) {
    const win = fakeWindow();
    const ch = channel();
    const opened: string[] = [];
    const deps: SendDeps = {
      to: TO,
      open: (url) => {
        opened.push(url);
        return win;
      },
      listen: ch.listen,
      buildZip: async () => ({ blob: zipBlob(), count: 3 }),
      ...overrides,
    };
    return { win, ch, opened, deps };
  }

  it("opens the fixed address, waits for ready from that window, sends the zip to that origin only, and reports done", async () => {
    const { win, ch, opened, deps } = sender();
    const states: string[] = [];
    const result = sendFiles({ ...deps, onState: (s) => states.push(s) });
    expect(opened).toEqual([`${TO}${MOVE_PATH}${MOVE_HASH}`]);
    await vi.advanceTimersByTimeAsync(0);
    expect(win.posted).toEqual([]);
    // Ready from anyone else, or from another window at the right origin, is not an answer.
    ch.send({ origin: EVIL, source: win, data: READY });
    ch.send({ origin: TO, source: fakeWindow(), data: READY });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.posted).toEqual([]);
    ch.send({ origin: TO, source: win, data: READY });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.posted).toHaveLength(1);
    expect(win.posted[0].origin).toBe(TO);
    const sent = win.posted[0].data as { type: string; v: number; zip: Blob; count: number };
    expect(sent.type).toBe("codeeditor-move");
    expect(sent.v).toBe(1);
    expect(sent.zip).toBeInstanceOf(Blob);
    expect(sent.count).toBe(3);
    // A forged "done" is ignored; the real one ends it.
    ch.send({ origin: EVIL, source: win, data: { type: "codeeditor-move-done", v: 1, added: 99, skipped: 0 } });
    ch.send({ origin: TO, source: win, data: { type: "codeeditor-move-done", v: 1, added: 3, skipped: 1 } });
    await expect(result).resolves.toEqual({ kind: "done", added: 3, skipped: 1 });
    expect(states).toEqual(["waiting", "sent", "done"]);
    expect(ch.count).toBe(0);
    // A second ready never sends the files twice.
    ch.send({ origin: TO, source: win, data: READY });
    expect(win.posted).toHaveLength(1);
  });

  it("a blocked popup is reported at once, and no zip is built", async () => {
    const buildZip = vi.fn(async () => ({ blob: zipBlob(), count: 1 }));
    const { deps, ch } = sender({ open: () => null, buildZip });
    await expect(sendFiles(deps)).resolves.toEqual({ kind: "blocked" });
    expect(buildZip).not.toHaveBeenCalled();
    expect(ch.count).toBe(0);
  });

  it("the new tab closed before the end is reported", async () => {
    const { deps, win, ch } = sender();
    const result = sendFiles(deps);
    await vi.advanceTimersByTimeAsync(600);
    win.closed = true;
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ kind: "closed" });
    expect(ch.count).toBe(0);
  });

  it("no answer within 60 s is a timeout, and the opened tab is closed", async () => {
    const { deps, win } = sender();
    const result = sendFiles(deps);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS - 1000);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ kind: "timeout" });
    expect(MOVE_TIMEOUT_MS).toBe(60_000);
    expect(win.closed).toBe(true);
  });

  it("once the files are sent, the student's answer may take longer than a minute, and their tab is never closed under the dialog", async () => {
    const { deps, win, ch } = sender();
    const result = sendFiles(deps);
    await vi.advanceTimersByTimeAsync(MOVE_TIMEOUT_MS - 5000);
    ch.send({ origin: TO, source: win, data: READY });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.posted).toHaveLength(1);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2 * MOVE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(win.closed).toBe(false);
    ch.send({ origin: TO, source: win, data: { type: "codeeditor-move-done", v: 1, added: 2, skipped: 0 } });
    await expect(result).resolves.toEqual({ kind: "done", added: 2, skipped: 0 });
  });

  it("with no answer at all after sending, it gives up later, leaving the tab open", async () => {
    const { deps, win, ch } = sender();
    const result = sendFiles(deps);
    ch.send({ origin: TO, source: win, data: READY });
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ kind: "timeout" });
    expect(win.closed).toBe(false);
  });

  it("a zip that can't be built is reported, and the opened tab is closed", async () => {
    const { deps, win } = sender({ buildZip: async () => Promise.reject(new Error("storage closed")) });
    await expect(sendFiles(deps)).resolves.toEqual({ kind: "failed", reason: "storage closed" });
    expect(win.closed).toBe(true);
  });

  it("the receiver's refusal comes back with its reason", async () => {
    const { deps, win, ch } = sender();
    const result = sendFiles(deps);
    ch.send({ origin: TO, source: win, data: READY });
    await vi.advanceTimersByTimeAsync(0);
    ch.send({ origin: TO, source: win, data: { type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "read-only" } });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "read-only" });
  });
});

describe("receiveFiles (the new address)", () => {
  function receiver(overrides: Partial<ReceiveDeps> = {}) {
    const opener = fakeWindow();
    const ch = channel();
    const confirm = vi.fn(async (_count: number) => true);
    const apply = vi.fn(async () => ({ added: 3, skipped: 1 }));
    const prepare = vi.fn(async (_zip: Blob) => ({ count: 4, apply }));
    const deps: ReceiveDeps = {
      from: FROM,
      opener,
      listen: ch.listen,
      canWrite: () => true,
      maxBytes: 1000,
      prepare,
      confirm,
      ...overrides,
    };
    return { opener, ch, confirm, apply, prepare, deps };
  }
  const offer = (zip: unknown = zipBlob()) => ({ type: "codeeditor-move", v: 1, zip, count: 4 });

  it("does nothing without an opener", async () => {
    const { deps, ch } = receiver({ opener: null });
    await expect(receiveFiles(deps)).resolves.toEqual({ kind: "no-opener" });
    expect(ch.count).toBe(0);
  });

  it("says ready to the opener at the old origin only, asks first, imports, and answers with the counts", async () => {
    const { deps, ch, opener, confirm, apply, prepare } = receiver();
    const states: string[] = [];
    const result = receiveFiles({ ...deps, onState: (s) => states.push(s) });
    expect(opener.posted).toEqual([{ data: READY, origin: FROM }]);
    ch.send({ origin: FROM, source: opener, data: offer() });
    await expect(result).resolves.toEqual({ kind: "done", added: 3, skipped: 1 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(4);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(opener.posted.at(-1)).toEqual({ data: { type: "codeeditor-move-done", v: 1, added: 3, skipped: 1 }, origin: FROM });
    expect(states).toEqual(["waiting", "asking", "importing", "done"]);
    expect(ch.count).toBe(0);
  });

  it("ignores a message from a third origin, or from a window that isn't the opener, and still takes the real one", async () => {
    const { deps, ch, opener, apply } = receiver();
    const ignored: number[] = [];
    const result = receiveFiles({ ...deps, onIgnored: (n) => ignored.push(n) });
    ch.send({ origin: EVIL, source: opener, data: offer() });
    ch.send({ origin: FROM, source: fakeWindow(), data: offer() });
    ch.send({ origin: FROM, source: null, data: offer() });
    await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(ignored).toEqual([1, 2, 3]);
    ch.send({ origin: FROM, source: opener, data: offer() });
    await expect(result).resolves.toEqual({ kind: "done", added: 3, skipped: 1 });
  });

  it("takes exactly one offer: a second one is never imported", async () => {
    const { deps, ch, opener, apply } = receiver();
    const result = receiveFiles(deps);
    ch.send({ origin: FROM, source: opener, data: offer() });
    ch.send({ origin: FROM, source: opener, data: offer() });
    await result;
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("refuses a zip that isn't a Blob, or is too big, without asking", async () => {
    for (const zip of ["not a blob", new Uint8Array(30), zipBlob(1001)]) {
      const { deps, ch, opener, confirm, prepare } = receiver();
      const result = receiveFiles(deps);
      ch.send({ origin: FROM, source: opener, data: offer(zip) });
      await expect(result).resolves.toEqual({ kind: "refused", reason: "invalid" });
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(opener.posted.at(-1)?.data).toEqual({ type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "invalid" });
    }
  });

  it("a zip the import pipeline rejects is refused", async () => {
    const { deps, ch, opener, confirm } = receiver({ prepare: async () => Promise.reject(new Error("This isn't a zip file.")) });
    const result = receiveFiles(deps);
    ch.send({ origin: FROM, source: opener, data: offer() });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "invalid" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a No in the dialog imports nothing", async () => {
    const { deps, ch, opener, apply } = receiver({ confirm: async () => false });
    const result = receiveFiles(deps);
    ch.send({ origin: FROM, source: opener, data: offer() });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "declined" });
    expect(apply).not.toHaveBeenCalled();
    expect(opener.posted.at(-1)?.data).toEqual({ type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "declined" });
  });

  it("a read-only tab imports nothing and says so to the opener", async () => {
    const { deps, ch, opener, apply, confirm } = receiver({ canWrite: () => false });
    const result = receiveFiles(deps);
    ch.send({ origin: FROM, source: opener, data: offer() });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "read-only" });
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(opener.posted.at(-1)?.data).toEqual({ type: "codeeditor-move-done", v: 1, added: 0, skipped: 0, error: "read-only" });
  });
});
