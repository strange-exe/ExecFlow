// After signing in: who the student is and which repositories the app can reach for them
// (GET /user, GET /user/installations, GET /user/installations/{id}/repositories). A user token
// reaches a repository only when the app is installed on it AND the student can reach it.
// https://docs.github.com/en/rest/apps/installations
// https://docs.github.com/en/rest/users/users#get-the-authenticated-user
import { API_ROOT, API_VERSION, classify, GitHubError, REQUEST_TIMEOUT_MS, type GitHubOp } from "./github";

export interface ReachableRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
}

export interface Installation {
  id: number;
  account: string;
  /** GitHub's settings page for this installation (where the repository list is changed). */
  settingsUrl: string;
}

export interface Reach {
  login: string;
  installations: Installation[];
  repos: ReachableRepo[];
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const PER_PAGE = 100;
/** At most this many pages per installation (1,000 repositories): enough for any student. */
const MAX_PAGES = 10;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const field = (data: unknown, key: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined);

/** Only a github.com https page: anything else becomes GitHub's own installations page. */
function settingsUrl(value: unknown, id: number): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "") return url.href;
    } catch {
      // fall through
    }
  }
  return `https://github.com/settings/installations/${id}`;
}

export async function listReachable(token: string, fetchImpl: Fetch = (i, init) => globalThis.fetch(i, init)): Promise<Reach> {
  async function get(op: GitHubOp, path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(API_ROOT + path, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": API_VERSION },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubError("network", 0, op, "GitHub couldn't be reached");
    }
    // GitHub's own message text is left out: these errors are explained by kind (repo-check.ts).
    if (!res.ok) throw classify(op, res.status, res.headers);
    try {
      return await res.json();
    } catch {
      throw new GitHubError("server", res.status, op, "GitHub sent an answer ExecFlow couldn't read");
    }
  }
  const unreadable = (op: GitHubOp) => new GitHubError("server", 200, op, "GitHub sent an answer ExecFlow couldn't read");

  const user = await get("getUser", "/user");
  const login = field(user, "login");
  if (typeof login !== "string" || !OWNER.test(login)) throw unreadable("getUser");

  const installations: Installation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = field(await get("listInstallations", `/user/installations?per_page=${PER_PAGE}&page=${page}`), "installations");
    if (!Array.isArray(list)) throw unreadable("listInstallations");
    for (const item of list) {
      const id = field(item, "id");
      const account = field(field(item, "account"), "login");
      if (!isId(id) || typeof account !== "string" || !OWNER.test(account)) continue;
      installations.push({ id, account, settingsUrl: settingsUrl(field(item, "html_url"), id) });
    }
    if (list.length < PER_PAGE) break;
  }

  const repos: ReachableRepo[] = [];
  const seen = new Set<number>();
  for (const installation of installations) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = field(await get("listRepos", `/user/installations/${installation.id}/repositories?per_page=${PER_PAGE}&page=${page}`), "repositories");
      if (!Array.isArray(list)) throw unreadable("listRepos");
      for (const item of list) {
        const id = field(item, "id");
        const name = field(item, "name");
        const owner = field(field(item, "owner"), "login");
        const isPrivate = field(item, "private");
        const defaultBranch = field(item, "default_branch");
        if (!isId(id) || seen.has(id) || typeof name !== "string" || !REPO.test(name) || name === "." || name === "..") continue;
        if (typeof owner !== "string" || !OWNER.test(owner) || typeof isPrivate !== "boolean" || typeof defaultBranch !== "string" || defaultBranch === "") continue;
        seen.add(id);
        repos.push({ id, owner, name, private: isPrivate, defaultBranch, installationId: installation.id });
      }
      if (list.length < PER_PAGE) break;
    }
  }
  repos.sort((a, b) => `${a.owner}/${a.name}`.toLowerCase().localeCompare(`${b.owner}/${b.name}`.toLowerCase()));
  return { login, installations, repos };
}
