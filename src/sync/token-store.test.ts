import "fake-indexeddb/auto";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { SECRETS_DB, deleteSecretsDb, forgetToken, hasRememberedToken, loadToken, rememberToken, validateTokenShape } from "./token-store";
import { TEST_TOKEN } from "./test-helpers";

// Runs against fake-indexeddb (in memory) with Node's WebCrypto. Node's structuredClone copies a
// CryptoKey, so the key really goes through IndexedDB's structured clone here, as in a browser.

async function raw() {
  const db = await openDB(SECRETS_DB, 1);
  try {
    return { key: (await db.get("secrets", "key")) as CryptoKey | undefined, pat: (await db.get("secrets", "pat")) as { iv: Uint8Array; ct: ArrayBuffer } | undefined };
  } finally {
    db.close();
  }
}

const contains = (haystack: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

beforeEach(async () => {
  await deleteSecretsDb();
});

describe("token store", () => {
  it("round-trips a token through IndexedDB, encrypted with a non-extractable key", async () => {
    expect(await hasRememberedToken()).toBe(false);
    expect(await loadToken()).toBeNull();
    await rememberToken(TEST_TOKEN);
    expect(await hasRememberedToken()).toBe(true);
    expect(await loadToken()).toBe(TEST_TOKEN);

    const { key, pat } = await raw();
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key!.extractable).toBe(false);
    expect(key!.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key!)).rejects.toThrow();
    expect(pat!.iv).toBeInstanceOf(Uint8Array);
    expect(pat!.iv.length).toBe(12);
    const ct = new Uint8Array(pat!.ct);
    expect(contains(ct, new TextEncoder().encode(TEST_TOKEN))).toBe(false);
    expect(contains(ct, new TextEncoder().encode(TEST_TOKEN.slice(11, 31)))).toBe(false);
    expect(JSON.stringify(Array.from(ct))).not.toContain(TEST_TOKEN);
  });

  it("makes a new key and IV every time, so an old key can't open the new token", async () => {
    await rememberToken(TEST_TOKEN);
    const first = await raw();
    await rememberToken(TEST_TOKEN + "2");
    const second = await raw();
    expect(Array.from(second.pat!.iv)).not.toEqual(Array.from(first.pat!.iv));
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv: second.pat!.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode("codeeditor/github-token/v1") }, first.key!, second.pat!.ct),
    ).rejects.toThrow();
    expect(await loadToken()).toBe(TEST_TOKEN + "2");
  });

  it("forgets the token and its key", async () => {
    await rememberToken(TEST_TOKEN);
    await forgetToken();
    expect(await hasRememberedToken()).toBe(false);
    expect(await loadToken()).toBeNull();
    expect(await raw()).toEqual({ key: undefined, pat: undefined });
  });

  it("drops a damaged record instead of returning garbage", async () => {
    await rememberToken(TEST_TOKEN);
    const db = await openDB(SECRETS_DB, 1);
    const pat = (await db.get("secrets", "pat")) as { ct: ArrayBuffer };
    const ct = new Uint8Array(pat.ct.slice(0));
    ct[0] = ct[0]! ^ 0xff;
    await db.put("secrets", { ...pat, ct: ct.buffer }, "pat");
    db.close();
    expect(await loadToken()).toBeNull();
    expect(await hasRememberedToken()).toBe(false);
  });

  it("deletes its whole database", async () => {
    await rememberToken(TEST_TOKEN);
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(SECRETS_DB);
    await deleteSecretsDb();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(SECRETS_DB);
    expect(await loadToken()).toBeNull();
  });

  it("refuses to remember an empty token without echoing anything", async () => {
    await expect(rememberToken("")).rejects.toThrow(TypeError);
  });
});

describe("validateTokenShape", () => {
  it("accepts fine-grained tokens and trims what was pasted around them", () => {
    expect(validateTokenShape(`  ${TEST_TOKEN}\n`)).toEqual({ ok: true, token: TEST_TOKEN });
  });

  it("warns that a classic token reaches every repository", () => {
    const classic = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const result = validateTokenShape(classic);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toMatch(/every repository/);
  });

  it("refuses anything else with a reason that never includes the input", () => {
    for (const input of ["", "   ", "github_pat_short", "gho_" + "x".repeat(36), "hello world token", TEST_TOKEN + "!", "x".repeat(300), TEST_TOKEN.replace("_", String.fromCodePoint(0x202e))]) {
      const result = validateTokenShape(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok && input.trim().length > 3) expect(result.reason).not.toContain(input.trim());
    }
  });
});
