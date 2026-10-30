import { describe, expect, it } from "vitest";
import { conflictName } from "../core/paths";
import { SyncError, sync, type SyncOptions, type SyncReport } from "./engine";
import { GitHubError, createClient, type GitHubClient } from "./github";
import { MemoryStore, createFakeGitHub, fileBytes, type FakeGitHubOptions, type MemoryStoreOptions } from "./test-helpers";

const noSleep = async () => undefined;

function setup(options: FakeGitHubOptions = {}) {
  const gh = createFakeGitHub(options);
  const client = createClient({ token: gh.token, owner: gh.owner, repo: gh.repo, fetch: gh.fetch, sleep: noSleep });
  return { gh, client };
}

const clock = (iso: string) => () => new Date(iso);
const at10 = clock("2026-10-16T10:00:00");

function run(store: MemoryStore, client: GitHubClient, extra: Partial<SyncOptions> = {}): Promise<SyncReport> {
  return sync(store, client, { deviceName: "laptop", now: at10, branch: "main", ...extra });
}

const device = (files: Record<string, string> = {}, options?: MemoryStoreOptions) => MemoryStore.with(files, options);
const since = (log: string[], from: number) => log.slice(from);

const uni = "my dir/h" + String.fromCodePoint(0xe9) + "llo w" + String.fromCodePoint(0xf6) + "rld.py";

