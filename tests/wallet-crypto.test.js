import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import {
  isWeakPin,
  assertStrongPin,
  randomBytes,
  randomSalt,
  randomIv,
  deriveKeyBytes,
  importAesKey,
  encryptSeed,
  decryptSeed,
  deriveKey
} from "../wallet/wallet-crypto.js";
import { WalletError, ERROR_CODES } from "../wallet/wallet-errors.js";
import {
  AES_IV_LENGTH_BYTES,
  SALT_LENGTH_BYTES,
  ARGON2_HASH_LENGTH
} from "../wallet/constants.js";

// jsdom doesn't ship crypto.subtle, but node:crypto's webcrypto does.
const nodeCrypto = webcrypto;

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("isWeakPin", () => {
  it("rejects repeated digits", () => {
    for (const pin of ["000000", "111111", "999999"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects common sequences", () => {
    for (const pin of ["123456", "654321", "234567", "987654"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects ascending and descending runs", () => {
    // 4+ digits ascending/descending sequences fail even outside the blocklist
    expect(isWeakPin("456789")).toBe(true);
    expect(isWeakPin("876543")).toBe(true);
  });

  it("rejects 19XX and 20XX year patterns", () => {
    expect(isWeakPin("198500")).toBe(true);
    expect(isWeakPin("202000")).toBe(true);
  });

  it("rejects non-numeric or wrong-length input", () => {
    expect(isWeakPin("abcdef")).toBe(true);
    expect(isWeakPin("12345")).toBe(true);
    expect(isWeakPin("1234567")).toBe(true);
    expect(isWeakPin("")).toBe(true);
    expect(isWeakPin(null)).toBe(true);
    expect(isWeakPin(42)).toBe(true);
  });

  it("accepts reasonable PINs that dodge the blocklist", () => {
    expect(isWeakPin("358914")).toBe(false);
    expect(isWeakPin("702486")).toBe(false);
  });
});

describe("assertStrongPin", () => {
  it("throws WalletError(WEAK_PIN) on a weak pin", () => {
    try {
      assertStrongPin("000000");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WEAK_PIN);
    }
  });

  it("does not throw on a strong pin", () => {
    expect(() => assertStrongPin("702486")).not.toThrow();
  });
});

describe("random helpers", () => {
  it("randomBytes returns a Uint8Array of the requested length", () => {
    const buf = randomBytes(32, nodeCrypto);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBe(32);
  });

  it("randomSalt and randomIv use the configured lengths", () => {
    expect(randomSalt(nodeCrypto).length).toBe(SALT_LENGTH_BYTES);
    expect(randomIv(nodeCrypto).length).toBe(AES_IV_LENGTH_BYTES);
  });

  it("randomBytes returns independent samples", () => {
    const a = randomBytes(32, nodeCrypto);
    const b = randomBytes(32, nodeCrypto);
    // Vanishing probability two 32-byte samples match
    expect(bytesEqual(a, b)).toBe(false);
  });
});

describe("Argon2id key derivation", () => {
  it("produces a 32-byte key", async () => {
    const salt = randomSalt(nodeCrypto);
    const out = await deriveKeyBytes("702486", salt);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(ARGON2_HASH_LENGTH);
  }, 20_000);

  it("is deterministic for the same (pin, salt)", async () => {
    const salt = new Uint8Array(SALT_LENGTH_BYTES).fill(7);
    const a = await deriveKeyBytes("702486", salt);
    const b = await deriveKeyBytes("702486", salt);
    expect(bytesEqual(a, b)).toBe(true);
  }, 30_000);

  it("diverges on a different pin", async () => {
    const salt = new Uint8Array(SALT_LENGTH_BYTES).fill(7);
    const a = await deriveKeyBytes("702486", salt);
    const b = await deriveKeyBytes("702487", salt);
    expect(bytesEqual(a, b)).toBe(false);
  }, 30_000);

  it("rejects empty pins and short salts", async () => {
    await expect(deriveKeyBytes("", new Uint8Array(16))).rejects.toThrow(TypeError);
    await expect(deriveKeyBytes("702486", new Uint8Array(4))).rejects.toThrow(TypeError);
  });
});

describe("AES-GCM seed round-trip", () => {
  it("encrypts and decrypts to the original plaintext", async () => {
    const pin = "702486";
    const salt = randomSalt(nodeCrypto);
    const iv = randomIv(nodeCrypto);
    const key = await deriveKey(pin, salt, nodeCrypto);
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const ciphertext = await encryptSeed(mnemonic, key, iv, nodeCrypto);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(ciphertext.length).toBeGreaterThan(0);
    const plaintext = await decryptSeed(ciphertext, key, iv, nodeCrypto);
    expect(plaintext).toBe(mnemonic);
  }, 30_000);

  it("fails with WRONG_PIN when the key is wrong (tag violation)", async () => {
    const salt = randomSalt(nodeCrypto);
    const iv = randomIv(nodeCrypto);
    const good = await deriveKey("702486", salt, nodeCrypto);
    const bad = await deriveKey("702487", salt, nodeCrypto);
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const ciphertext = await encryptSeed(mnemonic, good, iv, nodeCrypto);
    try {
      await decryptSeed(ciphertext, bad, iv, nodeCrypto);
      throw new Error("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect(err.code).toBe(ERROR_CODES.WRONG_PIN);
    }
  }, 60_000);

  it("fails when the ciphertext is tampered with", async () => {
    const salt = randomSalt(nodeCrypto);
    const iv = randomIv(nodeCrypto);
    const key = await deriveKey("702486", salt, nodeCrypto);
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const ciphertext = await encryptSeed(mnemonic, key, iv, nodeCrypto);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptSeed(tampered, key, iv, nodeCrypto)).rejects.toMatchObject({
      code: ERROR_CODES.WRONG_PIN
    });
  }, 30_000);
});

describe("importAesKey", () => {
  it("returns a CryptoKey usable for encrypt/decrypt", async () => {
    const raw = new Uint8Array(32).fill(42);
    const key = await importAesKey(raw, nodeCrypto);
    expect(key).toBeDefined();
    // Round-trip via the real encrypt/decrypt path.
    const iv = randomIv(nodeCrypto);
    const ciphertext = await encryptSeed("hello world", key, iv, nodeCrypto);
    const plaintext = await decryptSeed(ciphertext, key, iv, nodeCrypto);
    expect(plaintext).toBe("hello world");
  });
});
