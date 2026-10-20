// Contrast report for every theme the app offers, in light and dark: each foreground/background
// pair the UI draws (src/theme/contrast.ts PAIRS, token contract v2) is computed with the WCAG 2.2
// formula.
//   node scripts/contrast-check.mjs            summary per theme; exits 1 if any pair fails
//   node scripts/contrast-check.mjs --rows     also print every pair of CodeEditor's own palettes
//   node scripts/contrast-check.mjs --json     machine-readable result
// CodeEditor's own palettes (Deep Field and Slate) must pass as designed: the guard may move
// nothing in them. Deep Field must also meet every role-distinctness rule and region step
// (checkRules); Slate's misses there are its v1 identity (one azure for action, focus and
// location; near-equal grounds) and are reported, not failed. Palette themes are checked after the
// readability guard (the colours the app really paints), and the colours it moved are listed.
//
// The theme modules are TypeScript, loaded with Node's built-in type stripping. Their imports have
// no file extension (Vite style), so a resolve hook tries ".ts" for relative imports.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // not a .ts file: resolve normally
      }
    }
    return nextResolve(specifier, context);
  },
});

const { checkPalette, checkRules, PAIRS, readablePalette } = await import("../src/theme/contrast.ts");
const { BUILT_IN, themePalette } = await import("../src/theme/themes.ts");

const args = new Set(process.argv.slice(2));
const report = [];
for (const theme of BUILT_IN) {
  // "match device" is the same palette's light and dark, already listed as their own themes.
  if (theme.system) continue;
  const scheme = theme.scheme;
  const { palette, adjusted } = themePalette(theme, scheme);
  const rows = checkPalette(palette);
  const failed = rows.filter((r) => !r.pass);
  const worst = rows.reduce((w, r) => (r.ratio / r.min < w.ratio / w.min ? r : w));
  // An own palette must already pass: the guard would move nothing.
  const wouldMove = theme.own ? readablePalette(palette).adjusted : [];
  const rules = theme.own ? checkRules(palette, { scheme, separation: "surface" }) : null;
  const ruleMisses = rules ? [...rules.distinct, ...rules.steps].filter((x) => !x.pass).map((x) => `${x.a} vs ${x.b}`) : [];
  report.push({ id: theme.id, name: theme.name, own: theme.own ?? null, scheme, checked: rows.length, failed, worst, adjusted, wouldMove, ruleMisses, rows });
}

const fmt = (n) => n.toFixed(2);
if (args.has("--json")) {
  console.log(JSON.stringify(report.map(({ rows, ...r }) => ({ ...r, rows: args.has("--rows") ? rows : undefined })), null, 2));
} else {
  console.log(`${PAIRS.length} pairs per theme (WCAG 2.2; text 4.5:1, UI and graphics 3:1)\n`);
  for (const r of report) {
    const state = r.failed.length ? `FAIL ${r.failed.length}` : "pass";
    const moved = r.adjusted.length ? `  guard moved: ${r.adjusted.join(", ")}` : "";
    console.log(`${state.padEnd(7)} ${`${r.name} (${r.scheme})`.padEnd(40)} worst ${r.worst.fg} on ${r.worst.bg} ${fmt(r.worst.ratio)} (needs ${r.worst.min})${moved}`);
    for (const f of r.failed) console.log(`        ${f.fg} ${f.fgHex} on ${f.bg} ${f.bgHex}: ${fmt(f.ratio)} < ${f.min} (${f.use})`);
    if (r.wouldMove.length) console.log(`        not as designed: the guard would move ${r.wouldMove.join(", ")}`);
    if (r.own) {
      const label = r.own === "deep-field" ? "rules" : "rules (reported only: Slate's v1 identity)";
      console.log(`        ${label}: ${r.ruleMisses.length ? `missed ${r.ruleMisses.join(", ")}` : "every distinctness rule and region step passes"}`);
    }
  }
  if (args.has("--rows")) {
    for (const r of report.filter((x) => x.own)) {
      console.log(`\n${r.name}`);
      for (const row of r.rows) console.log(`  ${fmt(row.ratio).padStart(6)} ${row.min === 3 ? "3  " : "4.5"} ${row.fg.padEnd(16)} on ${row.bg.padEnd(28)} ${row.use}`);
    }
  }
}
const failures = report.reduce((n, r) => n + r.failed.length, 0);
const ownMoved = report.filter((r) => r.wouldMove.length);
const deepFieldMisses = report.filter((r) => r.own === "deep-field" && r.ruleMisses.length);
if (failures || ownMoved.length || deepFieldMisses.length) {
  if (!args.has("--json")) console.error(`\n${failures} failing pair(s); own palettes the guard would move: ${ownMoved.length}; Deep Field rule misses: ${deepFieldMisses.length}`);
  process.exit(1);
}