describe("prototype scenarios", () => {
  it("empty repo: first device bootstraps with the Contents API, then pushes one commit", async () => {
    const { gh, client } = setup();
    const a = await device({ "main.py": "print(1)\n", "lib/util.c": "int f(void){return 1;}\n", [uni]: "# unicode path\n" });
    await run(a, client, { now: clock("2026-10-16T10:00:00"), deviceName: "laptop" });
    const b = await device();
    await run(b, client, { deviceName: "desktop" });
    expect(b.texts()).toEqual(a.texts());
    expect(gh.log.filter((l) => l.startsWith("PUT"))).toHaveLength(1);
    expect(gh.log.filter((l) => l.startsWith("PATCH"))).toHaveLength(1);
    expect(gh.files()).toEqual(a.texts());
    // The first file starts the repository under the same kind of message as any other commit.
    expect([...gh.commits.values()].map((c) => c.message)).toEqual([
      "Add lib/util.c\n\nAdded:\n  lib/util.c\n\nFrom: laptop (ExecFlow)",
      `Add main.py and ${uni}\n\nAdded:\n  main.py\n  ${uni}\n\nFrom: laptop (ExecFlow)`,
    ]);
  });

  it("a typed subject names every commit of that sync, the lists stay, and the next sync is automatic again", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "a\n", "b.py": "b\n" });
    const first = await run(a, client, { subject: "  Lab 3:" + String.fromCodePoint(0x202e) + " first try\n" });
    expect(first.commits).toBe(2);
    expect([...gh.commits.values()].map((c) => c.message)).toEqual([
      "Lab 3: first try\n\nAdded:\n  a.py\n\nFrom: laptop (ExecFlow)",
      "Lab 3: first try\n\nAdded:\n  b.py\n\nFrom: laptop (ExecFlow)",
    ]);
    await a.write("b.py", "b2\n");
    await run(a, client);
    expect(gh.commits.get(gh.head()!)!.message).toBe("Update b.py\n\nChanged:\n  b.py\n\nFrom: laptop (ExecFlow)");
    // Nothing to upload: no commit, whatever the subject.
    const before = gh.commits.size;
    const idle = await run(a, client, { subject: "Nothing here" });
    expect(idle.commits).toBe(0);
    expect(gh.commits.size).toBe(before);
  });

  it("non-overlapping edits on two machines merge without conflicts; idle sync makes no commit", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "a1\n", "b.py": "b1\n" });
    await run(a, client);
    const b = await device();
    await run(b, client);
    await a.write("a.py", "a2\n");
    await b.write("b.py", "b2\n");
    await b.write("new.cpp", "int main(){}\n");
    await run(a, client);
    const r = await run(b, client);
    await run(a, client);
    expect(a.texts()).toEqual({ "a.py": "a2\n", "b.py": "b2\n", "new.cpp": "int main(){}\n" });
    expect(b.texts()).toEqual(a.texts());
    expect(r.conflicts).toEqual([]);
    expect(r.details.some((x) => x.kind.startsWith("conflict"))).toBe(false);
    // Unlike the prototype, a sync that wrote files here doesn't keep the ref's ETag (a path it
    // skipped would make the base differ from the tree), so the first idle sync reads the tree once.
    let before = gh.log.length;
    const settle = await run(a, client);
    expect(settle.pushed).toEqual([]);
    expect(since(gh.log, before).filter((l) => !l.startsWith("GET"))).toEqual([]);
    before = gh.log.length;
    const idle = await run(a, client);
    expect(idle.pushed).toEqual([]);
    expect(since(gh.log, before)).toEqual(["GET /git/ref/heads/main"]);
  });

  it("both edited the same file: remote keeps the path, local goes to a synced conflict copy", async () => {
    const { client } = setup();
    const a = await device({ "main.py": "v0\n" });
    await run(a, client);
    const b = await device();
    await run(b, client);
    await a.write("main.py", "from A\n");
    await b.write("main.py", "from B\n");
    await run(a, client);
    const r = await run(b, client, { now: clock("2026-10-16T14:30:05") });
    await run(a, client);
    const expected = { "main.conflict-20261016-143005.py": "from B\n", "main.py": "from A\n" };
    expect(b.texts()).toEqual(expected);
    expect(a.texts()).toEqual(expected);
    expect(r.details.some((x) => x.kind === "conflict-both-changed")).toBe(true);
    expect(r.conflicts).toEqual([{ path: "main.py", copy: "main.conflict-20261016-143005.py" }]);
    expect(r.pushed).toEqual(["main.conflict-20261016-143005.py"]);
  });

  it("edit vs delete: the edit wins on both sides; unchanged remote delete is applied", async () => {
    const { client } = setup();
    const a = await device({ "keep.py": "k\n", "gone.py": "g\n", "x.py": "x\n" });
    await run(a, client);
    const b = await device();
    await run(b, client);
    a.delete("keep.py");
    await b.write("keep.py", "edited on B\n");
    a.delete("gone.py");
    b.delete("x.py");
    await a.write("x.py", "edited on A\n");
    await run(a, client);
    await run(b, client);
    await run(a, client);
    expect(a.texts()).toEqual({ "keep.py": "edited on B\n", "x.py": "edited on A\n" });
    expect(b.texts()).toEqual(a.texts());
  });

  it("race: remote moves between GET ref and PATCH ref -> 422 -> re-merge -> success", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n" });
    await run(a, client);
    await a.write("a.py", "2 from laptop\n");
    gh.beforeUpdateRef.push(() => gh.remoteCommit({ "web.md": "edited on github.com\n" }));
    await run(a, client);
    // The bootstrap used PUT /contents (no PATCH); then one rejected PATCH (422) and one retried PATCH.
    expect(gh.log.filter((l) => l.startsWith("PATCH"))).toHaveLength(2);
    const b = await device();
    await run(b, client);
    expect(b.texts()).toEqual({ "a.py": "2 from laptop\n", "web.md": "edited on github.com\n" });
    expect(a.texts()).toEqual(b.texts());
    expect(a.commits).toHaveLength(2); // one store commit per sync, none for the rejected attempt
  });

  it("ETag: unchanged remote answers 304 and the idle sync costs one conditional GET", async () => {
    const { client } = setup();
    const a = await device({ "a.py": "1\n" });
    await run(a, client);
    await run(a, client); // stores the ref ETag
    const r = await client.getRef("main", a.remote!.refEtag);
    expect(r.state).toBe("unchanged");
  });

  it("repo emptied/recreated: local files are re-pushed, never deleted", async () => {
    const { client } = setup();
    const a = await device({ "a.py": "1\n", "b.py": "2\n" });
    await run(a, client);
    const fresh = setup();
    await run(a, fresh.client); // same device, base points at a commit the new repo lacks
    expect(a.texts()).toEqual({ "a.py": "1\n", "b.py": "2\n" });
    const b = await device();
    await run(b, fresh.client);
    expect(b.texts()).toEqual({ "a.py": "1\n", "b.py": "2\n" });
  });

  it("history rewritten (force-push elsewhere): remote deletions are not applied", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n", "b.py": "2\n" });
    await run(a, client);
    const old = gh.head();
    // Someone force-pushes an unrelated root commit containing only b.py.
    await gh.remoteCommit({ "a.py": null }, { root: true });
    expect(gh.head()).not.toBe(old);
    const r = await run(a, client);
    expect(a.texts()).toEqual({ "a.py": "1\n", "b.py": "2\n" });
    expect(r.historyRewritten).toBe(true);
    expect(r.details.some((x) => x.kind === "kept-after-history-rewrite")).toBe(true);
  });

  it("BOM and CRLF files pulled from the remote round-trip byte-exactly (no phantom push)", async () => {
    const { gh, client } = setup();
    const a = await device({ "seed.py": "s\n" });
    await run(a, client);
    const bytes = fileBytes("int x;\nint y;\n", "\r\n", true);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await gh.remoteCommit({ "win.c": bytes });
    await run(a, client);
    const before = gh.log.length;
    const r = await run(a, client);
    expect(r.pushed).toEqual([]);
    expect(since(gh.log, before).some((l) => l.startsWith("POST") || l.startsWith("PATCH"))).toBe(false);
    expect(a.files.get("win.c")).toMatchObject({ text: "int x;\nint y;\n", eol: "\r\n", bom: true });
    // Editing it keeps its line endings and BOM.
    await a.write("win.c", "int x;\nint z;\n", "\r\n", true);
    await run(a, client);
    expect([...gh.bytesAt("win.c")!]).toEqual([...fileBytes("int x;\nint z;\n", "\r\n", true)]);
  });
});

