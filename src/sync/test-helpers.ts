// Test doubles for the sync module (never imported by the app):
// - MemoryStore: an in-memory SyncStore that follows src/core/types.ts exactly: compare-and-set
//   on every put/remove (`expect`), skipped paths reported, one atomic commit. For a skipped path
//   it keeps that path's previous base entry (see the sync report's contract notes).
// - createFakeGitHub: the GitHub endpoints sync uses, in memory, following the documented
//   semantics (ported from the tested prototype fake-github.mjs): 409 on an empty repository,
//   base_tree + sha:null deletes (error if missing), sha XOR content, force:false fast-forward
//   check (422), ETag/304 on refs, compare status, raw blobs. Tree and commit ids are fake hashes.

import { encodeFileBytes, gitBlobSha, textBlobSha, type Eol } from "../core/bytes";
import { normalizePath, parentOf } from "../core/paths";
import type { BaseEntry, LocalFileState, OpaqueBlob, RemoteMeta, SyncCommit, SyncSnapshot, SyncStore, WsPath } from "../core/types";
import type { OpaquePut, SyncCommitWithOpaque } from "./engine";

export const TEST_TOKEN = "github_pat_TESTtoken0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";

// ---------------------------------------------------------------- store

export interface MemoryFile {
  text: string;
  eol: Eol;
  bom: boolean;
  sha: string;
  opaque?: OpaqueBlob;
}

export type FileInput = string | { text: string; eol?: Eol; bom?: boolean };

const EMPTY_REMOTE: RemoteMeta = {
  provider: "github",
  owner: "",
  repo: "",
  branch: "",
  baseCommit: null,
  baseTree: null,
  refEtag: null,
  lastSyncAt: null,
  lastError: null,
  deviceName: "",
};

export interface MemoryStoreOptions {
  /** false: behave like a store that doesn't know SyncCommit.opaque (ignores it). */
  supportsOpaque?: boolean;
}

export class MemoryStore implements SyncStore {
  readonly files = new Map<WsPath, MemoryFile>();
  base = new Map<WsPath, BaseEntry>();
  remote: RemoteMeta | null = null;
  readonly commits: SyncCommitWithOpaque[] = [];
  /** Runs at the start of commit(): simulates the user typing while a sync is under way. */
  beforeCommit: (() => Promise<void> | void) | null = null;
  readTexts = 0;

  constructor(readonly options: MemoryStoreOptions = {}) {}

  static async with(files: Record<string, FileInput> = {}, options: MemoryStoreOptions = {}): Promise<MemoryStore> {
    const store = new MemoryStore(options);
    for (const [path, input] of Object.entries(files)) {
      if (typeof input === "string") await store.write(path, input);
      else await store.write(path, input.text, input.eol, input.bom);
    }
    return store;
  }

  /** A user edit (or a new file). */
  async write(path: string, text: string, eol: Eol = "\n", bom = false): Promise<void> {
    if (normalizePath(path) !== path) throw new Error(`test bug: ${path} isn't a clean path`);
    this.files.set(path, { text, eol, bom, sha: await textBlobSha(text, eol, bom) });
  }

  /** A user delete. */
  delete(path: string): void {
    this.files.delete(path);
  }

