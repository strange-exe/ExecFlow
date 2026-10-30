/// <reference types="node" />
// What search engines and link previews read (src/about/site.ts): each page's title, description,
// canonical address and social card, the sitemap, robots.txt, the real 404 page with the sign-in
// rewrite beside it, and the home page's structured data, which never claims a rating or review.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALLBACK_PATH } from "../sync/auth-callback";
import { CHANGELOG } from "./changelog";
import { HTML_INPUT, ORIGIN, PAGES, SOCIAL_CARD, headTags, lastUpdated, pageDates, pagesFile, parseRewrites, rewriteFor, servedPath, sitemapXml, withHeadTags } from "./site";

const read = (file: string) => readFileSync(file, "utf8");
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
const descriptionOf = (html: string) => /<meta name="description" content="([^"]*)" \/>/.exec(html)?.[1] ?? "";

describe("each page's title and description", () => {
  it.each(PAGES.map((p) => [p.path, p.file]))("%s (%s): a branded title up to 60 characters, a description of 120 to 160", (_path, file) => {
    const html = read(file);
    const title = titleOf(html);
    expect(title).toContain("ExecFlow");
    expect(title.length).toBeLessThanOrEqual(60);
    const description = descriptionOf(html);
    expect(description.length, description).toBeGreaterThanOrEqual(120);
    expect(description.length, description).toBeLessThanOrEqual(160);
  });

  it("the home and About titles say what students search for: Python, C and C++, online or in the browser", () => {
    expect(titleOf(read("index.html"))).toMatch(/Python, C and C\+\+/);
    expect(titleOf(read("about.html"))).toMatch(/Python, C and C\+\+ in your browser/);
  });
});

describe("headTags", () => {
  const tags = headTags("/about", "About & more", "Runs \"code\" <here>");

  it("names the page's one canonical address and its absolute URL for link previews", () => {
    expect(tags).toContain(`<link rel="canonical" href="${ORIGIN}/about" />`);
    expect(tags).toContain(`<meta property="og:url" content="${ORIGIN}/about" />`);
    expect(headTags("/", "t", "d")).toContain(`<link rel="canonical" href="${ORIGIN}/" />`);
  });

  it("carries the title and description escaped, the site name, and the card with its size and text", () => {
    expect(tags).toContain('<meta property="og:title" content="About &amp; more" />');
    expect(tags).toContain('<meta property="og:description" content="Runs &quot;code&quot; &lt;here&gt;" />');
    expect(tags).toContain('<meta property="og:site_name" content="ExecFlow" />');
    expect(tags).toContain('<meta property="og:type" content="website" />');
    expect(tags).toContain(`<meta property="og:image" content="${ORIGIN}${SOCIAL_CARD.path}" />`);
    expect(tags).toContain('<meta property="og:image:width" content="1200" />');
    expect(tags).toContain('<meta property="og:image:height" content="630" />');
    expect(tags).toContain(`<meta property="og:image:alt" content="${SOCIAL_CARD.alt}" />`);
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(tags).toContain(`<meta name="twitter:image" content="${ORIGIN}${SOCIAL_CARD.path}" />`);
  });
});

describe("withHeadTags", () => {
  const page = '<head>\n    <title>A &amp; B</title>\n    <meta name="description" content="Say &quot;hi&quot;" />\n    <link rel="icon" />\n</head>';

  it("adds the page's tags after its description, from its own title and description", () => {
    const out = withHeadTags(page, "/about");
    expect(out).toBe(page.replace('content="Say &quot;hi&quot;" />', `content="Say &quot;hi&quot;" />\n    ${headTags("/about", "A & B", 'Say "hi"')}`));
    expect(out.indexOf('rel="canonical"')).toBeLessThan(out.indexOf('rel="icon"'));
  });

  it("stops the build for a page without a title or a description", () => {
    expect(() => withHeadTags("<title>t</title>", "/x")).toThrow(/description/);
    expect(() => withHeadTags('<meta name="description" content="d" />', "/x")).toThrow(/title/);
  });

  it.each(PAGES.map((p) => [p.path, p.file]))("%s (%s) gets its tags once, with its own canonical address", (path, file) => {
    const out = withHeadTags(read(file), path);
    expect(out.split('rel="canonical"')).toHaveLength(2);
    expect(out).toContain(`<link rel="canonical" href="${ORIGIN}${path}" />`);
    expect(out).toContain(`<meta property="og:title" content="${titleOf(read(file))}" />`);
  });
});

