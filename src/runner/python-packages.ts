// Python packages CodeEditor serves itself (the user's choice, 2026-10-17): numpy and pandas plus what
// they depend on, exactly as Pyodide built them. scripts/fetch-pyodide-packages.mjs downloads this set
// into the runtime folder (sha256-checked against pyodide-lock.json), and the worker loads it before
// the lockdown, because a worker running user code has no network.
//
// This file is also imported by scripts/fetch-pyodide-packages.mjs (Node strips the types), so it
// imports nothing and uses only syntax Node can strip.

/** What programs can import besides the standard library. Their dependencies come along. */
export const PYTHON_PACKAGES: readonly string[] = ["numpy", "pandas"];

/** The parts of a pyodide-lock.json entry these helpers read. */
export interface LockEntry {
  name: string;
  version: string;
  file_name: string;
  sha256: string;
  depends: string[];
  imports: string[];
}

export interface LockFile {
  packages: Record<string, LockEntry>;
}

/** PEP 503 normalisation, the form pyodide-lock.json uses for its keys and `depends`. */
export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function entryKey(lock: LockFile, name: string): string {
  const wanted = canonicalName(name);
  const key = Object.keys(lock.packages).find((k) => canonicalName(k) === wanted);
  if (!key) throw new Error(`pyodide-lock.json has no package "${name}"`);
  return key;
}

/** `roots` and everything they depend on, as lock-file keys, dependencies before dependents. */
export function packageClosure(lock: LockFile, roots: readonly string[]): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    const key = entryKey(lock, name);
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") throw new Error(`pyodide-lock.json has a dependency cycle at "${key}"`);
    state.set(key, "visiting");
    for (const dep of lock.packages[key].depends) visit(dep);
    state.set(key, "done");
    order.push(key);
  };
  for (const root of roots) visit(root);
  return order;
}

/** Top-level import name ("dateutil") -> package ("python-dateutil"), for the packages given. */
export function importIndex(lock: LockFile, packages: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of packages) {
    const key = entryKey(lock, name);
    for (const imp of lock.packages[key].imports) index.set(imp.split(".")[0], key);
  }
  return index;
}

/**
 * Supported packages a program imports that this interpreter hasn't loaded. `imports` are the
 * program's top-level third-party import names; `unavailable` packages failed to load earlier in
 * the session and aren't asked for again (the import then fails with a note instead).
 */
export function missingPackages(
  imports: Iterable<string>,
  index: ReadonlyMap<string, string>,
  loaded: Iterable<string>,
  unavailable: Iterable<string> = [],
): string[] {
  const have = new Set([...loaded, ...unavailable].map(canonicalName));
  const missing = new Set<string>();
  for (const name of imports) {
    const pkg = index.get(name);
    if (pkg && !have.has(canonicalName(pkg))) missing.add(pkg);
  }
  return [...missing].sort();
}

/**
 * The package list for the next worker: what the current one was started with plus `missing`,
 * keeping only names this build can load (`available`, reported by a worker before any user code
 * ran). Sorted, so the same set always gives the same list. null when nothing would change.
 */
export function nextPackageSet(current: readonly string[], missing: readonly string[], available: readonly string[]): string[] | null {
  const allowed = new Set(available.map(canonicalName));
  const next = new Set(current.filter((p) => allowed.has(canonicalName(p))));
  let added = false;
  for (const name of missing) {
    if (!allowed.has(canonicalName(name)) || [...next].some((p) => canonicalName(p) === canonicalName(name))) continue;
    next.add(name);
    added = true;
  }
  return added ? [...next].sort() : null;
}
