// The About page only: after theme-boot.js, before the stylesheet. A scheme chosen with the page's
// own light/dark toggle (src/about/scheme.ts) wins over the editor's theme and the device for this
// page, so it opens without a flash of the other one. A file, not inline: the Content-Security-Policy
// forbids inline scripts. The toolbar colour follows the page's own ground (about-tokens.css).
(function () {
  var root = document.documentElement, saved = null;
  try { saved = localStorage.getItem("codeeditor:about-scheme"); } catch (e) {}
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  var ground = { light: "#f4f4f6", dark: "#0c0c0e" }[root.dataset.theme === "dark" ? "dark" : "light"];
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", ground);
})();
