import { describe, expect, it } from "vitest";
import { branchProblem, deviceName, ownerProblem, parseRepoInput, repoProblem, TOKEN_PAGE, tokenPageUrl } from "./sync-form";
import { SYNC_ICON_NAMES, syncIconSource } from "./sync-icons";
import { pathData } from "./icons";

describe("repository input", () => {
  it.each([
    ["me/code", { owner: "me", repo: "code" }],
    ["  me/code  ", { owner: "me", repo: "code" }],
    ["https://github.com/me/code", { owner: "me", repo: "code" }],
    ["https://github.com/me/code.git", { owner: "me", repo: "code" }],
    ["github.com/Me-2/my.repo/tree/main/src", { owner: "Me-2", repo: "my.repo" }],
    ["git@github.com:me/code.git", { owner: "me", repo: "code" }],
    ["https://www.github.com/me/code/?tab=readme#x", { owner: "me", repo: "code" }],
  ])("reads %s", (text, want) => {
    expect(parseRepoInput(text)).toEqual(want);
  });

  it.each(["me", "", "me/", "/code", "me/..", "-me/code", "me/co de", "https://gitlab.com/me/code"])("leaves %s alone", (text) => {
    expect(parseRepoInput(text)).toBeNull();
  });

  it("checks names with the client's own rules before anything is sent", () => {
    expect(ownerProblem("me")).toBeNull();
    expect(ownerProblem("")).toMatch(/Enter/);
    expect(ownerProblem("-me")).not.toBeNull();
    expect(ownerProblem("a".repeat(40))).not.toBeNull();
    expect(repoProblem("my.repo_1-x")).toBeNull();
    expect(repoProblem("..")).not.toBeNull();
    expect(repoProblem("a b")).not.toBeNull();
  });

  it("refuses branch names git refuses, and allows an empty one (the default branch)", () => {
    expect(branchProblem("")).toBeNull();
    expect(branchProblem("main")).toBeNull();
    expect(branchProblem("feature/v1.2")).toBeNull();
    for (const bad of ["../user", "a..b", ".hidden", "x/.y", "a b", "a:b", "a~1", "a^", "x.lock", "x/", "/x", "a//b", "a@{1}", "a\\b"]) {
      expect(branchProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("the token page link", () => {
  it("fills in what GitHub's documented parameters allow, for this repository only", () => {
    const url = new URL(tokenPageUrl("me", "code"));
    expect(url.origin + url.pathname).toBe(TOKEN_PAGE);
    expect(url.searchParams.get("contents")).toBe("write");
    expect(url.searchParams.get("expires_in")).toBe("90");
    expect(url.searchParams.get("target_name")).toBe("me");
    expect(url.searchParams.get("name")).toBe("CodeEditor code");
    // Nothing broader than Contents is asked for.
    expect([...url.searchParams.keys()].sort()).toEqual(["contents", "description", "expires_in", "name", "target_name"]);
  });

  it("keeps the name within GitHub's 40 characters and leaves out an invalid owner", () => {
    const url = new URL(tokenPageUrl("bad owner", "r".repeat(100)));
    expect(url.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
    expect(url.searchParams.has("target_name")).toBe(false);
  });
});

describe("device label for commit messages", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", "Win32", "Firefox on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0", "Win32", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel", "Safari on macOS"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Linux x86_64", "Chrome on Linux"],
    ["", "", "a browser"],
  ])("%s", (ua, platform, want) => {
    expect(deviceName(ua, platform)).toBe(want);
  });
});

describe("sync icons", () => {
  it.each(SYNC_ICON_NAMES)("%s is drawn from path data only", (name) => {
    const source = syncIconSource(name);
    expect(source).toMatch(/^<svg [^>]*viewBox="0 0 256 256"/);
    const tags = [...source.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "path"]));
    for (const d of pathData(source)) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
  });
});
