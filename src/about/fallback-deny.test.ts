// The service worker's navigation fallback (vite.config.ts navigateFallbackDenylist): a file URL goes
// to the network, every app route gets the precached editor page. Workbox's NavigationRoute tests the
// denylist against the pathname AND the query string (workbox-routing NavigationRoute.js), so a dot in
// a query must not make an app route look like a file.
import { describe, expect, it } from "vitest";
import { FILE_URL } from "./fallback-deny";

describe("FILE_URL (navigateFallbackDenylist)", () => {
  it.each(["/licenses.txt", "/media/x.mp4", "/media/launch-0.7.0.4714ab9e.mp4", "/media/x.mp4?v=2", "/privacy.pdf?x=a.b"])("%s is a file: the network answers", (url) => {
    expect(FILE_URL.test(url)).toBe(true);
  });

  it.each(["/", "/about", "/about?v=1.2", "/?x=a.b", "/x.html", "/x.html?v=1.2", "/auth-callback?code=a.b&state=c.d", "/folder.d/", "/folder.d/page"])("%s is an app route: the fallback page", (url) => {
    expect(FILE_URL.test(url)).toBe(false);
  });
});
