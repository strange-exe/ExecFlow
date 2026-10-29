// The guide pages: one per task a student comes with (.claude/seo/plan.md section 2). Each is a
// static HTML entry (vite.config.ts), served at its clean URL (Cloudflare Pages drops ".html").
// The sitemap can list `GUIDE_ROUTES`; the service worker never answers these paths with the editor.

export interface GuideRoute {
  /** The path, e.g. "/python". */
  path: string;
  /** The page's source file at the project root. */
  file: string;
  /** Its <title>. */
  title: string;
}

export const SITE = "https://code-editor.abhinesh.codes";

export const GUIDE_ROUTES: readonly GuideRoute[] = [
  { path: "/flowchart-from-code", file: "flowchart-from-code.html", title: "Turn Python, C or C++ code into a flowchart | Execflow" },
  { path: "/python", file: "python.html", title: "Run Python online in your browser | Execflow" },
  { path: "/c", file: "c.html", title: "Run C online in your browser | Execflow" },
  { path: "/cpp", file: "cpp.html", title: "Run C++ online in your browser | Execflow" },
];

/** A guide page's path, with or without ".html" or a trailing slash, and with any query string. */
export const GUIDE_PATH = new RegExp(`^(${GUIDE_ROUTES.map((r) => r.path.replace(/[+]/g, "[+]")).join("|")})(\\.html)?/?(\\?.*)?$`);
