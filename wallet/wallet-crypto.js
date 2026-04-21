// WebCrypto + hash-wasm Argon2id. Derives an AES-GCM key from the user's PIN
// and wraps the seed.
//
// Design notes:
// - Argon2id config is hard-coded (m=19 MiB, t=2, p=1 — OWASP 2024 minimum).
//   No benchmark, no fallback — per the plan, a second KDF path is not worth
//   the drift surface for a device floor that's already in the right ballpark.
// - hash-wasm returns a raw hash; we import it as raw AES key material.
// - Salt (16 B) and IV (12 B) are per-wallet random. Do not reuse.
// - Seed is round-tripped as UTF-8 bytes of the mnemonic string.
// - A weak-PIN blocklist is enforced at call site; `isWeakPin` is exported.

import { argon2id } from "hash-wasm";
import {
  AES_IV_LENGTH_BYTES,
  SALT_LENGTH_BYTES,
  ARGON2_HASH_LENGTH,
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH
} from "./constants.js";
import { WalletError, ERROR_CODES } from "./wallet-errors.js";

const WEAK_PINS = new Set([
  "000000",
  "111111",
  "222222",
  "333333",
  "444444",
  "555555",
  "666666",
  "777777",
  "888888",
  "999999",
  "123456",
  "234567",
  "345678",
  "456789",
  "987654",
  "876543",
  "765432",
  "654321",
  "112233",
  "121212",
  "123123",
  "123321",
  "101010",
  "696969"
]);

function isAscendingOrDescendingRun(pin) {
  if (pin.length < 4) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < pin.length; i++) {
    const delta = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (delta !== 1) asc = false;
    if (delta !== -1) desc = false;
  }
  return asc || desc;
}

function looksLikeYearPattern(pin) {
  // PINs like "19XX" padded to 6 digits or "20XX" — conservative: reject if
  // the first 4 digits are 19YY (1900..1999) or 20YY (2000..2026). Stops the
  // most common birth-year pattern without forbidding every date-like PIN.
  if (!/^[0-9]{6}$/.test(pin)) return false;
  const head = pin.slice(0, 4);
  const n = parseInt(head, 10);
  if (Number.isNaN(n)) return false;
  if (n >= 1900 && n <= 1999) return true;
  if (n >= 2000 && n <= 2026) return true;
  return false;
}

export function isWeakPin(pin) {
  if (typeof pin !== "string") return true;
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) return true;
  if (!/^[0-9]+$/.test(pin)) return true;
  if (WEAK_PINS.has(pin)) return true;
  if (isAscendingOrDescendingRun(pin)) return true;
  if (looksLikeYearPattern(pin)) return true;
  // All identical digits (already covered by WEAK_PINS for 6-digit but cheap to assert)
  if (/^(.)\1+$/.test(pin)) return true;
  return false;
}

export function assertStrongPin(pin) {
  if (isWeakPin(pin)) {
    throw new WalletError(
      ERROR_CODES.WEAK_PIN,
      "PIN is too common, choose another"
    );
  }
}

function toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new TypeError("Expected Uint8Array or ArrayBuffer");
}

export function randomBytes(n, cryptoImpl) {
  const c = cryptoImpl ?? crypto;
  const buf = new Uint8Array(n);
  c.getRandomValues(buf);
  return buf;
}

export function randomSalt(cryptoImpl) {
  return randomBytes(SALT_LENGTH_BYTES, cryptoImpl);
}

export function randomIv(cryptoImpl) {
  return randomBytes(AES_IV_LENGTH_BYTES, cryptoImpl);
}

// Argon2id: derives raw key material from the PIN and salt.
// Returns raw Uint8Array(32). Import into WebCrypto via `importAesKey`.
export async function deriveKeyBytes(pin, salt) {
  if (typeof pin !== "string" || pin.length === 0) {
    throw new TypeError("pin must be a non-empty string");
  }
  const saltBytes = toUint8(salt);
  if (saltBytes.length < 8) {
    throw new TypeError("salt too short");
  }
  const result = await argon2id({
    password: pin,
    salt: saltBytes,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: "binary"
  });
  return result;
}

export async function importAesKey(rawBytes, cryptoImpl) {
  const c = cryptoImpl ?? crypto;
  return c.subtle.importKey(
    "raw",
    toUint8(rawBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSeed(mnemonic, key, iv, cryptoImpl) {
  const c = cryptoImpl ?? crypto;
  if (typeof mnemonic !== "string" || !mnemonic) {
    throw new TypeError("mnemonic must be a non-empty string");
  }
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = await c.subtle.encrypt(
    { name: "AES-GCM", iv: toUint8(iv) },
    key,
    plaintext
  );
  return new Uint8Array(ciphertext);
}

export async function decryptSeed(ciphertext, key, iv, cryptoImpl) {
  const c = cryptoImpl ?? crypto;
  try {
    const plaintext = await c.subtle.decrypt(
      { name: "AES-GCM", iv: toUint8(iv) },
      key,
      toUint8(ciphertext)
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (err) {
    throw new WalletError(
      ERROR_CODES.WRONG_PIN,
      "Decryption failed — wrong PIN or corrupted data",
      err
    );
  }
}

// Convenience: PIN → key in one step, for callers that just want the happy
// path. Returns the imported CryptoKey, not the raw bytes.
export async function deriveKey(pin, salt, cryptoImpl) {
  const raw = await deriveKeyBytes(pin, salt);
  return importAesKey(raw, cryptoImpl);
}
