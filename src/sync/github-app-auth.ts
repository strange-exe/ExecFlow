// "Sign in with GitHub" in the browser (a GitHub App, web flow with PKCE S256 and state), and the
// token source that keeps its 8-hour access token fresh. The client secret lives only in the
// sign-in relay on this site (/api/auth/*, server/github-auth.ts); this file never sees it.
//
// The round trip: startSignIn() keeps a one-time record {state, PKCE verifier, workspace,
// remember} in sessionStorage (this tab only, it survives the trip to github.com) and returns
// GitHub's authorize URL; the page goes there in the same tab. GitHub sends the student back to
// /auth-callback, src/sync/auth-callback.ts takes the code off the URL, and checkCallback() reads
// AND deletes the record and compares the state before anything is sent. Only then does
// exchange() post the code and the verifier to the relay.
//
// Tokens: in memory by default; "Remember on this device" seals them in the secrets database
// (token-store.ts). Refreshing rotates the pair (the old one stops working), so a refresh runs
// under the Web Lock "codeeditor/github-refresh" and first re-reads the sealed record: if another
// tab already refreshed, its pair is taken instead of spending the same refresh token twice.
// No token ever goes into a URL, the DOM, storage in clear, or a message.
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
// https://www.rfc-editor.org/rfc/rfc7636 (PKCE), https://www.rfc-editor.org/rfc/rfc9700 (OAuth security BCP)

import { CALLBACK_PATH, type AuthCallback } from "./auth-callback";
import { TokenUnavailable, type TokenSource } from "./github";
import { forgetAppTokens, loadAppTokens, rememberAppTokens, type AppTokens } from "./token-store";

export const AUTH_API = "/api/auth";
export const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const PENDING_KEY = "codeeditor:sign-in";
/** A sign-in not finished within 10 minutes is ignored. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;
/** Refresh when the access token has less than this left (a large push takes minutes). */
export const REFRESH_EARLY_MS = 10 * 60_000;
export const REFRESH_LOCK = "codeeditor/github-refresh";
const TIMEOUT_MS = 15_000;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

/** Same-origin calls to the relay: no caching, no Referer. */
const RELAY: RequestInit = { cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer" };

export interface AuthConfig {
  clientId: string;
  appSlug: string;
}

/** absent: this site has no sign-in relay (forks, `vite preview`, not set up): the token path. */
export type ConfigState = { state: "available"; config: AuthConfig } | { state: "absent" } | { state: "unreachable" };

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const every = (text: string, ok: (c: number) => boolean) => {
  for (let i = 0; i < text.length; i++) if (!ok(text.charCodeAt(i))) return false;
  return true;
};
const isClientId = (v: unknown): v is string => typeof v === "string" && v.length >= 4 && v.length <= 64 && every(v, (c) => isAlpha(c) || isDigit(c) || c === 0x2e || c === 0x5f || c === 0x2d);
const isSlug = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 64 && every(v, (c) => (c >= 0x61 && c <= 0x7a) || isDigit(c) || c === 0x2d);
const isCode = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 100 && every(v, (c) => isAlpha(c) || isDigit(c) || c === 0x5f || c === 0x2d);
const isToken = (prefix: string) => (v: unknown): v is string =>
  typeof v === "string" && v.length > prefix.length + 8 && v.length <= 255 && v.startsWith(prefix) && every(v, (c) => c > 0x20 && c < 0x7f);
const isAccess = isToken("ghu_");
const isRefresh = isToken("ghr_");
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Reads /api/auth/config. Anything but the relay's JSON (404, the app's own HTML page) is "absent". */
export async function fetchConfig(fetchImpl: Fetch = defaultFetch): Promise<ConfigState> {
  let res: Response;
  try {
    // No Accept header: a site without the relay answers with its own page (an SPA fallback),
    // which reads as "absent" below instead of a 404 (vite preview answers 404 to non-HTML Accepts).
    res = await fetchImpl(`${AUTH_API}/config`, { ...RELAY, method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { state: "unreachable" };
  }
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("application/json")) return { state: "absent" };
  try {
    const data: unknown = await res.json();
    const { clientId, appSlug } = (data ?? {}) as Record<string, unknown>;
    if (isClientId(clientId) && isSlug(appSlug)) return { state: "available", config: { clientId, appSlug } };
  } catch {
    // not the relay's answer
  }
  return { state: "absent" };
}

// ---------------------------------------------------------------- state and PKCE

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes as base64url: 43 characters (a PKCE verifier, RFC 7636 4.1; and the state). */
export const randomValue = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** S256: BASE64URL(SHA-256(verifier)), RFC 7636 4.2. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export interface PendingSignIn {
  v: 1;
  state: string;
  verifier: string;
  /** The workspace that asked (after the trip back, sign-in finishes only for it). */
  ws: string;
  remember: boolean;
  createdAt: number;
  /** An already connected repository: the new token is narrowed to it (repository_id). */
  repoId?: number;
}

export function authorizeUrl(config: AuthConfig, origin: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", origin + CALLBACK_PATH);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Expiring tokens with a refresh token (the only scope a GitHub App takes).
  url.searchParams.set("scope", "offline_access");
  // Always the account picker: on a shared computer the last student's GitHub session isn't used silently.
  url.searchParams.set("prompt", "select_account");
  return url.href;
}

export interface StartOptions {
  config: AuthConfig;
  origin: string;
  ws: string;
  remember: boolean;
  repoId?: number;
  storage?: Pick<Storage, "setItem">;
  now?: number;
}

/** Keeps the one-time record and returns the URL to send this tab to. Throws if storage is blocked. */
export async function startSignIn(o: StartOptions): Promise<string> {
  const state = randomValue();
  const verifier = randomValue();
  const pending: PendingSignIn = { v: 1, state, verifier, ws: o.ws, remember: o.remember, createdAt: o.now ?? Date.now() };
  if (o.repoId !== undefined) pending.repoId = o.repoId;
  (o.storage ?? sessionStorage).setItem(PENDING_KEY, JSON.stringify(pending));
  return authorizeUrl(o.config, o.origin, state, await pkceChallenge(verifier));
}

const isPending = (v: unknown): v is PendingSignIn => {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.state === "string" &&
    p.state.length === 43 &&
    typeof p.verifier === "string" &&
    p.verifier.length === 43 &&
    typeof p.ws === "string" &&
    typeof p.remember === "boolean" &&
    typeof p.createdAt === "number" &&
    (p.repoId === undefined || (typeof p.repoId === "number" && Number.isSafeInteger(p.repoId) && p.repoId > 0))
  );
};

