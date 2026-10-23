import { describe, expect, it } from "vitest";
import { SyncError } from "./engine";
import { GitHubError, createClient } from "./github";
import { checkAccess, explainError } from "./repo-check";
import { TEST_TOKEN, createFakeGitHub } from "./test-helpers";

const noSleep = async () => undefined;
const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  createClient({
    token: TEST_TOKEN,
    owner: "me",
    repo: "workspace",
    sleep: noSleep,
    fetch: async () => new Response(JSON.stringify(body), { status, headers }),
  });

describe("checkAccess", () => {
  it("reports a private repository and its default branch", async () => {
    const gh = createFakeGitHub({ branch: "trunk" });
    const client = createClient({ token: gh.token, owner: gh.owner, repo: gh.repo, fetch: gh.fetch, sleep: noSleep });
    expect(await checkAccess(client)).toEqual({ ok: true, private: true, defaultBranch: "trunk" });
  });

  it("reports a public repository so the UI can warn", async () => {
    const gh = createFakeGitHub({ private: false });
    const client = createClient({ token: gh.token, owner: gh.owner, repo: gh.repo, fetch: gh.fetch, sleep: noSleep });
    expect(await checkAccess(client)).toMatchObject({ ok: true, private: false });
  });

  it("explains each failure in one plain sentence without the token", async () => {
    const cases: [number, Record<string, string>, RegExp][] = [
      [401, {}, /didn't accept this token/],
      [403, {}, /Only select repositories/],
      [404, {}, /can't find this repository/],
      [403, { "retry-after": "120" }, /try again in 2 minutes/],
      [500, {}, /GitHub had a problem/],
    ];
    for (const [status, headers, pattern] of cases) {
      const result = await checkAccess(answering(status, { message: `nope ${TEST_TOKEN}` }, headers));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toMatch(pattern);
      expect(result.reason).not.toContain(TEST_TOKEN);
      expect(result.reason.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length).toBe(1);
    }
    const offline = createClient({
      token: TEST_TOKEN,
      owner: "me",
      repo: "workspace",
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await checkAccess(offline)).toEqual({ ok: false, reason: expect.stringMatching(/couldn't reach GitHub/) });
  });
});

describe("explainError", () => {
  it("covers every error kind", () => {
    const kinds = ["auth", "forbidden", "not-found", "conflict", "ref-rejected", "validation", "rate-limit", "server", "network"] as const;
    const texts = kinds.map((k) => explainError(new GitHubError(k, 0, "getTree", "x")));
    expect(new Set(texts).size).toBe(kinds.length);
    expect(explainError(new GitHubError("not-found", 404, "getRef", "x"))).toMatch(/branch doesn't exist/);
    expect(explainError(new GitHubError("rate-limit", 429, "getRef", "x", 30_000))).toMatch(/1 minute\./);
    expect(explainError(new SyncError("remote-moving", "Exactly this."))).toBe("Exactly this.");
    expect(explainError(new Error(TEST_TOKEN))).not.toContain(TEST_TOKEN);
  });

  it("words a refused read (422 on getRepo or getRef) as a read: it never says that nothing was saved (plan-v2 P5)", () => {
    const read = "GitHub refused this request as invalid, so check the owner, repository and branch, then try again.";
    for (const op of ["getRepo", "getRef", "getCommit", "getTree", "getBlob", "compare"] as const) {
      const text = explainError(new GitHubError("validation", 422, op, "x"));
      expect(text, op).toBe(read);
      expect(text, op).not.toMatch(/saved/);
    }
    for (const op of ["createBlob", "createTree", "createCommit", "putFile"] as const) {
      expect(explainError(new GitHubError("validation", 422, op, "x")), op).toBe("GitHub refused the change as invalid, so nothing was saved there; your files here are unchanged.");
    }
  });

  it("reports a 422 to the repository read through checkAccess with the read sentence", async () => {
    const result = await checkAccess(answering(422, { message: "Validation Failed" }));
    expect(result).toEqual({ ok: false, reason: "GitHub refused this request as invalid, so check the owner, repository and branch, then try again." });
  });
});
