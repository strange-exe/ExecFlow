// The text of each page of a PDF that Chromium's page.pdf() wrote (Skia's writer), for the print
// tests (print.spec.ts): enough of PDF 1.4 to read it back, no dependency. Skia writes plain
// indirect objects (no object streams), Flate-compressed content streams, and its fonts as Type0
// with a ToUnicode CMap (two-byte codes in hex strings) or as simple fonts. Text is returned in
// drawing order, one line per text object; positions are ignored, so compare with whitespace
// removed. Not a general PDF reader: anything it does not understand is skipped, never guessed.
import { inflateSync } from "node:zlib";

interface PdfObject {
  readonly dict: string;
  readonly stream: Buffer | null;
}

/** Every `N 0 obj ... endobj` with its dictionary text and its decoded stream. */
function objects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1");
  const out = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[2];
    const at = body.search(/stream\r?\n/);
    if (at < 0) {
      out.set(Number(m[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, at);
    const start = m.index + m[0].indexOf(body) + at + body.slice(at).match(/^stream\r?\n/)![0].length;
    const length = Number(/\/Length (\d+)(?! 0 R)/.exec(dict)?.[1] ?? -1);
    const raw = length >= 0 ? pdf.subarray(start, start + length) : Buffer.from(body.slice(at).replace(/^stream\r?\n/, "").replace(/\r?\nendstream[\s\S]*$/, ""), "latin1");
    let stream: Buffer | null = raw;
    if (/\/Filter\s*\/FlateDecode/.test(dict)) {
      try {
        stream = inflateSync(raw);
      } catch {
        stream = null;
      }
    }
    out.set(Number(m[1]), { dict, stream });
  }
  return out;
}

const refs = (text: string) => [...text.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));

/** A ToUnicode CMap: code (hex) to text. */
function cmap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const unicode = (hex: string) => {
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(m[1].toLowerCase(), unicode(m[2]));
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const width = m[1].length;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const list = m[4] ? [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]) : null;
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        const key = c.toString(16).padStart(width, "0");
        if (list) map.set(key, unicode(list[c - lo] ?? ""));
        else {
          const base = parseInt(m[3]!, 16) + (c - lo);
          map.set(key, String.fromCodePoint(base));
        }
      }
    }
  }
  return map;
}

interface Font {
  readonly bytes: 1 | 2;
  readonly map: Map<string, string> | null;
}

/** A PDF literal string's bytes (the escapes of PDF 1.4 section 3.2.3). */
function literal(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out.push(c.charCodeAt(0));
      continue;
    }
    const n = s[++i];
    const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (n in esc) out.push(esc[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i];
      out.push(parseInt(oct, 8));
    }
  }
  return out;
}

function decode(font: Font | undefined, bytes: number[]): string {
  const size = font?.bytes ?? 1;
  let s = "";
  for (let i = 0; i + size <= bytes.length; i += size) {
    const code = size === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const key = code.toString(16).padStart(size * 2, "0");
    s += font?.map?.get(key) ?? (size === 1 ? String.fromCharCode(code) : "");
  }
  return s;
}

/** Every non-stroking colour the pages set with `r g b rg`, as #rrggbb (the text colours, and any fills). */
export function pdfFillColours(pdf: Buffer): Set<string> {
  const out = new Set<string>();
  for (const o of objects(pdf).values()) {
    const ops = o.stream?.toString("latin1") ?? "";
    if (/\/Type\s*\/(XObject|Font|FontDescriptor)\b/.test(o.dict) && !/\/Subtype\s*\/Form/.test(o.dict)) continue;
    for (const m of ops.matchAll(/(?:^|\s)([\d.]+) ([\d.]+) ([\d.]+) rg\b/g)) {
      out.add(`#${[m[1], m[2], m[3]].map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, "0")).join("")}`);
    }
  }
  return out;
}

/** The text of every page, in page order. */
export function pdfPages(pdf: Buffer): string[] {
  const objs = objects(pdf);
  const fonts = new Map<number, Font>();
  for (const [n, o] of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.dict)) continue;
    const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    const map = toUnicode ? cmap(objs.get(Number(toUnicode[1]))?.stream?.toString("latin1") ?? "") : null;
    fonts.set(n, { bytes: /\/Subtype\s*\/Type0/.test(o.dict) ? 2 : 1, map });
  }
  // Pages in the order the page tree lists them.
  const root = [...objs.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent/.test(o.dict));
  const order: number[] = [];
  const walk = (n: number) => {
    const o = objs.get(n);
    if (!o) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) for (const k of refs(/\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? "")) walk(k);
    else if (/\/Type\s*\/Page\b/.test(o.dict)) order.push(n);
  };
  if (root) for (const k of refs(/\/Kids\s*\[([^\]]*)\]/.exec(root.dict)?.[1] ?? "")) walk(k);
  return order.map((n) => {
    const page = objs.get(n)!;
    // The page's fonts by resource name, from its resources (inline or a reference).
    let resources = /\/Resources\s*(\d+) 0 R/.exec(page.dict) ? objs.get(Number(/\/Resources\s*(\d+) 0 R/.exec(page.dict)![1]))?.dict ?? "" : page.dict;
    const fontDict = /\/Font\s*(\d+) 0 R/.exec(resources);
    if (fontDict) resources = objs.get(Number(fontDict[1]))?.dict ?? resources;
    const named = new Map<string, Font>();
    for (const m of resources.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+) 0 R/g)) {
      const f = fonts.get(Number(m[2]));
      if (f) named.set(m[1], f);
    }
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? "";
    const ops = refs(contents).map((r) => objs.get(r)?.stream?.toString("latin1") ?? "").join("\n");
    let font: Font | undefined;
    let line = "";
    const lines: string[] = [];
    const token = /\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)|\b(BT|ET|TJ|Tj|'|")\b/g;
    for (const m of ops.matchAll(token)) {
      if (m[1]) font = named.get(m[1]);
      else if (m[2] !== undefined) {
        const hex = m[2].replace(/\s+/g, "");
        const bytes: number[] = [];
        for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
        line += decode(font, bytes);
      } else if (m[3] !== undefined) line += decode(font, literal(m[3]));
      else if (m[4] === "BT" || m[4] === "ET") {
        if (line) lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    return lines.join("\n");
  });
}
