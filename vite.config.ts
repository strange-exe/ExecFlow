import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { FLOWCHART_DIR, PACK_FILES } from "./src/flowchart/pack.ts";
import { cacheOnlyTheFile, neverStore } from "./src/about/sw-cache-guard.ts";
import { PYTHON_CACHE, RUNTIME_FILES } from "./src/runner/python-runtime.ts";
import { APP_ROUTE, NAVIGATE_DENYLIST } from "./src/about/fallback-deny.ts";
import { CHANGELOG } from "./src/about/changelog.ts";
import { HTML_INPUT, PAGES, pageDates, pagesFile, parseRewrites, rewriteFor, servedPath, sitemapXml, withHeadTags } from "./src/about/site.ts";
import { makeCodeLink } from "./src/core/code-link.ts";
import { loadGuideData } from "./src/pages/load.ts";
import { expandGuide, type GuideData } from "./src/pages/render.ts";
import { GUIDE_ROUTES } from "./src/pages/routes.ts";

const pyodideVersion: string = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version;
/** Pyodide's folder under /pyodide/: version plus Python's memory cap (scripts/copy-pyodide.mjs builds it). */
const pyodideDir = `${pyodideVersion}-heap${JSON.parse(readFileSync("scripts/python-heap.json", "utf8")).mb}`;

/**
 * Each file Python's first start downloads, with its size (src/runner/python-download.ts counts
 * them, for "Downloading Python (one time, about 14 MB)") and its sha256: the worker keeps a file
 * only when the bytes it got have that sha256, as the C/C++ pack and the flowchart files are checked.
 * Unit tests (mode "test") get an empty map when the runtime isn't copied; dev and build stop with
 * a clear message instead, since a file without its sha256 would never be kept.
 */
let pyodideMemo: Record<string, { bytes: number; sha256: string }> | undefined;
function pyodideFiles(mode: string): Record<string, { bytes: number; sha256: string }> {
  if (pyodideMemo) return pyodideMemo;
  const path = (f: string) => `public/pyodide/${pyodideDir}/${f}`;
  const missing = RUNTIME_FILES.filter((f) => !existsSync(path(f)));
  if (missing.length) {
    if (mode === "test") return {};
    throw new Error(`Python's runtime is missing (${missing.join(", ")}): run \`node scripts/copy-pyodide.mjs\` (npm run dev/build do this).`);
  }
  pyodideMemo = Object.fromEntries(
    RUNTIME_FILES.map((f) => {
      const bytes = readFileSync(path(f));
      return [f, { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }];
    }),
  );
  return pyodideMemo;
}
const pyodideBytes = (mode: string) => Object.values(pyodideFiles(mode)).reduce((sum, f) => sum + f.bytes, 0);

/**
 * The C/C++ pack manifest, written by scripts/fetch-clang.mjs (npm's predev/prebuild run it).
 * Unit tests (Vitest, mode "test") never touch the pack, so they get a placeholder instead of
 * requiring a 20 MB download first. Dev and build fail with a clear message if it's missing.
 */
function clangPack(mode: string) {
  const dir = existsSync("public/clang") ? readdirSync("public/clang")[0] : undefined;
  if (dir) return JSON.parse(readFileSync(`public/clang/${dir}/manifest.json`, "utf8"));
  if (mode === "test") return { version: "test", source: "none", totalBytes: 0, files: {} };
  throw new Error("The C/C++ pack is missing: run `node scripts/fetch-clang.mjs` (npm run dev/build do this).");
}

/**
 * The flowchart's parser files (src/flowchart/pack.ts), written by scripts/fetch-flowchart-grammars.mjs.
 * Dev and build stop with a clear message when one is missing; unit tests don't need them here.
 */
function flowchartPack(): Plugin {
  return {
    name: "code-editor:flowchart-pack",
    config(_config, { mode }) {
      if (mode === "test") return;
      const missing = PACK_FILES.filter((f) => !existsSync(`public/flowchart/${FLOWCHART_DIR}/${f.file}`)).map((f) => f.file);
      if (missing.length) {
        throw new Error(`The flowchart parser files are missing (${missing.join(", ")}): run \`node scripts/fetch-flowchart-grammars.mjs\` (npm run dev/build do this).`);
      }
    },
  };
}

