// A small GitHub REST client for sync: only the Git Database endpoints sync needs, over fetch.
// (Ported from the tested prototype; no Octokit: ~2 KB instead of ~18-37 KB gzip.)
//
// Rules from GitHub's docs, applied to every request:
// - Accept application/vnd.github+json, Authorization: Bearer, X-GitHub-Api-Version 2026-03-10.
// - cache: "no-store": API answers carry Cache-Control max-age=60, so a cached ref could be a
//   minute stale. Conditional reads send If-None-Match by hand (a 304 is free with a token).
// - credentials: "omit": the API allows any origin, so the token travels only in the header.
// - Writes go one at a time, at least 1 s apart ("make requests serially", secondary limits).
// - After a 401 the client refuses every further call: repeated bad credentials lock the account
//   out for a while, even for good tokens.
// Errors are classified by status, operation and headers, never by GitHub's message alone, and
// no error message ever contains the token.
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2026-03-10";
/** Shortest gap between the end of one write and the start of the next. */
export const WRITE_GAP_MS = 1000;
export const REQUEST_TIMEOUT_MS = 30_000;

const JSON_TYPE = "application/vnd.github+json";
const RAW_TYPE = "application/vnd.github.raw+json";

export type GitHubErrorKind =
  | "auth" // 401: token wrong, expired or revoked
  | "forbidden" // 403 without rate-limit headers: the token lacks a permission
  | "not-found" // 404/410: no such repo, branch or object (or the token can't see the private repo)
  | "conflict" // 409 (an empty repository answers getRef with 409; getRef reports that as "empty")
  | "ref-rejected" // 422 on updateRef: the branch moved (not a fast-forward)
  | "validation" // other 4xx: GitHub refused the request as invalid
  | "rate-limit" // 429, or 403 with retry-after / x-ratelimit-remaining: 0
  | "server" // 5xx, or an answer ExecFlow couldn't read
  | "network"; // no answer: offline, blocked, or timed out

export type GitHubOp =
  | "getRepo"
  | "getRef"
  | "getCommit"
  | "getTree"
  | "getBlob"
  | "compare"
  | "createBlob"
  | "createTree"
  | "createCommit"
  | "updateRef"
  | "putFile"
  | "getUser"
  | "listInstallations"
  | "listRepos"
  | "createGist";

const OP_LABEL: Record<GitHubOp, string> = {
  createGist: "Creating the gist",
  getUser: "Reading your GitHub account",
  listInstallations: "Reading where ExecFlow is installed",
  listRepos: "Reading the repositories ExecFlow can reach",
  getRepo: "Reading the repository",
  getRef: "Reading the branch",
  getCommit: "Reading a commit",
  getTree: "Reading the file list",
  getBlob: "Downloading a file",
  compare: "Comparing commits",
  createBlob: "Uploading a file",
  createTree: "Uploading the file list",
  createCommit: "Creating the commit",
  updateRef: "Moving the branch",
  putFile: "Adding the first file",
};

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    readonly kind: GitHubErrorKind,
    /** HTTP status; 0 when no answer arrived. */
    readonly status: number,
    readonly op: GitHubOp,
    message: string,
    /** Rate limits only: how long to wait before trying again. */
    readonly retryAfterMs?: number,
    /** "sign-in": the token couldn't be renewed (ExecFlow's sign-in relay), GitHub wasn't asked. */
    readonly via?: "sign-in",
  ) {
    super(message);
  }
}

/** Default wait after a rate-limit answer without a usable header (GitHub: "at least one minute"). */
const DEFAULT_RETRY_MS = 60_000;

/**
 * Classifies a failed answer. A 403 is a rate limit when its headers say so (retry-after, or
 * x-ratelimit-remaining "0") or when GitHub's message says so: a secondary limit may come with
 * neither header, and the docs then say to wait at least a minute. Any other 403 means a missing
 * permission. A 422 means "the branch moved" only for updateRef.
 */
