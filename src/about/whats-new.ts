// Whether to tell someone what's new: once after the app updates, never on a first visit and never
// for a rollback. The version seen last is kept in localStorage; every read and write may throw
// (private windows, blocked site data), and then nothing is shown.

export const LAST_SEEN_KEY = "codeeditor:last-seen-version";

/** The part of localStorage this needs (tests pass a map). */
export type VersionStore = Pick<Storage, "getItem" | "setItem">;

const parts = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);

/** Whether version `a` is newer than `b`, compared as numbers (0.10.0 is newer than 0.9.9). */
export function newerThan(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * The version to announce (`current`), or null. Remembers `current` either way. `returning`: the
 * workspace existed before this visit. With no version remembered, a returning student used
 * ExecFlow before versions were remembered (they count as updated); anyone else is new. (Other
 * localStorage keys can't tell: the theme writes its paint on every start.)
 */
export function whatsNew(store: VersionStore | null, current: string, returning: boolean): string | null {
  if (!store) return null;
  try {
    const seen = store.getItem(LAST_SEEN_KEY) ?? (returning ? "0.0.0" : current);
    store.setItem(LAST_SEEN_KEY, current);
    return newerThan(current, seen) ? current : null;
  } catch {
    return null;
  }
}
