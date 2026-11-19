// "Joined symbols" in code (from Pocket Run's src/ligatures.ts, same author, MIT). Code is set in
// Geist Mono, whose coding ligatures (Stylistic Set 11) join symbols such as != and ->; this
// setting turns them on and changes nothing else (the font stays). Off by default, so code shows
// exactly the characters typed; this is the opt-in. public/theme-boot.js applies the choice before
// first paint, and tokens.css turns ligatures off everywhere, and ss11 on, by <html data-ligatures>.
export const LIGATURES_KEY = "codeeditor:ligatures";

export function ligaturesOn(): boolean {
  try {
    return localStorage.getItem(LIGATURES_KEY) === "on";
  } catch {
    return false;
  }
}

export function setLigatures(on: boolean): void {
  if (on) document.documentElement.dataset.ligatures = "on";
  else delete document.documentElement.dataset.ligatures;
  try {
    if (on) localStorage.setItem(LIGATURES_KEY, "on");
    else localStorage.removeItem(LIGATURES_KEY);
  } catch {
    // storage blocked: applies to this visit only
  }
}
