// Command-line arguments for a run: the Arguments field's text, split the way a shell splits a
// simple command, and kept per file. Pure parsing and a small per-file memory; the workbench saves
// the memory in the workspace's UI state (storage/workspace.ts setRunArgs).
//
// Splitting: words end at spaces, tabs and line breaks (ASCII whitespace only, so a no-break space
// stays inside a word, as in a shell). '...' and "..." keep spaces inside one argument and join the
// text next to them (a"b c"d is "ab cd"); "" is an empty argument. Nothing else is special: no
// escapes (a backslash is a character) and no expansion ($HOME, *, $(...), ;, | and > are text),
// because no shell ever sees the arguments: they go straight into sys.argv or argv.

import type { WsPath } from "../core/types";

/** At most this many arguments per run. */
export const MAX_ARGS = 100;
/** At most this many characters (code points, as the student counts them) of argument text. */
export const MAX_ARGS_CHARS = 4096;

export type ParsedArgs = { ok: true; args: string[] } | { ok: false; reason: string };

const SPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const QUOTES = new Set(["'", '"']);

const count = (n: number) => n.toLocaleString("en");
/** A no-break space: it keeps a quote mark on the line of the word before it. */
const NBSP = String.fromCodePoint(0xa0);

/** The arguments in `text`, or why it can't be split. */
export function parseArgs(text: string): ParsedArgs {
  const chars = Array.from(text); // code points: the length and a position count what the student sees
  if (chars.length > MAX_ARGS_CHARS) {
    return { ok: false, reason: `The arguments are ${count(chars.length)} characters long; the limit is ${count(MAX_ARGS_CHARS)}, so shorten them.` };
  }
  const args: string[] = [];
  let word: string | null = null; // null: between words
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (SPACE.has(c)) {
      if (word !== null) args.push(word);
      word = null;
    } else if (QUOTES.has(c)) {
      const close = chars.indexOf(c, i + 1);
      if (close < 0) return { ok: false, reason: `The quote mark${NBSP}${c} at character ${i + 1} is never closed, so add another${NBSP}${c} or remove it.` };
      word = (word ?? "") + chars.slice(i + 1, close).join("");
      i = close;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) args.push(word);
  if (args.length > MAX_ARGS) {
    return { ok: false, reason: `That is ${count(args.length)} arguments; the limit is ${count(MAX_ARGS)}, so remove some.` };
  }
  return { ok: true, args };
}

/**
 * The arguments as one line a student can read and type back: plain where that splits the same,
 * otherwise in quotes ("two words", '"quoted"', "" for an empty one). parseArgs gives them back.
 */
export function formatArgs(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg === "") return '""';
  if (!Array.from(arg).some((c) => SPACE.has(c) || QUOTES.has(c))) return arg;
  if (!arg.includes('"')) return `"${arg}"`;
  if (!arg.includes("'")) return `'${arg}'`;
  // Both quote kinds: each run of text goes in the quote it doesn't contain, joined without spaces.
  return arg.split('"').map((part) => (part ? `"${part}"` : "")).join(`'"'`);
}

/** Where the per-file texts are kept between visits. */
export interface RunArgsStore {
  load(): Promise<Record<WsPath, string>>;
  /** Saves one file's text; "" removes it. */
  save(path: WsPath, text: string): Promise<void>;
}

/**
 * The Arguments text of each file, as typed. This tab's copy is what the field and Run read; every
 * change is also saved. A load (at start, or when another tab may have written) never replaces a
 * text whose save is still on its way.
 */
export class RunArgsMemory {
  private texts = new Map<WsPath, string>();
  private saving = new Map<WsPath, number>();
  private listeners = new Set<() => void>();

  constructor(private readonly store: RunArgsStore | null) {}

  get(path: WsPath): string {
    return this.texts.get(path) ?? "";
  }

  set(path: WsPath, text: string): void {
    if (this.get(path) === text) return;
    if (text) this.texts.set(path, text);
    else this.texts.delete(path);
    if (!this.store) return;
    this.saving.set(path, (this.saving.get(path) ?? 0) + 1);
    void this.store
      .save(path, text)
      .catch(() => {}) // a read-only tab, or storage refused: the text lasts for this visit
      .finally(() => {
        const left = (this.saving.get(path) ?? 1) - 1;
        if (left > 0) this.saving.set(path, left);
        else this.saving.delete(path);
      });
  }

  /** A file or folder was renamed (`to`) or deleted (null): its texts follow it or go. */
  moved(from: WsPath, to: WsPath | null): void {
    for (const [path, text] of [...this.texts]) {
      const inside = path === from || path.startsWith(`${from}/`);
      if (!inside) continue;
      this.texts.delete(path);
      if (to !== null) this.texts.set(to + path.slice(from.length), text);
    }
  }

  /** Reads the saved texts again; tells listeners when something shown may have changed. */
  async load(): Promise<void> {
    if (!this.store) return;
    let saved: Record<WsPath, string>;
    try {
      saved = await this.store.load();
    } catch {
      return;
    }
    const next = new Map<WsPath, string>();
    for (const [path, text] of Object.entries(saved)) if (typeof text === "string" && text) next.set(path, text);
    for (const path of this.saving.keys()) {
      const mine = this.texts.get(path);
      if (mine === undefined) next.delete(path);
      else next.set(path, mine);
    }
    const changed = next.size !== this.texts.size || [...next].some(([p, t]) => this.texts.get(p) !== t);
    this.texts = next;
    if (changed) for (const fn of [...this.listeners]) fn();
  }

  onLoad(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
