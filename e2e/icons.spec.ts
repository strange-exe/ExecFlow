// The app's icons (DESIGN.md decision 11, mark v2): browsers fetch icons out of band, so no console
// error, failed-request check or axe rule notices a missing or broken one. These tests fetch every
// icon that index.html and the web app manifest declare and check the bytes themselves: the type by
// its magic bytes, the size from the PNG header, the SVG's text, the maskable safe zone and the
// service worker's precache. (Proved to fail with an icon removed and with var() in the SVG.)
import { createHash } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./helpers";

test.use({ serviceWorkers: "block" });

/** The previous (azure) mark's files: none may be served from the precache any more. */
const OLD_ICONS = ["favicon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk (the first chunk, right after the signature). */
function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_MAGIC) || b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const isSvg = (b: Buffer) => /^(<\?xml[^>]*\?>\s*)?<svg[\s>]/.test(b.toString("utf8").trimStart());

/** WCAG 2.2 relative luminance and contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Declared {
  where: string;
  url: string;
  type: string | null;
  sizes: string | null;
  purpose?: string;
}

/** Every icon the served index.html declares, with its URL resolved by the browser. */
async function pageIcons(page: Page): Promise<Declared[]> {
  await page.goto("/");
  return page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (els) =>
    els.map((e) => ({ where: e.getAttribute("rel") ?? "", url: (e as HTMLLinkElement).href, type: e.getAttribute("type"), sizes: e.getAttribute("sizes") })),
  );
}

/** The manifest's icons, each src resolved against the manifest's own URL (as browsers do). */
async function manifestIcons(page: Page, request: APIRequestContext): Promise<{ manifestUrl: string; icons: Declared[] }> {
  await page.goto("/");
  const manifestUrl = await page.locator('link[rel="manifest"]').evaluate((e) => (e as HTMLLinkElement).href);
  const res = await request.get(manifestUrl);
  expect(res.status(), manifestUrl).toBe(200);
  const manifest = (await res.json()) as { icons?: { src: string; sizes?: string; type?: string; purpose?: string }[] };
  const icons = (manifest.icons ?? []).map((i) => ({ where: "manifest", url: new URL(i.src, manifestUrl).href, type: i.type ?? null, sizes: i.sizes ?? null, purpose: i.purpose }));
  return { manifestUrl, icons };
}

/** Fetches a declared icon and checks status, Content-Type, magic bytes and (for PNGs) the declared size. */
async function checkIcon(request: APIRequestContext, icon: Declared): Promise<Buffer> {
  const label = `${icon.where} ${icon.url}`;
  const res = await request.get(icon.url);
  expect(res.status(), label).toBe(200);
  const body = await res.body();
  const served = (res.headers()["content-type"] ?? "").split(";")[0].trim();
  const declared = icon.type ?? (icon.url.endsWith(".svg") ? "image/svg+xml" : "image/png");
  expect(served, `${label}: served type`).toBe(declared);
  if (declared === "image/svg+xml") {
    expect(isSvg(body), `${label}: bytes are SVG`).toBe(true);
  } else {
    expect(declared, label).toBe("image/png");
    const size = pngSize(body);
    expect(size, `${label}: bytes are a PNG`).not.toBeNull();
    if (icon.sizes) expect(`${size!.width}x${size!.height}`, `${label}: declared size`).toBe(icon.sizes);
  }
  return body;
}

type Stops = [number, string][];