// Cross-origin isolation enables SharedArrayBuffer: live input while a program runs, and stopping
// a Python program without killing (and re-booting) the whole runtime.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Cloudflare Web Analytics, which Cloudflare injects into every page at its edge (the owner's choice,
// 2026-10-27; listed on the Privacy page). The live script's path is beacon.min.js/<version>, and a
// source without a trailing slash matches one exact path, so the prefix form is listed too. It
// reports to this site's own /cdn-cgi/rum ('self'), and sends Cross-Origin-Resource-Policy:
// cross-origin, so cross-origin isolation still lets it load.
// https://developers.cloudflare.com/web-analytics/faq/
const BEACON = "https://static.cloudflareinsights.com/beacon.min.js";

/**
 * The site's old and new addresses, for the one-click move (src/ui/address-move.ts): the old one
 * shows the banner, the new one takes the files. Fixed at build time; MOVE_FROM and MOVE_TO
 * override them for the end-to-end tests (two origins on one machine: 127.0.0.1 and localhost).
 * Each must be an exact origin, or the build stops.
 */
function moveOrigin(name: "MOVE_FROM" | "MOVE_TO", fallback: string): string {
  const value = process.env[name] ?? fallback;
  let origin = "";
  try {
    origin = new URL(value).origin;
  } catch {
    // reported below
  }
  if (origin !== value || !/^https?:$/.test(new URL(value).protocol)) throw new Error(`${name} must be an exact origin like https://example.org (got ${JSON.stringify(value)}).`);
  return value;
}
const MOVE_FROM = moveOrigin("MOVE_FROM", "https://code-editor.abhinesh.codes");
const MOVE_TO = moveOrigin("MOVE_TO", "https://execflow.abhinesh.codes");
if (MOVE_FROM === MOVE_TO) throw new Error("MOVE_FROM and MOVE_TO must differ.");

