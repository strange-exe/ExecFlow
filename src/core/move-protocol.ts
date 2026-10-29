// The one-click move from the site's old address to its new one (release 0.12.0). Browser storage
// belongs to one origin, so files kept at the old address can't be read at the new one: the old
// address hands them over in the browser, as a .zip Blob in a postMessage, and the new one imports
// that zip through the normal import pipeline (src/storage/zip.ts readZip, then importFiles).
//
// The messages, each with v: 1:
//   new -> old  {type: "codeeditor-move-ready"}                      the new tab is listening
//   old -> new  {type: "codeeditor-move", zip: Blob, count}          the files
//   new -> old  {type: "codeeditor-move-done", added, skipped, error?}
//
// Every message is taken only from the expected ORIGIN and the expected WINDOW (the tab the old
// address opened, or the new tab's opener), and every message is posted with that exact target
// origin, never "*". The address opened is a build-time constant, never input. DOM-free, so the
// unit tests drive both halves with fake windows; src/ui/address-move.ts wires it to the page.
// https://html.spec.whatwg.org/multipage/web-messaging.html#authors

/** Where the hand-over happens at both addresses (served without COOP: see address-move.ts). */
export const MOVE_PATH = "/move";
/** What tells the new address's page that the old one opened it to receive files. */
export const MOVE_HASH = "#move-from";
/** The whole hand-over, from the new tab opening to the answer. */
export const MOVE_TIMEOUT_MS = 60_000;
/** How often the old address checks the new tab is still open. */
export const CLOSED_POLL_MS = 500;

export type MoveRole = "from" | "to";

/** "from" at the old address, "to" at the new one, null anywhere else (a preview, localhost). */
export function moveRole(origin: string, from: string, to: string): MoveRole | null {
  if (origin === from) return "from";
  if (origin === to) return "to";
  return null;
}

/** The parts of a window this code uses (a real Window, or a fake in the tests). */
export interface PeerWindow {
  postMessage(data: unknown, targetOrigin: string): void;
  readonly closed: boolean;
  close(): void;
}

/** The parts of a MessageEvent this code reads. */
export interface MoveEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The one check every incoming message passes first: exactly this origin, exactly this window. */
export function fromPeer(event: MoveEvent, origin: string, peer: unknown): boolean {
  return event.origin === origin && event.source !== null && event.source === peer;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function isReady(data: unknown): boolean {
  return isRecord(data) && data.type === "codeeditor-move-ready" && data.v === 1;
}

export type RefusalReason = "invalid" | "declined" | "read-only";
const REASONS: ReadonlySet<string> = new Set<RefusalReason>(["invalid", "declined", "read-only"]);

export interface DoneMessage {
  type: "codeeditor-move-done";
  v: 1;
  added: number;
  skipped: number;
  error?: RefusalReason;
}

export function isDone(data: unknown): data is DoneMessage {
  return (
    isRecord(data) &&
    data.type === "codeeditor-move-done" &&
    data.v === 1 &&
    isCount(data.added) &&
    isCount(data.skipped) &&
    (data.error === undefined || (typeof data.error === "string" && REASONS.has(data.error)))
  );
}

/** The files message: v 1 and a real Blob of 1 to maxBytes bytes. `count` is only a hint, never trusted. */
export function checkOffer(data: unknown, maxBytes: number): { ok: true; zip: Blob } | { ok: false } {
  if (!isRecord(data) || data.type !== "codeeditor-move" || data.v !== 1) return { ok: false };
  const zip = data.zip;
  if (!(zip instanceof Blob) || zip.size < 1 || zip.size > maxBytes) return { ok: false };
  return { ok: true, zip };
}

const done = (added: number, skipped: number, error?: RefusalReason): DoneMessage =>
  error ? { type: "codeeditor-move-done", v: 1, added, skipped, error } : { type: "codeeditor-move-done", v: 1, added, skipped };

// ---------------------------------------------------------------- the old address

export interface SendDeps {
  /** The new address's origin (a build-time constant). */
  to: string;
  /** window.open; null when a popup blocker stopped it. */
  open(url: string): PeerWindow | null;
  /** Adds a message listener; returns its removal. */
  listen(handler: (event: MoveEvent) => void): () => void;
  /** The workspace as a .zip (the export's own code). */
  buildZip(): Promise<{ blob: Blob; count: number }>;
  onState?(state: "waiting" | "sent" | "done"): void;
}

export type SendResult =
  | { kind: "done"; added: number; skipped: number }
  | { kind: "refused"; reason: RefusalReason }
  | { kind: "blocked" }
  | { kind: "closed" }
  | { kind: "timeout" }
  | { kind: "failed"; reason: string };

/**
 * Opens the new address and hands it the files. The tab is opened FIRST, while the click's user
 * activation still holds (a popup opened after awaiting the zip is blocked, Safari above all), and
 * the zip is built meanwhile.
 */
export function sendFiles(deps: SendDeps): Promise<SendResult> {
  const win = deps.open(deps.to + MOVE_PATH + MOVE_HASH);
  if (!win) return Promise.resolve({ kind: "blocked" });
  const zip = deps.buildZip();
  return new Promise<SendResult>((resolve) => {
    let finished = false;
    let sent = false;
    const finish = (result: SendResult, closeTab = false) => {
      if (finished) return;
      finished = true;
      stop();
      clearTimeout(timer);
      clearInterval(poll);
      if (closeTab) win.close();
      if (result.kind === "done") deps.onState?.("done");
      resolve(result);
    };
    const stop = deps.listen((event) => {
      if (finished || !fromPeer(event, deps.to, win)) return;
      if (isReady(event.data) && !sent) {
        sent = true;
        zip.then(
          ({ blob, count }) => {
            if (finished) return;
            // The exact origin, never "*": if that tab has gone somewhere else, nothing is delivered.
            win.postMessage({ type: "codeeditor-move", v: 1, zip: blob, count }, deps.to);
            deps.onState?.("sent");
          },
          () => {},
        );
      } else if (isDone(event.data) && sent) {
        const d = event.data;
        finish(d.error ? { kind: "refused", reason: d.error } : { kind: "done", added: d.added, skipped: d.skipped });
      }
    });
    zip.catch((e: unknown) => finish({ kind: "failed", reason: e instanceof Error ? e.message : String(e) }, true));
    const timer = setTimeout(() => finish({ kind: "timeout" }, true), MOVE_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (win.closed) finish({ kind: "closed" });
    }, CLOSED_POLL_MS);
    deps.onState?.("waiting");
  });
}

