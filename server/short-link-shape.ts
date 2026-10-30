// Short links (owner's go-ahead 2026-10-30, .claude/tasks/HANDOFF.md "2026-10-30 night"): the shapes
// the browser (src/core/short-link.ts) and the Pages Function (server/short-links.ts) share.
//   https://<origin>/s/<id>#<key>
// The id names a stored blob; the key (AES-GCM, 256 bits) is only ever in the fragment, which the
// browser never sends to a server. What is stored, byte for byte:
//   STORED_VERSION (1 byte) | IV (12 bytes) | AES-GCM ciphertext with its 16-byte tag
// No regex escapes here: shapes are checked character by character (as server/github-auth.ts does).

/** The id's length: 10 characters of [0-9A-Za-z], about 59.5 bits, made by the server. */
export const LINK_ID_LENGTH = 10;
/** How long a link is kept, in seconds: 1 day, 30 days (the default), 90 days (owner's pick 2026-10-30). */
export const LINK_TTLS = [86400, 2592000, 7776000] as const;
export type LinkTtl = (typeof LINK_TTLS)[number];
export const DEFAULT_TTL: LinkTtl = 2592000;

export const STORED_VERSION = 1;
/** AES-GCM's recommended 96-bit IV (NIST SP 800-38D section 8.2), fresh for every link. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** The version byte, the IV, at least one byte of ciphertext and the tag. */
export const MIN_BODY_BYTES = 1 + IV_BYTES + 1 + TAG_BYTES;
/**
 * The most a stored link may be. The plaintext is a format byte and a code-link payload deflated
 * from at most 256 KB of JSON (src/core/code-link.ts MAX_INFLATED_BYTES); deflate adds at most a few
 * bytes per 64 KB block to text that doesn't compress, so 264 KB holds the largest one with room.
 */
export const MAX_BODY_BYTES = 264 * 1024;

const isBase62 = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** Exactly LINK_ID_LENGTH characters of [0-9A-Za-z]: nothing else ever reaches the store. */
export function isLinkId(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== LINK_ID_LENGTH) return false;
  for (let i = 0; i < v.length; i++) if (!isBase62(v.charCodeAt(i))) return false;
  return true;
}

export const isLinkTtl = (v: unknown): v is LinkTtl => typeof v === "number" && (LINK_TTLS as readonly number[]).includes(v);
