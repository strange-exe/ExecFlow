// Share link (the "Share link..." dialog, src/ui/share-dialog.ts): the two links a student can
// share, built here as plain functions so the rules are tested apart from the page.
// 1. The file on GitHub at the commit that holds its synced content:
//    https://github.com/{owner}/{repo}/blob/{commit}/{path}, each path segment URL-encoded. It opens
//    only for people who can read the repository (private: the owner and its collaborators).
// 2. A copy of the file as a secret gist (POST /gists, public: false). GitHub's docs: secret gists
//    aren't private; anyone with the URL can open them; they aren't listed or searchable.
//    https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists
//    https://docs.github.com/en/rest/gists/gists#create-a-gist
// Nothing here talks to the network; file content goes only into the request body, never a URL.
import { nameOf } from "../core/paths";
import { GitHubError, type GistBody } from "./github";
import { explainError, type AuthKind } from "./repo-check";

/**
 * Largest file CodeEditor puts in a gist. GitHub's API cuts a gist file's content at 1 MB in its
 * answers (larger files need raw_url or a clone), so a shared copy stays well inside that.
 */
export const GIST_MAX_BYTES = 512 * 1024;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The file's page on GitHub at `commit`. Every path segment is encoded on its own (a space, #, ?
 * and % become %20, %23, %3F and %25; other characters their UTF-8 percent-escapes), so the URL
 * parser never reads part of a name as a query, a fragment or another folder.
 */
export function repoFileUrl(owner: string, repo: string, commit: string, path: string): string {
  if (!OWNER.test(owner)) throw new TypeError("share: not a GitHub account name");
  if (!REPO.test(repo) || repo === "." || repo === "..") throw new TypeError("share: not a repository name");
  if (!SHA.test(commit)) throw new TypeError("share: not a commit id");
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new TypeError("share: the path is empty or malformed");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${commit}/${segments.map(encodeURIComponent).join("/")}`;
}

/** Where the file stands against the repository, for the repository link. */
export type RepoLinkState =
  | { kind: "ready"; url: string }
  /** Never synced: the repository has no copy of it yet. */
  | { kind: "new" }
  /** Changed here since the last sync: a link would show an older version. */
  | { kind: "changed" }
  /** The connection or the path can't make a safe github.com address (repoFileUrl refused it). */
  | { kind: "invalid" };

/**
 * `localSha` is the file's blob id here, `baseSha` its blob id at the last sync (null: never
 * synced) and `commit` the commit this workspace last synced with. A link is offered only when
 * the file here is exactly the synced one, so it shows what the student sees.
 */
export function repoLinkState(o: { owner: string; repo: string; commit: string | null; path: string; localSha: string | null; baseSha: string | null }): RepoLinkState {
  if (o.commit === null || o.baseSha === null) return { kind: "new" };
  if (o.localSha !== o.baseSha) return { kind: "changed" };
  try {
    return { kind: "ready", url: repoFileUrl(o.owner, o.repo, o.commit, o.path) };
  } catch {
    // A stored connection or name that can't make a safe github.com address: no link at all.
    return { kind: "invalid" };
  }
}

/** Why a file can't go in a gist, checked before anything is sent. */
export type GistRefusal = { kind: "opaque" } | { kind: "empty" } | { kind: "too-big"; bytes: number };

export function gistRefusal(file: { opaque: boolean; text: string | null }): GistRefusal | null {
  if (file.opaque || file.text === null) return { kind: "opaque" };
  // GitHub refuses a gist file without content.
  if (file.text.trim() === "") return { kind: "empty" };
  const bytes = new TextEncoder().encode(file.text).byteLength;
  return bytes > GIST_MAX_BYTES ? { kind: "too-big", bytes } : null;
}

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

export function refusalText(r: GistRefusal, path: string): string {
  const name = nameOf(path);
  switch (r.kind) {
    case "opaque":
      return `${name} isn't a text file CodeEditor can edit, so it can't go in a gist. The repository link still works.`;
    case "empty":
      return `${name} is empty, and GitHub doesn't keep empty files in a gist.`;
    case "too-big":
      return `${name} is ${kb(r.bytes)}; a gist from CodeEditor holds at most ${kb(GIST_MAX_BYTES)}. Share the repository link instead.`;
  }
}

/** POST /gists: one secret file named after the file, the path in the description. */
export function gistRequest(path: string, text: string): GistBody {
  return { description: `${path}, shared from CodeEditor`, public: false, files: { [nameOf(path)]: { content: text } } };
}

const MAX_GIST_URL = 2048;

/**
 * The gist's page from GitHub's answer, only when it is an https page on gist.github.com (no user
 * name, password or port). Anything else is never shown as a link.
 */
export function gistPageUrl(value: unknown): string | null {
  // A real gist page is about 60 characters; anything this long isn't one.
  if (typeof value !== "string" || value.length > MAX_GIST_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "gist.github.com" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  return url.href;
}

/** What a token needs to create gists, by how this computer connected. */
export function gistPermissionText(auth: AuthKind): string {
  return auth === "app"
    ? 'Your GitHub sign-in can\'t create gists: the site\'s owner has to give CodeEditor\'s GitHub App the account permission "Gists: Read and write", and then you sign in again to approve it (Disconnect in Settings, then Sign in with GitHub). The repository link works without it.'
    : 'This token can\'t create gists: a fine-grained token needs the account permission "Gists" set to "Read and write", and a classic token the "gist" scope. The repository link works without it.';
}

/** One sentence for a failed POST /gists. Nothing was shared unless the answer was lost on the way. */
export function explainGistError(error: unknown, auth: AuthKind): string {
  if (!(error instanceof GitHubError)) return "Something went wrong while talking to GitHub, so no gist was made. Try again.";
  switch (error.kind) {
    case "forbidden":
    case "not-found":
      return gistPermissionText(auth);
    case "validation":
      return "GitHub refused the gist as invalid, so nothing was shared.";
    case "server":
    case "network":
      // The request may have reached GitHub before the answer was lost.
      return `${explainError(error, auth)} If GitHub did make the gist, it is under Your gists on GitHub.`;
    default:
      return explainError(error, auth);
  }
}
