// The About page's light/dark toggle (redesign 9, Living Graph). The page opens in the scheme
// theme-boot.js chose (the device's, or the editor's saved theme); the toggle overrides it for this
// page only, remembered under ABOUT_SCHEME_KEY, which public/about-boot.js reads before the first
// paint. The editor's own theme is never touched. Pure apart from apply(), so the rules are unit tested.

export type Scheme = "light" | "dark";

/** A codeeditor: key, so "Sign out and clear" removes it with the rest. */
export const ABOUT_SCHEME_KEY = "codeeditor:about-scheme";

/** The page's ground per scheme (about-tokens.css --lg-ground), for the browser's toolbar colour. */
export const GROUND: Readonly<Record<Scheme, string>> = { light: "#f4f4f6", dark: "#0c0c0e" };

export function otherScheme(s: Scheme): Scheme {
  return s === "dark" ? "light" : "dark";
}

/** A stored value read back: light or dark, anything else (nothing, a damaged value) is no choice. */
export function savedScheme(value: unknown): Scheme | null {
  return value === "light" || value === "dark" ? value : null;
}

/** Shows `s` on the page and in the toolbar, and remembers it (storage may throw: the switch still works). */
export function applyScheme(s: Scheme): void {
  document.documentElement.dataset.theme = s;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = GROUND[s];
  try {
    localStorage.setItem(ABOUT_SCHEME_KEY, s);
  } catch {
    // Blocked site data or a private window: the toggle still works for this visit.
  }
}
