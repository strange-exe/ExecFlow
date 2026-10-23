// The sign-in relay for "Sign in with GitHub" (a GitHub App, web flow with PKCE). It exists only
// because two steps need the app's client secret, which must never reach a browser: exchanging the
// one-time code for tokens, and refreshing them. Revoking a token needs it too (Basic auth).
// Cloudflare Pages runs it as four routes (functions/api/auth/*.ts); this file is the whole logic,
// a pure (request, env, fetch) => Response so the unit tests can drive it.
//
// Rules, each applied before anything is forwarded:
// - One method per route, else 405. Bodies only as application/json, at most 4 KB, else 415/413.
//   (A cross-site JSON POST needs a CORS preflight, and nothing here ever answers one.)
// - Origin must equal ALLOWED_ORIGIN exactly, and Sec-Fetch-Site must be same-origin when the
//   browser sends it, else 403. Preview and old deployments have another origin, so they refuse.
// - Every field's shape is checked (code, PKCE verifier, ghr_/ghu_ tokens, repository id).
// - Upstream URLs are constants; nothing from the request becomes a URL or a header. redirect_uri
//   comes from ALLOWED_ORIGIN, never from the request. No redirects are followed; 10 s timeout.
// - Answers carry only whitelisted fields; GitHub's errors map to a fixed set of words, and
//   GitHub's own text is never passed on. No CORS headers, no caching, nothing is logged.
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
// https://docs.github.com/en/rest/apps/oauth-applications (Delete an app token)
// https://developers.cloudflare.com/pages/functions/api-reference/

export interface AuthEnv {
  GITHUB_CLIENT_ID?: string;
  /** An encrypted Pages secret, Production only. */
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  /** The exact production origin, e.g. https://code.example.org (no trailing slash). */
  ALLOWED_ORIGIN?: string;
}

export type AuthRoute = "config" | "token" | "refresh" | "revoke";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The words an answer's `error` field can hold: nothing else ever is. */
export type AuthErrorCode =
  | "not_configured"
  | "method_not_allowed"
  | "forbidden"
  | "unsupported_media_type"
  | "too_large"
  | "invalid_request"
  | "bad_verification_code"
  | "bad_refresh_token"
  | "unverified_user_email"
  | "access_denied"
  | "incorrect_client_credentials"
  | "redirect_uri_mismatch"
  | "upstream"
  | "internal";

export const TOKEN_URL = "https://github.com/login/oauth/access_token";
export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2026-03-10";
/** The path GitHub sends the student back to (one segment, so the page's relative URLs still resolve). */
export const CALLBACK_PATH = "/auth-callback";
export const MAX_BODY_BYTES = 4096;
export const UPSTREAM_TIMEOUT_MS = 10_000;
const USER_AGENT = "CodeEditor-sign-in";

const METHODS: Record<AuthRoute, string> = { config: "GET", token: "POST", refresh: "POST", revoke: "POST" };

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function reply(status: number, body: Record<string, unknown> | null, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const fail = (status: number, error: AuthErrorCode, extra?: Record<string, string>) => reply(status, { error }, extra);

// ---------------------------------------------------------------- shapes (no regex escapes)

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function every(text: string, ok: (c: number) => boolean): boolean {
  for (let i = 0; i < text.length; i++) if (!ok(text.charCodeAt(i))) return false;
  return true;
}

/** The one-time code GitHub puts in the callback URL. */
export const isCode = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 100 && every(v, (c) => isAlpha(c) || isDigit(c) || c === 0x5f || c === 0x2d);

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
export const isVerifier = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 43 &&
  v.length <= 128 &&
  every(v, (c) => isAlpha(c) || isDigit(c) || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e);

/** A GitHub token with its prefix: visible ASCII only (it becomes a form field or a JSON string). */
const isToken = (prefix: string) => (v: unknown): v is string =>
  typeof v === "string" && v.length > prefix.length + 8 && v.length <= 255 && v.startsWith(prefix) && every(v, (c) => c > 0x20 && c < 0x7f);
export const isAccessToken = isToken("ghu_");
export const isRefreshToken = isToken("ghr_");

const isRepoId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Client IDs ("Iv23li..." or "Iv1.8a61..."), slugs ("codeeditor-sync"): checked before use. */
const isClientId = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 4 && v.length <= 64 && every(v, (c) => isAlpha(c) || isDigit(c) || c === 0x2e || c === 0x5f || c === 0x2d);
const isSlug = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 64 && every(v, (c) => (c >= 0x61 && c <= 0x7a) || isDigit(c) || c === 0x2d);

/** An origin exactly as a browser sends it: scheme, host, optional port, nothing else. */
function isOrigin(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200) return false;
  try {
    const url = new URL(v);
    return url.origin === v && (url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

interface Config {
  clientId: string;
  clientSecret: string;
  slug: string;
  origin: string;
}

function configOf(env: AuthEnv): Config | null {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret, GITHUB_APP_SLUG: slug, ALLOWED_ORIGIN: origin } = env;
  if (!isClientId(clientId) || !isSlug(slug) || !isOrigin(origin)) return null;
  if (typeof clientSecret !== "string" || clientSecret.length < 8 || clientSecret.length > 255 || !every(clientSecret, (c) => c > 0x20 && c < 0x7f)) return null;
  return { clientId, clientSecret, slug, origin };
}

// ---------------------------------------------------------------- the request

/** Reads at most MAX_BODY_BYTES; null when the body is larger (the rest is never read). */
async function readCapped(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

async function jsonBody(request: Request): Promise<BodyResult> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, response: fail(415, "unsupported_media_type") };
  let text: string | null;
  try {
    text = await readCapped(request);
  } catch {
    return { ok: false, response: fail(400, "invalid_request") };
  }
  if (text === null) return { ok: false, response: fail(413, "too_large") };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: fail(400, "invalid_request") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, response: fail(400, "invalid_request") };
  return { ok: true, body: body as Record<string, unknown> };
}

