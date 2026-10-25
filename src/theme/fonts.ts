// The code font's italic face, loaded ahead of its first use. The browser downloads a face only
// when text uses it (tokens.css), and code's italic is first used by the first edit (the unsaved
// tab's name and the breadcrumb) or a comment. Loading it then put one long task into that
// keystroke: while the 12 KB file downloaded, Chromium mapped system fallback fonts on the main
// thread and laid the text out again when the face came (111-161 ms at 4x CPU slowdown, speed
// profile 2026-10-19). So once the editor view exists (editor/host.ts viewHost: the first file
// shown, or the editor fetched early when the pointer heads for the file list) it is loaded when
// the page is next idle, with the CSS Font Loading API (w3.org/TR/css-font-loading-3,
// FontFaceSet.load()), which draws nothing. The file is precached with the app, so this works
// offline too. The code font is JetBrains Mono in every theme ("Joined symbols" turns on its
// ligatures only, never another font), so this is needed once. Only the editor chunk imports this
// file, so the first visit doesn't carry it.

/** How long an idle callback may wait while the page stays busy (ms). */
const IDLE_TIMEOUT_MS = 2000;
/** Where there is no requestIdleCallback (WebKit): after this delay instead (ms). */
const FALLBACK_MS = 1000;

/** Runs `run` when the page is next idle (requestIdleCallback), or after FALLBACK_MS without it. */
export function atIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => run(), { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(run, FALLBACK_MS);
}

/**
 * Loads the italic face of the code font (--font-code, JetBrains Mono). Never rejects and never
 * logs: a load that fails, or that a reload cancels (Firefox and WebKit then reject with a
 * NetworkError), only means the face loads at its first use, as before.
 */
export function loadCodeItalic(): void {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
  if (!family || !("fonts" in document)) return;
  document.fonts.load(`italic 400 1em ${family}`).catch(() => undefined);
}