describe("conditional reads", () => {
  it("the 304 path costs no commit, tree or compare read, even for a push", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n", "b.py": "2\n" });
    await run(a, client);
    await run(a, client); // learns the ETag
    await a.write("a.py", "changed\n");
    const before = gh.log.length;
    await run(a, client);
    expect(since(gh.log, before).map((l) => l.split(" ")[0] + " " + l.split(" ")[1]!.split("/").slice(0, 3).join("/"))).toEqual([
      "GET /git/ref",
      "POST /git/trees",
      "GET /git/trees", // checking what GitHub stored, before the branch moves
      "POST /git/commits",
      "PATCH /git/refs",
    ]);
    expect(gh.requests[before]!.headers.get("if-none-match")).toBe(`W/"${gh.commits.get(gh.head()!)!.parents[0]}"`);
    expect(gh.files()["a.py"]).toBe("changed\n");
  });
});

describe("races and failures", () => {
  it("422 three times in a row stops with nothing changed locally", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n" });
    await run(a, client);
    await a.write("a.py", "2\n");
    let n = 0;
    for (let i = 0; i < 3; i++) gh.beforeUpdateRef.push(() => gh.remoteCommit({ [`web${++n}.md`]: `${n}\n` }));
    const commitsBefore = a.commits.length;
    const error = await run(a, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("remote-moving");
    expect(a.commits).toHaveLength(commitsBefore);
    expect(a.texts()).toEqual({ "a.py": "2\n" });
    // The next sync converges.
    await run(a, client);
    expect(gh.files()).toEqual({ "a.py": "2\n", "web1.md": "1\n", "web2.md": "2\n", "web3.md": "3\n" });
  });

  it("a push whose answer was lost doesn't make a second conflict copy", async () => {
    const gh = createFakeGitHub();
    let dropPatch = false;
    const client = createClient({
      token: gh.token,
      owner: gh.owner,
      repo: gh.repo,
      sleep: noSleep,
      fetch: async (input, init) => {
        const res = await gh.fetch(input, init);
        if (init.method === "PATCH" && dropPatch) {
          dropPatch = false;
          throw new TypeError("connection reset");
        }
        return res;
      },
    });
    const a = await device({ "main.py": "v0\n" });
    await run(a, client);
    await gh.remoteCommit({ "main.py": "remote\n" });
    await a.write("main.py", "local\n");
    dropPatch = true;
    await expect(run(a, client, { now: clock("2026-10-16T11:00:00") })).rejects.toMatchObject({ kind: "network", op: "updateRef" });
    expect(a.texts()).toEqual({ "main.py": "local\n" }); // nothing applied locally
    const r = await run(a, client, { now: clock("2026-10-16T11:00:07") });
    expect(r.conflicts).toEqual([]);
    expect(a.texts()).toEqual({ "main.conflict-20261016-110000.py": "local\n", "main.py": "remote\n" });
    expect(gh.files()).toEqual(a.texts());
  });

  it("GitHub storing different bytes stops the sync before the branch moves", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n" });
    await run(a, client);
    const head = gh.head();
    await a.write("a.py", "2\n");
    gh.setMangle((_p, bytes) => new Uint8Array([...bytes, 0x20]));
    const error = await run(a, client).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SyncError", kind: "verify-failed" });
    expect(gh.head()).toBe(head);
    expect(gh.log.some((l) => l.startsWith("POST /git/commits"))).toBe(false);
    expect(a.commits).toHaveLength(1);
  });

  it("a downloaded file that doesn't match its id stops the sync", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "a.py": "1\n" });
    gh.interceptors.push((req) => (req.path.startsWith("/git/blobs/") ? new Response(new TextEncoder().encode("tampered\n"), { status: 200 }) : undefined));
    const a = await device();
    await expect(run(a, client)).rejects.toMatchObject({ kind: "bad-download" });
    expect(a.commits).toHaveLength(0);
  });

  it("a truncated tree listing is refused", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "a.py": "1\n" });
    gh.interceptors.push((req) =>
      req.method === "GET" && req.path.startsWith("/git/trees/") ? new Response(JSON.stringify({ sha: "b".repeat(40), truncated: true, tree: [] }), { status: 200 }) : undefined,
    );
    await expect(run(await device(), client)).rejects.toMatchObject({ kind: "tree-too-large" });
  });

  it("GitHub errors pass through unchanged (rate limit with its wait)", async () => {
    const { gh, client } = setup();
    gh.interceptors.push(() => new Response(JSON.stringify({ message: "secondary rate limit" }), { status: 403, headers: { "retry-after": "42" } }));
    const error = await run(await device({ "a.py": "1\n" }), client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ kind: "rate-limit", retryAfterMs: 42_000 });
  });

  it("a repository larger than a workspace is refused before any download", async () => {
    const { gh, client } = setup();
    const many: Record<string, string> = {};
    for (let i = 0; i <= 2000; i++) many[`f${i}.txt`] = `${i}\n`;
    await gh.remoteCommit(many);
    await expect(run(await device(), client)).rejects.toMatchObject({ kind: "too-many-files" });
    expect(gh.log.some((l) => l.startsWith("GET /git/blobs"))).toBe(false);
  });

  it("a repository whose text files add up to more than a workspace holds is refused before any download", async () => {
    // Review regression: only the file count was checked, so up to 2000 files of 1 MiB were
    // downloaded into memory before the store refused them (50 MiB per workspace).
    const { gh, client } = setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 51; i++) files[`data/${i}.csv`] = `${i},` + "x".repeat(1_040_000) + "\n";
    await gh.remoteCommit(files);
    const error = await run(await device(), client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ kind: "workspace-too-large" });
    expect(gh.log.some((l) => l.startsWith("GET /git/blobs"))).toBe(false);
  });
});

