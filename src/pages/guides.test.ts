/// <reference types="node" />
// The guide pages (src/pages/routes.ts) as the build makes them (render.ts, vite.config.ts
// guidePages): every "Open in ExecFlow" link decodes, through the app's own code-link reader, to
// exactly the code shown beside it; every example and chart comes from the capture run; each page's
// head says what its route says; and the inlined charts are drawn only in the page's tokens.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeCodeLink, readCodeLink } from "../core/code-link";
import { printColors } from "../flowchart/export";
import { EXAMPLES } from "./examples";
import { loadGuideData } from "./load";
import { chartSvg, colorTokens, errorLine, escapeHtml, expandGuide, outputHtml, warningText, type CapturedRun } from "./render";
import { GUIDE_PATH, GUIDE_ROUTES, SITE } from "./routes";
import { NAVIGATE_DENYLIST } from "../about/fallback-deny";

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
  it("every Open in ExecFlow link opens exactly the code shown beside it, under the example's name", async () => {
    const html = await page(route.file);
    const blocks = [...html.matchAll(/<div class="ex" id="ex-([\w-]+)">.*?<span class="ex-file">([^<]*)<\/span><a class="ex-open" href="([^"]+)">.*?<pre class="ex-code"[^>]*><code>(.*?)<\/code><\/pre>/gs)];
    expect(blocks.length).toBe((html.match(/class="ex-open"/g) ?? []).length);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const [, id, file, href, shown] of blocks) {
      expect(href.startsWith("/#code=1.")).toBe(true);
      const read = await readCodeLink(unescape(href).slice(1));
      expect(read, id).toEqual({ ok: true, file: { name: EXAMPLES[id].name, text: data.sources[id].code } });
      expect(unescape(file)).toBe(EXAMPLES[id].name);
      // The page shows the same program the link carries (its last newline aside), escaped as text:
      // "#include <stdio.h>" raw in the page would be read as a tag and never shown.
      expect(shown, id).toBe(escapeHtml(data.sources[id].code.replace(/\n$/, "")));
    }
    // A code block keeps its lines whole and scrolls sideways, so it is a named keyboard stop.
    for (const [, id] of blocks) {
      expect(html).toContain(`<pre class="ex-code" tabindex="0" role="group" aria-label="Code of ${escapeHtml(EXAMPLES[id].name)}"><code>`);
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
    // Long enough to say something, short enough not to be cut off in a results page.
    expect(description.length).toBeLessThanOrEqual(160);
    expect(attr(html, /<meta property="og:description" content="([^"]+)"/)!.length).toBeLessThanOrEqual(160);
    expect(attr(html, /<meta name="twitter:description" content="([^"]+)"/)!.length).toBeLessThanOrEqual(160);
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

  it("names the product ExecFlow everywhere it is seen: title, headings, link text, prose and tags", async () => {
    const html = await page(route.file);
    // 0.16.0 renamed CodeEditor to ExecFlow (owner, 2026-10-30): the old name is gone from the page
    // (a lowercase "code editor" is the common noun, as in "what code editors use").
    expect(html).not.toMatch(/CodeEditor|Code Editor/);
    expect(attr(html, /<title>([^<]*)<\/title>/)).toMatch(/ \| ExecFlow$/);
    expect(attr(html, /<meta property="og:site_name" content="([^"]+)"/)).toBe("ExecFlow");
    const opens = html.match(/class="ex-open"/g) ?? [];
    expect(html.match(/>Open in ExecFlow<span class="ex-sr">/g) ?? []).toHaveLength(opens.length);
  });

  it("says what Open in ExecFlow really does: a preview first, the editor only after Add to my files", async () => {
    const html = await page(route.file);
    const intro = attr(html, /<section aria-labelledby="examples">([\s\S]*?)<div class="guide-example">/)!.replace(/\s+/g, " ");
    expect(intro).toContain("<strong>Open in ExecFlow</strong> shows");
    expect(intro).toContain("a preview");
    expect(intro).toContain("<strong>Add to my files</strong> puts it in the editor");
    expect(intro).toContain("until you press Run");
    expect(html).not.toMatch(/puts (it|the program) in the editor without|loads it into the editor/);
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
    const html = (await Promise.all(GUIDE_ROUTES.map((r) => page(r.file)))).join("\n");
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

  it("a warning is the compiler's message from its Problems row, without the place or the help", () => {
    const run = data.captured.examples["c-amp"];
    expect(warningText(run, "age.c", 1)).toBe("variable 'age' is uninitialized when used here");
    expect(warningText(run, "age.c", 2)).toBe("format specifies type 'int *' but the argument has type 'int'");
    expect(() => warningText(run, "age.c", 3)).toThrow(/no warning 3/);
    expect(() => warningText(data.captured.examples["c-semicolon"], "semicolon.c", 1)).toThrow();
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

describe("what the pages say matches the app (fact review)", () => {
  const section = (html: string, id: string) => attr(html, new RegExp(`<section aria-labelledby="${id}">([\\s\\S]*?)</section>`))!;

  it("the flowchart page's list of steps not drawn box by box is a list of examples, right per language", async () => {
    const limits = section(await page("flowchart-from-code.html"), "limits");
    expect(limits).toContain("For example:");
    // C has no try: only C++ does.
    expect(limits).toContain("<code>try</code> blocks (C++)");
    expect(limits.match(/spans several lines/g)).toHaveLength(2);
    expect(limits).toContain("<code>case</code> label inside a block or loop");
  });

  it("the C++ page says the precompiled header is kept for the last few settings, not for every one", async () => {
    const html = await page("cpp.html");
    expect(html).not.toContain("once per standard");
    expect(html).toContain("kept for the last few compiler settings used");
  });

  it("the Python page gives the real first download (about 13.5 MB with pyodide.asm.mjs), never 12 MB", async () => {
    const html = await page("python.html");
    expect(html).not.toMatch(/\b12 MB/);
    expect(html.match(/about 13\.5 MB/gi)).toHaveLength(3);
  });

  it("the Python page says the output limit counts thousands of 1,024 characters", async () => {
    const html = (await page("python.html")).replace(/\s+/g, " ");
    expect(html).not.toContain("4,096 thousand characters");
    expect(html).toContain("counted in thousands of characters of 1,024 each (the default, 512, is the 524,288 above)");
  });
});

// /loop-flowcharts (plan-phase2.md batch 1, page 2): its examples are the "lp-" ones.
describe("/loop-flowcharts", () => {
  const FILE = "loop-flowcharts.html";
  const LP = Object.keys(EXAMPLES).filter((id) => id.startsWith("lp-"));
  const out = (id: string) => data.captured.examples[id].output;

  it("is a guide route, with a title of at most 60 characters and a description of at most 160", () => {
    const route = GUIDE_ROUTES.find((r) => r.path === "/loop-flowcharts");
    expect(route?.file).toBe(FILE);
    expect(route!.title.length).toBeLessThanOrEqual(60);
    expect(GUIDE_PATH.test("/loop-flowcharts?ref=x")).toBe(true);
    const description = attr(readFileSync(FILE, "utf8"), /<meta name="description" content="([^"]+)"/)!;
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("shows every lp- example, each with a captured run, and a chart for each loop's C and Python program", async () => {
    const html = await page(FILE);
    expect(LP.length).toBe(16);
    for (const id of LP) {
      expect(html, id).toContain(`id="ex-${id}"`);
      // A captured run (the time-limit example prints nothing, so its status is the evidence).
      expect(data.captured.examples[id]?.status, id).toBeTruthy();
      expect(data.captured.examples[id].runlog, id).toContain(EXAMPLES[id].name);
    }
    const charted = LP.filter((id) => EXAMPLES[id].chart);
    expect(charted).toHaveLength(10);
    for (const id of charted) expect(html, id).toContain(`id="chart-${id}"`);
    // Every program is shown in both languages.
    for (const stem of new Set(LP.map((id) => id.replace(/-(c|py)$/, "")))) {
      expect(LP, stem).toContain(`${stem}-c`);
      expect(LP, stem).toContain(`${stem}-py`);
    }
  });

  it("every capture ran the code the page shows (an example edited after its capture fails here)", () => {
    for (const id of LP) expect(data.captured.examples[id].code, id).toBe(data.sources[id].code);
  });

  it("the captured runs say what the page teaches", () => {
    for (const id of LP.filter((i) => !i.startsWith("lp-endless"))) expect(data.captured.examples[id].status, id).toBe("ok");
    expect(out("lp-for-c")).toContain("7 x 10 = 70");
    expect(out("lp-for-py")).toContain("7 x 10 = 70");
    expect(out("lp-for-py")).not.toContain("7 x 11");
    for (const id of ["lp-while-c", "lp-while-py"]) expect(out(id), id).toMatch(/Sum of digits = 19$/m);
    // The do-while asks again after 15 and 0, and takes 7.
    for (const id of ["lp-do-c", "lp-do-py"]) {
      expect(out(id).match(/Enter a number from 1 to 10: /g), id).toHaveLength(3);
      expect(out(id), id).toMatch(/You chose 7$/m);
    }
    for (const id of ["lp-nested-c", "lp-nested-py"]) expect(out(id).trimEnd().split("\n").map((l) => l.trim()), id).toEqual(["*", "* *", "* * *", "* * * *"]);
    // -3 is skipped by continue, 0 ends the loop with break: 5 + 8.
    for (const id of ["lp-jump-c", "lp-jump-py"]) expect(out(id), id).toMatch(/Total of the positive numbers = 13$/m);
    // Off by one: 1 to 9, never 10.
    for (const id of ["lp-off-c", "lp-off-py"]) expect(out(id).trim(), id).toBe("1 2 3 4 5 6 7 8 9");
    // Changing i inside the loop: C skips, Python doesn't.
    expect(out("lp-change-c").trim()).toBe("1 3 5");
    expect(out("lp-change-py").trim()).toBe("1 2 3 4 5 6");
    // The endless loops are stopped by ExecFlow: one prints until the output limit, one runs into the time limit.
    expect(data.captured.examples["lp-endless-c"].status).toBe("output-limit");
    expect(new Set(out("lp-endless-c").trimEnd().split("\n"))).toEqual(new Set(["i is still 1"]));
    expect(data.captured.examples["lp-endless-c"].help?.id).toBe("limit-output");
    expect(data.captured.examples["lp-endless-py"].status).toBe("timeout");
    expect(data.captured.examples["lp-endless-py"].help?.id).toBe("limit-time");
    expect(data.captured.examples["lp-endless-py"].problems.join("\n")).toContain("forgot_update.py:4:");
  });

  it("says Python has no do-while, and the page links the related guides and the editor", async () => {
    const html = (await page(FILE)).replace(/\s+/g, " ");
    expect(html).toContain("Python has no <code>do</code>-<code>while</code>");
    for (const path of ["/flowchart-from-code", "/python", "/c", "/cpp", "/"]) expect(html).toContain(`href="${path}"`);
    // The other guides link back.
    for (const route of GUIDE_ROUTES.filter((r) => r.file !== FILE)) expect(await page(route.file), route.file).toContain('href="/loop-flowcharts"');
  });
});

describe("NAVIGATE_DENYLIST (the service worker's navigateFallbackDenylist)", () => {
  it("holds GUIDE_PATH, so a guide page the precache misses (/python?ref=x) goes to the network, never the editor", () => {
    expect(NAVIGATE_DENYLIST).toContain(GUIDE_PATH);
    expect(NAVIGATE_DENYLIST.some((re) => re.test("/python?ref=x"))).toBe(true);
    expect(NAVIGATE_DENYLIST.some((re) => re.test("/?ref=x"))).toBe(false);
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