const directives = (connect: string, scripts = "") =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${scripts}`,
    // CodeMirror injects its stylesheet at run time.
    "style-src 'self' 'unsafe-inline'",
    // data: images, all built in (none from user content): CodeMirror's lint underlines, and two
    // CSS masks drawn in a theme colour, the call-site arrow (src/editor/extensions.ts ARROW_MASK)
    // and the suggestion list's keyword key (src/editor/highlight.ts KEY_MASK).
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

// The page talks to GitHub for sync; besides the analytics beacon, nothing else leaves the site.
// WebAssembly may compile ('wasm-unsafe-eval') but eval() and new Function() may not.
const pageCsp = directives("'self' https://api.github.com", ` ${BEACON} ${BEACON}/`);
// Workers run student code, so they get a second policy without GitHub or the beacon. Browsers enforce every
// policy a response carries, so a worker can only reach its own site even if lockdown.ts missed
// something. (Cloudflare Pages joins the two matching _headers rules with a comma: two policies.)
const workerCsp = directives("'self'");

/** Hash-only file names: long-term caching still works and source names don't leak. */
/**
 * The About page's 3D scene and three.js (136 KB gzip) live under assets/a/: the service worker
 * leaves them out of the precache every visitor downloads, and caches them when /about is opened.
 * The page's own entry (a few KB: the changelog, the video) stays in assets/ and is precached with
 * its HTML, so a page served by an older service worker after a release still has its code; only
 * the optional scene can be missing there, and then the poster stays (the scene's failure path).
 */
const aboutOnly = (chunk: { name: string; moduleIds: readonly string[] }) =>
  chunk.moduleIds.some((id) => /[\\/]node_modules[\\/]three[\\/]|[\\/]src[\\/]about[\\/]scene\.ts$/.test(id));
const hashedNames = {
  entryFileNames: "assets/[hash].js",
  chunkFileNames: (chunk: { name: string; moduleIds: readonly string[] }) => (aboutOnly(chunk) ? "assets/a/[hash].js" : "assets/[hash].js"),
  assetFileNames: "assets/[hash][extname]",
};
/** Worker bundles live under assets/w/ so the worker-only policy can target them. */
const workerNames = { entryFileNames: "assets/w/[hash].js", chunkFileNames: "assets/w/[hash].js", assetFileNames: "assets/[hash][extname]" };

/** A header name starting with this removes that header (Cloudflare Pages' "! Name" line). */
const DETACH = "! ";

/**
 * Header rules, in Cloudflare Pages _headers order. Every rule whose path matches applies; a header
 * named by several rules is joined with ", ". The preview server applies the same list, so the
 * end-to-end tests see exactly what the deployed site sends.
 */
const securityRules: [string, Record<string, string>][] = [
  [
    "/*",
    {
      ...isolation,
      "Content-Security-Policy": pageCsp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Nothing in the app uses these; a page the app didn't write can't ask for them either.
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      // HTTPS only from the first visit on (one year; not its sibling subdomains, which aren't this app's).
      "Strict-Transport-Security": "max-age=31536000",
    },
  ],
  ["/assets/w/*", { "Content-Security-Policy": workerCsp }],
  // The move to the new address (src/ui/address-move.ts): /move is the editor without cross-origin
  // isolation, so the old and the new address can open each other and keep the reference that
  // postMessage needs (COOP same-origin cuts it). "! Name" removes a header an earlier rule set
  // (Cloudflare Pages _headers; the preview server below does the same).
  // https://developers.cloudflare.com/pages/configuration/headers/
  ["/move", { [`${DETACH}Cross-Origin-Opener-Policy`]: "", [`${DETACH}Cross-Origin-Embedder-Policy`]: "" }],
  // A short link's address (/s/<id>, src/core/short-link.ts) is someone's shared code, never a page
  // to index. /api/links/* needs no rule: _headers doesn't apply to Pages Functions' responses, and
  // server/short-links.ts sends its own Cache-Control: no-store, nosniff and CSP on every answer.
  ["/s/*", { "X-Robots-Tag": "noindex" }],
];

/** Hashed and versioned files never change; everything else revalidates on every visit. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const cacheRules: [string, Record<string, string>][] = [
  ["/assets/*", { "Cache-Control": IMMUTABLE }],
  [`/pyodide/${pyodideDir}/*`, { "Cache-Control": IMMUTABLE }],
  ["/clang/*", { "Cache-Control": IMMUTABLE }], // the folder name is the pack's version
  [`/flowchart/${FLOWCHART_DIR}/*`, { "Cache-Control": IMMUTABLE }], // the folder name carries every file's version
  ["/media/*", { "Cache-Control": IMMUTABLE }], // each name carries its content hash (src/about/media.test.ts)
];

/** Cloudflare-style path match: "*" matches anything, including "/". */
function matches(rule: string, path: string): boolean {
  const re = new RegExp("^" + rule.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(path);
}

function headersFor(path: string, rules = securityRules): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rule, headers] of rules) {
    if (!matches(rule, path)) continue;
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(DETACH)) delete out[name.slice(DETACH.length)];
      else out[name] = out[name] ? `${out[name]}, ${value}` : value;
    }
  }
  return out;
}

/**
 * web-tree-sitter finds its .wasm with `new URL("web-tree-sitter.wasm", import.meta.url)`, which
 * Vite would bundle as a hashed asset, and the service worker would then precache it (205 KB on the
 * first visit, a second copy of public/flowchart/'s). The flowchart engine always hands the runtime
 * its bytes (wasmBinary, sha256-checked), so that URL is never fetched: it becomes a plain name. If
 * an update changes the text, the build stops here instead of quietly shipping the extra file.
 */
function flowchartRuntimeUrl(): Plugin {
  const original = 'new URL("web-tree-sitter.wasm", import.meta.url).href';
  return {
    name: "code-editor:flowchart-runtime-url",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]web-tree-sitter[\\/]web-tree-sitter\.js$/.test(id.split("?")[0])) return null;
      const found = code.split(original).length - 1;
      if (found !== 1) throw new Error(`web-tree-sitter.js: expected ${original} once, found it ${found} times; re-check the flowchart runtime's loading.`);
      return { code: code.replace(original, '"web-tree-sitter.wasm"'), map: null };
    },
  };
}

