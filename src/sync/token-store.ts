// "Remember on this computer" for the GitHub token. By default the token lives only in memory.
// When the user opts in, it is stored AES-GCM encrypted in its OWN IndexedDB database
// ("codeeditor-secrets", store "secrets"), beside a non-extractable CryptoKey made for it.
//
// What this protects against: the token showing up in plain text (devtools, storage dumps,
// backups of the profile's IndexedDB files read elsewhere without the browser) and being
// exported as raw key material. What it doesn't: any script running on this origin can still
// ask the browser to decrypt it (XSS), and so can anyone using this browser profile. The defences
// for those are elsewhere: a one-repository, Contents-only, expiring token; a strict CSP; repo
// content never rendered as HTML; worker lockdown. The token is never logged.
// https://www.w3.org/TR/webcrypto/ (CryptoKey is Serializable, so IndexedDB can hold it)
// https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html

import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

export const SECRETS_DB = "codeeditor-secrets";
const STORE = "secrets";
const KEY_ID = "key";
const TOKEN_ID = "pat";
/** Binds the ciphertext to its purpose, so it can't be swapped in as some other secret. */
const AAD = new TextEncoder().encode("codeeditor/github-token/v1");

interface SealedToken {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
  savedAt: number;
}

interface SecretsSchema extends DBSchema {
  secrets: { key: string; value: CryptoKey | SealedToken };
}

async function open(): Promise<IDBPDatabase<SecretsSchema>> {
  const db: IDBPDatabase<SecretsSchema> = await openDB<SecretsSchema>(SECRETS_DB, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    },
    // Another tab wants to delete the database ("Sign out and clear this computer"): let it.
    blocking() {
      db.close();
    },
  });
  return db;
}

async function withDb<T>(fn: (db: IDBPDatabase<SecretsSchema>) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const isSealed = (value: unknown): value is SealedToken =>
  !!value &&
  typeof value === "object" &&
  (value as SealedToken).v === 1 &&
  (value as SealedToken).iv instanceof Uint8Array &&
  (value as SealedToken).iv.length === 12 &&
  (value as SealedToken).ct instanceof ArrayBuffer;

const isAesKey = (value: unknown): value is CryptoKey =>
  typeof CryptoKey !== "undefined" && value instanceof CryptoKey && value.algorithm.name === "AES-GCM";

/**
 * Encrypts and stores the token, replacing any remembered one. Every call makes a new key and a
 * new random 96-bit IV; both records are written in one transaction.
 */
export async function rememberToken(token: string): Promise<void> {
  if (token.length === 0) throw new TypeError("There is no token to remember.");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, new TextEncoder().encode(token));
  const sealed: SealedToken = { v: 1, iv, ct, savedAt: Date.now() };
  // Crypto first: an IndexedDB transaction commits as soon as it waits on anything else.
  await withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    await Promise.all([tx.store.put(key, KEY_ID), tx.store.put(sealed, TOKEN_ID), tx.done]);
  });
}

/** The remembered token, or null if none is stored (or it can no longer be decrypted). */
export async function loadToken(): Promise<string | null> {
  const [key, sealed] = await withDb(async (db) => {
    const tx = db.transaction(STORE, "readonly");
    const values = await Promise.all([tx.store.get(KEY_ID), tx.store.get(TOKEN_ID)]);
    await tx.done;
    return values;
  });
  if (!isAesKey(key) || !isSealed(sealed)) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: AAD }, key, sealed.ct);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    // Damaged or mismatched records can never decrypt: drop them so the user is asked again.
    await forgetToken();
    return null;
  }
}

/** True when a token (and its key) are stored. Doesn't decrypt anything. */
export async function hasRememberedToken(): Promise<boolean> {
  const [key, sealed] = await withDb(async (db) => {
    const tx = db.transaction(STORE, "readonly");
    const values = await Promise.all([tx.store.get(KEY_ID), tx.store.get(TOKEN_ID)]);
    await tx.done;
    return values;
  });
  return isAesKey(key) && isSealed(sealed);
}

/** Deletes the stored token and its key (one transaction). */
export async function forgetToken(): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    await Promise.all([tx.store.delete(KEY_ID), tx.store.delete(TOKEN_ID), tx.done]);
  });
}

// ---------------------------------------------------------------- "Sign in with GitHub" tokens
// The same protection for the GitHub App's tokens, in records of their own: their own key, a new
// AAD (so a PAT record can never be read as app tokens, or the reverse) and one sealed payload
// with both tokens and their expiry times. Every refresh rotates the pair, so every refresh seals
// it again (new key, new IV).

