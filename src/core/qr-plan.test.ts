// The marked QR codes still read: each plan is rasterised here and decoded by an independent reader
// (jsQR, a devDependency only), for short links and code links of every length a link can have,
// with the mark drawn as a solid dark square (the worst case) and as a light one. The cleared square
// stays within MARK_AREA_MAX and never touches a finder, timing or format module.
import jsQR from "jsqr";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { BRAND_MARK } from "../editor/brand-mark";
import { clearSide, darkPath, MARK_AREA_MAX, qrPlan, QUIET, type QrPlan } from "./qr-plan";

const ORIGIN = "https://execflow.abhinesh.codes";
/** The mark's tile colour (src/editor/brand-mark.ts), painted over the whole mark square; black if the tile has no single fill. */
const tileFill = (BRAND_MARK.tile as { fill?: unknown }).fill;
const MARK_BLUE: [number, number, number] = typeof tileFill === "string" && /^#[0-9a-f]{6}$/i.test(tileFill) ? [1, 3, 5].map((i) => parseInt(tileFill.slice(i, i + 2), 16)) as [number, number, number] : [0, 0, 0];

/** RGBA pixels of a plan, `px` pixels a module; the mark square painted `mark` (or left light). */
function raster(plan: QrPlan, px: number, mark: [number, number, number] | null, colours = { dark: [0, 0, 0], light: [255, 255, 255] }) {
  const w = plan.size * px;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const mx = Math.floor(x / px);
      const my = Math.floor(y / px);
      let c = plan.modules[my][mx] ? colours.dark : colours.light;
      const m = plan.mark;
      if (mark && m && mx >= m.markAt && mx < m.markAt + m.markSize && my >= m.markAt && my < m.markAt + m.markSize) c = mark;
      const i = (y * w + x) * 4;
      data.set([c[0], c[1], c[2], 255], i);
    }
  }
  return { data, w };
}

function decodes(plan: QrPlan, mark: [number, number, number] | null, px = 4): string | null {
  const { data, w } = raster(plan, px, mark);
  return jsQR(data, w, w, { inversionAttempts: "dontInvert" })?.data ?? null;
}

/** A link-like text of exactly `n` characters (letters and digits, as base64url links are). */
function textOf(n: number, seed = 3): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = seed;
  const head = `${ORIGIN}/#code=1.`;
  let out = head;
  while (out.length < n) out += chars[(s = (s * 48271) % 2147483647) % 64];
  return out.slice(0, n);
}

const shortLink = (seed: number) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = seed;
  const pick = (n: number, set: string) => Array.from({ length: n }, () => set[(s = (s * 48271) % 2147483647) % set.length]).join("");
  return `${ORIGIN}/s/${pick(10, chars)}#${pick(43, `${chars}-_`)}`;
};

describe("a short link's QR code", () => {
  it("is level H with the mark, and reads with the mark drawn dark or light", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const url = shortLink(seed);
      const plan = qrPlan(url)!;
      expect(plan.ecc).toBe("H");
      expect(plan.mark).not.toBeNull();
      expect(decodes(plan, MARK_BLUE), url).toBe(url);
      expect(decodes(plan, null), url).toBe(url);
      expect(decodes(plan, MARK_BLUE, 2), `${url} at 2 px a module`).toBe(url);
    }
  });
});

describe("a code link's QR code", () => {
  it("has the mark at level H up to the longest link level H holds, and reads at every length", () => {
    let marked = 0;
    for (const n of [40, 120, 300, 500, 800, 1000, 1150, 1250, 1270, 1273]) {
      const url = textOf(n, n);
      const plan = qrPlan(url)!;
      expect(plan.ecc, String(n)).toBe("H");
      marked++;
      expect(decodes(plan, MARK_BLUE), String(n)).toBe(url);
      expect(decodes(plan, null), String(n)).toBe(url);
    }
    expect(marked).toBe(10);
    // Twenty decodes of codes up to version 40.
  }, 60_000);

  it("past level H's room it is the plain level L code, unmarked, as before; past level L's, none", () => {
    for (const n of [1274, 1800, 2900, 2953]) {
      const url = textOf(n, n);
      const plan = qrPlan(url)!;
      expect(plan.ecc, String(n)).toBe("L");
      expect(plan.mark).toBeNull();
      expect(plan.modules).toEqual(encode(url, { ecc: "L", border: QUIET }).data);
      expect(decodes(plan, null, 3), String(n)).toBe(url);
    }
    expect(qrPlan(textOf(2954))).toBeNull();
  }, 60_000);
});

describe("the cleared square", () => {
  it(`covers at most ${Math.round(MARK_AREA_MAX * 100)}% of the symbol, is centred, and only ever data, error correction or the centre alignment pattern`, () => {
    const seen = new Set<number>();
    // Steps smaller than the room one version adds at level H, so every version from 1 to 40 is met.
    for (let n = 1; n <= 1273; n += Math.max(1, Math.floor(n / 80))) {
      const url = textOf(n, n);
      const r = encode(url, { ecc: "H", border: QUIET });
      if (seen.has(r.version)) continue;
      seen.add(r.version);
      const plan = qrPlan(url)!;
      if (r.version === 1) {
        // Its centre is format information: no mark, the library's modules as they are.
        expect(plan.mark).toBeNull();
        expect(plan.modules).toEqual(r.data);
        continue;
      }
      const m = plan.mark!;
      const symbol = plan.size - 2 * QUIET;
      expect(m.clear).toBe(clearSide(symbol));
      expect(m.clear % 2).toBe(1);
      expect((m.clear * m.clear) / (symbol * symbol), `version ${r.version}`).toBeLessThanOrEqual(MARK_AREA_MAX);
      expect(m.at - QUIET).toBe(QUIET + symbol - (m.at + m.clear));
      expect(m.markSize).toBe(m.clear - 2);
      // QrCodeDataType: 0 data, 4 alignment; never border (-1), function (1, format and version
      // information), position (2, finders) or timing (3).
      const wrong: string[] = [];
      plan.modules.forEach((row, y) => row.forEach((dark, x) => {
        const inside = x >= m.at && x < m.at + m.clear && y >= m.at && y < m.at + m.clear;
        if (inside && ((r.types[y][x] !== 0 && r.types[y][x] !== 4) || dark)) wrong.push(`(${x}, ${y}) type ${r.types[y][x]}, dark ${dark}`);
        // Everything outside the square is the library's code, module for module.
        if (!inside && dark !== r.data[y][x]) wrong.push(`(${x}, ${y}) outside changed`);
      }));
      expect(wrong, `version ${r.version}`).toEqual([]);
    }
    expect(seen.size).toBe(40);
    // About 300 codes are made to meet all 40 versions.
  }, 60_000);

  it("the path draws exactly the dark modules", () => {
    const plan = qrPlan(shortLink(1))!;
    const d = darkPath(plan.modules);
    let count = 0;
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) count += Number(m[3]);
    expect(count).toBe(plan.modules.flat().filter(Boolean).length);
  });
});