/** Reads AND deletes this tab's record (it is single use). Null when there is none, or it is too old. */
export function takePending(storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage, now = Date.now()): PendingSignIn | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPending(value)) return null;
    const age = now - value.createdAt;
    return age >= 0 && age <= PENDING_MAX_AGE_MS ? value : null;
  } catch {
    return null;
  }
}

/** Forgets a sign-in started in this tab (sign-out, a new attempt). */
export function clearPending(storage: Pick<Storage, "removeItem"> = sessionStorage): void {
  try {
    storage.removeItem(PENDING_KEY);
  } catch {
    // storage blocked: nothing was kept
  }
}

export type CallbackCheck =
  | { ok: true; code: string; pending: PendingSignIn }
  /** state: no record in this tab, another state, too old, another workspace. denied: cancelled on GitHub. */
  | { ok: false; reason: "state" | "denied" | "github" };

/** Compares the callback with this tab's record. Nothing is sent anywhere. */
export function checkCallback(cb: AuthCallback, pending: PendingSignIn | null, ws: string): CallbackCheck {
  if (!pending || cb.state === null || !sameText(cb.state, pending.state) || pending.ws !== ws) return { ok: false, reason: "state" };
  if (cb.error !== null) return { ok: false, reason: cb.error === "access_denied" ? "denied" : "github" };
  if (!isCode(cb.code)) return { ok: false, reason: "github" };
  return { ok: true, code: cb.code, pending };
}

/** Compares without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- the relay

export type SignInErrorKind = "bad_verification_code" | "bad_refresh_token" | "unverified_user_email" | "access_denied" | "unavailable" | "network";

export class SignInError extends Error {
  override name = "SignInError";
  constructor(readonly kind: SignInErrorKind) {
    super(`sign-in failed: ${kind}`);
  }
}

const STUDENT_ERRORS: readonly string[] = ["bad_verification_code", "bad_refresh_token", "unverified_user_email", "access_denied"];

async function post(fetchImpl: Fetch, route: string, body: unknown): Promise<Response> {
  try {
    return await fetchImpl(`${AUTH_API}/${route}`, {
      ...RELAY,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SignInError("network");
  }
}

async function tokensFrom(res: Response, now: number): Promise<AppTokens> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new SignInError("unavailable");
  }
  const d = (data ?? {}) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new SignInError(typeof d.error === "string" && STUDENT_ERRORS.includes(d.error) ? (d.error as SignInErrorKind) : "unavailable");
  }
  if (!isAccess(d.access_token) || !isSeconds(d.expires_in) || !isRefresh(d.refresh_token) || !isSeconds(d.refresh_token_expires_in)) throw new SignInError("unavailable");
  return { access: d.access_token, accessExpiresAt: now + d.expires_in * 1000, refresh: d.refresh_token, refreshExpiresAt: now + d.refresh_token_expires_in * 1000 };
}

/** The one-time code and the PKCE verifier for a token pair (POST /api/auth/token). */
export async function exchange(code: string, verifier: string, repoId: number | undefined, fetchImpl: Fetch = defaultFetch, now = () => Date.now()): Promise<AppTokens> {
  const body: Record<string, unknown> = { code, code_verifier: verifier };
  if (repoId !== undefined) body.repository_id = repoId;
  const res = await post(fetchImpl, "token", body);
  return tokensFrom(res, now());
}

