import { describe, expect, it } from "vitest";
import { API_VERSION, GitHubError, WRITE_GAP_MS, classify, createClient, toBase64, type GitHubClient } from "./github";
import { explainError } from "./repo-check";
import { TEST_TOKEN, createFakeGitHub } from "./test-helpers";

const h = (o: Record<string, string> = {}) => new Headers(o);
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const SHA = "a".repeat(40);
const noSleep = async () => undefined;

function clientWith(fetch: (input: string, init: RequestInit) => Promise<Response>, token = TEST_TOKEN): GitHubClient {
  return createClient({ token, owner: "me", repo: "workspace", fetch, sleep: noSleep });
}

describe("classify", () => {
  it("prototype: 401 auth, 403 permission vs rate limit, 422 on ref update", () => {
    const now = Date.now();
    expect(classify("getRepo", 401, h(), "Bad credentials").kind).toBe("auth");
    expect(classify("createTree", 403, h(), "Resource not accessible by personal access token").kind).toBe("forbidden");
    const rl = classify("getRepo", 403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now / 1000) + 30) }), "API rate limit exceeded", now);
    expect(rl.kind).toBe("rate-limit");
    expect(rl.retryAfterMs).toBeGreaterThan(25_000);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(classify("getRepo", 429, h({ "retry-after": "7" })).retryAfterMs).toBe(7000);
    expect(classify("updateRef", 422, h(), "Update is not a fast forward").kind).toBe("ref-rejected");
    expect(classify("getRef", 409, h(), "Git Repository is empty.").kind).toBe("conflict");
  });

  it("403 is a rate limit when its headers or GitHub's message say so; otherwise a missing permission", () => {
    expect(classify("createTree", 403, h({ "retry-after": "30" }), "You have exceeded a secondary rate limit").retryAfterMs).toBe(30_000);
    expect(classify("createTree", 403, h({ "x-ratelimit-remaining": "0" }), "").kind).toBe("rate-limit");
    // Review regression: GitHub's docs say a secondary limit answers 403 or 429 "and an error
    // message that indicates" it; retry-after and remaining: 0 are only "if present", and the
    // primary quota can still have requests left. Then wait at least one minute.
    expect(classify("createTree", 403, h({ "x-ratelimit-remaining": "4985" }), "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.")).toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 60_000,
    });
    expect(classify("createTree", 403, h({ "x-ratelimit-remaining": "4985" }), "Resource not accessible by personal access token").kind).toBe("forbidden");
    expect(classify("createTree", 403, h(), "").kind).toBe("forbidden");
    // 429 is a rate limit by definition; without headers wait the documented minute.
    expect(classify("getBlob", 429, h())).toMatchObject({ kind: "rate-limit", retryAfterMs: 60_000 });
    expect(classify("getBlob", 403, h({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), "", Date.parse("Wed, 21 Oct 2026 07:27:00 GMT")).retryAfterMs).toBe(60_000);
  });

  it("422 is a validation error except on updateRef; other statuses map by family", () => {
    expect(classify("createTree", 422, h()).kind).toBe("validation");
    expect(classify("createTree", 400, h()).kind).toBe("validation");
    expect(classify("getTree", 404, h()).kind).toBe("not-found");
    expect(classify("getTree", 410, h()).kind).toBe("not-found");
    expect(classify("getTree", 502, h()).kind).toBe("server");
  });
});

describe("requests", () => {
  it("send the documented headers and fetch options, and never put the token in a URL", async () => {
    const gh = createFakeGitHub();
    const client = clientWith(gh.fetch);
    await gh.remoteCommit({ "a.py": "1\n" });
    const head = gh.head()!;
    await client.getRepo();
    await client.getRef("main");
    const commit = await client.getCommit(head);
    await client.getTree(commit.tree);
    await client.createTree(commit.tree, [{ path: "b.py", mode: "100644", type: "blob", content: "2\n" }]);
    for (const req of gh.requests) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
      expect(req.headers.get("x-github-api-version")).toBe(API_VERSION);
      expect(req.headers.get("accept")).toBe("application/vnd.github+json");
      expect(req.init.cache).toBe("no-store");
      expect(req.init.credentials).toBe("omit");
      expect(req.init.signal).toBeInstanceOf(AbortSignal);
      expect(req.path.includes(TEST_TOKEN)).toBe(false);
    }
    const post = gh.requests.find((r) => r.method === "POST")!;
    expect(post.headers.get("content-type")).toBe("application/json");
  });

  it("read blobs as raw bytes", async () => {
    const gh = createFakeGitHub();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    await gh.remoteCommit({ "img.png": bytes });
    const client = clientWith(gh.fetch);
    const sha = gh.entries().get("img.png")!.sha;
    expect([...(await client.getBlob(sha))]).toEqual([...bytes]);
    expect(gh.requests.at(-1)!.headers.get("accept")).toBe("application/vnd.github.raw+json");
  });

  it("getRef: 304 is 'unchanged' and 409 is 'empty'", async () => {
    const gh = createFakeGitHub();
    const client = clientWith(gh.fetch);
    expect(await client.getRef("main")).toEqual({ state: "empty" });
    await gh.remoteCommit({ "a.py": "1\n" });
    const ref = await client.getRef("main");
    expect(ref.state).toBe("ok");
    if (ref.state !== "ok") return;
    expect(await client.getRef("main", ref.etag)).toEqual({ state: "unchanged" });
    expect(gh.requests.at(-1)!.headers.get("if-none-match")).toBe(ref.etag);
    await expect(client.getRef("dev")).rejects.toMatchObject({ kind: "not-found", op: "getRef" });
  });

  it("encode unusual paths per segment for the Contents API", async () => {
    const gh = createFakeGitHub();
    const client = clientWith(gh.fetch);
    const path = "my dir/h" + String.fromCodePoint(0xe9) + "llo #1?.py";
    await client.putFile(path, new TextEncoder().encode("x\n"), "first");
    expect(gh.files()).toEqual({ [path]: "x\n" });
  });

  it("base64 matches the platform for every byte value", () => {
    const all = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256);
    let binary = "";
    for (const b of all) binary += String.fromCharCode(b);
    expect(toBase64(all)).toBe(btoa(binary));
  });
});

