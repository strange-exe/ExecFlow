/// <reference types="node" />
// The guide pages (src/pages/routes.ts) as the build makes them (render.ts, vite.config.ts
// guidePages): every "Open in Execflow" link decodes, through the app's own code-link reader, to
// exactly the code shown beside it; every example and chart comes from the capture run; each page's
// head says what its route says; and the inlined charts are drawn only in the page's tokens.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeCodeLink, readCodeLink } from "../core/code-link";
import { printColors } from "../flowchart/export";
import { EXAMPLES } from "./examples";
import { loadGuideData } from "./load";
import { chartSvg, colorTokens, errorLine, escapeHtml, expandGuide, outputHtml, type CapturedRun } from "./render";
import { GUIDE_PATH, GUIDE_ROUTES, SITE } from "./routes";

const data = loadGuideData(process.cwd());
const link = async (name: string, text: string) => {
  const made = await makeCodeLink("", name, text);
  if (!made.ok) throw new Error(made.refusal.kind);
  return made.url;
};
const built = new Map<string, string>();
async function page(file: string): Promise<string> {
  if (!built.has(file)) built.set(file, await expandGuide(readFileSync(file, "utf8"), data, link));
  return built.get(file)!;
}
const attr = (html: string, re: RegExp) => re.exec(html)?.[1];
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe.each(GUIDE_ROUTES)("$path", (route) => {
  it("every Open in Execflow link opens exactly the code shown beside it, under the example's name", async () => {
    const html = await page(route.file);
    const blocks = [...html.matchAll(/<div class="ex" id="ex-([\w-]+)">.*?<span class="ex-file">([^<]*)<\/span><a class="ex-open" href="([^"]+)">.*?<pre class="ex-code"><code>(.*?)<\/code><\/pre>/gs)];
    expect(blocks.length).toBe((html.match(/class="ex-open"/g) ?? []).length);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const [, id, file, href, shown] of blocks) {
      expect(href.startsWith("/#code=1.")).toBe(true);
      const read = await readCodeLink(unescape(href).slice(1));
      expect(read, id).toEqual({ ok: true, file: { name: EXAMPLES[id].name, text: data.sources[id].code } });
      expect(unescape(file)).toBe(EXAMPLES[id].name);
      // The page shows the same program the link carries (its last newline aside).
      expect(unescape(shown)).toBe(data.sources[id].code.replace(/\n$/, ""));
    }
  });

  it("its head matches the route: title, canonical, Open Graph and Twitter tags, one h1", async () => {
    const html = await page(route.file);
    const url = `${SITE}${route.path}`;
    expect(attr(html, /<title>([^<]*)<\/title>/)).toBe(route.title);
    expect(attr(html, /<link rel="canonical" href="([^"]+)"/)).toBe(url);
    expect(attr(html, /<meta property="og:url" content="([^"]+)"/)).toBe(url);
    const description = attr(html, /<meta name="description" content="([^"]+)"/)!;
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(200);
    for (const tag of ["og:title", "og:description", "og:type", "og:site_name"]) expect(html).toMatch(new RegExp(`<meta property="${tag}" content="[^"]+"`));
    for (const tag of ["twitter:card", "twitter:title", "twitter:description"]) expect(html).toMatch(new RegExp(`<meta name="${tag}" content="[^"]+"`));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // Headings never skip a level (h2 after h1, h3 after h2).
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    levels.forEach((level, i) => i && expect(level - levels[i - 1], `heading ${i}`).toBeLessThanOrEqual(1));
  });

  it("links to the other three guides, the About page, the privacy page and the editor; no placeholder is left", async () => {
    const html = await page(route.file);
    for (const other of GUIDE_ROUTES) expect(html).toContain(`href="${other.path}"`);
    for (const path of ["/about", "/privacy", "/"]) expect(html).toContain(`href="${path}"`);
    expect(html).not.toMatch(/data-(example|flowchart|capture|fact)=/);
    // No script of its own besides the theme painter (the CSP forbids inline scripts anyway).
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="theme-boot.js">']);
    expect(html).toContain(`aria-current="page"`);
    expect(attr(html, /<a href="([^"]+)" aria-current="page"/)).toBe(route.path);
  });

  it("is ASCII with LF line endings (characters as HTML entities)", () => {
    const bytes = readFileSync(route.file);
    expect([...bytes].filter((b) => b > 0x7e || (b < 0x20 && b !== 0x0a)).length).toBe(0);
  });
});