describe("pagesFile (what Cloudflare Pages serves; vite preview copies it)", () => {
  const files = new Set(["/index.html", "/about.html", "/licenses.txt", "/sw.js", "/media/a.png", "/docs/index.html"]);
  const isFile = (f: string) => files.has(f);

  it.each([
    ["/", "/index.html"],
    ["/about", "/about.html"],
    ["/about.html", "/about.html"],
    ["/licenses.txt", "/licenses.txt"],
    ["/media/a.png", "/media/a.png"],
    ["/docs/", "/docs/index.html"],
  ])("%s is %s", (path, file) => {
    expect(pagesFile(path, isFile)).toBe(file);
  });

  it.each(["/nope", "/about/x", "/media/b.png", "/sitemap", "/x/"])("%s is not a file: 404.html with a 404", (path) => {
    expect(pagesFile(path, isFile)).toBeNull();
  });
});

describe("servedPath (vite preview looks up only decoded paths inside the build)", () => {
  it.each([
    ["/", "/"],
    ["/about", "/about"],
    ["/media/a%20b.png", "/media/a b.png"],
    ["/docs/", "/docs/"],
  ])("%s is %s", (path, decoded) => {
    expect(servedPath(path)).toBe(decoded);
  });

  it.each(["/../package.json", "/media/../../x", "/%2e%2e/x", "/a/%2E%2E/b", "/./about", "/a/.", "/a%5c..%5cx", "/a%00b", "/%E0%A4%A", "about", "//x"])(
    "%s never reaches the file system: 404",
    (path) => {
      expect(servedPath(path)).toBeNull();
    },
  );
});

describe("the build (vite.config.ts) uses these", () => {
  const config = read("vite.config.ts");

  it("builds every page and 404.html, adds the head tags, writes the sitemap, and copies Pages' 404s and rewrites into vite preview", () => {
    // The guide pages (src/pages/routes.ts) are built beside these, so the input spreads HTML_INPUT.
    expect(config).toContain("...HTML_INPUT,");
    expect(config).toContain("withHeadTags(");
    expect(config).toContain('fileName: "sitemap.xml"');
    expect(config).toContain("pagesFile(");
    expect(config).toContain("servedPath(");
    expect(config).toContain("parseRewrites(");
  });

  it("the service worker answers only the editor's own addresses with the editor, so unknown ones reach the 404 page", () => {
    expect(config).toContain("navigateFallbackAllowlist: [APP_ROUTE],");
  });
});

describe("the social card", () => {
  it("is a 1200 x 630 PNG under 120 KB, at a hashed address under /media/", () => {
    expect(SOCIAL_CARD.path).toMatch(/^\/media\/social-card\.[0-9a-f]{8}\.png$/);
    const bytes = readFileSync(`public${SOCIAL_CARD.path}`);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(bytes.length).toBeLessThan(120 * 1024);
  });
});

