import { describe, expect, it } from "vitest";
import { API_VERSION, createClient, GitHubError } from "./github";
import {
  explainGistError, gistPageUrl, gistRefusal, gistRequest, GIST_MAX_BYTES, refusalText, repoAudience, repoFileUrl, repoLinkState,
} from "./share";
import { createFakeGitHub, TEST_TOKEN } from "./test-helpers";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BLOB = "b".repeat(40);
const noSleep = async () => undefined;

describe("repoFileUrl", () => {
  it("pins the file to the commit, under blob/", () => {
    expect(repoFileUrl("me", "workspace", SHA, "main.py")).toBe(`https://github.com/me/workspace/blob/${SHA}/main.py`);
  });

  it("keeps folders as path segments and encodes each segment on its own", () => {
    expect(repoFileUrl("me", "workspace", SHA, "week 1/lab #2/a?b.py")).toBe(`https://github.com/me/workspace/blob/${SHA}/week%201/lab%20%232/a%3Fb.py`);
  });

  it("encodes % and non-ASCII names (UTF-8), so the URL parser reads them back as the same name", () => {
    const name = `100%${String.fromCodePoint(0xe9)}t${String.fromCodePoint(0x1f600)}.py`;
    const url = repoFileUrl("me", "workspace", SHA, `notes/${name}`);
    expect(url).toBe(`https://github.com/me/workspace/blob/${SHA}/notes/100%25%C3%A9t%F0%9F%98%80.py`);
    const parsed = new URL(url);
    expect(parsed.hash).toBe("");
    expect(parsed.search).toBe("");
    expect(decodeURIComponent(parsed.pathname.split("/").at(-1)!)).toBe(name);
  });

  it("refuses names that would reach another page", () => {
    for (const bad of ["", "a//b.py", "../x.py", "a/./b.py", "a/"]) expect(() => repoFileUrl("me", "workspace", SHA, bad)).toThrow(TypeError);
    expect(() => repoFileUrl("me", "workspace", "main", "a.py")).toThrow(TypeError);
    expect(() => repoFileUrl("me/x", "workspace", SHA, "a.py")).toThrow(TypeError);
    expect(() => repoFileUrl("me", "..", SHA, "a.py")).toThrow(TypeError);
  });
});

describe("attacker pass: paths, names and ids that try to leave the blob URL", () => {
  const prefix = `https://github.com/me/workspace/blob/${SHA}/`;
  /** The URL parser reads it back unchanged, on github.com, under the pinned blob, with one segment per path segment. */
  function staysInside(path: string) {
    const url = repoFileUrl("me", "workspace", SHA, path);
    const parsed = new URL(url);
    expect(parsed.href, path).toBe(url);
    expect(parsed.origin).toBe("https://github.com");
    expect(url.startsWith(prefix), path).toBe(true);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    const segments = url.slice(prefix.length).split("/");
    expect(segments.map(decodeURIComponent), path).toEqual(path.split("/"));
  }

  it("encoded dots, #, ?, backslashes and lookalike slashes stay inside one segment", () => {
    for (const path of [
      "%2e%2e/x.py", "%2E%2E", ".%2e/x.py", "a/%2f/b.py", "a#b.py", "a?b=c.py", "a\\..\\b.py", "\\\\evil.example\\x.py",
      `a${String.fromCodePoint(0x2215)}..${String.fromCodePoint(0x2215)}b.py`, `a${String.fromCodePoint(0xff0f)}b.py`,
      `${String.fromCodePoint(0x2025)}/x.py`, "...", "a..b/c.py", "@evil.example/x.py", "javascript:alert(1)",
    ]) staysInside(path);
  });

  it("empty, '.', '..', a leading or doubled '/' are refused, never resolved", () => {
    for (const path of ["/x.py", "//evil.example/x.py", "a//b.py", "../x.py", "a/../../x.py", "./x.py", "a/.", "x.py/"]) {
      expect(() => repoFileUrl("me", "workspace", SHA, path), path).toThrow(TypeError);
    }
  });

  it("a hostile owner, repository or commit from a stored connection is refused", () => {
    for (const [owner, repo, commit] of [
      ["evil.example/x", "workspace", SHA], ["me@evil.example", "workspace", SHA], ["-me", "workspace", SHA], ["", "workspace", SHA],
      ["me", "x/../../y", SHA], ["me", "work space", SHA], ["me", ".", SHA], ["me", "workspace", "../../../evil"],
      ["me", "workspace", SHA.toUpperCase()], ["me", "workspace", `${SHA}/x`],
    ]) expect(() => repoFileUrl(owner, repo, commit, "a.py"), `${owner} ${repo} ${commit}`).toThrow(TypeError);
  });

  it("repoLinkState turns a link it can't build safely into 'invalid', not an exception", () => {
    expect(repoLinkState({ owner: "me", repo: "workspace", commit: "../../evil", path: "a.py", localSha: BLOB, baseSha: BLOB })).toEqual({ kind: "invalid" });
    expect(repoLinkState({ owner: "evil.example/x", repo: "workspace", commit: SHA, path: "a.py", localSha: BLOB, baseSha: BLOB })).toEqual({ kind: "invalid" });
  });
});

