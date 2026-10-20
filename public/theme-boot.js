// Paints the saved colour theme before anything is drawn, so there is no flash of the wrong one
// (from Pocket Run's public/theme-boot.js, same author, MIT). Loaded as a small blocking script in
// index.html's <head>: a file, not inline, so the Content-Security-Policy can forbid inline scripts.
// Written by applyTheme() in src/theme/themes.ts. Only the colour contract's names are applied
// (COLORS: never a layout, size or font token), each as #rrggbb, or #rrggbbaa for the four band
// tokens that may be translucent.
(function () {
  // The chrome colour per own palette and scheme (src/theme/palettes.ts DEEP_FIELD and SLATE
  // surface; a unit test keeps them equal). Their other colours are in tokens.css: Deep Field on
  // :root, Slate under data-palette="slate", so nothing else is needed for them.
  var OWN_SURFACE = { "deep-field": { light: "#dbeee2", dark: "#152a22" }, slate: { light: "#f6f8fa", dark: "#14171d" } };
  // src/theme/contrast.ts COLOR_VARS, in order (contrast.test.ts keeps them equal).
  var COLORS = "bg surface surface-raised terminal-bg terminal-fg runlog-bg divider border border-strong text text-secondary text-muted gutter-text action action-hover on-action control-on focus selection list-selected active-line location danger warning success info error-band call-site input-echo link brand on-brand syn-keyword syn-string syn-number syn-comment syn-function syn-type syn-variable syn-operator syn-macro syn-punctuation".split(" ");
  var BANDS = { "active-line": true, "error-band": true, selection: true, "list-selected": true };
  var root = document.documentElement, saved = null;
  try { saved = JSON.parse(localStorage.getItem("codeeditor:theme-paint")); } catch (e) {}
  // Nothing stored: the default, Deep Field following the device.
  if (!saved || typeof saved !== "object") saved = { system: true, scheme: "light", palette: "deep-field", colors: null };
  var colors = !saved.system && saved.colors && typeof saved.colors === "object" ? saved.colors : null;
  var palette = saved.palette;
  // Written before Deep Field (no "palette" field): the only own palette was Slate, so a payload
  // without colours is Slate (its "match device" included) and one with colours a palette theme.
  if (palette === undefined) palette = colors ? "palette" : "slate";
  if (palette !== "deep-field" && palette !== "slate" && palette !== "palette") palette = "deep-field";
  if (palette !== "palette") colors = null;
  else if (!colors) palette = "deep-field"; // a palette theme with nothing to paint: the default's colours
  var dark = matchMedia("(prefers-color-scheme: dark)").matches;
  var scheme = saved.system ? (dark ? "dark" : "light") : saved.scheme === "dark" ? "dark" : "light";
  root.dataset.theme = scheme;
  if (palette !== "deep-field") root.dataset.palette = palette;
  var valid = function (name, value) {
    return COLORS.indexOf(name) >= 0 && typeof value === "string" && (BANDS[name] ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i).test(value);
  };
  if (colors) for (var n = 0; n < COLORS.length; n++) {
    if (valid(COLORS[n], colors[COLORS[n]])) root.style.setProperty("--" + COLORS[n], colors[COLORS[n]]);
  }
  // The browser's toolbar colour follows the theme too (the <meta> tags come before this script).
  var own = OWN_SURFACE[palette === "slate" ? "slate" : "deep-field"];
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var metaScheme = /dark/.test(metas[i].getAttribute("media") || "") ? "dark" : "light";
    var surface = colors && valid("surface", colors.surface) ? colors.surface : own[saved.system ? metaScheme : scheme];
    metas[i].setAttribute("content", surface);
  }
  // Joined symbols in code (ligatures, drawn with JetBrains Mono) are opt-in: src/theme/ligatures.ts.
  var ligatures = null;
  try { ligatures = localStorage.getItem("codeeditor:ligatures"); } catch (e) {}
  if (ligatures === "on") root.dataset.ligatures = "on";
})();