describe("the sitemap", () => {
  it("lists every page by its absolute address with a lastmod date, and escapes", () => {
    const xml = sitemapXml([{ path: "/", lastmod: "2026-10-29" }, { path: "/a&b", lastmod: "2026-10-01" }]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(xml).toContain(`<url><loc>${ORIGIN}/</loc><lastmod>2026-10-29</lastmod></url>`);
    expect(xml).toContain(`<loc>${ORIGIN}/a&amp;b</loc>`);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("dates the editor and About by the newest release, Privacy and Terms by their own Last updated line", () => {
    const dates = pageDates(read, CHANGELOG[0].date);
    expect(dates.map((d) => d.path)).toEqual(PAGES.map((p) => p.path));
    expect(dates.find((d) => d.path === "/")?.lastmod).toBe(CHANGELOG[0].date);
    expect(dates.find((d) => d.path === "/about")?.lastmod).toBe(CHANGELOG[0].date);
    expect(dates.find((d) => d.path === "/privacy")?.lastmod).toBe(lastUpdated(read("privacy.html")));
    expect(dates.find((d) => d.path === "/terms")?.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The 0.10.0 Privacy/Terms redesign moved the date into a <time datetime> element (it was a
  // "legal-date" paragraph when the sitemap was written), so the line is read in that form.
  it("lastUpdated reads the legal pages' date line, and stops the build without one", () => {
    const line = (iso: string, shown: string) => `<p class="legal-updated"><svg></svg>\n  <span>Last updated</span> <time datetime="${iso}">${shown}</time>\n</p>`;
    expect(lastUpdated(line("2026-03-07", "7 March 2026"))).toBe("2026-03-07");
    expect(() => lastUpdated("<p>no date</p>")).toThrow(/Last updated/);
    expect(() => lastUpdated(line("2026-03-07", "7 Smarch 2026"))).toThrow(/Smarch/);
    expect(() => lastUpdated(line("2026-03-08", "7 March 2026"))).toThrow(/datetime is 2026-03-08/);
    expect(lastUpdated(read("privacy.html"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lastUpdated(read("terms.html"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("robots.txt", () => {
  it("lets every crawler in, keeps the sign-in relay out, and names the sitemap", () => {
    const lines = read("public/robots.txt").trim().split("\n");
    expect(lines).toEqual(["User-agent: *", "Allow: /", "Disallow: /api/", "", `Sitemap: ${ORIGIN}/sitemap.xml`]);
  });
});

describe("real 404s (Cloudflare Pages serves 404.html, so no editor under every address)", () => {
  it("404.html is built with the other pages, is never indexed, and links to the editor and About", () => {
    expect(Object.values(HTML_INPUT).sort()).toEqual(["404.html", ...PAGES.map((p) => p.file)].sort());
    const html = read("404.html");
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).toMatch(/<a [^>]*href="\/about"/);
    expect(html).not.toContain('rel="canonical"');
  });

  it("_redirects serves the editor at /auth-callback, where GitHub sends a student back after sign-in", () => {
    const rewrites = parseRewrites(read("public/_redirects"));
    expect(rewrites.get(CALLBACK_PATH)).toBe("/");
    expect(rewrites.size).toBe(2);
  });

  it("_redirects serves the editor at /s/<id>, a short link's address (src/core/short-link.ts)", () => {
    const rewrites = parseRewrites(read("public/_redirects"));
    expect(rewriteFor(rewrites, "/s/Ab3dEf9hIj")).toBe("/");
    expect(rewriteFor(rewrites, "/s/")).toBe(undefined);
    expect(rewriteFor(rewrites, "/s")).toBe(undefined);
    expect(rewriteFor(rewrites, "/sx/Ab3dEf9hIj")).toBe(undefined);
    expect(rewriteFor(rewrites, "/api/links/Ab3dEf9hIj")).toBe(undefined);
  });

  it("parseRewrites keeps 200 rules only and skips comments", () => {
    expect([...parseRewrites("# note\n/a /b 200\n/c /d 301\n\n/e /f\n")]).toEqual([["/a", "/b"]]);
  });

  it("rewriteFor matches exact sources first, then splats", () => {
    const rules = parseRewrites("/x/* /splat 200\n/x/a /exact 200\n");
    expect(rewriteFor(rules, "/x/a")).toBe("/exact");
    expect(rewriteFor(rules, "/x/b/c")).toBe("/splat");
    expect(rewriteFor(rules, "/x/")).toBe(undefined);
    expect(rewriteFor(rules, "/y/a")).toBe(undefined);
  });
});

describe("the home page", () => {
  const html = read("index.html");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const keys = (v: unknown): string[] => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);

  it("has one JSON-LD block: WebSite (the site name) and WebApplication, free, with no rating or review", () => {
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]);
    expect(data["@context"]).toBe("https://schema.org");
    const site = data["@graph"].find((n: { "@type": string }) => n["@type"] === "WebSite");
    expect(site).toMatchObject({ name: "ExecFlow", url: `${ORIGIN}/` });
    expect(site.alternateName.length).toBeGreaterThan(0);
    const app = data["@graph"].find((n: { "@type": string }) => n["@type"] === "WebApplication");
    expect(app).toMatchObject({
      name: "ExecFlow",
      url: `${ORIGIN}/`,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any (runs in a web browser)",
      isAccessibleForFree: true,
      inLanguage: "en",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    });
    expect(app.description.length).toBeGreaterThan(50);
    expect(app.browserRequirements).toMatch(/WebAssembly/);
    expect(app.featureList.length).toBeGreaterThan(2);
    expect(app.image).toBe(ORIGIN + SOCIAL_CARD.path);
    const all = keys(data).map((k) => k.toLowerCase());
    // schema.org's rating and review properties (aggregateRating, review, reviews, reviewRating, ratingValue...),
    // and not operatingSystem, which contains "rating".
    expect(all.filter((k) => /rating$|^rating|^reviews?$|review[a-z]/.test(k) && k !== "operatingsystem")).toEqual([]);
  });

  it("says what ExecFlow is to a reader without JavaScript, with links to About, Privacy and Terms", () => {
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? "";
    for (const words of ["Python", "C++", "nothing to install", "flowchart", "JavaScript"]) expect(noscript).toContain(words);
    for (const href of ["/about", "/privacy", "/terms"]) expect(noscript).toContain(`href="${href}"`);
  });

  it("has a level-one heading with the product's name, outside #app so the workbench keeps it", () => {
    expect(html).toMatch(/<body>\s*<h1 class="visually-hidden">ExecFlow<\/h1>\s*<div id="app"/);
  });
});