/** Writes Cloudflare Pages' _headers file from the rules above, so the two can't drift apart. */
function pagesHeaders(): Plugin {
  return {
    name: "code-editor:pages-headers",
    apply: "build",
    generateBundle() {
      const block = ([path, headers]: [string, Record<string, string>]) =>
        `${path}\n${Object.entries(headers).map(([n, v]) => (n.startsWith(DETACH) ? `  ${n}` : `  ${n}: ${v}`)).join("\n")}\n`;
      this.emitFile({ type: "asset", fileName: "_headers", source: [...securityRules, ...cacheRules].map(block).join("\n") });
    },
  };
}

/** npm packages in the page's and the workers' bundles (workers are built first, inside the page's build). */
const bundledPackages = new Set<string>();

/** The package a module id belongs to ("@codemirror/view", "idb"), or null for the project's own files. */
function packageOf(id: string): string | null {
  const path = id.split("?")[0].replace(/\\/g, "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const [first, second] = path.slice(at + "/node_modules/".length).split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

function collectPackages(): Plugin {
  return {
    name: "code-editor:collect-packages",
    apply: "build",
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const pkg = packageOf(id);
        if (pkg) bundledPackages.add(pkg);
      }
    },
  };
}

/**
 * Third-party parts the site serves that aren't npm modules in a bundle: runtimes copied to public/,
 * vendored code, fonts (CSS url() assets) and the grammars. Each with the licence file it ships under.
 */
const LICENSE_EXTRAS: { name: string; file: string }[] = [
  { name: "Pyodide 314.0.7 (served from /pyodide/)", file: "licenses/pyodide-314.0.7-LICENSE.txt" },
  { name: "CPython 3.14, inside Pyodide", file: "licenses/cpython-3.14-LICENSE.txt" },
  // The C/C++ pack (0.17.0, scripts/fetch-clang.mjs): YoWASP's clang + lld 22 and wasi-sdk-33's libraries.
  { name: "YoWASP runtime (the JavaScript side of @yowasp/clang), vendored in src/vendor/yowasp-clang", file: "licenses/yowasp-runtime-LICENSE.txt" },
  { name: "LLVM 22: clang and lld, in the C/C++ pack", file: "licenses/llvm-22-LICENSE.TXT" },
  { name: "libc++ 22 (exceptions build, from wasi-sdk-33), in the C/C++ pack", file: "licenses/libcxx-22-LICENSE.TXT" },
  { name: "libc++abi 22 (from wasi-sdk-33), in the C/C++ pack", file: "licenses/libcxxabi-22-LICENSE.TXT" },
  { name: "libunwind 22 (from wasi-sdk-33), in the C/C++ pack", file: "licenses/libunwind-22-LICENSE.TXT" },
  { name: "compiler-rt 22 (libclang_rt.builtins), in the C/C++ pack", file: "licenses/compiler-rt-22-LICENSE.TXT" },
  { name: "wasi-libc (wasi-sdk-33, commit 161b3195), in the C/C++ pack", file: "licenses/wasi-libc-LICENSE.txt" },
  { name: "wasi-libc, under its MIT option", file: "licenses/wasi-libc-LICENSE-MIT.txt" },
  { name: "musl, inside wasi-libc", file: "licenses/wasi-libc-musl-COPYRIGHT.txt" },
  { name: "cloudlibc, inside wasi-libc", file: "licenses/wasi-libc-cloudlibc-LICENSE.txt" },
  // The editor's C and C++ suggestions are still read from clang 8's headers (scripts/gen-c-completions.mjs).
  { name: "libc++ 8 headers (the editor's suggestion lists were read from them)", file: "licenses/libcxx-8-LICENSE.TXT" },
  { name: "libc++abi 8 headers (as above)", file: "licenses/libcxxabi-8-LICENSE.TXT" },
  { name: "tree-sitter-c 0.24.1 (its .wasm, served from /flowchart/)", file: "licenses/tree-sitter-c-0.24.1-LICENSE.txt" },
  { name: "tree-sitter-cpp 0.23.4 (its .wasm, served from /flowchart/)", file: "licenses/tree-sitter-cpp-0.23.4-LICENSE.txt" },
  { name: "tree-sitter-python 0.25.0 (its .wasm, served from /flowchart/)", file: "licenses/tree-sitter-python-0.25.0-LICENSE.txt" },
  { name: "web-tree-sitter 0.27.1 (its .wasm, served from /flowchart/)", file: "node_modules/web-tree-sitter/LICENSE" },
  { name: "Geist (@fontsource-variable/geist)", file: "node_modules/@fontsource-variable/geist/LICENSE" },
  { name: "JetBrains Mono (@fontsource/jetbrains-mono)", file: "node_modules/@fontsource/jetbrains-mono/LICENSE" },
  // sw.js and workbox-<hash>.js are built by vite-plugin-pwa from these Workbox packages (one licence).
  { name: "Workbox: workbox-core, -precaching, -routing, -strategies, -expiration, -cacheable-response (the service worker)", file: "node_modules/workbox-core/LICENSE" },
];