/** The tile gradient's colour at t (0..1, clamped) from its stops, interpolated in sRGB as SVG and canvas do. */
function rampAt(stops: Stops, t: number): string {
  const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const u = Math.min(1, Math.max(0, t));
  const i = Math.max(1, stops.findIndex(([o]) => o >= u));
  const [[o0, c0], [o1, c1]] = [stops[i - 1], stops[i]];
  const f = o1 === o0 ? 0 : (u - o0) / (o1 - o0);
  return `#${rgb(c0).map((v, j) => Math.round(v + (rgb(c1)[j] - v) * f).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Where a pixel's centre lies along the tile's diagonal (0 top-left, 1 bottom-right), in the mark's
 * 32-unit view: a rounded tile spans 1 to 31 units (the favicon's rect), a full-bleed square 0 to 32.
 */
function along(x: number, y: number, size: number, fullBleed: boolean): number {
  const [vx, vy] = [((x + 0.5) * 32) / size, ((y + 0.5) * 32) / size];
  return fullBleed ? (vx + vy) / 64 : (vx - 1 + (vy - 1)) / 60;
}

/**
 * Facts about a same-origin image's pixels, worked out in the page (img-src 'self' allows it; same
 * origin keeps the canvas readable): its size, how many pixels aren't fully opaque, the colour at
 * the tile sample point (left of the glyph, on its middle line) and where that point is, and with
 * a full-bleed icon's gradient `stops` given, the pixels that aren't the gradient's colour at their
 * own place and lie outside the maskable safe zone (a circle of radius 40%).
 */
function imageFacts(page: Page, url: string, stops: Stops | null = null) {
  return page.evaluate(
    async ({ src, stops }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const [width, height] = [img.naturalWidth, img.naturalHeight];
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, width, height).data;
      const hexRgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
      // The full-bleed gradient at a pixel's centre (the same sum as rampAt and along, in the page).
      const expected = (x: number, y: number) => {
        const t = Math.min(1, Math.max(0, (x + 0.5 + y + 0.5) / (width + height)));
        const i = Math.max(1, stops!.findIndex(([o]) => o >= t));
        const [[o0, c0], [o1, c1]] = [stops![i - 1], stops![i]];
        const f = (t - o0) / (o1 - o0);
        return hexRgb(c0).map((v, j) => v + (hexRgb(c1)[j] - v) * f);
      };
      let transparent = 0;
      const outside: string[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (d[i + 3] !== 255) transparent++;
          if (stops && Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > 0.4 * width && expected(x, y).some((v, j) => Math.abs(d[i + j] - v) > 8)) outside.push(`${x},${y}`);
        }
      }
      const [sx, sy] = [Math.floor((width * 3) / 32), Math.floor(height / 2)];
      const s = (sy * width + sx) * 4;
      const sample = `#${[d[s], d[s + 1], d[s + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      return { width, height, transparent, sample, sx, sy, cornerAlpha: d[3], outside: outside.slice(0, 5), outsideCount: outside.length };
    },
    { src: url, stops },
  );
}

const near = (a: string, b: string, tolerance = 3) => [1, 3, 5].every((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(b.slice(k, k + 2), 16)) <= tolerance);

/** The SVG favicon's tile gradient (its id and stops) and glyph stroke. */
async function svgMark(page: Page, request: APIRequestContext) {
  const svgIcon = (await pageIcons(page)).find((i) => i.type === "image/svg+xml");
  expect(svgIcon, "an SVG favicon").toBeDefined();
  const text = (await checkIcon(request, svgIcon!)).toString("utf8");
  const gradients = [...text.matchAll(/<linearGradient\b([^>]*)>/gi)];
  expect(gradients, "one linearGradient").toHaveLength(1);
  const id = /\sid="([a-z][a-z0-9-]*)"/.exec(gradients[0][1])?.[1];
  expect(id, "the gradient's own id").toBeDefined();
  // Top-left to bottom-right of the tile's own box (objectBoundingBox, the default units).
  expect(gradients[0][1], "x1=0 y1=0 x2=1 y2=1").toMatch(/^(?=.*\sx1="0")(?=.*\sy1="0")(?=.*\sx2="1")(?=.*\sy2="1")(?!.*gradientUnits="userSpaceOnUse")/);
  expect(text.match(/<rect\b[^>]*\bfill="([^"]+)"/i)?.[1], "the tile is filled with that gradient").toBe(`url(#${id})`);
  const stops: Stops = [...text.matchAll(/<stop\b[^>]*\boffset="([\d.]+)"[^>]*\bstop-color="(#[0-9a-f]{6})"/gi)].map((m) => [Number(m[1]), m[2].toLowerCase()]);
  expect(stops.length, "the gradient's stops are resolved #rrggbb colours").toBeGreaterThanOrEqual(2);
  expect(stops.length, "every stop read").toBe(text.match(/<stop\b/g)?.length);
  expect([stops[0][0], stops.at(-1)![0]], "stops from 0 to 1").toEqual([0, 1]);
  const glyph = text.match(/<path\b[^>]*\bstroke="(#[0-9a-f]{6})"/i)?.[1];
  expect(glyph, "the glyph's stroke is a resolved #rrggbb colour").toBeDefined();
  return { text, id: id!, stops, glyph: glyph!.toLowerCase() };
}

