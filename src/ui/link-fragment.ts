// The first module main.ts loads. A short link (/s/<id>#<key>) and a code link (#code=...) carry
// their secret in the address: the key that opens the stored code, or the code itself. Both leave
// the address here, before the styles, the workbench, any lazy chunk or any script the host adds at
// the end of the page (Cloudflare's analytics beacon) can read location, and in every tab, read-only
// ones included. What was taken waits in memory until the workbench asks for it (onLinkFragment).
// A link pasted into an open tab's address bar later is taken on hashchange, the same way.
// Kept tiny and free of imports: it is part of every first visit. The marks are the app's own
// (SHORT_PATH, CODE_LINK_MARK, MOVE_PATH); link-fragment.test.ts checks they stay equal.

export const LINK_PATHS = { short: "/s/", code: "#code=", move: "/move" } as const;

export type LinkFragment = { kind: "short"; pathname: string; hash: string } | { kind: "code"; hash: string };

type Address = Pick<Location, "pathname" | "search" | "hash">;
type Entries = Pick<History, "replaceState" | "state">;

/**
 * The link this address holds, taken out of it (replaceState: no new history entry), or null.
 * /move is never touched: it runs without cross-origin isolation, so another site that opened it
 * can keep a handle to the tab and change its fragment.
 */
export function takeFrom(loc: Address, hist: Entries): LinkFragment | null {
  const { pathname, search, hash } = loc;
  if (pathname === LINK_PATHS.move) return null;
  if (pathname.startsWith(LINK_PATHS.short)) {
    hist.replaceState(hist.state, "", `/${search}`);
    return { kind: "short", pathname, hash };
  }
  if (hash.startsWith(LINK_PATHS.code)) {
    hist.replaceState(hist.state, "", pathname + search);
    return { kind: "code", hash };
  }
  return null;
}

/** Takes links from an address and keeps the latest one until someone listens. */
export function linkCatcher(loc: Address, hist: Entries) {
  let waiting: LinkFragment | null = null;
  let listener: ((link: LinkFragment) => void) | null = null;
  return {
    capture(): void {
      const link = takeFrom(loc, hist);
      if (!link) return;
      if (listener) listener(link);
      else waiting = link;
    },
    listen(fn: (link: LinkFragment) => void): void {
      listener = fn;
      const link = waiting;
      waiting = null;
      if (link) fn(link);
    },
  };
}

const page = typeof window === "undefined" ? null : linkCatcher(location, history);
if (page) {
  page.capture();
  // Registered now, so it runs before any listener a later script adds.
  if (location.pathname !== LINK_PATHS.move) window.addEventListener("hashchange", () => page.capture());
}

/** The workbench's handler for every link taken from this tab's address, past and future. */
export function onLinkFragment(fn: (link: LinkFragment) => void): void {
  page?.listen(fn);
}