export function classify(op: GitHubOp, status: number, headers: Headers, message = "", nowMs = Date.now()): GitHubError {
  const text = `${OP_LABEL[op]} failed: HTTP ${status}${message ? ` (${message})` : ""}`;
  const retryAfter = headers.get("retry-after");
  const remaining = headers.get("x-ratelimit-remaining");
  if (status === 429 || (status === 403 && (retryAfter !== null || remaining === "0" || /rate limit/i.test(message)))) {
    return new GitHubError("rate-limit", status, op, text, retryDelay(retryAfter, remaining, headers.get("x-ratelimit-reset"), nowMs));
  }
  if (status === 401) return new GitHubError("auth", status, op, text);
  if (status === 403) return new GitHubError("forbidden", status, op, text);
  if (status === 404 || status === 410) return new GitHubError("not-found", status, op, text);
  if (status === 409) return new GitHubError("conflict", status, op, text);
  if (status === 422 && op === "updateRef") return new GitHubError("ref-rejected", status, op, text);
  if (status >= 400 && status < 500) return new GitHubError("validation", status, op, text);
  return new GitHubError("server", status, op, text);
}

function retryDelay(retryAfter: string | null, remaining: string | null, reset: string | null, nowMs: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  if (remaining === "0" && reset !== null && Number.isFinite(Number(reset))) {
    return Math.max(1000, Number(reset) * 1000 - nowMs);
  }
  return DEFAULT_RETRY_MS;
}

// ---------------------------------------------------------------- shapes

export type TreeEntryType = "blob" | "tree" | "commit";

export interface TreeEntry {
  path: string;
  mode: string;
  type: TreeEntryType;
  sha: string;
  /** Blobs only. */
  size?: number;
}

/** One change for createTree. `sha: null` deletes the path; `content` is stored as UTF-8 bytes. */
export type TreeWrite =
  | { path: string; mode: string; type: "blob"; sha: string | null }
  | { path: string; mode: string; type: "blob"; content: string };

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export type RefState =
  | { state: "ok"; sha: string; etag: string | null }
  /** 304: the branch still points where it did when `etag` was issued. */
  | { state: "unchanged" }
  /** 409: the repository has no commits yet. */
  | { state: "empty" };

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
}

export interface TreeListing {
  sha: string;
  /** GitHub stops at 100,000 entries / 7 MB; a truncated list must not be synced against. */
  truncated: boolean;
  entries: TreeEntry[];
}

export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface GitHubClient {
  readonly owner: string;
  readonly repo: string;
  /** True once GitHub rejected the token (401): every later call fails without sending anything. */
  readonly tokenRejected: boolean;
  getRepo(): Promise<RepoInfo>;
  getRef(branch: string, etag?: string | null): Promise<RefState>;
  getCommit(sha: string): Promise<CommitInfo>;
  getTree(sha: string, recursive?: boolean): Promise<TreeListing>;
  /** The blob's exact bytes. */
  getBlob(sha: string): Promise<Uint8Array>;
  /** How `head` relates to `base`: "ahead" means head contains base. */
  compare(base: string, head: string): Promise<CompareStatus>;
  /** Uploads bytes as base64 (for content that can't go inline in createTree). Returns the blob sha. */
  createBlob(bytes: Uint8Array): Promise<string>;
  /** Returns the new tree's sha. `baseTree` null builds a tree from `entries` alone. */
  createTree(baseTree: string | null, entries: TreeWrite[]): Promise<string>;
  createCommit(message: string, tree: string, parents: string[]): Promise<string>;
  /** Moves the branch to `sha` only if that is a fast-forward (force: false). */
  updateRef(branch: string, sha: string): Promise<void>;
  /** Contents API, used only to give an empty repository its first commit (on the default branch). */
  putFile(path: string, bytes: Uint8Array, message: string): Promise<{ commit: string; blob: string }>;
  /**
   * POST /gists (Share link, src/sync/share.ts gistRequest): not under the repository, but with the
   * same token, headers and write queue. Returns GitHub's id and html_url as given: the caller
   * checks the address (share.ts gistPageUrl) before showing it as a link.
   */
  /**
   * POST /gists. `signal` is checked when the request's turn in the write queue comes, right before
   * it is sent: aborted by then, nothing is sent and the promise rejects with the signal's reason.
   * (It isn't passed to fetch: once the request is on its way, the gist may exist either way.)
   */
  createGist(body: GistBody, signal?: AbortSignal): Promise<{ id: string; htmlUrl: string }>;
}

