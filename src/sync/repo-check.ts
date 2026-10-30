// Checks a freshly entered token against its repository, and turns sync errors into one plain
// sentence for the UI. No message ever contains the token (GitHubError messages are already
// cleaned, and these sentences are fixed text).

import { SyncError } from "./engine";
import { GitHubError, type GitHubClient, type GitHubOp } from "./github";

export type AccessResult =
  | { ok: true; private: boolean; defaultBranch: string }
  | { ok: false; reason: string };

/**
 * Reads the repository with the token (GET /repos/{owner}/{repo}). A public repository is still
 * ok: the caller warns, because student code is meant to stay private. Write access can't be
 * tested without writing; the first sync reports it if it is missing.
 */
export async function checkAccess(client: GitHubClient, auth: AuthKind = "pat"): Promise<AccessResult> {
  try {
    const repo = await client.getRepo();
    return { ok: true, private: repo.private, defaultBranch: repo.defaultBranch };
  } catch (error) {
    return { ok: false, reason: explainError(error, auth) };
  }
}

/** How the connection was made: a pasted token, or "Sign in with GitHub" (a GitHub App). */
export type AuthKind = "pat" | "app";

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** Requests that only read from GitHub: when one is refused, nothing was ever going to be saved. */
const READS: ReadonlySet<GitHubOp> = new Set<GitHubOp>(["getRepo", "getRef", "getCommit", "getTree", "getBlob", "compare", "getUser", "listInstallations", "listRepos"]);

/** One plain sentence explaining why GitHub access or a sync failed. */
export function explainError(error: unknown, auth: AuthKind = "pat"): string {
  if (error instanceof SyncError) return error.message;
  if (!(error instanceof GitHubError)) return "Something went wrong while talking to GitHub, so try again.";
  if (auth === "app") {
    if (error.kind === "auth") return "Your GitHub sign-in has ended or was revoked, so sign in again. Your files here are kept and sync once you're back.";
    if (error.kind === "forbidden" || (error.kind === "not-found" && error.op !== "getRef")) {
      return "ExecFlow isn't allowed in this repository any more: sign in again and choose it on GitHub.";
    }
    if (error.via === "sign-in") {
      return error.kind === "network"
        ? "ExecFlow couldn't reach its sign-in service to renew your GitHub sign-in, so check the internet connection and try again."
        : "ExecFlow's sign-in service couldn't renew your GitHub sign-in just now, so try again in a few minutes; your files here are unchanged.";
    }
  }
  switch (error.kind) {
    case "auth":
      return "GitHub didn't accept this token: it may be mistyped, expired or revoked, so create a new one and paste it here.";
    case "forbidden":
      return 'This token can\'t see or write this repository: in the token\'s settings, check that "Only select repositories" includes it and that Contents is set to "Read and write".';
    case "not-found":
      return error.op === "getRef"
        ? "This branch doesn't exist in the repository, so pick the branch to sync with again."
        : 'GitHub can\'t find this repository with this token: check the owner and name, and that the token\'s "Only select repositories" list includes it.';
    case "conflict":
      return "GitHub reported a conflict (the repository may be empty or busy), so try again in a moment.";
    case "ref-rejected":
      return "Someone else changed the repository at the same moment, so sync again.";
    case "validation":
      return READS.has(error.op)
        ? "GitHub refused this request as invalid, so check the owner, repository and branch, then try again."
        : "GitHub refused the change as invalid, so nothing was saved there; your files here are unchanged.";
    case "rate-limit": {
      const n = minutes(error.retryAfterMs ?? 60_000);
      return `GitHub is limiting requests from this token for now, so try again in ${n} minute${n === 1 ? "" : "s"}.`;
    }
    case "server":
      return "GitHub had a problem answering, so try again in a few minutes; your files here are unchanged.";
    case "network":
      return "ExecFlow couldn't reach GitHub, so check the internet connection and try again.";
  }
}