describe("the pages' examples", () => {
  it("every example is on a page, and every captured run belongs to an example", async () => {
    const all = (await Promise.all(GUIDE_ROUTES.map((r) => page(r.file)))).join("\n");
    const sources = GUIDE_ROUTES.map((r) => readFileSync(r.file, "utf8")).join("\n");
    for (const id of Object.keys(EXAMPLES)) {
      expect(all.includes(`id="ex-${id}"`) || sources.includes(`data-capture="${id}:`), id).toBe(true);
    }
    expect(Object.keys(data.captured.examples).sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  it("every flowchart example has its export, its steps, and a chart beside its code", async () => {
    const html = await page("flowchart-from-code.html");
    for (const [id, ex] of Object.entries(EXAMPLES).filter(([, e]) => e.chart)) {
      expect(data.captured.examples[id].steps?.length, id).toBeGreaterThan(3);
      expect(data.charts[id]).toContain(`<title>Flowchart of ${ex.chart} in ${ex.name}</title>`);
      expect(html).toContain(`id="chart-${id}"`);
    }
  });

  it("a run's output marks the typed input where it was echoed, and escapes everything", () => {
    const run: CapturedRun = { status: "ok", output: "Name? <b>Ada</b>\nHi, <b>Ada</b>!\n", outputChars: 0, runlog: "", help: null, problems: [] };
    expect(outputHtml(run, ["<b>Ada</b>"])).toBe('Name? <kbd class="ex-typed">&lt;b&gt;Ada&lt;/b&gt;</kbd>\nHi, &lt;b&gt;Ada&lt;/b&gt;!');
    const failed: CapturedRun = { ...run, status: "crashed", output: "Which? 9\n The program crashed.\n" };
    expect(outputHtml(failed, ["9"])).toBe('Which? <kbd class="ex-typed">9</kbd>\n<span class="ex-note">The program crashed.</span>');
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("an error line is the traceback's last exception", () => {
    expect(errorLine(data.captured.examples["py-thread"])).toBe("RuntimeError: can't start new thread");
    expect(() => errorLine(data.captured.examples["py-list"])).toThrow();
  });
});

describe("an inlined flowchart", () => {
  it("is drawn only in the page's tokens and fonts, without the export's ground or footer", () => {
    for (const raw of Object.values(data.charts)) {
      const svg = chartSvg(raw, "A chart");
      expect(svg).not.toMatch(/#[0-9a-f]{6}/i);
      expect(svg).toMatch(/var\(--text\)/);
      expect(svg).not.toContain("Made with");
      expect(svg).not.toContain("&quot;");
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" class="fc-chart"')).toBe(true);
      expect(svg).toContain('role="img" aria-label="A chart"');
    }
  });

  it("refuses an export with anything active in it, or a colour that isn't the export's", () => {
    const raw = data.charts["fc-loop"];
    const inner = raw.indexOf("<g>");
    for (const bad of ['<script>alert(1)</script>', '<g onclick="x()"></g>', '<a href="https://example.com"></a>', '<rect style="fill:url(#x)"/>']) {
      expect(() => chartSvg(raw.slice(0, inner) + bad + raw.slice(inner), "x"), bad).toThrow(/active/);
    }
    expect(() => chartSvg(raw.slice(0, inner) + '<rect style="fill:#123456"/>' + raw.slice(inner), "x")).toThrow(/not one of the export's colours/);
  });

  it("maps no two tokens to one colour", () => {
    const map = colorTokens();
    expect(new Set(map.values()).size).toBe(map.size);
    const print = printColors();
    expect(print.info).not.toBe(print.action);
    expect(() => colorTokens({ ...print, info: print.action })).toThrow(/is both/);
  });
});

describe("GUIDE_PATH (navigateFallbackDenylist)", () => {
  it.each(["/python", "/python.html", "/python/", "/c", "/cpp?ref=x", "/flowchart-from-code", "/flowchart-from-code.html?a=b.c"])("%s is a guide page, never the editor", (url) => {
    expect(GUIDE_PATH.test(url)).toBe(true);
  });
  it.each(["/", "/about", "/pythonx", "/c/x", "/cpp.js", "/assets/c.js", "/?x=/python"])("%s is not", (url) => {
    expect(GUIDE_PATH.test(url)).toBe(false);
  });
});
