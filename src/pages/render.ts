// Fills in the guide pages at build time (vite.config.ts guidePages()): every example's code, the
// input typed into it, what it printed and the help the app showed, all from the capture run
// (captured.json), and every flowchart from the app's own SVG export (flowcharts/<id>.svg).
// Placeholders in the page source:
//   <div data-example="ID"></div>          the example as a frame: code, input, output, help, link
//   <div data-flowchart="ID"></div>        the chart, inline, in the page's colours, with its steps
//   <span data-capture="ID:FIELD"></span>  one captured line, as text (FIELD: error, first, means, tips)
//   <span data-fact="NAME"></span>         a captured fact (packOffer)
// An unknown ID or field stops the build. Everything inserted is text the app produced or a file
// in this repo, and it is escaped; the chart is checked for anything active before it is inlined.
// Pure: the caller reads the files and hands over a link maker (src/core/code-link.ts).
import { mixHex, printColors, type ExportColors } from "../flowchart/export";
import { CHART_TINT, type KindHue } from "../flowchart/render";

export interface CapturedRun {
  status: string | null;
  output: string;
  outputChars: number;
  runlog: string;
  help: { id: string; means: string; tips: string } | null;
  problems: string[];
  steps?: string[];
}

export interface Captured {
  facts: Record<string, string>;
  examples: Record<string, CapturedRun>;
}

export interface GuideData {
  /** Example id to its editor file name, source text and typed input lines. */
  sources: Record<string, { name: string; code: string; stdin: string[] }>;
  captured: Captured;
  /** Example id to the app's exported SVG, as downloaded. */
  charts: Record<string, string>;
}

/** Makes the "Open in Execflow" link for a file (relative: "/#code=1...."). */
export type LinkMaker = (name: string, text: string) => Promise<string>;

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An exception line of a Python traceback ("TypeError: ..."), the last one in the output. */
export function errorLine(run: CapturedRun): string {
  const lines = run.output.split("\n").filter((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit)\b.*:/.test(l));
  if (!lines.length) throw new Error("no error line in the captured output");
  return lines[lines.length - 1];
}

/**
 * The output's lines as HTML. Typed input (the stdin lines, in order) is marked where the console
 * echoed it, at the end of its line. A line the app adds after a failed run (it starts with one
 * space, its icon's place) is shown as the app's note, apart from the program's own output.
 */
export function outputHtml(run: CapturedRun, stdin: readonly string[]): string {
  const typed = [...stdin];
  const lines = run.output.replace(/\n$/, "").split("\n");
  return lines
    .map((line) => {
      if (run.status !== "ok" && /^ \S/.test(line)) return `<span class="ex-note">${escapeHtml(line.slice(1))}</span>`;
      const next = typed[0];
      if (next !== undefined && next !== "" && line.endsWith(next)) {
        typed.shift();
        return `${escapeHtml(line.slice(0, line.length - next.length))}<kbd class="ex-typed">${escapeHtml(next)}</kbd>`;
      }
      return escapeHtml(line);
    })
    .join("\n");
}

const STATUS_WORDS: Record<string, string> = {
  ok: "Finished",
  error: "Stopped with an error",
  "build-failed": "Didn't compile",
  crashed: "Crashed",
  "output-limit": "Stopped at the output limit",
  timeout: "Stopped at the time limit",
};

async function exampleHtml(id: string, data: GuideData, link: LinkMaker): Promise<string> {
  const src = data.sources[id];
  const run = data.captured.examples[id];
  if (!src || !run) throw new Error(`guide pages: no example "${id}" (source or capture missing)`);
  const words = STATUS_WORDS[run.status ?? ""];
  if (!words) throw new Error(`guide pages: example "${id}" has an unknown status "${run.status}"`);
  const href = await link(src.name, src.code);
  const code = escapeHtml(src.code.replace(/\n$/, ""));
  const input = src.stdin.length
    ? `<p class="ex-typed-note">Typed while it ran: ${src.stdin.map((s) => `<kbd class="ex-typed">${escapeHtml(s)}</kbd>`).join(", then ")}</p>`
    : "";
  const help = run.help
    ? `<div class="ex-help"><p class="ex-help-title">Execflow's explanation</p><p>${escapeHtml(run.help.means)}</p><p>${escapeHtml(run.help.tips)}</p></div>`
    : "";
  return [
    `<div class="ex" id="ex-${id}">`,
    `<div class="ex-bar"><span class="ex-file">${escapeHtml(src.name)}</span><a class="ex-open" href="${escapeHtml(href)}">Open in Execflow<span class="ex-sr"> (${escapeHtml(src.name)})</span></a></div>`,
    `<div class="ex-panes">`,
    `<pre class="ex-code"><code>${code}</code></pre>`,
    `<div class="ex-run"><p class="ex-label">Output <span class="ex-status" data-status="${escapeHtml(run.status ?? "")}">${words}</span></p>`,
    `<pre class="ex-out">${outputHtml(run, src.stdin)}</pre>${input}${help}</div>`,
    `</div>`,
    `</div>`,
  ].join("");
}

// ---------------------------------------------------------------- the flowchart, in the page's colours

const HUES: readonly KindHue[] = ["success", "warning", "info", "action"];