describe("401 lockout", () => {
  it("prototype: 401 stops all further requests (failed-login lockout)", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls++;
      return reply(401, { message: "Bad credentials" });
    });
    await expect(client.getRepo()).rejects.toMatchObject({ kind: "auth" });
    await expect(client.getRepo()).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
    expect(client.tokenRejected).toBe(true);
  });

  it("covers writes and calls already queued behind the failing one", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls++;
      return reply(401, { message: "Bad credentials" });
    });
    const first = client.createCommit("m", SHA, []);
    const second = client.updateRef("main", SHA);
    await expect(first).rejects.toMatchObject({ kind: "auth" });
    await expect(second).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(client.getBlob(SHA)).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
  });
});

describe("write queue", () => {
  it("runs writes one at a time, at least 1 s apart", async () => {
    const waits: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = createClient({
      token: TEST_TOKEN,
      owner: "me",
      repo: "workspace",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async (_input, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return init.method === "PATCH" ? reply(200, { object: { sha: SHA } }) : reply(201, { sha: SHA });
      },
    });
    await Promise.all([client.createTree(null, []), client.createCommit("m", SHA, []), client.updateRef("main", SHA), client.createBlob(new Uint8Array([1]))]);
    expect(maxInFlight).toBe(1);
    expect(waits).toHaveLength(3);
    for (const w of waits) {
      expect(w).toBeGreaterThan(WRITE_GAP_MS - 50);
      expect(w).toBeLessThanOrEqual(WRITE_GAP_MS);
    }
  });

  it("keeps going after a failed write", async () => {
    let n = 0;
    const client = clientWith(async () => (++n === 1 ? reply(500, { message: "boom" }) : reply(201, { sha: SHA })));
    await expect(client.createTree(null, [])).rejects.toMatchObject({ kind: "server" });
    await expect(client.createTree(null, [])).resolves.toBe(SHA);
  });

  it("reads don't wait for writes", async () => {
    const gh = createFakeGitHub();
    await gh.remoteCommit({ "a.py": "1\n" });
    let release!: () => void;
    const client = createClient({ token: TEST_TOKEN, owner: "me", repo: "workspace", fetch: gh.fetch, sleep: () => new Promise<void>((r) => (release = r)) });
    const tree = gh.commits.get(gh.head()!)!.tree;
    await client.createTree(tree, []);
    const pending = client.createTree(tree, []); // waits for the 1 s gap
    await expect(client.getRepo()).resolves.toMatchObject({ defaultBranch: "main" });
    release();
    await pending;
  });
});