describe("repoLinkState", () => {
  const base = { owner: "me", repo: "workspace", commit: SHA, path: "main.py", localSha: BLOB, baseSha: BLOB };
  it("offers the link only when the file here is the synced one", () => {
    expect(repoLinkState(base)).toEqual({ kind: "ready", url: `https://github.com/me/workspace/blob/${SHA}/main.py` });
    expect(repoLinkState({ ...base, localSha: "c".repeat(40) })).toEqual({ kind: "changed" });
    // A sha still being computed is not proof of "unchanged".
    expect(repoLinkState({ ...base, localSha: null })).toEqual({ kind: "changed" });
  });
  it("a file never synced, or a workspace that never synced, has no link yet", () => {
    expect(repoLinkState({ ...base, baseSha: null })).toEqual({ kind: "new" });
    expect(repoLinkState({ ...base, commit: null })).toEqual({ kind: "new" });
  });
});

describe("gistRefusal", () => {
  it("refuses opaque, empty and oversized files before anything is sent", () => {
    expect(gistRefusal({ opaque: true, text: null })).toEqual({ kind: "opaque" });
    expect(gistRefusal({ opaque: false, text: " \n\n" })).toEqual({ kind: "empty" });
    expect(gistRefusal({ opaque: false, text: "x".repeat(GIST_MAX_BYTES) })).toBeNull();
    expect(gistRefusal({ opaque: false, text: "x".repeat(GIST_MAX_BYTES + 1) })).toEqual({ kind: "too-big", bytes: GIST_MAX_BYTES + 1 });
    // Counted in UTF-8 bytes, not characters.
    const e = String.fromCodePoint(0xe9);
    expect(gistRefusal({ opaque: false, text: e.repeat(GIST_MAX_BYTES / 2 + 1) })).toEqual({ kind: "too-big", bytes: GIST_MAX_BYTES + 2 });
  });
  it("says what to do instead", () => {
    expect(refusalText({ kind: "too-big", bytes: 600 * 1024 }, "lab/big.py")).toBe("big.py is 600 KB; a gist from CodeEditor holds at most 512 KB. Share the repository link instead.");
    expect(refusalText({ kind: "opaque" }, "logo.png")).toContain("repository link");
  });
});

describe("repoAudience (security review, finding 1)", () => {
  it("promises the collaborators only when the repository is known to be private", () => {
    expect(repoAudience("me/workspace", true)).toEqual({
      visibility: "private",
      text: "Opens on GitHub only for you and the collaborators of me/workspace. It shows the file as last synced.",
    });
  });

  it("says anyone can open it when the repository is public", () => {
    expect(repoAudience("me/workspace", false)).toEqual({
      visibility: "public",
      text: "me/workspace is public, so anyone can open this link, signed in or not. It shows the file as last synced.",
    });
  });

  it("promises nothing when the visibility isn't known", () => {
    const a = repoAudience("me/workspace", null);
    expect(a).toEqual({
      visibility: "unknown",
      text: "CodeEditor couldn't check whether me/workspace is private. If it is public, anyone can open this link. It shows the file as last synced.",
    });
    expect(a.text).not.toContain("collaborators");
  });
});

