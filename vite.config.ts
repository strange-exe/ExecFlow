import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const pyodideVersion: string = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version;
/** Pyodide's folder under /pyodide/: version plus Python's memory cap (scripts/copy-pyodide.mjs builds it). */
const pyodideDir = `${pyodideVersion}-heap${JSON.parse(readFileSync("scripts/python-heap.json", "utf8")).mb}`;

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

// Cross-origin isolation enables SharedArrayBuffer: live input while a program runs, and stopping
// a Python program without killing (and re-booting) the whole runtime.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const directives = (connect: string) =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    // CodeMirror injects its stylesheet at run time.
    "style-src 'self' 'unsafe-inline'",
    // Lint underlines are data: SVGs.
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

// The page talks to GitHub for sync; nothing else leaves the site. WebAssembly may compile
// ('wasm-unsafe-eval') but eval() and new Function() may not.
const pageCsp = directives("'self' https://api.github.com");
// Workers run student code, so they get a second policy without GitHub. Browsers enforce every
// policy a response carries, so a worker can only reach its own site even if lockdown.ts missed
// something. (Cloudflare Pages joins the two matching _headers rules with a comma: two policies.)
const workerCsp = directives("'self'");

/** Hash-only file names: long-term caching still works and source names don't leak. */
const hashedNames = {
  entryFileNames: "assets/[hash].js",
  chunkFileNames: "assets/[hash].js",
  assetFileNames: "assets/[hash][extname]",
};
/** Worker bundles live under assets/w/ so the worker-only policy can target them. */
const workerNames = { entryFileNames: "assets/w/[hash].js", chunkFileNames: "assets/w/[hash].js", assetFileNames: "assets/[hash][extname]" };

/**
 * Header rules, in Cloudflare Pages _headers order. Every rule whose path matches applies; a header
 * named by several rules is joined with ", ". The preview server applies the same list, so the
 * end-to-end tests see exactly what the deployed site sends.
 */
const securityRules: [string, Record<string, string>][] = [
  ["/*", { ...isolation, "Content-Security-Policy": pageCsp, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }],
  ["/assets/w/*", { "Content-Security-Policy": workerCsp }],
];

/** Hashed and versioned files never change; everything else revalidates on every visit. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const cacheRules: [string, Record<string, string>][] = [
  ["/assets/*", { "Cache-Control": IMMUTABLE }],
  [`/pyodide/${pyodideDir}/*`, { "Cache-Control": IMMUTABLE }],
  ["/clang/*", { "Cache-Control": IMMUTABLE }], // the folder name is the pack's version
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
    for (const [name, value] of Object.entries(headers)) out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/** Writes Cloudflare Pages' _headers file from the rules above, so the two can't drift apart. */
function pagesHeaders(): Plugin {
  return {
    name: "code-editor:pages-headers",
    apply: "build",
    generateBundle() {
      const block = ([path, headers]: [string, Record<string, string>]) =>
        `${path}\n${Object.entries(headers).map(([n, v]) => `  ${n}: ${v}`).join("\n")}\n`;
      this.emitFile({ type: "asset", fileName: "_headers", source: [...securityRules, ...cacheRules].map(block).join("\n") });
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
  worker: { format: "es", rolldownOptions: { output: workerNames } },
  build: {
    // No source maps in production: DevTools can't rebuild the src/ tree. Nothing secret lives in the client.
    sourcemap: false,
    rolldownOptions: {
      output: {
        ...hashedNames,
        // Oxc minifier: drop leftover console.* calls (and debugger statements, its default).
        minify: { compress: { dropConsole: true, dropDebugger: true } },
      },
    },
  },
  define: {
    __PYODIDE_DIR__: JSON.stringify(pyodideDir),
    __CLANG_PACK__: JSON.stringify(clangPack(mode)),
  },
  plugins: [
    devIsolation(),
    pagesHeaders(),
    previewHeaders(),
    VitePWA({
      // An editor can hold unsaved text, so updates wait for the user instead of reloading tabs.
      registerType: "prompt",
      manifest: {
        name: "CodeEditor",
        short_name: "CodeEditor",
        description: "A personal editor that runs Python, C and C++ in the browser.",
        theme_color: "#0e1217",
        background_color: "#0e1217",
        display: "standalone",
        start_url: "/",
        // Rasterised from public/favicon.svg's mark.
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The Python runtime is precached so the app works offline after the first visit.
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2,wasm,zip,json}"],
        // The C/C++ pack (~20 MB) is downloaded by the compiler worker into its own cache when first needed.
        globIgnores: ["clang/**"],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // Versioned or hashed URLs need no ?__WB_REVISION__ cache-buster, so installing the
        // service worker can reuse what the page already downloaded (no second 6 MB download).
        dontCacheBustURLsMatching: /^(assets|pyodide\/\d+\.\d+\.\d+-heap\d+)\//,
        navigateFallback: "/index.html",
        // numpy, pandas and their helpers (~7.5 MB, scripts/fetch-pyodide-packages.mjs) are not precached:
        // they download the first time a program imports them, then keep working offline. The folder is
        // versioned, so cached wheels never go stale; Pyodide also checks each one's sha256 (SRI).
        runtimeCaching: [
          {
            urlPattern: new RegExp(`/pyodide/${pyodideDir.replace(/\./g, "\\.")}/[^/]+\\.whl$`),
            handler: "CacheFirst",
            options: {
              cacheName: "codeeditor-python-packages",
              expiration: { maxEntries: 16 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
}));
