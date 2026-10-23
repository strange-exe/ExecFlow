// GET /api/auth/config: a thin Pages Functions wrapper; the logic and its rules are in server/github-auth.ts.
import { handleAuth, type AuthEnv } from "../../../server/github-auth";

export const onRequest = (context: { request: Request; env: AuthEnv }): Promise<Response> =>
  handleAuth("config", context.request, context.env, (input, init) => fetch(input, init));
