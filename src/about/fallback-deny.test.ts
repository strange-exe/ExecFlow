// The service worker's navigation fallback (vite.config.ts navigateFallbackDenylist): a file URL goes
// to the network, every app route gets the precached editor page. Workbox's NavigationRoute tests the
// denylist against the pathname AND the query string (workbox-routing NavigationRoute.js), so a dot in
// a query must not make an app route look like a file.
import { describe, expect, it } from "vitest";
import { APP_ROUTE, FILE_URL } from "./fallback-deny";

// The allowlist (navigateFallbackAllowlist): only the editor's own addresses get the editor page.
// Any other address goes to the network, which answers 404.html with a 404 (Cloudflare Pages); the
// other pages (/about, /privacy, /terms) are answered by the precache itself, not the fallback.
describe("APP_ROUTE (navigateFallbackAllowlist)", () => {
  it.each(["/", "/?x=a.b", "/auth-callback", "/auth-callback?code=a.b&state=c.d", "/auth-callback?error=access_denied"])("%s is the editor", (url) => {
    expect(APP_ROUTE.test(url)).toBe(true);
  });

  it.each(["/nope", "/about", "/privacy", "/auth-callback/x", "/auth-callbackx", "/index", "//", "/x?/"])("%s is not: the network or the precache answers", (url) => {
    expect(APP_ROUTE.test(url)).toBe(false);
  });
});

describe("FILE_URL (navigateFallbackDenylist)", () => {
  it.each(["/licenses.txt", "/media/x.mp4", "/media/launch-0.16.0.8fb45e33.mp4", "/media/x.mp4?v=2", "/privacy.pdf?x=a.b"])("%s is a file: the network answers", (url) => {
    expect(FILE_URL.test(url)).toBe(true);
  });

  it.each(["/", "/about", "/about?v=1.2", "/?x=a.b", "/x.html", "/x.html?v=1.2", "/auth-callback?code=a.b&state=c.d", "/folder.d/", "/folder.d/page"])("%s is an app route: the fallback page", (url) => {
    expect(FILE_URL.test(url)).toBe(false);
  });
});