const LICENSE_NOTES = [
  "The C/C++ pack's compiler is @yowasp/clang 22.0.0-git20542-10 (YoWASP's build of LLVM 22, whose build scripts are Apache-2.0); its libraries are the wasm32-wasip1 sysroot of wasi-sdk-33, which ships no licence files of its own, so the texts above come from llvm-project release/22.x and wasi-libc at the commit wasi-sdk-33 pins.",
  "numpy, pandas, python-dateutil, pytz and six are served as their original wheel files, each with its licence inside (its .dist-info folder).",
  "The colour themes in Settings use the published palettes of other themes; each is listed with its source and licence in the README: https://github.com/strange-exe/ExecFlow#third-party-software",
];

function licenseFileOf(pkg: string): string | null {
  const dir = `node_modules/${pkg}`;
  const name = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)) : undefined;
  return name ? `${dir}/${name}` : null;
}

/**
 * Writes /licenses.txt: ExecFlow's own licence, then every third-party licence text the site's
 * files ship under. A bundled package without a licence file stops the build.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: "code-editor:third-party-licenses",
    apply: "build",
    generateBundle() {
      const missing: string[] = [];
      const parts: { name: string; file: string }[] = [];
      for (const pkg of [...bundledPackages].sort()) {
        const file = licenseFileOf(pkg);
        if (!file) missing.push(pkg);
        else parts.push({ name: `${pkg} ${JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, "utf8")).version}`, file });
      }
      if (missing.length) throw new Error(`No licence file for bundled package(s): ${missing.join(", ")}. Add one to LICENSE_EXTRAS in vite.config.ts.`);
      parts.push(...LICENSE_EXTRAS);
      const rule = "=".repeat(78);
      const text = [
        "ExecFlow: licences",
        "",
        "ExecFlow's own code is under the MIT licence (the first text below). The rest are the licences of",
        "the third-party software this site serves, each under its own licence.",
        "",
        ...LICENSE_NOTES.map((n) => `- ${n}`),
        "",
        rule,
        "ExecFlow",
        rule,
        readFileSync("LICENSE", "utf8").trim(),
        ...parts.flatMap(({ name, file }) => ["", rule, name, rule, readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim()]),
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "licenses.txt", source: text });
    },
  };
}

/**
 * What search engines and link previews read (src/about/site.ts): each page's canonical link and
 * social tags, and sitemap.xml. `vite preview` also answers like Cloudflare Pages does with 404.html
 * in the build: the _redirects rewrites (GitHub's sign-in return path, short links' /s/*), the pages and files, and
 * 404.html with a 404 for any other address, so the end-to-end tests meet the deployed site's 404s.
 */
