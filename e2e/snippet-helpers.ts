// Shared by the Capture snippet specs (snippet-image.spec.ts, snippet-image-privacy.spec.ts,
// code-menu.spec.ts; .claude/design/snippet-image/final-v3.md section 9): the fixture, selecting its
// lines, opening the dialog, reading an exported PNG (chunks, size, RGBA pixels) and the test-only
// instrumentation of 9.2. The instrumentation lives only in init scripts here, never in src/.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Download, Locator, Page } from "@playwright/test";
import { IMAGE_MIXES, over } from "../src/theme/contrast";
import { expect, importFiles, openApp, openFromTree, treeItem, type FileSpec } from "./helpers";

/** 9.2's main.py: lines 2 to 3 are the default capture (694 x 229 at scale 2). */
export const FIXTURE = "# total of two numbers\ndef add(a, b):\n    return a + b\n\nprint(add(2, 3))\n";
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Opens the app with `files` imported (those not already in this context's workspace) and the first one open. */
export async function openWith(page: Page, files: FileSpec[] = [{ name: "main.py", text: FIXTURE }]) {
  await openApp(page);
  const missing: FileSpec[] = [];
  for (const f of files) if (!(await treeItem(page, f.name).count())) missing.push(f);
  if (missing.length) await importFiles(page, missing);
  await openFromTree(page, files[0].name);
  // The import's notice would sit over nothing here, but its text would race the refusal texts.
  const dismiss = page.locator(".notice [aria-label='Dismiss notice']");
  if (await dismiss.isVisible()) await dismiss.click();
}

/** Selects lines 2 to 3 by keyboard: Ctrl+Home, Down, Shift+Down twice (the end lands at line 4's column 0). */
export async function selectFixtureLines(page: Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  // The head at line 4's start; the drawn selection shows (the labels then name lines 2 to 3).
  await expect(page.locator("#status-pos")).toHaveText("Ln 4, Col 1");
  await expect(page.locator(".cm-selectionBackground").first()).toBeAttached();
}

/** Selects the whole file by keyboard. */
export async function selectAll(page: Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+A`);
}

export const dialogOf = (page: Page) => page.locator("dialog#snippet-dialog");

/** More file actions, then the Capture snippet item (its label names the file and the lines). */
export async function openFromFileMenu(page: Page, label: RegExp = /^Capture snippet of main\.py, lines 2 to 3\.\.\./) {
  await page.locator("#file-actions").click();
  await page.getByRole("menuitem", { name: label }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Round 2's defaults after round 1's three words in data-preview-options: 2x, medium background, plain frame. */
export const ROUND2_DEFAULTS = "2x medium plain";

/**
 * The dialog's preview has settled on the options shown. Round 1's three words ("light numbers
 * name") stand for those with round 2's defaults; a longer string is matched as it is.
 */
export async function previewReady(page: Page, options?: string) {
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAttribute("data-preview", "ready", { timeout: 30_000 });
  if (options) await expect(dialog).toHaveAttribute("data-preview-options", options.split(" ").length === 3 ? `${options} ${ROUND2_DEFAULTS}` : options);
}

/** The default background's padding at the default scale, in bitmap px: the card's corner in the PNG. */
export const CARD_AT = 64;
/** The image's background colour: the theme's action colour at 25% over its code ground (contrast.ts IMAGE_MIXES.mat). */
export const matOf = (t: Record<string, string>) => over(hex6(t.bg), hex6(t.action), IMAGE_MIXES.mat.pct / 100);
/** The highlight band's colour: focus at 12% over the code ground (IMAGE_MIXES.mark). */
export const markOf = (t: Record<string, string>) => over(hex6(t.bg), hex6(t.focus), IMAGE_MIXES.mark.pct / 100);
const hex6 = (hex: string) => `#${hexRgb(hex).map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export const captures = async (page: Page) => Number((await page.locator("#app").getAttribute("data-captures")) ?? 0);

/** Download (.png): the file's name and bytes. */
export async function downloadPng(page: Page): Promise<{ name: string; bytes: Buffer; download: Download }> {
  const dialog = dialogOf(page);
  const waiting = page.waitForEvent("download", { timeout: 30_000 }).catch(async () => {
    // Say why there is no file: the export's own result (a failed export never downloads).
    const app = page.locator("#app");
    throw new Error(`no download: data-capture=${await app.getAttribute("data-capture")} reason=${await app.getAttribute("data-capture-reason")}`);
  });
  const [download] = await Promise.all([waiting, dialog.getByRole("button", { name: "Download (.png)" }).click()]);
  return { name: download.suggestedFilename(), bytes: readFileSync((await download.path())!), download };
}

// ---------------------------------------------------------------- PNG reading

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
  chunks: string[];
}

/** The PNG's header and the names of its chunks, in order. */
export function pngInfo(png: Buffer): PngInfo {
  expect(png.subarray(0, 8).equals(SIGNATURE), "PNG signature").toBe(true);
  const chunks: string[] = [];
  let ihdr: Buffer | null = null;
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    const kind = png.toString("latin1", pos + 4, pos + 8);
    chunks.push(kind);
    if (kind === "IHDR") ihdr = png.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (kind === "IEND") break;
  }
  if (!ihdr) throw new Error("no IHDR");
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), depth: ihdr[8], colorType: ihdr[9], interlace: ihdr[12], chunks };
}