test("every icon index.html declares is there, in its declared format and size: a PNG and an SVG favicon and a square apple-touch-icon", async ({ page, request }) => {
  const icons = await pageIcons(page);
  expect(icons.filter((i) => i.where.split(" ").includes("icon")).map((i) => i.type).sort(), "favicons").toEqual(["image/png", "image/svg+xml"]);
  const touch = icons.filter((i) => i.where === "apple-touch-icon");
  expect(touch, "one apple-touch-icon").toHaveLength(1);
  // Relative icon hrefs (lessons.md, Setu); the manifest link is the plugin's root path.
  const hrefs = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]', (els) => els.map((e) => e.getAttribute("href") ?? ""));
  expect(hrefs.filter((h) => h !== "/manifest.webmanifest" && h.startsWith("/")), "icon hrefs are relative").toEqual([]);
  for (const icon of icons) await checkIcon(request, icon);
  // iOS draws the apple-touch-icon as given and rounds it itself: a square, fully opaque PNG.
  const px = await imageFacts(page, touch[0].url);
  expect(px.width, "apple-touch-icon is square").toBe(px.height);
  expect(px.width, "apple-touch-icon is 180 px (the iPhone home screen size)").toBe(180);
  expect(px.transparent, "apple-touch-icon has no transparent pixel").toBe(0);
});