describe("empty repositories", () => {
  it("can only be started on the default branch", async () => {
    const { client } = setup();
    await expect(run(await device({ "a.py": "1\n" }), client, { branch: "dev" })).rejects.toMatchObject({ kind: "not-default-branch" });
  });

  it("with nothing to push, nothing is written and the commit stays null", async () => {
    const { gh, client } = setup();
    const r = await run(await device(), client);
    expect(r.commit).toBeNull();
    expect(gh.writes()).toEqual([]);
  });

  it("typing in the first file while the repository is being started is pushed, never asked about", async () => {
    // Review regression: the round after PUT /contents had no base, so an edit typed meanwhile
    // looked like a first-connect difference; "use-remote" then overwrote it with the upload.
    const gh = createFakeGitHub();
    const a = await device({ "a.py": "v1\n", "b.py": "b\n" });
    const client = createClient({
      token: gh.token,
      owner: gh.owner,
      repo: gh.repo,
      sleep: noSleep,
      fetch: async (input, init) => {
        const res = await gh.fetch(input, init);
        if (init.method === "PUT") await a.write("a.py", "v2 typed meanwhile\n");
        return res;
      },
    });
    let asked = 0;
    const r = await run(a, client, {
      firstConnect: async () => {
        asked++;
        return "use-remote";
      },
    });
    expect(asked).toBe(0);
    expect(r.conflicts).toEqual([]);
    expect(a.texts()).toEqual({ "a.py": "v2 typed meanwhile\n", "b.py": "b\n" });
    expect(gh.files()).toEqual(a.texts());
  });
});

