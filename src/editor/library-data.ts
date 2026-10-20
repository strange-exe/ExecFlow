// Library names for suggestions, loaded on demand: the standard library a Python file can import
// (data/python-stdlib.json, written in Pyodide 314.0.7 by scripts/gen-python-completions.mjs) and
// the C and C++ library (data/c-library.json, written from the C/C++ pack's sysroot by
// scripts/gen-c-completions.mjs). Each file is its own lazy chunk (a dynamic import), so neither
// is part of the first visit or of the editor's CodeMirror chunk, and the service worker precaches
// them with every other chunk. Loading starts when a file of that language is first shown
// (library-completion.ts libraryLoader) or at the first suggestion request. Until the data is
// there, and if it never arrives (offline before any visit), the library sources offer nothing and
// everything else works as before: no error, no spinner, nothing in the console.

export type LibraryId = "python" | "c";
export type LibraryStatus = "idle" | "loading" | "ready" | "failed";

/** Kinds the Python data uses (each is one of CodeMirror's base icons). */
export type PythonKind = "class" | "constant" | "function" | "namespace" | "variable";

export interface PythonLibrary {
  /** Top-level standard modules that import and work in the browser, sorted. */
  modules: readonly string[];
  /** Module (dotted for submodules, e.g. "os.path") -> kind -> name -> signature or null. */
  members: Readonly<Record<string, Partial<Record<PythonKind, Readonly<Record<string, string | null>>>>>>;
}

export interface CFunction {
  name: string;
  header: string;
  /** The declaration as clang sees it in gnu11, attributes removed. */
  proto: string;
  /** The -std settings that declare it; absent means all of them. */
  modes?: readonly string[];
}

export interface CMacro {
  name: string;
  header: string;
  kind: "constant" | "type";
  value?: string;
  modes?: readonly string[];
}

export interface StdName {
  name: string;
  kind: "class" | "function" | "variable";
  header: string;
  /** The first -std setting that has it. */
  since: string;
}

export interface CLibrary {
  header: { modes: { c: readonly string[]; cpp: readonly string[] } };
  /** since: the first C++ -std setting a libc++ header has any content in (absent: all of them). */
  headers: { c: readonly string[]; cpp: readonly string[]; since?: Readonly<Record<string, string>> };
  functions: readonly CFunction[];
  macros: readonly CMacro[];
  std: readonly StdName[];
}

interface Libraries {
  python: PythonLibrary;
  c: CLibrary;
}

/** A failed load (offline before the chunk was ever cached) is tried again at most this often. */
export const RETRY_MS = 30_000;

const isList = (v: unknown) => Array.isArray(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The shape checks: generated files from our own origin, but a wrong file must not break typing. */
const VALID: { [K in LibraryId]: (d: unknown) => d is Libraries[K] } = {
  python: (d): d is PythonLibrary => isObject(d) && isList(d.modules) && isObject(d.members),
  c: (d): d is CLibrary =>
    isObject(d) && isObject(d.header) && isObject(d.header.modes) && isObject(d.headers) && isList(d.headers.c) && isList(d.headers.cpp) &&
    isList(d.functions) && isList(d.macros) && isList(d.std),
};

// Vite turns each JSON file into a module of its own; a dynamic import makes it a separate chunk.
const LOADERS: { [K in LibraryId]: () => Promise<unknown> } = {
  python: () => import("./data/python-stdlib.json").then((m) => m.default),
  c: () => import("./data/c-library.json").then((m) => m.default),
};

interface Slot {
  status: LibraryStatus;
  data: unknown;
  pending: Promise<boolean> | null;
  failedAt: number;
}

const slots: Record<LibraryId, Slot> = {
  python: { status: "idle", data: null, pending: null, failedAt: 0 },
  c: { status: "idle", data: null, pending: null, failedAt: 0 },
};

/** The library's data once it has loaded, else null (a source then offers nothing from it). */
export function library<K extends LibraryId>(id: K): Libraries[K] | null {
  return slots[id].status === "ready" ? (slots[id].data as Libraries[K]) : null;
}

export function libraryStatus(id: LibraryId): LibraryStatus {
  return slots[id].status;
}

/**
 * Starts loading (once; a failure is retried after RETRY_MS) and resolves true when the data is
 * there. Never rejects and never logs: a failed load leaves the library "failed".
 */
export function loadLibrary(id: LibraryId, now: () => number = Date.now): Promise<boolean> {
  const slot = slots[id];
  if (slot.status === "ready") return Promise.resolve(true);
  if (slot.pending) return slot.pending;
  if (slot.status === "failed" && now() - slot.failedAt < RETRY_MS) return Promise.resolve(false);
  slot.status = "loading";
  slot.pending = LOADERS[id]().then(
    (data) => {
      slot.pending = null;
      if (!VALID[id](data)) throw new Error("not library data");
      slot.data = data;
      slot.status = "ready";
      return true;
    },
  ).catch(() => {
    slot.pending = null;
    slot.status = "failed";
    slot.failedAt = now();
    return false;
  });
  return slot.pending;
}