test("the SVG favicon is plain: no script, no var(), no outside reference, resolved colours that pass 4.5:1 and 3:1, the same mark as the PNGs", async ({ page, request }) => {
  const { text, id, stops, glyph } = await svgMark(page, request);
  // An external SVG can't see the page's custom properties, and an icon never runs code.
  expect(text, "no var()").not.toMatch(/var\(/i);
  expect(text, "no script element").not.toMatch(/<script/i);
  expect(text, "no event handler attribute").not.toMatch(/\son[a-z]+\s*=/i);
  expect(text, "no javascript: URL").not.toMatch(/javascript:/i);
  // The one url() allowed is the tile's fill naming the file's own gradient; nothing else refers out.
  expect(text.split(`fill="url(#${id})"`), "the tile's own gradient, named once").toHaveLength(2);
  expect(text.replace(`fill="url(#${id})"`, ""), "no reference to another file").not.toMatch(/\b(?:xlink:)?href\s*=|url\(|<foreignObject|<style|@import/i);
  expect(text, "a square viewBox").toMatch(/viewBox="0 0 32 32"/);
  // Every other colour in it is a resolved hex: the stops and the glyph.
  const colours = [...new Set([...text.matchAll(/\b(?:fill|stroke|stop-color)="([^"]+)"/g)].map((m) => m[1].toLowerCase()))].filter((c) => c !== "none" && c !== `url(#${id})`);
  expect(colours.sort()).toEqual([...new Set([...stops.map(([, c]) => c), glyph])].sort());
  // Every point of the ramp: the white glyph at 4.5:1, the tile at 3:1 on a dark tab strip (#0d1117).
  for (let i = 0; i <= 100; i++) {
    const c = rampAt(stops, i / 100);
    expect(contrast(glyph, c), `glyph ${glyph} on tile ${c} (t=${i / 100})`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c, "#0d1117"), `tile ${c} on #0d1117 (t=${i / 100})`).toBeGreaterThanOrEqual(3);
  }
  // One mark: every PNG icon's tile is the SVG's gradient at the sample's own place (left of the
  // glyph, on its middle line); the rounded tile spans 1 to 31 units, the full-bleed square all 32.
  const { icons } = await manifestIcons(page, request);
  const pngs = [...(await pageIcons(page)).filter((i) => i.type === "image/png" || i.where === "apple-touch-icon"), ...icons];
  for (const icon of pngs) {
    const px = await imageFacts(page, icon.url);
    const fullBleed = px.cornerAlpha === 255;
    const want = rampAt(stops, along(px.sx, px.sy, px.width, fullBleed));
    expect(near(px.sample, want), `${icon.where} ${icon.url} (${fullBleed ? "full bleed" : "rounded tile"}): tile ${px.sample} is the SVG's gradient there, ${want}`).toBe(true);
  }
});

test("the manifest declares 192 and 512 px icons and a maskable one, each there in its declared format and size, the maskable glyph inside the safe zone", async ({ page, request }) => {
  const { icons } = await manifestIcons(page, request);
  const any = icons.filter((i) => !i.purpose || i.purpose.split(" ").includes("any"));
  expect(any.map((i) => i.sizes).sort(), "any-purpose icons").toEqual(["192x192", "512x512"]);
  const maskable = icons.filter((i) => i.purpose?.split(" ").includes("maskable"));
  expect(maskable, "one maskable icon").toHaveLength(1);
  for (const icon of icons) await checkIcon(request, icon);
  // W3C Web App Manifest, icon masks: the safe zone is a circle centred on the icon, its radius 40%
  // of the icon's size; everything outside it may be cut away. So the glyph stays inside the circle
  // and the tile fills the whole square (full bleed, no transparent corner).
  const { stops } = await svgMark(page, request);
  const px = await imageFacts(page, maskable[0].url, stops);
  expect(px.width, "maskable icon is square").toBe(px.height);
  expect(px.transparent, "maskable icon is fully opaque (full bleed)").toBe(0);
  expect(px.outside, `glyph pixels outside the safe zone (${px.outsideCount})`).toEqual([]);
});

test("the service worker precaches every declared icon at its current bytes, and no old or stray icon", async ({ page, request }) => {
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  const entries = [...(await sw.text()).matchAll(/\{url:"([^"]+)",revision:(null|"([0-9a-f]+)")\}/g)].map((m) => ({ url: m[1], revision: m[3] ?? null }));
  expect(entries.length, "precache entries found in sw.js").toBeGreaterThan(10);
  const declared = [...(await pageIcons(page)), ...(await manifestIcons(page, request)).icons];
  const paths = [...new Set(declared.map((i) => new URL(i.url).pathname.slice(1)))];
  for (const path of paths) {
    const precached = entries.filter((e) => e.url === path);
    expect(precached.length, `${path} is precached`).toBeGreaterThan(0);
    // Workbox revisions are the MD5 of the file: the precache holds these bytes, not an older version.
    const md5 = createHash("md5").update(await (await request.get(`/${path}`)).body()).digest("hex");
    expect(precached.map((e) => e.revision), `${path} revision`).toEqual(precached.map(() => md5));
  }
  for (const old of OLD_ICONS) expect(entries.some((e) => e.url === old), `${old} is gone from the precache`).toBe(false);
  // Images outside the hashed assets and the runtimes are the declared icons and nothing else.
  const images = [...new Set(entries.map((e) => e.url).filter((u) => /\.(png|svg|ico)$/.test(u) && !/^(assets|pyodide|clang)\//.test(u)))];
  expect(images.sort(), "precached icons").toEqual(paths.sort());
});