export type RGBA = [number, number, number, number];

export interface RgbaPixels {
  width: number;
  height: number;
  at(x: number, y: number): RGBA;
}

/** 8-bit RGB or RGBA, non-interlaced (what canvas.toBlob gives); an RGB pixel has alpha 255. */
export function decodeRgba(png: Buffer): RgbaPixels {
  const info = pngInfo(png);
  const channels = info.colorType === 6 ? 4 : info.colorType === 2 ? 3 : 0;
  if (info.depth !== 8 || !channels || info.interlace) throw new Error(`unsupported PNG: ${JSON.stringify(info)}`);
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    const kind = png.toString("latin1", pos + 4, pos + 8);
    if (kind === "IDAT") idat.push(png.subarray(pos + 8, pos + 8 + length));
    pos += 12 + length;
  }
  const { width, height } = info;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
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
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
    },
  };
}

/** #rrggbb, or #rgb (the production build's minifier shortens some tokens.css values). */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not #rrggbb: ${hex}`);
  const six = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const n = parseInt(six, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The largest channel difference between a pixel and a colour. */
export const off = (p: RGBA | [number, number, number], hex: string) => Math.max(...hexRgb(hex).map((v, i) => Math.abs(v - p[i])));

/**
 * The most frequent colour in a box that is not the ground (within 8 of it), as #rrggbb. Text is
 * anti-aliased, so its own colour is the commonest non-ground pixel, not every one.
 */
export function inkOf(px: RgbaPixels, box: { x0: number; x1: number; y0: number; y1: number }, ground: string): string | null {
  const counts = new Map<string, number>();
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const p = px.at(x, y);
      if (off(p, ground) <= 8) continue;
      const key = `#${p.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

/** Some of the image tokens and a few chrome tokens, as the document root computes them. */
export function tokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const names = ["bg", "text", "syn-keyword", "syn-comment", "gutter-text", "danger", "divider", "text-secondary", "border", "surface", "action", "focus"];
    // The build's CSS minifier writes #ffffff (Signal light's code card) as #fff; read it as the app
    // does (core/snippet-dialog.ts checkColors), as #rrggbb.
    const full = (v: string) => (/^#[0-9a-f]{3}$/.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v);
    return Object.fromEntries(names.map((n) => [n, full(s.getPropertyValue(`--${n}`).trim().toLowerCase())]));
  });
}

/** The preview canvas's bitmap as PNG bytes (the export bitmap itself). */
export async function previewPng(page: Page): Promise<Buffer> {
  const url = await page.locator("#snippet-frame canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

// ---------------------------------------------------------------- instrumentation (9.2), init scripts only

export interface Instrument {
  /** Call the browser's own clipboard write (Chromium with both clipboard permissions). Otherwise the item is kept and the write settles as a real one does: once the item's PNG has. */
  realWrite: boolean;
  /** The clipboard write rejects at once ("now") or after awaiting the item ("after-item"). */
  writeReject?: "now" | "after-item";
  /**
   * A busy wait in every fillText call, in ms (a slow render). Tests that act during such a render
   * need tracing off (the configs' default): a trace's snapshot around each action waits behind the
   * render, so the action lands after it (tests 2, 22, 25 and 26 fail with `--trace`, 2026-10-21).
   */
  slowFillText?: number;
  /** toBlob calls back null. */
  toBlobNull?: boolean;
  /** toBlob's callback comes this many ms late. */
  toBlobDelay?: number;
  /** getImageData returns white: always, or only when called outside an event listener (after an await). */
  whiteReadback?: "always" | "async";
  /** getContext returns null. */
  getContextNull?: boolean;
}

/**
 * Every listener runs inside depth++ ... finally depth--, so a call made synchronously in an event
 * listener records sync: true and one made after any await records sync: false (the wrapper has
 * returned before the microtask checkpoint). Clipboard write, toBlob and getImageData are recorded
 * with the event type and the user activation at the call. The other options stub failures (9.2,
 * tests 3, 22, 25, 26).
 */
export function instrument(page: Page, o: Instrument) {
  return page.addInitScript((o: Instrument) => {
    const w = window as unknown as {
      __depth: number;
      __calls: { name: string; sync: boolean; type: string | null; active: boolean | null }[];
      __items: ClipboardItem[];
    };
    w.__depth = 0;
    w.__calls = [];
    w.__items = [];
    const wrapped = new WeakMap<object, EventListener>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const wrap = (l: EventListenerOrEventListenerObject): EventListener => {
      let f = wrapped.get(l);
      if (!f) {
        f = function (this: unknown, e: Event) {
          w.__depth++;
          try {
            return typeof l === "function" ? l.call(this, e) : l.handleEvent(e);
          } finally {
            w.__depth--;
          }
        };
        wrapped.set(l, f);
      }
      return f;
    };
    EventTarget.prototype.addEventListener = function (type: string, l: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
      return add.call(this, type, l ? wrap(l) : l, opts);
    };
    EventTarget.prototype.removeEventListener = function (type: string, l: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
      return remove.call(this, type, l ? (wrapped.get(l) ?? l) : l, opts);
    };
    const note = (name: string) =>
      w.__calls.push({ name, sync: w.__depth > 0, type: (window as unknown as { event?: Event }).event?.type ?? null, active: navigator.userActivation?.isActive ?? null });
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof getImageData>) {
      const sync = w.__depth > 0;
      note("getImageData");
      const data = getImageData.apply(this, args);
      if (o.whiteReadback === "always" || (o.whiteReadback === "async" && !sync)) data.data.fill(255);
      return data;
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, ...rest: unknown[]) {
      note("toBlob");
      if (o.toBlobNull) {
        setTimeout(() => callback(null));
        return;
      }
      const late = o.toBlobDelay;
      return toBlob.call(this, late ? (b) => setTimeout(() => callback(b), late) : callback, ...(rest as [string?, number?]));
    };
    if (o.slowFillText) {
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof fillText>) {
        const t = performance.now();
        while (performance.now() - t < o.slowFillText!);
        return fillText.apply(this, args);
      };
    }
    if (o.getContextNull) HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
    if (typeof Clipboard !== "undefined") {
      const write = Clipboard.prototype.write;
      Clipboard.prototype.write = function (items: ClipboardItems) {
        note("write");
        w.__items.push(...items);
        if (o.writeReject === "now") return Promise.reject(new DOMException("Write refused (test)", "NotAllowedError"));
        const settled = Promise.all(items.map((i) => i.getType("image/png"))).then(() => undefined);
        if (o.writeReject === "after-item") return settled.then(() => Promise.reject(new DOMException("Write refused (test)", "NotAllowedError")));
        return o.realWrite ? write.call(this, items) : settled;
      };
    }
  }, o);
}

export const clearCalls = (page: Page) => page.evaluate(() => void ((window as unknown as { __calls: unknown[] }).__calls.length = 0));

export const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { name: string; sync: boolean; type: string | null; active: boolean | null }[] }).__calls);

/** The PNG the last clipboard write was given (its item's promise, awaited in the page). */
export async function writtenPng(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const items = (window as unknown as { __items: ClipboardItem[] }).__items;
    const blob = await items[items.length - 1].getType("image/png");
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

/** Copy image works in this engine as the specs drive it (the page's own check). */
export const canCopy = (page: Page) => page.locator("#snippet-dialog .snippet-actions button", { hasText: "Copy image" }).count().then((n) => n > 0);

export const box = async (l: Locator) => (await l.boundingBox())!;

/**
 * The salience proxy of final-v3 e2e 24 on a screenshot taken at device pixel ratio 1: |mean
 * luminance (sRGB luma, 0 to 255) inside the box minus the mean of a 6 px ring around it|.
 */
export function salience(png: Buffer, b: { x: number; y: number; width: number; height: number }): number {
  const px = decodeRgba(png);
  const lum = (x: number, y: number) => {
    const [r, g, bl] = px.at(x, y);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x0, y0] = [Math.round(b.x), Math.round(b.y)];
  const [x1, y1] = [Math.round(b.x + b.width) - 1, Math.round(b.y + b.height) - 1];
  let inside = 0;
  let n = 0;
  let ring = 0;
  let m = 0;
  for (let y = y0 - 6; y <= y1 + 6; y++) {
    for (let x = x0 - 6; x <= x1 + 6; x++) {
      if (x < 0 || y < 0 || x >= px.width || y >= px.height) continue;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        inside += lum(x, y);
        n++;
      } else {
        ring += lum(x, y);
        m++;
      }
    }
  }
  return Math.round(Math.abs(inside / n - ring / m) * 100) / 100;
}