describe("the token never appears in an error", () => {
  const SECRET = TEST_TOKEN;
  const leaks = (e: unknown) => {
    const err = e as Error;
    const texts = [String(err), err.message, err.stack ?? "", JSON.stringify(err), JSON.stringify({ ...err }), explainError(err)];
    return texts.some((t) => t.includes(SECRET));
  };
  const statuses: [number, Record<string, string>][] = [
    [400, {}],
    [401, {}],
    [403, {}],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }],
    [403, { "retry-after": "5" }],
    [404, {}],
    [409, {}],
    [410, {}],
    [422, {}],
    [429, {}],
    [500, {}],
    [503, {}],
  ];
  const calls: [string, (c: GitHubClient) => Promise<unknown>][] = [
    ["getRepo", (c) => c.getRepo()],
    ["getRef", (c) => c.getRef("main", 'W/"x"')],
    ["getCommit", (c) => c.getCommit(SHA)],
    ["getTree", (c) => c.getTree(SHA)],
    ["getBlob", (c) => c.getBlob(SHA)],
    ["compare", (c) => c.compare(SHA, SHA)],
    ["createBlob", (c) => c.createBlob(new Uint8Array([1]))],
    ["createTree", (c) => c.createTree(SHA, [])],
    ["createCommit", (c) => c.createCommit("m", SHA, [SHA])],
    ["updateRef", (c) => c.updateRef("main", SHA)],
    ["putFile", (c) => c.putFile("a.py", new Uint8Array([1]), "m")],
  ];

  it.each(statuses)("HTTP %i answers that echo the token", async (status, headers) => {
    for (const [name, call] of calls) {
      const client = clientWith(async () => reply(status, { message: `Bad token ${SECRET} rejected`, documentation_url: SECRET }, headers));
      const error = await call(client).then(
        () => null,
        (e: unknown) => e,
      );
      if (status === 409 && name === "getRef") {
        expect(error).toBeNull(); // an empty repository, not an error
        continue;
      }
      expect(error, name).toBeInstanceOf(GitHubError);
      expect(leaks(error), `${name} ${status}`).toBe(false);
      expect((error as GitHubError).message).toContain("[token]");
    }
  });

  it("network failures, timeouts, unreadable and unexpected answers", async () => {
    const failures: (() => Promise<Response>)[] = [
      async () => {
        throw new TypeError(`fetch failed: Authorization: Bearer ${SECRET}`);
      },
      async () => {
        throw new DOMException(`timed out ${SECRET}`, "TimeoutError");
      },
      async () => {
        throw new DOMException(`aborted ${SECRET}`, "AbortError");
      },
      async () => new Response(`not json ${SECRET}`, { status: 200 }),
      async () => new Response(`<html>${SECRET}</html>`, { status: 502 }),
      async () => reply(200, { sha: SECRET, object: { sha: SECRET }, tree: SECRET, status: SECRET }),
      async () => reply(304, null),
    ];
    for (const [i, fail] of failures.entries()) {
      for (const [name, call] of calls) {
        const error = await call(clientWith(fail)).then(
          () => null,
          (e: unknown) => e,
        );
        if (error === null) continue; // e.g. getBlob accepts any bytes; updateRef ignores the body
        expect(leaks(error), `failure ${i} in ${name}: ${String(error)}`).toBe(false);
      }
    }
  });

  it("after a 401, and for a token that can't be sent at all", async () => {
    const client = clientWith(async () => reply(401, { message: SECRET }));
    await client.getRepo().catch(() => undefined);
    const later = await client.createTree(null, []).catch((e: unknown) => e);
    expect(leaks(later)).toBe(false);
    for (const bad of [`${SECRET}\n`, ` ${SECRET}`, `${SECRET}${String.fromCodePoint(0xe9)}`, ""]) {
      let thrown: unknown = null;
      try {
        clientWith(async () => reply(200, {}), bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(leaks(thrown)).toBe(false);
    }
  });

  it("rejects account and repository names that would change the URL", () => {
    for (const [owner, repo] of [
      ["../x", "workspace"],
      ["me", "../../user"],
      ["me", "a/b"],
      ["me", ".."],
      ["me?x=1", "r"],
    ]) {
      expect(() => createClient({ token: TEST_TOKEN, owner: owner!, repo: repo!, fetch: async () => reply(200, {}) })).toThrow(TypeError);
    }
  });

  it("rejects branch names and file paths with dot segments, which would move the URL", async () => {
    // Review regression: "../../../../../../user" reached GET https://api.github.com/user (the
    // URL parser resolves dot segments) with the token attached. Git forbids components that
    // start with "." (git check-ref-format), so no real branch is refused.
    const urls: string[] = [];
    const client = clientWith(async (input) => {
      urls.push(input);
      return reply(200, {});
    });
    for (const branch of ["..", "../../../../../../user", "a/../b", "./x", "x/.", ".hidden", "a//b"]) {
      await expect(client.getRef(branch), branch).rejects.toBeInstanceOf(TypeError);
      await expect(client.updateRef(branch, SHA), branch).rejects.toBeInstanceOf(TypeError);
    }
    for (const path of ["../x.py", "a/../../x.py", "./x.py", "a//x.py"]) {
      await expect(client.putFile(path, new Uint8Array([1]), "m"), path).rejects.toBeInstanceOf(TypeError);
    }
    expect(urls).toEqual([]);
    // Ordinary names still work, dots inside a name included.
    await client.getRef("feature/v1.2").catch(() => undefined);
    await client.putFile(".github/notes.md", new Uint8Array([1]), "m").catch(() => undefined);
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/repos/me/workspace/git/ref/heads/feature/v1.2", "/repos/me/workspace/contents/.github/notes.md"]);
  });
});