describe("remote paths the workspace can't store", () => {
  const bidi = "x" + String.fromCodePoint(0x202e) + "yp.exe";
  const nfd = "cafe" + String.fromCodePoint(0x301) + ".py";
  const backslash = "a" + String.fromCharCode(0x5c) + "b.py";
  const bad = ["bad/CON.txt", bidi, nfd, backslash, "trailing.", "x/.git/config", "zero" + String.fromCodePoint(0x200b) + ".c"];

  it("are ignored: never pulled, never deleted on GitHub, reported", async () => {
    const { gh, client } = setup();
    const planted: Record<string, string> = { "ok.py": "ok\n" };
    for (const p of bad) planted[p] = `content of a bad name\n`;
    await gh.remoteCommit(planted);
    const shasBefore = new Map([...gh.entries()].filter(([p]) => bad.includes(p)).map(([p, e]) => [p, e.sha]));
    expect(shasBefore.size).toBe(bad.length);

    const a = await device();
    const r = await run(a, client);
    expect(a.texts()).toEqual({ "ok.py": "ok\n" });
    expect([...r.ignoredRemotePaths].sort()).toEqual([...bad].sort());

    // A push, then deleting everything locally: the bad names stay on GitHub untouched.
    await a.write("new.py", "n\n");
    await run(a, client);
    a.delete("ok.py");
    a.delete("new.py");
    await run(a, client);
    const after = gh.entries();
    for (const [p, sha] of shasBefore) expect(after.get(p)?.sha, p).toBe(sha);
    expect(after.has("ok.py")).toBe(false);
    for (const req of gh.requests.filter((q) => q.method === "POST" && q.path === "/git/trees")) {
      const tree = (req.body as { tree: { path: string }[] }).tree;
      for (const e of tree) expect(bad).not.toContain(e.path);
    }
  });

  it("a local file named like an ignored folder moves aside instead of clashing", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "bad/CON.txt": "x\n", "ok.py": "1\n" });
    const a = await device({ bad: "local file\n" });
    const r = await run(a, client);
    expect(a.texts()).toEqual({ "bad.conflict-20261016-100000": "local file\n", "ok.py": "1\n" });
    expect(r.conflicts).toEqual([{ path: "bad", copy: "bad.conflict-20261016-100000" }]);
    expect(gh.files()["bad/CON.txt"]).toBe("x\n");
  });

  it("after an idle sync (304 next time), a new local file named like an ignored folder still moves aside", async () => {
    // Review regression: the 304 shortcut doesn't list the tree, so it knew no ignored paths and
    // pushed "bad" as a file over the folder "bad/" (GitHub: tree entries overwrite base_tree
    // items with the same path), deleting bad/CON.txt on GitHub. The fake answers 422 instead.
    const { gh, client } = setup();
    await gh.remoteCommit({ "bad/CON.txt": "x\n", "ok.py": "1\n" });
    const a = await device();
    await run(a, client); // pulls ok.py
    await run(a, client); // nothing changes: keeps the ref ETag
    const etag = a.remote!.refEtag;
    expect(etag).not.toBeNull();
    await a.write("bad", "local file\n");
    const before = gh.log.length;
    const r = await run(a, client);
    expect(gh.requests[before]!.headers.get("if-none-match")).toBe(etag); // the 304 path really ran
    expect(gh.files()["bad/CON.txt"]).toBe("x\n");
    expect(a.texts()).toEqual({ "bad.conflict-20261016-100000": "local file\n", "ok.py": "1\n" });
    expect(r.conflicts).toEqual([{ path: "bad", copy: "bad.conflict-20261016-100000" }]);
  });
});

describe("opaque files", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const big = new TextEncoder().encode("a".repeat(1024 * 1024 + 10));
  const submodule = "c".repeat(40);
  const repoWithOpaque = async (gh: ReturnType<typeof createFakeGitHub>) => {
    await gh.remoteCommit({
      "logo.png": png,
      link: { text: "target.py", mode: "120000" },
      "lib/vendored": { submodule },
      "mixed.txt": new TextEncoder().encode("a\r\nb\n"),
      "big.txt": big,
      "trojan.c": "int ok" + String.fromCodePoint(0x202e) + " = 1;\n",
      "run.sh": { text: "echo hi\n", mode: "100755" },
      "main.py": "print(1)\n",
    });
  };
  const OPAQUE = ["big.txt", "lib/vendored", "link", "logo.png", "mixed.txt", "trojan.c"];

  it("are kept as read-only pointers, and links, submodules and large files are never downloaded", async () => {
    const { gh, client } = setup();
    await repoWithOpaque(gh);
    const a = await device();
    const r = await run(a, client);
    expect(a.opaquePaths()).toEqual(OPAQUE);
    expect(a.texts()).toEqual({ "main.py": "print(1)\n", "run.sh": "echo hi\n" });
    expect(r.opaque.map((o) => o.path)).toEqual(OPAQUE);
    expect(r.opaque.find((o) => o.path === "logo.png")!.reason).toContain("PNG");
    const entries = gh.entries();
    const downloaded = gh.log.filter((l) => l.startsWith("GET /git/blobs/")).map((l) => l.slice("GET /git/blobs/".length));
    for (const p of ["big.txt", "link", "lib/vendored"]) expect(downloaded).not.toContain(entries.get(p)!.sha);
    expect(a.files.get("lib/vendored")!.opaque).toEqual({ sha: submodule, mode: "160000" });
  });

  it("survive a push unchanged, keep the executable bit, and are restored instead of deleted", async () => {
    const { gh, client } = setup();
    await repoWithOpaque(gh);
    const before = gh.entries();
    const a = await device();
    await run(a, client);
    await a.write("run.sh", "echo bye\n");
    await a.write("main.py", "print(2)\n");
    await run(a, client);
    let after = gh.entries();
    for (const p of OPAQUE) expect(after.get(p), p).toEqual(before.get(p));
    expect(after.get("run.sh")!.mode).toBe("100755");
    expect(gh.files()["run.sh"]).toBe("echo bye\n");

    // Deleting a read-only pointer here doesn't delete the file on GitHub.
    a.delete("logo.png");
    a.delete("link");
    const r = await run(a, client);
    after = gh.entries();
    for (const p of OPAQUE) expect(after.get(p), p).toEqual(before.get(p));
    expect(a.opaquePaths()).toEqual(OPAQUE);
    expect(r.details.filter((d) => d.kind === "kept-opaque").map((d) => d.path)).toEqual(["link", "logo.png"]);
    expect(r.deleted).toEqual([]);
  });

  it("a text file written over a read-only one becomes a conflict copy", async () => {
    const { gh, client } = setup();
    await repoWithOpaque(gh);
    const a = await device();
    await run(a, client);
    a.delete("link");
    await a.write("link", "now a text file\n");
    const r = await run(a, client);
    expect(gh.entries().get("link")!.mode).toBe("120000");
    expect(r.conflicts).toEqual([{ path: "link", copy: "link.conflict-20261016-100000" }]);
    expect(gh.files()["link.conflict-20261016-100000"]).toBe("now a text file\n");
  });

  it("are never deleted on GitHub even by a store that can't keep pointers", async () => {
    const { gh, client } = setup();
    await repoWithOpaque(gh);
    const before = gh.entries();
    const a = await device({}, { supportsOpaque: false });
    await run(a, client);
    expect(a.opaquePaths()).toEqual([]);
    await a.write("main.py", "print(3)\n");
    await run(a, client);
    await run(a, client);
    await run(a, client);
    const after = gh.entries();
    for (const p of OPAQUE) expect(after.get(p), p).toEqual(before.get(p));
    for (const req of gh.requests.filter((q) => q.method === "POST" && q.path === "/git/trees")) {
      for (const e of (req.body as { tree: { path: string; sha?: string | null }[] }).tree) expect(e.sha === null && OPAQUE.includes(e.path)).toBe(false);
    }
  });
});

