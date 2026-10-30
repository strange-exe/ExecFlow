// GET /api/links/<id>: a thin Pages Functions wrapper; the logic and its rules are in server/short-links.ts.
// `params.id` is whatever the route matched: readLink checks its shape before anything else.
import { readLink, type LinksEnv } from "../../../server/short-links";

export const onRequest = (context: { request: Request; env: LinksEnv; params: { id?: string | string[] } }): Promise<Response> =>
  readLink(context.request, context.env, context.params.id);