function site(): Plugin {
  let outDir = "dist";
  return {
    name: "code-editor:site",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = PAGES.find((p) => ctx.filename.replace(/\\/g, "/").endsWith(`/${p.file}`));
        return page ? withHeadTags(html, page.path) : html;
      },
    },
    generateBundle() {
      const released = CHANGELOG[0].date;
      // The guide pages (src/pages/routes.ts) are rebuilt with each release, like the editor.
      const dates = [...pageDates((file) => readFileSync(file, "utf8"), released), ...GUIDE_ROUTES.map((r) => ({ path: r.path, lastmod: released }))];
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(dates) });
    },
    configurePreviewServer(server) {
      const rewrites = parseRewrites(readFileSync("public/_redirects", "utf8"));
      const isFile = (file: string) => existsSync(`${outDir}${file}`) && statSync(`${outDir}${file}`).isFile();
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? "/").split(/\?(.*)/s);
        const to = rewriteFor(rewrites, path);
        if (to) {
          req.url = query === undefined ? to : `${to}?${query}`;
          return next();
        }
        if (path.startsWith("/api/")) return next();
        const decoded = servedPath(path);
        if (decoded && pagesFile(decoded, isFile)) return next();
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(readFileSync(`${outDir}/404.html`));
      });
    },
  };
}

/**
 * The guide pages (src/pages/routes.ts): their examples, outputs and flowcharts are filled in from
 * the repo's captured data (src/pages/render.ts), and each "Open in ExecFlow" link is made with the
 * app's own code-link encoder, so a link always opens exactly the code shown beside it.
 */
function guidePages(): Plugin {
  const files = new Set(GUIDE_ROUTES.map((r) => r.file));
  let data: GuideData | undefined;
  const link = async (name: string, text: string) => {
    const made = await makeCodeLink("", name, text);
    if (!made.ok) throw new Error(`guide pages: no code link for ${name} (${made.refusal.kind})`);
    return made.url;
  };
  return {
    name: "code-editor:guide-pages",
    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        if (!files.has(ctx.filename.replace(/\\/g, "/").split("/").pop() ?? "")) return html;
        data ??= loadGuideData(process.cwd());
        return expandGuide(html, data, link);
      },
    },
  };
}

/**
 * move.html, served at /move: the built editor page again, for the move to the new address
 * (src/ui/address-move.ts), which needs it without cross-origin isolation (securityRules "/move").
 * Never indexed, and never precached (globIgnores): the service worker would answer it with the
 * headers it stored, and a move needs the network anyway.
 */
function movePage(): Plugin {
  return {
    name: "code-editor:move-page",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (!index || index.type !== "asset") throw new Error("move.html: the built index.html is missing.");
        const html = String(index.source);
        const page = html.replace("<head>", '<head>\n    <meta name="robots" content="noindex" />');
        if (page === html || html.includes('name="robots"')) throw new Error("move.html: index.html's <head> changed; re-check the move page.");
        this.emitFile({ type: "asset", fileName: "move.html", source: page });
      },
    },
  };
}

/** `vite preview` sends the same security headers as Cloudflare, per path (cache rules left out). */
function previewHeaders(): Plugin {
  return {
    name: "code-editor:preview-headers",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "/").split("?")[0];
        for (const [name, value] of Object.entries(headersFor(path))) res.setHeader(name, value);
        next();
      });
    },
  };
}

/**
 * The dev server's isolation headers on EVERY response. Vite leaves server.headers off its 304 Not
 * Modified replies, and WebKit then refuses to start a worker whose revalidated module scripts lack
 * COEP, so every worker restart after the first failed in `npm run dev` (measured 2026-10-17).
 * Production serves those files immutable, so nothing is revalidated there.
 */