describe("conflicts and restores", () => {
  it("local delete vs remote edit: the remote edit is restored here", async () => {
    const { gh, client } = setup();
    const a = await device({ "x.py": "v0\n", "y.py": "y\n" });
    await run(a, client);
    const b = await device();
    await run(b, client);
    a.delete("x.py");
    await b.write("x.py", "edited on B\n");
    await run(b, client);
    const r = await run(a, client);
    expect(a.texts()).toEqual({ "x.py": "edited on B\n", "y.py": "y\n" });
    expect(gh.files()["x.py"]).toBe("edited on B\n");
    expect(r.details.find((d) => d.path === "x.py")?.kind).toBe("conflict-local-delete-vs-remote-edit");
    expect(r.pulled).toEqual(["x.py"]);
  });

  it("conflict-copy names don't collide with a copy another device made the same second", async () => {
    const { gh, client } = setup();
    const a = await device({ "main.py": "v0\n" });
    await run(a, client, { now: clock("2026-10-16T14:00:00") });
    const stamp = clock("2026-10-16T14:30:05");
    const taken = conflictName("main.py", stamp(), () => false);
    await gh.remoteCommit({ "main.py": "remote\n", [taken]: "the other device's copy\n" });
    await a.write("main.py", "local\n");
    const r = await run(a, client, { now: stamp });
    expect(r.conflicts).toEqual([{ path: "main.py", copy: "main.conflict-20261016-143005-2.py" }]);
    expect(gh.files()).toEqual({ "main.py": "remote\n", [taken]: "the other device's copy\n", "main.conflict-20261016-143005-2.py": "local\n" });
    expect(a.texts()).toEqual(gh.files());
  });

  it("typing during a sync: that file is skipped, and the next sync keeps both versions", async () => {
    const { gh, client } = setup();
    const a = await device({ "main.py": "v0\n" });
    await run(a, client);
    await gh.remoteCommit({ "main.py": "remote\n" });
    a.beforeCommit = () => {
      a.beforeCommit = null;
      return a.write("main.py", "typed during sync\n");
    };
    const r1 = await run(a, client);
    expect(r1.skipped).toEqual(["main.py"]);
    expect(r1.pulled).toEqual([]);
    expect(a.texts()).toEqual({ "main.py": "typed during sync\n" });
    const r2 = await run(a, client, { now: clock("2026-10-16T10:05:00") });
    expect(r2.conflicts).toEqual([{ path: "main.py", copy: "main.conflict-20261016-100500.py" }]);
    expect(gh.files()).toEqual({ "main.conflict-20261016-100500.py": "typed during sync\n", "main.py": "remote\n" });
  });

  it("a local file where the repository has a folder moves aside on both sides", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "notes/a.py": "remote\n" });
    const a = await device({ notes: "my notes\n" });
    const r = await run(a, client, { now: clock("2026-10-16T09:00:00") });
    const expected = { "notes.conflict-20261016-090000": "my notes\n", "notes/a.py": "remote\n" };
    expect(a.texts()).toEqual(expected);
    expect(gh.files()).toEqual(expected);
    expect(r.conflicts).toEqual([{ path: "notes", copy: "notes.conflict-20261016-090000" }]);
    expect(r.deleted).toEqual([]);
    expect(r.pulled).toEqual(["notes/a.py"]);
  });
});

