// The link catcher (src/ui/link-fragment.ts): a short link's key and a code link's code leave the
// address at once, in every tab, and wait in memory for the workbench.
import { describe, expect, it } from "vitest";
import { CODE_LINK_MARK } from "../core/code-link";
import { MOVE_PATH } from "../core/move-protocol";
import { SHORT_PATH } from "../core/short-link";
import { LINK_PATHS, linkCatcher, takeFrom, type LinkFragment } from "./link-fragment";

const KEY = "#" + "k".repeat(43);

/** A location and a history whose replaceState changes that location, as a browser's does. */
function address(pathname: string, search = "", hash = "") {
  const loc = { pathname, search, hash };
  const calls: { state: unknown; url: string }[] = [];
  const hist = {
    state: { kept: 1 } as unknown,
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      const next = new URL(String(url), "https://execflow.example.test");
      calls.push({ state, url: String(url) });
      loc.pathname = next.pathname;
      loc.search = next.search;
      loc.hash = next.hash;
    },
  };
  return { loc, hist, calls };
}

describe("takeFrom", () => {
  it("uses the app's own marks", () => {
    expect(LINK_PATHS).toEqual({ short: SHORT_PATH, code: CODE_LINK_MARK, move: MOVE_PATH });
  });

  it("takes a short link: the address goes back to / (with the query), the key stays in memory only", () => {
    const { loc, hist, calls } = address("/s/AbCdEfGh12", "?lang=c", KEY);
    expect(takeFrom(loc, hist)).toEqual({ kind: "short", pathname: "/s/AbCdEfGh12", hash: KEY });
    expect(calls).toEqual([{ state: { kept: 1 }, url: "/?lang=c" }]);
    expect(loc).toEqual({ pathname: "/", search: "?lang=c", hash: "" });
  });

  it("takes a short link without a key too (the dialog says it is damaged)", () => {
    const { loc, hist } = address("/s/AbCdEfGh12");
    expect(takeFrom(loc, hist)).toEqual({ kind: "short", pathname: "/s/AbCdEfGh12", hash: "" });
    expect(loc.pathname).toBe("/");
  });

  it("takes a code link: the fragment leaves, the path and query stay", () => {
    const { loc, hist, calls } = address("/", "?x=1", "#code=abc");
    expect(takeFrom(loc, hist)).toEqual({ kind: "code", hash: "#code=abc" });
    expect(calls).toEqual([{ state: { kept: 1 }, url: "/?x=1" }]);
    expect(loc.hash).toBe("");
  });

  it("leaves every other address alone", () => {
    for (const [path, hash] of [["/", ""], ["/", "#settings"], ["/", "#codex"], ["/legal", "#3"], ["/sx/abc", KEY], ["/S/abc", KEY]]) {
      const { loc, hist, calls } = address(path, "", hash);
      expect(takeFrom(loc, hist), `${path}${hash}`).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("never takes anything at /move (another site may hold that tab and change its fragment)", () => {
    const { loc, hist, calls } = address(MOVE_PATH, "", "#code=abc");
    expect(takeFrom(loc, hist)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("linkCatcher", () => {
  it("keeps what it caught until the workbench listens, then hands it over once", () => {
    const { loc, hist } = address("/s/AbCdEfGh12", "", KEY);
    const catcher = linkCatcher(loc, hist);
    catcher.capture();
    expect(loc.hash).toBe("");
    const got: LinkFragment[] = [];
    catcher.listen((link) => got.push(link));
    expect(got).toEqual([{ kind: "short", pathname: "/s/AbCdEfGh12", hash: KEY }]);
    // Later fragments (a link pasted into the address bar) go straight to the listener.
    loc.hash = "#code=later";
    catcher.capture();
    expect(got.at(-1)).toEqual({ kind: "code", hash: "#code=later" });
    expect(loc.hash).toBe("");
    expect(got).toHaveLength(2);
  });

  it("keeps only the latest link while nobody listens", () => {
    const { loc, hist } = address("/", "", "#code=one");
    const catcher = linkCatcher(loc, hist);
    catcher.capture();
    loc.hash = "#code=two";
    catcher.capture();
    const got: LinkFragment[] = [];
    catcher.listen((link) => got.push(link));
    expect(got).toEqual([{ kind: "code", hash: "#code=two" }]);
  });

  it("hands nothing over when the address held no link", () => {
    const { loc, hist } = address("/", "", "#settings");
    const catcher = linkCatcher(loc, hist);
    catcher.capture();
    const got: LinkFragment[] = [];
    catcher.listen((link) => got.push(link));
    expect(got).toEqual([]);
    expect(loc.hash).toBe("#settings");
  });
});
