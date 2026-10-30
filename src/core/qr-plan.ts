// The share dialogs' QR codes (owner's pick 2026-10-30: "custom QR codes having our mark"): which
// modules are dark, and where the ExecFlow mark sits. uqr gives the modules only (no markup from a
// library); src/ui/share-dialog.ts draws them.
// - A link that fits at error correction level H (about 30% of the codewords can be lost and still
//   read, ISO/IEC 18004 table 1) gets the mark: the modules in a square at the centre are cleared
//   and the mark is drawn there, one module in from the cleared edge. The cleared square is at most
//   MARK_AREA_MAX of the symbol (the quiet zone not counted), well inside what level H can lose,
//   which leaves most of the 30% for a scratched screen, glare or a blurry photo. A square at the
//   centre touches data and error-correction codewords only, never a finder, timing or format
//   module (qr-plan.test.ts checks every version a link can reach); from version 7 the centre
//   alignment pattern is covered, which readers tolerate (the test decodes such codes).
// - A link too long for level H (a long code link: over about 1,270 characters) keeps the plain
//   level L code, as before, with no mark: the most data per code.
// - Too long for level L too: null (the dialog says so).
import { encode } from "uqr";

/** The most of the symbol the cleared square may cover (0.07: 7%). */
export const MARK_AREA_MAX = 0.07;
/** The quiet zone, in modules, as the QR standard asks. */
export const QUIET = 4;

export interface QrPlan {
  /** Modules per side, the quiet zone included. */
  size: number;
  version: number;
  ecc: "H" | "L";
  /** true: dark. The cleared square is all light. */
  modules: boolean[][];
  /** The cleared square (top-left module and side) and the mark inside it; null without one. */
  mark: { at: number; clear: number; markAt: number; markSize: number } | null;
}

/** The cleared square's side for a symbol of `symbol` modules: odd (so it is centred), within MARK_AREA_MAX. */
export function clearSide(symbol: number): number {
  let side = Math.floor(Math.sqrt(MARK_AREA_MAX) * symbol);
  if (side % 2 === 0) side--;
  return side;
}

export function qrPlan(text: string): QrPlan | null {
  try {
    const r = encode(text, { ecc: "H", border: QUIET });
    const symbol = r.size - 2 * QUIET;
    const clear = clearSide(symbol);
    const at = QUIET + (symbol - clear) / 2;
    const inside = (x: number, y: number) => x >= at && x < at + clear && y >= at && y < at + clear;
    // Only data, error correction (0) and the centre alignment pattern (4) may be cleared: version
    // 1's centre holds format information, so its code (text of at most 7 bytes) stays unmarked.
    const clean = r.types.every((row, y) => row.every((type, x) => !inside(x, y) || type === 0 || type === 4));
    if (!clean) return { size: r.size, version: r.version, ecc: "H", modules: r.data, mark: null };
    const modules = r.data.map((row, y) => row.map((dark, x) => dark && !inside(x, y)));
    return { size: r.size, version: r.version, ecc: "H", modules, mark: { at, clear, markAt: at + 1, markSize: clear - 2 } };
  } catch {
    // Too long for level H: the plain code below.
  }
  try {
    const r = encode(text, { ecc: "L", border: QUIET });
    return { size: r.size, version: r.version, ecc: "L", modules: r.data, mark: null };
  } catch {
    return null;
  }
}

/** Each row's dark runs as one path segment each, so a version-40 code stays a short string. */
export function darkPath(modules: readonly (readonly boolean[])[]): string {
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < row.length && row[x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return d;
}