/** The body of POST /gists (https://docs.github.com/en/rest/gists/gists#create-a-gist). */
export interface GistBody {
  description: string;
  public: false;
  files: Record<string, { content: string }>;
}

/**
 * Where the client gets its access token. A pasted token ("pat") never changes. A GitHub App
 * sign-in ("app") expires after 8 hours: current() refreshes it first when it is about to, and
 * after a 401 the client asks refresh() once, then retries that one request once.
 */
export interface TokenSource {
  readonly kind: "pat" | "app";
  /** The token to send now. Throws TokenUnavailable when there is none (sign-in ended, offline). */
  current(): Promise<string>;
  /** GitHub refused `stale` (401): resolves true when a different token is ready to try. */
  refresh?(stale: string): Promise<boolean>;
  /** Every secret the source holds (access and refresh tokens), scrubbed from all messages. */
  secrets(): readonly string[];
}

/** A token source couldn't give a token: "auth" means sign in again, the others may pass. */
export class TokenUnavailable extends Error {
  override name = "TokenUnavailable";
  constructor(readonly kind: "auth" | "network" | "server") {
    super(kind === "auth" ? "the GitHub sign-in has ended" : kind === "network" ? "the sign-in service couldn't be reached" : "the sign-in service had a problem");
  }
}

export const patSource = (token: string): TokenSource => ({ kind: "pat", current: async () => token, secrets: () => [token] });

export interface ClientOptions {
  /** A pasted token; or `source`. */
  token?: string;
  source?: TokenSource;
  owner: string;
  repo: string;
  /** Defaults to the global fetch (tests pass a fake). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Defaults to a setTimeout promise (tests pass one that returns at once). */
  sleep?: (ms: number) => Promise<void>;
}

const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const COMPARE_STATUSES: readonly string[] = ["ahead", "behind", "identical", "diverged"];
const ENTRY_TYPES: readonly string[] = ["blob", "tree", "commit"];

const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
/**
 * Encodes a branch or file path for the URL, one segment at a time. Empty, "." and ".." segments
 * are refused: the URL parser would resolve them and send the request (and the token) to another
 * API endpoint.
 */
function encodePath(path: string, what: string): string {
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new TypeError(`GitHub client: the ${what} is empty or malformed`);
  return segments.map(encodeURIComponent).join("/");
}

function requireSha(value: string, what: string): string {
  if (!isSha(value)) throw new TypeError(`${what} must be a 40-character git object id`);
  return value;
}

/** Token characters GitHub uses (letters, digits, "_"), checked without regex escapes. */
function tokenProblem(token: string): string | null {
  if (token.length === 0) return "the token is empty";
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    // Anything outside visible ASCII would make the Authorization header invalid, and some
    // engines quote the bad header value (the token) in that error.
    if (c < 0x21 || c > 0x7e) return "the token contains spaces or characters a GitHub token never has";
  }
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Answer {
  status: number;
  headers: Headers;
  data: unknown;
}

interface RequestOptions {
  body?: unknown;
  etag?: string | null;
  raw?: boolean;
  /** `path` starts at the API root (/gists), not at the repository. */
  api?: boolean;
}