// ---------------------------------------------------------------- the new address

export interface ReceiveDeps {
  /** The old address's origin (a build-time constant). */
  from: string;
  /** window.opener: the tab at the old address that opened this one, or null. */
  opener: PeerWindow | null;
  listen(handler: (event: MoveEvent) => void): () => void;
  /** Whether this tab may write the workspace (it holds the writer lock). */
  canWrite(): boolean;
  /** The import size limit for the zip. */
  maxBytes: number;
  /** Reads the zip with the import pipeline (it throws on a hostile or broken zip). */
  prepare(zip: Blob): Promise<{ count: number; apply(): Promise<{ added: number; skipped: number }> }>;
  /** Asks the student; nothing is imported without a yes. */
  confirm(count: number): Promise<boolean>;
  onState?(state: "waiting" | "asking" | "importing" | "done" | "refused"): void;
  /** Called with the running count of messages ignored (wrong origin or wrong window). */
  onIgnored?(count: number): void;
}

export type ReceiveResult =
  | { kind: "done"; added: number; skipped: number }
  | { kind: "refused"; reason: RefusalReason }
  | { kind: "no-opener" }
  | { kind: "timeout" }
  | { kind: "failed"; reason: string };

/** Tells the opener it is ready, then takes exactly one files message from it. */
export function receiveFiles(deps: ReceiveDeps): Promise<ReceiveResult> {
  const opener = deps.opener;
  if (!opener) return Promise.resolve({ kind: "no-opener" });
  return new Promise<ReceiveResult>((resolve) => {
    let ignored = 0;
    let taken = false;
    const answer = (message: DoneMessage) => {
      try {
        opener.postMessage(message, deps.from);
      } catch {
        // the opener has gone: the result still shows here
      }
    };
    const end = (result: ReceiveResult) => {
      deps.onState?.(result.kind === "done" ? "done" : "refused");
      resolve(result);
    };
    const refuse = (reason: RefusalReason) => {
      answer(done(0, 0, reason));
      end({ kind: "refused", reason });
    };
    const stop = deps.listen((event) => {
      if (taken) return;
      if (!fromPeer(event, deps.from, opener)) {
        deps.onIgnored?.(++ignored);
        return;
      }
      // Exactly one message from the opener is taken, whatever it holds.
      taken = true;
      stop();
      clearTimeout(timer);
      void take(event.data);
    });
    const timer = setTimeout(() => {
      if (taken) return;
      taken = true;
      stop();
      end({ kind: "timeout" });
    }, MOVE_TIMEOUT_MS);

    async function take(data: unknown) {
      const offer = checkOffer(data, deps.maxBytes);
      if (!offer.ok) return refuse("invalid");
      if (!deps.canWrite()) return refuse("read-only");
      let prepared: Awaited<ReturnType<ReceiveDeps["prepare"]>>;
      try {
        prepared = await deps.prepare(offer.zip);
      } catch {
        return refuse("invalid");
      }
      deps.onState?.("asking");
      if (!(await deps.confirm(prepared.count))) return refuse("declined");
      // The answer took time: the writer lock may have moved to another tab meanwhile.
      if (!deps.canWrite()) return refuse("read-only");
      deps.onState?.("importing");
      try {
        const { added, skipped } = await prepared.apply();
        answer(done(added, skipped));
        end({ kind: "done", added, skipped });
      } catch (e) {
        answer(done(0, 0, "invalid"));
        deps.onState?.("refused");
        resolve({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
      }
    }

    deps.onState?.("waiting");
    // The target origin is the old address: if the opener is anything else, the browser drops it.
    opener.postMessage({ type: "codeeditor-move-ready", v: 1 }, deps.from);
  });
}