/** Same site only: the exact origin, and the browser's own Sec-Fetch-Site when it sends one. */
function sameOrigin(request: Request, origin: string, requireOrigin: boolean): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const sent = request.headers.get("origin");
  if (sent === null) return !requireOrigin;
  return sent === origin;
}

// ---------------------------------------------------------------- GitHub

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "bad_verification_code",
  "bad_refresh_token",
  "unverified_user_email",
  "access_denied",
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
]);

/** The student can fix these by signing in again; the others are this site's set-up or GitHub. */
const STUDENT_ERRORS: ReadonlySet<string> = new Set(["bad_verification_code", "bad_refresh_token", "unverified_user_email", "access_denied"]);

async function tokenRequest(fetchImpl: Fetch, fields: Record<string, string>): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return fail(502, "upstream");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return fail(502, "upstream");
  }
  const field = (key: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined);
  // GitHub can answer 200 with an `error` field: the error wins whatever the status.
  const error = field("error");
  if (typeof error === "string") {
    if (!KNOWN_ERRORS.has(error)) return fail(502, "upstream");
    return fail(STUDENT_ERRORS.has(error) ? 400 : 502, error as AuthErrorCode);
  }
  if (res.status !== 200) return fail(502, "upstream");
  const access = field("access_token");
  const expiresIn = field("expires_in");
  const refresh = field("refresh_token");
  const refreshExpiresIn = field("refresh_token_expires_in");
  // Expiring tokens only (scope=offline_access asks for them): a pair CodeEditor can refresh.
  if (!isAccessToken(access) || !isSeconds(expiresIn) || !isRefreshToken(refresh) || !isSeconds(refreshExpiresIn)) return fail(502, "upstream");
  return reply(200, { access_token: access, expires_in: expiresIn, refresh_token: refresh, refresh_token_expires_in: refreshExpiresIn });
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function revokeRequest(fetchImpl: Fetch, config: Config, accessToken: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_ROOT}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${base64(`${config.clientId}:${config.clientSecret}`)}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return fail(502, "upstream");
  }
  // 204: revoked. 404: GitHub doesn't know the token (already revoked or expired): it is gone either way.
  if (res.status === 204 || res.status === 404) return reply(204, null);
  return fail(502, "upstream");
}

// ---------------------------------------------------------------- the handler

/** Answers one request to /api/auth/<route>. Never throws, never logs. */
export async function handleAuth(route: AuthRoute, request: Request, env: AuthEnv, fetchImpl: Fetch): Promise<Response> {
  try {
    const method = METHODS[route];
    if (request.method !== method) return fail(405, "method_not_allowed", { Allow: method });
    const config = configOf(env);
    if (!config) return fail(404, "not_configured");
    if (!sameOrigin(request, config.origin, route !== "config")) return fail(403, "forbidden");
    if (route === "config") return reply(200, { clientId: config.clientId, appSlug: config.slug });

    const parsed = await jsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { body } = parsed;

    if (route === "token") {
      const { code, code_verifier: verifier, repository_id: repoId } = body;
      if (!isCode(code) || !isVerifier(verifier) || (repoId !== undefined && !isRepoId(repoId))) return fail(400, "invalid_request");
      const fields: Record<string, string> = {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: config.origin + CALLBACK_PATH,
      };
      if (repoId !== undefined) fields.repository_id = String(repoId);
      return await tokenRequest(fetchImpl, fields);
    }
    if (route === "refresh") {
      const { refresh_token: refresh } = body;
      if (!isRefreshToken(refresh)) return fail(400, "invalid_request");
      return await tokenRequest(fetchImpl, { client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refresh });
    }
    const { access_token: access } = body;
    if (!isAccessToken(access)) return fail(400, "invalid_request");
    return await revokeRequest(fetchImpl, config, access);
  } catch {
    return fail(500, "internal");
  }
}
