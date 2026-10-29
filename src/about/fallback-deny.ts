// A file URL for the service worker's navigation fallback (vite.config.ts navigateFallbackDenylist):
// a last path segment with an extension other than .html, such as media/*.mp4 or licenses.txt, is a
// file, never the editor, so it goes to the network. Workbox tests the denylist against the pathname
// and the query string together, so the match stops at the first "?": a dot in a query
// (/about?v=1.2) leaves an app route an app route.
import { GUIDE_PATH } from "../pages/routes";
export const FILE_URL = /^[^?]*\/[^/?]+\.(?!html(?:[?]|$))[^/.?]+(?:[?].*)?$/;

// The only addresses the navigation fallback answers with the editor (navigateFallbackAllowlist): the
// editor itself and GitHub's sign-in return path (src/sync/auth-callback.ts), with any query. Every
// other unknown address goes to the network, which answers the site's 404 page with a 404, so the
// service worker never turns a missing page back into the editor. Offline, such an address fails
// like any uncached page. /about, /privacy and /terms never reach here: the precache answers them.
export const APP_ROUTE = /^\/(?:auth-callback)?(?:[?].*)?$/;

/**
 * The whole navigateFallbackDenylist: the sign-in relay (functions/api/auth/*) always answers from
 * the network; a file URL is a file; a guide page (src/pages/routes.ts) is a page of its own, never
 * the editor. The guides are precached, but a query Workbox doesn't ignore (/python?ref=x; it drops
 * only utm_* and fbclid) misses the precache and reaches the fallback.
 */
export const NAVIGATE_DENYLIST: readonly RegExp[] = [/^\/api\//, FILE_URL, GUIDE_PATH];
