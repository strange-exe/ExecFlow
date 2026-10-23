// The first thing src/main.ts does: if GitHub sent the student back to /auth-callback, take the
// one-time code, state and error from the URL and replace the address with "/" at once, before any
// other code runs or loads, so the code leaves the address bar and the history. The sync screens
// pick the values up later (takeCallback). Kept tiny: it is part of every first visit.

/** One path segment, so the page's relative URLs (icons, theme-boot.js) still resolve at the root. */
export const CALLBACK_PATH = "/auth-callback";

export interface AuthCallback {
  code: string | null;
  state: string | null;
  error: string | null;
}

let captured: AuthCallback | null = null;

export function captureCallback(loc: Pick<Location, "pathname" | "search"> = location, hist: Pick<History, "replaceState"> = history): void {
  if (loc.pathname !== CALLBACK_PATH) return;
  const query = new URLSearchParams(loc.search);
  const take = (name: string) => query.get(name)?.slice(0, 512) ?? null;
  captured = { code: take("code"), state: take("state"), error: take("error") };
  hist.replaceState(null, "", "/");
}

/** The callback this page load came with (once): null when it came with none. */
export function takeCallback(): AuthCallback | null {
  const value = captured;
  captured = null;
  return value;
}
