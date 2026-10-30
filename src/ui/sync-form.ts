// Small pure helpers for the Connect dialog: reading what the user typed or pasted for the
// repository, checking names before anything is sent, the token page link, and a device label.

/** GitHub account names (src/sync/github.ts uses the same rules before it builds any URL). */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new";

/**
 * Splits "owner/repo", "github.com/owner/repo" or a full clone URL ("https://github.com/owner/repo.git")
 * into its parts. Returns null for anything else (then the text is just an owner name).
 */
export function parseRepoInput(text: string): { owner: string; repo: string } | null {
  let s = text.trim();
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = s.split("/");
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function ownerProblem(owner: string): string | null {
  if (!owner) return "Enter the account or organisation that owns the repository.";
  if (!OWNER.test(owner)) return "An account name has only letters, digits and hyphens (not first), and at most 39 characters.";
  return null;
}

export function repoProblem(repo: string): string | null {
  if (!repo) return "Enter the repository's name.";
  if (!REPO.test(repo) || repo === "." || repo === "..") return "A repository name has only letters, digits, dots, hyphens and underscores.";
  return null;
}

/** git check-ref-format, the parts that matter for a typed branch name (empty = the default branch). */
export function branchProblem(branch: string): string | null {
  if (!branch) return null;
  const bad =
    branch.length > 250 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.split("/").some((part) => part.startsWith(".")) ||
    [...branch].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f || "~^:?*[\\".includes(ch));
  return bad ? "This isn't a valid branch name. Leave it empty to use the repository's default branch." : null;
}

/**
 * GitHub's new fine-grained token page, filled in as far as its documented URL parameters go:
 * a name, the owner, Contents read and write, 90 days. The repository itself is picked on the page.
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 */
export function tokenPageUrl(owner: string, repo: string): string {
  const url = new URL(TOKEN_PAGE);
  const validRepo = repoProblem(repo) === null;
  url.searchParams.set("name", `ExecFlow ${validRepo ? repo : "sync"}`.slice(0, 40));
  url.searchParams.set("description", "ExecFlow sync for one repository: Contents read and write.");
  if (ownerProblem(owner) === null) url.searchParams.set("target_name", owner);
  url.searchParams.set("expires_in", "90");
  url.searchParams.set("contents", "write");
  return url.href;
}

/** "Firefox on Windows": shown in the commit messages a sync makes. */
export function deviceName(ua: string, platform: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /Windows/i.test(ua + platform)
    ? "Windows"
    : /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/i.test(ua + platform)
        ? "iOS"
        : /Mac/i.test(ua + platform)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/i.test(ua + platform)
              ? "Linux"
              : "";
  return os ? `${browser} on ${os}` : browser;
}
