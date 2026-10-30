// The public site as search engines and link previews see it: its pages, each page's canonical
// address and social tags (vite.config.ts adds them to every page at build time, from the page's own
// <title> and description), the sitemap, and the sign-in rewrite beside the real 404 page. No DOM
// code, and no imports: vite.config.ts loads it under Node.
// Google: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
// Open Graph: https://ogp.me/  Sitemaps: https://www.sitemaps.org/protocol.html

/**
 * The address the site is published at (Cloudflare Pages, custom domain). Since 0.12.0; the old
 * address, https://code-editor.abhinesh.codes, still serves the same build while students move
 * their files (src/ui/address-move.ts), and canonical tags point here from both.
 */
export const ORIGIN = "https://execflow.abhinesh.codes";

/** The pages to index, in sitemap order: the path they are served at and the HTML file behind it. */
export const PAGES = [
  { path: "/", file: "index.html" },
  { path: "/about", file: "about.html" },
  { path: "/privacy", file: "privacy.html" },
  { path: "/terms", file: "terms.html" },
] as const;

/**
 * Vite's HTML entry points: the pages, plus 404.html, which Cloudflare Pages serves with a 404 for
 * any address that is not a file (with a top-level 404.html, Pages leaves its single-page-app mode,
 * where every unknown address answered 200 with the editor).
 * https://developers.cloudflare.com/pages/configuration/serving-pages/
 */
export const HTML_INPUT: Record<string, string> = {
  index: "index.html",
  privacy: "privacy.html",
  terms: "terms.html",
  about: "about.html",
  notFound: "404.html",
};

/**
 * The picture a shared link shows (public/media/, its name carries its sha256 like the About
 * page's media; rendered by scripts/make-social-card.mjs).
 */
export const SOCIAL_CARD = {
  path: "/media/social-card.1b0e2b95.png",
  width: 1200,
  height: 630,
  alt: "ExecFlow: write, run and chart Python, C and C++ in your browser.",
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The canonical link, Open Graph and Twitter card tags for the page served at `path`. */
export function headTags(path: string, title: string, description: string): string {
  const url = escape(ORIGIN + path);
  const image = escape(ORIGIN + SOCIAL_CARD.path);
  const og = (property: string, content: string) => `<meta property="og:${property}" content="${content}" />`;
  return [
    `<link rel="canonical" href="${url}" />`,
    og("type", "website"),
    og("site_name", "ExecFlow"),
    og("title", escape(title)),
    og("description", escape(description)),
    og("url", url),
    og("image", image),
    og("image:width", String(SOCIAL_CARD.width)),
    og("image:height", String(SOCIAL_CARD.height)),
    og("image:alt", escape(SOCIAL_CARD.alt)),
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${escape(SOCIAL_CARD.alt)}" />`,
  ].join("\n    ");
}

/**
 * The page with its head tags added after its description, for the page served at `path`. Its own
 * <title> and description supply the text; a page without either stops the build.
 */
export function withHeadTags(html: string, path: string): string {
  const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
  const description = /( *)(<meta name="description" content="([^"]+)" \/>)/.exec(html);
  if (!title || !description) throw new Error(`${path}: the page needs a <title> and a <meta name="description"> for its head tags.`);
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const at = description.index + description[0].length;
  return `${html.slice(0, at)}\n${description[1]}${headTags(path, unescape(title), unescape(description[3]))}${html.slice(at)}`;
}

/**
 * The file Cloudflare Pages serves for a path, or null when it serves 404.html with a 404: the file
 * itself, the page without its .html, or a folder's index.html. `vite preview` uses it, so the
 * end-to-end tests meet the same 404s as the deployed site.
 */
export function pagesFile(path: string, isFile: (file: string) => boolean): string | null {
  if (path.endsWith("/")) return isFile(`${path}index.html`) ? `${path}index.html` : null;
  if (isFile(path)) return path;
  return isFile(`${path}.html`) ? `${path}.html` : null;
}

/**
 * A request's path, decoded, when `vite preview` may look it up in the build: null (a 404) for a
 * path that does not decode, or that holds a NUL, a backslash, an empty segment, "." or "..", so a
 * lookup never leaves the build folder (security review m3, 2026-10-29). Browsers resolve dot
 * segments before they send a request; only a hand-made one has them.
 */
export function servedPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || /[\0\\]/.test(decoded)) return null;
  const segments = decoded.slice(1).split("/");
  const inner = decoded.endsWith("/") ? segments.slice(0, -1) : segments;
  return inner.every((s) => s !== "" && s !== "." && s !== "..") ? decoded : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A legal page's "Last updated" line (`<span>Last updated</span> <time datetime="2026-10-28">28 October
 * 2026</time>`) as 2026-10-28. The date a reader sees and the machine-readable one must agree; a page
 * without the line, or with two dates that differ, stops the build.
 */
export function lastUpdated(html: string): string {
  const m = /<span>Last updated<\/span>\s*<time datetime="(\d{4}-\d{2}-\d{2})">(\d{1,2}) ([A-Za-z]+) (\d{4})<\/time>/.exec(html);
  if (!m) throw new Error('No "Last updated <time datetime=...>day month year</time>" line for the sitemap.');
  const month = MONTHS.indexOf(m[3]) + 1;
  if (!month) throw new Error(`Unknown month in "Last updated": ${m[3]}`);
  const shown = `${m[4]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (shown !== m[1]) throw new Error(`"Last updated" says ${m[2]} ${m[3]} ${m[4]} but its datetime is ${m[1]}`);
  return shown;
}

/**
 * Each page's last real change, for the sitemap's lastmod (Google uses it only while it is accurate):
 * the editor and About (which carries What's new) change with each release (`released`, the newest
 * release's date in src/about/changelog.ts); Privacy and Terms say their own date.
 */
export function pageDates(read: (file: string) => string, released: string): { path: string; lastmod: string }[] {
  return PAGES.map((p) => ({ path: p.path, lastmod: p.file === "privacy.html" || p.file === "terms.html" ? lastUpdated(read(p.file)) : released }));
}

/** sitemap.xml for the given pages (absolute addresses; Google ignores priority and changefreq). */
export function sitemapXml(entries: { path: string; lastmod: string }[]): string {
  const urls = entries.map((e) => `  <url><loc>${escape(ORIGIN + e.path)}</loc><lastmod>${e.lastmod}</lastmod></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}

/**
 * The rewrites (status 200) in a Cloudflare Pages _redirects file, source to target. `vite preview`
 * applies the same ones, so the end-to-end tests see what the deployed site serves.
 * https://developers.cloudflare.com/pages/configuration/redirects/
 */
export function parseRewrites(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const [from, to, code] = line.trim().split(/\s+/);
    if (from && !from.startsWith("#") && to && code === "200") out.set(from, to);
  }
  return out;
}