const APP_KEY_ID = "app-key";
const APP_TOKENS_ID = "app-tokens";
const APP_AAD = new TextEncoder().encode("codeeditor/github-app-tokens/v1");

/** A signed-in GitHub App user: access token (ghu_, 8 h) and refresh token (ghr_, 6 months). */
export interface AppTokens {
  access: string;
  /** ms since the epoch */
  accessExpiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}

const isAppTokens = (v: unknown): v is AppTokens => {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    t.access.startsWith("ghu_") &&
    typeof t.refresh === "string" &&
    t.refresh.startsWith("ghr_") &&
    typeof t.accessExpiresAt === "number" &&
    Number.isFinite(t.accessExpiresAt) &&
    typeof t.refreshExpiresAt === "number" &&
    Number.isFinite(t.refreshExpiresAt)
  );
};

/** Seals and stores the pair, replacing any remembered one (new key and IV every time). */
export async function rememberAppTokens(tokens: AppTokens): Promise<void> {
  if (!isAppTokens(tokens)) throw new TypeError("There are no sign-in tokens to remember.");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({ v: 1, access: tokens.access, accessExpiresAt: tokens.accessExpiresAt, refresh: tokens.refresh, refreshExpiresAt: tokens.refreshExpiresAt });
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: APP_AAD }, key, new TextEncoder().encode(payload));
  const sealed: SealedToken = { v: 1, iv, ct, savedAt: Date.now() };
  await withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    await Promise.all([tx.store.put(key, APP_KEY_ID), tx.store.put(sealed, APP_TOKENS_ID), tx.done]);
  });
}

/** The remembered pair, or null (none, or it can't be decrypted any more: then it is dropped). */
export async function loadAppTokens(): Promise<AppTokens | null> {
  const [key, sealed] = await withDb(async (db) => {
    const tx = db.transaction(STORE, "readonly");
    const values = await Promise.all([tx.store.get(APP_KEY_ID), tx.store.get(APP_TOKENS_ID)]);
    await tx.done;
    return values;
  });
  if (!isAesKey(key) || !isSealed(sealed)) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: APP_AAD }, key, sealed.ct);
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== 1 || !isAppTokens(data)) throw new TypeError("damaged");
    const t = data as AppTokens;
    return { access: t.access, accessExpiresAt: t.accessExpiresAt, refresh: t.refresh, refreshExpiresAt: t.refreshExpiresAt };
  } catch {
    await forgetAppTokens();
    return null;
  }
}

/** Deletes the remembered pair and its key (one transaction). */
export async function forgetAppTokens(): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    await Promise.all([tx.store.delete(APP_KEY_ID), tx.store.delete(APP_TOKENS_ID), tx.done]);
  });
}

/** Deletes the whole secrets database ("Sign out and clear this computer"). */
export async function deleteSecretsDb(): Promise<void> {
  await deleteDB(SECRETS_DB);
}

export type TokenShape = { ok: true; token: string; warning?: string } | { ok: false; reason: string };

const isTokenChar = (code: number) =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;

/**
 * Checks what the user pasted looks like a personal access token, before anything is sent.
 * Fine-grained tokens ("github_pat_") are expected; classic ones ("ghp_") work but get a warning.
 * Returns the token with surrounding whitespace removed. Messages never include the token.
 */
export function validateTokenShape(input: string): TokenShape {
  const token = input.trim();
  if (token === "") return { ok: false, reason: "Paste the token first." };
  for (let i = 0; i < token.length; i++) {
    if (!isTokenChar(token.charCodeAt(i))) {
      return { ok: false, reason: "A GitHub token has only letters, digits and underscores, so check that exactly the token was copied." };
    }
  }
  if (token.length > 255) return { ok: false, reason: "This is longer than any GitHub token, so check that exactly the token was copied." };
  if (token.startsWith("github_pat_")) {
    if (token.length < 40) return { ok: false, reason: "This token looks cut short, so copy it again from GitHub." };
    return { ok: true, token };
  }
  if (token.startsWith("ghp_")) {
    if (token.length < 40) return { ok: false, reason: "This token looks cut short, so copy it again from GitHub." };
    return {
      ok: true,
      token,
      warning: "This is a classic token, which can reach every repository your account can; a fine-grained token (it starts with github_pat_) limited to this one repository is safer.",
    };
  }
  return { ok: false, reason: "This doesn't look like a GitHub personal access token: fine-grained tokens start with github_pat_." };
}