  /** Text files, sorted, as {path: text}. */
  texts(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of [...this.files.keys()].sort()) {
      const f = this.files.get(path)!;
      if (!f.opaque) out[path] = f.text;
    }
    return out;
  }

  opaquePaths(): string[] {
    return [...this.files].filter(([, f]) => f.opaque).map(([p]) => p).sort();
  }

  async snapshot(): Promise<SyncSnapshot> {
    const local = new Map<WsPath, LocalFileState>();
    for (const [path, f] of this.files) {
      const state: LocalFileState = { path, sha: f.sha, eol: f.eol, bom: f.bom };
      if (f.opaque) state.opaque = { ...f.opaque };
      local.set(path, state);
    }
    return {
      local,
      base: new Map([...this.base].map(([p, e]) => [p, { ...e }])),
      remote: this.remote ? { ...this.remote } : null,
    };
  }

  async readText(path: WsPath): Promise<string> {
    const f = this.files.get(path);
    if (!f || f.opaque) throw new Error(`no text file at ${path}`);
    this.readTexts++;
    return f.text;
  }

  async commit(change: SyncCommit): Promise<{ skipped: WsPath[] }> {
    await this.beforeCommit?.();
    const opaque: OpaquePut[] = this.options.supportsOpaque === false ? [] : ((change as SyncCommitWithOpaque).opaque ?? []);
    // Check everything before changing anything: one transaction.
    const seen = new Set<string>();
    for (const path of [...change.put.map((p) => p.path), ...opaque.map((o) => o.path), ...change.remove.map((r) => r.path)]) {
      if (normalizePath(path) !== path) throw new Error(`commit: ${path} isn't a clean path`);
      if (seen.has(path)) throw new Error(`commit: ${path} appears twice`);
      seen.add(path);
    }
    for (const p of change.put) {
      if ((await textBlobSha(p.text, p.eol, p.bom)) !== p.sha) throw new Error(`commit: the sha given for ${p.path} doesn't match its text`);
    }
    for (const e of change.base) if (normalizePath(e.path) !== e.path) throw new Error(`commit: base path ${e.path} isn't clean`);

    const skipped: WsPath[] = [];
    const current = (path: string) => this.files.get(path)?.sha ?? "absent";
    const accept = (path: string, expect: string) => {
      if (current(path) === expect) return true;
      skipped.push(path);
      return false;
    };
    const puts = change.put.filter((p) => accept(p.path, p.expect));
    const opaques = opaque.filter((o) => accept(o.path, o.expect));
    const removes = change.remove.filter((r) => accept(r.path, r.expect));

    const next = new Map(this.files);
    for (const r of removes) next.delete(r.path);
    for (const p of puts) next.set(p.path, { text: p.text, eol: p.eol, bom: p.bom, sha: p.sha });
    for (const o of opaques) next.set(o.path, { text: "", eol: "\n", bom: false, sha: o.sha, opaque: { sha: o.sha, mode: o.mode } });
    // Like the real store: a path can't be a file and a folder at once.
    for (const path of next.keys()) {
      for (let d = parentOf(path); d !== ""; d = parentOf(d)) if (next.has(d)) throw new Error(`commit: ${d} would be a file and a folder`);
    }

    const base = new Map(change.base.map((e) => [e.path, { ...e }]));
    for (const path of skipped) {
      const old = this.base.get(path);
      if (old) base.set(path, old);
      else base.delete(path);
    }
    this.files.clear();
    for (const [p, f] of next) this.files.set(p, f);
    this.base = base;
    this.remote = { ...(this.remote ?? EMPTY_REMOTE), ...change.remote };
    this.commits.push(change);
    return { skipped };
  }
}

// ---------------------------------------------------------------- GitHub

export interface FakeEntry {
  sha: string;
  mode: string;
  type: "blob" | "commit";
}

/** A file for remoteCommit: text, exact bytes, or a link/submodule. null deletes the path. */
export type RemoteChange = string | Uint8Array | null | { bytes?: Uint8Array; text?: string; mode?: string; submodule?: string };

export interface FakeRequest {
  method: string;
  path: string;
  headers: Headers;
  init: RequestInit;
  body: unknown;
}

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  private?: boolean;
  /** Delay before each blob answer, to observe parallel downloads. */
  blobLatencyMs?: number;
  /** false: changes under .github/workflows/ are refused, as for a token without Workflows. */
  workflowsWritable?: boolean;
  /**
   * POST /gists for a token without the gist permission: 403 (a fine-grained token or a GitHub App
   * without "Gists"), 404 (a classic token without the gist scope). Default: allowed.
   */
  gistsRefused?: 403 | 404;
}

