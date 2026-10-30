// Renders the picture a shared link shows (Open Graph and Twitter cards): 1200 x 630, Signal's dark
// theme, the brand mark, the name, one line on what ExecFlow does, and a small code-and-flowchart
// motif. Writes public/media/social-card.<sha256 first 8>.png and removes the older card; then set
// SOCIAL_CARD.path in src/about/site.ts to the printed name (src/about/site.test.ts checks the file).
// Every text colour must pass 4.5:1 on its ground, or nothing is written.
// Run: node scripts/make-social-card.mjs
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Signal dark (src/theme/palettes.ts).
const C = {
  bg: "#0e1116",
  sheet: "#1d232c",
  border: "#252c35",
  rule: "#737d8b",
  text: "#e8ebf0",
  secondary: "#b9c0ca",
  muted: "#a3aab5",
  gutter: "#9198a5",
  action: "#7ea2ff",
  keyword: "#e896dc",
  string: "#8bd79a",
  number: "#f4a87a",
  fn: "#6fd3e0",
  variable: "#dce1e8",
};

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const pairs = [
  ["name", C.text, C.bg],
  ["line", C.secondary, C.bg],
  ["address", C.muted, C.bg],
  ...["gutter", "keyword", "string", "number", "fn", "variable", "text", "action"].map((k) => [`code ${k}`, C[k], C.sheet]),
];
const failing = pairs.filter(([, fg, bg]) => ratio(fg, bg) < 4.5);
if (failing.length) throw new Error(`Below 4.5:1: ${failing.map(([n, fg, bg]) => `${n} ${ratio(fg, bg).toFixed(2)}`).join(", ")}`);

const font = (file) => `data:font/woff2;base64,${readFileSync(file).toString("base64")}`;
const mark = readFileSync("public/icons/mark-v2.svg", "utf8");

const code = [
  [["k", "def"], ["t", " "], ["f", "average"], ["t", "(marks):"]],
  [["t", "    total "], ["t", "= "], ["n", "0"]],
  [["k", "    for"], ["t", " m "], ["k", "in"], ["t", " marks:"]],
  [["t", "        total "], ["t", "+= m"]],
  [["k", "    return"], ["t", " total / "], ["f", "len"], ["t", "(marks)"]],
  [],
  [["f", "print"], ["t", "("], ["f", "average"], ["t", "(["], ["n", "72"], ["t", ", "], ["n", "85"], ["t", ", "], ["n", "91"], ["t", "]))"]],
];
const colour = { k: C.keyword, f: C.fn, n: C.number, s: C.string, t: C.variable };
const lines = code
  .map((parts, i) => `<div class="ln"><span class="g">${i + 1}</span>${parts.map(([k, s]) => `<span style="color:${colour[k]}">${s.replace(/ /g, "&nbsp;")}</span>`).join("")}</div>`)
  .join("");

// The flowchart of the function above, in the app's own shapes: rounded ends, a diamond for the
// loop's test, the body below it with its line back up, and the way out on the right.
const chart = `<svg class="chart" viewBox="0 0 200 320" aria-hidden="true">
  <g fill="none" stroke="${C.rule}" stroke-width="2">
    <rect x="40" y="4" width="120" height="34" rx="17"/>
    <rect x="30" y="62" width="140" height="36" rx="6"/>
    <path d="M100 120 L178 150 L100 180 L22 150 Z"/>
    <rect x="30" y="206" width="140" height="36" rx="6"/>
    <rect x="40" y="280" width="120" height="34" rx="17"/>
  </g>
  <g stroke="${C.action}" stroke-width="2" fill="none">
    <path d="M100 38 V62 M100 98 V120 M100 180 V206"/>
    <path d="M100 242 V258 H8 V150 H22"/>
    <path d="M178 150 H194 V297 H160"/>
  </g>
  <g font-family="JetBrains Mono" font-size="13" fill="${C.text}" text-anchor="middle">
    <text x="100" y="26">average</text>
    <text x="100" y="85">total = 0</text>
    <text x="100" y="155">m in marks?</text>
    <text x="100" y="229">total += m</text>
    <text x="100" y="302">return</text>
  </g>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Geist"; font-weight: 100 900; src: url(${font("node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2")}) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url(${font("node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2")}) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 600; src: url(${font("node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2")}) format("woff2"); }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; background: ${C.bg}; color: ${C.text}; font-family: Geist; overflow: hidden; }
.card { position: relative; display: grid; grid-template-columns: 470px 1fr; gap: 48px; height: 100%; padding: 72px 72px 64px; }
.brand { display: flex; align-items: center; gap: 20px; }
.brand svg { width: 72px; height: 72px; }
h1 { font-size: 64px; white-space: nowrap; }
/* The wordmark (src/styles/wordmark.css): Exec in the code font, Flow in the UI font and the action colour. */
.wm-exec { font-family: "JetBrains Mono"; font-weight: 600; letter-spacing: -0.02em; }
.wm-flow { font-family: Geist; font-weight: 700; color: ${C.action}; }
.line { margin-top: 40px; font-size: 40px; line-height: 1.25; font-weight: 500; color: ${C.secondary}; }
.address { position: absolute; left: 72px; bottom: 64px; font-size: 24px; color: ${C.muted}; }
.motif { display: grid; grid-template-columns: 1fr 180px; gap: 16px; align-self: center; align-items: center; }
.sheet { background: ${C.sheet}; border: 1px solid ${C.border}; border-radius: 14px; padding: 22px 20px; font: 16px/1.75 "JetBrains Mono"; white-space: nowrap; overflow: hidden; }
.ln { display: flex; }
.g { width: 26px; flex: none; color: ${C.gutter}; }
.chart { width: 180px; height: 288px; align-self: center; }
</style></head><body><div class="card">
<div><div class="brand">${mark}<h1><span class="wm-exec">Exec</span><span class="wm-flow">Flow</span></h1></div>
<p class="line">Write, run and chart Python, C and C++ in your browser</p></div>
<div class="motif"><div class="sheet">${lines}</div>${chart}</div>
<p class="address">execflow.abhinesh.codes</p>
</div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: "png" });
  const name = `social-card.${createHash("sha256").update(png).digest("hex").slice(0, 8)}.png`;
  for (const old of readdirSync("public/media").filter((f) => /^social-card\..*\.png$/.test(f))) rmSync(`public/media/${old}`);
  writeFileSync(`public/media/${name}`, png);
  console.log(`public/media/${name} (${png.length} bytes)`);
} finally {
  await browser.close();
}