describe("gistRequest", () => {
  it("is one secret file named after the file, with only its name in the description", () => {
    expect(gistRequest("week 1/main.py", "print(1)\n")).toEqual({
      description: "main.py, shared from CodeEditor",
      public: false,
      files: { "main.py": { content: "print(1)\n" } },
    });
  });

  it("never puts the folders in the description, and cleans the name (security review, finding 3)", () => {
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    const path = "students/Priya Sharma 2510370000/private" + cp(0x2028) + "notes/q2.c";
    const body = gistRequest(path, "int main(void){return 0;}\n");
    expect(body.description).toBe("q2.c, shared from CodeEditor");
    expect(body.description).not.toContain("Priya");
    expect(gistRequest("lab/q" + cp(0x202e, 0x200b, 0xfe0f) + "2.c", "x\n").description).toBe("q2.c, shared from CodeEditor");
    expect(gistRequest("a" + cp(10) + "b.py", "x\n").description).toBe("a b.py, shared from CodeEditor");
  });

  it("goes to POST https://api.github.com/gists with the sync headers, the content only in the body", async () => {
    const gh = createFakeGitHub();
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: (url, init) => (seen.push({ url, init }), gh.fetch(url, init)) });
    const marker = "SECRET_CONTENT_MARKER_42";
    const out = await client.createGist(gistRequest("main.py", `print("${marker}")\n`));
    expect(out.htmlUrl).toMatch(/^https:\/\/gist\.github\.com\/me\/[0-9a-z]+$/);
    expect(seen).toHaveLength(1);
    const [{ url, init }] = seen;
    expect(url).toBe("https://api.github.com/gists");
    expect(url).not.toContain(marker);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers.get("x-github-api-version")).toBe(API_VERSION);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(JSON.parse(String(init.body))).toEqual({ description: "main.py, shared from CodeEditor", public: false, files: { "main.py": { content: `print("${marker}")\n` } } });
    expect(gh.gists).toHaveLength(1);
    expect(gh.gists[0].public).toBe(false);
  });

  it("a request cancelled while it waits in the write queue is never sent (security review, finding 2)", async () => {
    const gh = createFakeGitHub();
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const client = createClient({
      token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep,
      fetch: async (url, init) => {
        seen.push(`${init?.method ?? "GET"} ${url}`);
        // The sync's write ahead of it is slow (a delayed POST /git/trees).
        if (url.endsWith("/git/blobs")) await held;
        return gh.fetch(url, init);
      },
    });
    const ahead = client.createBlob(new TextEncoder().encode("b\n")).catch(() => undefined);
    const cancel = new AbortController();
    const gist = client.createGist(gistRequest("main.py", "print(1)\n"), cancel.signal);
    cancel.abort();
    release();
    await ahead;
    await expect(gist).rejects.toBe(cancel.signal.reason);
    expect(seen.filter((s) => s.includes("/gists"))).toEqual([]);
    expect(gh.gists).toEqual([]);
  });

  it("an already-cancelled request sends nothing; an uncancelled one is sent", async () => {
    const gh = createFakeGitHub();
    const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: gh.fetch });
    const done = new AbortController();
    done.abort();
    await expect(client.createGist(gistRequest("a.py", "1\n"), done.signal)).rejects.toBe(done.signal.reason);
    expect(gh.gists).toEqual([]);
    await client.createGist(gistRequest("a.py", "1\n"), new AbortController().signal);
    expect(gh.gists).toHaveLength(1);
  });

  it("never sends public: true, whatever the caller passes", async () => {
    const gh = createFakeGitHub();
    const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: gh.fetch });
    await client.createGist({ ...gistRequest("a.py", "1\n"), public: true } as unknown as ReturnType<typeof gistRequest>);
    expect(gh.gists[0].public).toBe(false);
  });

  it("classifies a token without the gist permission, and explains it per connection kind", async () => {
    for (const status of [403, 404] as const) {
      const gh = createFakeGitHub({ gistsRefused: status });
      const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: gh.fetch });
      const error = await client.createGist(gistRequest("a.py", "1\n")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubError);
      expect((error as GitHubError).kind).toBe(status === 403 ? "forbidden" : "not-found");
      expect(explainGistError(error, "pat")).toContain('"Gists" set to "Read and write"');
      expect(explainGistError(error, "pat")).toContain('"gist" scope');
      expect(explainGistError(error, "app")).toContain('"Gists: Read and write"');
      expect(gh.gists).toHaveLength(0);
    }
  });

  it("explains a rate limit, a server error and no connection", () => {
    expect(explainGistError(new GitHubError("rate-limit", 403, "createGist", "x", 120_000), "pat")).toContain("try again in 2 minutes");
    expect(explainGistError(new GitHubError("server", 502, "createGist", "x"), "pat")).toContain("Your gists");
    expect(explainGistError(new GitHubError("network", 0, "createGist", "x"), "pat")).toContain("internet connection");
    expect(explainGistError(new GitHubError("validation", 422, "createGist", "x"), "pat")).toBe("GitHub refused the gist as invalid, so nothing was shared.");
  });

  it("an answer without an id or html_url is a server error, not a link", async () => {
    const client = createClient({
      token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep,
      fetch: async () => new Response(JSON.stringify({ id: "1" }), { status: 201, headers: { "content-type": "application/json" } }),
    });
    await expect(client.createGist(gistRequest("a.py", "1\n"))).rejects.toMatchObject({ kind: "server", op: "createGist" });
  });
});