/** A gist the fake made (POST /gists). */
export interface FakeGist {
  id: string;
  description: unknown;
  public: unknown;
  files: Record<string, { content: string }>;
}

const utf8 = new TextEncoder();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function createFakeGitHub(options: FakeGitHubOptions = {}) {
  const owner = options.owner ?? "me";
  const repo = options.repo ?? "workspace";
  const branch = options.branch ?? "main";
  const token = options.token ?? TEST_TOKEN;
  /** Tokens GitHub accepts now: a sign-in's token expires (rejectToken) and its refresh is accepted. */
  const accepted = new Set<string>([token]);
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, FakeEntry>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  const log: string[] = [];
  const requests: FakeRequest[] = [];
  const gists: FakeGist[] = [];
  /** Answer a request yourself: return a Response, or undefined to let the fake answer. */
  const interceptors: ((req: FakeRequest) => Response | undefined | Promise<Response | undefined>)[] = [];
  /** Each runs once, inside the next PATCH ref, before the fast-forward check (a racing push). */
  const beforeUpdateRef: (() => Promise<unknown> | unknown)[] = [];
  /** Lets a test make "GitHub" store different bytes than it was sent. */
  let mangle: ((path: string, bytes: Uint8Array) => Uint8Array) | null = null;
  let counter = 0;
  let blobsInFlight = 0;
  let maxBlobsInFlight = 0;

  const hex = (text: string) => gitBlobSha(utf8.encode(text));
  const isAncestor = (ancestor: string | undefined, sha: string) => {
    if (ancestor === undefined) return false;
    const stack = [sha];
    const seen = new Set<string>();
    while (stack.length) {
      const s = stack.pop()!;
      if (s === ancestor) return true;
      if (seen.has(s) || !commits.has(s)) continue;
      seen.add(s);
      stack.push(...commits.get(s)!.parents);
    }
    return false;
  };
  async function putBlob(bytes: Uint8Array): Promise<string> {
    const sha = await gitBlobSha(bytes);
    blobs.set(sha, bytes.slice());
    return sha;
  }
  async function putTree(map: Map<string, FakeEntry>): Promise<string> {
    const sha = await hex("tree " + JSON.stringify([...map].sort()));
    trees.set(sha, map);
    return sha;
  }
  async function putCommit(tree: string, parents: string[], message: string): Promise<string> {
    const sha = await hex(`commit ${tree} ${parents.join(",")} ${message} ${++counter}`);
    commits.set(sha, { tree, parents, message });
    return sha;
  }
  function listing(map: Map<string, FakeEntry>, recursive: boolean) {
    const out: { path: string; mode: string; type: string; sha: string; size?: number }[] = [];
    const dirs = new Set<string>();
    for (const [p, e] of map) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (!recursive && parts.length > 1) continue;
      out.push(e.type === "blob" ? { path: p, mode: e.mode, type: "blob", sha: e.sha, size: blobs.get(e.sha)!.byteLength } : { path: p, mode: e.mode, type: "commit", sha: e.sha });
    }
    for (const d of dirs) if (recursive || !d.includes("/")) out.push({ path: d, mode: "040000", type: "tree", sha: "0".repeat(40) });
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  const headTree = () => {
    const ref = refs.get(`heads/${branch}`);
    return ref ? trees.get(commits.get(ref)!.tree)! : new Map<string, FakeEntry>();
  };
  const validTreePath = (p: unknown): p is string =>
    typeof p === "string" && p !== "" && !p.startsWith("/") && !p.endsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..");
  const isWorkflow = (p: string) => p.toLowerCase().startsWith(".github/workflows/");

  async function handle(req: FakeRequest): Promise<Response> {
    const { method, path, headers } = req;
    const body = req.body as Record<string, unknown> | undefined;
    const ref = refs.get(`heads/${branch}`) ?? null;
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "") {
      return json(200, { full_name: `${owner}/${repo}`, private: options.private ?? true, default_branch: branch, size: ref ? 1 : 0 });
    }
    if (method === "GET" && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const name = m[1]!.split("/").map(decodeURIComponent).join("/");
      if (!ref) return json(409, { message: "Git Repository is empty." });
      const target = refs.get(`heads/${name}`);
      if (!target) return json(404, { message: "Not Found" });
      const etag = `W/"${target}"`;
      if (headers.get("if-none-match") === etag) return json(304, null, { etag });
      return json(200, { ref: `refs/heads/${name}`, object: { sha: target, type: "commit" } }, { etag });
    }
    if (!ref && path.startsWith("/git/")) return json(409, { message: "Git Repository is empty." });
    if (method === "GET" && (m = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = commits.get(m[1]!);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^\/git\/trees\/([0-9a-f]{40})(\?recursive=1)?$/))) {
      const t = trees.get(m[1]!);
      return t ? json(200, { sha: m[1], truncated: false, tree: listing(t, m[2] !== undefined) }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const b = blobs.get(m[1]!);
      if (!b) return json(404, { message: "Not Found" });
      blobsInFlight++;
      maxBlobsInFlight = Math.max(maxBlobsInFlight, blobsInFlight);
      try {
        if (options.blobLatencyMs) await new Promise((r) => setTimeout(r, options.blobLatencyMs));
      } finally {
        blobsInFlight--;
      }
      // The raw media type gives the bytes; otherwise GitHub answers JSON with base64.
      if (headers.get("accept") === "application/vnd.github.raw+json") return new Response(b.slice(), { status: 200 });
      let binary = "";
      for (const byte of b) binary += String.fromCharCode(byte);
      return json(200, { sha: m[1], size: b.byteLength, encoding: "base64", content: btoa(binary) });
    }
    if (method === "GET" && (m = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=1$/))) {
      const [, a, b] = m as unknown as [string, string, string];
      if (!commits.has(a) || !commits.has(b)) return json(404, { message: "Not Found" });
      const status = a === b ? "identical" : isAncestor(a, b) ? "ahead" : isAncestor(b, a) ? "behind" : "diverged";
      return json(200, { status, commits: [] });
    }
    if (method === "POST" && path === "/git/blobs") {
      if (body?.encoding !== "base64" || typeof body.content !== "string") return json(422, { message: "Invalid request." });
      return json(201, { sha: await putBlob(fromBase64(body.content)) });
    }
    if (method === "POST" && path === "/git/trees") {
      const baseTree = body?.base_tree;
      const start = typeof baseTree === "string" ? trees.get(baseTree) : new Map<string, FakeEntry>();
      if (!start) return json(422, { message: "Invalid base_tree" });
      const next = new Map(start);
      const list = body?.tree;
      if (!Array.isArray(list)) return json(422, { message: "Invalid tree" });
      for (const raw of list as Record<string, unknown>[]) {
        const p = raw.path;
        if (!validTreePath(p)) return json(422, { message: "Invalid path" });
        if (options.workflowsWritable === false && isWorkflow(p)) {
          return json(404, { message: "Not Found" });
        }
        if ("sha" in raw && "content" in raw) return json(422, { message: "Use either sha or content" });
        const mode = raw.mode;
        if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") return json(422, { message: "Invalid mode" });
        if (raw.sha === null) {
          if (!next.has(p)) return json(422, { message: `path ${p} does not exist` });
          next.delete(p);
        } else if (typeof raw.content === "string") {
          let bytes: Uint8Array = utf8.encode(raw.content);
          if (mangle) bytes = mangle(p, bytes);
          next.set(p, { sha: await putBlob(bytes), mode, type: "blob" });
        } else if (typeof raw.sha === "string") {
          if (raw.type === "blob" && !blobs.has(raw.sha)) return json(422, { message: "sha not found" });
          next.set(p, { sha: raw.sha, mode, type: raw.type === "commit" ? "commit" : "blob" });
        } else return json(422, { message: "Invalid tree entry" });
      }
      for (const p of next.keys()) {
        for (let d = parentOf(p); d !== ""; d = parentOf(d)) if (next.has(d)) return json(422, { message: `tree has both ${d} and ${p}` });
      }
      return json(201, { sha: await putTree(next), truncated: false, tree: [] });
    }
    if (method === "POST" && path === "/git/commits") {
      const tree = body?.tree;
      const parents = body?.parents;
      if (typeof tree !== "string" || !trees.has(tree) || !Array.isArray(parents) || !parents.every((p) => typeof p === "string" && commits.has(p))) {
        return json(422, { message: "Invalid" });
      }
      return json(201, { sha: await putCommit(tree, parents as string[], String(body?.message ?? "")) });
    }
    if (method === "PATCH" && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const hook = beforeUpdateRef.shift();
      if (hook) await hook();
      const name = `heads/${m[1]!.split("/").map(decodeURIComponent).join("/")}`;
      const current = refs.get(name);
      const sha = body?.sha;
      if (typeof sha !== "string" || !commits.has(sha)) return json(422, { message: "Object does not exist" });
      if (current === undefined) return json(422, { message: "Reference does not exist" });
      if (body?.force !== false && body?.force !== undefined) return json(422, { message: "test fake: sync must never force" });
      if (!isAncestor(current, sha)) return json(422, { message: "Update is not a fast forward" });
      refs.set(name, sha);
      return json(200, { ref: `refs/${name}`, object: { sha, type: "commit" } });
    }
    if (method === "PUT" && (m = path.match(/^\/contents\/(.+)$/))) {
      const p = m[1]!.split("/").map(decodeURIComponent).join("/");
      if (typeof body?.content !== "string" || typeof body.message !== "string") return json(422, { message: "Invalid request." });
      const sha = await putBlob(fromBase64(body.content));
      const map = new Map(headTree());
      if (map.has(p)) return json(422, { message: '"sha" wasn\'t supplied.' });
      map.set(p, { sha, mode: "100644", type: "blob" });
      const commit = await putCommit(await putTree(map), ref ? [ref] : [], body.message);
      refs.set(`heads/${branch}`, commit);
      return json(201, { content: { path: p, sha }, commit: { sha: commit } });
    }
    return json(404, { message: "Not Found" });
  }

  /**
   * POST /gists, as documented: `files` (each with non-empty `content`), `description`, `public`.
   * 201 with id and html_url; GitHub refuses an empty file with 422.
   */
  function createGist(body: Record<string, unknown> | undefined): Response {
    if (options.gistsRefused === 403) return json(403, { message: "Resource not accessible by personal access token" });
    if (options.gistsRefused === 404) return json(404, { message: "Not Found" });
    const files = body?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return json(422, { message: "Invalid request." });
    const list = Object.entries(files as Record<string, unknown>);
    if (list.length === 0 || list.some(([, f]) => !f || typeof (f as { content?: unknown }).content !== "string" || (f as { content: string }).content === "")) {
      return json(422, { message: "Validation Failed" });
    }
    const id = `${++counter}`.padStart(32, "a");
    const gist: FakeGist = { id, description: body?.description, public: body?.public, files: files as FakeGist["files"] };
    gists.push(gist);
    return json(201, { id, html_url: `https://gist.github.com/${owner}/${id}`, public: gist.public === true, files: {} });
  }

  async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const prefix = `https://api.github.com/repos/${owner}/${repo}`;
    // POST /gists is the one address outside the repository; its path keeps the API root's form.
    // A query is accepted (and ignored), so a test can see what a request would have put in the URL.
    const gist = input.split("?")[0] === "https://api.github.com/gists";
    if (!gist && !input.startsWith(prefix)) throw new TypeError("test fake: unexpected URL");
    const path = gist ? "/gists" : input.slice(prefix.length);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const req: FakeRequest = { method, path, headers, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    log.push(`${method} ${path}`);
    for (const intercept of interceptors) {
      const answer = await intercept(req);
      if (answer) return answer;
    }
    const bearer = headers.get("authorization") ?? "";
    if (!bearer.startsWith("Bearer ") || !accepted.has(bearer.slice(7))) return json(401, { message: "Bad credentials" });
    if (headers.get("x-github-api-version") !== "2026-03-10") return json(400, { message: "Unsupported API version" });
    if (gist) return method === "POST" ? createGist(req.body as Record<string, unknown> | undefined) : json(404, { message: "Not Found" });
    return handle(req);
  }

  function entryFor(change: Exclude<RemoteChange, null>): Promise<FakeEntry> | FakeEntry {
    if (typeof change === "string") return putBlob(utf8.encode(change)).then((sha) => ({ sha, mode: "100644", type: "blob" as const }));
    if (change instanceof Uint8Array) return putBlob(change).then((sha) => ({ sha, mode: "100644", type: "blob" as const }));
    if (change.submodule) return { sha: change.submodule, mode: "160000", type: "commit" };
    const bytes = change.bytes ?? utf8.encode(change.text ?? "");
    return putBlob(bytes).then((sha) => ({ sha, mode: change.mode ?? "100644", type: "blob" as const }));
  }

  /**
   * Simulates a change made on github.com (or by another machine) directly in the repository.
   * Paths are taken as they are, unchecked, so tests can plant names ExecFlow must ignore.
   * `root: true` makes a commit with no parents (a rewritten history).
   */
  async function remoteCommit(changes: Record<string, RemoteChange>, opts: { root?: boolean; message?: string } = {}): Promise<string> {
    const ref = refs.get(`heads/${branch}`);
    const map = new Map(headTree());
    for (const [p, change] of Object.entries(changes)) {
      if (change === null) map.delete(p);
      else map.set(p, await entryFor(change));
    }
    const commit = await putCommit(await putTree(map), ref && !opts.root ? [ref] : [], opts.message ?? "web edit");
    refs.set(`heads/${branch}`, commit);
    return commit;
  }

  /** The branch's files: text decoded leniently (for assertions), keyed by path. */
  function files(): Record<string, string> {
    const out: Record<string, string> = {};
    const map = headTree();
    for (const p of [...map.keys()].sort()) {
      const e = map.get(p)!;
      out[p] = e.type === "commit" ? `<submodule ${e.sha}>` : new TextDecoder("utf-8", { ignoreBOM: true }).decode(blobs.get(e.sha)!);
    }
    return out;
  }

  return {
    owner,
    repo,
    branch,
    token,
    fetch,
    log,
    requests,
    gists,
    interceptors,
    beforeUpdateRef,
    refs,
    commits,
    remoteCommit,
    files,
    /** Entries of the branch head (path -> sha, mode, type). */
    entries: () => new Map(headTree()),
    bytesAt: (p: string) => {
      const e = headTree().get(p);
      return e && e.type === "blob" ? blobs.get(e.sha)!.slice() : undefined;
    },
    head: () => refs.get(`heads/${branch}`) ?? null,
    setMangle(fn: ((path: string, bytes: Uint8Array) => Uint8Array) | null) {
      mangle = fn;
    },
    get maxBlobsInFlight() {
      return maxBlobsInFlight;
    },
    writes: () => log.filter((l) => !l.startsWith("GET")),
    acceptToken: (t: string) => void accepted.add(t),
    rejectToken: (t: string) => void accepted.delete(t),
  };
}

/** Exact bytes of a text file, as sync stores it. */
export const fileBytes = (text: string, eol: Eol = "\n", bom = false) => encodeFileBytes(text, eol, bom);
