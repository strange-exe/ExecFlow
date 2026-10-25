// "Joined symbols" in code (from Pocket Run's src/ligatures.ts, same author, MIT). Code is set in
// JetBrains Mono, whose ligatures draw != as one symbol and -> as an arrow; this setting turns them
// on and changes nothing else (the font stays). Off by default, so code shows exactly the
// characters typed; this is the opt-in. public/theme-boot.js applies the choice before first paint,
// and tokens.css turns ligatures off everywhere unless <html data-ligatures="on">.
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
