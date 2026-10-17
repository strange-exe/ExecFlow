// Paints the saved colour theme before anything is drawn, so there is no flash of the wrong one
// (from Pocket Run's public/theme-boot.js, same author, MIT). Loaded as a small blocking script in
// index.html's <head>: a file, not inline, so the Content-Security-Policy can forbid inline scripts.
// Written by applyTheme() in src/theme/themes.ts; only #rrggbb values for known names are applied.
(function () {
  // CodeEditor Slate's top-bar colour per scheme (src/theme/palettes.ts SLATE surface; a unit test
  // keeps them equal). Slate's own colours are in tokens.css, so nothing else is needed for it.
  var SLATE_SURFACE = { light: "#f6f8fa", dark: "#14171d" };
  var root = document.documentElement, saved = null;
  try { saved = JSON.parse(localStorage.getItem("codeeditor:theme-paint")); } catch (e) {}
  if (!saved || typeof saved !== "object") saved = { system: true, scheme: "light", colors: null };
  var dark = matchMedia("(prefers-color-scheme: dark)").matches;
  var scheme = saved.system ? (dark ? "dark" : "light") : saved.scheme === "dark" ? "dark" : "light";
  root.dataset.theme = scheme;
  var colors = !saved.system && saved.colors && typeof saved.colors === "object" ? saved.colors : null;
  if (colors) for (var k in colors) {
    if (/^[a-z-]{2,20}$/.test(k) && /^#[0-9a-f]{6}$/i.test(colors[k])) root.style.setProperty("--" + k, colors[k]);
  }
  // The browser's toolbar colour follows the theme too (the <meta> tags come before this script).
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var own = /dark/.test(metas[i].getAttribute("media") || "") ? "dark" : "light";
    var surface = colors && /^#[0-9a-f]{6}$/i.test(colors.surface) ? colors.surface : SLATE_SURFACE[saved.system ? own : scheme];
    metas[i].setAttribute("content", surface);
  }
  // Joined symbols in code (ligatures) are opt-in: src/theme/ligatures.ts.
  var ligatures = null;
  try { ligatures = localStorage.getItem("codeeditor:ligatures"); } catch (e) {}
  if (ligatures === "on") root.dataset.ligatures = "on";
})();
