// A file URL for the service worker's navigation fallback (vite.config.ts navigateFallbackDenylist):
// a last path segment with an extension other than .html, such as media/*.mp4 or licenses.txt, is a
// file, never the editor, so it goes to the network. Workbox tests the denylist against the pathname
// and the query string together, so the match stops at the first "?": a dot in a query
// (/about?v=1.2) leaves an app route an app route.
export const FILE_URL = /^[^?]*\/[^/?]+\.(?!html(?:[?]|$))[^/.?]+(?:[?].*)?$/;

// The only addresses the navigation fallback answers with the editor (navigateFallbackAllowlist): the
// editor itself and GitHub's sign-in return path (src/sync/auth-callback.ts), with any query. Every
// other unknown address goes to the network, which answers the site's 404 page with a 404, so the
// service worker never turns a missing page back into the editor. Offline, such an address fails
// like any uncached page. /about, /privacy and /terms never reach here: the precache answers them.
export const APP_ROUTE = /^\/(?:auth-callback)?(?:[?].*)?$/;