export function createClient(options: ClientOptions): GitHubClient {
  const { owner, repo } = options;
  if (options.token !== undefined) {
    const problem = tokenProblem(options.token);
    if (problem) throw new TypeError(`GitHub client: ${problem}`);
  }
  const source = options.source ?? (options.token !== undefined ? patSource(options.token) : null);
  if (!source) throw new TypeError("GitHub client: there is no token");
  const again = source.kind === "app" ? "sign in again" : "enter a new one";
  if (!OWNER.test(owner)) throw new TypeError(`GitHub client: "${owner}" isn't a valid account name`);
  if (!REPO.test(repo) || repo === "." || repo === "..") throw new TypeError(`GitHub client: "${repo}" isn't a valid repository name`);

  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const root = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let rejected = false;

  /** Every token this client has sent: scrubbed from messages even after a refresh replaced it. */
  const used = new Set<string>();
  /** Keeps the tokens out of any text that leaves this module. */
  function clean(text: string): string {
    let scrubbed = text;
    for (const secret of [...used, ...source!.secrets()]) if (secret) scrubbed = scrubbed.split(secret).join("[token]");
    let out = "";
    for (const ch of scrubbed) {
      const code = ch.codePointAt(0)!;
      out += code < 0x20 || code === 0x7f ? " " : ch;
    }
    out = out.trim();
    return out.length > 200 ? `${out.slice(0, 200)}...` : out;
  }

  function networkError(op: GitHubOp, error: unknown): GitHubError {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "";
    const reason =
      name === "TimeoutError"
        ? `GitHub didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
        : name === "AbortError"
          ? "the request was cancelled"
          : "GitHub couldn't be reached";
    return new GitHubError("network", 0, op, `${OP_LABEL[op]} failed: ${reason}`);
  }

  const unexpected = (op: GitHubOp, status: number) =>
    new GitHubError("server", status, op, `${OP_LABEL[op]} failed: GitHub sent an answer ExecFlow couldn't read`);

  /** The source's error as a GitHubError of the same meaning ("auth" stops this client for good). */
  function unavailable(op: GitHubOp, error: unknown): GitHubError {
    if (error instanceof GitHubError) return error;
    const kind = error instanceof TokenUnavailable ? error.kind : "server";
    if (kind === "auth") {
      rejected = true;
      return new GitHubError("auth", 401, op, `${OP_LABEL[op]} wasn't tried: the GitHub sign-in has ended, so ${again}`);
    }
    return kind === "network"
      ? new GitHubError("network", 0, op, `${OP_LABEL[op]} failed: ExecFlow's sign-in service couldn't be reached`, undefined, "sign-in")
      : new GitHubError("server", 502, op, `${OP_LABEL[op]} failed: ExecFlow's sign-in service had a problem`, undefined, "sign-in");
  }

  async function currentToken(op: GitHubOp): Promise<string> {
    let token: string;
    try {
      token = await source!.current();
    } catch (error) {
      throw unavailable(op, error);
    }
    const problem = tokenProblem(token);
    if (problem) throw unavailable(op, new TokenUnavailable("auth"));
    used.add(token);
    return token;
  }

  async function request(op: GitHubOp, method: string, path: string, opts: RequestOptions = {}): Promise<Answer> {
    // An app token GitHub refuses gets one refresh and this request one retry; a second 401 stops.
    for (let attempt = 0; ; attempt++) {
      const token = await currentToken(op);
      const answer = await send(op, method, path, token, opts);
      if (!("unauthorized" in answer)) return answer;
      if (attempt === 0 && source!.refresh) {
        let fresh = false;
        try {
          fresh = await source!.refresh(token);
        } catch (error) {
          const e = unavailable(op, error);
          // Offline or the relay down: this token is still refused, but a later sync may refresh it.
          if (e.kind !== "auth") throw e;
        }
        if (fresh && !rejected) continue;
      }
      rejected = true;
      throw answer.unauthorized;
    }
  }

  /** One request with `token`. A 401 comes back as `unauthorized` so request() can refresh once. */
  async function send(op: GitHubOp, method: string, path: string, token: string, opts: RequestOptions): Promise<Answer | { unauthorized: GitHubError }> {
    if (rejected) {
      throw new GitHubError("auth", 401, op, `${OP_LABEL[op]} wasn't tried: GitHub rejected this token earlier, so ${again}`);
    }
    const headers: Record<string, string> = {
      Accept: opts.raw ? RAW_TYPE : JSON_TYPE,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    let res: Response;
    try {
      res = await doFetch((opts.api ? API_ROOT : root) + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(op, error);
    }
    if (res.status === 304 && opts.etag) return { status: 304, headers: res.headers, data: null };
    if (!res.ok) {
      let message = "";
      try {
        const body: unknown = JSON.parse(await res.text());
        if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
          message = clean((body as { message: string }).message);
        }
      } catch {
        // No readable body: the status and headers still classify the error.
      }
      const error = classify(op, res.status, res.headers, message);
      if (error.kind === "auth") return { unauthorized: error };
      throw error;
    }
    let data: unknown;
    try {
      data = opts.raw ? new Uint8Array(await res.arrayBuffer()) : await res.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw unexpected(op, res.status);
      throw networkError(op, error);
    }
    return { status: res.status, headers: res.headers, data };
  }

  // Writes run one after another with at least WRITE_GAP_MS between them, even across callers.
  let writes: Promise<unknown> = Promise.resolve();
  let lastWriteEnd = Number.NEGATIVE_INFINITY;
  function write<T>(fn: () => Promise<T>): Promise<T> {
    const run = writes.then(async () => {
      const wait = lastWriteEnd + WRITE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        lastWriteEnd = Date.now();
      }
    });
    writes = run.catch(() => undefined);
    return run;
  }

  const field = (data: unknown, key: string): unknown =>
    data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;

  function shaOf(op: GitHubOp, answer: Answer, ...keys: string[]): string {
    let value: unknown = answer.data;
    for (const key of keys) value = field(value, key);
    if (!isSha(value)) throw unexpected(op, answer.status);
    return value;
  }

  function branchPath(branch: string): string {
    // git check-ref-format: no component may begin with "." (which also rules out "." and "..").
    if (branch.split("/").some((s) => s.startsWith("."))) throw new TypeError("GitHub client: the branch name is empty or malformed");
    return encodePath(branch, "branch name");
  }

  return {
    owner,
    repo,
    get tokenRejected() {
      return rejected;
    },

    async getRepo() {
      const answer = await request("getRepo", "GET", "");
      const fullName = field(answer.data, "full_name");
      const isPrivate = field(answer.data, "private");
      const defaultBranch = field(answer.data, "default_branch");
      if (typeof isPrivate !== "boolean" || typeof defaultBranch !== "string" || defaultBranch === "") throw unexpected("getRepo", answer.status);
      return { fullName: typeof fullName === "string" ? fullName : `${owner}/${repo}`, private: isPrivate, defaultBranch };
    },

    async getRef(branch, etag) {
      let answer: Answer;
      try {
        answer = await request("getRef", "GET", `/git/ref/heads/${branchPath(branch)}`, { etag });
      } catch (error) {
        if (error instanceof GitHubError && error.kind === "conflict") return { state: "empty" };
        throw error;
      }
      if (answer.status === 304) return { state: "unchanged" };
      return { state: "ok", sha: shaOf("getRef", answer, "object", "sha"), etag: answer.headers.get("etag") };
    },

    async getCommit(sha) {
      const answer = await request("getCommit", "GET", `/git/commits/${requireSha(sha, "commit")}`);
      const tree = shaOf("getCommit", answer, "tree", "sha");
      const parents = field(answer.data, "parents");
      if (!Array.isArray(parents)) throw unexpected("getCommit", answer.status);
      return {
        sha: shaOf("getCommit", answer, "sha"),
        tree,
        parents: parents.map((p) => {
          const s = field(p, "sha");
          if (!isSha(s)) throw unexpected("getCommit", answer.status);
          return s;
        }),
      };
    },

    async getTree(sha, recursive = true) {
      const answer = await request("getTree", "GET", `/git/trees/${requireSha(sha, "tree")}${recursive ? "?recursive=1" : ""}`);
      const list = field(answer.data, "tree");
      if (!Array.isArray(list)) throw unexpected("getTree", answer.status);
      const entries = list.map((item): TreeEntry => {
        const path = field(item, "path");
        const mode = field(item, "mode");
        const type = field(item, "type");
        const entrySha = field(item, "sha");
        const size = field(item, "size");
        if (typeof path !== "string" || typeof mode !== "string" || typeof type !== "string" || !ENTRY_TYPES.includes(type) || !isSha(entrySha)) {
          throw unexpected("getTree", answer.status);
        }
        const entry: TreeEntry = { path, mode, type: type as TreeEntryType, sha: entrySha };
        if (typeof size === "number" && Number.isFinite(size) && size >= 0) entry.size = size;
        return entry;
      });
      return { sha: shaOf("getTree", answer, "sha"), truncated: field(answer.data, "truncated") === true, entries };
    },

    async getBlob(sha) {
      const answer = await request("getBlob", "GET", `/git/blobs/${requireSha(sha, "blob")}`, { raw: true });
      return answer.data as Uint8Array;
    },

    async compare(base, head) {
      const answer = await request("compare", "GET", `/compare/${requireSha(base, "base")}...${requireSha(head, "head")}?per_page=1`);
      const status = field(answer.data, "status");
      if (typeof status !== "string" || !COMPARE_STATUSES.includes(status)) throw unexpected("compare", answer.status);
      return status as CompareStatus;
    },

    async createBlob(bytes) {
      return write(async () => shaOf("createBlob", await request("createBlob", "POST", "/git/blobs", { body: { content: toBase64(bytes), encoding: "base64" } }), "sha"));
    },

    async createTree(baseTree, entries) {
      const body: Record<string, unknown> = { tree: entries };
      if (baseTree !== null) body.base_tree = requireSha(baseTree, "base tree");
      return write(async () => shaOf("createTree", await request("createTree", "POST", "/git/trees", { body }), "sha"));
    },

    async createCommit(message, tree, parents) {
      const body = { message, tree: requireSha(tree, "tree"), parents: parents.map((p) => requireSha(p, "parent")) };
      return write(async () => shaOf("createCommit", await request("createCommit", "POST", "/git/commits", { body }), "sha"));
    },

    async updateRef(branch, sha) {
      const path = `/git/refs/heads/${branchPath(branch)}`;
      const body = { sha: requireSha(sha, "commit"), force: false };
      return write(async () => {
        await request("updateRef", "PATCH", path, { body });
      });
    },

    async putFile(path, bytes, message) {
      const url = `/contents/${encodePath(path, "file path")}`;
      return write(async () => {
        const answer = await request("putFile", "PUT", url, { body: { message, content: toBase64(bytes) } });
        return { commit: shaOf("putFile", answer, "commit", "sha"), blob: shaOf("putFile", answer, "content", "sha") };
      });
    },

    async createGist(body, signal) {
      // Only the fields the share dialog builds: never `public: true`, whatever a caller passes.
      const sent: GistBody = { description: String(body.description), public: false, files: body.files };
      signal?.throwIfAborted();
      return write(async () => {
        // The dialog may have closed while a sync's writes went first.
        signal?.throwIfAborted();
        const answer = await request("createGist", "POST", "/gists", { body: sent, api: true });
        const id = field(answer.data, "id");
        const htmlUrl = field(answer.data, "html_url");
        if (typeof id !== "string" || id === "" || typeof htmlUrl !== "string") throw unexpected("createGist", answer.status);
        return { id, htmlUrl };
      });
    },
  };
}
