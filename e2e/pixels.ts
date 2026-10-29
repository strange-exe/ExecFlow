// Reads the colours a screenshot really painted, for checks that a computed style can't make (a
// translucent band over a selection layer, say). Playwright's screenshots are 8-bit RGB or RGBA,
// non-interlaced PNGs; this decodes exactly those with node's zlib, and refuses anything else.
import { inflateSync } from "node:zlib";

export type RGB = [number, number, number];

export interface Pixels {
  width: number;
  height: number;
  /** The colour at image pixel (x, y). */
  at(x: number, y: number): RGB;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(png: Buffer): Pixels {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    const kind = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + length;
  }
  const channels = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("truncated PNG data");
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = raw[row + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = Math.trunc(y) * stride + Math.trunc(x) * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" as channels and alpha (0 to 1). */
export function parseHex(hex: string): { rgb: RGB; alpha: number } {
  let h = hex.trim();
  // The short forms double each digit (CSS Color 4).
  if (/^#[0-9a-f]{3,4}$/i.test(h)) h = `#${[...h.slice(1)].map((c) => c + c).join("")}`;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(h);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

/** Hex colours painted in order, the first at the bottom (browsers blend in sRGB). */
export function stack(...hexes: string[]): RGB {
  let acc: RGB = [255, 255, 255];
  for (const hex of hexes) {
    const { rgb, alpha } = parseHex(hex);
    acc = [0, 1, 2].map((i) => rgb[i] * alpha + acc[i] * (1 - alpha)) as RGB;
  }
  return acc.map(Math.round) as RGB;
}

/** The largest per-channel difference. */
export const distance = (a: RGB, b: RGB) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** WCAG 2.2 contrast ratio of two opaque colours, rounded to 2 decimals. */
export function contrast(a: RGB, b: RGB): number {
  const lum = (c: RGB) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** "rgb(r, g, b)", as getComputedStyle writes an opaque colour. */
export const rgbOf = (hex: string) => `rgb(${parseHex(hex).rgb.join(", ")})`;