function devIsolation(): Plugin {
  return {
    name: "code-editor:dev-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value);
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // The CSP is enforced on the production build (`vite preview`, which the end-to-end tests use).
  // The dev server keeps only the isolation headers.
  server: { headers: isolation },
  // `vite preview` would reuse server.headers on every response; previewHeaders() sends the
  // deployed site's own rules instead, including /move's, which has no isolation headers.
  preview: { headers: {} },
  // Workers have their own plugin list: the flowchart worker is where web-tree-sitter lives.
  // Workers drop console.* and debugger like the page (their libraries log: web-tree-sitter, memfs).
  worker: {
    format: "es",
    plugins: () => [flowchartRuntimeUrl(), collectPackages()],
    rolldownOptions: { output: { ...workerNames, minify: { compress: { dropConsole: true, dropDebugger: true } } } },
  },
  build: {
    // No source maps in production: DevTools can't rebuild the src/ tree. Nothing secret lives in the client.
    sourcemap: false,
    rolldownOptions: {
      // The editor, About, Privacy and Terms (served at /about, /privacy and /terms: Cloudflare Pages
      // drops the .html; the service worker's precache matches the same clean URLs), and 404.html.
      // The guide pages likewise (/python, /c, /cpp, /flowchart-from-code: src/pages/routes.ts).
      input: {
        ...HTML_INPUT,
        ...Object.fromEntries(GUIDE_ROUTES.map((r) => [r.file.replace(/\.html$/, ""), r.file])),
      },
      output: {
        ...hashedNames,
        // Oxc minifier: drop leftover console.* calls (and debugger statements, its default).
        minify: { compress: { dropConsole: true, dropDebugger: true } },
      },
    },
  },
  define: {
    // The release (src/about/changelog.ts's newest; a unit test keeps them equal): no request for it.
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
    __PYODIDE_DIR__: JSON.stringify(pyodideDir),
    __PYODIDE_BYTES__: JSON.stringify(pyodideBytes(mode)),
    __PYODIDE_FILES__: JSON.stringify(pyodideFiles(mode)),
    __CLANG_PACK__: JSON.stringify(clangPack(mode)),
    __MOVE_FROM__: JSON.stringify(MOVE_FROM),
    __MOVE_TO__: JSON.stringify(MOVE_TO),
  },
  plugins: [
    devIsolation(),
    flowchartPack(),
    flowchartRuntimeUrl(),
    pagesHeaders(),
    collectPackages(),
    thirdPartyLicenses(),
    guidePages(),
    movePage(),
    previewHeaders(),
    site(),
    VitePWA({
      // An editor can hold unsaved text, so updates wait for the user instead of reloading tabs.
      registerType: "prompt",
      manifest: {
        name: "ExecFlow",
        short_name: "ExecFlow",
        description: "Write, run and chart Python, C and C++ in your browser, with nothing to install.",
        // Signal's dark chrome and code ground (the default theme; src/theme/contrast.test.ts keeps them equal).
        theme_color: "#0b0d10",
        background_color: "#15181d",
        display: "standalone",
        start_url: "/",
        // Mark v2, rasterised from public/icons/mark-v2.svg (.claude/design/make-icons.mjs). Relative
        // to the manifest's URL (start_url, the manifest link and the navigate fallback are still root
        // paths); the maskable icon keeps the glyph inside the safe zone (e2e/icons.spec.ts checks the pixels).
        icons: [
          { src: "icons/mark-v2-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/mark-v2-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/mark-v2-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app itself is precached, so it opens offline after the first visit. licenses.txt too:
        // with the service worker in control it is served from here (and offline), where otherwise
        // the navigate fallback below would answer it with the editor.
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2,wasm,zip,json,txt}"],
        // The C/C++ pack (~20 MB) is downloaded by the compiler worker into its own cache when first needed.
        // So is the Python runtime (~14 MB, the owner's "On first use", 2026-10-30): the Python worker
        // downloads it the first time Python starts (src/runner/python-download.ts), and the route
        // below answers its scripts from that cache, so a visit that never uses Python never fetches it.
        // _routes.json is Cloudflare's (which paths run the sign-in function), not the app's.
        // The flowchart's parser files (~4.5 MB) are not precached either: they download the first time
        // a flowchart is asked for, and are runtime-cached below.
        // The About page's code and images (assets/a/, media/) are cached when /about is opened, below.
        // move.html is the editor served without isolation for the move to the new address (movePage).
        globIgnores: ["clang/**", "pyodide/**", "flowchart/**", "_routes.json", "assets/a/**", "media/**", "move.html"],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // Hashed URLs need no ?__WB_REVISION__ cache-buster, so installing the service worker can
        // reuse what the page already downloaded.
        dontCacheBustURLsMatching: /^assets\//,
        navigateFallback: "/index.html",
        // Only the editor's own addresses (/, GitHub's sign-in return path /auth-callback, a short link's /s/<id>) get the
        // editor; any other address the precache doesn't hold goes to the network, which answers
        // 404.html with a 404 (APP_ROUTE, src/about/fallback-deny.ts). Offline, such an address fails
        // like any uncached page. The sign-in relay (functions/api/auth/*) always answers from the
        // network, never from the precache. A file URL (a name with an extension other than .html, such
        // as media/*.mp4) is a file, never the editor: it goes to the network (FILE_URL ignores the
        // query string, which Workbox tests along with the path). Workbox applies both lists.
        // The guide pages are pages of their own, never the editor (src/about/fallback-deny.ts).
        navigateFallbackAllowlist: [APP_ROUTE],
        navigateFallbackDenylist: [...NAVIGATE_DENYLIST],
        // numpy, pandas and their helpers (~7.5 MB, scripts/fetch-pyodide-packages.mjs) are not precached:
        // they download the first time a program imports them, then keep working offline. The folder is
        // versioned, so cached wheels never go stale; Pyodide also checks each one's sha256 (SRI).
        runtimeCaching: [
          // The Python runtime, once its first start has put it in PYTHON_CACHE (the Python worker
          // does that itself: on a first visit no service worker controls the page yet). The folder is
          // versioned, so a kept file never goes stale; the worker drops other versions' files.
          {
            urlPattern: new RegExp(`/pyodide/${pyodideDir.replace(/\./g, "\\.")}/(${RUNTIME_FILES.map((f) => f.replace(/\./g, "\\.")).join("|")})$`),
            handler: "CacheFirst",
            options: {
              cacheName: PYTHON_CACHE,
              cacheableResponse: { statuses: [200] },
              // The worker stored them from fetch(), which sends no Origin header; an import is a CORS
              // request, which does. A server that answers "Vary: Origin" (vite preview's does) would
              // otherwise never match, and Python couldn't start offline (measured in Chromium).
              matchOptions: { ignoreVary: true },
              // Read only: the worker keeps a file once its sha256 matched the build's; a copy this
              // route stored from the network (a worker's fetch it answered) would skip that check.
              plugins: [neverStore],
            },
          },
          {
            urlPattern: new RegExp(`/pyodide/${pyodideDir.replace(/\./g, "\\.")}/[^/]+\\.whl$`),
            handler: "CacheFirst",
            options: {
              cacheName: "codeeditor-python-packages",
              expiration: { maxEntries: 16 },
              cacheableResponse: { statuses: [200] },
              // Never the site's fallback page under a file's URL (src/about/sw-cache-guard.ts).
              plugins: [cacheOnlyTheFile],
            },
          },
          // The flowchart's runtime and grammars: versioned folder, so a cached file never goes stale;
          // the flowchart worker also checks each one's sha256 before using it.
          {
            urlPattern: new RegExp(`/flowchart/${FLOWCHART_DIR.replace(/\./g, "\\.")}/[^/]+\\.wasm$`),
            handler: "CacheFirst",
            options: {
              cacheName: "codeeditor-flowchart",
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [200] },
              plugins: [cacheOnlyTheFile],
            },
          },
          // The About page's code and its images, once /about was opened. Both have content-hashed names
          // (media/: src/about/media.test.ts), so a cached copy is never stale.
          {
            urlPattern: /\/(assets\/a\/[^/]+\.js|media\/[^/]+\.(webp|avif))$/,
            handler: "CacheFirst",
            options: {
              cacheName: "codeeditor-about",
              expiration: { maxEntries: 24 },
              cacheableResponse: { statuses: [200] },
              // A missing file's answer (the editor's page, 200 text/html) is passed on, never kept.
              plugins: [cacheOnlyTheFile],
            },
          },
        ],
      },
    }),
  ],
}));