describe("gistPageUrl", () => {
  it("shows only https pages on gist.github.com", () => {
    expect(gistPageUrl("https://gist.github.com/me/abc123")).toBe("https://gist.github.com/me/abc123");
    for (const bad of [
      "http://gist.github.com/me/abc",
      "https://gist.github.com.evil.example/me/abc",
      "https://evil.example/https://gist.github.com/",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:pw@gist.github.com/me/abc",
      "https://gist.github.com:8443/me/abc",
      "https://gist.github.com/",
      "//gist.github.com/me/abc",
      42,
      null,
    ]) expect(gistPageUrl(bad), String(bad)).toBeNull();
  });

  it("attacker pass: lookalike and tricky hosts, other schemes, and an oversized address are refused", () => {
    for (const bad of [
      "https://gist.github.com./me/abc",
      "https://gist.github.com@evil.example/me/abc",
      "https://evil.example#https://gist.github.com/me/abc",
      "https:\\\\evil.example/me/abc",
      `https://gist.g${String.fromCodePoint(0x456)}thub.com/me/abc`,
      "https://GIST.github.com.evil.example/me",
      "https://github.com/me/abc",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      " javascript:alert(1)",
      "https://gist.github.com/" + "a".repeat(3000),
      "",
    ]) expect(gistPageUrl(bad), bad.slice(0, 60)).toBeNull();
    // Upper case and a trailing path are fine: the parser lowers the host.
    expect(gistPageUrl("https://GIST.GITHUB.COM/me/abc")).toBe("https://gist.github.com/me/abc");
  });
});

describe("attacker pass: gist answers", () => {
  const answering = (status: number, body: string) =>
    createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }) });

  it("a malformed or hostile 201 is a server error, never a link", async () => {
    for (const body of ["not json", "[]", "null", '{"id":42,"html_url":"https://gist.github.com/me/a"}', '{"id":"","html_url":"https://gist.github.com/me/a"}', '{"id":"a","html_url":{"x":1}}']) {
      await expect(answering(201, body).createGist(gistRequest("a.py", "1\n")), body).rejects.toMatchObject({ kind: "server", op: "createGist" });
    }
  });

  it("a huge answer is read without crashing and its address checked like any other", async () => {
    const out = await answering(201, JSON.stringify({ id: "a", html_url: `https://gist.github.com/${"x".repeat(2_000_000)}`, files: { "a.py": { content: "y".repeat(1_000_000) } } })).createGist(gistRequest("a.py", "1\n"));
    expect(gistPageUrl(out.htmlUrl)).toBeNull();
  });

  it("a 401 stops the client for good: no second request with a token GitHub refused", async () => {
    let calls = 0;
    const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", sleep: noSleep, fetch: async () => (calls++, new Response('{"message":"Bad credentials"}', { status: 401 })) });
    await expect(client.createGist(gistRequest("a.py", "1\n"))).rejects.toMatchObject({ kind: "auth" });
    await expect(client.createGist(gistRequest("a.py", "1\n"))).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
    expect(client.tokenRejected).toBe(true);
    expect(explainGistError(new GitHubError("auth", 401, "createGist", "x"), "pat")).toContain("didn't accept this token");
  });

  it("GitHub's error text with the token in it never reaches a message", async () => {
    const client = answering(422, JSON.stringify({ message: `Validation Failed for ${TEST_TOKEN}` }));
    const error = (await client.createGist(gistRequest("a.py", "1\n")).catch((e: unknown) => e)) as GitHubError;
    expect(error.message).not.toContain(TEST_TOKEN);
    expect(explainGistError(error, "pat")).toBe("GitHub refused the gist as invalid, so nothing was shared.");
    expect(explainGistError(new Error("boom"), "pat")).toContain("no gist was made");
  });
});
