// A file URL for the service worker's navigation fallback (vite.config.ts navigateFallbackDenylist):
// a last path segment with an extension other than .html, such as media/*.mp4 or licenses.txt, is a
// file, never the editor, so it goes to the network. Workbox tests the denylist against the pathname
// and the query string together, so the match stops at the first "?": a dot in a query
// (/about?v=1.2) leaves an app route an app route.
export const FILE_URL = /^[^?]*\/[^/?]+\.(?!html(?:[?]|$))[^/.?]+(?:[?].*)?$/;
