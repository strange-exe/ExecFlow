// POST /api/links: a thin Pages Functions wrapper; the logic and its rules are in server/short-links.ts.
import { createLink, edgeCache, type LinksEnv } from "../../../server/short-links";

export const onRequest = (context: { request: Request; env: LinksEnv }): Promise<Response> =>
  createLink(context.request, context.env, { random: (bytes) => void crypto.getRandomValues(bytes), now: () => Date.now(), counter: edgeCache() });
