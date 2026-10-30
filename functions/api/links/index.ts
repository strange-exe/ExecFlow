// POST /api/links: a thin Pages Functions wrapper; the logic and its rules are in server/short-links.ts.
import { createLink, type Counter, type LinksEnv } from "../../../server/short-links";

/** caches.default: Cloudflare's own cache, which the standard CacheStorage type doesn't name. */
const edgeCache = (): Counter | null => (globalThis as { caches?: { default?: Counter } }).caches?.default ?? null;

export const onRequest = (context: { request: Request; env: LinksEnv }): Promise<Response> =>
  createLink(context.request, context.env, { random: (bytes) => void crypto.getRandomValues(bytes), now: () => Date.now(), counter: edgeCache() });