describe("first connect", () => {
  const both = async (choice?: "use-remote" | "merge" | "push-local") => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "shared.py": "remote\n", "r.py": "r\n", "same.py": "same\n" });
    const a = await device({ "shared.py": "local\n", "l.py": "l\n", "same.py": "same\n" });
    let asked = 0;
    const firstConnect = choice
      ? async () => {
          asked++;
          return choice;
        }
      : undefined;
    const report = await run(a, client, { firstConnect });
    return { gh, a, asked, report, client };
  };

  it("merge (the default): conflict copy for files that differ, everything else kept", async () => {
    const { gh, a } = await both();
    const expected = { "l.py": "l\n", "r.py": "r\n", "same.py": "same\n", "shared.conflict-20261016-100000.py": "local\n", "shared.py": "remote\n" };
    expect(a.texts()).toEqual(expected);
    expect(gh.files()).toEqual(expected);
  });

  it("use-remote: the repository's version wins, files only here are still uploaded", async () => {
    const { gh, a, asked } = await both("use-remote");
    expect(asked).toBe(1);
    const expected = { "l.py": "l\n", "r.py": "r\n", "same.py": "same\n", "shared.py": "remote\n" };
    expect(a.texts()).toEqual(expected);
    expect(gh.files()).toEqual(expected);
  });

  it("push-local: this computer's version wins, files only in the repository are kept", async () => {
    const { gh, a } = await both("push-local");
    const expected = { "l.py": "l\n", "r.py": "r\n", "same.py": "same\n", "shared.py": "local\n" };
    expect(a.texts()).toEqual(expected);
    expect(gh.files()).toEqual(expected);
  });

  it("isn't asked when nothing differs, and cancelling changes nothing", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "same.py": "same\n", "r.py": "r\n" });
    let asked = 0;
    const a = await device({ "same.py": "same\n" });
    await run(a, client, {
      firstConnect: async () => {
        asked++;
        return "merge";
      },
    });
    expect(asked).toBe(0);
    const b = await device({ "same.py": "different\n" });
    const writes = gh.writes().length;
    await expect(run(b, client, { firstConnect: () => Promise.reject(new Error("cancelled")) })).rejects.toThrow("cancelled");
    expect(b.commits).toHaveLength(0);
    expect(gh.writes()).toHaveLength(writes);
  });
});