/** A new pair for the refresh token (POST /api/auth/refresh). The old pair stops working. */
export async function refreshPair(refresh: string, fetchImpl: Fetch = defaultFetch, now = () => Date.now()): Promise<AppTokens> {
  return tokensFrom(await post(fetchImpl, "refresh", { refresh_token: refresh }), now());
}

/** Revokes this one access token (POST /api/auth/revoke). True when GitHub confirmed it. */
export async function revokeToken(access: string, fetchImpl: Fetch = defaultFetch): Promise<boolean> {
  try {
    return (await post(fetchImpl, "revoke", { access_token: access })).status === 204;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the token source

export interface TokenStore {
  load(): Promise<AppTokens | null>;
  save(tokens: AppTokens): Promise<void>;
  forget(): Promise<void>;
}

const sealedStore: TokenStore = { load: loadAppTokens, save: rememberAppTokens, forget: forgetAppTokens };

export type Lock = <T>(run: () => Promise<T>) => Promise<T>;

/** The Web Lock shared by every tab of this site; without Web Locks, just runs. */
const webLock: Lock = (run) => (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request(REFRESH_LOCK, run) : run());

export interface AppSourceOptions {
  tokens: AppTokens;
  /** The pair is sealed in the secrets database, and every refresh seals the new one. */
  remember: boolean;
  fetch?: Fetch;
  now?: () => number;
  lock?: Lock;
  store?: TokenStore;
}

export interface AppTokenSource extends TokenSource {
  readonly kind: "app";
  readonly remembered: boolean;
  /** The pair now (for revoke on Disconnect). */
  tokens(): AppTokens;
}

export function createAppTokenSource(o: AppSourceOptions): AppTokenSource {
  const fetchImpl = o.fetch ?? defaultFetch;
  const now = o.now ?? (() => Date.now());
  const lock = o.lock ?? webLock;
  const store = o.store ?? sealedStore;
  let tokens = { ...o.tokens };
  const seen = new Set<string>([tokens.access, tokens.refresh]);
  let inflight: Promise<void> | null = null;

  const adopt = (next: AppTokens) => {
    tokens = { ...next };
    seen.add(next.access);
    seen.add(next.refresh);
  };

  /** Refreshes unless the pair already moved on from `stale` (here, or in another tab). */
  function refreshFrom(stale: string): Promise<void> {
    inflight ??= lock(async () => {
      if (tokens.access !== stale) return;
      if (o.remember) {
        const stored = await store.load().catch(() => null);
        if (stored && stored.access !== stale && stored.refresh !== tokens.refresh) {
          adopt(stored);
          return;
        }
      }
      if (now() >= tokens.refreshExpiresAt) {
        if (o.remember) await store.forget().catch(() => {});
        throw new TokenUnavailable("auth");
      }
      let next: AppTokens;
      try {
        next = await refreshPair(tokens.refresh, fetchImpl, now);
      } catch (error) {
        const kind = error instanceof SignInError ? error.kind : "unavailable";
        if (kind === "bad_refresh_token") {
          if (o.remember) await store.forget().catch(() => {});
          throw new TokenUnavailable("auth");
        }
        throw new TokenUnavailable(kind === "network" ? "network" : "server");
      }
      adopt(next);
      if (o.remember) {
        // A sealed pair that is no longer the live one would only fail later: drop it instead.
        await store.save(next).catch(() => store.forget().catch(() => {}));
      }
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    kind: "app",
    remembered: o.remember,
    tokens: () => ({ ...tokens }),
    secrets: () => [...seen],
    async current() {
      if (tokens.accessExpiresAt - now() > REFRESH_EARLY_MS) return tokens.access;
      try {
        await refreshFrom(tokens.access);
      } catch (error) {
        // Offline or the relay down, but the token still has a few minutes: use them.
        if (error instanceof TokenUnavailable && error.kind !== "auth" && tokens.accessExpiresAt > now()) return tokens.access;
        throw error;
      }
      return tokens.access;
    },
    async refresh(stale) {
      await refreshFrom(stale);
      return tokens.access !== stale;
    },
  };
}
