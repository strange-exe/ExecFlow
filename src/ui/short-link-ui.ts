// The short link's controls shared by the Share dialog and Choose files (src/core/short-link.ts):
// how long the link is kept (owner's pick 2026-10-30: the sharer picks 1 day, 30 days or 90 days,
// 30 days by default), the date it expires, and making one with this page's fetch.
import { DEFAULT_TTL, LINK_TTLS, type LinkTtl } from "../../server/short-link-shape";
import type { Packed } from "../core/code-link";
import { makeShortLink, type ShortMakeRefusal } from "../core/short-link";
import { h } from "./dom";

export { DEFAULT_TTL };
export type { LinkTtl };

const TTL_NAMES: Record<LinkTtl, string> = { 86400: "1 day", 2592000: "30 days", 7776000: "90 days" };

/** "Keep the link for [30 days]": a native select, the same on a phone as with a keyboard. */
export function expiryField(id: string, value: LinkTtl, onChange: (ttl: LinkTtl) => void): HTMLElement {
  const select = h("select", { id }, ...LINK_TTLS.map((t) => h("option", { value: String(t) }, TTL_NAMES[t])));
  select.value = String(value);
  select.addEventListener("change", () => {
    const ttl = LINK_TTLS.find((t) => String(t) === select.value);
    if (ttl) onChange(ttl);
  });
  return h("div", { class: "field short-ttl" }, h("label", { for: id }, "Keep the link for"), select);
}

/** The day a link expires, in words ("29 November 2026"), as this device's calendar has it. */
export const expiryDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** What a short link is, in one sentence, under its choice. */
export const SHORT_NOTE = "Short enough for any chat or a QR code. Your code is encrypted on this device first: ExecFlow's server keeps only the encrypted copy, until the link expires, and the key to read it is in the link itself.";

/** Encrypts and stores `packed` with this page's own fetch (same origin: /api/links). */
export function makeShort(packed: Packed, ttl: LinkTtl): Promise<{ ok: true; url: string; expires: number } | { ok: false; refusal: ShortMakeRefusal }> {
  return makeShortLink(location.origin, packed, ttl, { fetch: (input, init) => fetch(input, init), online: () => navigator.onLine });
}