describe("pushing", () => {
  it("never pushes changes under .github/workflows/ and still syncs the rest", async () => {
    const { gh, client } = setup({ workflowsWritable: false });
    await gh.remoteCommit({ ".github/workflows/ci.yml": "on: push\n", "a.py": "1\n" });
    const a = await device();
    await run(a, client);
    await a.write(".github/workflows/ci.yml", "on: pull_request\n");
    await a.write("a.py", "2\n");
    const r = await run(a, client);
    expect(r.notPushed).toEqual([".github/workflows/ci.yml"]);
    expect(gh.files()).toEqual({ ".github/workflows/ci.yml": "on: push\n", "a.py": "2\n" });
    expect(a.texts()[".github/workflows/ci.yml"]).toBe("on: pull_request\n");
  });

  it("a file replaced by a folder of large files pushes in several trees without a file/folder clash", async () => {
    // Review regression: deletes went after the adds, so when the inline budget split the push,
    // the first tree held both the file "notes" and "notes/1.txt" (GitHub refuses or overwrites).
    const { gh, client } = setup();
    const a = await device({ notes: "a file\n", "keep.py": "k\n" });
    await run(a, client);
    a.delete("notes");
    for (const n of ["1", "2", "3"]) await a.write(`notes/${n}.txt`, n.repeat(600_000) + "\n");
    const before = gh.log.length;
    const r = await run(a, client);
    expect(since(gh.log, before).filter((l) => l === "POST /git/trees").length).toBeGreaterThan(1);
    expect(Object.keys(gh.files()).sort()).toEqual(["keep.py", "notes/1.txt", "notes/2.txt", "notes/3.txt"]);
    expect(r.deleted).toEqual([{ path: "notes", where: "remote" }]);
    expect(r.pushed).toEqual(["notes/1.txt", "notes/2.txt", "notes/3.txt"]);
  });

  it("downloads at most 3 files at a time", async () => {
    const { gh, client } = setup({ blobLatencyMs: 5 });
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.py`] = `${i}\n`;
    await gh.remoteCommit(files);
    const a = await device();
    const r = await run(a, client);
    expect(a.texts()).toEqual(files);
    expect(r.pulled).toHaveLength(12);
    expect(gh.maxBlobsInFlight).toBeLessThanOrEqual(3);
    expect(gh.maxBlobsInFlight).toBeGreaterThan(1);
  });

  it("reuses local text for a file renamed on the other side (no download)", async () => {
    const { gh, client } = setup();
    const a = await device({ "old.py": "same bytes\n" });
    await run(a, client);
    await gh.remoteCommit({ "old.py": null, "new.py": "same bytes\n" });
    const before = gh.log.length;
    await run(a, client);
    expect(a.texts()).toEqual({ "new.py": "same bytes\n" });
    expect(since(gh.log, before).some((l) => l.startsWith("GET /git/blobs"))).toBe(false);
  });

  it("reports every kind of change, writes one clean commit message, and sends deletes", async () => {
    const { gh, client } = setup();
    const a = await device({ "keep.py": "k\n", "del.py": "d\n", "edit.py": "e\n" });
    await run(a, client);
    a.delete("del.py");
    await a.write("edit.py", "e2\n");
    await a.write("add.py", "a\n");
    const nasty = "lab" + String.fromCharCode(10) + "PC" + String.fromCodePoint(0x202e) + " 7";
    const r = await run(a, client, { deviceName: nasty });
    expect(r.pushed).toEqual(["add.py", "edit.py"]);
    expect(r.deleted).toEqual([{ path: "del.py", where: "remote" }]);
    expect(gh.commits.get(gh.head()!)!.message).toBe(
      ["Add add.py, update edit.py and delete del.py", "", "Added:", "  add.py", "", "Changed:", "  edit.py", "", "Deleted:", "  del.py", "", "From: lab PC 7 (ExecFlow)"].join("\n"),
    );
    expect(r.commits).toBe(1);
    expect(a.remote).toMatchObject({ owner: "me", repo: "workspace", branch: "main", baseCommit: gh.head(), lastError: null, deviceName: nasty });
    expect([...a.base.keys()].sort()).toEqual(["add.py", "edit.py", "keep.py"]);
  });

  it("reports progress phases in order", async () => {
    const { gh, client } = setup();
    await gh.remoteCommit({ "r.py": "r\n" });
    const a = await device({ "l.py": "l\n" });
    const phases: string[] = [];
    await run(a, client, { onProgress: (phase, done, total) => phases.push(done === undefined ? phase : `${phase} ${done}/${total}`) });
    expect(phases).toEqual(["checking", "downloading 0/1", "downloading 1/1", "uploading", "verifying", "saving"]);
  });

  it("text with a lone surrogate is pushed as the exact bytes it was hashed as", async () => {
    const { gh, client } = setup();
    const a = await device({ "seed.py": "s\n" });
    await run(a, client);
    const odd = "x = '" + String.fromCharCode(0xd800) + "'\n";
    await a.write("odd.py", odd);
    await run(a, client);
    expect([...gh.bytesAt("odd.py")!]).toEqual([...fileBytes(odd)]);
  });

  it("content over 1 MiB goes up as a base64 blob, not inline", async () => {
    const { gh, client } = setup();
    const a = await device({ "seed.py": "s\n" });
    await run(a, client);
    const huge = "y".repeat(1024 * 1024 + 1) + "\n";
    await a.write("huge.txt", huge);
    await run(a, client);
    expect(gh.log.filter((l) => l === "POST /git/blobs")).toHaveLength(1);
    const tree = gh.requests.filter((q) => q.path === "/git/trees").at(-1)!.body as { tree: Record<string, unknown>[] };
    expect(tree.tree).toEqual([{ path: "huge.txt", mode: "100644", type: "blob", sha: a.files.get("huge.txt")!.sha }]);
    expect(gh.bytesAt("huge.txt")!.length).toBe(huge.length);
  });

  it("two syncs started together run one after the other", async () => {
    const { gh, client } = setup();
    const a = await device({ "a.py": "1\n" });
    await run(a, client);
    await a.write("a.py", "2\n");
    const [r1, r2] = await Promise.all([run(a, client), run(a, client)]);
    expect(r1.pushed).toEqual(["a.py"]);
    expect(r2.pushed).toEqual([]);
    expect(gh.log.filter((l) => l.startsWith("PATCH"))).toHaveLength(1);
  });

  it("a different repository in the store's remote is treated as a first connect", async () => {
    const first = setup({ repo: "old" });
    const a = await device({ "a.py": "1\n", "b.py": "2\n" });
    await run(a, first.client);
    const other = setup({ repo: "new" });
    await other.gh.remoteCommit({ "c.py": "3\n" });
    await run(a, other.client);
    // The old base must not turn into deletions in the new repository (or here).
    expect(a.texts()).toEqual({ "a.py": "1\n", "b.py": "2\n", "c.py": "3\n" });
    expect(other.gh.files()).toEqual(a.texts());
  });
});
