/// <reference lib="webworker" />
// Adapted from Pocket Run (same author, MIT). Code in the Python worker can reach JavaScript
// (`import js`, `pyodide_js`). ExecFlow keeps the workspace and, if the user chose "Remember on
// this computer", an encrypted GitHub token in this origin's IndexedDB; the app itself lives in Cache
// Storage. Before any user code runs, the worker removes storage, network, cross-tab and
// worker-spawning APIs from its global scope, and refuses to run anything if one is still reachable.
// The worker keeps private module-level references to what it needs itself (see python.worker.ts).
// The worker CSP (connect-src 'self', no eval) is the second layer.

/** Globals user code must not reach. */
export const BLOCKED_GLOBALS = [
  // storage
  "caches", "indexedDB",
  // network
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport",
  // running more code, other workers and other tabs
  "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
  // font loads are requests; notifications reach outside the page
  "FontFace", "fonts", "Notification",
  // messages to the page: the worker keeps its own bound copy, so a program can't forge one
  "postMessage",
] as const;

/** Properties of `navigator` that open storage, service workers or cross-tab locks. */
export const BLOCKED_NAVIGATOR = ["storage", "storageBuckets", "serviceWorker", "locks"] as const;

/** Deletes `name` from `obj` and every object on its prototype chain (Web IDL members live on prototypes). */
function removeEverywhere(obj: object, name: string) {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, name)) Reflect.deleteProperty(o, name);
  }
}

/**
 * Removes the blocked APIs. Returns any that are still reachable (should be none). Reflect.has and
 * `in` check the whole prototype chain without calling a getter.
 */
export function lockDown(scope: WorkerGlobalScope): string[] {
  for (const name of BLOCKED_GLOBALS) removeEverywhere(scope, name);
  const nav: object = scope.navigator;
  for (const name of BLOCKED_NAVIGATOR) removeEverywhere(nav, name);
  return [
    ...BLOCKED_GLOBALS.filter((n) => n in scope),
    ...BLOCKED_NAVIGATOR.filter((n) => n in nav).map((n) => `navigator.${n}`),
  ];
}