/**
 * Each colour of a Print-safe light export, back to the token it was resolved from (the view's own
 * form: render.ts VIEW_LOOK). Two tokens with one colour can't be told apart: that stops the build.
 */
export function colorTokens(colors: ExportColors = printColors()): Map<string, string> {
  const map = new Map<string, string>();
  const add = (hex: string, value: string) => {
    const key = hex.toLowerCase();
    const had = map.get(key);
    if (had !== undefined && had !== value) throw new Error(`guide pages: ${key} is both ${had} and ${value} in the export's colours`);
    map.set(key, value);
  };
  for (const [token, hex] of Object.entries(colors)) {
    // The export's ground and rule are not in the chart itself (its ground is surface-raised's colour).
    if (token === "bg" || token === "border") continue;
    add(hex, `var(--${token})`);
  }
  for (const hue of HUES) add(mixHex(colors[hue], colors["surface-raised"], CHART_TINT), `color-mix(in srgb, var(--${hue}) ${CHART_TINT}%, var(--surface-raised))`);
  return map;
}

/**
 * The chart of an exported SVG, for inlining: the drawing only (the export's ground and its footer
 * credit are left out), every colour the token it came from and every font the page's, so it follows
 * the page's light and dark themes. Refuses anything that could act: scripts, handlers, links, styles.
 */
export function chartSvg(raw: string, label: string): string {
  const start = raw.indexOf("<svg", raw.indexOf("<svg") + 1);
  const end = raw.indexOf("</svg>", start);
  if (start < 0 || end < 0) throw new Error("guide pages: the export has no chart inside it");
  const inner = raw.slice(start, end + "</svg>".length);
  if (/<(script|style|foreignObject|a|image|use)\b|\son\w+\s*=|href\s*=|url\(|javascript:/i.test(inner)) {
    throw new Error("guide pages: the exported chart contains something active");
  }
  const box = /^<svg [^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"[^>]*>/.exec(inner);
  if (!box) throw new Error("guide pages: the chart has no view box");
  const [, w, h] = box;
  const tokens = colorTokens();
  let body = inner.slice(box[0].length, inner.length - "</svg>".length);
  body = body.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => {
    const token = tokens.get(hex.toLowerCase());
    if (!token) throw new Error(`guide pages: ${hex} is not one of the export's colours`);
    return token;
  });
  // The list as serialised: quoted names are &quot;...&quot;, whose ";" doesn't end the declaration.
  body = body.replace(/font-family:((?:&quot;|[^;"])*)/g, (_m, list: string) => {
    if (/Geist/.test(list)) return "font-family:var(--font-ui)";
    if (/JetBrains Mono/.test(list)) return "font-family:var(--font-code)";
    throw new Error(`guide pages: an unknown font list in the chart: ${list}`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="fc-chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeHtml(label)}" focusable="false">${body}</svg>`;
}

function flowchartHtml(id: string, data: GuideData): string {
  const src = data.sources[id];
  const run = data.captured.examples[id];
  const raw = data.charts[id];
  if (!src || !run?.steps || !raw) throw new Error(`guide pages: no flowchart "${id}" (source, steps or SVG missing)`);
  const title = /<title>([^<]*)<\/title>/.exec(raw)?.[1];
  if (!title) throw new Error(`guide pages: the export of "${id}" has no title`);
  // "Flowchart of find in find.py" (the export's own title), and where its words are.
  const label = `${title.replace(/&amp;/g, "&")}. Its steps are listed as text under it.`;
  return [
    `<figure class="fc-figure" id="chart-${id}">`,
    `<div class="fc-frame">${chartSvg(raw, label)}</div>`,
    `<details class="fc-steps"><summary>Steps as text</summary><ol>${run.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol></details>`,
    `</figure>`,
  ].join("");
}

function captureText(spec: string, data: GuideData): string {
  const [id, field] = spec.split(":");
  const run = data.captured.examples[id];
  if (!run) throw new Error(`guide pages: no captured run "${id}"`);
  if (field === "error") return escapeHtml(errorLine(run));
  if (field === "first") return escapeHtml(run.output.split("\n")[0]);
  if ((field === "means" || field === "tips") && run.help) return escapeHtml(run.help[field]);
  throw new Error(`guide pages: no field "${field}" for "${id}"`);
}

/** The page with every placeholder filled in. */
export async function expandGuide(html: string, data: GuideData, link: LinkMaker): Promise<string> {
  const ids = [...html.matchAll(/<div data-example="([\w-]+)"><\/div>/g)].map((m) => m[1]);
  const examples = new Map(await Promise.all(ids.map(async (id) => [id, await exampleHtml(id, data, link)] as const)));
  return html
    .replace(/<div data-example="([\w-]+)"><\/div>/g, (_m, id: string) => examples.get(id)!)
    .replace(/<div data-flowchart="([\w-]+)"><\/div>/g, (_m, id: string) => flowchartHtml(id, data))
    .replace(/<span data-capture="([\w-]+:\w+)"><\/span>/g, (_m, spec: string) => captureText(spec, data))
    .replace(/<span data-fact="(\w+)"><\/span>/g, (_m, name: string) => {
      const fact = data.captured.facts[name];
      if (fact === undefined) throw new Error(`guide pages: no captured fact "${name}"`);
      return escapeHtml(fact);
    });
}
